import {
  createPublicClient,
  decodeEventLog,
  encodeFunctionData,
  fallback,
  http,
  type Address,
  type Chain,
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
import { memeCurveParameters } from "../../features/meme/meme-curve-math.js";
import type { ChainVerificationState } from "../bsc/rpc-client.js";
import { memeCurveAbiV1 } from "./meme-abi.v1.js";

/**
 * LoopMemeCurve adapter (Decision 0101). The only module that speaks the
 * MEME curve ABI: block-pinned reads (`getCurve`, `quoteBuy`, `quoteSell`,
 * `params`), calldata for `createToken / buy / sell / graduate`, and event
 * decoding for the `meme_event` lane. It never signs and never broadcasts
 * (the graduation executor owns its own wallet client), and knows nothing
 * about accounts or HTTP. Endpoint URLs never reach an error or a result.
 */

/** Parsed `MEME_*` contract keys plus the launch slot's USD1 (all or nothing). */
export interface MemeContractConfig {
  /** Lowercase 0x + 40 hex. */
  readonly address: string;
  /** Semantic version `MAJOR.MINOR.PATCH`. */
  readonly version: string;
  readonly versionMajor: number;
  /** Deployment block; the `meme_event` lane starts here. */
  readonly startBlock: bigint;
  /** `LoopMemeToken` implementation the curve clones (CREATE2 input). */
  readonly tokenImplementation: string;
  /** USD1 on the launch slot (`LAUNCH_USD1_ADDRESS`), lowercase. */
  readonly usd1Address: string;
}

export const memeContractAbiMajor = 1;

export const memeContractReasonCodes = Object.freeze({
  notConfigured: "MEME_CONTRACT_NOT_CONFIGURED",
  usd1NotConfigured: "MEME_USD1_NOT_CONFIGURED",
  versionUnsupported: "MEME_CONTRACT_VERSION_UNSUPPORTED",
  chainRpcNotConfigured: "MEME_CHAIN_RPC_NOT_CONFIGURED",
  chainRpcUnreachable: "MEME_CHAIN_RPC_UNREACHABLE",
  chainIdMismatch: "MEME_CHAIN_ID_MISMATCH",
  codeMissing: "MEME_CONTRACT_CODE_MISSING",
  paramsMismatch: "MEME_CONTRACT_PARAMS_MISMATCH",
  verificationPending: "MEME_CONTRACT_VERIFICATION_PENDING",
  readFailed: "MEME_CONTRACT_READ_FAILED",
  readInvalid: "MEME_CONTRACT_READ_INVALID",
  snapshotReorged: "MEME_SNAPSHOT_REORGED",
} as const);

export type MemeContractReasonCode =
  (typeof memeContractReasonCodes)[keyof typeof memeContractReasonCodes];

/** `getCurve(token).status` (loop-contracts 0001 §3.8). */
export const memeCurveStatuses = Object.freeze([
  "NONE",
  "TRADING",
  "FULL",
  "GRADUATED",
  "PAUSED",
] as const);
export type MemeCurveStatus = (typeof memeCurveStatuses)[number];

export interface MemeContractSnapshot {
  readonly blockNumber: bigint;
  readonly blockHash: string;
}

export interface MemeContractRead<T> {
  readonly value: T;
  readonly snapshot: MemeContractSnapshot;
}

export interface MemeCurveRead {
  readonly vUsd1: bigint;
  readonly vToken: bigint;
  readonly realUsd1: bigint;
  readonly sold: bigint;
  readonly createdAt: bigint;
  readonly creator: string;
  readonly status: MemeCurveStatus;
  readonly pool: string;
  readonly graduatedAt: bigint;
}

export interface MemeQuoteBuyRead {
  readonly tokensOut: bigint;
  readonly fee: bigint;
  readonly refund: bigint;
}

export interface MemeQuoteSellRead {
  readonly usd1Out: bigint;
  readonly fee: bigint;
}

export interface MemeContractCall {
  readonly to: string;
  readonly data: Hex;
  readonly value: 0n;
}

export interface MemeContractLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly removed: boolean;
}

interface MemeEventBase {
  readonly address: string;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly removed: boolean;
}

