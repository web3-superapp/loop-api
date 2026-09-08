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
  erc20AllowanceAbi,
  erc20ApprovalEvent,
  erc20BalanceAbi,
  erc20IdentityAbi,
  erc20TransferEvent,
  pancakeV3BurnEvent,
  pancakeV3MintEvent,
  pancakeV3PoolAbi,
  pancakeV3SwapEvent,
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

export type BscPoolEventKind = "swap" | "mint" | "burn";

/**
 * One decoded PancakeSwap V3 pool log. `blockTimestamp` comes from the RPC log
 * when the endpoint reports it and from the block header otherwise; it is
 * never interpolated from a block number.
 */
export interface BscPoolEventLog {
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly blockTimestamp: bigint;
  readonly address: string;
  readonly kind: BscPoolEventKind;
  /** Every decoded argument as a canonical decimal string. */
  readonly args: Readonly<Record<string, string>>;
  readonly removed: boolean;
}

/** One decoded ERC-20 `Approval` log (Decision 0035). */
export interface BscApprovalLog {
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly address: string;
  readonly owner: string;
  readonly spender: string;
  readonly value: bigint;
  readonly removed: boolean;
}

export interface BscAllowanceRequestItem {
  readonly assetId: string;
  readonly token: string;
  readonly spender: string;
}

export interface BscAllowanceResult {
  readonly assetId: string;
  readonly spender: string;
  readonly rawValue: bigint | null;
  readonly reasonCode: string | null;
}

export interface BscAllowanceReadResult {
  readonly head: BscChainHead;
  readonly allowances: readonly BscAllowanceResult[];
}

/** Exact call shape LOOP pre-executes and estimates: from is always the wallet. */
export interface BscCallRequest {
  readonly from: string;
  readonly to: string;
  readonly data: Hex;
  readonly value: bigint;
}

export type BscCallOutcome =
  | { readonly status: "passed"; readonly returnData: Hex }
  | { readonly status: "reverted"; readonly reasonCode: string };

/**
 * Fee facts from the endpoint. BSC serves both `eth_maxPriorityFeePerGas` and
 * a legacy gas price; when the endpoint reports EIP-1559 fields the intent is
 * built as a type-2 transaction, otherwise as legacy.
 */
export type BscFeeData =
  | {
      readonly type: "eip1559";
      readonly maxFeePerGas: bigint;
      readonly maxPriorityFeePerGas: bigint;
    }
  | { readonly type: "legacy"; readonly gasPrice: bigint };

export interface BscTransactionObservation {
  readonly hash: string;
  readonly from: string;
  readonly to: string | null;
  readonly input: Hex;
  readonly value: bigint;
  readonly nonce: number;
  readonly chainId: number | null;
  readonly blockNumber: bigint | null;
}

export interface BscTransactionReceiptObservation {
  readonly hash: string;
  readonly status: "success" | "reverted";
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly gasUsed: bigint;
  readonly effectiveGasPrice: bigint;
}

export interface BscReadClient {
  readonly chainId: BscChainConfig["chainId"];
  readonly chainReference: BscChainConfig["chainReference"];
  readonly confirmations: number;
  readonly reorgDepthBlocks: number;
  readonly endpointRefs: readonly string[];
  /** Cached chain-ID verification; a mismatch is sticky until reconfigured. */
  verifyChain(): Promise<ChainVerificationState>;
  /**
   * The state the last probe actually observed, read synchronously. A
   * projection that must not block uses this; it reflects a recovery as soon
   * as the next probe lands.
   */
  currentVerification(): ChainVerificationState;
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
  readPoolEventLogs(
    query: BscTransferLogQuery,
  ): Promise<readonly BscPoolEventLog[]>;
  /** ERC-20 `Approval` logs for the same addresses and range as the transfer lane. */
  readApprovalLogs(
    query: BscTransferLogQuery,
  ): Promise<readonly BscApprovalLog[]>;
  probeEndpoints(): Promise<readonly BscEndpointHealth[]>;
}

/**
 * Read-only RPC methods that the wallet-intent flows need on top of the S5a
 * read surface (Decision 0035). None of them broadcasts: `call` and
 * `estimateGas` pre-execute a reviewed payload, the rest observe chain state.
 */
