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
  officialPoolRouterAbi,
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
import { requireLaunch2Counterparties } from "./launch2-counterparty.js";
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
  type Launch2BuybackChainState,
  type Launch2BuybackRecord,
  type Launch2Chain,
  type Launch2DynamicChain,
  type Launch2DynamicHookState,
  type Launch2DynamicSwapCall,
  type Launch2InstanceRecord,
  type Launch2IntentRecord,
  type Launch2PoolChain,
  type Launch2PoolChainState,
  type Launch2PoolTradeRecord,
  type Launch2PoolTradeStats,
  type Launch2PositionRecord,
  type Launch2Repository,
  type Launch2TradeRecord,
  type Launch2ViewerChainState,
} from "./launch2-ports.js";
import {
  launch2PoolAveragePriceE18,
  launch2PoolId,
  launch2PoolKey,
  launch2PoolMaxAmount,
  launch2PoolMaxIn,
  launch2PoolMinOut,
  launch2PoolPriceE18,
  launch2PoolReasonCodes,
  launch2PoolTaxBps,
  launch2PoolTaxOfNet,
  launch2PoolUnboundedMaxIn,
  launch2PoolZeroForOne,
  type Launch2PoolKey,
  type Launch2PoolMode,
  type Launch2PoolSide,
} from "./launch2-pool.js";
import { deriveLaunch2Stage, launch2EarlyRoundEnd } from "./launch2-stage.js";
import {
  classifyLaunch2DynamicRevert,
  encodeLaunch2DynamicClaim,
  encodeLaunch2DynamicSwap,
  launch2DynamicBps,
  launch2DynamicCandleSeconds,
  launch2DynamicClaimable,
  launch2DynamicGrossOfNet,
  launch2DynamicPriceTiming,
  launch2DynamicReasonCodes,
  launch2DynamicRoll,
  launch2DynamicRoutingPolicy,
  launch2DynamicSellSplit,
  launch2HookKindOf,
  type Launch2PoolHookKind,
} from "./launch2-dynamic.js";

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
  /**
   * Decision 0124: the official-pool router reader; null keeps the pool
   * quote / prepare 503 POOL_ROUTER_NOT_CONFIGURED.
   */
  readonly poolChain?: Launch2PoolChain | null;
  /**
   * Decision 0131: the LoopDynamic reader (LoopRouter verified by code
   * hash); null keeps LoopDynamic quotes / prepares / reads 503
   * LAUNCH2_DYNAMIC_ROUTER_NOT_CONFIGURED. OfficialTax is unaffected.
   */
  readonly dynamicChain?: Launch2DynamicChain | null;
  /**
   * Decision 0131: LAUNCH2_DYNAMIC_ROUTER_REGISTRY_ADDRESS — when set, a
   * LoopDynamic Hook must point at this trusted-router list.
   */
  readonly dynamicRouterRegistry?: string | null;
  /**
   * Decision 0126: `LAUNCH2_POOL_TRADE_DEADLINE_SECONDS` (default 180): the
   * on-chain deadline a pool or curve prepare encodes, counted from the
   * prepare (two device signatures must fit).
   */
  readonly tradeDeadlineSeconds?: number;
  /** Decision 0126: wallet balance cache lifetime (≤ 15 s, default 15 s). */
  readonly balanceCacheMs?: number;
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
  /** Decision 0124: official-pool quote (graduated instances). */
  poolQuote(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly instanceId: string;
    readonly side?: unknown;
    readonly mode?: unknown;
    readonly amount?: unknown;
    readonly walletId?: unknown;
    readonly slippageBps?: unknown;
  }): Promise<Resource>;
  /** Decision 0124: official-pool router call (graduated instances). */
  preparePoolTrade(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly instanceId: string;
    readonly body: unknown;
    readonly idempotencyKey: string;
  }): Promise<Resource>;
  /** Decision 0126: one wallet's attributed official-pool trades. */
  listPoolTrades(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly instanceId: string;
    readonly walletId?: unknown;
    readonly limit?: unknown;
  }): Promise<Resource>;
  /** Decision 0131: the LoopDynamic pool / round state (hookKind for all). */
  getDynamicPool(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly instanceId: string;
    readonly walletId?: unknown;
  }): Promise<Resource>;
  /** Decision 0131: one wallet's LoopDynamic rewards per round. */
  listDynamicRewards(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly instanceId: string;
    readonly walletId?: unknown;
    readonly limit?: unknown;
  }): Promise<Resource>;
  /** Decision 0131: `claim(roundId)` intent for the device signing exit. */
  prepareDynamicClaim(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly instanceId: string;
    readonly body: unknown;
    readonly idempotencyKey: string;
  }): Promise<Resource>;
  /** Decision 0131: the device reports the claim transaction hash. */
  reportDynamicClaim(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly instanceId: string;
    readonly body: unknown;
    readonly idempotencyKey: string;
  }): Promise<Resource>;
}

const maximumDeadlineSeconds = 600;
/** Decision 0126: default `LAUNCH2_POOL_TRADE_DEADLINE_SECONDS`. */
export const launch2DefaultTradeDeadlineSeconds = 180;
const maximumBalanceCacheMs = 15_000;
const approvalGas = 80_000n;
const fallbackGas: Readonly<Record<Launch2IntentKind, bigint>> = Object.freeze({
  nft_mint: 250_000n,
  buy: 400_000n,
  sell: 250_000n,
  pool_buy: 300_000n,
  pool_sell: 300_000n,
  dynamic_claim: 200_000n,
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
    nftSaleEnd: seconds(record.nftSaleEnd),
    snapshotPublishedAt:
      record.snapshot === null ? null : seconds(record.snapshot.publishedAt),
    graduated: record.graduation !== null,
    holdReason: record.holdReason,
    closedNoHolders: record.noHoldersClosure !== null,
    openedWithoutHoldersAt:
      record.openedWithoutHolders === null
        ? null
        : seconds(record.openedWithoutHolders.openedAt),
  });
}

/**
 * Decision 0122: why the next buyback order cannot run now (null = it
 * can). v3: `quoteNextOrder().executable` is false for exactly one of the
 * `execute()` pre-swap checks; the first that holds is named, the locked
 * principal guard (≥ 10,000 USD1 LP principal, order ≤ 1 %) being the
 * only one left. v2 (price-protected, legacy): a reverted quote or a zero
 * protected output is `BUYBACK_LEGACY_PRICE_PROTECTION`.
 */
export function launch2NextOrderBlockedReason(input: {
  readonly generation: Launch2InstanceRecord["generation"];
  readonly graduated: boolean;
  readonly state: Launch2BuybackChainState;
}): string | null {
  const { state } = input;
  const legacy = input.generation === "v2";
  if (state.nextOrderAmountIn === null) {
    return legacy
      ? "BUYBACK_LEGACY_PRICE_PROTECTION"
      : "BUYBACK_QUOTE_UNAVAILABLE";
  }
  if (state.paused) return "BUYBACK_PAUSED";
  if (!input.graduated) return "BUYBACK_NOT_GRADUATED";
  if (state.nextOrderAmountIn === 0n) return "BUYBACK_NO_BUDGET";
  if (state.nextOrderExecutable === true) return null;
  if (legacy) return "BUYBACK_LEGACY_PRICE_PROTECTION";
  if (
    state.lastSuccessfulAt !== 0n &&
    state.blockTimestamp <
      state.lastSuccessfulAt + BigInt(launch2Template.buybackMinIntervalSeconds)
  ) {
    return "BUYBACK_TOO_SOON";
  }
  return "BUYBACK_PRINCIPAL_INSUFFICIENT";
}