/** The events the `meme_event` lane consumes, by `eventName`. */
export type MemeContractEvent =
  | (MemeEventBase & {
      readonly eventName: "TokenCreated";
      readonly token: string;
      readonly creator: string;
      readonly salt: string;
      readonly metadataHash: string;
      readonly name: string;
      readonly symbol: string;
      readonly at: bigint;
    })
  | (MemeEventBase & {
      readonly eventName: "Trade";
      readonly token: string;
      readonly wallet: string;
      readonly isBuy: boolean;
      readonly usd1Amount: bigint;
      readonly tokenAmount: bigint;
      readonly feeUsd1: bigint;
      readonly vUsd1After: bigint;
      readonly vTokenAfter: bigint;
      readonly soldAfter: bigint;
      readonly at: bigint;
    })
  | (MemeEventBase & {
      readonly eventName: "CurveFull";
      readonly token: string;
      readonly realUsd1: bigint;
      readonly at: bigint;
    })
  | (MemeEventBase & {
      readonly eventName: "Graduated";
      readonly token: string;
      readonly pool: string;
      readonly usd1ToPool: bigint;
      readonly tokensToPool: bigint;
      readonly lpTokenId: bigint;
      readonly feeUsd1: bigint;
      readonly at: bigint;
    })
  | (MemeEventBase & {
      readonly eventName: "GraduationResidual";
      readonly token: string;
      readonly usd1Left: bigint;
      readonly tokensLeft: bigint;
    })
  | (MemeEventBase & {
      readonly eventName: "ResidualInjected";
      readonly token: string;
      readonly pool: string;
      readonly usd1ToPool: bigint;
      readonly tokensToPool: bigint;
      readonly lpTokenId: bigint;
    })
  | (MemeEventBase & {
      readonly eventName: "Paused";
      readonly token: string;
      readonly by: string;
    })
  | (MemeEventBase & {
      readonly eventName: "Unpaused";
      readonly token: string;
      readonly by: string;
    });

export type MemeContractEventName = MemeContractEvent["eventName"];

export const memeLaneEventNames = Object.freeze([
  "TokenCreated",
  "Trade",
  "CurveFull",
  "Graduated",
  "GraduationResidual",
  "ResidualInjected",
  "Paused",
  "Unpaused",
] as const satisfies readonly MemeContractEventName[]);

export interface MemeContractDecodeResult {
  readonly events: readonly MemeContractEvent[];
  /**
   * Logs of the contract the lane does not consume (`TreasuryChanged`,
   * the Ownable events) or does not recognise. Counted, never guessed at.
   */
  readonly ignored: number;
}

export type MemeContractAvailability =
  | { readonly status: "available" }
  | {
      readonly status: "unavailable";
      readonly reasonCode: MemeContractReasonCode;
    };

export interface MemeContractBlock {
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly timestamp: bigint;
}

export interface MemeContractAdapter {
  readonly contract: MemeContractConfig | null;
  readonly chainId: LaunchChainId;
  readonly chainReference: LaunchChainReference;
  /** Probes (chain ID, `eth_getCode`, `params()`) when not yet settled. */
  availability(): Promise<MemeContractAvailability>;
  /** What the last probe observed; never blocks. */
  currentAvailability(): MemeContractAvailability;
  verifyAtStartup(): Promise<MemeContractAvailability>;
  takeSnapshot(): Promise<MemeContractSnapshot>;
  /** Throws `MEME_SNAPSHOT_REORGED` when the block hash has changed. */
  confirmSnapshot(snapshot: MemeContractSnapshot): Promise<void>;
  getCurve(
    token: string,
    snapshot?: MemeContractSnapshot,
  ): Promise<MemeContractRead<MemeCurveRead>>;
  quoteBuy(
    input: { readonly token: string; readonly usd1In: bigint },
    snapshot?: MemeContractSnapshot,
  ): Promise<MemeContractRead<MemeQuoteBuyRead>>;
  quoteSell(
    input: { readonly token: string; readonly tokensIn: bigint },
    snapshot?: MemeContractSnapshot,
  ): Promise<MemeContractRead<MemeQuoteSellRead>>;
  /**
   * Decision 0103: `slot0().sqrtPriceX96` of a graduated token's
   * PancakeSwap V3 pool at the latest block. Throws
   * `MemeContractUnavailableError` when the read fails or the pool is not
   * initialised (zero price).
   */
  readPoolSqrtPriceX96(pool: string): Promise<bigint>;
  encodeCreateToken(input: MemeCreateTokenCallInput): MemeContractCall;
  encodeBuy(input: MemeBuyCallInput): MemeContractCall;
  encodeSell(input: MemeSellCallInput): MemeContractCall;
  encodeGraduate(token: string): MemeContractCall;
  decodeEvents(logs: readonly MemeContractLog[]): MemeContractDecodeResult;
  /** Raw `eth_getLogs` of the curve over at most `memeContractMaximumLogRange` blocks. */
  readLogs(range: {
    readonly fromBlock: bigint;
    readonly toBlock: bigint;
  }): Promise<readonly MemeContractLog[]>;
  readBlock(blockNumber: bigint): Promise<MemeContractBlock>;
}

