import { createHash, randomUUID } from "node:crypto";

import { encodeFunctionData, type Hex } from "viem";

import type { BscWriteConfig } from "../../config.js";
import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import {
  InvalidV2CursorError,
  type V2CursorCodec,
} from "../../core/http/v2-cursor.js";
import {
  V2ApiError,
  type V2ErrorDetailsSafe,
} from "../../core/http/v2-error.js";
import { isOpaqueId } from "../../core/ids/opaque-id.js";
import { canonicalJson } from "../../core/json/canonical-json.js";
import type {
  AccountWalletRecord,
  AccountWalletRepository,
} from "../../database/account-wallet-repository.js";
import type {
  BscChainCallClient,
  BscFeeData,
} from "../../integrations/bsc/rpc-client.js";
import {
  buildErc20Approve,
  toHexQuantity,
} from "../../integrations/bsc/tx-builder.js";
import {
  curveEngineAbi,
  projectNFTAbi,
} from "../../integrations/launch/hooks-launch-protocol-abi.generated.js";
import {
  assetIdForAddress,
  bscChainId,
  nativeAssetId,
  type LaunchChainId,
} from "../chain/chain-contract.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import {
  bscWriteCanaryPolicyVersion,
  walletIntentRefusalReasonCodes,
} from "../wallet-intents/intent-contract.js";
import {
  dailyCanaryAdmission,
  enforceCanaryCeiling,
  requireCanaryCounterparty,
} from "../wallet-intents/intent-preparation.js";
import {
  formatLaunch2Amount,
  isLaunch2Stage,
  launch2ReasonCodes,
  launch2Template,
  launch2TemplateProjection,
  parseLaunch2Amount,
  type Launch2IntentKind,
  type Launch2Stage,
} from "./launch2-contract.js";
import {
  launch2Max,
  launch2PriceAt,
  launch2QuoteBuy,
  launch2QuoteSell,
  type Launch2Max,
} from "./launch2-curve-math.js";
import {
  Launch2IdempotencyConflictError,
  Launch2RepositoryUnavailableError,
  type CreateLaunch2IntentRecord,
  type Launch2BuybackRecord,
  type Launch2Chain,
  type Launch2InstanceRecord,
  type Launch2IntentRecord,
  type Launch2PositionRecord,
  type Launch2Repository,
  type Launch2TradeRecord,
  type Launch2ViewerChainState,
} from "./launch2-ports.js";
import {
  deriveLaunch2Stage,
  launch2EarlyRoundEnd,
  launch2NftSaleEnd,
} from "./launch2-stage.js";

/**
 * Decision 0114: the `/v2/launch2/*` service. Lists and details come from
 * the `launch2_event` projection (the stage is re-derived from the clock on
 * every answer); quotes and prepares read the curve, the NFT, and the
 * wallet at one block of the launch slot and recompute the contract's
 * arithmetic; a prepare returns the unsigned transaction (plus an exact
 * `approve` when the allowance is short) for the device signing exit
 * (`device_eth_send_transaction`) — nothing is signed or sent here. Any
 * missing piece (module off, Factory / chain not configured, store or RPC
 * down) is 503 CAPABILITY_UNAVAILABLE with the reason; no fixture answers.
 */

export interface Launch2ServiceLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface Launch2ServiceDependencies {
  readonly repository: Launch2Repository | null;
  readonly chain: Launch2Chain | null;
  /** The launch slot's call client (allowances, nonce, fee, simulation). */
  readonly readClient: BscChainCallClient | null;
  readonly wallets: AccountWalletRepository | null;
  readonly writes: BscWriteConfig | null;
  readonly cursorCodec: V2CursorCodec | null;
  /** CAIP-2 id of the launch slot (`eip155:97`). */
  readonly chainId: LaunchChainId;
  /** Non-null keeps every route unavailable with this reason. */
  readonly unavailableReason: string | null;
  readonly quoteTtlSeconds: number;
  readonly defaultSlippageBps: number;
  readonly now?: () => Date;
  readonly createUuid?: () => string;
  readonly logger?: Launch2ServiceLogger;
}

type Resource = Record<string, unknown>;

export interface Launch2Service {
  listInstances(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly stage?: unknown;
    readonly cursor?: unknown;
    readonly limit?: unknown;
  }): Promise<Resource>;
  getInstance(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly instanceId: string;
    readonly walletId?: unknown;
  }): Promise<Resource>;
  quote(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly instanceId: string;
    readonly side?: unknown;
    readonly amount?: unknown;
    readonly walletId?: unknown;
    readonly slippageBps?: unknown;
  }): Promise<Resource>;
  listBuybacks(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly instanceId: string;
    readonly cursor?: unknown;
    readonly limit?: unknown;
  }): Promise<Resource>;
  listMyPositions(input: {
    readonly principal: AuthenticatedLoopPrincipal;
  }): Promise<Resource>;
  prepareNftMint(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly instanceId: string;
    readonly body: unknown;
    readonly idempotencyKey: string;
  }): Promise<Resource>;
  prepareTrade(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly instanceId: string;
    readonly body: unknown;
    readonly idempotencyKey: string;
  }): Promise<Resource>;
}

const maximumDeadlineSeconds = 600;
const approvalGas = 80_000n;
const fallbackGas: Readonly<Record<Launch2IntentKind, bigint>> = Object.freeze({
  nft_mint: 250_000n,
  buy: 400_000n,
  sell: 250_000n,
});
/** The last buy builds the pool atomically; its gas is far above a plain buy. */
const graduatingBuyGas = 3_000_000n;

function unavailableWith(reasonCode: string): never {
  throw V2ApiError.fromCode("CAPABILITY_UNAVAILABLE", { reasonCode });
}

function refuse(
  code:
    | "DATA_STALE"
    | "VALIDATION_FAILED"
    | "POLICY_BLOCKED"
    | "INSUFFICIENT_BALANCE"
    | "QUOTE_EXPIRED",
  reasonCode: string,
  extra: V2ErrorDetailsSafe = {},
): never {
  throw V2ApiError.fromCode(code, { reasonCode, ...extra });
}

function seconds(iso: string): bigint {
  return BigInt(Math.floor(Date.parse(iso) / 1000));
}

function isoOf(unixSeconds: bigint): string {
  return new Date(Number(unixSeconds) * 1000).toISOString();
}

function bps(part: bigint, whole: bigint): number {
  return whole === 0n ? 0 : Number((part * 10_000n) / whole);
}

function translate(error: unknown): never {
  if (error instanceof V2ApiError) throw error;
  if (error instanceof Launch2IdempotencyConflictError) {
    throw V2ApiError.idempotencyConflict();
  }
  if (error instanceof Launch2RepositoryUnavailableError) {
    return unavailableWith(launch2ReasonCodes.repositoryUnavailable);
  }
  return unavailableWith(launch2ReasonCodes.chainReadFailed);
}

/** Every chain read on a route path: a failure is 503, never a 500. */
async function chainRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof V2ApiError) throw error;
    return unavailableWith(launch2ReasonCodes.chainReadFailed);
  }
}