function summaryOf(
  record: Launch2InstanceRecord,
  nowSeconds: bigint,
): Resource {
  const stage = stageOf(record, nowSeconds);
  const sold = BigInt(record.soldSupply);
  const reserve = BigInt(record.reserveUsd1);
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
      endAt: record.nftSaleEnd,
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
    // Decision 0122: null for a v3 execution (no price protection).
    minMemeOut:
      record.minMemeOut === null
        ? null
        : formatLaunch2Amount(BigInt(record.minMemeOut)),
    referencePriceUsd1:
      record.referencePriceE18 === null
        ? null
        : formatLaunch2Amount(BigInt(record.referencePriceE18)),
    spotPriceUsd1:
      record.spotPriceE18 === null
        ? null
        : formatLaunch2Amount(BigInt(record.spotPriceE18)),
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

/**
 * Decision 0121: the keeper's newest attempt. `nextEligibleAt` = the
 * backoff / retry time after a refusal or failure, or the last ledger
 * success + `MIN_SUCCESS_INTERVAL` once the newest attempt is in the
 * ledger; null while an attempt is in flight or unknown.
 */
function keeperSummaryOf(record: Launch2InstanceRecord): Resource | null {
  const keeper = record.buybackKeeper;
  if (keeper === null) return null;
  let nextEligibleAt: string | null = null;
  if (keeper.status === "rejected" || keeper.status === "failed") {
    nextEligibleAt = keeper.nextEligibleAt;
  } else if (
    keeper.status === "confirmed" &&
    keeper.aligned &&
    record.buyback.lastAt !== null
  ) {
    nextEligibleAt = new Date(
      Date.parse(record.buyback.lastAt) +
        launch2Template.buybackMinIntervalSeconds * 1000,
    ).toISOString();
  }
  return Object.freeze({
    lastAttemptAt: keeper.lastAttemptAt,
    lastResult: keeper.status,
    reasonCode: keeper.reasonCode,
    nextEligibleAt,
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
    keeper: keeperSummaryOf(record),
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

interface PoolRequest {
  readonly side: Launch2PoolSide;
  readonly mode: Launch2PoolMode;
  readonly amount: bigint;
  readonly slippageBps: number;
}

interface PoolNumbers {
  readonly amountIn: bigint;
  readonly maxIn: bigint;
  readonly expectedOut: bigint;
  readonly minOut: bigint;
  readonly tax: bigint;
  readonly deadline: bigint;
}

function parsePoolRequest(input: {
  readonly side: unknown;
  readonly mode: unknown;
  readonly amount: unknown;
  readonly slippageBps: unknown;
}): PoolRequest {
  const { side, mode, slippageBps } = input;
  if (
    (side !== "buy" && side !== "sell") ||
    (mode !== "exactIn" && mode !== "exactOut") ||
    typeof slippageBps !== "number" ||
    !Number.isInteger(slippageBps) ||
    slippageBps < 0 ||
    slippageBps > 5_000
  ) {
    throw V2ApiError.invalidRequest();
  }
  const amount = parseLaunch2Amount(input.amount);
  if (amount === null || amount === 0n || amount > launch2PoolMaxAmount) {
    refuse("VALIDATION_FAILED", launch2ReasonCodes.amountInvalid);
  }
  return { side, mode, amount, slippageBps };
}

function parsePoolTradeBody(
  body: unknown,
): PoolRequest & { readonly walletId: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw V2ApiError.invalidRequest();
  }
  const value = body as Record<string, unknown>;
  const allowed = new Set([
    "walletId",
    "side",
    "mode",
    "amount",
    "slippageBps",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw V2ApiError.invalidRequest();
  }
  const walletId = value["walletId"];
  if (typeof walletId !== "string" || !isOpaqueId(walletId)) {
    throw V2ApiError.invalidRequest();
  }
  return {
    walletId,
    ...parsePoolRequest({
      side: value["side"],
      mode: value["mode"],
      amount: value["amount"],
      slippageBps: value["slippageBps"],
    }),
  };
}

/** Decision 0124: `swapExactIn` / `swapExactOut` calldata of the router. */
function encodePoolSwap(input: {
  readonly mode: Launch2PoolMode;
  readonly key: Launch2PoolKey;
  readonly zeroForOne: boolean;
  readonly amountIn: bigint;
  readonly expectedOut: bigint;
  readonly minOut: bigint;
  readonly maxIn: bigint;
  readonly recipient: string;
  readonly deadline: bigint;
}): string {
  const key = {
    currency0: input.key.currency0 as Hex,
    currency1: input.key.currency1 as Hex,
    fee: input.key.fee,
    tickSpacing: input.key.tickSpacing,
    hooks: input.key.hooks as Hex,
  };
  return input.mode === "exactIn"
    ? encodeFunctionData({
        abi: officialPoolRouterAbi,
        functionName: "swapExactIn",
        args: [
          key,
          input.zeroForOne,
          input.amountIn,
          input.minOut,
          input.recipient as Hex,
          input.deadline,
        ],
      })
    : encodeFunctionData({
        abi: officialPoolRouterAbi,
        functionName: "swapExactOut",
        args: [
          key,
          input.zeroForOne,
          input.expectedOut,
          input.maxIn,
          input.recipient as Hex,
          input.deadline,
        ],
      });
}

interface WalletBalances {
  readonly blockNumber: bigint;
  readonly memeBalance: bigint;
  readonly usd1Balance: bigint;
}

const notGraduatedBalances: Resource = Object.freeze({
  memeBalance: null,
  usd1Balance: null,
  balanceStatus: "not_graduated",
  balanceReasonCode: null,
  balanceBlockNumber: null,
});

function unavailableBalances(reasonCode: string): Resource {
  return Object.freeze({
    memeBalance: null,
    usd1Balance: null,
    balanceStatus: "unavailable",
    balanceReasonCode: reasonCode,
    balanceBlockNumber: null,
  });
}

function poolTradeStatsOf(stats: Launch2PoolTradeStats | undefined): Resource {
  return Object.freeze({
    poolTradeCount: stats?.count ?? "0",
    lastPoolTradeAt: stats?.lastAt ?? null,
  });
}

function poolTradeOf(record: Launch2PoolTradeRecord): Resource {
  const buy = record.side === "buy";
  return Object.freeze({
    poolTradeId: record.poolTradeId,
    side: record.side,
    inputToken: buy ? "usd1" : "meme",
    outputToken: buy ? "meme" : "usd1",
    amountIn: formatLaunch2Amount(BigInt(record.amountIn)),
    amountOut: formatLaunch2Amount(BigInt(record.amountOut)),
    usd1Amount: formatLaunch2Amount(BigInt(record.usd1Amount)),
    memeAmount: formatLaunch2Amount(BigInt(record.memeAmount)),
    taxAmount: formatLaunch2Amount(BigInt(record.taxAmount)),
    taxToken: record.taxToken,
    priceUsd1: formatLaunch2Amount(BigInt(record.priceE18)),
    recipientAddress: record.recipientAddress,
    tradedAt: record.tradedAt,
    transactionHash: record.transactionHash,
    logIndex: record.logIndex,
    blockNumber: record.blockNumber,
  });
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
    poolQuote: fail,
    preparePoolTrade: fail,
    listPoolTrades: fail,
    getDynamicPool: fail,
    listDynamicRewards: fail,
    prepareDynamicClaim: fail,
    reportDynamicClaim: fail,
  });
}

export function createLaunch2Service(
  deps: Launch2ServiceDependencies,
): Launch2Service {
  const now = deps.now ?? ((): Date => new Date());
  const createUuid = deps.createUuid ?? randomUUID;
  const tradeDeadlineSeconds = BigInt(
    Math.min(
      Math.max(
        deps.tradeDeadlineSeconds ?? launch2DefaultTradeDeadlineSeconds,
        1,
      ),
      maximumDeadlineSeconds,
    ),
  );
  const balanceCacheMs = Math.min(
    Math.max(deps.balanceCacheMs ?? maximumBalanceCacheMs, 0),
    maximumBalanceCacheMs,
  );
  /** Decision 0126: (meme|wallet) → balances read at one block. */
  const balanceCache = new Map<
    string,
    { readonly at: number; readonly value: WalletBalances }
  >();

  /**
   * Decision 0126: the wallet's MEME / USD1 balances of a graduated
   * instance (≤ 15 s cache). Never throws: a failed read is
   * `unavailable` with the reason, never a guessed 0.
   */
  async function walletBalancesOf(
    record: Launch2InstanceRecord,
    address: string,
  ): Promise<Resource> {
    if (record.graduation === null) {
      return notGraduatedBalances;
    }
    if (deps.chain === null) {
      return unavailableBalances(launch2ReasonCodes.chainNotConfigured);
    }
    const reader = deps.chain;
    const wallet = address.toLowerCase();
    const key = `${record.addresses.meme}|${wallet}`;
    const nowMs = now().getTime();
    const cached = balanceCache.get(key);
    let value: WalletBalances;
    if (cached !== undefined && nowMs - cached.at < balanceCacheMs) {
      value = cached.value;
    } else {
      try {
        value = await reader.readWalletBalances({
          curve: record.addresses.curve,
          meme: record.addresses.meme,
          wallet,
        });
      } catch {
        return unavailableBalances(launch2ReasonCodes.chainReadFailed);
      }
      if (balanceCache.size > 1_000) balanceCache.clear();
      balanceCache.set(key, { at: nowMs, value });
    }
    return Object.freeze({
      memeBalance: formatLaunch2Amount(value.memeBalance),
      usd1Balance: formatLaunch2Amount(value.usd1Balance),
      balanceStatus: "available",
      balanceReasonCode: null,
      balanceBlockNumber: value.blockNumber.toString(10),
    });
  }

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
    if (at < seconds(record.nftSaleEnd)) return "nft_sale";
    if (state.curve.earlyRoundEndsAt === 0n) {
      // Decision 0120: no holder at the cutoff — nothing can be published.
      return record.noHoldersClosure === null
        ? "snapshot_pending"
        : "closed_no_holders";
    }
    return at < state.curve.earlyRoundEndsAt ? "priority" : "public";
  }

  /**
   * S143 / Decision 0121 §quote: the stage that gates a quote or a trade
   * prepare is the read model's — the same `stage` the instance detail
   * shows (lane-confirmed facts + the clock). The chain stage at the quote
   * block must agree; when the chain has already moved (a snapshot or a
   * graduation not yet `confirmations` deep for the lane) the answer is
   * 409 `LAUNCH2_STAGE_MISMATCH` with the read-model `stage`, never a quote
   * for a round the App does not show yet. MAX and amounts still come from
   * that chain block.
   */
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
    const stage = stageOf(record, nowSeconds()).stage;
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
    const chainStage = state.curve.published
      ? chainStageOf(record, state)
      : "upcoming";
    if (chainStage !== stage) {
      refuse("DATA_STALE", launch2ReasonCodes.stageMismatch, { stage });
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
    /** The read block and the instance's USD1 (curve-bound). */
    readonly state: {
      readonly usd1: string;
      readonly blockNumber: bigint;
      readonly blockHash: string;
    };
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
    /** Decision 0124: the verified pool router, trusted as a target. */
    readonly verifiedRouter?: string;
    /**
     * Decision 0124: a simulation that also runs while the approve is
     * pending (the allowance overridden in the call); replaces the plain
     * eth_call + estimate.
     */
    readonly simulate?: (approvalPending: boolean) => Promise<{
      readonly status: "passed" | "reverted" | "unavailable";
      readonly reasonCode: string | null;
      readonly gas: bigint | null;
    }>;
    /** Extra policy keys stored with the intent (bound by the digest). */
    readonly policyExtra?: Readonly<Record<string, unknown>>;
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
    // Decision 0117: counterparties come from the activated instance's
    // registry row (and its curve-bound USD1), not the static env allowlist.
    requireLaunch2Counterparties({
      record: input.record,
      usd1: input.state.usd1,
      targets: [
        input.contract,
        ...(input.approval === null ? [] : [input.approval.token]),
      ],
      ...(input.verifiedRouter === undefined
        ? {}
        : { verifiedRouter: input.verifiedRouter }),
    });
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
    if (input.simulate !== undefined) {
      const simulated = await chainRead(() =>
        (input.simulate as NonNullable<typeof input.simulate>)(
          approvalTarget !== null,
        ),
      );
      simulation = {
        status: simulated.status,
        reasonCode: simulated.reasonCode,
      };
      if (simulated.gas !== null) gasLimit = (simulated.gas * 12n) / 10n;
    } else if (approvalTarget !== null) {
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
    const requiredNative = totalGas * perGas;
    if (requiredNative > native) {
      // S157: the numbers behind the refusal (gas ceiling = gas limit(s)
      // x maxFeePerGas / gasPrice, and the wallet's BNB at the same read).
      refuse("INSUFFICIENT_BALANCE", launch2ReasonCodes.gasInsufficient, {
        requiredBnb: formatLaunch2Amount(requiredNative),
        balanceBnb: formatLaunch2Amount(native),
      });
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
      ...input.policyExtra,
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

  async function createIntentRecord(
    principal: AuthenticatedLoopPrincipal,
    idempotencyKey: string,
    requestSha256: string,
    writes: BscWriteConfig,
    build: () => Promise<CreateLaunch2IntentRecord>,
  ): Promise<{
    readonly record: Launch2IntentRecord;
    readonly resource: Resource;
  }> {
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
      return {
        record: outcome.intent,
        resource: projectLaunch2Intent(outcome.intent, now()),
      };
    } catch (error) {
      return translate(error);
    }
  }

  async function createIntent(
    principal: AuthenticatedLoopPrincipal,
    idempotencyKey: string,
    requestSha256: string,
    writes: BscWriteConfig,
    build: () => Promise<CreateLaunch2IntentRecord>,
  ): Promise<Resource> {
    return (
      await createIntentRecord(
        principal,
        idempotencyKey,
        requestSha256,
        writes,
        build,
      )
    ).resource;
  }

  function poolChain(): Launch2PoolChain {
    if (deps.poolChain === undefined || deps.poolChain === null) {
      return unavailableWith(launch2PoolReasonCodes.routerNotConfigured);
    }
    return deps.poolChain;
  }

  /**
   * Decision 0124: one official-pool quote at one block — the read-model
   * stage must be `graduated`, the router verified by code hash, the
   * PoolKey rebuilt from the hook and checked against `officialPoolId`,
   * then the router call simulated from the wallet with the input token's
   * balance and allowance overridden in the call only.
   */
  async function poolQuoteAt(
    record: Launch2InstanceRecord,
    wallet: AccountWalletRecord,
    request: PoolRequest,
    /**
     * Decision 0126: seconds from the quote block's time to the deadline —
     * the quote TTL for GET …/pool/quote, the trade deadline for a prepare.
     */
    deadlineSeconds: bigint,
  ): Promise<{
    readonly resource: Resource;
    readonly state: Launch2PoolChainState;
    readonly key: Launch2PoolKey;
    readonly zeroForOne: boolean;
    readonly router: string;
    readonly numbers: PoolNumbers;
  }> {
    if (record.holdReason !== null) {
      refuse("DATA_STALE", launch2ReasonCodes.instancePaused, {
        holdReason: record.holdReason,
      });
    }
    const stage = stageOf(record, nowSeconds()).stage;
    const graduation = record.graduation;
    if (stage !== "graduated" || graduation === null) {
      refuse("VALIDATION_FAILED", launch2PoolReasonCodes.notGraduated, {
        stage,
      });
    }
    const pool = poolChain();
    const check = await chainRead(() => pool.verifyRouter());
    if (check.status !== "ok") return unavailableWith(check.reasonCode);
    const address = wallet.address.toLowerCase();
    const state = await chainRead(() =>
      pool.readPoolState({
        hook: record.addresses.hook,
        curve: record.addresses.curve,
        meme: record.addresses.meme,
        poolId: graduation.poolId,
        wallet: address,
      }),
    );
    if (state.hookPoolManager !== check.poolManager) {
      return unavailableWith(launch2PoolReasonCodes.routerManagerMismatch);
    }
    const key = launch2PoolKey({
      meme: record.addresses.meme,
      usd1: state.curveUsd1,
      hook: record.addresses.hook,
    });
    if (
      key.currency0 !== state.currency0 ||
      key.currency1 !== state.currency1 ||
      launch2PoolId(key) !== graduation.poolId.toLowerCase()
    ) {
      return unavailableWith(launch2PoolReasonCodes.keyMismatch);
    }
    const meme = record.addresses.meme.toLowerCase();
    const zeroForOne = launch2PoolZeroForOne(key, request.side, meme);
    const memeIsCurrency0 = key.currency0 === meme;
    const chainNow =
      state.blockTimestamp > nowSeconds() ? state.blockTimestamp : nowSeconds();
    const deadline = chainNow + deadlineSeconds;
    const inputToken = request.side === "buy" ? state.curveUsd1 : meme;
    const pullAmount =
      request.mode === "exactIn" ? request.amount : launch2PoolUnboundedMaxIn;
    const data = encodePoolSwap({
      mode: request.mode,
      key,
      zeroForOne,
      amountIn: request.amount,
      expectedOut: request.amount,
      minOut: 0n,
      maxIn: launch2PoolUnboundedMaxIn,
      recipient: address,
      deadline,
    });
    const simulated = await chainRead(() =>
      pool.simulate({
        blockNumber: state.blockNumber,
        from: address,
        data,
        override: {
          token: inputToken,
          balance: pullAmount,
          allowance: pullAmount,
        },
      }),
    );
    if (simulated.status === "override_unsupported") {
      refuse("VALIDATION_FAILED", launch2PoolReasonCodes.quoteUnavailable, {
        revertReason: "STATE_OVERRIDE_UNSUPPORTED",
      });
    }
    if (simulated.status === "reverted") {
      const name = simulated.errorName;
      if (name === "InsufficientOutput") {
        refuse(
          "VALIDATION_FAILED",
          launch2PoolReasonCodes.insufficientLiquidity,
        );
      }
      if (name === "InvalidSwapDelta") {
        refuse("VALIDATION_FAILED", launch2PoolReasonCodes.quoteZero);
      }
      if (name === "InvalidAmount") {
        refuse("VALIDATION_FAILED", launch2ReasonCodes.amountInvalid);
      }
      refuse("VALIDATION_FAILED", launch2PoolReasonCodes.quoteUnavailable, {
        revertReason: name ?? "UNKNOWN",
      });
    }
    const amountIn =
      request.mode === "exactIn" ? request.amount : simulated.returned;
    const expectedOut =
      request.mode === "exactIn" ? simulated.returned : request.amount;
    if (expectedOut === 0n || amountIn === 0n) {
      refuse("VALIDATION_FAILED", launch2PoolReasonCodes.quoteZero);
    }
    const maxIn =
      request.mode === "exactIn"
        ? amountIn
        : launch2PoolMaxIn(amountIn, request.slippageBps);
    const minOut =
      request.mode === "exactIn"
        ? launch2PoolMinOut(expectedOut, request.slippageBps)
        : expectedOut;
    const tax = launch2PoolTaxOfNet(expectedOut, request.mode);
    const usd1Side = request.side === "buy" ? amountIn : expectedOut;
    const memeSide = request.side === "buy" ? expectedOut : amountIn;
    const inputBalance =
      request.side === "buy" ? state.usd1Balance : state.memeBalance;
    const numbers: PoolNumbers = {
      amountIn,
      maxIn,
      expectedOut,
      minOut,
      tax,
      deadline,
    };
    const resource = Object.freeze({
      instanceId: record.instanceId,
      walletId: wallet.walletId,
      venue: "official_pool",
      side: request.side,
      mode: request.mode,
      stage: "graduated",
      requestedAmount: formatLaunch2Amount(request.amount),
      amountIn: formatLaunch2Amount(amountIn),
      maxIn: formatLaunch2Amount(maxIn),
      expectedOut: formatLaunch2Amount(expectedOut),
      minOut: formatLaunch2Amount(minOut),
      slippageBps: request.slippageBps,
      taxBps: Number(launch2PoolTaxBps),
      taxAmount: formatLaunch2Amount(tax),
      taxToken: request.side === "buy" ? "meme" : "usd1",
      taxUsd1: formatLaunch2Amount(request.side === "sell" ? tax : 0n),
      priceBeforeUsd1: formatLaunch2Amount(
        launch2PoolPriceE18(state.sqrtPriceX96, memeIsCurrency0),
      ),
      averagePriceUsd1: formatLaunch2Amount(
        launch2PoolAveragePriceE18(usd1Side, memeSide),
      ),
      balance: Object.freeze({
        usd1: formatLaunch2Amount(state.usd1Balance),
        meme: formatLaunch2Amount(state.memeBalance),
      }),
      exceedsBalance: maxIn > inputBalance,
      router: pool.router,
      poolId: graduation.poolId.toLowerCase(),
      poolKey: key,
      zeroForOne,
      deadline: isoOf(deadline),
      expiresAt: isoOf(deadline),
      quotedAt: now().toISOString(),
      quotedAtBlock: state.blockNumber.toString(10),
      basis: Object.freeze({
        blockNumber: state.blockNumber.toString(10),
        blockHash: state.blockHash,
      }),
    });
    return {
      resource,
      state,
      key,
      zeroForOne,
      router: pool.router,
      numbers,
    };
  }

  // -------------------------------------------------------------------------
  // Decision 0131: LoopDynamic official pool
  // -------------------------------------------------------------------------

  function hookKindOf(record: Launch2InstanceRecord): Launch2PoolHookKind {
    return record.poolHookKind ?? launch2HookKindOf(record.addresses.hook);
  }

  function dynamicChain(): Launch2DynamicChain {
    if (deps.dynamicChain === undefined || deps.dynamicChain === null) {
      return unavailableWith(launch2DynamicReasonCodes.routerNotConfigured);
    }
    return deps.dynamicChain;
  }

  function dynamicRefuse(
    errorName: string | null,
    fallbackCode: string,
  ): never {
    const mapped = classifyLaunch2DynamicRevert(errorName);
    if (mapped === null) {
      refuse("VALIDATION_FAILED", fallbackCode, {
        revertReason: errorName ?? "UNKNOWN",
      });
    }
    throw V2ApiError.fromCode(mapped.code, { reasonCode: mapped.reasonCode });
  }

  /**
   * The bound Hook of a graduated LoopDynamic instance at one block, with
   * the router / PoolManager / pool id cross-checked: the Hook must trust
   * the configured LoopRouter, share its PoolManager, and serve the pool
   * the lane indexed (`LoopHookBound` = `Graduated.officialPoolId`).
   */
  async function dynamicHookAt(
    record: Launch2InstanceRecord,
    wallet: string | null,
    verifyRouter: boolean,
  ): Promise<{
    readonly chain: Launch2DynamicChain;
    readonly hook: string;
    readonly state: Launch2DynamicHookState;
  }> {
    const bound = record.dynamicPool ?? null;
    if (bound === null) {
      return unavailableWith(launch2DynamicReasonCodes.hookNotIndexed);
    }
    const reader = dynamicChain();
    let manager: string | null = null;
    if (verifyRouter) {
      const check = await chainRead(() => reader.verifyRouter());
      if (check.status !== "ok") return unavailableWith(check.reasonCode);
      manager = check.poolManager;
    }
    const state = await chainRead(() =>
      reader.readHookState({ hook: bound.hook, wallet }),
    );
    if (
      state.trustedRouter !== reader.router ||
      (manager !== null && state.manager !== manager) ||
      state.poolId !== bound.poolId.toLowerCase() ||
      (record.graduation !== null &&
        record.graduation.poolId.toLowerCase() !== state.poolId) ||
      state.meme !== record.addresses.meme.toLowerCase() ||
      (deps.dynamicRouterRegistry !== undefined &&
        deps.dynamicRouterRegistry !== null &&
        state.routerRegistry !== deps.dynamicRouterRegistry.toLowerCase())
    ) {
      return unavailableWith(launch2DynamicReasonCodes.hookMismatch);
    }
    if (!state.initialized) {
      return unavailableWith(launch2DynamicReasonCodes.hookNotInitialized);
    }
    return { chain: reader, hook: bound.hook.toLowerCase(), state };
  }

  /**
   * Decision 0131: a LoopDynamic quote at one block — exact-input only,
   * `LoopRouter.swapExactInput` simulated from the wallet (input balance /
   * allowance overridden in the call). A buy pays the 2 % buy fee in MEME
   * (S165) and earns reward weight = USD1 spent when the round is armed
   * after the candle roll the swap performs; a sell pays the base fee plus
   * the dynamic fee (split from a second, "neutral" simulation).
   */
  async function dynamicPoolQuoteAt(
    record: Launch2InstanceRecord,
    wallet: AccountWalletRecord,
    request: PoolRequest,
    deadlineSeconds: bigint,
  ): Promise<{
    readonly resource: Resource;
    readonly state: Launch2DynamicHookState;
    readonly key: Launch2PoolKey;
    readonly zeroForOne: boolean;
    readonly router: string;
    readonly numbers: PoolNumbers;
    readonly chain: Launch2DynamicChain;
  }> {
    if (request.mode !== "exactIn") {
      refuse(
        "VALIDATION_FAILED",
        launch2DynamicReasonCodes.exactOutUnsupported,
      );
    }
    if (record.holdReason !== null) {
      refuse("DATA_STALE", launch2ReasonCodes.instancePaused, {
        holdReason: record.holdReason,
      });
    }
    const stage = stageOf(record, nowSeconds()).stage;
    const graduation = record.graduation;
    if (stage !== "graduated" || graduation === null) {
      refuse("VALIDATION_FAILED", launch2PoolReasonCodes.notGraduated, {
        stage,
      });
    }
    const address = wallet.address.toLowerCase();
    const {
      chain: reader,
      hook,
      state,
    } = await dynamicHookAt(record, address, true);
    const meme = record.addresses.meme.toLowerCase();
    const key = launch2PoolKey({ meme, usd1: state.quote, hook });
    if (launch2PoolId(key) !== state.poolId) {
      return unavailableWith(launch2DynamicReasonCodes.hookMismatch);
    }
    const zeroForOne = launch2PoolZeroForOne(key, request.side, meme);
    const chainNow =
      state.blockTimestamp > nowSeconds() ? state.blockTimestamp : nowSeconds();
    const deadline = chainNow + deadlineSeconds;
    const inputToken = request.side === "buy" ? state.quote : meme;
    const data = encodeLaunch2DynamicSwap({
      key,
      zeroForOne,
      amountIn: request.amount,
      minOut: 0n,
      deadline,
    });
    const override = {
      token: inputToken,
      balance: request.amount,
      allowance: request.amount,
    };
    const simulate = (neutralHook: string | null) =>
      chainRead(() =>
        reader.simulateSwap({
          blockNumber: state.blockNumber,
          from: address,
          data,
          override,
          neutralHook,
        }),
      );
    const actual = await simulate(null);
    if (actual.status === "override_unsupported") {
      refuse("VALIDATION_FAILED", launch2PoolReasonCodes.quoteUnavailable, {
        revertReason: "STATE_OVERRIDE_UNSUPPORTED",
      });
    }
    if (actual.status === "reverted") {
      dynamicRefuse(actual.errorName, launch2PoolReasonCodes.quoteUnavailable);
    }
    const amountIn = actual.amountSpent;
    const expectedOut = actual.amountReceived;
    if (expectedOut === 0n || amountIn === 0n) {
      refuse("VALIDATION_FAILED", launch2PoolReasonCodes.quoteZero);
    }
    const roll = launch2DynamicRoll(state, state.blockTimestamp);
    let baseFee: bigint;
    let dynamicFee = 0n;
    let dynamicTaxBps = 0;
    let rewardWeight = 0n;
    if (request.side === "buy") {
      // S165: the buy fee is taken from the MEME output (gross − fee = net).
      const gross = launch2DynamicGrossOfNet(expectedOut, state.buyFeePpm);
      baseFee = gross - expectedOut;
      if (roll.armed && address !== state.rewardExcludedBuyer) {
        rewardWeight = amountIn;
      }
    } else {
      const neutral = await simulate(hook);
      if (neutral.status !== "ok") {
        refuse("VALIDATION_FAILED", launch2PoolReasonCodes.quoteUnavailable, {
          revertReason:
            neutral.status === "reverted"
              ? (neutral.errorName ?? "UNKNOWN")
              : "STATE_OVERRIDE_UNSUPPORTED",
        });
      }
      const split = launch2DynamicSellSplit({
        netActual: expectedOut,
        netNeutral: neutral.amountReceived,
        baseSellFeePpm: state.baseSellFeePpm,
      });
      baseFee = split.baseFee;
      dynamicFee = split.dynamicFee;
      dynamicTaxBps = split.dynamicTaxBps;
    }
    const tax = baseFee + dynamicFee;
    const minOut = launch2PoolMinOut(expectedOut, request.slippageBps);
    const usd1Side = request.side === "buy" ? amountIn : expectedOut;
    const memeSide = request.side === "buy" ? expectedOut : amountIn;
    const inputBalance =
      request.side === "buy"
        ? (state.wallet?.usd1Balance ?? 0n)
        : (state.wallet?.memeBalance ?? 0n);
    const numbers: PoolNumbers = {
      amountIn,
      maxIn: amountIn,
      expectedOut,
      minOut,
      tax,
      deadline,
    };
    const resource = Object.freeze({
      instanceId: record.instanceId,
      walletId: wallet.walletId,
      venue: "official_pool",
      side: request.side,
      mode: request.mode,
      stage: "graduated",
      requestedAmount: formatLaunch2Amount(request.amount),
      amountIn: formatLaunch2Amount(amountIn),
      maxIn: formatLaunch2Amount(amountIn),
      expectedOut: formatLaunch2Amount(expectedOut),
      minOut: formatLaunch2Amount(minOut),
      slippageBps: request.slippageBps,
      taxBps: launch2DynamicBps(
        request.side === "buy" ? state.buyFeePpm : state.baseSellFeePpm,
      ),
      taxAmount: formatLaunch2Amount(tax),
      taxToken: request.side === "buy" ? "meme" : "usd1",
      taxUsd1: formatLaunch2Amount(request.side === "sell" ? tax : 0n),
      priceBeforeUsd1: formatLaunch2Amount(
        launch2PoolPriceE18(state.sqrtPriceX96, state.memeIsCurrency0),
      ),
      averagePriceUsd1: formatLaunch2Amount(
        launch2PoolAveragePriceE18(usd1Side, memeSide),
      ),
      balance: Object.freeze({
        usd1: formatLaunch2Amount(state.wallet?.usd1Balance ?? 0n),
        meme: formatLaunch2Amount(state.wallet?.memeBalance ?? 0n),
      }),
      exceedsBalance: amountIn > inputBalance,
      router: reader.router,
      poolId: state.poolId,
      poolKey: key,
      zeroForOne,
      deadline: isoOf(deadline),
      expiresAt: isoOf(deadline),
      quotedAt: now().toISOString(),
      quotedAtBlock: state.blockNumber.toString(10),
      basis: Object.freeze({
        blockNumber: state.blockNumber.toString(10),
        blockHash: state.blockHash,
      }),
      dynamic: Object.freeze({
        hookKind: "loopDynamic",
        hook,
        priceTiming: launch2DynamicPriceTiming(state.priceTiming),
        baseTaxBps: launch2DynamicBps(
          request.side === "buy" ? state.buyFeePpm : state.baseSellFeePpm,
        ),
        baseTaxAmount: formatLaunch2Amount(baseFee),
        dynamicTaxBps,
        dynamicTaxAmount: formatLaunch2Amount(dynamicFee),
        armed: roll.armed,
        roundId: roll.armed ? roll.roundId.toString(10) : null,
        rewardWeight: formatLaunch2Amount(rewardWeight),
      }),
    });
    return {
      resource,
      state,
      key,
      zeroForOne,
      router: reader.router,
      numbers,
      chain: reader,
    };
  }

  async function prepareDynamicPoolTrade(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly record: Launch2InstanceRecord;
    readonly body: PoolRequest & { readonly walletId: string };
    readonly idempotencyKey: string;
    readonly writes: BscWriteConfig;
  }): Promise<Resource> {
    const { record, body, writes } = input;
    if (body.mode !== "exactIn") {
      refuse(
        "VALIDATION_FAILED",
        launch2DynamicReasonCodes.exactOutUnsupported,
      );
    }
    const wallet = await signingWallet(input.principal, body.walletId);
    const requestSha256 = requestDigest([
      record.instanceId,
      wallet.walletId,
      "loop_dynamic_pool",
      body.side,
      body.mode,
      body.amount.toString(10),
      String(body.slippageBps),
    ]);
    const intent = await createIntentRecord(
      input.principal,
      input.idempotencyKey,
      requestSha256,
      writes,
      async () => {
        const priced = await dynamicPoolQuoteAt(
          record,
          wallet,
          body,
          tradeDeadlineSeconds,
        );
        const {
          numbers,
          state,
          key,
          zeroForOne,
          router,
          chain: reader,
        } = priced;
        const inputBalance =
          body.side === "buy"
            ? (state.wallet?.usd1Balance ?? 0n)
            : (state.wallet?.memeBalance ?? 0n);
        if (numbers.maxIn > inputBalance) {
          refuse(
            "INSUFFICIENT_BALANCE",
            body.side === "buy"
              ? launch2ReasonCodes.usd1Insufficient
              : launch2ReasonCodes.memeInsufficient,
            {
              maxAmountIn: formatLaunch2Amount(inputBalance),
              requiredAmountIn: formatLaunch2Amount(numbers.maxIn),
              ...(body.side === "buy"
                ? { balanceUsd1: formatLaunch2Amount(inputBalance) }
                : { balanceMeme: formatLaunch2Amount(inputBalance) }),
            },
          );
        }
        const address = wallet.address.toLowerCase();
        const data = encodeLaunch2DynamicSwap({
          key,
          zeroForOne,
          amountIn: numbers.amountIn,
          minOut: numbers.minOut,
          deadline: numbers.deadline,
        });
        const inputToken =
          body.side === "buy" ? state.quote : record.addresses.meme;
        const overrideFor = (
          approvalPending: boolean,
        ): Launch2DynamicSwapCall["override"] =>
          approvalPending
            ? { token: inputToken, balance: null, allowance: numbers.maxIn }
            : null;
        const kind = body.side === "buy" ? "pool_buy" : "pool_sell";
        return sealIntent({
          principal: input.principal,
          record,
          wallet,
          writes,
          kind,
          state: {
            usd1: state.quote,
            blockNumber: state.blockNumber,
            blockHash: state.blockHash,
          },
          contract: router,
          data,
          approval: { token: inputToken, amount: numbers.maxIn },
          amountIn: numbers.maxIn,
          expectedOut: numbers.expectedOut,
          minOut: numbers.minOut,
          tax: body.side === "sell" ? numbers.tax : 0n,
          refund: 0n,
          valueUsd: body.side === "buy" ? numbers.maxIn : numbers.expectedOut,
          deadline: numbers.deadline,
          gasHint: fallbackGas[kind],
          verifiedRouter: router,
          simulate: async (approvalPending) => {
            const simulated = await reader.simulateSwap({
              blockNumber: state.blockNumber,
              from: address,
              data,
              override: overrideFor(approvalPending),
              neutralHook: null,
            });
            if (simulated.status !== "ok") {
              const reverted = simulated.status === "reverted";
              return {
                status: reverted ? "reverted" : "unavailable",
                reasonCode: reverted
                  ? (classifyLaunch2DynamicRevert(simulated.errorName)
                      ?.reasonCode ?? launch2ReasonCodes.simulationReverted)
                  : launch2ReasonCodes.simulationUnavailable,
                gas: null,
              };
            }
            const gas = await reader.estimateGas({
              from: address,
              to: router,
              data,
              override: overrideFor(approvalPending),
            });
            return gas === null
              ? {
                  status: "unavailable",
                  reasonCode: launch2ReasonCodes.simulationUnavailable,
                  gas: null,
                }
              : { status: "passed", reasonCode: null, gas };
          },
          policyExtra: { poolQuote: priced.resource },
        });
      },
    );
    return Object.freeze({
      launch2Intent: intent.resource["launch2Intent"],
      quote: intent.record.policy["poolQuote"],
      contractVersion: v2ContractVersion,
    });
  }

  function notApplicableDynamicPool(
    record: Launch2InstanceRecord,
    hookKind: Launch2PoolHookKind,
    status: "not_applicable" | "not_graduated",
  ): Resource {
    return Object.freeze({
      dynamicPool: Object.freeze({
        instanceId: record.instanceId,
        hookKind,
        status,
        hook: null,
        poolId: null,
        router: null,
        routerRegistry: null,
        routingPolicy: null,
        priceTiming: null,
        buyTaxBps: null,
        baseSellTaxBps: null,
        excludeBuybackFromRewards: null,
        armed: null,
        currentRoundId: null,
        candleId: null,
        candleSeconds: Number(launch2DynamicCandleSeconds),
        candleEndsAt: null,
        rollPending: null,
        currentDropWad: null,
        currentDropBps: null,
        potUsd1: null,
        carryUsd1: null,
        roundExtraFeesUsd1: null,
        roundTotalBuyWeightUsd1: null,
        reservedRewardsUsd1: null,
        priceUsd1: null,
        viewer: null,
        summary: null,
        basis: null,
      }),
      contractVersion: v2ContractVersion,
    });
  }

  function parseRoundId(value: unknown): bigint {
    if (typeof value !== "string" || !/^[1-9][0-9]{0,30}$/u.test(value)) {
      refuse("VALIDATION_FAILED", launch2DynamicReasonCodes.roundInvalid);
    }
    return BigInt(value);
  }

  async function getDynamicPool(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly instanceId: string;
    readonly walletId?: unknown;
  }): Promise<Resource> {
    const record = await visibleInstance(input.instanceId);
    const hookKind = hookKindOf(record);
    if (hookKind !== "loopDynamic") {
      return notApplicableDynamicPool(record, hookKind, "not_applicable");
    }
    if (record.graduation === null) {
      return notApplicableDynamicPool(record, hookKind, "not_graduated");
    }
    const wallet = await walletFor(input.principal, input.walletId, false);
    const {
      chain: reader,
      hook,
      state,
    } = await dynamicHookAt(
      record,
      wallet === null ? null : wallet.address.toLowerCase(),
      true,
    );
    const summary = await repository()
      .dynamicRoundSummary(record.instanceId)
      .catch(translate);
    const roll = launch2DynamicRoll(state, state.blockTimestamp);
    const roundExtra =
      state.armed && state.currentRound !== null
        ? state.currentRound.extraFees
        : 0n;
    const roundWeight =
      state.armed && state.currentRound !== null
        ? state.currentRound.totalBuyWeight
        : 0n;
    return Object.freeze({
      dynamicPool: Object.freeze({
        instanceId: record.instanceId,
        hookKind,
        status: "active",
        hook,
        poolId: state.poolId,
        router: reader.router,
        routerRegistry:
          state.routerRegistry === "0x0000000000000000000000000000000000000000"
            ? null
            : state.routerRegistry,
        routingPolicy: launch2DynamicRoutingPolicy(state.routingPolicy),
        priceTiming: launch2DynamicPriceTiming(state.priceTiming),
        buyTaxBps: launch2DynamicBps(state.buyFeePpm),
        baseSellTaxBps: launch2DynamicBps(state.baseSellFeePpm),
        excludeBuybackFromRewards: state.excludeBuybackFromRewards,
        armed: state.armed,
        currentRoundId:
          state.armed && state.currentRoundId > 0n
            ? state.currentRoundId.toString(10)
            : null,
        candleId: state.candleId.toString(10),
        candleSeconds: Number(launch2DynamicCandleSeconds),
        candleEndsAt: isoOf(
          (state.candleId + 1n) * launch2DynamicCandleSeconds,
        ),
        rollPending: roll.rollPending,
        currentDropWad: formatLaunch2Amount(state.currentDropWad),
        currentDropBps: Number((state.currentDropWad * 10_000n) / 10n ** 18n),
        potUsd1: formatLaunch2Amount(state.carry + roundExtra),
        carryUsd1: formatLaunch2Amount(state.carry),
        roundExtraFeesUsd1: formatLaunch2Amount(roundExtra),
        roundTotalBuyWeightUsd1: formatLaunch2Amount(roundWeight),
        reservedRewardsUsd1: formatLaunch2Amount(state.reservedRewards),
        priceUsd1: formatLaunch2Amount(
          launch2PoolPriceE18(state.sqrtPriceX96, state.memeIsCurrency0),
        ),
        viewer:
          wallet === null || state.wallet === null
            ? null
            : Object.freeze({
                walletId: wallet.walletId,
                currentRoundWeightUsd1: formatLaunch2Amount(
                  state.armed ? state.wallet.currentRoundWeight : 0n,
                ),
              }),
        summary: Object.freeze({
          roundCount: summary.roundCount,
          closedRoundCount: summary.closedRoundCount,
          allocatedUsd1: formatLaunch2Amount(BigInt(summary.allocatedUsd1)),
          claimedUsd1: formatLaunch2Amount(BigInt(summary.claimedUsd1)),
          dynamicFeesUsd1: formatLaunch2Amount(BigInt(summary.extraFeesUsd1)),
          baseSellFeesUsd1: formatLaunch2Amount(
            BigInt(summary.baseSellFeesUsd1),
          ),
          buyFeesMeme: formatLaunch2Amount(BigInt(summary.buyFeesMeme)),
        }),
        basis: Object.freeze({
          blockNumber: state.blockNumber.toString(10),
          blockHash: state.blockHash,
        }),
      }),
      contractVersion: v2ContractVersion,
    });
  }

  async function listDynamicRewards(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly instanceId: string;
    readonly walletId?: unknown;
    readonly limit?: unknown;
  }): Promise<Resource> {
    const record = await visibleInstance(input.instanceId);
    if (input.walletId === undefined) throw V2ApiError.invalidRequest();
    const limit = parseLimit(input.limit, 50, 100);
    const wallet = await walletFor(input.principal, input.walletId, true);
    if (wallet === null) throw V2ApiError.notFound();
    const hookKind = hookKindOf(record);
    const rows =
      hookKind === "loopDynamic"
        ? await repository()
            .listDynamicRewards({
              instanceId: record.instanceId,
              walletAddress: wallet.address.toLowerCase(),
              limit,
            })
            .catch(translate)
        : [];
    let claimableTotal = 0n;
    let claimedTotal = 0n;
    const rounds = rows.map((row) => {
      const claimed =
        row.claimedAmountUsd1 === null ? null : BigInt(row.claimedAmountUsd1);
      const claimable =
        !row.closed || claimed !== null || row.allocationUsd1 === null
          ? 0n
          : launch2DynamicClaimable({
              allocation: BigInt(row.allocationUsd1),
              weight: BigInt(row.weightUsd1),
              totalBuyWeight: BigInt(row.totalBuyWeightUsd1),
            });
      claimableTotal += claimable;
      claimedTotal += claimed ?? 0n;
      return Object.freeze({
        roundId: row.roundId,
        status: !row.closed
          ? "open"
          : claimed !== null
            ? "claimed"
            : claimable > 0n
              ? "claimable"
              : "no_reward",
        weightUsd1: formatLaunch2Amount(BigInt(row.weightUsd1)),
        totalBuyWeightUsd1: formatLaunch2Amount(BigInt(row.totalBuyWeightUsd1)),
        allocationUsd1:
          row.allocationUsd1 === null
            ? null
            : formatLaunch2Amount(BigInt(row.allocationUsd1)),
        claimableUsd1: formatLaunch2Amount(claimable),
        claimedUsd1: claimed === null ? null : formatLaunch2Amount(claimed),
        claimTransactionHash: row.claimTransactionHash,
        claimedAt: row.claimedAt,
        startCandle: row.startCandle,
        endCandle: row.endCandle,
        activatedAt: row.activatedAt,
        closedAt: row.closedAt,
      });
    });
    return Object.freeze({
      instanceId: record.instanceId,
      walletId: wallet.walletId,
      hookKind,
      claimableUsd1: formatLaunch2Amount(claimableTotal),
      claimedUsd1: formatLaunch2Amount(claimedTotal),
      rounds,
      contractVersion: v2ContractVersion,
    });
  }

  async function prepareDynamicClaim(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly instanceId: string;
    readonly body: unknown;
    readonly idempotencyKey: string;
  }): Promise<Resource> {
    const writes = writesOrUnavailable();
    const body = input.body;
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== "walletId" && key !== "roundId")
    ) {
      throw V2ApiError.invalidRequest();
    }
    const value = body as Record<string, unknown>;
    if (
      typeof value["walletId"] !== "string" ||
      !isOpaqueId(value["walletId"])
    ) {
      throw V2ApiError.invalidRequest();
    }
    const walletId = value["walletId"];
    const roundId = parseRoundId(value["roundId"]);
    const record = await visibleInstance(input.instanceId);
    if (hookKindOf(record) !== "loopDynamic") {
      refuse("VALIDATION_FAILED", launch2DynamicReasonCodes.notApplicable);
    }
    if (record.graduation === null) {
      refuse("VALIDATION_FAILED", launch2PoolReasonCodes.notGraduated, {
        stage: stageOf(record, nowSeconds()).stage,
      });
    }
    const wallet = await signingWallet(input.principal, walletId);
    const requestSha256 = requestDigest([
      record.instanceId,
      wallet.walletId,
      "dynamic_claim",
      roundId.toString(10),
    ]);
    const intent = await createIntentRecord(
      input.principal,
      input.idempotencyKey,
      requestSha256,
      writes,
      async () => {
        const address = wallet.address.toLowerCase();
        const {
          chain: reader,
          hook,
          state,
        } = await dynamicHookAt(record, address, false);
        if (roundId > launch2DynamicRoll(state, state.blockTimestamp).roundId) {
          refuse("VALIDATION_FAILED", launch2DynamicReasonCodes.roundInvalid);
        }
        // `claim` rolls the candle first: a round the roll closes is
        // claimable in the same transaction, so the simulation decides.
        const simulated = await chainRead(() =>
          reader.simulateClaim({
            blockNumber: state.blockNumber,
            hook,
            roundId,
            wallet: address,
          }),
        );
        if (simulated.status === "reverted") {
          dynamicRefuse(
            simulated.errorName,
            launch2ReasonCodes.simulationReverted,
          );
        }
        if (simulated.amount === 0n) {
          refuse(
            "INSUFFICIENT_BALANCE",
            launch2DynamicReasonCodes.nothingToClaim,
          );
        }
        return sealIntent({
          principal: input.principal,
          record,
          wallet,
          writes,
          kind: "dynamic_claim",
          state: {
            usd1: state.quote,
            blockNumber: state.blockNumber,
            blockHash: state.blockHash,
          },
          contract: hook,
          data: encodeLaunch2DynamicClaim(roundId),
          approval: null,
          amountIn: 0n,
          expectedOut: simulated.amount,
          minOut: 0n,
          tax: 0n,
          refund: 0n,
          valueUsd: simulated.amount,
          deadline: nowSeconds() + tradeDeadlineSeconds,
          gasHint: fallbackGas.dynamic_claim,
          // The Hook the instance's own graduation adapter bound (indexed).
          verifiedRouter: hook,
          policyExtra: {
            dynamicClaim: {
              roundId: roundId.toString(10),
              hook,
              claimableUsd1: formatLaunch2Amount(simulated.amount),
            },
          },
        });
      },
    );
    return Object.freeze({
      launch2Intent: intent.resource["launch2Intent"],
      claim: intent.record.policy["dynamicClaim"],
      contractVersion: v2ContractVersion,
    });
  }

  async function reportDynamicClaim(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly instanceId: string;
    readonly body: unknown;
    readonly idempotencyKey: string;
  }): Promise<Resource> {
    const body = input.body;
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).some(
        (key) =>
          key !== "intentId" &&
          key !== "transactionHash" &&
          key !== "walletId" &&
          key !== "roundId",
      )
    ) {
      throw V2ApiError.invalidRequest();
    }
    const value = body as Record<string, unknown>;
    const intentId = value["intentId"];
    const transactionHash = value["transactionHash"];
    // Optional echoes (S168-mobile sends them): must match the intent.
    const echoedWalletId = value["walletId"];
    const echoedRoundId = value["roundId"];
    if (
      (echoedWalletId !== undefined &&
        (typeof echoedWalletId !== "string" || !isOpaqueId(echoedWalletId))) ||
      (echoedRoundId !== undefined &&
        (typeof echoedRoundId !== "string" ||
          !/^[1-9][0-9]{0,30}$/u.test(echoedRoundId)))
    ) {
      throw V2ApiError.invalidRequest();
    }
    if (
      typeof intentId !== "string" ||
      !isOpaqueId(intentId) ||
      typeof transactionHash !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/u.test(transactionHash)
    ) {
      throw V2ApiError.invalidRequest();
    }
    const record = await visibleInstance(input.instanceId);
    const store = repository();
    const intent = await store
      .getDynamicClaimIntent({
        intentId,
        ownerUserId: input.principal.userId,
      })
      .catch(translate);
    const claim = intent?.policy["dynamicClaim"] as
      { readonly roundId?: unknown } | undefined;
    if (
      intent === null ||
      intent.instanceId !== record.instanceId ||
      typeof claim?.roundId !== "string" ||
      (echoedWalletId !== undefined && echoedWalletId !== intent.walletId) ||
      (echoedRoundId !== undefined && echoedRoundId !== claim.roundId)
    ) {
      throw V2ApiError.fromCode("NOT_FOUND", {
        reasonCode: launch2DynamicReasonCodes.claimIntentNotFound,
      });
    }
    const recorded = await store
      .recordDynamicClaimReport({
        intentId,
        ownerUserId: input.principal.userId,
        instanceId: record.instanceId,
        walletId: intent.walletId,
        walletAddress: intent.walletAddress,
        roundId: claim.roundId,
        transactionHash: transactionHash.toLowerCase(),
      })
      .catch(translate);
    if (recorded.outcome === "conflict") {
      throw V2ApiError.fromCode("RESOURCE_CONFLICT", {
        reasonCode: launch2DynamicReasonCodes.claimTransactionConflict,
      });
    }
    const indexed = await store
      .findDynamicClaim({
        instanceId: record.instanceId,
        transactionHash: recorded.report.transactionHash,
        roundId: claim.roundId,
        buyer: intent.walletAddress,
      })
      .catch(translate);
    return Object.freeze({
      dynamicClaimReport: Object.freeze({
        intentId,
        instanceId: record.instanceId,
        walletId: intent.walletId,
        roundId: claim.roundId,
        transactionHash: recorded.report.transactionHash,
        status: indexed === null ? "submitted" : "confirmed",
        amountUsd1:
          indexed === null
            ? null
            : formatLaunch2Amount(BigInt(indexed.amountUsd1)),
        claimedAt: indexed?.claimedAt ?? null,
        blockNumber: indexed?.blockNumber ?? null,
        reportedAt: recorded.report.reportedAt,
      }),
      contractVersion: v2ContractVersion,
    });
  }

  return Object.freeze<Launch2Service>({
    async poolQuote(input) {
      const record = await visibleInstance(input.instanceId);
      const request = parsePoolRequest({
        side: input.side,
        mode: input.mode,
        amount: input.amount,
        slippageBps:
          input.slippageBps === undefined
            ? deps.defaultSlippageBps
            : typeof input.slippageBps === "string" &&
                /^(0|[1-9][0-9]{0,3})$/u.test(input.slippageBps)
              ? Number(input.slippageBps)
              : Number.NaN,
      });
      const wallet = await walletFor(input.principal, input.walletId, true);
      if (wallet === null) throw V2ApiError.notFound();
      // Decision 0131: a LoopDynamic instance quotes through LoopRouter.
      const priced = await (
        hookKindOf(record) === "loopDynamic" ? dynamicPoolQuoteAt : poolQuoteAt
      )(
        record,
        wallet,
        request,
        BigInt(Math.min(deps.quoteTtlSeconds, maximumDeadlineSeconds)),
      );
      return Object.freeze({
        quote: priced.resource,
        contractVersion: v2ContractVersion,
      });
    },

    async preparePoolTrade(input) {
      const writes = writesOrUnavailable();
      const body = parsePoolTradeBody(input.body);
      const record = await visibleInstance(input.instanceId);
      if (hookKindOf(record) === "loopDynamic") {
        return prepareDynamicPoolTrade({
          principal: input.principal,
          record,
          body,
          idempotencyKey: input.idempotencyKey,
          writes,
        });
      }
      const wallet = await signingWallet(input.principal, body.walletId);
      const requestSha256 = requestDigest([
        record.instanceId,
        wallet.walletId,
        "official_pool",
        body.side,
        body.mode,
        body.amount.toString(10),
        String(body.slippageBps),
      ]);
      const intent = await createIntentRecord(
        input.principal,
        input.idempotencyKey,
        requestSha256,
        writes,
        async () => {
          // Decision 0126: a fresh simulation at the prepare block with the
          // longer trade deadline (approve + trade are signed one after the
          // other on the device).
          const priced = await poolQuoteAt(
            record,
            wallet,
            body,
            tradeDeadlineSeconds,
          );
          const { numbers, state, key, zeroForOne, router } = priced;
          const inputBalance =
            body.side === "buy" ? state.usd1Balance : state.memeBalance;
          if (numbers.maxIn > inputBalance) {
            refuse(
              "INSUFFICIENT_BALANCE",
              body.side === "buy"
                ? launch2ReasonCodes.usd1Insufficient
                : launch2ReasonCodes.memeInsufficient,
              {
                maxAmountIn: formatLaunch2Amount(inputBalance),
                requiredAmountIn: formatLaunch2Amount(numbers.maxIn),
                ...(body.side === "buy"
                  ? { balanceUsd1: formatLaunch2Amount(state.usd1Balance) }
                  : { balanceMeme: formatLaunch2Amount(state.memeBalance) }),
              },
            );
          }
          const address = wallet.address.toLowerCase();
          const data = encodePoolSwap({
            mode: body.mode,
            key,
            zeroForOne,
            amountIn: numbers.amountIn,
            expectedOut: numbers.expectedOut,
            minOut: numbers.minOut,
            maxIn: numbers.maxIn,
            recipient: address,
            deadline: numbers.deadline,
          });
          const inputToken =
            body.side === "buy" ? state.curveUsd1 : record.addresses.meme;
          const pool = poolChain();
          const call = (approvalPending: boolean) => ({
            blockNumber: state.blockNumber,
            from: address,
            data,
            override: approvalPending
              ? { token: inputToken, balance: null, allowance: numbers.maxIn }
              : null,
          });
          const kind = body.side === "buy" ? "pool_buy" : "pool_sell";
          return sealIntent({
            principal: input.principal,
            record,
            wallet,
            writes,
            kind,
            state: {
              usd1: state.curveUsd1,
              blockNumber: state.blockNumber,
              blockHash: state.blockHash,
            },
            contract: router,
            data,
            approval: { token: inputToken, amount: numbers.maxIn },
            amountIn: numbers.maxIn,
            expectedOut: numbers.expectedOut,
            minOut: numbers.minOut,
            tax: body.side === "sell" ? numbers.tax : 0n,
            refund: 0n,
            valueUsd: body.side === "buy" ? numbers.maxIn : numbers.expectedOut,
            deadline: numbers.deadline,
            gasHint: fallbackGas[kind],
            verifiedRouter: router,
            simulate: async (approvalPending) => {
              const simulated = await pool.simulate(call(approvalPending));
              if (simulated.status !== "ok") {
                const reverted = simulated.status === "reverted";
                return {
                  status: reverted ? "reverted" : "unavailable",
                  reasonCode: reverted
                    ? launch2ReasonCodes.simulationReverted
                    : launch2ReasonCodes.simulationUnavailable,
                  gas: null,
                };
              }
              const gas = await pool.estimateGas(call(approvalPending));
              return gas === null
                ? {
                    status: "unavailable",
                    reasonCode: launch2ReasonCodes.simulationUnavailable,
                    gas: null,
                  }
                : { status: "passed", reasonCode: null, gas };
            },
            policyExtra: { poolQuote: priced.resource },
          });
        },
      );
      return Object.freeze({
        launch2Intent: intent.resource["launch2Intent"],
        quote: intent.record.policy["poolQuote"],
        contractVersion: v2ContractVersion,
      });
    },

    getDynamicPool,
    listDynamicRewards,
    prepareDynamicClaim,
    reportDynamicClaim,

    async listPoolTrades(input) {
      const record = await visibleInstance(input.instanceId);
      const store = repository();
      if (input.walletId === undefined) throw V2ApiError.invalidRequest();
      const limit = parseLimit(input.limit, 20, 50);
      const wallet = await walletFor(input.principal, input.walletId, true);
      if (wallet === null) throw V2ApiError.notFound();
      const address = wallet.address.toLowerCase();
      const [rows, stats] =
        record.graduation === null
          ? [[] as readonly Launch2PoolTradeRecord[], [] as const]
          : await Promise.all([
              store
                .listPoolTrades({
                  instanceId: record.instanceId,
                  walletAddress: address,
                  limit,
                })
                .catch(translate),
              store
                .poolTradeStats({
                  instanceId: record.instanceId,
                  walletAddresses: [address],
                })
                .catch(translate),
            ]);
      return Object.freeze({
        instanceId: record.instanceId,
        walletId: wallet.walletId,
        ...poolTradeStatsOf(stats[0]),
        trades: rows.map(poolTradeOf),
        contractVersion: v2ContractVersion,
      });
    },

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
      const [latest, trades, positions, member, poolStats, balances] =
        await Promise.all([
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
          wallet === null || record.graduation === null
            ? Promise.resolve([] as readonly Launch2PoolTradeStats[])
            : store
                .poolTradeStats({
                  instanceId: record.instanceId,
                  walletAddresses: [wallet.address],
                })
                .catch(translate),
          wallet === null
            ? Promise.resolve(notGraduatedBalances)
            : walletBalancesOf(record, wallet.address),
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
          template: launch2TemplateProjection(
            Number(seconds(record.nftSaleEnd) - seconds(record.nftSaleStart)),
          ),
          contracts: Object.freeze({
            factory: record.factoryAddress,
            ...record.addresses,
          }),
          snapshot: Object.freeze({
            status:
              snapshot !== null
                ? "published"
                : record.openedWithoutHolders !== null
                  ? "opened_without_holders"
                  : "pending",
            verification:
              snapshot === null ? null : (snapshot.verification ?? "pending"),
            root: snapshot?.root ?? null,
            dataHash: snapshot?.dataHash ?? null,
            cutoffBlockNumber: snapshot?.cutoffBlock ?? null,
            cutoffBlockHash: snapshot?.cutoffBlockHash ?? null,
            publishedAt: snapshot?.publishedAt ?? null,
            earlyRoundEndsAt:
              snapshot !== null
                ? isoOf(launch2EarlyRoundEnd(seconds(snapshot.publishedAt)))
                : // Decision 0122: no early round after a zero-holder opening.
                  (record.openedWithoutHolders?.openedAt ?? null),
            memberCount: snapshot?.memberCount ?? null,
            signers: snapshot?.signers ?? null,
            publication:
              record.snapshotPublication === null
                ? null
                : Object.freeze({ ...record.snapshotPublication }),
            closure:
              record.noHoldersClosure === null
                ? null
                : Object.freeze({
                    reason: "no_holders" as const,
                    cutoffBlock: record.noHoldersClosure.cutoffBlock,
                    closedAt: record.noHoldersClosure.closedAt,
                  }),
            openedWithoutHolders:
              record.openedWithoutHolders === null
                ? null
                : Object.freeze({ ...record.openedWithoutHolders }),
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
          pool:
            graduation === null
              ? null
              : Object.freeze({
                  poolId: graduation.poolId,
                  router: deps.poolChain?.router ?? null,
                  tradeCount: record.pool.tradeCount,
                  buyCount: record.pool.buyCount,
                  sellCount: record.pool.sellCount,
                  buyVolumeUsd1: formatLaunch2Amount(
                    BigInt(record.pool.buyVolumeUsd1),
                  ),
                  sellVolumeUsd1: formatLaunch2Amount(
                    BigInt(record.pool.sellVolumeUsd1),
                  ),
                  volume24hUsd1: formatLaunch2Amount(
                    BigInt(record.pool.volume24hUsd1),
                  ),
                  taxUsd1: formatLaunch2Amount(BigInt(record.pool.taxUsd1)),
                  taxMeme: formatLaunch2Amount(BigInt(record.pool.taxMeme)),
                  lastPriceUsd1:
                    record.pool.lastPriceE18 === null
                      ? null
                      : formatLaunch2Amount(BigInt(record.pool.lastPriceE18)),
                  lastTradeAt: record.pool.lastTradeAt,
                  // Decision 0127: without the buyback executor's swaps.
                  userTradeCount: record.pool.userTradeCount,
                  userBuyVolumeUsd1: formatLaunch2Amount(
                    BigInt(record.pool.userBuyVolumeUsd1),
                  ),
                  userSellVolumeUsd1: formatLaunch2Amount(
                    BigInt(record.pool.userSellVolumeUsd1),
                  ),
                }),
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
                  ...balances,
                  ...poolTradeStatsOf(poolStats[0]),
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
            generation: record.generation,
          });
          const blocked = launch2NextOrderBlockedReason({
            generation: record.generation,
            graduated: record.graduation !== null,
            state,
          });
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
      const stats = await store
        .poolTradeStats({
          instanceId: null,
          walletAddresses: [...byAddress.keys()],
        })
        .catch(translate);
      const statsOf = new Map(
        stats.map((row) => [`${row.instanceId}|${row.walletAddress}`, row]),
      );
      // Decision 0126: live balances of graduated rows, a few reads at a
      // time (each cached ≤ 15 s).
      const balancesOf = new Map<string, Resource>();
      const pending = positions.filter(
        (position) =>
          instances.get(position.instanceId)?.graduation !== null &&
          instances.has(position.instanceId),
      );
      for (let index = 0; index < pending.length; index += 8) {
        await Promise.all(
          pending.slice(index, index + 8).map(async (position) => {
            const record = instances.get(
              position.instanceId,
            ) as Launch2InstanceRecord;
            balancesOf.set(
              `${position.instanceId}|${position.holderAddress}`,
              await walletBalancesOf(record, position.holderAddress),
            );
          }),
        );
      }
      return Object.freeze({
        positions: positions.flatMap((position) => {
          const record = instances.get(position.instanceId);
          const wallet = byAddress.get(position.holderAddress);
          if (record === undefined || wallet === undefined) return [];
          const key = `${position.instanceId}|${position.holderAddress}`;
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
              ...(balancesOf.get(key) ?? notGraduatedBalances),
              ...poolTradeStatsOf(statsOf.get(key)),
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
                balanceUsd1: formatLaunch2Amount(state.usd1Balance ?? 0n),
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
            deadline: seconds(record.nftSaleEnd),
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
                {
                  maxAmountIn: formatLaunch2Amount(numbers.max.amountIn),
                  ...(body.side === "buy"
                    ? {
                        balanceUsd1: formatLaunch2Amount(
                          state.usd1Balance ?? 0n,
                        ),
                      }
                    : {
                        balanceMeme: formatLaunch2Amount(
                          state.memeBalance ?? 0n,
                        ),
                      }),
                },
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
          // Decision 0126: the quote's deadline only proves freshness; the
          // chain deadline leaves room for the approve + trade signatures.
          const chainNow =
            state.curve.blockTimestamp > nowSeconds()
              ? state.curve.blockTimestamp
              : nowSeconds();
          const tradeDeadline =
            chainNow + tradeDeadlineSeconds > body.deadline
              ? chainNow + tradeDeadlineSeconds
              : body.deadline;
          const data =
            body.side === "buy"
              ? encodeFunctionData({
                  abi: curveEngineAbi,
                  functionName: "buy",
                  args: [
                    body.amount,
                    body.minOut,
                    tradeDeadline,
                    proof as readonly Hex[],
                  ],
                })
              : encodeFunctionData({
                  abi: curveEngineAbi,
                  functionName: "sell",
                  args: [body.amount, body.minOut, tradeDeadline],
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
            deadline: tradeDeadline,
            gasHint: graduating ? graduatingBuyGas : fallbackGas[body.side],
          });
        },
      );
    },
  });
}