export interface MemeCreateTokenCallInput {
  readonly salt: string;
  readonly name: string;
  readonly symbol: string;
  readonly metadataHash: string;
  readonly initialBuyUsd1: bigint;
  readonly minTokensOut: bigint;
}

export interface MemeBuyCallInput {
  readonly token: string;
  readonly usd1In: bigint;
  readonly minTokensOut: bigint;
  readonly deadline: bigint;
}

export interface MemeSellCallInput {
  readonly token: string;
  readonly tokensIn: bigint;
  readonly minUsd1Out: bigint;
  readonly deadline: bigint;
}

export const memeContractMaximumLogRange = 2_000n;

/**
 * PancakeSwap V3 pool `slot0()` (Decision 0103). Only `sqrtPriceX96` is
 * read; the other words decode as declared (Pancake's `feeProtocol` is
 * uint32, unlike Uniswap's uint8).
 */
const pancakeV3PoolSlot0Abi = [
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint32" },
      { name: "unlocked", type: "bool" },
    ],
  },
] as const;

export class MemeContractUnavailableError extends Error {
  readonly code = "meme_contract_unavailable";

  constructor(
    readonly reasonCode: MemeContractReasonCode,
    options: { readonly cause?: unknown } = {},
  ) {
    super(
      "The MEME curve contract is unavailable",
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "MemeContractUnavailableError";
  }
}

// ---------------------------------------------------------------------------
// Pure encoding and decoding
// ---------------------------------------------------------------------------

const addressPattern = /^0x[0-9a-fA-F]{40}$/u;
const bytes32Pattern = /^0x[0-9a-fA-F]{64}$/u;
const maximumUint64 = (1n << 64n) - 1n;
const maximumUint256 = (1n << 256n) - 1n;

function lower(value: string): string {
  return value.toLowerCase();
}

function requireUint(value: bigint, maximum: bigint, field: string): bigint {
  if (value < 0n || value > maximum) {
    throw new RangeError(`${field} is out of range`);
  }
  return value;
}

function requireAddress(value: string, field: string): Address {
  if (!addressPattern.test(value)) {
    throw new RangeError(`${field} must be a 20-byte address`);
  }
  return lower(value) as Address;
}

function requireBytes32(value: string, field: string): Hex {
  if (!bytes32Pattern.test(value)) {
    throw new RangeError(`${field} must be bytes32`);
  }
  return lower(value) as Hex;
}

export function encodeMemeCreateTokenCalldata(
  input: MemeCreateTokenCallInput,
): Hex {
  return encodeFunctionData({
    abi: memeCurveAbiV1,
    functionName: "createToken",
    // docs/10 §3.2 order, verbatim.
    args: [
      requireBytes32(input.salt, "salt"),
      input.name,
      input.symbol,
      requireBytes32(input.metadataHash, "metadataHash"),
      requireUint(input.initialBuyUsd1, maximumUint256, "initialBuyUsd1"),
      requireUint(input.minTokensOut, maximumUint256, "minTokensOut"),
    ],
  });
}

export function encodeMemeBuyCalldata(input: MemeBuyCallInput): Hex {
  return encodeFunctionData({
    abi: memeCurveAbiV1,
    functionName: "buy",
    args: [
      requireAddress(input.token, "token"),
      requireUint(input.usd1In, maximumUint256, "usd1In"),
      requireUint(input.minTokensOut, maximumUint256, "minTokensOut"),
      requireUint(input.deadline, maximumUint64, "deadline"),
    ],
  });
}

export function encodeMemeSellCalldata(input: MemeSellCallInput): Hex {
  return encodeFunctionData({
    abi: memeCurveAbiV1,
    functionName: "sell",
    args: [
      requireAddress(input.token, "token"),
      requireUint(input.tokensIn, maximumUint256, "tokensIn"),
      requireUint(input.minUsd1Out, maximumUint256, "minUsd1Out"),
      requireUint(input.deadline, maximumUint64, "deadline"),
    ],
  });
}

export function encodeMemeGraduateCalldata(token: string): Hex {
  return encodeFunctionData({
    abi: memeCurveAbiV1,
    functionName: "graduate",
    args: [requireAddress(token, "token")],
  });
}

function invalid(): never {
  throw new MemeContractUnavailableError(memeContractReasonCodes.readInvalid);
}

function statusAt(raw: number): MemeCurveStatus {
  const value = memeCurveStatuses[raw];
  return value === undefined ? invalid() : value;
}

const consumed: ReadonlySet<string> = new Set(memeLaneEventNames);

/**
 * Decodes raw logs against the v1 ABI. Logs whose event the lane does not
 * consume are counted in `ignored`; a log whose topic matches a consumed
 * event but whose body does not decode is `MEME_CONTRACT_READ_INVALID`,
 * because then the deployed contract is not ABI v1.
 */
export function decodeMemeCurveLogs(
  logs: readonly MemeContractLog[],
): MemeContractDecodeResult {
  const events: MemeContractEvent[] = [];
  let ignored = 0;
  for (const log of logs) {
    const topics = log.topics as readonly Hex[];
    let decoded;
    try {
      decoded = decodeEventLog({
        abi: memeCurveAbiV1,
        data: log.data as Hex,
        topics: topics as [Hex, ...Hex[]],
        strict: true,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "AbiEventSignatureNotFoundError"
      ) {
        ignored += 1;
        continue;
      }
      return invalid();
    }
    if (!consumed.has(decoded.eventName)) {
      ignored += 1;
      continue;
    }
    const base: MemeEventBase = {
      address: lower(log.address),
      blockNumber: log.blockNumber,
      blockHash: lower(log.blockHash),
      transactionHash: lower(log.transactionHash),
      logIndex: log.logIndex,
      removed: log.removed,
    };
    const event = projectEvent(decoded, base);
    if (event !== null) {
      events.push(Object.freeze(event));
    }
  }
  return Object.freeze({ events: Object.freeze(events), ignored });
}

type DecodedMemeLog = ReturnType<typeof decodeEventLog<typeof memeCurveAbiV1>>;

function projectEvent(
  decoded: DecodedMemeLog,
  base: MemeEventBase,
): MemeContractEvent | null {
  switch (decoded.eventName) {
    case "TokenCreated": {
      return {
        ...base,
        eventName: "TokenCreated",
        token: lower(decoded.args.token),
        creator: lower(decoded.args.creator),
        salt: lower(decoded.args.salt),
        metadataHash: lower(decoded.args.metadataHash),
        name: decoded.args.name,
        symbol: decoded.args.symbol,
        at: decoded.args.at,
      };
    }
    case "Trade": {
      return {
        ...base,
        eventName: "Trade",
        token: lower(decoded.args.token),
        wallet: lower(decoded.args.wallet),
        isBuy: decoded.args.isBuy,
        usd1Amount: decoded.args.usd1Amount,
        tokenAmount: decoded.args.tokenAmount,
        feeUsd1: decoded.args.feeUsd1,
        vUsd1After: decoded.args.vUsd1After,
        vTokenAfter: decoded.args.vTokenAfter,
        soldAfter: decoded.args.soldAfter,
        at: decoded.args.at,
      };
    }
    case "CurveFull": {
      return {
        ...base,
        eventName: "CurveFull",
        token: lower(decoded.args.token),
        realUsd1: decoded.args.realUsd1,
        at: decoded.args.at,
      };
    }
    case "Graduated": {
      return {
        ...base,
        eventName: "Graduated",
        token: lower(decoded.args.token),
        pool: lower(decoded.args.pool),
        usd1ToPool: decoded.args.usd1ToPool,
        tokensToPool: decoded.args.tokensToPool,
        lpTokenId: decoded.args.lpTokenId,
        feeUsd1: decoded.args.feeUsd1,
        at: decoded.args.at,
      };
    }
    case "GraduationResidual": {
      return {
        ...base,
        eventName: "GraduationResidual",
        token: lower(decoded.args.token),
        usd1Left: decoded.args.usd1Left,
        tokensLeft: decoded.args.tokensLeft,
      };
    }
    case "ResidualInjected": {
      return {
        ...base,
        eventName: "ResidualInjected",
        token: lower(decoded.args.token),
        pool: lower(decoded.args.pool),
        usd1ToPool: decoded.args.usd1ToPool,
        tokensToPool: decoded.args.tokensToPool,
        lpTokenId: decoded.args.lpTokenId,
      };
    }
    case "Paused": {
      return {
        ...base,
        eventName: "Paused",
        token: lower(decoded.args.token),
        by: lower(decoded.args.by),
      };
    }
    case "Unpaused": {
      return {
        ...base,
        eventName: "Unpaused",
        token: lower(decoded.args.token),
        by: lower(decoded.args.by),
      };
    }
    default: {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface MemeContractTransportFactory {
  (url: string, options: { readonly timeoutMs: number }): Transport;
}

export interface MemeContractAdapterLogger {
  warn(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
}

export interface CreateMemeContractAdapterInput {
  readonly contract: MemeContractConfig | null;
  /** Why `contract` is null; ignored when it is set. */
  readonly unconfiguredReason?: MemeContractReasonCode;
  readonly chain: {
    readonly chainId: LaunchChainId;
    readonly chainReference: LaunchChainReference;
    readonly rpcUrls: readonly string[];
  };
  readonly verifyChain: () => Promise<ChainVerificationState>;
  readonly transportFactory?: MemeContractTransportFactory;
  readonly logger?: MemeContractAdapterLogger;
}

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

type CodeState =
  "unknown" | "present" | "missing" | "unreachable" | "mismatched";

export function createMemeContractAdapter(
  input: CreateMemeContractAdapterInput,
): MemeContractAdapter {
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
  let probeInFlight: Promise<MemeContractAvailability> | null = null;

  const available: MemeContractAvailability = Object.freeze({
    status: "available",
  });
  function unavailable(
    reasonCode: MemeContractReasonCode,
  ): MemeContractAvailability {
    return Object.freeze({ status: "unavailable", reasonCode });
  }

  function staticReason(): MemeContractReasonCode | null {
    if (contract === null) {
      return input.unconfiguredReason ?? memeContractReasonCodes.notConfigured;
    }
    if (contract.versionMajor !== memeContractAbiMajor) {
      return memeContractReasonCodes.versionUnsupported;
    }
    if (client === null) {
      return memeContractReasonCodes.chainRpcNotConfigured;
    }
    return null;
  }

  function currentAvailability(): MemeContractAvailability {
    const reason = staticReason();
    if (reason !== null) {
      return unavailable(reason);
    }
    if (chainState === "mismatched") {
      return unavailable(memeContractReasonCodes.chainIdMismatch);
    }
    switch (codeState) {
      case "present": {
        return chainState === "verified"
          ? available
          : unavailable(memeContractReasonCodes.chainRpcUnreachable);
      }
      case "missing": {
        return unavailable(memeContractReasonCodes.codeMissing);
      }
      case "mismatched": {
        return unavailable(memeContractReasonCodes.paramsMismatch);
      }
      case "unreachable": {
        return unavailable(memeContractReasonCodes.chainRpcUnreachable);
      }
      case "unknown": {
        return unavailable(memeContractReasonCodes.verificationPending);
      }
    }
  }

  /**
   * `params()` must equal the docs/10 §1 constants this backend recomputes
   * with, and name the configured USD1; `tokenImplementation()` must be the
   * configured implementation (the CREATE2 input of the salt pool).
   */
  async function paramsMatch(
    readClient: PublicClient<Transport, Chain>,
    configured: MemeContractConfig,
  ): Promise<boolean> {
    const address = configured.address as Address;
    const [params, implementation] = await Promise.all([
      readClient.readContract({
        address,
        abi: memeCurveAbiV1,
        functionName: "params",
      }),
      readClient.readContract({
        address,
        abi: memeCurveAbiV1,
        functionName: "tokenImplementation",
      }),
    ]);
    const [
      v0,
      t0,
      saleSupply,
      poolSupply,
      tradeFeeBps,
      graduationFeeUsd1,
      walletCapBps,
      minBuyUsd1,
      poolFee,
      usd1,
    ] = params;
    return (
      v0 === memeCurveParameters.v0 &&
      t0 === memeCurveParameters.t0 &&
      saleSupply === memeCurveParameters.saleSupply &&
      poolSupply === memeCurveParameters.poolSupply &&
      tradeFeeBps === memeCurveParameters.tradeFeeBps &&
      graduationFeeUsd1 === memeCurveParameters.graduationFeeUsd1 &&
      walletCapBps === memeCurveParameters.walletCapBps &&
      minBuyUsd1 === memeCurveParameters.minBuyUsd1 &&
      poolFee === memeCurveParameters.poolFee &&
      lower(usd1) === configured.usd1Address &&
      lower(implementation) === configured.tokenImplementation
    );
  }

  async function probe(): Promise<MemeContractAvailability> {
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
    if (
      codeState === "present" ||
      codeState === "missing" ||
      codeState === "mismatched"
    ) {
      return currentAvailability();
    }
    const readClient = client as PublicClient<Transport, Chain>;
    const configured = contract as MemeContractConfig;
    try {
      const code = await readClient.getCode({
        address: configured.address as Address,
      });
      if (code === undefined || code === "0x") {
        codeState = "missing";
      } else {
        codeState = (await paramsMatch(readClient, configured))
          ? "present"
          : "mismatched";
      }
    } catch {
      codeState = "unreachable";
    }
    return currentAvailability();
  }

  function availability(): Promise<MemeContractAvailability> {
    const reason = staticReason();
    if (reason !== null) {
      return Promise.resolve(unavailable(reason));
    }
    if (chainState === "verified" && codeState === "present") {
      return Promise.resolve(available);
    }
    if (
      codeState === "missing" ||
      codeState === "mismatched" ||
      chainState === "mismatched"
    ) {
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
      throw new MemeContractUnavailableError(state.reasonCode);
    }
    return {
      client: client as PublicClient<Transport, Chain>,
      address: (contract as MemeContractConfig).address as Address,
    };
  }

  function readFailed(error: unknown): never {
    if (error instanceof MemeContractUnavailableError) {
      throw error;
    }
    if (error instanceof RangeError) {
      throw new MemeContractUnavailableError(
        memeContractReasonCodes.readInvalid,
        { cause: error },
      );
    }
    if (
      error instanceof Error &&
      /AbiDecodingDataSizeTooSmall|AbiDecodingZeroData|InvalidAbiDecoding|PositionOutOfBounds/u.test(
        error.name,
      )
    ) {
      throw new MemeContractUnavailableError(
        memeContractReasonCodes.readInvalid,
        { cause: error },
      );
    }
    throw new MemeContractUnavailableError(memeContractReasonCodes.readFailed, {
      cause: error,
    });
  }

  async function takeSnapshot(): Promise<MemeContractSnapshot> {
    const { client: readClient } = await requireReadable();
    try {
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
    snapshot: MemeContractSnapshot,
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
      throw new MemeContractUnavailableError(
        memeContractReasonCodes.snapshotReorged,
      );
    }
  }

  async function pinned<T>(
    snapshot: MemeContractSnapshot | undefined,
    read: (
      readClient: PublicClient<Transport, Chain>,
      address: Address,
      blockNumber: bigint,
    ) => Promise<T>,
  ): Promise<MemeContractRead<T>> {
    const { client: readClient, address } = await requireReadable();
    const anchor = snapshot ?? (await takeSnapshot());
    let value: T;
    try {
      value = await read(readClient, address, anchor.blockNumber);
    } catch (error) {
      return readFailed(error);
    }
    if (snapshot === undefined) {
      await confirmSnapshot(anchor);
    }
    return Object.freeze({ value, snapshot: anchor });
  }

  function requireCallTarget(): string {
    const reason = staticReason();
    if (reason !== null) {
      throw new MemeContractUnavailableError(reason);
    }
    return (contract as MemeContractConfig).address;
  }

  function call(data: Hex): MemeContractCall {
    return Object.freeze({ to: requireCallTarget(), data, value: 0n });
  }

  const adapter: MemeContractAdapter = {
    contract,
    chainId: chain.chainId,
    chainReference: chain.chainReference,
    availability,
    currentAvailability,

    async verifyAtStartup() {
      const state = await availability();
      if (contract !== null) {
        if (state.status === "unavailable") {
          input.logger?.warn(
            {
              capabilityId: "meme",
              chainId: chain.chainId,
              contractVersion: contract.version,
              reasonCode: state.reasonCode,
            },
            "MEME curve contract is unavailable at startup",
          );
        } else {
          input.logger?.info(
            {
              capabilityId: "meme",
              chainId: chain.chainId,
              contractVersion: contract.version,
            },
            "MEME curve contract code and parameters observed on the launch chain",
          );
        }
      }
      return state;
    },

    takeSnapshot,
    confirmSnapshot,

    getCurve(token, snapshot) {
      return pinned(snapshot, async (readClient, address, blockNumber) => {
        const curve = await readClient.readContract({
          address,
          abi: memeCurveAbiV1,
          functionName: "getCurve",
          args: [requireAddress(token, "token")],
          blockNumber,
        });
        return Object.freeze({
          vUsd1: curve.vUsd1,
          vToken: curve.vToken,
          realUsd1: curve.realUsd1,
          sold: curve.sold,
          createdAt: curve.createdAt,
          creator: lower(curve.creator),
          status: statusAt(curve.status),
          pool: lower(curve.pool),
          graduatedAt: curve.graduatedAt,
        });
      });
    },

    quoteBuy(request, snapshot) {
      return pinned(snapshot, async (readClient, address, blockNumber) => {
        const [tokensOut, fee, refund] = await readClient.readContract({
          address,
          abi: memeCurveAbiV1,
          functionName: "quoteBuy",
          args: [
            requireAddress(request.token, "token"),
            requireUint(request.usd1In, maximumUint256, "usd1In"),
          ],
          blockNumber,
        });
        return Object.freeze({ tokensOut, fee, refund });
      });
    },

    quoteSell(request, snapshot) {
      return pinned(snapshot, async (readClient, address, blockNumber) => {
        const [usd1Out, fee] = await readClient.readContract({
          address,
          abi: memeCurveAbiV1,
          functionName: "quoteSell",
          args: [
            requireAddress(request.token, "token"),
            requireUint(request.tokensIn, maximumUint256, "tokensIn"),
          ],
          blockNumber,
        });
        return Object.freeze({ usd1Out, fee });
      });
    },

    async readPoolSqrtPriceX96(pool) {
      const { client: readClient } = await requireReadable();
      let sqrtPriceX96: bigint;
      try {
        const slot0 = await readClient.readContract({
          address: requireAddress(pool, "pool"),
          abi: pancakeV3PoolSlot0Abi,
          functionName: "slot0",
        });
        sqrtPriceX96 = slot0[0];
      } catch (error) {
        return readFailed(error);
      }
      if (sqrtPriceX96 <= 0n) {
        throw new MemeContractUnavailableError(
          memeContractReasonCodes.readInvalid,
        );
      }
      return sqrtPriceX96;
    },

    encodeCreateToken(request) {
      return call(encodeMemeCreateTokenCalldata(request));
    },
    encodeBuy(request) {
      return call(encodeMemeBuyCalldata(request));
    },
    encodeSell(request) {
      return call(encodeMemeSellCalldata(request));
    },
    encodeGraduate(token) {
      return call(encodeMemeGraduateCalldata(token));
    },

    async readLogs(range) {
      if (
        range.toBlock < range.fromBlock ||
        range.toBlock - range.fromBlock + 1n > memeContractMaximumLogRange
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
        throw new MemeContractUnavailableError(
          memeContractReasonCodes.readFailed,
          { cause: error },
        );
      }
      return Object.freeze(
        logs.map((log) =>
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
        ),
      );
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
          throw new MemeContractUnavailableError(
            memeContractReasonCodes.readInvalid,
          );
        }
      }
      return decodeMemeCurveLogs(logs);
    },
  };
  return Object.freeze(adapter);
}
