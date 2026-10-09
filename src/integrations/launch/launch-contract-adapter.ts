import {
  createPublicClient,
  decodeEventLog,
  encodeFunctionData,
  fallback,
  http,
  type Address,
  type Chain,
  type ContractFunctionReturnType,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";
import { bsc, bscTestnet } from "viem/chains";

import {
  bscTestnetChainReference,
  type LaunchChainId,
  type LaunchChainReference,
} from "../../features/chain/chain-contract.js";
import {
  launchContractReasonCodes,
  launchEntitlementStates,
  launchFinalOutcomes,
  launchLiquidityStates,
  launchOperationalStates,
  launchSaleStates,
  type LaunchContractReasonCode,
  type LaunchEntitlementState,
  type LaunchFinalOutcome,
  type LaunchLiquidityState,
  type LaunchOperationalState,
  type LaunchSaleState,
} from "../../features/launch/launch-contract.js";
import type { ChainVerificationState } from "../bsc/rpc-client.js";
import { launchpadAbiV1 } from "./launchpad-abi.v1.js";

/**
 * LoopLaunchpad adapter (Decision 0076). The only module that speaks the
 * Launch contract ABI: block-pinned reads, calldata encoding for the three
 * user calls, and event decoding. It never signs, never broadcasts, and
 * knows nothing about launches, accounts, or HTTP. Endpoint URLs stay inside
 * the viem transports: no error, log field, or result carries one.
 */

/** Parsed `LAUNCH_CONTRACT_*` / `LAUNCH_USD1_ADDRESS` keys (all or nothing). */
export interface LaunchContractConfig {
  /** Lowercase 0x + 40 hex. */
  readonly address: string;
  /** Semantic version `MAJOR.MINOR.PATCH` of the deployed contract. */
  readonly version: string;
  readonly versionMajor: number;
  /** Deployment block; the S83b event lane starts here. */
  readonly startBlock: bigint;
  /** Lowercase 0x + 40 hex. */
  readonly usd1Address: string;
}

/** The ABI major this adapter speaks. */
export const launchContractAbiMajor = 1;

export interface LaunchContractSnapshot {
  readonly blockNumber: bigint;
  /** Lowercase 0x + 64 hex. */
  readonly blockHash: string;
}

export interface LaunchContractRead<T> {
  readonly value: T;
  readonly snapshot: LaunchContractSnapshot;
}

export interface LaunchSaleStateTuple {
  readonly saleState: LaunchSaleState;
  readonly entitlementState: LaunchEntitlementState;
  readonly liquidityState: LaunchLiquidityState;
  readonly operationalState: LaunchOperationalState;
  /** bytes32, lowercase. */
  readonly configVersion: string;
  /** bytes32, lowercase; exactly as `getState` returned it. */
  readonly stateTupleDigest: string;
}

export interface LaunchContractRound {
  readonly roundId: number;
  readonly startAt: bigint;
  readonly endAt: bigint;
  readonly priceUsd1PerToken: bigint;
  readonly roundCapUsd1: bigint;
  readonly walletRoundCapUsd1: bigint;
  readonly allowlistRoot: string;
  readonly raisedUsd1: bigint;
}

export interface LaunchContractSaleConfig {
  readonly projectToken: string;
  readonly usd1: string;
  readonly softCapUsd1: bigint;
  readonly hardCapUsd1: bigint;
  readonly walletProjectCapUsd1: bigint;
  readonly minPurchaseUsd1: bigint;
  readonly protocolFeeBps: number;
  readonly liquidityBps: number;
  readonly tgeBps: number;
  readonly cliffSeconds: number;
  readonly vestingSeconds: number;
  readonly poolFeeTier: number;
  readonly lpLockSeconds: number;
  readonly configVersion: string;
}

export interface LaunchContractPosition {
  readonly cumulativeUsd1: bigint;
  readonly purchasedTokens: bigint;
  readonly entitledTokens: bigint;
  readonly claimableTokens: bigint;
  readonly claimedTokens: bigint;
  readonly refundableUsd1: bigint;
  readonly refundedUsd1: bigint;
}

/**
 * The sale-level reads of one projection (Decision 0085): `getState`,
 * `getRounds`, and `getSaleConfig` in one Multicall3 `aggregate3` pinned to
 * `snapshot.blockNumber`, confirmed afterwards like any explicit snapshot.
 */
export interface LaunchSaleSnapshotRead {
  readonly snapshot: LaunchContractSnapshot;
  readonly state: LaunchSaleStateTuple;
  readonly rounds: readonly LaunchContractRound[];
  readonly config: LaunchContractSaleConfig;
}

/** Calldata for one user call. `value` is always 0: the contract takes no BNB. */
export interface LaunchContractCall {
  readonly to: string;
  readonly data: Hex;
  readonly value: 0n;
}

export interface LaunchBuyCallInput {
  readonly saleId: bigint;
  readonly roundId: number;
  readonly usd1Amount: bigint;
  readonly minTokenAmount: bigint;
  /** Unix seconds (uint64). */
  readonly deadline: bigint;
  /** Empty when the round has no allowlist root. */
  readonly eligibilityProof: readonly string[];
}

export interface LaunchContractLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly removed: boolean;
}