function stageOf(record: Launch2InstanceRecord, nowSeconds: bigint) {
  return deriveLaunch2Stage({
    nowSeconds,
    nftSaleStart: seconds(record.nftSaleStart),
    snapshotPublishedAt:
      record.snapshot === null ? null : seconds(record.snapshot.publishedAt),
    graduated: record.graduation !== null,
    holdReason: record.holdReason,
  });
}

function summaryOf(
  record: Launch2InstanceRecord,
  nowSeconds: bigint,
): Resource {
  const stage = stageOf(record, nowSeconds);
  const sold = BigInt(record.soldSupply);
  const reserve = BigInt(record.reserveUsd1);
  const saleStart = seconds(record.nftSaleStart);
  return Object.freeze({
    instanceId: record.instanceId,
    projectId: record.projectId,
    launchId: record.launchId,
    chainId: record.chainId,
    name: record.name,
    ticker: record.ticker,
    logoUrl: record.logoUrl,
    memeAddress: record.addresses.meme,
    stage: stage.stage,
    nextChangeAt:
      stage.nextChangeAt === null ? null : isoOf(stage.nextChangeAt),
    holdReason: record.holdReason,
    activatedAt: record.activatedAt,
    nftSale: Object.freeze({
      priceUsd1: formatLaunch2Amount(launch2Template.nftPrice),
      soldCount: record.nftMintedCount,
      startAt: record.nftSaleStart,
      endAt: isoOf(launch2NftSaleEnd(saleStart)),
    }),
    curve: Object.freeze({
      saleSupply: formatLaunch2Amount(launch2Template.curveSaleSupply),
      soldSupply: formatLaunch2Amount(sold),
      soldBps: bps(sold, launch2Template.curveSaleSupply),
      reserveUsd1: formatLaunch2Amount(reserve),
      graduationReserveUsd1: formatLaunch2Amount(
        launch2Template.graduationReserve,
      ),
      reserveBps: bps(reserve, launch2Template.graduationReserve),
      priceUsd1: formatLaunch2Amount(BigInt(record.priceE18)),
    }),
    graduatedAt: record.graduation?.graduatedAt ?? null,
  });
}

function buybackOf(record: Launch2BuybackRecord): Resource {
  return Object.freeze({
    buybackId: record.buybackId,
    outcome: record.outcome,
    reasonCode: record.reasonCode,
    usd1Spent: formatLaunch2Amount(BigInt(record.usd1Spent)),
    memeDelivered: formatLaunch2Amount(BigInt(record.memeDelivered)),
    minMemeOut: formatLaunch2Amount(BigInt(record.minMemeOut)),
    referencePriceUsd1: formatLaunch2Amount(BigInt(record.referencePriceE18)),
    spotPriceUsd1: formatLaunch2Amount(BigInt(record.spotPriceE18)),
    executedAt: record.executedAt,
    transactionHash: record.transactionHash,
    blockNumber: record.blockNumber,
  });
}

function tradeOf(record: Launch2TradeRecord): Resource {
  return Object.freeze({
    tradeId: record.tradeId,
    side: record.side,
    traderAddress: record.traderAddress,
    memeAmount: formatLaunch2Amount(BigInt(record.memeAmount)),
    usd1Gross: formatLaunch2Amount(BigInt(record.usd1Gross)),
    usd1Net: formatLaunch2Amount(BigInt(record.usd1Net)),
    taxUsd1: formatLaunch2Amount(BigInt(record.taxUsd1)),
    tradedAt: record.tradedAt,
    transactionHash: record.transactionHash,
    blockNumber: record.blockNumber,
  });
}

function buybackSummaryOf(
  record: Launch2InstanceRecord,
  latest: Launch2BuybackRecord | null,
): Resource {
  const recorded = BigInt(record.nftMintedCount) * launch2Template.nftPrice;
  const spent = BigInt(record.buyback.usd1);
  return Object.freeze({
    recipient: record.buybackRecipient,
    paused: record.buyback.paused,
    executedCount: record.buyback.count,
    totalUsd1: formatLaunch2Amount(spent),
    totalMeme: formatLaunch2Amount(BigInt(record.buyback.meme)),
    lastExecutedAt: record.buyback.lastAt,
    escrowRecordedUsd1: formatLaunch2Amount(recorded),
    escrowAvailableUsd1: formatLaunch2Amount(
      recorded > spent ? recorded - spent : 0n,
    ),
    latest: latest === null ? null : buybackOf(latest),
  });
}

function positionCurveOf(position: Launch2PositionRecord | null): Resource {
  const bought = BigInt(position?.curveBought ?? "0");
  const sold = BigInt(position?.curveSold ?? "0");
  const cumulative = BigInt(position?.cumulativeBought ?? "0");
  const cap = launch2Template.perAddressCap;
  return Object.freeze({
    bought: formatLaunch2Amount(bought),
    sold: formatLaunch2Amount(sold),
    net: formatLaunch2Amount(bought > sold ? bought - sold : 0n),
    cumulativeBought: formatLaunch2Amount(cumulative),
    remainingQuota: formatLaunch2Amount(
      cumulative >= cap ? 0n : cap - cumulative,
    ),
    usd1Spent: formatLaunch2Amount(BigInt(position?.usd1Spent ?? "0")),
    usd1Received: formatLaunch2Amount(BigInt(position?.usd1Received ?? "0")),
    taxUsd1: formatLaunch2Amount(BigInt(position?.taxUsd1 ?? "0")),
  });
}

function unsignedTransactionFor(input: {
  readonly chainReference: number;
  readonly from: string;
  readonly to: string;
  readonly data: string;
  readonly gasLimit: bigint;
  readonly nonce: number;
  readonly fee: BscFeeData;
}): Record<string, unknown> {
  return {
    chainId: input.chainReference,
    to: input.to,
    data: input.data,
    value: "0x0",
    from: input.from,
    gas: toHexQuantity(input.gasLimit),
    nonce: toHexQuantity(BigInt(input.nonce)),
    type: input.fee.type,
    maxFeePerGas:
      input.fee.type === "eip1559"
        ? toHexQuantity(input.fee.maxFeePerGas)
        : null,
    maxPriorityFeePerGas:
      input.fee.type === "eip1559"
        ? toHexQuantity(input.fee.maxPriorityFeePerGas)
        : null,
    gasPrice:
      input.fee.type === "legacy" ? toHexQuantity(input.fee.gasPrice) : null,
  };
}

