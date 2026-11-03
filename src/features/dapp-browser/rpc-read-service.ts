import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import type { FixedWindowRateLimiter } from "../../core/http/fixed-window-rate-limiter.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import {
  BscChainMismatchError,
  BscReadUnavailableError,
  type BscChainCallClient,
} from "../../integrations/bsc/rpc-client.js";
import { isChainId } from "../chain/chain-contract.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import { dappReasonCodes } from "../wallet-intents/intent-contract.js";

/**
 * Decision 0197 (S342): `POST /v2/chain/rpc-read`, the DApp browser's
 * read-only JSON-RPC channel. The App routes a page's read methods here
 * instead of to the Privy provider (which only signs): the request is
 * forwarded verbatim through the API's own verified RPC clients, on
 * eip155:56 or the launch slot only, with a method whitelist, strict
 * parameter shapes, an `eth_getLogs` block-span ceiling and a per-account
 * fixed-window rate limit. Nothing here signs or broadcasts.
 */

export const dappRpcReadMethods = Object.freeze([
  "eth_chainId",
  "eth_blockNumber",
  "eth_call",
  "eth_getBalance",
  "eth_getCode",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_getLogs",
  // S342 integration: the two block / fee reads wallet libraries issue
  // before they build a transaction (viem / ethers fee estimation).
  "eth_getBlockByNumber",
  "eth_feeHistory",
] as const);
export type DappRpcReadMethod = (typeof dappRpcReadMethods)[number];

/** Largest `toBlock - fromBlock + 1` an `eth_getLogs` may span. */
export const dappRpcLogsMaximumBlockSpan = 1_000n;
const maximumLogAddresses = 20;
const maximumTopicAlternatives = 20;
/** Geth's own eth_feeHistory ceiling (`maxBlockCount`). */
const maximumFeeHistoryBlocks = 1_024n;
const maximumRewardPercentiles = 100;

export interface DappRpcReadRuntime {
  readonly enabled: boolean;
  /** The chains the proxy serves: eip155:56 and the launch slot. */
  readonly clients: readonly BscChainCallClient[];
  readonly limiter: FixedWindowRateLimiter;
}

export interface DappRpcReadResource {
  readonly chainId: string;
  readonly method: DappRpcReadMethod;
  /** The node's `result` verbatim; null when `error` is set. */
  readonly result: unknown;
  /** The node's JSON-RPC error (e.g. code 3 + revert data for eth_call). */
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data: unknown;
  } | null;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface DappRpcReadService {
  read(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly body: unknown;
  }): Promise<DappRpcReadResource>;
}