interface LaunchEventBase {
  readonly saleId: bigint;
  readonly address: string;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly removed: boolean;
}

/** The 14 events of 06 §3, discriminated by `eventName`. */
export type LaunchContractEvent =
  | (LaunchEventBase & {
      readonly eventName: "SaleStateChanged";
      readonly fromState: LaunchSaleState;
      readonly toState: LaunchSaleState;
      readonly at: bigint;
    })
  | (LaunchEventBase & {
      readonly eventName: "Purchased";
      readonly buyer: string;
      readonly roundId: number;
      readonly usd1Amount: bigint;
      readonly tokenAmount: bigint;
      readonly walletCumulativeUsd1: bigint;
      readonly purchaseIndex: bigint;
    })
  | (LaunchEventBase & {
      readonly eventName: "SaleFinalized";
      readonly outcome: LaunchFinalOutcome;
      readonly totalRaisedUsd1: bigint;
      readonly totalTokensSold: bigint;
    })
  | (LaunchEventBase & {
      readonly eventName: "BudgetsFrozen";
      readonly usd1ToLiquidity: bigint;
      readonly tokenToLiquidity: bigint;
      readonly usd1ToProject: bigint;
      readonly protocolFeeUsd1: bigint;
    })
  | (LaunchEventBase & {
      readonly eventName: "RefundLiabilityFrozen";
      readonly wallet: string;
      readonly usd1Amount: bigint;
    })
  | (LaunchEventBase & {
      readonly eventName: "Refunded";
      readonly wallet: string;
      readonly usd1Amount: bigint;
      readonly cumulativeRefunded: bigint;
    })
  | (LaunchEventBase & {
      readonly eventName: "VestingScheduleCreated";
      readonly tgeBps: number;
      readonly cliffSeconds: number;
      readonly durationSeconds: number;
      readonly tgeAt: bigint;
    })
  | (LaunchEventBase & {
      readonly eventName: "Claimed";
      readonly wallet: string;
      readonly tokenAmount: bigint;
      readonly cumulativeClaimed: bigint;
    })
  | (LaunchEventBase & {
      readonly eventName: "PoolPrepared";
      readonly pool: string;
      readonly feeTier: number;
      readonly initialSqrtPriceX96: bigint;
      readonly tickLower: number;
      readonly tickUpper: number;
    })
  | (LaunchEventBase & {
      readonly eventName: "LiquidityAdded";
      readonly pool: string;
      readonly lpTokenId: bigint;
      readonly usd1Amount: bigint;
      readonly tokenAmount: bigint;
    })
  | (LaunchEventBase & {
      readonly eventName: "LPNFTLocked";
      readonly locker: string;
      readonly lpTokenId: bigint;
      readonly unlockAt: bigint;
    })
  | (LaunchEventBase & {
      readonly eventName: "LiquidityRetryScheduled";
      readonly reasonCode: string;
      readonly retryAfter: bigint;
    })
  | (LaunchEventBase & {
      readonly eventName: "Paused";
      readonly by: string;
    })
  | (LaunchEventBase & {
      readonly eventName: "Unpaused";
      readonly by: string;
    });

export type LaunchContractEventName = LaunchContractEvent["eventName"];

export interface UnrecognizedLaunchLog {
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly topic0: string | null;
}

export interface LaunchContractDecodeResult {
  readonly events: readonly LaunchContractEvent[];
  /**
   * Logs of the contract that are not one of the 14 (for example an
   * OpenZeppelin `OwnershipTransferred`). Reported, never guessed at.
   */
  readonly unrecognized: readonly UnrecognizedLaunchLog[];
}

export type LaunchContractAvailability =
  | { readonly status: "available" }
  | {
      readonly status: "unavailable";
      readonly reasonCode: LaunchContractReasonCode;
    };