export function projectLaunch2Intent(
  record: Launch2IntentRecord,
  now: Date,
): Resource {
  const elapsed = Date.parse(record.expiresAt) <= now.getTime();
  const simulation = record.policy["simulation"] as
    { readonly status: string; readonly reasonCode: string | null } | undefined;
  const reverted = simulation?.status === "reverted";
  const allowed = !elapsed && !reverted;
  return Object.freeze({
    launch2Intent: Object.freeze({
      intentId: record.intentId,
      kind: record.kind,
      state: elapsed ? "expired" : "prepared",
      instanceId: record.instanceId,
      walletId: record.walletId,
      chainId: record.chainId,
      chainReference: record.unsignedTransaction["chainId"],
      contractAddress: record.contractAddress,
      amountIn: formatLaunch2Amount(BigInt(record.amountIn)),
      expectedOut: formatLaunch2Amount(BigInt(record.expectedOut)),
      minOut: formatLaunch2Amount(BigInt(record.minOut)),
      taxUsd1: formatLaunch2Amount(BigInt(record.taxUsd1)),
      refundUsd1: formatLaunch2Amount(BigInt(record.refundUsd1)),
      deadline: record.deadline,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
      calldata: record.calldata,
      unsignedTransaction: record.unsignedTransaction,
      approval: record.approval,
      payloadDigest: record.payloadDigest,
      snapshotBlockNumber: record.snapshotBlockNumber,
      snapshotBlockHash: record.snapshotBlockHash,
      simulation: Object.freeze({
        status: simulation?.status ?? "unavailable",
        reasonCode: simulation?.reasonCode ?? null,
      }),
      policy: Object.freeze({
        configVersion: record.policy["configVersion"],
        canaryMaxUsd: record.policy["canaryMaxUsd"],
        valueUsd: record.policy["valueUsd"],
        priceSource: record.policy["priceSource"],
      }),
      signing: Object.freeze({
        mode: "device_eth_send_transaction",
        allowed,
        reasonCode: allowed
          ? null
          : elapsed
            ? launch2ReasonCodes.intentExpired
            : launch2ReasonCodes.simulationReverted,
      }),
    }),
    contractVersion: v2ContractVersion,
  });
}

interface TradeBody {
  readonly walletId: string;
  readonly side: "buy" | "sell";
  readonly amount: bigint;
  readonly minOut: bigint;
  readonly deadline: bigint;
}

function parseWalletBody(body: unknown): { readonly walletId: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw V2ApiError.invalidRequest();
  }
  const value = body as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => key !== "walletId") ||
    typeof value["walletId"] !== "string" ||
    !isOpaqueId(value["walletId"])
  ) {
    throw V2ApiError.invalidRequest();
  }
  return { walletId: value["walletId"] };
}

function parseTradeBody(body: unknown): TradeBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw V2ApiError.invalidRequest();
  }
  const value = body as Record<string, unknown>;
  const allowed = new Set(["walletId", "side", "amount", "minOut", "deadline"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw V2ApiError.invalidRequest();
  }
  const walletId = value["walletId"];
  const side = value["side"];
  if (
    typeof walletId !== "string" ||
    !isOpaqueId(walletId) ||
    (side !== "buy" && side !== "sell")
  ) {
    throw V2ApiError.invalidRequest();
  }
  const amount = parseLaunch2Amount(value["amount"]);
  const minOut = parseLaunch2Amount(value["minOut"]);
  const deadlineText = value["deadline"];
  if (amount === null || amount === 0n || minOut === null) {
    refuse("VALIDATION_FAILED", launch2ReasonCodes.amountInvalid);
  }
  if (
    typeof deadlineText !== "string" ||
    Number.isNaN(Date.parse(deadlineText))
  ) {
    throw V2ApiError.invalidRequest();
  }
  return {
    walletId,
    side,
    amount,
    minOut,
    deadline: seconds(deadlineText),
  };
}

export function createUnavailableLaunch2Service(
  reasonCode: string = launch2ReasonCodes.runtimeUnavailable,
): Launch2Service {
  const fail = (): Promise<never> =>
    Promise.reject(
      V2ApiError.fromCode("CAPABILITY_UNAVAILABLE", { reasonCode }),
    );
  return Object.freeze({
    listInstances: fail,
    getInstance: fail,
    quote: fail,
    listBuybacks: fail,
    listMyPositions: fail,
    prepareNftMint: fail,
    prepareTrade: fail,
  });
}