export interface BscChainCallClient extends BscReadClient {
  call(request: BscCallRequest): Promise<BscCallOutcome>;
  /** `null` when the endpoint refuses to estimate (the call would revert). */
  estimateGas(request: BscCallRequest): Promise<bigint | null>;
  getFeeData(): Promise<BscFeeData>;
  /** `pending` nonce so a second intent after an unmined one does not collide. */
  getTransactionCount(address: string): Promise<number>;
  getCode(address: string): Promise<Hex>;
  getTransaction(hash: string): Promise<BscTransactionObservation | null>;
  getTransactionReceipt(
    hash: string,
  ): Promise<BscTransactionReceiptObservation | null>;
  readAllowances(
    owner: string,
    items: readonly BscAllowanceRequestItem[],
  ): Promise<BscAllowanceReadResult>;
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
/** Mirrors the BSC_CONFIRMATIONS and BSC_REORG_DEPTH_BLOCKS defaults. */
export const defaultBscConfirmations = 15;
export const defaultBscReorgDepthBlocks = 64;
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

/**
 * A revert is a chain fact about the payload, not an endpoint failure. viem
 * wraps `eth_call` and `eth_estimateGas` execution errors in typed classes;
 * anything else (transport, rate limit, chain mismatch) propagates so the
 * caller reports the simulation as unavailable rather than reverted.
 */
function isRevertError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const revertNames = new Set([
    "ExecutionRevertedError",
    "CallExecutionError",
    "EstimateGasExecutionError",
  ]);
  const name = "name" in error ? String(error.name) : "";
  if (!revertNames.has(name)) {
    return false;
  }
  // viem wraps the RPC failure: only an execution revert underneath counts as
  // a chain fact. A transport, rate-limit, or endpoint error inside the same
  // wrapper is "unavailable", never "reverted".
  const walk = "walk" in error ? error.walk : undefined;
  if (typeof walk !== "function") {
    return name === "ExecutionRevertedError";
  }
  const inner = (walk as (fn: (e: unknown) => boolean) => unknown).call(
    error,
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      "name" in candidate &&
      candidate.name === "ExecutionRevertedError",
  );
  return inner !== null && inner !== undefined;
}

/** HTTP 403 from the endpoint: the method is refused, not the transaction. */
export function isRpcForbiddenError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const status = "status" in error ? error.status : undefined;
  if (status === 403) {
    return true;
  }
  const walk = "walk" in error ? error.walk : undefined;
  if (typeof walk !== "function") {
    return false;
  }
  const inner = (walk as (fn: (e: unknown) => boolean) => unknown).call(
    error,
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      "status" in candidate &&
      candidate.status === 403,
  );
  return inner !== null && inner !== undefined;
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "TransactionNotFoundError" ||
      error.name === "TransactionReceiptNotFoundError")
  );
}