export interface LaunchContractAdapter {
  /** The configured contract, or null when the four keys are blank. */
  readonly contract: LaunchContractConfig | null;
  readonly chainId: LaunchChainId;
  /** Probes (chain ID, then `eth_getCode`) when not yet settled. */
  availability(): Promise<LaunchContractAvailability>;
  /** What the last probe observed; never blocks, never probes. */
  currentAvailability(): LaunchContractAvailability;
  /** One non-blocking startup probe; logs a warning when unavailable. */
  verifyAtStartup(): Promise<LaunchContractAvailability>;
  /** The launch slot's latest block, the anchor of a multi-read projection. */
  takeSnapshot(): Promise<LaunchContractSnapshot>;
  /** Throws `LAUNCH_SNAPSHOT_REORGED` when the block hash has changed. */
  confirmSnapshot(snapshot: LaunchContractSnapshot): Promise<void>;
  /**
   * Decision 0085: the four axes, rounds, and configuration of one sale at
   * one block, in one `eth_call` (Multicall3) between the head read and the
   * reorg check. A successful read may be served again, unchanged, for
   * `snapshotCacheTtlMs`; a failed read is never cached.
   */
  readSaleSnapshot(saleId: bigint): Promise<LaunchSaleSnapshotRead>;
  getState(
    saleId: bigint,
    snapshot?: LaunchContractSnapshot,
  ): Promise<LaunchContractRead<LaunchSaleStateTuple>>;
  getRounds(
    saleId: bigint,
    snapshot?: LaunchContractSnapshot,
  ): Promise<LaunchContractRead<readonly LaunchContractRound[]>>;
  getSaleConfig(
    saleId: bigint,
    snapshot?: LaunchContractSnapshot,
  ): Promise<LaunchContractRead<LaunchContractSaleConfig>>;
  quote(
    input: {
      readonly saleId: bigint;
      readonly roundId: number;
      readonly usd1Amount: bigint;
    },
    snapshot?: LaunchContractSnapshot,
  ): Promise<LaunchContractRead<bigint>>;
  getPosition(
    input: { readonly saleId: bigint; readonly wallet: string },
    snapshot?: LaunchContractSnapshot,
  ): Promise<LaunchContractRead<LaunchContractPosition>>;
  getRoundPosition(
    input: {
      readonly saleId: bigint;
      readonly roundId: number;
      readonly wallet: string;
    },
    snapshot?: LaunchContractSnapshot,
  ): Promise<LaunchContractRead<bigint>>;
  encodeBuy(input: LaunchBuyCallInput): LaunchContractCall;
  encodeClaim(saleId: bigint): LaunchContractCall;
  encodeClaimRefund(saleId: bigint): LaunchContractCall;
  /** Decodes logs emitted by the configured contract; others are refused. */
  decodeEvents(logs: readonly LaunchContractLog[]): LaunchContractDecodeResult;
  /**
   * Raw `eth_getLogs` of the configured contract over an inclusive block
   * range of at most `launchContractMaximumLogRange` blocks (Decision 0077).
   */
  readLogs(range: {
    readonly fromBlock: bigint;
    readonly toBlock: bigint;
  }): Promise<readonly LaunchContractLog[]>;
  /** One block header: number, hash, and unix-second timestamp. */
  readBlock(blockNumber: bigint): Promise<LaunchContractBlock>;
}

export interface LaunchContractBlock {
  readonly blockNumber: bigint;
  /** Lowercase 0x + 64 hex. */
  readonly blockHash: string;
  /** Unix seconds. */
  readonly timestamp: bigint;
}

/** Maximum block span of one `readLogs` request (same bound as 0034). */
export const launchContractMaximumLogRange = 2_000n;

export class LaunchContractUnavailableError extends Error {
  readonly code = "launch_contract_unavailable";