export function createLaunch2Service(
  deps: Launch2ServiceDependencies,
): Launch2Service {
  const now = deps.now ?? ((): Date => new Date());
  const createUuid = deps.createUuid ?? randomUUID;

  function nowSeconds(): bigint {
    return BigInt(Math.floor(now().getTime() / 1000));
  }

  function repository(): Launch2Repository {
    if (deps.unavailableReason !== null) {
      return unavailableWith(deps.unavailableReason);
    }
    if (deps.repository === null) {
      return unavailableWith(launch2ReasonCodes.repositoryUnavailable);
    }
    return deps.repository;
  }

  function chain(): Launch2Chain {
    if (deps.chain === null) {
      return unavailableWith(launch2ReasonCodes.chainNotConfigured);
    }
    return deps.chain;
  }

  function cursorCodec(): V2CursorCodec {
    if (deps.cursorCodec === null) {
      return unavailableWith(launch2ReasonCodes.runtimeUnavailable);
    }
    return deps.cursorCodec;
  }

  function decodeCursor(
    principal: AuthenticatedLoopPrincipal,
    route: string,
    filter: string,
    cursor: unknown,
  ): Readonly<Record<string, string | number | boolean>> {
    if (typeof cursor !== "string") throw V2ApiError.invalidRequest();
    try {
      return cursorCodec().decode({
        ownerId: principal.userId,
        route,
        filter,
        cursor,
      });
    } catch (error) {
      if (error instanceof InvalidV2CursorError) {
        throw V2ApiError.invalidRequest();
      }
      throw error;
    }
  }

  function parseLimit(
    value: unknown,
    fallback: number,
    maximum: number,
  ): number {
    if (value === undefined) return fallback;
    const parsed =
      typeof value === "number"
        ? value
        : typeof value === "string" && /^[1-9][0-9]{0,3}$/u.test(value)
          ? Number(value)
          : Number.NaN;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
      throw V2ApiError.invalidRequest();
    }
    return parsed;
  }

  async function visibleInstance(
    instanceId: string,
  ): Promise<Launch2InstanceRecord> {
    if (!isOpaqueId(instanceId)) throw V2ApiError.notFound();
    const record = await repository().getInstance(instanceId).catch(translate);
    if (
      record === null ||
      record.chainId !== deps.chainId ||
      (record.activatedAt === null && record.holdReason === null)
    ) {
      throw V2ApiError.fromCode("NOT_FOUND", {
        reasonCode: launch2ReasonCodes.instanceNotFound,
      });
    }
    return record;
  }

  async function walletFor(
    principal: AuthenticatedLoopPrincipal,
    walletId: unknown,
    required: boolean,
  ): Promise<AccountWalletRecord | null> {
    if (deps.wallets === null) {
      if (required) unavailableWith(launch2ReasonCodes.walletsUnavailable);
      return null;
    }
    const wallets = deps.wallets;
    if (walletId === undefined) {
      if (required) throw V2ApiError.invalidRequest();
      const all = await wallets
        .list(principal.userId)
        .catch(() => unavailableWith(launch2ReasonCodes.walletsUnavailable));
      return (
        all.find((wallet) => wallet.isActive && wallet.status === "active") ??
        null
      );
    }
    if (typeof walletId !== "string" || !isOpaqueId(walletId)) {
      throw V2ApiError.invalidRequest();
    }
    const wallet = await wallets
      .get(principal.userId, walletId)
      .catch(() => unavailableWith(launch2ReasonCodes.walletsUnavailable));
    if (wallet === null || wallet.status !== "active") {
      throw V2ApiError.notFound();
    }
    return wallet;
  }

  async function viewerState(
    record: Launch2InstanceRecord,
    wallet: string | null,
  ): Promise<Launch2ViewerChainState> {
    const reader = chain();
    return chainRead(() =>
      reader.readViewerState({
        meme: record.addresses.meme,
        curve: record.addresses.curve,
        gate: record.addresses.gate,
        nft: record.addresses.nft,
        snapshots: record.addresses.snapshots,
        wallet,
      }),
    );
  }

  /** Chain-truth trading gate: the stage the contract itself enforces. */
  function chainStageOf(
    record: Launch2InstanceRecord,
    state: Launch2ViewerChainState,
  ): Launch2Stage {
    if (record.holdReason !== null) return "paused";
    if (state.curve.graduated) return "graduated";
    const at = state.curve.blockTimestamp;
    const saleStart = seconds(record.nftSaleStart);
    if (at < saleStart) return "upcoming";
    if (at < launch2NftSaleEnd(saleStart)) return "nft_sale";
    if (state.curve.earlyRoundEndsAt === 0n) return "snapshot_pending";
    return at < state.curve.earlyRoundEndsAt ? "priority" : "public";
  }

  function requireTradable(
    record: Launch2InstanceRecord,
    state: Launch2ViewerChainState,
    side: "buy" | "sell",
  ): Launch2Stage {
    if (record.holdReason !== null) {
      refuse("DATA_STALE", launch2ReasonCodes.instancePaused, {
        holdReason: record.holdReason,
      });
    }
    if (!state.curve.published) {
      refuse("DATA_STALE", launch2ReasonCodes.stageMismatch, {
        stage: "upcoming",
      });
    }
    const stage = chainStageOf(record, state);
    const open =
      side === "buy"
        ? stage === "priority" || stage === "public"
        : stage === "public";
    if (stage === "graduated") {
      refuse("DATA_STALE", launch2ReasonCodes.soldOut, { stage });
    }
    if (!open) {
      refuse(
        "DATA_STALE",
        side === "sell" && stage === "priority"
          ? launch2ReasonCodes.sellNotOpen
          : launch2ReasonCodes.stageMismatch,
        { stage },
      );
    }
    return stage;
  }

  interface QuoteNumbers {
    readonly max: Launch2Max;
    readonly amountIn: bigint;
    readonly expectedOut: bigint;
    readonly tax: bigint;
    readonly refund: bigint;
    readonly accepted: bigint;
    readonly nextSold: bigint;
  }

  function quoteNumbers(
    side: "buy" | "sell",
    state: Launch2ViewerChainState,
    amount: bigint,
  ): QuoteNumbers {
    const balance = side === "buy" ? state.usd1Balance : state.memeBalance;
    const max = launch2Max({
      side,
      state: state.curve,
      cumulativeBought: state.cumulativeBought,
      balance,
    });
    const capped = amount > max.amountIn ? max.amountIn : amount;
    if (side === "buy") {
      const quote = launch2QuoteBuy(
        state.curve,
        state.cumulativeBought,
        capped,
      );
      return {
        max,
        amountIn: capped,
        expectedOut: quote.memeOut,
        tax: quote.platformTax,
        refund: quote.usd1Refund,
        accepted: quote.usd1Accepted,
        nextSold: quote.nextSoldSupply,
      };
    }
    const quote = launch2QuoteSell(state.curve.soldSupply, capped);
    return {
      max,
      amountIn: capped,
      expectedOut: quote.usd1Out,
      tax: quote.platformTax,
      refund: 0n,
      accepted: capped,
      nextSold: quote.nextSoldSupply,
    };
  }

  async function eligibility(
    record: Launch2InstanceRecord,
    stage: Launch2Stage,
    address: string,
  ): Promise<{
    readonly required: boolean;
    readonly eligible: boolean | null;
    readonly proof: readonly string[] | null;
    readonly reasonCode: string | null;
  }> {
    if (stage !== "priority") {
      return { required: false, eligible: null, proof: [], reasonCode: null };
    }
    if (record.snapshot?.verification !== "verified") {
      return {
        required: true,
        eligible: null,
        proof: null,
        reasonCode: launch2ReasonCodes.snapshotUnverified,
      };
    }
    const member = await repository()
      .getSnapshotMember({ instanceId: record.instanceId, address })
      .catch(translate);
    const proof = member?.proof ?? null;
    return {
      required: true,
      eligible: proof !== null,
      proof,
      reasonCode: proof === null ? launch2ReasonCodes.notInSnapshot : null,
    };
  }

  function requestDigest(parts: readonly string[]): string {
    const hash = createHash("sha256");
    hash.update(`loop:v2:launch2:launch2_intent_v1:${v2ContractVersion}`);
    for (const part of parts) {
      hash.update("\0", "utf8");
      hash.update(part, "utf8");
    }
    return hash.digest("hex");
  }

  function writesOrUnavailable(): BscWriteConfig {
    if (deps.writes === null) {
      return unavailableWith(launch2ReasonCodes.writesDisabled);
    }
    if (deps.chainId === bscChainId) {
      return unavailableWith(launch2ReasonCodes.mainnetClosed);
    }
    return deps.writes;
  }

  function callClient(): BscChainCallClient {
    if (deps.readClient === null) {
      return unavailableWith(launch2ReasonCodes.chainNotConfigured);
    }
    return deps.readClient;
  }

  async function signingWallet(
    principal: AuthenticatedLoopPrincipal,
    walletId: string,
  ): Promise<AccountWalletRecord> {
    const wallet = await walletFor(principal, walletId, true);
    if (wallet === null) throw V2ApiError.notFound();
    if (wallet.kind !== "embedded" || wallet.providerWalletId === null) {
      refuse("VALIDATION_FAILED", launch2ReasonCodes.walletNotEmbedded);
    }
    return wallet;
  }

  /** Allowance, gas, nonce, fee, simulation, canary — then the sealed record. */
  async function sealIntent(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly record: Launch2InstanceRecord;
    readonly wallet: AccountWalletRecord;
    readonly writes: BscWriteConfig;
    readonly kind: Launch2IntentKind;
    readonly state: Launch2ViewerChainState;
    readonly contract: string;
    readonly data: string;
    readonly approval: {
      readonly token: string;
      readonly amount: bigint;
    } | null;
    readonly amountIn: bigint;
    readonly expectedOut: bigint;
    readonly minOut: bigint;
    readonly tax: bigint;
    readonly refund: bigint;
    readonly valueUsd: bigint;
    readonly deadline: bigint;
    readonly gasHint: bigint;
  }): Promise<CreateLaunch2IntentRecord> {
    const client = callClient();
    const { wallet, writes } = input;
    const usd1AssetId = assetIdForAddress(deps.chainId, input.state.usd1);
    if (!writes.canaryAssetIds.includes(usd1AssetId)) {
      refuse(
        "POLICY_BLOCKED",
        walletIntentRefusalReasonCodes.assetNotInCanaryAllowlist,
      );
    }
    requireCanaryCounterparty(writes, input.contract);
    const valueUsd = formatLaunch2Amount(input.valueUsd);
    enforceCanaryCeiling(writes, valueUsd);
    let approvalTarget = input.approval;
    if (approvalTarget !== null) {
      const target = approvalTarget;
      const allowances = await chainRead(() =>
        client.readAllowances(wallet.address, [
          {
            assetId: assetIdForAddress(deps.chainId, target.token),
            token: target.token,
            spender: input.contract,
          },
        ]),
      );
      const allowance = allowances.allowances[0]?.rawValue;
      if (allowance === undefined || allowance === null) {
        return unavailableWith(launch2ReasonCodes.chainReadFailed);
      }
      if (allowance >= target.amount) approvalTarget = null;
    }
    const callRequest = {
      from: wallet.address,
      to: input.contract,
      data: input.data as Hex,
      value: 0n,
    };
    let simulation: { status: string; reasonCode: string | null };
    let gasLimit = input.gasHint;
    if (approvalTarget !== null) {
      simulation = {
        status: "unavailable",
        reasonCode: launch2ReasonCodes.approvalRequired,
      };
    } else {
      const simulated = await chainRead(() => client.call(callRequest));
      if (simulated.status === "reverted") {
        simulation = {
          status: "reverted",
          reasonCode: launch2ReasonCodes.simulationReverted,
        };
      } else {
        const estimate = await client
          .estimateGas(callRequest)
          .catch(() => null);
        if (estimate === null) {
          simulation = {
            status: "unavailable",
            reasonCode: launch2ReasonCodes.simulationUnavailable,
          };
        } else {
          simulation = { status: "passed", reasonCode: null };
          gasLimit = (estimate * 12n) / 10n;
        }
      }
    }
    const nativeId = nativeAssetId(deps.chainId);
    const [fee, nonce, natives] = await chainRead(() =>
      Promise.all([
        client.getFeeData(),
        client.getTransactionCount(wallet.address),
        client.readBalances(wallet.address, [
          { assetId: nativeId, address: null },
        ]),
      ]),
    );
    const native = natives.balances[0]?.rawValue;
    if (native === undefined || native === null) {
      return unavailableWith(launch2ReasonCodes.chainReadFailed);
    }
    const perGas = fee.type === "eip1559" ? fee.maxFeePerGas : fee.gasPrice;
    const totalGas = gasLimit + (approvalTarget === null ? 0n : approvalGas);
    if (totalGas * perGas > native) {
      refuse("INSUFFICIENT_BALANCE", launch2ReasonCodes.gasInsufficient);
    }
    const chainReference = client.chainReference;
    let approval: Record<string, unknown> | null = null;
    if (approvalTarget !== null) {
      const approveCall = buildErc20Approve({
        token: approvalTarget.token,
        spender: input.contract,
        value: approvalTarget.amount,
      });
      approval = {
        token: approvalTarget.token,
        spender: input.contract,
        amount: formatLaunch2Amount(approvalTarget.amount),
        calldata: { to: approveCall.to, data: approveCall.data, value: "0" },
        unsignedTransaction: unsignedTransactionFor({
          chainReference,
          from: wallet.address,
          to: approveCall.to,
          data: approveCall.data,
          gasLimit: approvalGas,
          nonce,
          fee,
        }),
      };
    }
    const unsignedTransaction = unsignedTransactionFor({
      chainReference,
      from: wallet.address,
      to: input.contract,
      data: input.data,
      gasLimit,
      nonce: approvalTarget === null ? nonce : nonce + 1,
      fee,
    });
    const intentId = createUuid();
    const deadline = isoOf(input.deadline);
    const expiresAt = new Date(
      Math.min(
        now().getTime() + maximumDeadlineSeconds * 1000,
        Number(input.deadline) * 1000,
      ),
    ).toISOString();
    const calldata = { to: input.contract, data: input.data, value: "0" };
    const policy = {
      configVersion: bscWriteCanaryPolicyVersion,
      canaryMaxUsd: writes.canaryMaxUsd,
      valueUsd,
      priceSource: "usd1_par",
      simulation,
    };
    const binding = {
      version: "launch2IntentV1",
      intentId,
      accountId: input.principal.userId,
      walletId: wallet.walletId,
      instanceId: input.record.instanceId,
      kind: input.kind,
      chainId: deps.chainId,
      contractAddress: input.contract,
      amountIn: input.amountIn.toString(10),
      expectedOut: input.expectedOut.toString(10),
      minOut: input.minOut.toString(10),
      deadline,
      snapshotBlockNumber: input.state.blockNumber.toString(10),
      snapshotBlockHash: input.state.blockHash,
      calldata,
      unsignedTransaction,
      approval,
      policy,
    };
    return Object.freeze({
      intentId,
      ownerUserId: input.principal.userId,
      instanceId: input.record.instanceId,
      walletId: wallet.walletId,
      walletAddress: wallet.address.toLowerCase(),
      kind: input.kind,
      chainId: deps.chainId,
      contractAddress: input.contract,
      amountIn: input.amountIn.toString(10),
      expectedOut: input.expectedOut.toString(10),
      minOut: input.minOut.toString(10),
      taxUsd1: input.tax.toString(10),
      refundUsd1: input.refund.toString(10),
      deadline,
      snapshotBlockNumber: input.state.blockNumber.toString(10),
      snapshotBlockHash: input.state.blockHash,
      calldata,
      unsignedTransaction,
      approval,
      policy,
      payloadDigest: createHash("sha256")
        .update(canonicalJson(binding), "utf8")
        .digest("hex"),
      expiresAt,
    });
  }

  async function createIntent(
    principal: AuthenticatedLoopPrincipal,
    idempotencyKey: string,
    requestSha256: string,
    writes: BscWriteConfig,
    build: () => Promise<CreateLaunch2IntentRecord>,
  ): Promise<Resource> {
    try {
      const outcome = await repository().createIntent({
        ownerUserId: principal.userId,
        idempotencyKey,
        requestSha256,
        build,
        canaryAdmission: (built) => {
          const valueUsd = String(built.policy["valueUsd"]);
          return valueUsd === "0"
            ? null
            : dailyCanaryAdmission(writes, valueUsd, now());
        },
      });
      return projectLaunch2Intent(outcome.intent, now());
    } catch (error) {
      return translate(error);
    }
  }

  return Object.freeze<Launch2Service>({
    async listInstances(input) {
      const store = repository();
      const stage =
        input.stage === undefined
          ? null
          : isLaunch2Stage(input.stage)
            ? input.stage
            : (() => {
                throw V2ApiError.invalidRequest();
              })();
      if (input.cursor !== undefined && input.limit !== undefined) {
        throw V2ApiError.invalidRequest();
      }
      const filter = stage ?? "all";
      let limit: number;
      let after: { activatedAt: string; instanceId: string } | null = null;
      if (input.cursor !== undefined) {
        const continuation = decodeCursor(
          input.principal,
          "launch2Instances",
          filter,
          input.cursor,
        );
        if (
          typeof continuation["at"] !== "string" ||
          typeof continuation["id"] !== "string" ||
          typeof continuation["limit"] !== "number"
        ) {
          throw V2ApiError.invalidRequest();
        }
        after = {
          activatedAt: continuation["at"],
          instanceId: continuation["id"],
        };
        limit = continuation["limit"];
      } else {
        limit = parseLimit(input.limit, 30, 50);
      }
      const rows = await store
        .listInstances({
          chainId: deps.chainId,
          stage,
          after,
          limit: limit + 1,
        })
        .catch(translate);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      const at = nowSeconds();
      return Object.freeze({
        instances: page.map((row) => summaryOf(row, at)),
        nextCursor:
          rows.length > limit && last !== undefined
            ? cursorCodec().encode({
                ownerId: input.principal.userId,
                route: "launch2Instances",
                filter,
                continuation: {
                  at: last.activatedAt ?? last.registeredAt,
                  id: last.instanceId,
                  limit,
                },
              })
            : null,
        contractVersion: v2ContractVersion,
      });
    },

    async getInstance(input) {
      const record = await visibleInstance(input.instanceId);
      const store = repository();
      const at = nowSeconds();
      const wallet = await walletFor(input.principal, input.walletId, false);
      const [latest, trades, positions, member] = await Promise.all([
        store
          .listBuybacks({
            instanceId: record.instanceId,
            after: null,
            limit: 1,
          })
          .catch(translate),
        store
          .listTrades({ instanceId: record.instanceId, limit: 20 })
          .catch(translate),
        wallet === null
          ? Promise.resolve([] as readonly Launch2PositionRecord[])
          : store
              .listPositions({
                holderAddresses: [wallet.address],
                instanceId: record.instanceId,
              })
              .catch(translate),
        wallet === null
          ? Promise.resolve(null)
          : store
              .getSnapshotMember({
                instanceId: record.instanceId,
                address: wallet.address,
              })
              .catch(translate),
      ]);
      const stage = stageOf(record, at);
      const position = positions[0] ?? null;
      const snapshot = record.snapshot;
      const graduation = record.graduation;
      return Object.freeze({
        instance: Object.freeze({
          ...summaryOf(record, at),
          viewerIsProjectOwner: record.ownerUserId === input.principal.userId,
          projectOwnerAddress: record.projectOwner,
          configVersion: record.configVersion,
          configHash: record.configHash,
          buybackRecipient: record.buybackRecipient,
          template: launch2TemplateProjection(),
          contracts: Object.freeze({
            factory: record.factoryAddress,
            ...record.addresses,
          }),
          snapshot: Object.freeze({
            status: snapshot === null ? "pending" : "published",
            verification:
              snapshot === null ? null : (snapshot.verification ?? "pending"),
            root: snapshot?.root ?? null,
            dataHash: snapshot?.dataHash ?? null,
            cutoffBlockNumber: snapshot?.cutoffBlock ?? null,
            cutoffBlockHash: snapshot?.cutoffBlockHash ?? null,
            publishedAt: snapshot?.publishedAt ?? null,
            earlyRoundEndsAt:
              snapshot === null
                ? null
                : isoOf(launch2EarlyRoundEnd(seconds(snapshot.publishedAt))),
            memberCount: snapshot?.memberCount ?? null,
            signers: snapshot?.signers ?? null,
          }),
          graduation:
            graduation === null
              ? null
              : Object.freeze({
                  graduatedAt: graduation.graduatedAt,
                  officialPoolId: graduation.poolId,
                  hookAddress: record.addresses.hook,
                  lpFee: launch2Template.lpFee,
                  tickSpacing: launch2Template.tickSpacing,
                  officialPoolTaxBps: launch2Template.officialPoolTaxBps,
                  transactionHash: graduation.transactionHash,
                }),
          buyback: buybackSummaryOf(record, latest[0] ?? null),
          recentTrades: trades.map(tradeOf),
          viewer:
            wallet === null
              ? null
              : Object.freeze({
                  walletId: wallet.walletId,
                  nft: Object.freeze({
                    mintedTokenId: position?.nftMintedTokenId ?? null,
                    held: position?.nftHeld ?? 0,
                  }),
                  snapshot: Object.freeze({
                    member: member?.proof !== null && member !== null,
                    eligibleNow:
                      stage.stage === "priority"
                        ? member?.proof !== null && member !== null
                        : stage.stage === "public",
                  }),
                  curve: positionCurveOf(position),
                }),
          projectedAt: record.projectedAt,
        }),
        contractVersion: v2ContractVersion,
      });
    },

    async quote(input) {
      const record = await visibleInstance(input.instanceId);
      if (input.side !== "buy" && input.side !== "sell") {
        throw V2ApiError.invalidRequest();
      }
      const side = input.side;
      const amount = parseLaunch2Amount(input.amount);
      if (amount === null || amount === 0n) {
        refuse("VALIDATION_FAILED", launch2ReasonCodes.amountInvalid);
      }
      let slippageBps = deps.defaultSlippageBps;
      if (input.slippageBps !== undefined) {
        const parsed =
          typeof input.slippageBps === "string" &&
          /^(0|[1-9][0-9]{0,3})$/u.test(input.slippageBps)
            ? Number(input.slippageBps)
            : Number.NaN;
        if (!Number.isInteger(parsed) || parsed > 5_000) {
          throw V2ApiError.invalidRequest();
        }
        slippageBps = parsed;
      }
      const wallet = await walletFor(input.principal, input.walletId, true);
      if (wallet === null) throw V2ApiError.notFound();
      const state = await viewerState(record, wallet.address.toLowerCase());
      const stage = requireTradable(record, state, side);
      const numbers = quoteNumbers(side, state, amount);
      if (numbers.max.amountIn === 0n || numbers.expectedOut === 0n) {
        refuse(
          "DATA_STALE",
          numbers.max.limitedBy === "quota"
            ? launch2ReasonCodes.quotaExhausted
            : numbers.max.limitedBy === "inventory"
              ? launch2ReasonCodes.soldOut
              : launch2ReasonCodes.quoteZero,
          { limitedBy: numbers.max.limitedBy },
        );
      }
      const eligible = await eligibility(
        record,
        stage,
        wallet.address.toLowerCase(),
      );
      const minOut =
        (numbers.expectedOut * BigInt(10_000 - slippageBps)) / 10_000n;
      const chainNow =
        state.curve.blockTimestamp > nowSeconds()
          ? state.curve.blockTimestamp
          : nowSeconds();
      const deadline = chainNow + BigInt(deps.quoteTtlSeconds);
      const cap = launch2Template.perAddressCap;
      const used = state.cumulativeBought;
      return Object.freeze({
        quote: Object.freeze({
          instanceId: record.instanceId,
          walletId: wallet.walletId,
          side,
          stage,
          requestedAmount: formatLaunch2Amount(amount),
          exceedsMax: amount > numbers.max.amountIn,
          amountIn: formatLaunch2Amount(numbers.amountIn),
          maxIn: formatLaunch2Amount(numbers.amountIn),
          expectedOut: formatLaunch2Amount(numbers.expectedOut),
          minOut: formatLaunch2Amount(minOut),
          slippageBps,
          taxUsd1: formatLaunch2Amount(numbers.tax),
          taxBps: Number(launch2Template.curveBuyTaxBps),
          refundUsd1: formatLaunch2Amount(numbers.refund),
          priceBeforeUsd1: formatLaunch2Amount(
            launch2PriceAt(state.curve.soldSupply),
          ),
          priceAfterUsd1: formatLaunch2Amount(launch2PriceAt(numbers.nextSold)),
          max: Object.freeze({
            amountIn: formatLaunch2Amount(numbers.max.amountIn),
            amountOut: formatLaunch2Amount(numbers.max.amountOut),
            limitedBy: numbers.max.limitedBy,
          }),
          quota: Object.freeze({
            capMeme: formatLaunch2Amount(cap),
            usedMeme: formatLaunch2Amount(used),
            remainingMeme: formatLaunch2Amount(used >= cap ? 0n : cap - used),
          }),
          inventory: Object.freeze({
            saleSupply: formatLaunch2Amount(launch2Template.curveSaleSupply),
            soldSupply: formatLaunch2Amount(state.curve.soldSupply),
            remainingMeme: formatLaunch2Amount(
              launch2Template.curveSaleSupply - state.curve.soldSupply,
            ),
          }),
          eligibility: Object.freeze({
            required: eligible.required,
            eligible: eligible.eligible,
            reasonCode: eligible.reasonCode,
          }),
          deadline: isoOf(deadline),
          quotedAt: now().toISOString(),
          basis: Object.freeze({
            blockNumber: state.blockNumber.toString(10),
            blockHash: state.blockHash,
          }),
        }),
        contractVersion: v2ContractVersion,
      });
    },

    async listBuybacks(input) {
      const record = await visibleInstance(input.instanceId);
      const store = repository();
      if (input.cursor !== undefined && input.limit !== undefined) {
        throw V2ApiError.invalidRequest();
      }
      let limit: number;
      let after: { executedAt: string; buybackId: string } | null = null;
      if (input.cursor !== undefined) {
        const continuation = decodeCursor(
          input.principal,
          "launch2Buybacks",
          record.instanceId,
          input.cursor,
        );
        if (
          typeof continuation["at"] !== "string" ||
          typeof continuation["id"] !== "string" ||
          typeof continuation["limit"] !== "number"
        ) {
          throw V2ApiError.invalidRequest();
        }
        after = {
          executedAt: continuation["at"],
          buybackId: continuation["id"],
        };
        limit = continuation["limit"];
      } else {
        limit = parseLimit(input.limit, 30, 100);
      }
      const rows = await store
        .listBuybacks({
          instanceId: record.instanceId,
          after,
          limit: limit + 1,
        })
        .catch(translate);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      let live: Resource | null = null;
      let liveUnavailable: Resource | null = null;
      if (deps.chain === null) {
        liveUnavailable = { reasonCode: launch2ReasonCodes.chainNotConfigured };
      } else {
        try {
          const state = await deps.chain.readBuybackState({
            buybackExecutor: record.addresses.buybackExecutor,
            escrow: record.addresses.escrow,
          });
          const blocked =
            state.nextOrderAmountIn === null
              ? "BUYBACK_PRICE_SOURCE_UNAVAILABLE"
              : state.paused
                ? "BUYBACK_PAUSED"
                : record.graduation === null
                  ? "BUYBACK_NOT_GRADUATED"
                  : state.nextOrderAmountIn === 0n
                    ? "BUYBACK_NO_BUDGET"
                    : state.nextOrderMinMemeOut === 0n
                      ? "BUYBACK_PROTECTION_BLOCKED"
                      : null;
          live = Object.freeze({
            paused: state.paused,
            lastSuccessfulAt:
              state.lastSuccessfulAt === 0n
                ? null
                : isoOf(state.lastSuccessfulAt),
            escrowRecordedUsd1: formatLaunch2Amount(state.totalRecorded),
            escrowSpentUsd1: formatLaunch2Amount(state.totalSpent),
            escrowAvailableUsd1: formatLaunch2Amount(state.availableBudget),
            nextOrderUsd1:
              state.nextOrderAmountIn === null
                ? null
                : formatLaunch2Amount(state.nextOrderAmountIn),
            nextOrderBlockedReason: blocked,
          });
        } catch {
          liveUnavailable = { reasonCode: launch2ReasonCodes.chainReadFailed };
        }
      }
      return Object.freeze({
        instanceId: record.instanceId,
        summary: buybackSummaryOf(record, rows[0] ?? null),
        live,
        liveUnavailable,
        buybacks: page.map(buybackOf),
        nextCursor:
          rows.length > limit && last !== undefined
            ? cursorCodec().encode({
                ownerId: input.principal.userId,
                route: "launch2Buybacks",
                filter: record.instanceId,
                continuation: {
                  at: last.executedAt,
                  id: last.buybackId,
                  limit,
                },
              })
            : null,
        contractVersion: v2ContractVersion,
      });
    },

    async listMyPositions(input) {
      const store = repository();
      if (deps.wallets === null) {
        return unavailableWith(launch2ReasonCodes.walletsUnavailable);
      }
      const wallets = await deps.wallets
        .list(input.principal.userId)
        .catch(() => unavailableWith(launch2ReasonCodes.walletsUnavailable));
      const byAddress = new Map(
        wallets.map((wallet) => [wallet.address.toLowerCase(), wallet]),
      );
      const positions = await store
        .listPositions({
          holderAddresses: [...byAddress.keys()],
          instanceId: null,
        })
        .catch(translate);
      const instances = new Map<string, Launch2InstanceRecord>();
      for (const position of positions) {
        if (!instances.has(position.instanceId)) {
          const record = await store
            .getInstance(position.instanceId)
            .catch(translate);
          if (record !== null) instances.set(position.instanceId, record);
        }
      }
      const at = nowSeconds();
      return Object.freeze({
        positions: positions.flatMap((position) => {
          const record = instances.get(position.instanceId);
          const wallet = byAddress.get(position.holderAddress);
          if (record === undefined || wallet === undefined) return [];
          return [
            Object.freeze({
              instanceId: record.instanceId,
              name: record.name,
              ticker: record.ticker,
              logoUrl: record.logoUrl,
              memeAddress: record.addresses.meme,
              stage: stageOf(record, at).stage,
              walletId: wallet.walletId,
              nft: Object.freeze({
                mintedTokenId: position.nftMintedTokenId,
                held: position.nftHeld,
              }),
              snapshotMember: position.snapshotMember,
              curve: positionCurveOf(position),
              lastActivityAt: position.lastActivityAt,
            }),
          ];
        }),
        contractVersion: v2ContractVersion,
      });
    },

    async prepareNftMint(input) {
      const writes = writesOrUnavailable();
      const body = parseWalletBody(input.body);
      const record = await visibleInstance(input.instanceId);
      const wallet = await signingWallet(input.principal, body.walletId);
      const requestSha256 = requestDigest([
        record.instanceId,
        wallet.walletId,
        "nft_mint",
      ]);
      return createIntent(
        input.principal,
        input.idempotencyKey,
        requestSha256,
        writes,
        async () => {
          const address = wallet.address.toLowerCase();
          const state = await viewerState(record, address);
          if (record.holdReason !== null) {
            refuse("DATA_STALE", launch2ReasonCodes.instancePaused, {
              holdReason: record.holdReason,
            });
          }
          const stage = chainStageOf(record, state);
          if (!state.curve.published || stage !== "nft_sale") {
            refuse("DATA_STALE", launch2ReasonCodes.stageMismatch, {
              stage: state.curve.published ? stage : "upcoming",
            });
          }
          if (state.nftMinted) {
            refuse("DATA_STALE", launch2ReasonCodes.nftAlreadyMinted);
          }
          const price = launch2Template.nftPrice;
          if ((state.usd1Balance ?? 0n) < price) {
            refuse(
              "INSUFFICIENT_BALANCE",
              launch2ReasonCodes.usd1Insufficient,
              {
                requiredUsd1: formatLaunch2Amount(price),
              },
            );
          }
          const data = encodeFunctionData({
            abi: projectNFTAbi,
            functionName: "mint",
            args: [],
          });
          return sealIntent({
            principal: input.principal,
            record,
            wallet,
            writes,
            kind: "nft_mint",
            state,
            contract: record.addresses.nft,
            data,
            approval: { token: state.usd1, amount: price },
            amountIn: price,
            expectedOut: 1n,
            minOut: 1n,
            tax: 0n,
            refund: 0n,
            valueUsd: price,
            deadline: launch2NftSaleEnd(seconds(record.nftSaleStart)),
            gasHint: fallbackGas.nft_mint,
          });
        },
      );
    },

    async prepareTrade(input) {
      const writes = writesOrUnavailable();
      const body = parseTradeBody(input.body);
      const record = await visibleInstance(input.instanceId);
      const at = nowSeconds();
      if (body.deadline <= at) {
        refuse("QUOTE_EXPIRED", launch2ReasonCodes.quoteExpired);
      }
      if (body.deadline > at + BigInt(maximumDeadlineSeconds)) {
        refuse("VALIDATION_FAILED", launch2ReasonCodes.deadlineTooFar, {
          maximumSeconds: maximumDeadlineSeconds,
        });
      }
      const wallet = await signingWallet(input.principal, body.walletId);
      const requestSha256 = requestDigest([
        record.instanceId,
        wallet.walletId,
        body.side,
        body.amount.toString(10),
        body.minOut.toString(10),
        body.deadline.toString(10),
      ]);
      return createIntent(
        input.principal,
        input.idempotencyKey,
        requestSha256,
        writes,
        async () => {
          const address = wallet.address.toLowerCase();
          const state = await viewerState(record, address);
          const stage = requireTradable(record, state, body.side);
          const numbers = quoteNumbers(body.side, state, body.amount);
          if (numbers.max.amountIn === 0n) {
            refuse(
              "DATA_STALE",
              numbers.max.limitedBy === "quota"
                ? launch2ReasonCodes.quotaExhausted
                : launch2ReasonCodes.soldOut,
              { limitedBy: numbers.max.limitedBy },
            );
          }
          if (body.amount > numbers.max.amountIn) {
            if (numbers.max.limitedBy === "balance") {
              refuse(
                "INSUFFICIENT_BALANCE",
                body.side === "buy"
                  ? launch2ReasonCodes.usd1Insufficient
                  : launch2ReasonCodes.memeInsufficient,
                { maxAmountIn: formatLaunch2Amount(numbers.max.amountIn) },
              );
            }
            refuse("VALIDATION_FAILED", launch2ReasonCodes.amountAboveMax, {
              maxAmountIn: formatLaunch2Amount(numbers.max.amountIn),
              maxAmountOut: formatLaunch2Amount(numbers.max.amountOut),
              limitedBy: numbers.max.limitedBy,
            });
          }
          if (numbers.expectedOut === 0n) {
            refuse("VALIDATION_FAILED", launch2ReasonCodes.quoteZero);
          }
          if (numbers.expectedOut < body.minOut) {
            // Another order filled first: the App re-quotes in place.
            refuse("DATA_STALE", launch2ReasonCodes.priceMoved, {
              expectedOut: formatLaunch2Amount(numbers.expectedOut),
              minOut: formatLaunch2Amount(body.minOut),
            });
          }
          let proof: readonly string[] = [];
          if (body.side === "buy") {
            const eligible = await eligibility(record, stage, address);
            if (eligible.required) {
              if (
                eligible.reasonCode === launch2ReasonCodes.snapshotUnverified
              ) {
                return unavailableWith(launch2ReasonCodes.snapshotUnverified);
              }
              if (eligible.proof === null) {
                refuse("POLICY_BLOCKED", launch2ReasonCodes.notInSnapshot);
              }
              proof = eligible.proof;
            }
          }
          const data =
            body.side === "buy"
              ? encodeFunctionData({
                  abi: curveEngineAbi,
                  functionName: "buy",
                  args: [
                    body.amount,
                    body.minOut,
                    body.deadline,
                    proof as readonly Hex[],
                  ],
                })
              : encodeFunctionData({
                  abi: curveEngineAbi,
                  functionName: "sell",
                  args: [body.amount, body.minOut, body.deadline],
                });
          const graduating =
            body.side === "buy" &&
            numbers.nextSold === launch2Template.curveSaleSupply;
          return sealIntent({
            principal: input.principal,
            record,
            wallet,
            writes,
            kind: body.side,
            state,
            contract: record.addresses.curve,
            data,
            approval:
              body.side === "buy"
                ? { token: state.usd1, amount: body.amount }
                : { token: record.addresses.meme, amount: body.amount },
            amountIn: body.amount,
            expectedOut: numbers.expectedOut,
            minOut: body.minOut,
            tax: numbers.tax,
            refund: numbers.refund,
            valueUsd: body.side === "buy" ? body.amount : numbers.expectedOut,
            deadline: body.deadline,
            gasHint: graduating ? graduatingBuyGas : fallbackGas[body.side],
          });
        },
      );
    },
  });
}
