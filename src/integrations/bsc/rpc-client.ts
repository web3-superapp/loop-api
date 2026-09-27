import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

import {
  createPublicClient,
  fallback,
  http,
  HttpRequestError,
  InvalidParamsRpcError,
  LimitExceededRpcError,
  SocketClosedError,
  TimeoutError,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";
import { bsc, bscTestnet } from "viem/chains";

import {
  bscChainId,
  bscChainReference,
  bscTestnetChainReference,
  type LaunchChainId,
  type LaunchChainReference,
} from "../../features/chain/chain-contract.js";
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
  /** Host name of the endpoint, for display; never scheme, path, or key. */
  readonly label: string;
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

/** Contract addresses and an inclusive block range of one log read. */
export interface BscLogRangeQuery {
  readonly addresses: readonly string[];
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
}

/**
 * Wallet scope of an ERC-20 log read (Decision 0075). Only logs whose indexed
 * wallet topic (`Transfer.from`, `Transfer.to`, `Approval.owner`) is one of
 * `walletAddresses` are returned. The set is sent as topic OR arrays of at
 * most `topicChunkSize` entries per request; an empty set reads nothing.
 */
export interface BscWalletLogFilter {
  readonly walletAddresses: readonly string[];
  readonly topicChunkSize: number;
}

export interface BscTransferLogQuery extends BscLogRangeQuery {
  /** Absent: every log of `addresses` (no wallet scope). */
  readonly walletFilter?: BscWalletLogFilter;
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

/**
 * What a read client needs to know about its chain slot (Decision 0038). Both
 * `BscChainConfig` (primary, always 56) and `LaunchChainConfig` (56 or 97)
 * satisfy it; the client never learns which slot it serves.
 */
export interface BscRpcChainConfig {
  readonly chainId: LaunchChainId;
  readonly chainReference: LaunchChainReference;
  readonly rpcUrls: readonly string[];
  readonly confirmations: number;
  readonly reorgDepthBlocks: number;
  /**
   * Token (emitter) addresses per `eth_getLogs` request, the ceiling the
   * client narrows below and relaxes back to (Decision 0078,
   * `BSC_LOG_ADDRESS_CHUNK_SIZE`, 1-100, default 8).
   */
  readonly logAddressChunkSize?: number | undefined;
}

export interface BscReadClient {
  readonly chainId: LaunchChainId;
  readonly chainReference: LaunchChainReference;
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
    query: BscLogRangeQuery,
  ): Promise<readonly BscPoolEventLog[]>;
  /**
   * ERC-20 `Approval` logs for the same addresses and range as the transfer
   * lane; a wallet filter scopes them to `owner` (Decision 0075).
   */
  readApprovalLogs(
    query: BscTransferLogQuery,
  ): Promise<readonly BscApprovalLog[]>;
  probeEndpoints(): Promise<readonly BscEndpointHealth[]>;
  /**
   * Current learned `eth_getLogs` limits (Decision 0079), for lane logs.
   * Absent on clients that never read logs (the unavailable client, fakes).
   */
  logQueryLimits?(): BscLogQueryLimits;
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

/**
 * Safe, loggable classification of a Provider error (Decision 0068). Every
 * field is a class name, a numeric status/code, a host name, or a JSON-RPC
 * method name; never a URL, a request body, an address list, or a key.
 */
export interface BscRpcErrorSummary {
  /** The error's `name` (viem error name) or constructor name. */
  readonly errorClass: string;
  /** HTTP status of the failed request, when the Provider answered at all. */
  readonly rpcStatus: number | null;
  /** JSON-RPC error code, from the typed error or the response body. */
  readonly rpcCode: number | null;
  /** Host name only of the endpoint that answered last. */
  readonly rpcUrlHost: string | null;
  /** JSON-RPC method of the failed request. */
  readonly method: string | null;
}

export class BscReadUnavailableError extends Error {
  readonly code = "bsc_read_unavailable";
  /** Present when a Provider error was classified into this reason code. */
  readonly rpcError: BscRpcErrorSummary | null;

  constructor(
    readonly reasonCode: string,
    options: {
      readonly cause?: unknown;
      readonly rpcError?: BscRpcErrorSummary;
    } = {},
  ) {
    super(
      "The BSC read capability is unavailable",
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "BscReadUnavailableError";
    this.rpcError = options.rpcError ?? null;
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
 * Endpoints cap `eth_getLogs` by block span, by result size, by address count,
 * and by quota, and report these through HTTP statuses, JSON-RPC codes, and
 * free-text messages alike (Decision 0068). A shape refusal is narrowed along
 * the dimension its text names (block range, topics, addresses); a refusal
 * that names none — a bare "Request blocked" or "limit exceeded" — is
 * narrowed addresses first, then the wallet topic array, then the block range
 * (Decision 0078: address caps of ~8 are far tighter than go-ethereum's 1,000
 * sub-topics, and a span of at most 2,000 blocks is rarely the cause). Only a
 * single-address, single-wallet, single-block request that is still refused
 * fails closed as `BSC_LOG_QUERY_REJECTED`. Logs are never silently dropped.
 */
const bscLogRangeSplitFloor = 1n;
/**
 * Default and ceiling of token addresses per `eth_getLogs` request
 * (Decision 0078, `BSC_LOG_ADDRESS_CHUNK_SIZE`). The public BSC endpoint
 * that serves wallet-scoped reads accepts 8 addresses and refuses 11 with
 * HTTP 403 / -32602 "Request blocked" whatever the topics or span.
 */
export const defaultBscLogAddressChunkSize = 8;
export const maximumBscLogAddressChunkSize = 100;
/**
 * Consecutive refusal-free segment reads before learned limits are probed one
 * step wider (Decision 0079, amending 0078's 16). One indexer tick issues
 * about three segment reads, so a narrowed client starts re-widening after
 * about two ticks. A probe that is refused on the very next read is rolled
 * back and doubles the streak needed for the next probe, up to
 * `bscLogLimitRelaxMaximumCleanReads`; a probe that holds restores the base
 * streak. A Provider that keeps its cap therefore costs one refusal per
 * 4, 8, 16, then 32 clean reads instead of oscillating.
 */
export const bscLogLimitRelaxAfterCleanReads = 4;
export const bscLogLimitRelaxMaximumCleanReads = 32;
/**
 * Floors of the learned limits (Decision 0079). A shape refusal whose text
 * does not name the dimension may narrow the request in flight below its
 * floor, but the value kept on the client (and reused by every later read)
 * stops at the floor. Only a refusal that names the dimension (`address`,
 * `topic`, `block range`, ...) lowers the kept value below it. At the floors
 * today's wallet-scoped segment (11 tokens, 360 wallets in two topic arrays,
 * 2,000 blocks) is 11 × 4 × 4 = 176 requests per side, inside the 512-read
 * budget, so a client pinned to its floors still finishes a segment.
 */
export const bscLogAddressLimitFloor = 1;
export const bscLogTopicGroupLimitFloor = 100;
export const bscLogRangeLimitFloor = 500n;
/**
 * Warn-level reason code emitted when the learned limits are reset to their
 * configured starting values after `BSC_LOG_QUERY_BUDGET_EXHAUSTED`
 * (Decision 0079), so the next segment probes from the top instead of
 * grinding at the narrowest shape.
 */
export const bscLogLimitsResetReasonCode = "BSC_LOG_LIMITS_RESET";

/**
 * The client's current learned `eth_getLogs` limits (Decision 0079): numbers
 * only, safe to log. `learnedTopicGroupLimit` is capped at the caller's wallet
 * topic chunk (1,000 before any wallet-scoped read).
 */
export interface BscLogQueryLimits {
  readonly learnedAddressLimit: number;
  readonly learnedTopicGroupLimit: number;
  readonly learnedRangeLimit: number;
  readonly relaxAfterCleanReads: number;
}

/**
 * Detail code of a `BSC_LOG_LIMITS_RESET` caused by a throttle that aborted a
 * read while the learned limits were narrowed (Decision 0079). Log-only.
 */
export const bscLogQueryThrottledReasonCode = "BSC_LOG_QUERY_THROTTLED";

export interface BscLogQueryLimitsResetEvent {
  readonly reasonCode: typeof bscLogLimitsResetReasonCode;
  readonly trigger:
    | typeof bscLogQueryBudgetExhaustedReasonCode
    | typeof bscLogQueryThrottledReasonCode;
  readonly before: BscLogQueryLimits;
  readonly after: BscLogQueryLimits;
}
/**
 * Upper bound on client-side `eth_getLogs` reads one segment may issue while
 * it splits (each read is at most one HTTP attempt per endpoint: the log lane
 * never retries the whole chain, Decision 0078). Beyond it the endpoint policy is too restrictive to
 * index through and the read fails closed as
 * `BSC_LOG_QUERY_BUDGET_EXHAUSTED` rather than grinding thousands of
 * requests per segment against a rationed Provider.
 */
export const bscMaximumLogRequestsPerSegment = 512;
export const bscLogQueryRejectedReasonCode = "BSC_LOG_QUERY_REJECTED";
/**
 * Default number of wallet addresses in one topic position's OR array
 * (Decision 0075). go-ethereum and bnb-chain/bsc filters cap one position at
 * 1,000 sub-topics and some gateways refuse large request bodies; 200 keeps a 5x
 * margin under that cap, a request body around 14 KB, and today's wallet set
 * (360 addresses) at two requests per side. A Provider that still refuses a
 * chunk is narrowed like any other shape refusal and fails closed as
 * `BSC_LOG_QUERY_REJECTED`; it never drops the chunk.
 */
export const defaultBscWalletTopicChunkSize = 200;
export const maximumBscWalletTopicChunkSize = 1_000;
export const bscLogWalletFilterInvalidReasonCode =
  "BSC_LOG_WALLET_FILTER_INVALID";
export const bscLogQueryBudgetExhaustedReasonCode =
  "BSC_LOG_QUERY_BUDGET_EXHAUSTED";
/**
 * The endpoint serves only recent blocks and refuses the requested range as
 * an archive (historical) read (Decision 0079, S82d). Narrowing cannot help:
 * the read fails closed at once, the learned limits are left untouched, and
 * the lane reports how far behind the head the refused segment starts.
 */
export const bscLogArchiveRequiredReasonCode = "BSC_LOG_ARCHIVE_REQUIRED";
/** Mirrors the BSC_CONFIRMATIONS and BSC_REORG_DEPTH_BLOCKS defaults. */
export const defaultBscConfirmations = 15;
export const defaultBscReorgDepthBlocks = 64;
const healthyLatencyMs = 1_500;
const requestTimeoutMs = 6_000;
/**
 * Point reads (`eth_blockNumber`-class head reads, Multicall3 balances,
 * `eth_getBalance`) sit on an interactive screen, so a slow endpoint must be
 * abandoned for the next one in seconds rather than after the log-scan budget
 * (Decision 0063). Range scans, simulations, and gas estimates keep the longer
 * budget: those are batch-shaped and a premature timeout would make the whole
 * read fail closed for no reason.
 */
const pointReadTimeoutMs = 2_500;

/**
 * Stable, non-reversible endpoint reference. It lets operators correlate a
 * degraded endpoint across responses without publishing the Provider URL.
 */
export function endpointRefFor(url: string): string {
  return `rpc-${createHash("sha256").update(url).digest("hex").slice(0, 12)}`;
}

/**
 * Displayable endpoint label (Decision 0049): the URL's host name only, so a
 * user can tell endpoints apart without the scheme, port, path, query, or
 * user-info that may carry a provider key. Falls back to the opaque ref when
 * the URL cannot be parsed.
 */
export function endpointLabelFor(url: string): string {
  try {
    const { hostname } = new URL(url);
    return hostname.length === 0 ? endpointRefFor(url) : hostname;
  } catch {
    return endpointRefFor(url);
  }
}

export interface BscTransportFactory {
  /**
   * `timeoutMs` is the per-attempt budget for the lane the transport serves.
   * A test seam may ignore it; the HTTP transport applies it per endpoint so
   * the fallback chain moves on instead of waiting out a stalled endpoint.
   */
  (url: string, options: { readonly timeoutMs: number }): Transport;
}

export interface CreateBscReadClientOptions {
  readonly config: BscRpcChainConfig;
  /** Test seam: supplies a mock transport instead of an HTTP transport. */
  readonly transportFactory?: BscTransportFactory;
  readonly now?: () => Date;
  readonly monotonicMs?: () => number;
  /**
   * Called (synchronously, errors swallowed) when the learned log-query
   * limits are reset after a read ran out of budget (Decision 0079).
   */
  readonly onLogQueryLimitsReset?: (event: BscLogQueryLimitsResetEvent) => void;
}

type ViemClient = PublicClient<Transport, Chain>;

/**
 * One `eth_getLogs` request of a segment read. `topics` is the wallet topic
 * OR array of a wallet-scoped read (Decision 0075), `null` otherwise.
 */
interface LogRangeRequest {
  readonly from: bigint;
  readonly to: bigint;
  readonly addresses: readonly Address[];
  readonly topics: readonly Address[] | null;
}

/**
 * Every error an endpoint returned for the `eth_getLogs` request currently in
 * flight (Decision 0078). viem's `fallback` rethrows only the *last*
 * endpoint's error, so a quota-exhausted endpoint at the end of the list
 * would hide the shape refusal an earlier endpoint gave; the range reader
 * classifies all of them.
 */
const logEndpointErrors = new AsyncLocalStorage<unknown[]>();

function observeEndpointErrors(transport: Transport): Transport {
  return (parameters) => {
    const inner = transport(parameters);
    const request = (async (...args: Parameters<typeof inner.request>) => {
      try {
        return await inner.request(...args);
      } catch (error) {
        logEndpointErrors.getStore()?.push(error);
        throw error;
      }
    }) as typeof inner.request;
    return { ...inner, request };
  };
}

type LogQueryDimension = "addresses" | "topics" | "range";
const logQueryNarrowingOrder: readonly LogQueryDimension[] = [
  "addresses",
  "topics",
  "range",
];
const dimensionHints: readonly (readonly [LogQueryDimension, RegExp])[] = [
  ["addresses", /address/i],
  ["topics", /topic/i],
  [
    "range",
    /block range|range (?:is )?too|too wide|blocks? span|max(?:imum)? (?:block )?range|more than \d+ (?:results|logs|blocks)|too many (?:results|logs|blocks)|returned more than|response size/i,
  ],
];

/** Dimensions the refusal texts name explicitly (Decision 0078). */
function hintedDimensions(errors: readonly unknown[]): Set<LogQueryDimension> {
  const hinted = new Set<LogQueryDimension>();
  for (const error of errors) {
    for (const candidate of walkCauses(error)) {
      const text = refusalText(candidate);
      if (text === null) {
        continue;
      }
      for (const [dimension, pattern] of dimensionHints) {
        if (pattern.test(text)) {
          hinted.add(dimension);
        }
      }
    }
  }
  return hinted;
}

function defaultTransport(
  url: string,
  options: { readonly timeoutMs: number },
): Transport {
  return http(url, { timeout: options.timeoutMs, retryCount: 0 });
}

/**
 * viem's built-in definition for the configured chain reference. Both carry
 * the Multicall3 address; the testnet one is used only for native balance
 * reads in this step (Decision 0038), never through Multicall3.
 */
function viemChainFor(reference: LaunchChainReference): Chain {
  return reference === bscTestnetChainReference ? bscTestnet : bsc;
}

function asAddress(value: string): Address {
  return value as Address;
}

function normalizeHex(value: string): string {
  return value.toLowerCase();
}

const walletAddressPattern = /^0x[0-9a-f]{40}$/;

/**
 * Splits a wallet filter into topic OR arrays (Decision 0075): `null` when the
 * read is not wallet-scoped, `[]` when the scope is empty. Addresses are
 * lower-cased, de-duplicated, and sorted so the chunking is deterministic.
 * A malformed address or chunk size fails the read closed rather than
 * widening or narrowing the scope.
 */
function walletTopicGroups(
  filter: BscWalletLogFilter | undefined,
): (readonly Address[])[] | null {
  if (filter === undefined) {
    return null;
  }
  const size = filter.topicChunkSize;
  if (
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > maximumBscWalletTopicChunkSize
  ) {
    throw new BscReadUnavailableError(bscLogWalletFilterInvalidReasonCode);
  }
  const wallets = [
    ...new Set(filter.walletAddresses.map((address) => normalizeHex(address))),
  ].sort();
  if (wallets.some((address) => !walletAddressPattern.test(address))) {
    throw new BscReadUnavailableError(bscLogWalletFilterInvalidReasonCode);
  }
  const groups: (readonly Address[])[] = [];
  for (let index = 0; index < wallets.length; index += size) {
    groups.push(wallets.slice(index, index + size).map(asAddress));
  }
  return groups;
}

/**
 * Merges the per-side reads of one wallet-scoped query. A transfer between
 * two indexed wallets matches both the `from` and the `to` read; it is kept
 * once, keyed by (transaction hash, log index), and the result is in block
 * and log order.
 */
function mergeLogSides<
  T extends {
    readonly transactionHash: string;
    readonly blockNumber: bigint;
    readonly logIndex: number;
  },
>(sides: readonly (readonly T[])[]): T[] {
  const unique = new Map<string, T>();
  for (const side of sides) {
    for (const log of side) {
      unique.set(
        `${normalizeHex(log.transactionHash)}:${String(log.logIndex)}`,
        log,
      );
    }
  }
  return [...unique.values()].sort((left, right) => {
    if (left.blockNumber !== right.blockNumber) {
      return left.blockNumber < right.blockNumber ? -1 : 1;
    }
    return left.logIndex - right.logIndex;
  });
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

const safeNamePattern = /^[A-Za-z0-9_.-]{1,64}$/;
const safeHostPattern = /^[A-Za-z0-9.-]{1,253}$/;

function walkCauses(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  while (
    typeof current === "object" &&
    current !== null &&
    chain.length < 16 &&
    !chain.includes(current)
  ) {
    chain.push(current);
    current = "cause" in current ? current.cause : undefined;
  }
  return chain;
}

/**
 * True when the error (or any error in its cause chain) is a transport-level
 * failure of an RPC request: viem's per-request timeout, an HTTP/socket
 * failure, or a closed socket (Decision 0082). Such a failure says nothing
 * about the chain; it only says the endpoint did not answer in time, so a
 * read route reports it as unreachable instead of an internal error.
 */
export function isBscRpcTransportError(error: unknown): boolean {
  return walkCauses(error).some(
    (candidate) =>
      candidate instanceof TimeoutError ||
      candidate instanceof HttpRequestError ||
      candidate instanceof SocketClosedError,
  );
}

function numberField(candidate: unknown, key: string): number | null {
  if (typeof candidate !== "object" || candidate === null) {
    return null;
  }
  const value = (candidate as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

function stringField(candidate: unknown, key: string): string | null {
  if (typeof candidate !== "object" || candidate === null) {
    return null;
  }
  const value = (candidate as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

/**
 * A JSON-RPC error code embedded in an HTTP error body, as a Provider that
 * refuses a request with a 4xx status and a JSON-RPC-shaped body reports it
 * (e.g. `403 {"code":-32602,"message":"Request blocked"}`). Only the numeric
 * code is read; the body text itself is never kept.
 */
function rpcCodeFromDetails(details: string | null): number | null {
  if (details === null || details.length === 0 || details.length > 4_096) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(details);
    const direct = numberField(parsed, "code");
    if (direct !== null) {
      return direct;
    }
    return numberField(
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)["error"]
        : null,
      "code",
    );
  } catch {
    return null;
  }
}

function methodFromBody(body: unknown): string | null {
  const candidate: unknown = Array.isArray(body) ? body[0] : body;
  const method = stringField(candidate, "method");
  return method !== null && safeNamePattern.test(method) ? method : null;
}

/**
 * Classifies any error into loggable fields (Decision 0068). It walks the
 * `cause` chain viem builds (typed RPC error → `RpcRequestError` /
 * `HttpRequestError`) and keeps only the class name, numeric status and code,
 * the endpoint host name, and the method name. It never returns the URL, the
 * request body, or any message text.
 */
export function summarizeRpcError(error: unknown): BscRpcErrorSummary {
  const chain = walkCauses(error);
  const first = chain[0];
  const constructorName =
    typeof first === "object" && first !== null
      ? stringField(
          (first as { readonly constructor?: unknown }).constructor ?? null,
          "name",
        )
      : null;
  const rawName =
    stringField(first, "name") ??
    constructorName ??
    (typeof first === "object" ? "Unknown" : typeof error);
  const errorClass = safeNamePattern.test(rawName) ? rawName : "Unknown";
  let rpcStatus: number | null = null;
  let rpcCode: number | null = null;
  let rpcUrlHost: string | null = null;
  let method: string | null = null;
  for (const candidate of chain) {
    rpcStatus ??= numberField(candidate, "status");
    const code = numberField(candidate, "code");
    rpcCode ??= code !== null && code !== -1 ? code : null;
    const url = stringField(candidate, "url");
    if (rpcUrlHost === null && url !== null) {
      const label = endpointLabelFor(url);
      rpcUrlHost = safeHostPattern.test(label) ? label : null;
    }
    method ??= methodFromBody(
      typeof candidate === "object" && candidate !== null
        ? (candidate as Record<string, unknown>)["body"]
        : null,
    );
  }
  if (rpcCode === null) {
    for (const candidate of chain) {
      rpcCode ??= rpcCodeFromDetails(stringField(candidate, "details"));
    }
  }
  return Object.freeze({ errorClass, rpcStatus, rpcCode, rpcUrlHost, method });
}

/**
 * Two kinds of refusal, treated differently (Decision 0068 as amended by the
 * S71 review):
 *
 * - `shape`: the endpoint objects to the *request* — too many blocks,
 *   addresses, or results, or a blanket "Request blocked". Narrowing helps,
 *   so the range reader splits.
 * - `throttle`: the endpoint objects to the *rate* — 429, "rate limit",
 *   "too many requests", "quota", "usage limit". Narrowing would multiply
 *   the requests against the same quota, so the error propagates unchanged
 *   to the lane's exponential backoff.
 * - `archive` (Decision 0079, S82d): the endpoint objects to the *age* of the
 *   blocks — it keeps only recent state/history and refuses older ranges
 *   whatever their shape. Observed 2026-09-25: publicnode mainnet answers
 *   HTTP 403 / -32602 "Archive requests require a personal token" about
 *   10,000 blocks behind the head; publicnode testnet answers -32701
 *   "History has been pruned for this block". Narrowing only multiplies the
 *   refusals, so it is checked before the shape codes (-32602 would
 *   otherwise read as a shape refusal) and never narrows.
 */
export type LogQueryRefusal = "shape" | "throttle" | "archive";

const shapeStatuses = new Set([413]);
const shapeCodes = new Set<number>([
  InvalidParamsRpcError.code, // -32602: "Request blocked", range/address caps
  LimitExceededRpcError.code, // -32005: result cap
]);
const throttleStatuses = new Set([429]);
/**
 * "too many" is a rate objection ("too many requests") except when it names
 * a part of the filter: a topic or address array a Provider finds too long
 * is a shape refusal that narrowing fixes (Decision 0075).
 */
const filterPartPattern = "(?:sub-?)?topics|addresses|logs|results";
const throttlePattern = new RegExp(
  `rate limit|too many(?! (?:${filterPartPattern}))|quota|usage limit`,
  "i",
);
/**
 * Age objections. "archive" and "personal token" are publicnode's mainnet
 * wording, "pruned" its testnet (and go-ethereum's history-expiry) wording,
 * "historical" the generic form some gateways use ("historical data/state/
 * blocks not available").
 */
const archivePattern =
  /archive|personal token|pruned|historical|missing trie node/i;
const shapePattern = new RegExp(
  `limit exceeded|request blocked|block range|more than|too wide|too large|exceed|too many (?:${filterPartPattern})`,
  "i",
);

/**
 * The refusal text a candidate error is allowed to contribute: the
 * `details` of a JSON-RPC error (`RpcRequestError` and the typed errors
 * viem builds on it) or of a 4xx `HttpRequestError`. A 5xx body is never
 * read: a gateway page that happens to say "blocked" is an outage, not a
 * refusal. Message text of plain errors is not consulted either.
 */
function refusalText(candidate: unknown): string | null {
  const details = stringField(candidate, "details");
  if (details === null) {
    return null;
  }
  const status = numberField(candidate, "status");
  if (status !== null && (status < 400 || status >= 500)) {
    return null;
  }
  return details;
}

export function classifyLogQueryError(error: unknown): LogQueryRefusal | null {
  const summary = summarizeRpcError(error);
  if (
    summary.rpcStatus !== null &&
    (summary.rpcStatus < 400 || summary.rpcStatus >= 500)
  ) {
    return null;
  }
  if (summary.rpcStatus !== null && throttleStatuses.has(summary.rpcStatus)) {
    return "throttle";
  }
  const texts = walkCauses(error).flatMap((candidate) => {
    const text = refusalText(candidate);
    return text === null ? [] : [text];
  });
  if (texts.some((text) => throttlePattern.test(text))) {
    return "throttle";
  }
  if (texts.some((text) => archivePattern.test(text))) {
    return "archive";
  }
  if (
    error instanceof LimitExceededRpcError ||
    error instanceof InvalidParamsRpcError
  ) {
    return "shape";
  }
  if (summary.rpcStatus !== null && shapeStatuses.has(summary.rpcStatus)) {
    return "shape";
  }
  if (summary.rpcCode !== null && shapeCodes.has(summary.rpcCode)) {
    return "shape";
  }
  return texts.some((text) => shapePattern.test(text)) ? "shape" : null;
}

/** Whether narrowing the request can help: a `shape` refusal only. */
export function isLogQueryRejection(error: unknown): boolean {
  return classifyLogQueryError(error) === "shape";
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
  const chain = viemChainFor(config.chainReference);
  const endpoints: readonly {
    readonly endpointRef: string;
    readonly label: string;
    readonly client: ViemClient;
  }[] = config.rpcUrls.map((url) => ({
    endpointRef: endpointRefFor(url),
    label: endpointLabelFor(url),
    client: createPublicClient({
      chain,
      transport: transportFactory(url, { timeoutMs: pointReadTimeoutMs }),
    }),
  }));
  const aggregate: ViemClient = createPublicClient({
    chain,
    transport: fallback(
      config.rpcUrls.map((url) =>
        transportFactory(url, { timeoutMs: requestTimeoutMs }),
      ),
    ),
  });
  /**
   * The interactive lane (Decision 0063): the same endpoints in the same
   * order, but a short per-endpoint budget and no whole-chain retry, so one
   * stalled endpoint costs one budget instead of multiplying it. It reads the
   * same chain as `aggregate` and never returns a different fact.
   */
  const pointReadAggregate: ViemClient = createPublicClient({
    chain,
    transport: fallback(
      config.rpcUrls.map((url) =>
        transportFactory(url, { timeoutMs: pointReadTimeoutMs }),
      ),
      { retryCount: 0 },
    ),
  });
  /**
   * The `eth_getLogs` lane (Decision 0078): the range-scan budget, one
   * attempt per endpoint and no whole-chain retry. A refused request costs
   * one pass over the endpoint list (seconds) instead of four (viem's default
   * fallback `retryCount` of 3); a transient failure propagates to the lane's
   * exponential backoff, and every endpoint error is recorded for
   * `readLogRangeWith`.
   */
  const logAggregate: ViemClient = createPublicClient({
    chain,
    transport: fallback(
      config.rpcUrls.map((url) =>
        observeEndpointErrors(
          transportFactory(url, { timeoutMs: requestTimeoutMs }),
        ),
      ),
      { retryCount: 0 },
    ),
  });
  const configuredAddressChunk = config.logAddressChunkSize;
  const addressChunkCeiling =
    configuredAddressChunk !== undefined &&
    Number.isSafeInteger(configuredAddressChunk) &&
    configuredAddressChunk >= 1 &&
    configuredAddressChunk <= maximumBscLogAddressChunkSize
      ? configuredAddressChunk
      : defaultBscLogAddressChunkSize;

  let verification: ChainVerificationState = "unknown";
  let verificationInFlight: Promise<ChainVerificationState> | null = null;
  /**
   * Request shape the endpoints are known to accept, learned from shape
   * refusals and kept on this client across reads (and indexer ticks, and
   * both log lanes that share the client) so the next segment is issued at
   * the known-good shape instead of rediscovering it (Decision 0078).
   * Decision 0079 bounds it: an unhinted refusal never keeps a value below
   * the dimension's floor; after `relaxAfterCleanReads` consecutive
   * refusal-free reads every learned limit is probed one doubling wider,
   * capped at its ceiling (2,000 blocks, the configured address chunk, the
   * caller's topic chunk); and a read that runs out of budget resets every
   * learned limit to its ceiling.
   */
  let learnedRangeLimit: bigint = bscMaximumLogRange;
  let learnedAddressLimit: number = addressChunkCeiling;
  /** Same discipline for wallet topic OR arrays (Decision 0075). */
  let topicChunkCeiling: number = maximumBscWalletTopicChunkSize;
  let learnedTopicLimit: number = topicChunkCeiling;
  let consecutiveCleanReads = 0;
  let relaxAfterCleanReads = bscLogLimitRelaxAfterCleanReads;
  /** Limits before the last relaxation, until the next read confirms it. */
  let relaxProbe: {
    readonly range: bigint;
    readonly addresses: number;
    readonly topics: number;
  } | null = null;

  function currentLogQueryLimits(): BscLogQueryLimits {
    return Object.freeze({
      learnedAddressLimit,
      learnedTopicGroupLimit: Math.min(learnedTopicLimit, topicChunkCeiling),
      learnedRangeLimit: Number(learnedRangeLimit),
      relaxAfterCleanReads,
    });
  }

  function relaxLearnedLimits(): void {
    const before = {
      range: learnedRangeLimit,
      addresses: learnedAddressLimit,
      topics: learnedTopicLimit,
    };
    const relaxedRange = learnedRangeLimit * 2n;
    learnedRangeLimit =
      relaxedRange < bscMaximumLogRange ? relaxedRange : bscMaximumLogRange;
    learnedAddressLimit = Math.min(
      addressChunkCeiling,
      learnedAddressLimit * 2,
    );
    learnedTopicLimit = Math.min(
      Math.max(topicChunkCeiling, learnedTopicLimit),
      learnedTopicLimit * 2,
    );
    const widened =
      learnedRangeLimit !== before.range ||
      learnedAddressLimit !== before.addresses ||
      Math.min(learnedTopicLimit, topicChunkCeiling) !==
        Math.min(before.topics, topicChunkCeiling);
    relaxProbe = widened ? before : null;
  }

  /**
   * Books one finished segment read (Decision 0079). A refused read ends the
   * clean streak; if it is the first read after a relaxation, the widening
   * is rolled back and the next probe waits twice as long (at most
   * `bscLogLimitRelaxMaximumCleanReads`). A clean read confirms a pending
   * probe (the base streak is restored) and extends the streak.
   */
  function recordSegmentRead(refused: boolean): void {
    const probe = relaxProbe;
    relaxProbe = null;
    if (refused) {
      consecutiveCleanReads = 0;
      if (probe !== null) {
        learnedRangeLimit =
          probe.range < learnedRangeLimit ? probe.range : learnedRangeLimit;
        learnedAddressLimit = Math.min(learnedAddressLimit, probe.addresses);
        learnedTopicLimit = Math.min(learnedTopicLimit, probe.topics);
        relaxAfterCleanReads = Math.min(
          bscLogLimitRelaxMaximumCleanReads,
          relaxAfterCleanReads * 2,
        );
      }
      return;
    }
    if (probe !== null) {
      relaxAfterCleanReads = bscLogLimitRelaxAfterCleanReads;
    }
    consecutiveCleanReads += 1;
    if (consecutiveCleanReads >= relaxAfterCleanReads) {
      consecutiveCleanReads = 0;
      relaxLearnedLimits();
    }
  }

  /** Whether any learned limit is below its ceiling. */
  function learnedLimitsNarrowed(): boolean {
    return (
      learnedAddressLimit < addressChunkCeiling ||
      learnedTopicLimit < topicChunkCeiling ||
      learnedRangeLimit < bscMaximumLogRange
    );
  }

  /**
   * Decision 0079: the learned shape is evidently not one the endpoints serve
   * within their budget (`BSC_LOG_QUERY_BUDGET_EXHAUSTED`) or their rate (a
   * throttle aborted a read while narrowed: a narrow shape multiplies the
   * requests of every segment), so every limit returns to its configured
   * starting value and the next segment probes from the top. A real cap is
   * re-learned from one refusal per halving.
   */
  function resetLearnedLimits(
    trigger: BscLogQueryLimitsResetEvent["trigger"],
  ): void {
    const before = currentLogQueryLimits();
    learnedRangeLimit = bscMaximumLogRange;
    learnedAddressLimit = addressChunkCeiling;
    learnedTopicLimit = topicChunkCeiling;
    consecutiveCleanReads = 0;
    relaxAfterCleanReads = bscLogLimitRelaxAfterCleanReads;
    relaxProbe = null;
    try {
      options.onLogQueryLimitsReset?.(
        Object.freeze({
          reasonCode: bscLogLimitsResetReasonCode,
          trigger,
          before,
          after: currentLogQueryLimits(),
        }),
      );
    } catch {
      // Observability must never turn a classified failure into another.
    }
  }

  async function probeVerification(): Promise<ChainVerificationState> {
    try {
      const chainId = await pointReadAggregate.getChainId();
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
   * Reads one segment, narrowing the request whenever the Provider refuses
   * its shape (Decision 0068, order Decision 0078, floors Decision 0079).
   * Before a request is sent it is split to the effective limits (addresses,
   * then wallet topics, then block range): the learned limit, or tighter if
   * this read already narrowed below a floor. A shape refusal — from the
   * endpoint whose error viem rethrows or from any earlier endpoint in the
   * fallback list — halves the dimension the refusal text names, or, when it
   * names none, the first dimension (addresses, topics, range) still above
   * its floor, and only then one below it. The walk is iterative and
   * bounded: the whole read fails closed — never a partial page — when a
   * single-address, single-wallet, single-block request is still refused or
   * when the read budget runs out (which also resets the learned limits).
   * A throttle from any endpoint of the request wins over a shape refusal
   * from another (Decision 0079) and propagates unchanged (resetting the
   * learned limits first when they are narrowed), as does a
   * timeout or a transport failure with no shape refusal beside it. An
   * archive refusal with no shape refusal beside it (S82d) fails the read
   * closed as `BSC_LOG_ARCHIVE_REQUIRED` without narrowing or resetting.
   * Collected logs are returned in block order regardless of split order.
   */
  async function readLogRangeWith<
    T extends {
      readonly blockNumber: bigint | null;
      readonly logIndex: number | null;
    },
  >(
    read: (request: LogRangeRequest) => Promise<readonly T[]>,
    addresses: readonly Address[],
    fromBlock: bigint,
    toBlock: bigint,
    topicGroups: readonly (readonly Address[])[] | null = null,
    topicChunk: number | null = null,
  ): Promise<T[]> {
    if (topicChunk !== null) {
      topicChunkCeiling = topicChunk;
    }
    const pending: LogRangeRequest[] =
      topicGroups === null
        ? [{ from: fromBlock, to: toBlock, addresses, topics: null }]
        : topicGroups.map((topics) => ({
            from: fromBlock,
            to: toBlock,
            addresses,
            topics,
          }));
    /**
     * Narrowing below a floor that no refusal text justified: it applies to
     * the rest of this read only and is never written back (Decision 0079).
     */
    let readAddressLimit = Number.MAX_SAFE_INTEGER;
    let readTopicLimit = Number.MAX_SAFE_INTEGER;
    let readRangeLimit = bscMaximumLogRange;
    const collected: T[] = [];
    let requestCount = 0;
    let refused = false;
    while (pending.length > 0) {
      const request = pending.shift();
      if (request === undefined) {
        break;
      }
      const addressLimit = Math.min(learnedAddressLimit, readAddressLimit);
      if (request.addresses.length > addressLimit) {
        pending.unshift(...splitAddresses(request, addressLimit));
        continue;
      }
      const topicLimit = Math.min(learnedTopicLimit, readTopicLimit);
      if (request.topics !== null && request.topics.length > topicLimit) {
        pending.unshift(...splitTopics(request, topicLimit));
        continue;
      }
      const rangeLimit =
        readRangeLimit < learnedRangeLimit ? readRangeLimit : learnedRangeLimit;
      if (request.to - request.from + 1n > rangeLimit) {
        const middle = request.from + (request.to - request.from) / 2n;
        pending.unshift(
          { ...request, to: middle },
          { ...request, from: middle + 1n },
        );
        continue;
      }
      if (requestCount >= bscMaximumLogRequestsPerSegment) {
        resetLearnedLimits(bscLogQueryBudgetExhaustedReasonCode);
        throw new BscReadUnavailableError(bscLogQueryBudgetExhaustedReasonCode);
      }
      requestCount += 1;
      const endpointErrors: unknown[] = [];
      try {
        collected.push(
          ...(await logEndpointErrors.run(endpointErrors, () => read(request))),
        );
      } catch (error) {
        const candidates = [...endpointErrors, error];
        // A rate objection anywhere in the request is temporary; narrowing
        // would only spend the quota faster (Decision 0079).
        const throttle = candidates.find(
          (candidate) => classifyLogQueryError(candidate) === "throttle",
        );
        if (throttle !== undefined) {
          if (learnedLimitsNarrowed()) {
            resetLearnedLimits(bscLogQueryThrottledReasonCode);
          }
          // Recorded endpoint errors are what the transports threw: rethrow
          // the rate objection itself so the lane logs its status and host.
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw throttle;
        }
        const shapeRefusals = candidates.filter((candidate) =>
          isLogQueryRejection(candidate),
        );
        if (shapeRefusals.length === 0) {
          // An age objection (S82d) is final for this read: no narrowing,
          // no reset, the learned limits stay what they were.
          const archive = candidates.find(
            (candidate) => classifyLogQueryError(candidate) === "archive",
          );
          if (archive !== undefined) {
            throw new BscReadUnavailableError(bscLogArchiveRequiredReasonCode, {
              cause: archive,
              rpcError: summarizeRpcError(archive),
            });
          }
          throw error;
        }
        refused = true;
        const hinted = hintedDimensions(shapeRefusals);
        const dimension = narrowingDimension(request, hinted);
        if (dimension === null) {
          const refusal = isLogQueryRejection(error)
            ? error
            : shapeRefusals[shapeRefusals.length - 1];
          throw new BscReadUnavailableError(bscLogQueryRejectedReasonCode, {
            cause: refusal,
            rpcError: summarizeRpcError(refusal),
          });
        }
        const named = hinted.has(dimension);
        switch (dimension) {
          case "addresses": {
            const half = Math.ceil(request.addresses.length / 2);
            readAddressLimit = Math.min(readAddressLimit, half);
            learnedAddressLimit = Math.min(
              learnedAddressLimit,
              named ? half : Math.max(half, bscLogAddressLimitFloor),
            );
            break;
          }
          case "topics": {
            const half = Math.ceil((request.topics?.length ?? 1) / 2);
            readTopicLimit = Math.min(readTopicLimit, half);
            learnedTopicLimit = Math.min(
              learnedTopicLimit,
              named ? half : Math.max(half, bscLogTopicGroupLimitFloor),
            );
            break;
          }
          case "range": {
            const half = (request.to - request.from + 2n) / 2n;
            if (half < readRangeLimit) {
              readRangeLimit = half;
            }
            const kept =
              named || half >= bscLogRangeLimitFloor
                ? half
                : bscLogRangeLimitFloor;
            if (kept < learnedRangeLimit) {
              learnedRangeLimit = kept;
            }
            break;
          }
        }
        pending.unshift(request);
      }
    }
    recordSegmentRead(refused);
    return collected.sort((left, right) => {
      const leftBlock = left.blockNumber ?? -1n;
      const rightBlock = right.blockNumber ?? -1n;
      if (leftBlock !== rightBlock) {
        return leftBlock < rightBlock ? -1 : 1;
      }
      return (left.logIndex ?? -1) - (right.logIndex ?? -1);
    });
  }

  /**
   * The dimension to halve after a shape refusal: the first one in
   * `logQueryNarrowingOrder` the refusal names and the request can still
   * narrow; else the first one still above its floor (Decision 0079); else
   * the first one it can narrow at all; `null` at one address, one wallet,
   * one block.
   */
  function narrowingDimension(
    request: LogRangeRequest,
    hinted: ReadonlySet<LogQueryDimension>,
  ): LogQueryDimension | null {
    const size = (dimension: LogQueryDimension): bigint => {
      switch (dimension) {
        case "addresses": {
          return BigInt(request.addresses.length);
        }
        case "topics": {
          return BigInt(request.topics?.length ?? 0);
        }
        case "range": {
          return request.to - request.from + 1n;
        }
      }
    };
    const floor = (dimension: LogQueryDimension): bigint => {
      switch (dimension) {
        case "addresses": {
          return BigInt(bscLogAddressLimitFloor);
        }
        case "topics": {
          return BigInt(bscLogTopicGroupLimitFloor);
        }
        case "range": {
          return bscLogRangeLimitFloor;
        }
      }
    };
    const narrowable = (dimension: LogQueryDimension): boolean =>
      size(dimension) > bscLogRangeSplitFloor;
    return (
      logQueryNarrowingOrder.find(
        (dimension) => hinted.has(dimension) && narrowable(dimension),
      ) ??
      logQueryNarrowingOrder.find(
        (dimension) =>
          narrowable(dimension) && size(dimension) > floor(dimension),
      ) ??
      logQueryNarrowingOrder.find((dimension) => narrowable(dimension)) ??
      null
    );
  }

  function splitTopics(
    request: LogRangeRequest,
    groupSize: number,
  ): LogRangeRequest[] {
    const topics = request.topics ?? [];
    const groups: LogRangeRequest[] = [];
    for (let index = 0; index < topics.length; index += groupSize) {
      groups.push({
        ...request,
        topics: topics.slice(index, index + groupSize),
      });
    }
    return groups;
  }

  function splitAddresses<R extends { readonly addresses: readonly Address[] }>(
    request: R,
    groupSize: number,
  ): R[] {
    const groups: R[] = [];
    for (let index = 0; index < request.addresses.length; index += groupSize) {
      groups.push({
        ...request,
        addresses: request.addresses.slice(index, index + groupSize),
      });
    }
    return groups;
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
    logQueryLimits: currentLogQueryLimits,

    async getHead(): Promise<BscChainHead> {
      await requireVerifiedChain();
      return readHead(pointReadAggregate);
    },

    async getBlockHash(blockNumber: bigint): Promise<string | null> {
      await requireVerifiedChain();
      try {
        const block = await pointReadAggregate.getBlock({ blockNumber });
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
      const head = await readHead(pointReadAggregate);
      const ownerAddress = asAddress(owner);
      const tokenItems = items.filter((item) => item.address !== null);
      const nativeItems = items.filter((item) => item.address === null);

      // The token multicall and the native read are two independent calls
      // pinned to the same block, so they are issued together. Concurrency
      // changes when the answers arrive, never which block answered.
      const readTokenBalances = async (): Promise<
        readonly BscBalanceResult[]
      > => {
        if (tokenItems.length === 0) {
          return [];
        }
        const results = await pointReadAggregate.multicall({
          allowFailure: true,
          blockNumber: head.blockNumber,
          contracts: tokenItems.map((item) => ({
            address: asAddress(item.address as string),
            abi: erc20BalanceAbi,
            functionName: "balanceOf" as const,
            args: [ownerAddress] as const,
          })),
        });
        return tokenItems.map((item, index) => {
          const result = results[index];
          if (result === undefined || result.status === "failure") {
            return Object.freeze({
              assetId: item.assetId,
              rawValue: null,
              reasonCode: "BSC_BALANCE_CALL_FAILED",
            });
          }
          return Object.freeze({
            assetId: item.assetId,
            rawValue: result.result,
            reasonCode: null,
          });
        });
      };
      const [tokenResults, nativeResults] = await Promise.all([
        readTokenBalances(),
        Promise.all(
          nativeItems.map(async (item) => {
            try {
              return Object.freeze({
                assetId: item.assetId,
                rawValue: await pointReadAggregate.getBalance({
                  address: ownerAddress,
                  blockNumber: head.blockNumber,
                }),
                reasonCode: null,
              });
            } catch {
              return Object.freeze({
                assetId: item.assetId,
                rawValue: null,
                reasonCode: "BSC_BALANCE_CALL_FAILED",
              });
            }
          }),
        ),
      ]);

      const balances: readonly BscBalanceResult[] = [
        ...tokenResults,
        ...nativeResults,
      ];

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
      const walletGroups = walletTopicGroups(query.walletFilter);
      if (
        query.addresses.length === 0 ||
        (walletGroups !== null && walletGroups.length === 0)
      ) {
        return Object.freeze([]);
      }
      const tokens = [...query.addresses].map(asAddress);
      // A wallet-scoped read is two topic-filtered reads, `from ∈ W` and
      // `to ∈ W`, merged on (transaction hash, log index) (Decision 0075).
      const readSide = (side: "from" | "to" | null) =>
        readLogRangeWith(
          (request) =>
            logAggregate.getLogs({
              address: [...request.addresses],
              event: erc20TransferEvent,
              args:
                side === null || request.topics === null
                  ? {}
                  : side === "from"
                    ? { from: [...request.topics] }
                    : { to: [...request.topics] },
              fromBlock: request.from,
              toBlock: request.to,
            }),
          tokens,
          query.fromBlock,
          query.toBlock,
          side === null ? null : walletGroups,
          side === null ? null : (query.walletFilter?.topicChunkSize ?? null),
        );
      const decode = (
        logs: Awaited<ReturnType<typeof readSide>>,
      ): BscTransferLog[] =>
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
        });
      if (walletGroups === null) {
        return Object.freeze(decode(await readSide(null)));
      }
      const fromSide = decode(await readSide("from"));
      const toSide = decode(await readSide("to"));
      return Object.freeze(mergeLogSides([fromSide, toSide]));
    },

    async readPoolEventLogs(
      query: BscLogRangeQuery,
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
      const logs = await readLogRangeWith(
        (request) =>
          logAggregate.getLogs({
            address: [...request.addresses],
            events: [
              pancakeV3SwapEvent,
              pancakeV3MintEvent,
              pancakeV3BurnEvent,
            ],
            fromBlock: request.from,
            toBlock: request.to,
          }),
        [...query.addresses].map(asAddress),
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
      const walletGroups = walletTopicGroups(query.walletFilter);
      if (
        query.addresses.length === 0 ||
        (walletGroups !== null && walletGroups.length === 0)
      ) {
        return Object.freeze([]);
      }
      // A wallet-scoped read keeps only `owner ∈ W` (Decision 0075): an
      // approval granted *to* a LOOP wallet is not part of its inventory.
      const logs = await readLogRangeWith(
        (request) =>
          logAggregate.getLogs({
            address: [...request.addresses],
            event: erc20ApprovalEvent,
            args: request.topics === null ? {} : { owner: [...request.topics] },
            fromBlock: request.from,
            toBlock: request.to,
          }),
        [...query.addresses].map(asAddress),
        query.fromBlock,
        query.toBlock,
        walletGroups,
        query.walletFilter?.topicChunkSize ?? null,
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
            readonly label: string;
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
                label: endpoint.label,
                latencyMs,
                blockNumber,
                chainVerification: matches ? "verified" : "mismatched",
              };
            } catch {
              return {
                endpointRef: endpoint.endpointRef,
                label: endpoint.label,
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
            label: probe.label,
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
 * The launch slot passes its own identity and reason code (Decision 0038).
 */
export function createUnavailableBscReadClient(
  options: {
    readonly chainId?: LaunchChainId;
    readonly chainReference?: LaunchChainReference;
    readonly confirmations?: number;
    readonly reorgDepthBlocks?: number;
    readonly reasonCode?: string;
  } = {},
): BscChainCallClient {
  const reasonCode = options.reasonCode ?? "BSC_RPC_NOT_CONFIGURED";
  const reject = (): Promise<never> =>
    Promise.reject(new BscReadUnavailableError(reasonCode));
  return Object.freeze({
    chainId: options.chainId ?? bscChainId,
    chainReference: options.chainReference ?? bscChainReference,
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
