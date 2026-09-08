import { createHash } from "node:crypto";

import {
  createPublicClient,
  fallback,
  http,
  InvalidParamsRpcError,
  LimitExceededRpcError,
  type Address,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";
import { bsc } from "viem/chains";

import type { BscChainConfig } from "../../config.js";
import {
  erc20BalanceAbi,
  erc20IdentityAbi,
  erc20TransferEvent,
  pancakeV3PoolAbi,
} from "./erc20-abi.js";

/**
 * Narrow read-only BSC RPC boundary (Decision 0033).
 *
 * Endpoint URLs never leave this module: every projection identifies an
 * endpoint by an opaque, non-reversible `endpointRef`. The client refuses to
 * serve any read until `eth_chainId` has been observed to equal the configured
 * chain reference, so a misconfigured or hijacked endpoint fails closed
 * instead of publishing another chain's facts as BSC facts.
 */

export const chainVerificationStates = Object.freeze([
  "verified",
  "mismatched",
  "unreachable",
  "unknown",
] as const);
export type ChainVerificationState = (typeof chainVerificationStates)[number];

export const endpointHealthStates = Object.freeze([
  "healthy",
  "degraded",
  "unreachable",
] as const);
export type EndpointHealthState = (typeof endpointHealthStates)[number];

export interface BscChainHead {
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly observedAt: string;
}

export interface BscEndpointHealth {
  readonly endpointRef: string;
  readonly status: EndpointHealthState;
  readonly latencyMs: number | null;
  readonly blockNumber: string | null;
  readonly blockLagBlocks: number | null;
  readonly chainVerification: ChainVerificationState;
  readonly observedAt: string;
}

export interface BscTokenIdentity {
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
}

export interface BscPoolIdentity {
  readonly token0: string;
  readonly token1: string;
  readonly fee: number;
  readonly tickSpacing: number;
}

export interface BscBalanceRequestItem {
  readonly assetId: string;
  /** `null` reads the native balance of the owner. */
  readonly address: string | null;
}

export interface BscBalanceResult {
  readonly assetId: string;
  readonly rawValue: bigint | null;
  readonly reasonCode: string | null;
}

export interface BscBalanceReadResult {
  readonly head: BscChainHead;
  readonly balances: readonly BscBalanceResult[];
}

export interface BscTransferLog {
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly address: string;
  readonly from: string;
  readonly to: string;
  readonly value: bigint;
  readonly removed: boolean;
}

export interface BscTransferLogQuery {
  readonly addresses: readonly string[];
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
}

export interface BscReadClient {
  readonly chainId: BscChainConfig["chainId"];
  readonly chainReference: BscChainConfig["chainReference"];
  readonly confirmations: number;
  readonly reorgDepthBlocks: number;
  readonly endpointRefs: readonly string[];
  /** Cached chain-ID verification; a mismatch is sticky until reconfigured. */
  verifyChain(): Promise<ChainVerificationState>;
  getHead(): Promise<BscChainHead>;
  getBlockHash(blockNumber: bigint): Promise<string | null>;
  readTokenIdentity(address: string): Promise<BscTokenIdentity>;
  readPoolIdentity(address: string): Promise<BscPoolIdentity>;
  readBalances(
    owner: string,
    items: readonly BscBalanceRequestItem[],
  ): Promise<BscBalanceReadResult>;
  readTransferLogs(
    query: BscTransferLogQuery,
  ): Promise<readonly BscTransferLog[]>;
  probeEndpoints(): Promise<readonly BscEndpointHealth[]>;
}

export class BscReadUnavailableError extends Error {
  readonly code = "bsc_read_unavailable";

  constructor(readonly reasonCode: string) {
    super("The BSC read capability is unavailable");
    this.name = "BscReadUnavailableError";
  }
}

export class BscChainMismatchError extends Error {
  readonly code = "bsc_chain_mismatch";

  constructor() {
    super("The configured RPC endpoint does not serve the expected chain");
    this.name = "BscChainMismatchError";
  }
}

/** Maximum block span of one `eth_getLogs` request. */
export const bscMaximumLogRange = 2_000n;
/**
 * Endpoints cap `eth_getLogs` by block span and by result size, and report the
 * two through different JSON-RPC errors. The client halves the range and
 * retries on either; a single block that still fails is a real endpoint
 * limitation and fails closed instead of silently dropping logs.
 */
const bscLogRangeSplitFloor = 1n;
const healthyLatencyMs = 1_500;
const requestTimeoutMs = 6_000;

/**
 * Stable, non-reversible endpoint reference. It lets operators correlate a
 * degraded endpoint across responses without publishing the Provider URL.
 */
export function endpointRefFor(url: string): string {
  return `rpc-${createHash("sha256").update(url).digest("hex").slice(0, 12)}`;
}

export interface BscTransportFactory {
  (url: string): Transport;
}

export interface CreateBscReadClientOptions {
  readonly config: BscChainConfig;
  /** Test seam: supplies a mock transport instead of an HTTP transport. */
  readonly transportFactory?: BscTransportFactory;
  readonly now?: () => Date;
  readonly monotonicMs?: () => number;
}

type ViemClient = PublicClient<Transport, typeof bsc>;

function defaultTransport(url: string): Transport {
  return http(url, { timeout: requestTimeoutMs, retryCount: 0 });
}

function asAddress(value: string): Address {
  return value as Address;
}

function normalizeHex(value: string): string {
  return value.toLowerCase();
}

export function createBscReadClient(
  options: CreateBscReadClientOptions,
): BscReadClient {
  const { config } = options;
  const transportFactory = options.transportFactory ?? defaultTransport;
  const now = options.now ?? ((): Date => new Date());
  const monotonicMs =
    options.monotonicMs ??
    ((): number => Number(process.hrtime.bigint() / 1_000_000n));
  const endpoints: readonly {
    readonly endpointRef: string;
    readonly client: ViemClient;
  }[] = config.rpcUrls.map((url) => ({
    endpointRef: endpointRefFor(url),
    client: createPublicClient({
      chain: bsc,
      transport: transportFactory(url),
    }),
  }));
  const aggregate: ViemClient = createPublicClient({
    chain: bsc,
    transport: fallback(config.rpcUrls.map((url) => transportFactory(url))),
  });

  let currentLogAddresses: readonly string[] = [];
  let verification: ChainVerificationState = "unknown";
  let verificationInFlight: Promise<ChainVerificationState> | null = null;

  async function probeVerification(): Promise<ChainVerificationState> {
    try {
      const chainId = await aggregate.getChainId();
      return chainId === config.chainReference ? "verified" : "mismatched";
    } catch {
      return "unreachable";
    }
  }

  function verifyChain(): Promise<ChainVerificationState> {
    if (verification === "verified" || verification === "mismatched") {
      return Promise.resolve(verification);
    }
    if (verificationInFlight !== null) {
      return verificationInFlight;
    }
    const pending = probeVerification()
      .then((state) => {
        verification = state;
        return state;
      })
      .finally(() => {
        verificationInFlight = null;
      });
    verificationInFlight = pending;
    return pending;
  }

  async function requireVerifiedChain(): Promise<void> {
    const state = await verifyChain();
    if (state === "mismatched") {
      throw new BscChainMismatchError();
    }
    if (state !== "verified") {
      throw new BscReadUnavailableError("BSC_RPC_UNREACHABLE");
    }
  }

  /**
   * Reads one segment, halving the range whenever the endpoint rejects the
   * request for exceeding its result limit. The walk is iterative and bounded
   * by the segment width, and a single block that still exceeds the limit is
   * rethrown rather than being silently skipped.
   */
  async function readLogRange(fromBlock: bigint, toBlock: bigint) {
    const pending = [{ from: fromBlock, to: toBlock }];
    const collected = [];
    while (pending.length > 0) {
      const range = pending.shift();
      if (range === undefined) {
        break;
      }
      try {
        collected.push(
          ...(await aggregate.getLogs({
            address: currentLogAddresses.map(asAddress),
            event: erc20TransferEvent,
            fromBlock: range.from,
            toBlock: range.to,
          })),
        );
      } catch (error) {
        const isRangeRejection =
          error instanceof LimitExceededRpcError ||
          error instanceof InvalidParamsRpcError;
        if (
          !isRangeRejection ||
          range.to - range.from < bscLogRangeSplitFloor
        ) {
          throw error;
        }
        const middle = range.from + (range.to - range.from) / 2n;
        pending.unshift(
          { from: range.from, to: middle },
          { from: middle + 1n, to: range.to },
        );
      }
    }
    return collected;
  }

  async function readHead(client: ViemClient): Promise<BscChainHead> {
    const block = await client.getBlock({ blockTag: "latest" });
    return Object.freeze({
      blockNumber: block.number,
      blockHash: normalizeHex(block.hash),
      observedAt: now().toISOString(),
    });
  }

  return Object.freeze({
    chainId: config.chainId,
    chainReference: config.chainReference,
    confirmations: config.confirmations,
    reorgDepthBlocks: config.reorgDepthBlocks,
    endpointRefs: Object.freeze(
      endpoints.map((endpoint) => endpoint.endpointRef),
    ),
    verifyChain,

    async getHead(): Promise<BscChainHead> {
      await requireVerifiedChain();
      return readHead(aggregate);
    },

    async getBlockHash(blockNumber: bigint): Promise<string | null> {
      await requireVerifiedChain();
      try {
        const block = await aggregate.getBlock({ blockNumber });
        return normalizeHex(block.hash);
      } catch {
        return null;
      }
    },

    async readTokenIdentity(address: string): Promise<BscTokenIdentity> {
      await requireVerifiedChain();
      const contract = { address: asAddress(address), abi: erc20IdentityAbi };
      const [symbol, name, decimals] = await aggregate.multicall({
        allowFailure: false,
        contracts: [
          { ...contract, functionName: "symbol" },
          { ...contract, functionName: "name" },
          { ...contract, functionName: "decimals" },
        ],
      });
      return Object.freeze({
        symbol: symbol.trim(),
        name: name.trim(),
        decimals: Number(decimals),
      });
    },

    async readPoolIdentity(address: string): Promise<BscPoolIdentity> {
      await requireVerifiedChain();
      const contract = { address: asAddress(address), abi: pancakeV3PoolAbi };
      const [token0, token1, fee, tickSpacing] = await aggregate.multicall({
        allowFailure: false,
        contracts: [
          { ...contract, functionName: "token0" },
          { ...contract, functionName: "token1" },
          { ...contract, functionName: "fee" },
          { ...contract, functionName: "tickSpacing" },
        ],
      });
      return Object.freeze({
        token0: normalizeHex(token0),
        token1: normalizeHex(token1),
        fee: Number(fee),
        tickSpacing: Number(tickSpacing),
      });
    },

    async readBalances(
      owner: string,
      items: readonly BscBalanceRequestItem[],
    ): Promise<BscBalanceReadResult> {
      await requireVerifiedChain();
      const head = await readHead(aggregate);
      const ownerAddress = asAddress(owner);
      const tokenItems = items.filter((item) => item.address !== null);
      const nativeItems = items.filter((item) => item.address === null);

      const tokenResults =
        tokenItems.length === 0
          ? []
          : await aggregate.multicall({
              allowFailure: true,
              blockNumber: head.blockNumber,
              contracts: tokenItems.map((item) => ({
                address: asAddress(item.address as string),
                abi: erc20BalanceAbi,
                functionName: "balanceOf" as const,
                args: [ownerAddress] as const,
              })),
            });

      const balances: BscBalanceResult[] = [];
      for (const [index, item] of tokenItems.entries()) {
        const result = tokenResults[index];
        if (result === undefined || result.status === "failure") {
          balances.push(
            Object.freeze({
              assetId: item.assetId,
              rawValue: null,
              reasonCode: "BSC_BALANCE_CALL_FAILED",
            }),
          );
          continue;
        }
        balances.push(
          Object.freeze({
            assetId: item.assetId,
            rawValue: result.result,
            reasonCode: null,
          }),
        );
      }

      for (const item of nativeItems) {
        try {
          const rawValue = await aggregate.getBalance({
            address: ownerAddress,
            blockNumber: head.blockNumber,
          });
          balances.push(
            Object.freeze({
              assetId: item.assetId,
              rawValue,
              reasonCode: null,
            }),
          );
        } catch {
          balances.push(
            Object.freeze({
              assetId: item.assetId,
              rawValue: null,
              reasonCode: "BSC_BALANCE_CALL_FAILED",
            }),
          );
        }
      }

      return Object.freeze({
        head,
        balances: Object.freeze(
          items.flatMap((item) =>
            balances.filter((balance) => balance.assetId === item.assetId),
          ),
        ),
      });
    },

    async readTransferLogs(
      query: BscTransferLogQuery,
    ): Promise<readonly BscTransferLog[]> {
      await requireVerifiedChain();
      if (query.toBlock < query.fromBlock) {
        throw new BscReadUnavailableError("BSC_LOG_RANGE_INVALID");
      }
      if (query.toBlock - query.fromBlock + 1n > bscMaximumLogRange) {
        throw new BscReadUnavailableError("BSC_LOG_RANGE_TOO_WIDE");
      }
      if (query.addresses.length === 0) {
        return Object.freeze([]);
      }
      currentLogAddresses = query.addresses;
      const logs = await readLogRange(query.fromBlock, query.toBlock);
      return Object.freeze(
        logs.flatMap((log): BscTransferLog[] => {
          const from = log.args.from;
          const to = log.args.to;
          const value = log.args.value;
          if (from === undefined || to === undefined || value === undefined) {
            return [];
          }
          return [
            Object.freeze({
              transactionHash: normalizeHex(log.transactionHash),
              logIndex: log.logIndex,
              blockNumber: log.blockNumber,
              blockHash: normalizeHex(log.blockHash),
              address: normalizeHex(log.address),
              from: normalizeHex(from),
              to: normalizeHex(to),
              value,
              removed: log.removed,
            }),
          ];
        }),
      );
    },

    async probeEndpoints(): Promise<readonly BscEndpointHealth[]> {
      const observedAt = now().toISOString();
      const probes = await Promise.all(
        endpoints.map(
          async (
            endpoint,
          ): Promise<{
            readonly endpointRef: string;
            readonly latencyMs: number | null;
            readonly blockNumber: bigint | null;
            readonly chainVerification: ChainVerificationState;
          }> => {
            const startedAt = monotonicMs();
            try {
              const [chainId, blockNumber] = await Promise.all([
                endpoint.client.getChainId(),
                endpoint.client.getBlockNumber(),
              ]);
              const latencyMs = Math.max(0, monotonicMs() - startedAt);
              const matches = chainId === config.chainReference;
              return {
                endpointRef: endpoint.endpointRef,
                latencyMs,
                blockNumber,
                chainVerification: matches ? "verified" : "mismatched",
              };
            } catch {
              return {
                endpointRef: endpoint.endpointRef,
                latencyMs: null,
                blockNumber: null,
                chainVerification: "unreachable",
              };
            }
          },
        ),
      );

      const heights = probes
        .map((probe) => probe.blockNumber)
        .filter((height): height is bigint => height !== null);
      const bestHeight =
        heights.length === 0
          ? null
          : heights.reduce((left, right) => (right > left ? right : left));

      return Object.freeze(
        probes.map((probe) => {
          const blockLagBlocks =
            bestHeight === null || probe.blockNumber === null
              ? null
              : Number(bestHeight - probe.blockNumber);
          const status: EndpointHealthState =
            probe.chainVerification === "unreachable"
              ? "unreachable"
              : probe.chainVerification === "mismatched" ||
                  (probe.latencyMs !== null &&
                    probe.latencyMs > healthyLatencyMs) ||
                  (blockLagBlocks !== null && blockLagBlocks > 3)
                ? "degraded"
                : "healthy";
          return Object.freeze({
            endpointRef: probe.endpointRef,
            status,
            latencyMs: probe.latencyMs,
            blockNumber:
              probe.blockNumber === null
                ? null
                : probe.blockNumber.toString(10),
            blockLagBlocks,
            chainVerification: probe.chainVerification,
            observedAt,
          });
        }),
      );
    },
  });
}

/**
 * The client used when no RPC endpoint is configured. Every read rejects with
 * a stable reason code; nothing is inferred, cached, or replaced by a fixture.
 */
export function createUnavailableBscReadClient(): BscReadClient {
  const reject = (): Promise<never> =>
    Promise.reject(new BscReadUnavailableError("BSC_RPC_NOT_CONFIGURED"));
  return Object.freeze({
    chainId: "eip155:56" as const,
    chainReference: 56 as const,
    confirmations: 15,
    reorgDepthBlocks: 64,
    endpointRefs: Object.freeze([] as readonly string[]),
    verifyChain: (): Promise<ChainVerificationState> =>
      Promise.resolve("unknown"),
    getHead: reject,
    getBlockHash: reject,
    readTokenIdentity: reject,
    readPoolIdentity: reject,
    readBalances: reject,
    readTransferLogs: reject,
    probeEndpoints: (): Promise<readonly BscEndpointHealth[]> =>
      Promise.resolve(Object.freeze([])),
  });
}

export type { Hex };