const addressPattern = /^0x[0-9a-fA-F]{40}$/u;
const hashPattern = /^0x[0-9a-fA-F]{64}$/u;
const quantityPattern = /^0x(0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/u;
const dataPattern = /^0x([0-9a-fA-F]{2}){0,49152}$/u;
const blockTags = new Set([
  "latest",
  "pending",
  "safe",
  "finalized",
  "earliest",
]);

function invalid(): never {
  throw V2ApiError.invalidRequest();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireAddress(value: unknown): void {
  if (typeof value !== "string" || !addressPattern.test(value)) invalid();
}

function requireBlock(value: unknown): void {
  if (
    typeof value !== "string" ||
    !(blockTags.has(value) || quantityPattern.test(value))
  ) {
    invalid();
  }
}

/** A call object: only the fields eth_call / eth_estimateGas accept. */
function requireCallObject(value: unknown): void {
  if (!isRecord(value)) invalid();
  for (const [key, entry] of Object.entries(value)) {
    switch (key) {
      case "from":
      case "to":
        if (entry !== null) requireAddress(entry);
        break;
      case "data":
      case "input":
        if (typeof entry !== "string" || !dataPattern.test(entry)) invalid();
        break;
      case "value":
      case "gas":
      case "gasPrice":
      case "maxFeePerGas":
      case "maxPriorityFeePerGas":
        if (typeof entry !== "string" || !quantityPattern.test(entry)) {
          invalid();
        }
        break;
      default:
        invalid();
    }
  }
}

function requireParams(
  params: readonly unknown[],
  minimum: number,
  maximum: number,
): void {
  if (params.length < minimum || params.length > maximum) invalid();
}

function requireTopics(value: unknown): void {
  if (!Array.isArray(value) || value.length > 4) invalid();
  for (const topic of value) {
    if (topic === null) continue;
    if (typeof topic === "string") {
      if (!hashPattern.test(topic)) invalid();
      continue;
    }
    if (
      !Array.isArray(topic) ||
      topic.length > maximumTopicAlternatives ||
      topic.some(
        (entry) =>
          entry !== null &&
          (typeof entry !== "string" || !hashPattern.test(entry)),
      )
    ) {
      invalid();
    }
  }
}

/**
 * eth_feeHistory: blockCount (hex quantity or JSON integer) 1…1,024, a block
 * tag or number, and optional reward percentiles — at most 100 numbers in
 * [0, 100], non-decreasing.
 */
function requireFeeHistory(params: readonly unknown[]): void {
  requireParams(params, 2, 3);
  const count = params[0];
  let blocks: bigint;
  if (typeof count === "string" && quantityPattern.test(count)) {
    blocks = BigInt(count);
  } else if (typeof count === "number" && Number.isSafeInteger(count)) {
    blocks = BigInt(count);
  } else {
    invalid();
  }
  if (blocks < 1n || blocks > maximumFeeHistoryBlocks) invalid();
  requireBlock(params[1]);
  if (params[1] === "pending") invalid();
  if (params.length === 3) {
    const percentiles = params[2];
    if (
      !Array.isArray(percentiles) ||
      percentiles.length > maximumRewardPercentiles
    ) {
      invalid();
    }
    let previous = 0;
    for (const entry of percentiles as readonly unknown[]) {
      if (
        typeof entry !== "number" ||
        !Number.isFinite(entry) ||
        entry < previous ||
        entry > 100
      ) {
        invalid();
      }
      previous = entry;
    }
  }
}

async function blockNumberOf(
  client: BscChainCallClient,
  tag: string,
  head: { value: bigint | null },
): Promise<bigint> {
  if (quantityPattern.test(tag)) return BigInt(tag);
  if (tag === "earliest") {
    // A range from genesis is never within the span ceiling.
    return 0n;
  }
  if (head.value === null) {
    try {
      head.value = (await client.getHead()).blockNumber;
    } catch {
      throw V2ApiError.capabilityUnavailable();
    }
  }
  return head.value;
}

/**
 * eth_getLogs filter: `blockHash` alone, or `fromBlock` / `toBlock` whose
 * span (tags resolved against the head) is at most 1,000 blocks; at most
 * 20 addresses and 4 topic positions of at most 20 alternatives.
 */
async function requireLogFilter(
  client: BscChainCallClient,
  value: unknown,
): Promise<void> {
  if (!isRecord(value)) invalid();
  for (const key of Object.keys(value)) {
    if (
      !["address", "topics", "fromBlock", "toBlock", "blockHash"].includes(key)
    ) {
      invalid();
    }
  }
  const address = value["address"];
  if (address !== undefined && address !== null) {
    if (typeof address === "string") {
      requireAddress(address);
    } else if (
      !Array.isArray(address) ||
      address.length > maximumLogAddresses
    ) {
      invalid();
    } else {
      address.forEach(requireAddress);
    }
  }
  if (value["topics"] !== undefined && value["topics"] !== null) {
    requireTopics(value["topics"]);
  }
  if (value["blockHash"] !== undefined) {
    if (
      typeof value["blockHash"] !== "string" ||
      !hashPattern.test(value["blockHash"]) ||
      value["fromBlock"] !== undefined ||
      value["toBlock"] !== undefined
    ) {
      invalid();
    }
    return;
  }
  const from = value["fromBlock"] ?? "latest";
  const to = value["toBlock"] ?? "latest";
  requireBlock(from);
  requireBlock(to);
  if (from === "pending" || to === "pending") invalid();
  const head = { value: null as bigint | null };
  const fromNumber = await blockNumberOf(client, from as string, head);
  const toNumber = await blockNumberOf(client, to as string, head);
  if (toNumber < fromNumber) invalid();
  if (toNumber - fromNumber + 1n > dappRpcLogsMaximumBlockSpan) {
    throw V2ApiError.fromCode("VALIDATION_FAILED", {
      reasonCode: dappReasonCodes.rpcLogRangeTooLarge,
      maximumBlockSpan: dappRpcLogsMaximumBlockSpan.toString(10),
    });
  }
}

async function validateParams(
  client: BscChainCallClient,
  method: DappRpcReadMethod,
  params: readonly unknown[],
): Promise<void> {
  switch (method) {
    case "eth_chainId":
    case "eth_blockNumber":
    case "eth_gasPrice":
      requireParams(params, 0, 0);
      return;
    case "eth_call":
    case "eth_estimateGas":
      requireParams(params, 1, 2);
      requireCallObject(params[0]);
      if (params.length === 2) requireBlock(params[1]);
      return;
    case "eth_getBalance":
    case "eth_getCode":
      requireParams(params, 1, 2);
      requireAddress(params[0]);
      if (params.length === 2) requireBlock(params[1]);
      return;
    case "eth_getTransactionReceipt":
    case "eth_getTransactionByHash":
      requireParams(params, 1, 1);
      if (typeof params[0] !== "string" || !hashPattern.test(params[0])) {
        invalid();
      }
      return;
    case "eth_getLogs":
      requireParams(params, 1, 1);
      await requireLogFilter(client, params[0]);
      return;
    case "eth_getBlockByNumber":
      // [block, fullTransactions]: the flag defaults to false when absent.
      requireParams(params, 1, 2);
      requireBlock(params[0]);
      if (params.length === 2 && typeof params[1] !== "boolean") invalid();
      return;
    case "eth_feeHistory":
      requireFeeHistory(params);
      return;
  }
}

function isAllowedMethod(value: unknown): value is DappRpcReadMethod {
  return (
    typeof value === "string" &&
    (dappRpcReadMethods as readonly string[]).includes(value)
  );
}

export function createDappRpcReadService(
  runtime: DappRpcReadRuntime,
): DappRpcReadService {
  const service: DappRpcReadService = {
    async read({ principal, body }) {
      if (!runtime.enabled) {
        throw V2ApiError.fromCode("CAPABILITY_UNAVAILABLE", {
          reasonCode: dappReasonCodes.disabled,
        });
      }
      if (!isRecord(body)) invalid();
      const { chainId, method } = body;
      const params = body["params"] ?? [];
      if (
        !isChainId(chainId) ||
        typeof method !== "string" ||
        !Array.isArray(params)
      ) {
        invalid();
      }
      const client = runtime.clients.find(
        (candidate) => candidate.chainId === chainId,
      );
      if (client === undefined) {
        throw V2ApiError.fromCode("CHAIN_MISMATCH");
      }
      if (!isAllowedMethod(method)) {
        throw V2ApiError.fromCode("VALIDATION_FAILED", {
          reasonCode: dappReasonCodes.rpcMethodNotAllowed,
        });
      }
      // One window per account: an account has one embedded wallet, so
      // this is the per-wallet limit the App's pages share.
      if (runtime.limiter.admit(principal.userId) !== null) {
        throw V2ApiError.rateLimited();
      }
      if (method === "eth_chainId") {
        requireParams(params as readonly unknown[], 0, 0);
        return Object.freeze({
          chainId,
          method,
          result: `0x${client.chainReference.toString(16)}`,
          error: null,
          contractVersion: v2ContractVersion,
        });
      }
      if (client.relayRead === undefined) {
        throw V2ApiError.fromCode("CAPABILITY_UNAVAILABLE", {
          reasonCode: dappReasonCodes.chainUnavailable,
        });
      }
      try {
        await validateParams(client, method, params as readonly unknown[]);
        const outcome = await client.relayRead(
          method,
          params as readonly unknown[],
        );
        return Object.freeze({
          chainId,
          method,
          result: outcome.status === "result" ? (outcome.result ?? null) : null,
          error: outcome.status === "error" ? outcome.error : null,
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        if (
          error instanceof BscReadUnavailableError ||
          error instanceof BscChainMismatchError
        ) {
          throw V2ApiError.capabilityUnavailable();
        }
        throw error;
      }
    },
  };
  return Object.freeze(service);
}