export function createBscReadClient(
  options: CreateBscReadClientOptions,
): BscChainCallClient {
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
  async function readLogRange(
    addresses: Address[],
    fromBlock: bigint,
    toBlock: bigint,
  ) {
    return readLogRangeWith(
      (range) =>
        aggregate.getLogs({
          address: addresses,
          event: erc20TransferEvent,
          fromBlock: range.from,
          toBlock: range.to,
        }),
      fromBlock,
      toBlock,
    );
  }

  async function readLogRangeWith<T>(
    read: (range: {
      readonly from: bigint;
      readonly to: bigint;
    }) => Promise<readonly T[]>,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<T[]> {
    const pending = [{ from: fromBlock, to: toBlock }];
    const collected: T[] = [];
    while (pending.length > 0) {
      const range = pending.shift();
      if (range === undefined) {
        break;
      }
      try {
        collected.push(...(await read(range)));
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
    currentVerification: (): ChainVerificationState => verification,

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
      const logs = await readLogRange(
        [...query.addresses].map(asAddress),
        query.fromBlock,
        query.toBlock,
      );
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

    async readPoolEventLogs(
      query: BscTransferLogQuery,
    ): Promise<readonly BscPoolEventLog[]> {
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
      const addresses = [...query.addresses].map(asAddress);
      const logs = await readLogRangeWith(
        (range) =>
          aggregate.getLogs({
            address: addresses,
            events: [
              pancakeV3SwapEvent,
              pancakeV3MintEvent,
              pancakeV3BurnEvent,
            ],
            fromBlock: range.from,
            toBlock: range.to,
          }),
        query.fromBlock,
        query.toBlock,
      );
      // Endpoints that omit `blockTimestamp` on logs fall back to one header
      // read per distinct block; the value is never derived from the height.
      const timestamps = new Map<bigint, bigint>();
      for (const log of logs) {
        if (log.blockTimestamp !== undefined) {
          timestamps.set(log.blockNumber, log.blockTimestamp);
        }
      }
      for (const log of logs) {
        if (timestamps.has(log.blockNumber)) {
          continue;
        }
        const block = await aggregate.getBlock({
          blockNumber: log.blockNumber,
        });
        timestamps.set(log.blockNumber, block.timestamp);
      }
      const decoded: BscPoolEventLog[] = [];
      for (const log of logs) {
        const blockTimestamp = timestamps.get(log.blockNumber);
        if (blockTimestamp === undefined) {
          throw new BscReadUnavailableError("BSC_BLOCK_TIMESTAMP_UNAVAILABLE");
        }
        const args: Record<string, string> = {};
        for (const [name, value] of Object.entries(log.args)) {
          if (typeof value === "bigint") {
            args[name] = value.toString(10);
          } else if (typeof value === "number") {
            args[name] = String(value);
          } else if (typeof value === "string") {
            args[name] = normalizeHex(value);
          }
        }
        const kind: BscPoolEventKind =
          log.eventName === "Swap"
            ? "swap"
            : log.eventName === "Mint"
              ? "mint"
              : "burn";
        decoded.push(
          Object.freeze({
            transactionHash: normalizeHex(log.transactionHash),
            logIndex: log.logIndex,
            blockNumber: log.blockNumber,
            blockHash: normalizeHex(log.blockHash),
            blockTimestamp,
            address: normalizeHex(log.address),
            kind,
            args: Object.freeze(args),
            removed: log.removed,
          }),
        );
      }
      return Object.freeze(decoded);
    },

    async readApprovalLogs(
      query: BscTransferLogQuery,
    ): Promise<readonly BscApprovalLog[]> {
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
      const addresses = [...query.addresses].map(asAddress);
      const logs = await readLogRangeWith(
        (range) =>
          aggregate.getLogs({
            address: addresses,
            event: erc20ApprovalEvent,
            fromBlock: range.from,
            toBlock: range.to,
          }),
        query.fromBlock,
        query.toBlock,
      );
      return Object.freeze(
        logs.flatMap((log): BscApprovalLog[] => {
          const owner = log.args.owner;
          const spender = log.args.spender;
          const value = log.args.value;
          if (
            owner === undefined ||
            spender === undefined ||
            value === undefined
          ) {
            return [];
          }
          return [
            Object.freeze({
              transactionHash: normalizeHex(log.transactionHash),
              logIndex: log.logIndex,
              blockNumber: log.blockNumber,
              blockHash: normalizeHex(log.blockHash),
              address: normalizeHex(log.address),
              owner: normalizeHex(owner),
              spender: normalizeHex(spender),
              value,
              removed: log.removed,
            }),
          ];
        }),
      );
    },

    async call(request: BscCallRequest): Promise<BscCallOutcome> {
      await requireVerifiedChain();
      try {
        const result = await aggregate.call({
          account: asAddress(request.from),
          to: asAddress(request.to),
          data: request.data,
          value: request.value,
        });
        return Object.freeze({
          status: "passed" as const,
          returnData: result.data ?? "0x",
        });
      } catch (error) {
        if (isRevertError(error)) {
          return Object.freeze({
            status: "reverted" as const,
            reasonCode: "BSC_CALL_REVERTED",
          });
        }
        throw error;
      }
    },

    async estimateGas(request: BscCallRequest): Promise<bigint | null> {
      await requireVerifiedChain();
      try {
        return await aggregate.estimateGas({
          account: asAddress(request.from),
          to: asAddress(request.to),
          data: request.data,
          value: request.value,
        });
      } catch (error) {
        if (isRevertError(error)) {
          return null;
        }
        throw error;
      }
    },

    async getFeeData(): Promise<BscFeeData> {
      await requireVerifiedChain();
      const block = await aggregate.getBlock({ blockTag: "latest" });
      if (block.baseFeePerGas !== null) {
        let priority: bigint;
        try {
          priority = await aggregate.estimateMaxPriorityFeePerGas();
        } catch {
          priority = await aggregate.getGasPrice();
        }
        // Base fee headroom of 2x plus the tip, so a short base-fee rise while
        // the user reviews does not strand the transaction.
        return Object.freeze({
          type: "eip1559" as const,
          maxFeePerGas: block.baseFeePerGas * 2n + priority,
          maxPriorityFeePerGas: priority,
        });
      }
      return Object.freeze({
        type: "legacy" as const,
        gasPrice: await aggregate.getGasPrice(),
      });
    },

    async getTransactionCount(address: string): Promise<number> {
      await requireVerifiedChain();
      return aggregate.getTransactionCount({
        address: asAddress(address),
        blockTag: "pending",
      });
    },

    async getCode(address: string): Promise<Hex> {
      await requireVerifiedChain();
      const code = await aggregate.getCode({ address: asAddress(address) });
      return code ?? "0x";
    },

    async getTransaction(
      hash: string,
    ): Promise<BscTransactionObservation | null> {
      await requireVerifiedChain();
      let transaction;
      try {
        transaction = await aggregate.getTransaction({ hash: hash as Hex });
      } catch (error) {
        if (isNotFoundError(error)) {
          return null;
        }
        throw error;
      }
      return Object.freeze({
        hash: normalizeHex(transaction.hash),
        from: normalizeHex(transaction.from),
        to: transaction.to === null ? null : normalizeHex(transaction.to),
        input: normalizeHex(transaction.input) as Hex,
        value: transaction.value,
        nonce: transaction.nonce,
        chainId: transaction.chainId ?? null,
        blockNumber: transaction.blockNumber,
      });
    },

    async getTransactionReceipt(
      hash: string,
    ): Promise<BscTransactionReceiptObservation | null> {
      await requireVerifiedChain();
      let receipt;
      try {
        receipt = await aggregate.getTransactionReceipt({ hash: hash as Hex });
      } catch (error) {
        if (isNotFoundError(error)) {
          return null;
        }
        throw error;
      }
      return Object.freeze({
        hash: normalizeHex(receipt.transactionHash),
        status: receipt.status,
        blockNumber: receipt.blockNumber,
        blockHash: normalizeHex(receipt.blockHash),
        gasUsed: receipt.gasUsed,
        effectiveGasPrice: receipt.effectiveGasPrice,
      });
    },

    async readAllowances(
      owner: string,
      items: readonly BscAllowanceRequestItem[],
    ): Promise<BscAllowanceReadResult> {
      await requireVerifiedChain();
      const head = await readHead(aggregate);
      if (items.length === 0) {
        return Object.freeze({ head, allowances: Object.freeze([]) });
      }
      const ownerAddress = asAddress(owner);
      const results = await aggregate.multicall({
        allowFailure: true,
        blockNumber: head.blockNumber,
        contracts: items.map((item) => ({
          address: asAddress(item.token),
          abi: erc20AllowanceAbi,
          functionName: "allowance" as const,
          args: [ownerAddress, asAddress(item.spender)] as const,
        })),
      });
      return Object.freeze({
        head,
        allowances: Object.freeze(
          items.map((item, index) => {
            const result = results[index];
            if (result === undefined || result.status === "failure") {
              return Object.freeze({
                assetId: item.assetId,
                spender: item.spender,
                rawValue: null,
                reasonCode: "BSC_ALLOWANCE_CALL_FAILED",
              });
            }
            return Object.freeze({
              assetId: item.assetId,
              spender: item.spender,
              rawValue: result.result,
              reasonCode: null,
            });
          }),
        ),
      });
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
 * Widens a read-only client to the call surface. A composed client already
 * has the methods; a narrow test double gets rejecting stubs so a
 * funds-moving path can never silently succeed against a fake that does not
 * pre-execute.
 */
export function asChainCallClient(
  client: BscReadClient | BscChainCallClient,
): BscChainCallClient {
  if ("call" in client && typeof client.call === "function") {
    return client;
  }
  const reject = (): Promise<never> =>
    Promise.reject(new BscReadUnavailableError("BSC_CALL_CLIENT_NOT_COMPOSED"));
  return Object.freeze({
    ...client,
    call: reject,
    estimateGas: reject,
    getFeeData: reject,
    getTransactionCount: reject,
    getCode: reject,
    getTransaction: reject,
    getTransactionReceipt: reject,
    readAllowances: reject,
  });
}

/**
 * The client used when no RPC endpoint is configured. Every read rejects with
 * a stable reason code; nothing is inferred, cached, or replaced by a fixture.
 */
export function createUnavailableBscReadClient(
  options: {
    readonly confirmations?: number;
    readonly reorgDepthBlocks?: number;
  } = {},
): BscChainCallClient {
  const reject = (): Promise<never> =>
    Promise.reject(new BscReadUnavailableError("BSC_RPC_NOT_CONFIGURED"));
  return Object.freeze({
    chainId: "eip155:56" as const,
    chainReference: 56 as const,
    confirmations: options.confirmations ?? defaultBscConfirmations,
    reorgDepthBlocks: options.reorgDepthBlocks ?? defaultBscReorgDepthBlocks,
    endpointRefs: Object.freeze([] as readonly string[]),
    verifyChain: (): Promise<ChainVerificationState> =>
      Promise.resolve("unknown"),
    currentVerification: (): ChainVerificationState => "unknown",
    getHead: reject,
    getBlockHash: reject,
    readTokenIdentity: reject,
    readPoolIdentity: reject,
    readBalances: reject,
    readTransferLogs: reject,
    readPoolEventLogs: reject,
    readApprovalLogs: reject,
    call: reject,
    estimateGas: reject,
    getFeeData: reject,
    getTransactionCount: reject,
    getCode: reject,
    getTransaction: reject,
    getTransactionReceipt: reject,
    readAllowances: reject,
    probeEndpoints: (): Promise<readonly BscEndpointHealth[]> =>
      Promise.resolve(Object.freeze([])),
  });
}

export type { Hex };