  constructor(
    readonly reasonCode: LaunchContractReasonCode,
    options: { readonly cause?: unknown } = {},
  ) {
    super(
      "The Launch contract is unavailable",
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "LaunchContractUnavailableError";
  }
}

// ---------------------------------------------------------------------------
// Pure encoding and decoding
// ---------------------------------------------------------------------------

const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const bytes32Pattern = /^0x[0-9a-fA-F]{64}$/;
const maximumUint16 = 0xffff;
const maximumUint64 = (1n << 64n) - 1n;
const maximumUint256 = (1n << 256n) - 1n;

function invalid(): never {
  throw new LaunchContractUnavailableError(
    launchContractReasonCodes.readInvalid,
  );
}

function enumAt<T extends string>(values: readonly T[], raw: number): T {
  const value = values[raw];
  return value === undefined ? invalid() : value;
}

function lower(value: string): string {
  return value.toLowerCase();
}

function requireUint(value: bigint, maximum: bigint, field: string): bigint {
  if (value < 0n || value > maximum) {
    throw new RangeError(`${field} is out of range`);
  }
  return value;
}

function requireRoundId(roundId: number): number {
  if (!Number.isInteger(roundId) || roundId < 0 || roundId > maximumUint16) {
    throw new RangeError("roundId is out of range");
  }
  return roundId;
}

function requireAddress(value: string, field: string): Address {
  if (!addressPattern.test(value)) {
    throw new RangeError(`${field} must be a 20-byte address`);
  }
  return lower(value) as Address;
}

function requireBytes32(value: string): Hex {
  if (!bytes32Pattern.test(value)) {
    throw new RangeError("eligibilityProof items must be bytes32");
  }
  return lower(value) as Hex;
}

export function encodeLaunchBuyCalldata(input: LaunchBuyCallInput): Hex {
  return encodeFunctionData({
    abi: launchpadAbiV1,
    functionName: "buy",
    // Parameter order is 06 §4.1, verbatim.
    args: [
      requireUint(input.saleId, maximumUint256, "saleId"),
      requireRoundId(input.roundId),
      requireUint(input.usd1Amount, maximumUint256, "usd1Amount"),
      requireUint(input.minTokenAmount, maximumUint256, "minTokenAmount"),
      requireUint(input.deadline, maximumUint64, "deadline"),
      input.eligibilityProof.map(requireBytes32),
    ],
  });
}

export function encodeLaunchClaimCalldata(saleId: bigint): Hex {
  return encodeFunctionData({
    abi: launchpadAbiV1,
    functionName: "claim",
    args: [requireUint(saleId, maximumUint256, "saleId")],
  });
}

export function encodeLaunchClaimRefundCalldata(saleId: bigint): Hex {
  return encodeFunctionData({
    abi: launchpadAbiV1,
    functionName: "claimRefund",
    args: [requireUint(saleId, maximumUint256, "saleId")],
  });
}

function outcomeFor(raw: number): LaunchFinalOutcome {
  const state = enumAt(launchSaleStates, raw);
  return (launchFinalOutcomes as readonly string[]).includes(state)
    ? (state as LaunchFinalOutcome)
    : invalid();
}

/**
 * Decodes raw logs against ABI v1. A log whose `topic0` is not one of the 14
 * events is reported in `unrecognized`; a log that matches a signature but
 * does not decode (wrong data length, out-of-range enum) is
 * `LAUNCH_CONTRACT_READ_INVALID`, because a matching topic with a wrong body
 * means the deployed contract is not ABI v1.
 */
export function decodeLaunchpadLogs(
  logs: readonly LaunchContractLog[],
): LaunchContractDecodeResult {
  const events: LaunchContractEvent[] = [];
  const unrecognized: UnrecognizedLaunchLog[] = [];
  for (const log of logs) {
    const topics = log.topics as readonly Hex[];
    let decoded;
    try {
      decoded = decodeEventLog({
        abi: launchpadAbiV1,
        data: log.data as Hex,
        topics: topics as [Hex, ...Hex[]],
        strict: true,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "AbiEventSignatureNotFoundError"
      ) {
        unrecognized.push(
          Object.freeze({
            transactionHash: lower(log.transactionHash),
            logIndex: log.logIndex,
            topic0: topics[0] === undefined ? null : lower(topics[0]),
          }),
        );
        continue;
      }
      return invalid();
    }
    const base = {
      saleId: decoded.args.saleId,
      address: lower(log.address),
      blockNumber: log.blockNumber,
      blockHash: lower(log.blockHash),
      transactionHash: lower(log.transactionHash),
      logIndex: log.logIndex,
      removed: log.removed,
    };
    events.push(Object.freeze(projectEvent(decoded, base)));
  }
  return Object.freeze({
    events: Object.freeze(events),
    unrecognized: Object.freeze(unrecognized),
  });
}

type DecodedLaunchLog = ReturnType<
  typeof decodeEventLog<typeof launchpadAbiV1>
>;

function projectEvent(
  decoded: DecodedLaunchLog,
  base: LaunchEventBase,
): LaunchContractEvent {
  switch (decoded.eventName) {
    case "SaleStateChanged": {
      return {
        ...base,
        eventName: decoded.eventName,
        fromState: enumAt(launchSaleStates, decoded.args.fromState),
        toState: enumAt(launchSaleStates, decoded.args.toState),
        at: decoded.args.at,
      };
    }
    case "Purchased": {
      return {
        ...base,
        eventName: decoded.eventName,
        buyer: lower(decoded.args.buyer),
        roundId: decoded.args.roundId,
        usd1Amount: decoded.args.usd1Amount,
        tokenAmount: decoded.args.tokenAmount,
        walletCumulativeUsd1: decoded.args.walletCumulativeUsd1,
        purchaseIndex: decoded.args.purchaseIndex,
      };
    }
    case "SaleFinalized": {
      return {
        ...base,
        eventName: decoded.eventName,
        outcome: outcomeFor(decoded.args.outcome),
        totalRaisedUsd1: decoded.args.totalRaisedUsd1,
        totalTokensSold: decoded.args.totalTokensSold,
      };
    }
    case "BudgetsFrozen": {
      return {
        ...base,
        eventName: decoded.eventName,
        usd1ToLiquidity: decoded.args.usd1ToLiquidity,
        tokenToLiquidity: decoded.args.tokenToLiquidity,
        usd1ToProject: decoded.args.usd1ToProject,
        protocolFeeUsd1: decoded.args.protocolFeeUsd1,
      };
    }
    case "RefundLiabilityFrozen": {
      return {
        ...base,
        eventName: decoded.eventName,
        wallet: lower(decoded.args.wallet),
        usd1Amount: decoded.args.usd1Amount,
      };
    }
    case "Refunded": {
      return {
        ...base,
        eventName: decoded.eventName,
        wallet: lower(decoded.args.wallet),
        usd1Amount: decoded.args.usd1Amount,
        cumulativeRefunded: decoded.args.cumulativeRefunded,
      };
    }
    case "VestingScheduleCreated": {
      return {
        ...base,
        eventName: decoded.eventName,
        tgeBps: decoded.args.tgeBps,
        cliffSeconds: decoded.args.cliffSeconds,
        durationSeconds: decoded.args.durationSeconds,
        tgeAt: decoded.args.tgeAt,
      };
    }
    case "Claimed": {
      return {
        ...base,
        eventName: decoded.eventName,
        wallet: lower(decoded.args.wallet),
        tokenAmount: decoded.args.tokenAmount,
        cumulativeClaimed: decoded.args.cumulativeClaimed,
      };
    }
    case "PoolPrepared": {
      return {
        ...base,
        eventName: decoded.eventName,
        pool: lower(decoded.args.pool),
        feeTier: decoded.args.feeTier,
        initialSqrtPriceX96: decoded.args.initialSqrtPriceX96,
        tickLower: decoded.args.tickLower,
        tickUpper: decoded.args.tickUpper,
      };
    }
    case "LiquidityAdded": {
      return {
        ...base,
        eventName: decoded.eventName,
        pool: lower(decoded.args.pool),
        lpTokenId: decoded.args.lpTokenId,
        usd1Amount: decoded.args.usd1Amount,
        tokenAmount: decoded.args.tokenAmount,
      };
    }
    case "LPNFTLocked": {
      return {
        ...base,
        eventName: decoded.eventName,
        locker: lower(decoded.args.locker),
        lpTokenId: decoded.args.lpTokenId,
        unlockAt: decoded.args.unlockAt,
      };
    }
    case "LiquidityRetryScheduled": {
      return {
        ...base,
        eventName: decoded.eventName,
        reasonCode: lower(decoded.args.reasonCode),
        retryAfter: decoded.args.retryAfter,
      };
    }
    case "Paused": {
      return {
        ...base,
        eventName: decoded.eventName,
        by: lower(decoded.args.by),
      };
    }
    case "Unpaused": {
      return {
        ...base,
        eventName: decoded.eventName,
        by: lower(decoded.args.by),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Read projections (one per struct-returning function; shared by the single
// reads and the Decision 0085 multicall)
// ---------------------------------------------------------------------------

type LaunchpadOutput<Name extends "getState" | "getRounds" | "getSaleConfig"> =
  ContractFunctionReturnType<typeof launchpadAbiV1, "view", Name>;

function stateTupleFrom(
  state: LaunchpadOutput<"getState">,
): LaunchSaleStateTuple {
  return Object.freeze({
    saleState: enumAt(launchSaleStates, state.saleState),
    entitlementState: enumAt(launchEntitlementStates, state.entitlementState),
    liquidityState: enumAt(launchLiquidityStates, state.liquidityState),
    operationalState: enumAt(launchOperationalStates, state.operationalState),
    configVersion: lower(state.configVersion),
    stateTupleDigest: lower(state.stateTupleDigest),
  });
}

function roundsFrom(
  rounds: LaunchpadOutput<"getRounds">,
): readonly LaunchContractRound[] {
  return Object.freeze(
    rounds.map((round) =>
      Object.freeze({
        roundId: round.roundId,
        startAt: round.startAt,
        endAt: round.endAt,
        priceUsd1PerToken: round.priceUsd1PerToken,
        roundCapUsd1: round.roundCapUsd1,
        walletRoundCapUsd1: round.walletRoundCapUsd1,
        allowlistRoot: lower(round.allowlistRoot),
        raisedUsd1: round.raisedUsd1,
      }),
    ),
  );
}

function saleConfigFrom(
  config: LaunchpadOutput<"getSaleConfig">,
): LaunchContractSaleConfig {
  return Object.freeze({
    projectToken: lower(config.projectToken),
    usd1: lower(config.usd1),
    softCapUsd1: config.softCapUsd1,
    hardCapUsd1: config.hardCapUsd1,
    walletProjectCapUsd1: config.walletProjectCapUsd1,
    minPurchaseUsd1: config.minPurchaseUsd1,
    protocolFeeBps: config.protocolFeeBps,
    liquidityBps: config.liquidityBps,
    tgeBps: config.tgeBps,
    cliffSeconds: config.cliffSeconds,
    vestingSeconds: config.vestingSeconds,
    poolFeeTier: config.poolFeeTier,
    lpLockSeconds: config.lpLockSeconds,
    configVersion: lower(config.configVersion),
  });
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface LaunchContractTransportFactory {
  (url: string, options: { readonly timeoutMs: number }): Transport;
}

export interface LaunchContractAdapterLogger {
  warn(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
}

export interface CreateLaunchContractAdapterInput {
  readonly contract: LaunchContractConfig | null;
  readonly chain: {
    readonly chainId: LaunchChainId;
    readonly chainReference: LaunchChainReference;
    readonly rpcUrls: readonly string[];
  };
  /** The launch slot's cached `eth_chainId` verification (Decision 0038). */
  readonly verifyChain: () => Promise<ChainVerificationState>;
  /** Test seam: a mock transport instead of HTTP. */
  readonly transportFactory?: LaunchContractTransportFactory;
  /**
   * Decision 0085: how long (ms) a successful `readSaleSnapshot` is served
   * again from memory. 0 (the default) disables the cache; the API passes
   * `LAUNCH_SNAPSHOT_CACHE_TTL_MS`.
   */
  readonly snapshotCacheTtlMs?: number;
  /** Test seam: the cache clock, in milliseconds. */
  readonly nowMs?: () => number;
  readonly logger?: LaunchContractAdapterLogger;
}

/** Same per-endpoint budget as the 0038 point-read lane. */
const readTimeoutMs = 2_500;

function defaultTransport(
  url: string,
  options: { readonly timeoutMs: number },
): Transport {
  return http(url, { timeout: options.timeoutMs, retryCount: 0 });
}

function viemChainFor(reference: LaunchChainReference): Chain {
  return reference === bscTestnetChainReference ? bscTestnet : bsc;
}

type CodeState = "unknown" | "present" | "missing" | "unreachable";

const zeroBytes32 = `0x${"0".repeat(64)}`;

export function createLaunchContractAdapter(
  input: CreateLaunchContractAdapterInput,
): LaunchContractAdapter {
  const { contract, chain } = input;
  const transportFactory = input.transportFactory ?? defaultTransport;
  const client: PublicClient<Transport, Chain> | null =
    contract === null || chain.rpcUrls.length === 0
      ? null
      : createPublicClient({
          chain: viemChainFor(chain.chainReference),
          transport: fallback(
            chain.rpcUrls.map((url) =>
              transportFactory(url, { timeoutMs: readTimeoutMs }),
            ),
            { retryCount: 0 },
          ),
        });
  let codeState: CodeState = "unknown";
  let chainState: ChainVerificationState = "unknown";
  let probeInFlight: Promise<LaunchContractAvailability> | null = null;

  const available: LaunchContractAvailability = Object.freeze({
    status: "available",
  });
  function unavailable(
    reasonCode: LaunchContractReasonCode,
  ): LaunchContractAvailability {
    return Object.freeze({ status: "unavailable", reasonCode });
  }

  /** Reasons that need no network: configuration alone decides them. */
  function staticReason(): LaunchContractReasonCode | null {
    if (contract === null) {
      return launchContractReasonCodes.baselinePending;
    }
    if (contract.versionMajor !== launchContractAbiMajor) {
      return launchContractReasonCodes.versionUnsupported;
    }
    if (client === null) {
      return launchContractReasonCodes.chainRpcNotConfigured;
    }
    return null;
  }

  function currentAvailability(): LaunchContractAvailability {
    const reason = staticReason();
    if (reason !== null) {
      return unavailable(reason);
    }
    if (chainState === "mismatched") {
      return unavailable(launchContractReasonCodes.chainIdMismatch);
    }
    switch (codeState) {
      case "present": {
        return chainState === "verified"
          ? available
          : unavailable(launchContractReasonCodes.chainRpcUnreachable);
      }
      case "missing": {
        return unavailable(launchContractReasonCodes.codeMissing);
      }
      case "unreachable": {
        return unavailable(launchContractReasonCodes.chainRpcUnreachable);
      }
      case "unknown": {
        return unavailable(launchContractReasonCodes.verificationPending);
      }
    }
  }

  async function probe(): Promise<LaunchContractAvailability> {
    chainState = await input.verifyChain();
    if (chainState === "mismatched") {
      return currentAvailability();
    }
    if (chainState !== "verified") {
      if (codeState === "unknown") {
        codeState = "unreachable";
      }
      return currentAvailability();
    }
    if (codeState === "present" || codeState === "missing") {
      return currentAvailability();
    }
    try {
      const code = await (client as PublicClient<Transport, Chain>).getCode({
        address: (contract as LaunchContractConfig).address as Address,
      });
      // Empty code is a chain fact and stays sticky until a restart.
      codeState = code === undefined || code === "0x" ? "missing" : "present";
    } catch {
      codeState = "unreachable";
    }
    return currentAvailability();
  }

  function availability(): Promise<LaunchContractAvailability> {
    const reason = staticReason();
    if (reason !== null) {
      return Promise.resolve(unavailable(reason));
    }
    if (chainState === "verified" && codeState === "present") {
      return Promise.resolve(available);
    }
    if (codeState === "missing" || chainState === "mismatched") {
      return Promise.resolve(currentAvailability());
    }
    if (probeInFlight !== null) {
      return probeInFlight;
    }
    const pending = probe().finally(() => {
      probeInFlight = null;
    });
    probeInFlight = pending;
    return pending;
  }

  async function requireReadable(): Promise<{
    readonly client: PublicClient<Transport, Chain>;
    readonly address: Address;
  }> {
    const state = await availability();
    if (state.status === "unavailable") {
      throw new LaunchContractUnavailableError(state.reasonCode);
    }
    return {
      client: client as PublicClient<Transport, Chain>,
      address: (contract as LaunchContractConfig).address as Address,
    };
  }

  function readFailed(error: unknown): never {
    if (error instanceof LaunchContractUnavailableError) {
      throw error;
    }
    throw new LaunchContractUnavailableError(
      launchContractReasonCodes.readFailed,
      { cause: error },
    );
  }

  async function takeSnapshot(): Promise<LaunchContractSnapshot> {
    const { client: readClient } = await requireReadable();
    try {
      // A non-pending block always carries its number and hash (viem types).
      const block = await readClient.getBlock({ blockTag: "latest" });
      return Object.freeze({
        blockNumber: block.number,
        blockHash: lower(block.hash),
      });
    } catch (error) {
      return readFailed(error);
    }
  }

  async function confirmSnapshot(
    snapshot: LaunchContractSnapshot,
  ): Promise<void> {
    const { client: readClient } = await requireReadable();
    let hash: string;
    try {
      const block = await readClient.getBlock({
        blockNumber: snapshot.blockNumber,
      });
      hash = lower(block.hash);
    } catch (error) {
      return readFailed(error);
    }
    if (hash !== snapshot.blockHash) {
      throw new LaunchContractUnavailableError(
        launchContractReasonCodes.snapshotReorged,
      );
    }
  }

  /**
   * Runs one `eth_call` pinned to the snapshot block. Without a snapshot the
   * read takes one and confirms it; with one, the caller confirms once after
   * all of its reads (one reorg check per projection).
   */
  async function pinned<T>(
    snapshot: LaunchContractSnapshot | undefined,
    read: (
      readClient: PublicClient<Transport, Chain>,
      address: Address,
      blockNumber: bigint,
    ) => Promise<T>,
  ): Promise<LaunchContractRead<T>> {
    const { client: readClient, address } = await requireReadable();
    const anchor = snapshot ?? (await takeSnapshot());
    let value: T;
    try {
      value = await read(readClient, address, anchor.blockNumber);
    } catch (error) {
      return callFailed(error);
    }
    if (snapshot === undefined) {
      await confirmSnapshot(anchor);
    }
    return Object.freeze({ value, snapshot: anchor });
  }

  /** One classification for every `eth_call` failure (Decision 0076). */
  function callFailed(error: unknown): never {
    if (
      error instanceof LaunchContractUnavailableError ||
      error instanceof RangeError
    ) {
      throw error instanceof RangeError
        ? new LaunchContractUnavailableError(
            launchContractReasonCodes.readInvalid,
            { cause: error },
          )
        : error;
    }
    if (
      error instanceof Error &&
      /AbiDecodingDataSizeTooSmall|AbiDecodingZeroData|InvalidAbiDecoding|PositionOutOfBounds/.test(
        error.name,
      )
    ) {
      throw new LaunchContractUnavailableError(
        launchContractReasonCodes.readInvalid,
        { cause: error },
      );
    }
    return readFailed(error);
  }

  /**
   * Decision 0085: head → one Multicall3 `aggregate3` at that block carrying
   * `getState`, `getRounds`, `getSaleConfig` → reorg check. Three round
   * trips, one `eth_call`; any failure is the whole read's failure, so a
   * partial or mixed-block result can never be returned.
   */
  async function readSaleUncached(
    saleId: bigint,
  ): Promise<LaunchSaleSnapshotRead> {
    const { client: readClient, address } = await requireReadable();
    const anchor = await takeSnapshot();
    let values: Omit<LaunchSaleSnapshotRead, "snapshot">;
    try {
      const id = requireUint(saleId, maximumUint256, "saleId");
      const [state, rounds, config] = await readClient.multicall({
        allowFailure: false,
        blockNumber: anchor.blockNumber,
        contracts: [
          {
            address,
            abi: launchpadAbiV1,
            functionName: "getState",
            args: [id],
          },
          {
            address,
            abi: launchpadAbiV1,
            functionName: "getRounds",
            args: [id],
          },
          {
            address,
            abi: launchpadAbiV1,
            functionName: "getSaleConfig",
            args: [id],
          },
        ],
      });
      values = {
        state: stateTupleFrom(state),
        rounds: roundsFrom(rounds),
        config: saleConfigFrom(config),
      };
    } catch (error) {
      return callFailed(error);
    }
    await confirmSnapshot(anchor);
    return Object.freeze({ snapshot: anchor, ...values });
  }

  const snapshotCacheTtlMs = Math.max(0, input.snapshotCacheTtlMs ?? 0);
  const nowMs = input.nowMs ?? ((): number => Date.now());
  /**
   * saleId → the in-flight or settled read. In memory only; a pending entry
   * is shared by concurrent callers, a settled one lives `snapshotCacheTtlMs`
   * from the moment its read started, a rejected one is dropped at once.
   */
  const saleSnapshots = new Map<
    string,
    { promise: Promise<LaunchSaleSnapshotRead>; expiresAt: number }
  >();

  function readSaleSnapshot(saleId: bigint): Promise<LaunchSaleSnapshotRead> {
    if (snapshotCacheTtlMs === 0) {
      return readSaleUncached(saleId);
    }
    const key = saleId.toString();
    const startedAt = nowMs();
    const cached = saleSnapshots.get(key);
    if (cached !== undefined && startedAt < cached.expiresAt) {
      return cached.promise;
    }
    for (const [staleKey, entry] of saleSnapshots) {
      if (entry.expiresAt <= startedAt) {
        saleSnapshots.delete(staleKey);
      }
    }
    const entry = {
      promise: Promise.resolve() as unknown as Promise<LaunchSaleSnapshotRead>,
      expiresAt: Number.POSITIVE_INFINITY,
    };
    entry.promise = readSaleUncached(saleId).then(
      (value) => {
        entry.expiresAt = startedAt + snapshotCacheTtlMs;
        return value;
      },
      (error: unknown) => {
        if (saleSnapshots.get(key) === entry) {
          saleSnapshots.delete(key);
        }
        throw error;
      },
    );
    saleSnapshots.set(key, entry);
    return entry.promise;
  }

  function requireCallTarget(): string {
    const reason = staticReason();
    if (reason !== null) {
      throw new LaunchContractUnavailableError(reason);
    }
    return (contract as LaunchContractConfig).address;
  }

  function call(data: Hex): LaunchContractCall {
    return Object.freeze({ to: requireCallTarget(), data, value: 0n });
  }

  const adapter: LaunchContractAdapter = {
    contract,
    chainId: chain.chainId,
    availability,
    currentAvailability,

    async verifyAtStartup() {
      const state = await availability();
      if (contract !== null) {
        if (state.status === "unavailable") {
          input.logger?.warn(
            {
              capabilityId: "launch",
              chainId: chain.chainId,
              contractVersion: contract.version,
              reasonCode: state.reasonCode,
            },
            "Launch contract is unavailable at startup",
          );
        } else {
          input.logger?.info(
            {
              capabilityId: "launch",
              chainId: chain.chainId,
              contractVersion: contract.version,
            },
            "Launch contract code observed on the launch chain",
          );
        }
      }
      return state;
    },

    takeSnapshot,
    confirmSnapshot,
    readSaleSnapshot,

    getState(saleId, snapshot) {
      return pinned(snapshot, async (readClient, address, blockNumber) =>
        stateTupleFrom(
          await readClient.readContract({
            address,
            abi: launchpadAbiV1,
            functionName: "getState",
            args: [requireUint(saleId, maximumUint256, "saleId")],
            blockNumber,
          }),
        ),
      );
    },

    getRounds(saleId, snapshot) {
      return pinned(snapshot, async (readClient, address, blockNumber) =>
        roundsFrom(
          await readClient.readContract({
            address,
            abi: launchpadAbiV1,
            functionName: "getRounds",
            args: [requireUint(saleId, maximumUint256, "saleId")],
            blockNumber,
          }),
        ),
      );
    },

    getSaleConfig(saleId, snapshot) {
      return pinned(snapshot, async (readClient, address, blockNumber) =>
        saleConfigFrom(
          await readClient.readContract({
            address,
            abi: launchpadAbiV1,
            functionName: "getSaleConfig",
            args: [requireUint(saleId, maximumUint256, "saleId")],
            blockNumber,
          }),
        ),
      );
    },

    quote(request, snapshot) {
      return pinned(snapshot, (readClient, address, blockNumber) =>
        readClient.readContract({
          address,
          abi: launchpadAbiV1,
          functionName: "quote",
          args: [
            requireUint(request.saleId, maximumUint256, "saleId"),
            requireRoundId(request.roundId),
            requireUint(request.usd1Amount, maximumUint256, "usd1Amount"),
          ],
          blockNumber,
        }),
      );
    },

    getPosition(request, snapshot) {
      return pinned(snapshot, async (readClient, address, blockNumber) => {
        const position = await readClient.readContract({
          address,
          abi: launchpadAbiV1,
          functionName: "getPosition",
          args: [
            requireUint(request.saleId, maximumUint256, "saleId"),
            requireAddress(request.wallet, "wallet"),
          ],
          blockNumber,
        });
        return Object.freeze({
          cumulativeUsd1: position.cumulativeUsd1,
          purchasedTokens: position.purchasedTokens,
          entitledTokens: position.entitledTokens,
          claimableTokens: position.claimableTokens,
          claimedTokens: position.claimedTokens,
          refundableUsd1: position.refundableUsd1,
          refundedUsd1: position.refundedUsd1,
        });
      });
    },

    getRoundPosition(request, snapshot) {
      return pinned(snapshot, (readClient, address, blockNumber) =>
        readClient.readContract({
          address,
          abi: launchpadAbiV1,
          functionName: "getRoundPosition",
          args: [
            requireUint(request.saleId, maximumUint256, "saleId"),
            requireRoundId(request.roundId),
            requireAddress(request.wallet, "wallet"),
          ],
          blockNumber,
        }),
      );
    },

    encodeBuy(request) {
      return call(encodeLaunchBuyCalldata(request));
    },

    encodeClaim(saleId) {
      return call(encodeLaunchClaimCalldata(saleId));
    },

    encodeClaimRefund(saleId) {
      return call(encodeLaunchClaimRefundCalldata(saleId));
    },

    async readLogs(range) {
      if (
        range.toBlock < range.fromBlock ||
        range.toBlock - range.fromBlock + 1n > launchContractMaximumLogRange
      ) {
        throw new RangeError("readLogs range is invalid");
      }
      const { client: readClient, address } = await requireReadable();
      let logs;
      try {
        logs = await readClient.getLogs({
          address,
          fromBlock: range.fromBlock,
          toBlock: range.toBlock,
        });
      } catch (error) {
        return readFailed(error);
      }
      const mapped: LaunchContractLog[] = [];
      for (const log of logs) {
        mapped.push(
          Object.freeze({
            address: lower(log.address),
            topics: Object.freeze(log.topics.map((topic) => lower(topic))),
            data: lower(log.data),
            blockNumber: log.blockNumber,
            blockHash: lower(log.blockHash),
            transactionHash: lower(log.transactionHash),
            logIndex: log.logIndex,
            removed: log.removed,
          }),
        );
      }
      return Object.freeze(mapped);
    },

    async readBlock(blockNumber) {
      const { client: readClient } = await requireReadable();
      try {
        const block = await readClient.getBlock({ blockNumber });
        return Object.freeze({
          blockNumber: block.number,
          blockHash: lower(block.hash),
          timestamp: block.timestamp,
        });
      } catch (error) {
        return readFailed(error);
      }
    },

    decodeEvents(logs) {
      const address = requireCallTarget();
      for (const log of logs) {
        if (lower(log.address) !== address) {
          // A foreign log is a caller bug (wrong filter), not a chain fact.
          throw new LaunchContractUnavailableError(
            launchContractReasonCodes.readInvalid,
          );
        }
      }
      return decodeLaunchpadLogs(logs);
    },
  };
  return Object.freeze(adapter);
}

/** True for the all-zero bytes32 an unknown `saleId` reads as. */
export function isZeroBytes32(value: string): boolean {
  return value.toLowerCase() === zeroBytes32;
}
