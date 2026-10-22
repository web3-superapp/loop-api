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
  launch2Wad,
  parseLaunch2Amount,
  type Launch2IntentKind,
  type Launch2Stage,
} from "./launch2-contract.js";
import {
  parseLaunch2CandleQuery,
  readLaunch2Candles,
} from "./launch2-candles.js";
import { requireLaunch2Counterparties } from "./launch2-counterparty.js";
import {
  launch2EmptyPositionPnl,
  launch2PositionPnlOf,
  replayLaunch2CostBasis,
} from "./launch2-cost-basis.js";
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
  type Launch2DynamicFactoryRouting,
  type Launch2DynamicHookState,
  type Launch2DynamicSwapCall,
  type Launch2InstanceRecord,
  type Launch2IntentRecord,
  type Launch2PoolChain,
  type Launch2PoolChainState,
  type Launch2PoolTradeRecord,
  type Launch2PoolTradeStats,
  type Launch2PositionRecord,
  type Launch2PublicMemeFacts,
  type Launch2PublicPoolTradeRecord,
  type Launch2CostTradeRecord,
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
import { deriveLaunch2StageOf, launch2EarlyRoundEnd } from "./launch2-stage.js";
import {
  launch2TradingHoldOf,
  launch2TradingHoldReasonCodes,
  type Launch2TradingHold,
} from "./launch2-trading-hold.js";
import type { ChainGuardHoldGate } from "../chain-guard/chain-guard-hold.js";
import { chainGuardReasonCodes } from "../chain-guard/chain-guard-contract.js";
import {
  classifyLaunch2DynamicRevert,
  encodeLaunch2DynamicClaim,
  encodeLaunch2DynamicSwap,
  launch2DynamicBps,
  launch2DynamicCandleSeconds,
  launch2DynamicClaimable,
  launch2DynamicBuyFeeTokenOfHook,
  launch2DynamicGrossOfNet,
  launch2DynamicUsd1BuySplit,
  launch2DynamicPriceTiming,
  launch2DynamicReasonCodes,
  launch2DynamicRoll,
  launch2DynamicEffectiveRateWad,
  launch2DynamicWadBps,
  launch2DynamicRoutingPolicy,
  launch2DynamicSellSplit,
  launch2HookKindOf,
  type Launch2DynamicBuyFeeToken,
  type Launch2PoolHookKind,
} from "./launch2-dynamic.js";
import {
  launch2OverviewActivityLimit,
  projectLaunch2Overview,
} from "./launch2-overview.js";
import {
  createEmptyWalletAccountDirectory,
  type TraderAccountProjection,
  type WalletAccountDirectory,
} from "../profile/wallet-account-directory.js";
import { launch2ProjectProfileProjection } from "./launch2-project-profile.js";
import {
  launch2NftLaunchIdPatternSource,
  launch2NftMetadataOf,
  launch2NftTokenIdPatternSource,
  type Launch2NftMetadata,
} from "./launch2-nft-metadata.js";
import {
  launch2PublicCandleIntervals,
  launch2PublicCandleMaximumLimit,
  launch2PublicChangePct,
  launch2PublicCurvePriceAt,
  launch2PublicExplorerBaseUrl,
  launch2PublicListDefaultLimit,
  launch2PublicListMaximumLimit,
  launch2PublicReasonCodes,
  launch2PublicSlogan,
  launch2PublicSocials,
  launch2PublicStageFilters,
  launch2PublicTotalTaxUsd1,
  type Launch2PublicStageFilter,
} from "./launch2-public.js";

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
  /** CAIP-2 id of the launch slot (`eip155:97`, or 56 under Decision 0150). */
  readonly chainId: LaunchChainId;
  /**
   * Decision 0150: `LAUNCH_CHAIN_ID=56` with `LAUNCH_MAINNET_ACK`. Absent /
   * false keeps LAUNCH2_MAINNET_SIGNING_CLOSED on 56 exactly as before.
   */
  readonly mainnetAcknowledged?: boolean;
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
   * Decision 0131: LAUNCH2_DYNAMIC_ROUTER_REGISTRY_ADDRESS. Decision 0153:
   * when set, the **current** LoopDynamic Factory's `routerRegistry()` must
   * equal it (else 503 LAUNCH2_DYNAMIC_ROUTER_MISMATCH); every Hook is
   * checked against its own Factory's registry.
   */
  readonly dynamicRouterRegistry?: string | null;
  /**
   * Decision 0153: the trusted LoopDynamic Factories — `current`
   * (LAUNCH2_DYNAMIC_FACTORY_ADDRESS) and `legacy` (the v3 entries of
   * LAUNCH2_LEGACY_FACTORIES), lower-case. A LoopDynamic instance of any
   * other Factory is 503 LAUNCH2_DYNAMIC_FACTORY_UNKNOWN. Absent / null =
   * none (every LoopDynamic read 503).
   */
  readonly dynamicFactories?: {
    readonly current: string | null;
    readonly legacy: readonly string[];
  } | null;
  /**
   * Decision 0126: `LAUNCH2_POOL_TRADE_DEADLINE_SECONDS` (default 180): the
   * on-chain deadline a pool or curve prepare encodes, counted from the
   * prepare (two device signatures must fit).
   */
  readonly tradeDeadlineSeconds?: number;
  /** Decision 0126: wallet balance cache lifetime (≤ 15 s, default 15 s). */
  readonly balanceCacheMs?: number;
  /**
   * Decision 0136: the chain guard's hold query for the launch chain;
   * absent / null (CHAIN_GUARD_ENABLED off, or no repository) = no hold
   * is ever applied and the instance detail shows `tradingHold: null`.
   */
  readonly chainGuardHolds?: ChainGuardHoldGate | null;
  readonly now?: () => Date;
  readonly createUuid?: () => string;
  readonly logger?: Launch2ServiceLogger;
  /**
   * Decision 0162: trader wallet → LOOP account for the curve trades, the
   * pool trades, and the launchpad activity. Absent = every trader stays a
   * bare wallet (`account: null`).
   */
  readonly accounts?: WalletAccountDirectory | null;
  /**
   * Decision 0166 (LAUNCH2_TRADER_ACCOUNT_EMIT): whether the three
   * projections above carry the `account` key at all. False (default) omits
   * the key and skips the directory lookup — builds <= 30 decode those
   * objects strictly and reject the extra key.
   */
  readonly traderAccountEmit?: boolean;
  /**
   * Decision 0173 (LAUNCH2_NFT_IMAGE_EMIT): whether the instance summary /
   * detail and the position rows carry the `nftImageUrl` key at all. False
   * (default) omits it — shipped clients decode those objects strictly.
   */
  readonly nftImageEmit?: boolean;
  /**
   * Decision 0174 (LAUNCH2_POSITION_VALUE_EMIT): whether the position rows
   * carry `priceUsd1` / `valueUsd1` / `priceSource` at all. False (default)
   * omits the three keys — shipped clients decode the rows strictly.
   */
  readonly positionValueEmit?: boolean;
  /**
   * Decision 0176 (LAUNCH2_PNL_EMIT): whether the position rows and the
   * detail's `viewer` carry the cost / PnL keys at all. False (default)
   * omits them — shipped clients decode those objects strictly.
   */
  readonly pnlEmit?: boolean;
}

type Resource = Record<string, unknown>;

/**
 * Decision 0169: one instance a wallet address holds something of, for the
 * public profile holdings. Raw 18-decimal integers.
 */
export interface Launch2AddressHolding {
  readonly instanceId: string;
  readonly chainId: string;
  readonly ticker: string;
  readonly name: string;
  readonly logoUrl: string | null;
  readonly stage: Launch2Stage;
  /** NFTs held (the indexed NFT transfers). */
  readonly nftHeld: number;
  /**
   * MEME held: the live balance once graduated (null when that read
   * failed), the curve net (bought − sold) before graduation.
   */
  readonly memeRaw: bigint | null;
  /** The indexed last price (pool once graduated, else curve); 0 = none. */
  readonly priceE18: bigint;
}

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
  /**
   * Decision 0173: the public ERC-721 metadata of one project NFT (no
   * principal). 404 LAUNCH2_INSTANCE_NOT_FOUND for an unknown launch id,
   * 404 LAUNCH2_NFT_NOT_MINTED for a token id above the minted count.
   */
  getNftMetadata(input: {
    readonly launchId: string;
    readonly tokenId: string;
  }): Promise<Launch2NftMetadata>;
  /**
   * Decision 0169: what `address` holds on the Launch chain, per instance
   * (the `launch2_positions` rows of the address, hidden listings included
   * as in Decision 0167). Not a route: the public profile reads it for the
   * profile owner's active wallet.
   */
  listAddressHoldings(input: {
    readonly address: string;
  }): Promise<readonly Launch2AddressHolding[]>;
  /** Decision 0139: the launchpad activity feed and scoreboard. */
  getOverview(input: {
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
  /**
   * Decision 0174: the instance's newest public official-pool trades (no
   * principal; wallets masked). Empty before graduation.
   */
  listRecentPoolTrades(input: {
    readonly instanceId: string;
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
  /** Decision 0147: the public MEME page list (no principal, no viewer). */
  listPublicMemes(input: {
    readonly stage?: unknown;
    readonly limit?: unknown;
    /** S207: the route's time budget; no further chain read once aborted. */
    readonly signal?: AbortSignal;
  }): Promise<Resource>;
  /** Decision 0147: one MEME's public page facts. */
  getPublicMeme(input: {
    readonly instanceId: string;
    readonly signal?: AbortSignal;
  }): Promise<Resource>;
  /** Decision 0147: one MEME's public 5-minute candles. */
  listPublicMemeCandles(input: {
    readonly instanceId: string;
    readonly interval?: unknown;
    readonly limit?: unknown;
    readonly signal?: AbortSignal;
  }): Promise<Resource>;
  /** Decision 0171: the App project page's curve / pool candles. */
  listCandles(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly instanceId: string;
    readonly interval?: unknown;
    readonly limit?: unknown;
    readonly before?: unknown;
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
  return deriveLaunch2StageOf(record, nowSeconds);
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
  /** Decision 0173: LAUNCH2_NFT_IMAGE_EMIT — false omits the key. */
  nftImageEmit: boolean,
): Resource {
  const stage = stageOf(record, nowSeconds);
  const sold = BigInt(record.soldSupply);
  const reserve = BigInt(record.reserveUsd1);
  // Decision 0138: null / [] when no config row joins (orphan, legacy).
  const profile = launch2ProjectProfileProjection(record.projectProfile);
  return Object.freeze({
    instanceId: record.instanceId,
    projectId: record.projectId,
    launchId: record.launchId,
    chainId: record.chainId,
    name: record.name,
    ticker: record.ticker,
    logoUrl: record.logoUrl,
    ...(nftImageEmit ? { nftImageUrl: record.nftImageUrl } : {}),
    summary: profile.summary,
    links: profile.links,
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
    // Decision 0163: no `listing` on /v2 — the shipped App's strict codec
    // refuses unknown keys; it ships later as an optional key with the App.
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

function tradeOf(
  record: Launch2TradeRecord,
  /** Decision 0166: null = LAUNCH2_TRADER_ACCOUNT_EMIT off, no `account` key. */
  accounts: ReadonlyMap<string, TraderAccountProjection | null> | null,
): Resource {
  return Object.freeze({
    tradeId: record.tradeId,
    side: record.side,
    traderAddress: record.traderAddress,
    ...(accounts === null
      ? {}
      : { account: accounts.get(record.traderAddress.toLowerCase()) ?? null }),
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

/**
 * Decision 0152: the instance curve's verified per-address purchase cap
 * (S209: a Factory parameter; before: the 5,000,000 MEME constant).
 */
function curvePurchaseCapOf(record: Launch2InstanceRecord): bigint {
  const raw = record.curvePurchaseCap;
  return raw !== undefined && /^[1-9][0-9]{0,77}$/u.test(raw)
    ? BigInt(raw)
    : launch2Template.perAddressCap;
}

function positionCurveOf(
  position: Launch2PositionRecord | null,
  cap: bigint,
): Resource {
  const bought = BigInt(position?.curveBought ?? "0");
  const sold = BigInt(position?.curveSold ?? "0");
  const cumulative = BigInt(position?.cumulativeBought ?? "0");
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

function poolTradeOf(
  record: Launch2PoolTradeRecord,
  /** Decision 0166: undefined = LAUNCH2_TRADER_ACCOUNT_EMIT off, no key. */
  account: TraderAccountProjection | null | undefined,
): Resource {
  const buy = record.side === "buy";
  return Object.freeze({
    poolTradeId: record.poolTradeId,
    ...(account === undefined ? {} : { account }),
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

/**
 * Decision 0174: a wallet address shown publicly — `0x` + the first four
 * and the last four hex digits (`0x1234…abcd`).
 */
export function maskLaunch2Wallet(address: string): string {
  const lower = address.toLowerCase();
  return `${lower.slice(0, 6)}…${lower.slice(-4)}`;
}

function publicPoolTradeOf(record: Launch2PublicPoolTradeRecord): Resource {
  return Object.freeze({
    txHash: record.transactionHash,
    blockNumber: record.blockNumber,
    at: record.tradedAt,
    side: record.side,
    memeAmount: formatLaunch2Amount(BigInt(record.memeAmount)),
    usd1Amount: formatLaunch2Amount(BigInt(record.usd1Amount)),
    priceUsd1: formatLaunch2Amount(BigInt(record.priceE18)),
    wallet:
      record.walletAddress === null
        ? null
        : maskLaunch2Wallet(record.walletAddress),
  });
}

/**
 * Decision 0174: the price and value of one position row. Before
 * graduation the curve's current price (`priceE18`, the detail's
 * `curve.priceUsd1`) × `curve.net`; after graduation the official pool's
 * last price (`pool.lastPriceUsd1`) × the live `memeBalance`. A missing or
 * zero price, or a balance that could not be read, is null — never
 * estimated. Value = floor(quantity × price / 1e18).
 */
/**
 * Decision 0174 / 0176: the price (0 = none) and the held quantity (null =
 * unreadable) a position is valued with — the curve price × `curve.net`
 * before graduation, the pool's last price × the live `memeBalance` after.
 */
function positionQuantityAndPrice(
  record: Launch2InstanceRecord,
  position: Launch2PositionRecord | null,
  balances: Resource,
): { readonly price: bigint; readonly quantity: bigint | null } {
  const graduated = record.graduation !== null;
  const rawPrice = graduated ? record.pool.lastPriceE18 : record.priceE18;
  const price =
    rawPrice !== null && /^[0-9]{1,78}$/u.test(rawPrice)
      ? BigInt(rawPrice)
      : 0n;
  let quantity: bigint | null;
  if (graduated) {
    const balance = balances["memeBalance"];
    quantity = typeof balance === "string" ? parseLaunch2Amount(balance) : null;
  } else if (position === null) {
    quantity = 0n;
  } else {
    const bought = BigInt(position.curveBought);
    const sold = BigInt(position.curveSold);
    quantity = bought > sold ? bought - sold : 0n;
  }
  return { price, quantity };
}

/**
 * Decision 0176: the cost / PnL keys of a position from the wallet's
 * trades of the instance (chain order; empty = all null).
 */
function positionPnlOf(
  record: Launch2InstanceRecord,
  position: Launch2PositionRecord | null,
  balances: Resource,
  trades: readonly Launch2CostTradeRecord[],
): Resource {
  if (trades.length === 0) return launch2EmptyPositionPnl;
  const { price, quantity } = positionQuantityAndPrice(
    record,
    position,
    balances,
  );
  return launch2PositionPnlOf({
    replay: replayLaunch2CostBasis(
      trades.map((trade) => ({
        side: trade.side,
        memeAmount: BigInt(trade.memeAmount),
        usd1Amount: BigInt(trade.usd1Amount),
      })),
    ),
    holding: quantity,
    priceE18: price === 0n ? null : price,
  });
}

function positionValueOf(
  record: Launch2InstanceRecord,
  position: Launch2PositionRecord,
  balances: Resource,
): Resource {
  const graduated = record.graduation !== null;
  const { price, quantity } = positionQuantityAndPrice(
    record,
    position,
    balances,
  );
  if (price === 0n) {
    return Object.freeze({
      priceUsd1: null,
      valueUsd1: null,
      priceSource: null,
    });
  }
  return Object.freeze({
    priceUsd1: formatLaunch2Amount(price),
    valueUsd1:
      quantity === null
        ? null
        : formatLaunch2Amount((quantity * price) / launch2Wad),
    priceSource: graduated ? "pool" : "curve",
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
    getNftMetadata: fail,
    listAddressHoldings: fail,
    getOverview: fail,
    prepareNftMint: fail,
    prepareTrade: fail,
    poolQuote: fail,
    preparePoolTrade: fail,
    listPoolTrades: fail,
    listRecentPoolTrades: fail,
    getDynamicPool: fail,
    listDynamicRewards: fail,
    prepareDynamicClaim: fail,
    reportDynamicClaim: fail,
    listPublicMemes: fail,
    getPublicMeme: fail,
    listPublicMemeCandles: fail,
    listCandles: fail,
  });
}

/** Decision 0174: how long one public pool-trades answer is reused. */
export const launch2RecentPoolTradesCacheMs = 10_000;

/** Decision 0146: addresses listed in dynamic-pool currentRoundBuyers. */
const dynamicRoundBuyersLimit = 20;

export function createLaunch2Service(
  deps: Launch2ServiceDependencies,
): Launch2Service {
  const now = deps.now ?? ((): Date => new Date());
  const createUuid = deps.createUuid ?? randomUUID;
  const accounts = deps.accounts ?? createEmptyWalletAccountDirectory();
  // Decision 0166: off (default) = no `account` key and no lookup.
  const traderAccountEmit = deps.traderAccountEmit === true;
  // Decision 0173: off (default) = no `nftImageUrl` key.
  const nftImageEmit = deps.nftImageEmit === true;
  // Decision 0174: off (default) = no price / value keys on position rows.
  const positionValueEmit = deps.positionValueEmit === true;
  // Decision 0176: off (default) = no cost / PnL keys.
  const pnlEmit = deps.pnlEmit === true;
  const tradeDeadlineSeconds = BigInt(
    Math.min(
      Math.max(
        deps.tradeDeadlineSeconds ?? launch2DefaultTradeDeadlineSeconds,
        1,
      ),
      maximumDeadlineSeconds,
    ),
  );
  /**
   * Decision 0152: per-curve `maxCumulativeBuy()` (or the pre-S209
   * `MAX_CUMULATIVE_BUY()`) read from the chain — immutable, so cached for
   * the process. No chain / a failed read answers the instance's verified
   * value (the executor read the same immutable before activation).
   */
  const curveCapCache = new Map<string, bigint>();
  async function chainCurvePurchaseCap(
    record: Launch2InstanceRecord,
  ): Promise<bigint> {
    const curve = record.addresses.curve.toLowerCase();
    const cached = curveCapCache.get(curve);
    if (cached !== undefined) return cached;
    if (deps.chain === null) return curvePurchaseCapOf(record);
    try {
      const value = await deps.chain.readCurvePurchaseCap(curve);
      if (value <= 0n) return curvePurchaseCapOf(record);
      if (curveCapCache.size > 1_000) curveCapCache.clear();
      curveCapCache.set(curve, value);
      return value;
    } catch {
      return curvePurchaseCapOf(record);
    }
  }

  const balanceCacheMs = Math.min(
    Math.max(deps.balanceCacheMs ?? maximumBalanceCacheMs, 0),
    maximumBalanceCacheMs,
  );
  /** Decision 0174: (instance|limit) → the public pool trades answer. */
  const recentPoolTradesCache = new Map<
    string,
    { readonly at: number; readonly value: Resource }
  >();
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

  /** Decision 0136: one warn per failure streak of the hold query. */
  let holdReadFailing = false;

  /**
   * Decision 0136: the chain guard hold, read once per request. Null when
   * the guard is off; throws when the query fails (callers decide).
   */
  async function readTradingHold(): Promise<Launch2TradingHold | null> {
    const gate = deps.chainGuardHolds ?? null;
    if (gate === null) return null;
    try {
      const hold = launch2TradingHoldOf(await gate.holds());
      holdReadFailing = false;
      return hold;
    } catch (error) {
      if (!holdReadFailing) {
        holdReadFailing = true;
        deps.logger?.warn(
          {
            event: "launch2.chain_guard_hold_unreadable",
            reasonCode: chainGuardReasonCodes.repositoryUnavailable,
            errorClass: error instanceof Error ? error.name : typeof error,
          },
          "LOOP launch2 could not read the chain guard hold",
        );
      }
      throw error;
    }
  }

  /**
   * Decision 0136: every launch2 write path (quote / prepare) is refused
   * while a hold exists — 503 CAPABILITY_UNAVAILABLE, like
   * LAUNCH2_WRITES_DISABLED — and while the hold cannot be read (never
   * sign unguarded).
   */
  async function requireNoTradingHold(): Promise<void> {
    let hold: Launch2TradingHold | null;
    try {
      hold = await readTradingHold();
    } catch {
      return unavailableWith(chainGuardReasonCodes.repositoryUnavailable);
    }
    if (hold !== null) {
      throw V2ApiError.fromCode("CAPABILITY_UNAVAILABLE", {
        reasonCode: launch2TradingHoldReasonCodes[hold.kind],
        since: hold.since,
      });
    }
  }

  /** Decision 0136: the detail's `tradingHold`; an unreadable hold is null. */
  async function tradingHoldForView(): Promise<Launch2TradingHold | null> {
    try {
      return await readTradingHold();
    } catch {
      return null;
    }
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

  /**
   * Decision 0170: a curve quote that comes out empty only because the
   * wallet cannot pay is a balance refusal, not a stale quote. Applies when
   * the executable MAX is balance-limited and either nothing is executable
   * (balance 0, or below one smallest unit's price) or the request was
   * capped to the balance and that still prices to 0. A request smaller
   * than the balance that prices to 0 stays `LAUNCH2_QUOTE_ZERO`.
   */
  function refuseZeroForBalance(
    side: "buy" | "sell",
    state: Launch2ViewerChainState,
    numbers: QuoteNumbers,
    requested: bigint,
  ): void {
    if (numbers.max.limitedBy !== "balance") return;
    const capped = numbers.amountIn === numbers.max.amountIn;
    if (
      numbers.max.amountIn !== 0n &&
      !(numbers.expectedOut === 0n && capped)
    ) {
      return;
    }
    const balance =
      (side === "buy" ? state.usd1Balance : state.memeBalance) ?? 0n;
    refuse(
      "INSUFFICIENT_BALANCE",
      side === "buy"
        ? launch2ReasonCodes.usd1Insufficient
        : launch2ReasonCodes.memeInsufficient,
      {
        maxAmountIn: formatLaunch2Amount(balance),
        requiredAmountIn: formatLaunch2Amount(requested),
        ...(side === "buy"
          ? { balanceUsd1: formatLaunch2Amount(balance) }
          : { balanceMeme: formatLaunch2Amount(balance) }),
      },
    );
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
    // Decision 0150: chain 56 signs only with LAUNCH_MAINNET_ACK.
    if (deps.chainId === bscChainId && deps.mainnetAcknowledged !== true) {
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
   * Decision 0153: the routing of the instance's own LoopDynamic Factory.
   * Every redeploy ships a new LoopRouter / registry, so a Hook is checked
   * against the Factory that deployed it — never against the one configured
   * router. The Factory must be trusted (`dynamicFactories`); its immutable
   * `loopRouter()` / `routerRegistry()` / `loopHookDeploymentFactory()` are
   * read once per Factory (in flight shared, a failure not cached). For the
   * current Factory the chain must agree with the configuration
   * (LAUNCH2_DYNAMIC_ROUTER_ADDRESS / _REGISTRY_ADDRESS), else 503
   * LAUNCH2_DYNAMIC_ROUTER_MISMATCH: a wrong env is surfaced, not bypassed.
   */
  const dynamicRoutings = new Map<
    string,
    Promise<Launch2DynamicFactoryRouting | null>
  >();
  /** `${factory}:${launchId}:${hook}` whose `loopHook(launchId)` matched. */
  const dynamicFactoryHooks = new Set<string>();

  async function dynamicRoutingOf(
    record: Launch2InstanceRecord,
    reader: Launch2DynamicChain,
  ): Promise<Launch2DynamicFactoryRouting> {
    const factory = record.factoryAddress.toLowerCase();
    const trusted = deps.dynamicFactories ?? null;
    const current = trusted?.current?.toLowerCase() ?? null;
    if (
      trusted === null ||
      (factory !== current &&
        !trusted.legacy.some((entry) => entry.toLowerCase() === factory))
    ) {
      return unavailableWith(launch2DynamicReasonCodes.factoryUnknown);
    }
    let pending = dynamicRoutings.get(factory);
    if (pending === undefined) {
      pending = reader.readFactoryRouting(factory);
      dynamicRoutings.set(factory, pending);
      pending.catch(() => {
        if (dynamicRoutings.get(factory) === pending) {
          dynamicRoutings.delete(factory);
        }
      });
    }
    const routing = await chainRead(() => pending);
    if (routing === null) {
      return unavailableWith(launch2DynamicReasonCodes.factoryUnknown);
    }
    if (factory === current) {
      const registry = deps.dynamicRouterRegistry?.toLowerCase() ?? null;
      if (
        routing.router !== reader.router.toLowerCase() ||
        (registry !== null && routing.routerRegistry !== registry)
      ) {
        return unavailableWith(launch2DynamicReasonCodes.routerMismatch);
      }
    }
    return routing;
  }

  /**
   * Decision 0153: the instance detail's `pool.router` for a graduated
   * LoopDynamic instance — its own Factory's LoopRouter; null when the
   * Factory is untrusted / unreadable (the detail never guesses one).
   */
  async function dynamicRouterForView(
    record: Launch2InstanceRecord,
  ): Promise<string | null> {
    const reader = deps.dynamicChain ?? null;
    if (
      reader === null ||
      record.graduation === null ||
      hookKindOf(record) !== "loopDynamic"
    ) {
      return null;
    }
    try {
      return (await dynamicRoutingOf(record, reader)).router;
    } catch {
      return null;
    }
  }

  /**
   * The bound Hook of a graduated LoopDynamic instance at one block, with
   * the router / PoolManager / pool id cross-checked. Decision 0153: the
   * Hook must be its Factory's `loopHook(launchId)` (deployed through that
   * Factory's Hook deployment factory), trust **that Factory's** LoopRouter
   * and registry, share the router's PoolManager, and serve the pool the
   * lane indexed (`LoopHookBound` = `Graduated.officialPoolId`). `router`
   * is the LoopRouter the instance trades through.
   */
  async function dynamicHookAt(
    record: Launch2InstanceRecord,
    wallet: string | null,
    verifyRouter: boolean,
  ): Promise<{
    readonly chain: Launch2DynamicChain;
    readonly hook: string;
    readonly router: string;
    readonly state: Launch2DynamicHookState;
  }> {
    const bound = record.dynamicPool ?? null;
    if (bound === null) {
      return unavailableWith(launch2DynamicReasonCodes.hookNotIndexed);
    }
    const reader = dynamicChain();
    const routing = await dynamicRoutingOf(record, reader);
    const hook = bound.hook.toLowerCase();
    const factory = record.factoryAddress.toLowerCase();
    const hookKey = `${factory}:${record.launchId.toLowerCase()}:${hook}`;
    if (!dynamicFactoryHooks.has(hookKey)) {
      const deployed = await chainRead(() =>
        reader.readFactoryHook({ factory, launchId: record.launchId }),
      );
      if (deployed !== hook) {
        return unavailableWith(launch2DynamicReasonCodes.hookMismatch);
      }
      dynamicFactoryHooks.add(hookKey);
    }
    let manager: string | null = null;
    if (verifyRouter) {
      const check = await chainRead(() => reader.verifyRouter(routing.router));
      if (check.status !== "ok") return unavailableWith(check.reasonCode);
      manager = check.poolManager;
    }
    const state = await chainRead(() =>
      reader.readHookState({ hook: bound.hook, wallet }),
    );
    if (
      state.trustedRouter !== routing.router ||
      state.routerRegistry !== routing.routerRegistry ||
      (manager !== null && state.manager !== manager) ||
      state.poolId !== bound.poolId.toLowerCase() ||
      (record.graduation !== null &&
        record.graduation.poolId.toLowerCase() !== state.poolId) ||
      state.meme !== record.addresses.meme.toLowerCase()
    ) {
      return unavailableWith(launch2DynamicReasonCodes.hookMismatch);
    }
    if (!state.initialized) {
      return unavailableWith(launch2DynamicReasonCodes.hookNotInitialized);
    }
    return { chain: reader, hook, router: routing.router, state };
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
    /** Decision 0152: the token a buy is taxed in (by the Hook address). */
    readonly buyFeeToken: Launch2DynamicBuyFeeToken;
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
      router,
      state,
    } = await dynamicHookAt(record, address, true);
    const meme = record.addresses.meme.toLowerCase();
    const key = launch2PoolKey({ meme, usd1: state.quote, hook });
    // Decision 0152: the Hook address's permission bits are its generation
    // (0x10C4 = MEME buy fee, 0x10CC = USD1 buy fee); anything else is not
    // a LoopDynamic Hook this backend knows.
    const buyFeeToken = launch2DynamicBuyFeeTokenOfHook(hook);
    if (launch2PoolId(key) !== state.poolId || buyFeeToken === null) {
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
          router,
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
      if (buyFeeToken === "usd1") {
        // Decision 0152 (loop-contracts Decision 0015): an S209 Hook keeps
        // floor(amountIn × buyFeePpm / 1e6) USD1 before the pool swaps
        // amountIn − fee; the MEME output (the simulation's) is untaxed.
        baseFee = launch2DynamicUsd1BuySplit(amountIn, state.buyFeePpm).fee;
      } else {
        // S165: the buy fee is taken from the MEME output (gross − fee = net).
        const gross = launch2DynamicGrossOfNet(expectedOut, state.buyFeePpm);
        baseFee = gross - expectedOut;
      }
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
      taxToken: request.side === "buy" ? buyFeeToken : "usd1",
      taxUsd1: formatLaunch2Amount(
        request.side === "sell" || buyFeeToken === "usd1" ? tax : 0n,
      ),
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
      // Decision 0153: the instance's own Factory's LoopRouter.
      router,
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
        // Decision 0152: the token baseTaxAmount is in (sell: USD1).
        baseTaxToken: request.side === "buy" ? buyFeeToken : "usd1",
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
      router,
      numbers,
      buyFeeToken,
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
          buyFeeToken,
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
          // Decision 0165: a USD1-taxed buy (buyFeeToken = usd1, loop-
          // contracts Decision 0015 §3) carries the quote's USD1 fee, the
          // same figure as the quote's `taxUsd1`; a MEME-taxed buy has none.
          tax:
            body.side === "sell" || buyFeeToken === "usd1" ? numbers.tax : 0n,
          refund: 0n,
          valueUsd: body.side === "buy" ? numbers.maxIn : numbers.expectedOut,
          deadline: numbers.deadline,
          gasHint: fallbackGas[kind],
          verifiedRouter: router,
          simulate: async (approvalPending) => {
            const simulated = await reader.simulateSwap({
              blockNumber: state.blockNumber,
              from: address,
              router,
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
        buyFeeToken: null,
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
        maxDynamicFeeWad: null,
        maxDynamicFeeBps: null,
        currentDynamicTaxBps: null,
        roundCloseRule: null,
        armedAfterRoll: null,
        potUsd1: null,
        carryUsd1: null,
        roundExtraFeesUsd1: null,
        roundTotalBuyWeightUsd1: null,
        currentRoundBuyers: null,
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

  // -------------------------------------------------------------------------
  // Decision 0147: the public MEME page read surface (no principal)
  // -------------------------------------------------------------------------

  /**
   * S207: once the route's time budget is spent, stop before the next
   * chain / database read (the route has already answered 503
   * PUBLIC_UPSTREAM_TIMEOUT to every waiter).
   */
  function publicStopIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
      unavailableWith(launch2PublicReasonCodes.upstreamTimeout);
    }
  }

  function publicInvalid(reasonCode: string): never {
    throw V2ApiError.fromCode("INVALID_REQUEST", { reasonCode });
  }

  function publicLimit(value: unknown, fallback: number, maximum: number) {
    if (value === undefined) return fallback;
    const parsed =
      typeof value === "string" && /^[1-9][0-9]{0,3}$/u.test(value)
        ? Number(value)
        : typeof value === "number"
          ? value
          : Number.NaN;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
      publicInvalid(launch2PublicReasonCodes.limitInvalid);
    }
    return parsed;
  }

  async function publicFactsOf(
    instanceIds: readonly string[],
  ): Promise<ReadonlyMap<string, Launch2PublicMemeFacts>> {
    const store = repository();
    if (store.getPublicMemeFacts === undefined) {
      return unavailableWith(launch2ReasonCodes.repositoryUnavailable);
    }
    const since = new Date(now().getTime() - 86_400_000).toISOString();
    const rows = await store
      .getPublicMemeFacts({ instanceIds, since })
      .catch(translate);
    const byId = new Map(rows.map((row) => [row.instanceId, row]));
    for (const id of instanceIds) {
      if (!byId.has(id)) {
        return unavailableWith(launch2ReasonCodes.repositoryUnavailable);
      }
    }
    return byId;
  }

  /** The indexed last price: the pool's last swap once graduated, else the curve. */
  function publicLastPriceE18(record: Launch2InstanceRecord): bigint {
    if (record.graduation !== null && record.pool.lastPriceE18 !== null) {
      return BigInt(record.pool.lastPriceE18);
    }
    return BigInt(record.priceE18);
  }

  function publicHookAddress(record: Launch2InstanceRecord): string | null {
    if (hookKindOf(record) === "loopDynamic") {
      return record.dynamicPool?.hook.toLowerCase() ?? null;
    }
    return record.addresses.hook.toLowerCase();
  }

  function publicLiveDynamic(record: Launch2InstanceRecord): boolean {
    return hookKindOf(record) === "loopDynamic" && record.graduation !== null;
  }

  function publicTaxBps(state: Launch2DynamicHookState): number {
    return launch2DynamicWadBps(
      launch2DynamicEffectiveRateWad(
        state.currentDropWad,
        state.maxDynamicFeeWad,
      ),
    );
  }

  async function listPublicMemes(input: {
    readonly stage?: unknown;
    readonly limit?: unknown;
    readonly signal?: AbortSignal;
  }): Promise<Resource> {
    const filter =
      input.stage === undefined
        ? "all"
        : typeof input.stage === "string" &&
            (launch2PublicStageFilters as readonly string[]).includes(
              input.stage,
            )
          ? (input.stage as Launch2PublicStageFilter)
          : publicInvalid(launch2PublicReasonCodes.stageInvalid);
    const limit = publicLimit(
      input.limit,
      launch2PublicListDefaultLimit,
      launch2PublicListMaximumLimit,
    );
    const records = await repository()
      .listInstances({
        chainId: deps.chainId,
        stage: filter === "graduated" ? "graduated" : null,
        notStage: filter === "curve" ? "graduated" : null,
        after: null,
        limit,
      })
      .catch(translate);
    // The stored stage can lag the clock; the derived one decides.
    const at = nowSeconds();
    const rows = records.filter((record) => {
      const stage = stageOf(record, at).stage;
      return filter === "all"
        ? true
        : filter === "graduated"
          ? stage === "graduated"
          : stage !== "graduated";
    });
    const facts = await publicFactsOf(rows.map((row) => row.instanceId));
    // Live LoopDynamic Hook reads, four at a time. A row whose Hook read
    // is unavailable (503) keeps `dynamic: null` and names the reason in
    // `dynamicReasonCode` — never a guessed state; the detail stays 503.
    const dynamics = new Map<string, Launch2DynamicHookState | string>();
    const live = rows.filter(publicLiveDynamic);
    for (let index = 0; index < live.length; index += 4) {
      publicStopIfAborted(input.signal);
      const reads = await Promise.all(
        live.slice(index, index + 4).map(async (record) => {
          try {
            const read = await dynamicHookAt(record, null, true);
            return { instanceId: record.instanceId, state: read.state };
          } catch (error) {
            const reason =
              error instanceof V2ApiError && error.statusCode === 503
                ? error.detailsSafe?.["reasonCode"]
                : undefined;
            if (typeof reason !== "string") throw error;
            return { instanceId: record.instanceId, state: reason };
          }
        }),
      );
      for (const read of reads) dynamics.set(read.instanceId, read.state);
    }
    return Object.freeze({
      items: rows.map((record) => {
        const read = dynamics.get(record.instanceId) ?? null;
        const state = typeof read === "string" ? null : read;
        return Object.freeze({
          instanceId: record.instanceId,
          name: record.name,
          symbol: record.ticker,
          logoUrl: record.logoUrl,
          stage: stageOf(record, at).stage,
          memeTokenAddress: record.addresses.meme.toLowerCase(),
          communityName: facts.get(record.instanceId)?.community?.name ?? null,
          lastPriceUsd1: formatLaunch2Amount(publicLastPriceE18(record)),
          dynamic:
            state === null
              ? null
              : Object.freeze({
                  armed: state.armed,
                  currentDynamicTaxBps: publicTaxBps(state),
                }),
          dynamicReasonCode: typeof read === "string" ? read : null,
        });
      }),
      generatedAt: now().toISOString(),
    });
  }

  async function getPublicMeme(input: {
    readonly instanceId: string;
    readonly signal?: AbortSignal;
  }): Promise<Resource> {
    const record = await visibleInstance(input.instanceId);
    const hookKind = hookKindOf(record);
    const at = nowSeconds();
    const facts = (await publicFactsOf([record.instanceId])).get(
      record.instanceId,
    ) as Launch2PublicMemeFacts;
    publicStopIfAborted(input.signal);
    const dynamicRead = publicLiveDynamic(record)
      ? await dynamicPoolRead(record, hookKind, null)
      : null;
    const summary =
      dynamicRead !== null
        ? dynamicRead.summary
        : hookKind === "loopDynamic"
          ? await repository()
              .dynamicRoundSummary(record.instanceId)
              .catch(translate)
          : null;
    const profile = record.projectProfile;
    const description =
      typeof profile?.description === "string" &&
      profile.description.trim().length > 0
        ? profile.description.trim()
        : null;
    const lastPrice = publicLastPriceE18(record);
    const referencePrice =
      record.graduation !== null
        ? facts.poolReferencePriceE18 === null
          ? null
          : BigInt(facts.poolReferencePriceE18)
        : launch2PublicCurvePriceAt(BigInt(facts.curveSoldAtSince));
    const priceAsOf =
      record.graduation !== null && record.pool.lastTradeAt !== null
        ? record.pool.lastTradeAt
        : record.projectedAt;
    const curveTax = BigInt(facts.curveTaxUsd1);
    const buyFeeMeme =
      summary !== null
        ? BigInt(summary.buyFeesMeme)
        : BigInt(facts.poolTaxMeme);
    // Decision 0152: S209 Hooks charge the buy fee in USD1 (the summary
    // splits Hook buy fees by token; OfficialTax buys are MEME-taxed).
    const buyFeeUsd1 = summary !== null ? BigInt(summary.buyFeesUsd1) : 0n;
    const baseSellFee =
      summary !== null
        ? BigInt(summary.baseSellFeesUsd1)
        : BigInt(facts.poolTaxUsd1);
    const dynamicFees = summary !== null ? BigInt(summary.extraFeesUsd1) : 0n;
    const totalTax = launch2PublicTotalTaxUsd1({
      usd1Parts: [curveTax, baseSellFee, buyFeeUsd1, dynamicFees],
      memeFee: buyFeeMeme,
      priceE18: lastPrice > 0n ? lastPrice : null,
    });
    const buyback = buybackSummaryOf(record, null);
    const curveCap = await chainCurvePurchaseCap(record);
    let dynamic: Resource | null = null;
    if (dynamicRead !== null) {
      const { state, armedRound, buyers } = dynamicRead;
      const round = state.currentRound;
      const roundExtra = state.armed && round !== null ? round.extraFees : 0n;
      const last = facts.lastClosedRound;
      dynamic = Object.freeze({
        hookKind: "loopDynamic",
        armed: state.armed,
        currentRound:
          armedRound === null || round === null
            ? null
            : Object.freeze({
                roundId: armedRound,
                startCandle: round.startCandle.toString(10),
                // The current 5-minute candle's open: the round closes at
                // the first candle that closes at or above its open
                // (Decision 0144).
                openPriceUsd1: formatLaunch2Amount(
                  launch2PoolPriceE18(
                    state.candleOpenSqrtPriceX96,
                    state.memeIsCurrency0,
                  ),
                ),
                buyerCount: buyers?.buyerCount ?? 0,
                totalBuyWeightUsd1: formatLaunch2Amount(round.totalBuyWeight),
              }),
        currentDynamicTaxBps: publicTaxBps(state),
        maxDynamicFeeBps: launch2DynamicWadBps(state.maxDynamicFeeWad),
        baseBuyFeeBps: launch2DynamicBps(state.buyFeePpm),
        // Decision 0152: usd1 = an S209 Hook (fee from the USD1 input).
        buyFeeToken:
          launch2DynamicBuyFeeTokenOfHook(publicHookAddress(record) ?? "") ??
          "meme",
        baseSellFeeBps: launch2DynamicBps(state.baseSellFeePpm),
        pendingPotUsd1: formatLaunch2Amount(state.carry + roundExtra),
        carryUsd1: formatLaunch2Amount(state.carry),
        currentRoundDynamicFeesUsd1: formatLaunch2Amount(roundExtra),
        roundCloseRule: state.roundCloseRule,
        lastClosedRound:
          last === null
            ? null
            : Object.freeze({
                roundId: last.roundId,
                closedAt: last.closedAt,
                allocationUsd1: formatLaunch2Amount(
                  BigInt(last.allocationUsd1),
                ),
                buyerCount: last.buyerCount,
              }),
        asOfBlock: state.blockNumber.toString(10),
      });
    }
    const community = facts.community;
    return Object.freeze({
      instance: Object.freeze({
        instanceId: record.instanceId,
        name: record.name,
        symbol: record.ticker,
        logoUrl: record.logoUrl,
        description,
        stage: stageOf(record, at).stage,
        graduatedAt: record.graduation?.graduatedAt ?? null,
        createdAt: record.activatedAt ?? record.registeredAt,
        memeTokenAddress: record.addresses.meme.toLowerCase(),
        hookAddress: publicHookAddress(record),
        poolId: record.graduation?.poolId.toLowerCase() ?? null,
        escrowAddress: record.addresses.escrow.toLowerCase(),
        perAddressCurveCapMeme: formatLaunch2Amount(curveCap),
        chainId: record.chainId,
        explorerBaseUrl: launch2PublicExplorerBaseUrl(record.chainId),
        socials: launch2PublicSocials(
          launch2ProjectProfileProjection(profile).links,
        ),
        listing: record.listing,
      }),
      community:
        community === null
          ? null
          : Object.freeze({
              communityId: community.communityId,
              name: community.name,
              slogan: launch2PublicSlogan(community.description),
              description: community.description,
              memberCount: community.memberCount,
              verified: community.verified,
              // Community logos are App presets or authenticated media.
              avatarUrl: null,
            }),
      price: Object.freeze({
        lastPriceUsd1: formatLaunch2Amount(lastPrice),
        change24hPct: launch2PublicChangePct(lastPrice, referencePrice),
        asOf: priceAsOf,
      }),
      dynamic,
      totals: Object.freeze({
        curveTaxUsd1: formatLaunch2Amount(curveTax),
        poolBaseBuyFeeMeme: formatLaunch2Amount(buyFeeMeme),
        poolBaseBuyFeeUsd1: formatLaunch2Amount(buyFeeUsd1),
        poolBaseSellFeeUsd1: formatLaunch2Amount(baseSellFee),
        dynamicFeesUsd1: formatLaunch2Amount(dynamicFees),
        totalTaxUsd1Equivalent:
          totalTax === null ? null : formatLaunch2Amount(totalTax),
        rewardsAllocatedUsd1: formatLaunch2Amount(
          summary === null ? 0n : BigInt(summary.allocatedUsd1),
        ),
        rewardsClaimedUsd1: formatLaunch2Amount(
          summary === null ? 0n : BigInt(summary.claimedUsd1),
        ),
        buyback: Object.freeze({
          executedCount: Number(record.buyback.count),
          spentUsd1: buyback["totalUsd1"],
          boughtMeme: buyback["totalMeme"],
          escrowRemainingUsd1: buyback["escrowAvailableUsd1"],
          recipientAddress: record.buybackRecipient.toLowerCase(),
          lastAt: record.buyback.lastAt,
        }),
      }),
      generatedAt: now().toISOString(),
    });
  }

  async function listPublicMemeCandles(input: {
    readonly instanceId: string;
    readonly interval?: unknown;
    readonly limit?: unknown;
    readonly signal?: AbortSignal;
  }): Promise<Resource> {
    if (
      input.interval !== undefined &&
      !(launch2PublicCandleIntervals as readonly unknown[]).includes(
        input.interval,
      )
    ) {
      publicInvalid(launch2PublicReasonCodes.intervalUnsupported);
    }
    const limit = publicLimit(
      input.limit,
      launch2PublicCandleMaximumLimit,
      launch2PublicCandleMaximumLimit,
    );
    const record = await visibleInstance(input.instanceId);
    const store = repository();
    if (store.listPublicCandles === undefined) {
      return unavailableWith(launch2ReasonCodes.repositoryUnavailable);
    }
    const graduated = record.graduation !== null;
    const read = (kind: "curve" | "pool" | "dynamic") =>
      store.listPublicCandles!({
        instanceId: record.instanceId,
        source: { kind },
        limit,
      }).catch(translate);
    let rows = await read(
      !graduated
        ? "curve"
        : hookKindOf(record) === "loopDynamic"
          ? "dynamic"
          : "pool",
    );
    // A LoopDynamic pool with no orientation fact (no indexed swap) or no
    // closed Hook candle yet falls back to the indexed swaps.
    if (
      graduated &&
      rows.length === 0 &&
      hookKindOf(record) === "loopDynamic"
    ) {
      publicStopIfAborted(input.signal);
      rows = await read("pool");
    }
    return Object.freeze({
      interval: "5m",
      source: graduated ? "pool" : "curve",
      candles: rows.map((row) =>
        Object.freeze({
          t: row.openTime,
          o: formatLaunch2Amount(BigInt(row.openE18)),
          h: formatLaunch2Amount(BigInt(row.highE18)),
          l: formatLaunch2Amount(BigInt(row.lowE18)),
          c: formatLaunch2Amount(BigInt(row.closeE18)),
          v:
            row.volumeUsd1 === null
              ? null
              : formatLaunch2Amount(BigInt(row.volumeUsd1)),
        }),
      ),
      generatedAt: now().toISOString(),
    });
  }

  /**
   * Decision 0131 / 0146 / 0147: the bound Hook at one block plus the
   * indexed round summary and the armed round's buyers — shared by the
   * App's dynamic-pool read and the public MEME page. Every dependency 503
   * names the instance's Hook kind (Decision 0132).
   */
  async function dynamicPoolRead(
    record: Launch2InstanceRecord,
    hookKind: Launch2PoolHookKind,
    wallet: AccountWalletRecord | null,
  ) {
    const withHookKind = (error: unknown): never => {
      if (error instanceof V2ApiError && error.statusCode === 503) {
        throw new V2ApiError({
          statusCode: error.statusCode,
          code: error.code,
          category: error.category,
          retryable: error.retryable,
          userMessageKey: error.userMessageKey,
          includeBearerChallenge: error.includeBearerChallenge,
          detailsSafe: { ...(error.detailsSafe ?? {}), hookKind },
        });
      }
      throw error;
    };
    const { hook, router, state } = await dynamicHookAt(
      record,
      wallet === null ? null : wallet.address.toLowerCase(),
      true,
    ).catch(withHookKind);
    const summary = await repository()
      .dynamicRoundSummary(record.instanceId)
      .catch(translate)
      .catch(withHookKind);
    // Decision 0146: the armed round's addresses by merged weight
    // (BuyCredited + CreditMoved in − out) and the viewer's indexed weight,
    // reconciled with the chain's buyWeight(round, wallet).
    const armedRound =
      state.armed && state.currentRoundId > 0n
        ? state.currentRoundId.toString(10)
        : null;
    const buyers =
      armedRound === null
        ? null
        : await repository()
            .listDynamicRoundBuyers({
              instanceId: record.instanceId,
              roundId: armedRound,
              limit: dynamicRoundBuyersLimit,
            })
            .catch(translate)
            .catch(withHookKind);
    const indexedViewerWeight =
      armedRound === null || wallet === null || state.wallet === null
        ? null
        : BigInt(
            await repository()
              .getDynamicBuyWeight({
                instanceId: record.instanceId,
                roundId: armedRound,
                address: wallet.address.toLowerCase(),
              })
              .catch(translate)
              .catch(withHookKind),
          );
    return {
      router,
      hook,
      state,
      summary,
      armedRound,
      buyers,
      indexedViewerWeight,
    };
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
    // Decision 0132 (S168b follow-up): every dependency 503 after the
    // registry read names the instance's Hook kind (`pool_hook_kind`, a
    // database fact), so an App whose first read fails still knows to
    // draw the LoopDynamic panel (exactIn only), never the OfficialTax one.
    const wallet = await walletFor(input.principal, input.walletId, false);
    const {
      router,
      hook,
      state,
      summary,
      armedRound,
      buyers,
      indexedViewerWeight,
    } = await dynamicPoolRead(record, hookKind, wallet);
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
        // Decision 0153: the instance's own Factory's LoopRouter.
        router,
        routerRegistry:
          state.routerRegistry === "0x0000000000000000000000000000000000000000"
            ? null
            : state.routerRegistry,
        routingPolicy: launch2DynamicRoutingPolicy(state.routingPolicy),
        priceTiming: launch2DynamicPriceTiming(state.priceTiming),
        buyTaxBps: launch2DynamicBps(state.buyFeePpm),
        // Decision 0152: the Hook generation (address permission bits).
        buyFeeToken: launch2DynamicBuyFeeTokenOfHook(hook),
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
        currentDropBps: launch2DynamicWadBps(state.currentDropWad),
        // Decision 0144: the cap and the rate a sell at the current price
        // pays (min(drop, cap); PRE_SWAP exact, POST_SWAP before the trade).
        maxDynamicFeeWad: formatLaunch2Amount(state.maxDynamicFeeWad),
        maxDynamicFeeBps: launch2DynamicWadBps(state.maxDynamicFeeWad),
        currentDynamicTaxBps: launch2DynamicWadBps(
          launch2DynamicEffectiveRateWad(
            state.currentDropWad,
            state.maxDynamicFeeWad,
          ),
        ),
        roundCloseRule: state.roundCloseRule,
        // Decision 0144 (loop-contracts 0013 §7.3): armed() is stale until
        // the next swap / poke settles; this is the state after that roll.
        armedAfterRoll: roll.armed,
        potUsd1: formatLaunch2Amount(state.carry + roundExtra),
        carryUsd1: formatLaunch2Amount(state.carry),
        roundExtraFeesUsd1: formatLaunch2Amount(roundExtra),
        roundTotalBuyWeightUsd1: formatLaunch2Amount(roundWeight),
        currentRoundBuyers:
          buyers === null || armedRound === null
            ? null
            : Object.freeze({
                roundId: armedRound,
                buyerCount: buyers.buyerCount,
                buyers: buyers.buyers.map((buyer) =>
                  Object.freeze({
                    address: buyer.address,
                    weightUsd1: formatLaunch2Amount(BigInt(buyer.weightUsd1)),
                    creditedUsd1: formatLaunch2Amount(
                      BigInt(buyer.creditedUsd1),
                    ),
                    movedInUsd1: formatLaunch2Amount(BigInt(buyer.movedInUsd1)),
                    movedOutUsd1: formatLaunch2Amount(
                      BigInt(buyer.movedOutUsd1),
                    ),
                    creditCount: buyer.creditCount,
                    attributions: buyer.attributions,
                    lastCreditedAt: buyer.lastCreditedAt,
                  }),
                ),
              }),
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
                // Decision 0146: the projection's merged weight and whether
                // it equals the chain's buyWeight at basis (false while
                // the index lags the basis block, or on a divergence).
                indexedCurrentRoundWeightUsd1:
                  indexedViewerWeight === null
                    ? null
                    : formatLaunch2Amount(indexedViewerWeight),
                weightReconciled:
                  indexedViewerWeight === null
                    ? null
                    : indexedViewerWeight === state.wallet.currentRoundWeight,
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
          buyFeesUsd1: formatLaunch2Amount(BigInt(summary.buyFeesUsd1)),
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
        // Decision 0146: weight = credited + movedIn − movedOut.
        creditedUsd1: formatLaunch2Amount(BigInt(row.creditedUsd1)),
        movedInUsd1: formatLaunch2Amount(BigInt(row.movedInUsd1)),
        movedOutUsd1: formatLaunch2Amount(BigInt(row.movedOutUsd1)),
        credits: row.entries.map((entry) =>
          Object.freeze({
            direction: entry.direction,
            attribution: entry.attribution,
            counterparty: entry.counterparty,
            amountUsd1: formatLaunch2Amount(BigInt(entry.amountUsd1)),
            transactionHash: entry.transactionHash,
            logIndex: entry.logIndex,
            creditedAt: entry.creditedAt,
          }),
        ),
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
    await requireNoTradingHold();
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
      await requireNoTradingHold();
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
      await requireNoTradingHold();
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
    listPublicMemes,
    getPublicMeme,
    listPublicMemeCandles,

    async listCandles(input) {
      // Decision 0171: query rules first (422), then the detail's 404 / 503.
      const query = parseLaunch2CandleQuery(input);
      const record = await visibleInstance(input.instanceId);
      const store = repository();
      if (
        store.readCandleBounds === undefined ||
        store.readCandleWindow === undefined
      ) {
        return unavailableWith(launch2ReasonCodes.repositoryUnavailable);
      }
      return readLaunch2Candles({
        instanceId: record.instanceId,
        graduated: record.graduation !== null,
        activatedAt: record.activatedAt,
        store: {
          readCandleBounds: store.readCandleBounds.bind(store),
          readCandleWindow: store.readCandleWindow.bind(store),
        },
        query,
        now: now(),
      }).catch(translate);
    },

    async listPoolTrades(input) {
      const record = await visibleInstance(input.instanceId);
      const store = repository();
      if (input.walletId === undefined) throw V2ApiError.invalidRequest();
      const limit = parseLimit(input.limit, 20, 50);
      const wallet = await walletFor(input.principal, input.walletId, true);
      if (wallet === null) throw V2ApiError.notFound();
      const address = wallet.address.toLowerCase();
      const own = traderAccountEmit
        ? ((await accounts.resolve([address], input.principal.userId)).get(
            address,
          ) ?? null)
        : undefined;
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
        trades: rows.map((row) => poolTradeOf(row, own)),
        contractVersion: v2ContractVersion,
      });
    },

    async listRecentPoolTrades(input) {
      const limit = parseLimit(input.limit, 20, 50);
      // Decision 0174: one answer per (instance, limit) for 10 s; only
      // successes are kept, so an unknown id never enters the cache.
      const cacheKey = `${input.instanceId}|${String(limit)}`;
      const nowMs = now().getTime();
      const cached = recentPoolTradesCache.get(cacheKey);
      if (
        cached !== undefined &&
        nowMs - cached.at < launch2RecentPoolTradesCacheMs
      ) {
        return cached.value;
      }
      const record = await visibleInstance(input.instanceId);
      const rows =
        record.graduation === null
          ? []
          : await repository()
              .listRecentPoolTrades({ instanceId: record.instanceId, limit })
              .catch(translate);
      const value = Object.freeze({
        instanceId: record.instanceId,
        items: rows.map(publicPoolTradeOf),
        observedAt: now().toISOString(),
        contractVersion: v2ContractVersion,
      });
      if (recentPoolTradesCache.size > 500) recentPoolTradesCache.clear();
      recentPoolTradesCache.set(cacheKey, { at: nowMs, value });
      return value;
    },

    async getOverview(input) {
      const store = repository();
      const [activity, facts] = await Promise.all([
        store.listActivity({
          chainId: deps.chainId,
          limit: launch2OverviewActivityLimit,
        }),
        store.listOverviewFacts({ chainId: deps.chainId }),
      ]).catch(translate);
      const actorAccounts = traderAccountEmit
        ? await accounts.resolve(
            activity.flatMap((row) => (row.actor === null ? [] : [row.actor])),
            input.principal.userId,
          )
        : null;
      return projectLaunch2Overview({
        activity,
        facts,
        now: now(),
        accounts: actorAccounts,
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
        instances: page.map((row) => summaryOf(row, at, nftImageEmit)),
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
      const [
        latest,
        trades,
        positions,
        member,
        poolStats,
        balances,
        tradingHold,
        dynamicRouter,
        costTrades,
      ] = await Promise.all([
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
        tradingHoldForView(),
        dynamicRouterForView(record),
        // Decision 0176: the viewer's trades (one read), only when emitted.
        !pnlEmit || wallet === null
          ? Promise.resolve([] as readonly Launch2CostTradeRecord[])
          : store
              .listCostTrades({
                holderAddresses: [wallet.address],
                instanceId: record.instanceId,
              })
              .catch(translate),
      ]);
      // Decision 0162: one batched (cached) lookup for the 20 traders.
      // Decision 0166: skipped (and no key) while the emit gate is off.
      const traderAccounts = traderAccountEmit
        ? await accounts.resolve(
            trades.map((trade) => trade.traderAddress),
            input.principal.userId,
          )
        : null;
      const stage = stageOf(record, at);
      const position = positions[0] ?? null;
      const snapshot = record.snapshot;
      const graduation = record.graduation;
      return Object.freeze({
        instance: Object.freeze({
          ...summaryOf(record, at, nftImageEmit),
          viewerIsProjectOwner: record.ownerUserId === input.principal.userId,
          projectOwnerAddress: record.projectOwner,
          configVersion: record.configVersion,
          configHash: record.configHash,
          buybackRecipient: record.buybackRecipient,
          template: launch2TemplateProjection(
            Number(seconds(record.nftSaleEnd) - seconds(record.nftSaleStart)),
            curvePurchaseCapOf(record),
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
                  // S171: a LoopDynamic instance deploys its Hook at graduation; report the bound one.
                  hookAddress:
                    hookKindOf(record) === "loopDynamic"
                      ? (record.dynamicPool?.hook ?? record.addresses.hook)
                      : record.addresses.hook,
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
                  // S171: LoopDynamic pools trade through the LoopRouter, not the OfficialPoolRouter.
                  router:
                    hookKindOf(record) === "loopDynamic"
                      ? dynamicRouter
                      : (deps.poolChain?.router ?? null),
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
          recentTrades: trades.map((trade) => tradeOf(trade, traderAccounts)),
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
                  curve: positionCurveOf(position, curvePurchaseCapOf(record)),
                  ...balances,
                  ...poolTradeStatsOf(poolStats[0]),
                  ...(pnlEmit
                    ? positionPnlOf(record, position, balances, costTrades)
                    : {}),
                }),
          tradingHold,
          projectedAt: record.projectedAt,
        }),
        contractVersion: v2ContractVersion,
      });
    },

    async quote(input) {
      const record = await visibleInstance(input.instanceId);
      await requireNoTradingHold();
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
        refuseZeroForBalance(side, state, numbers, amount);
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
      // Decision 0152: the curve's own cap at the quote block.
      const cap = state.curve.maxCumulativeBuy ?? launch2Template.perAddressCap;
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
      // Decision 0174: every instance (and so every price) in one read.
      const instances = new Map<string, Launch2InstanceRecord>(
        positions.length === 0
          ? []
          : (
              await store
                .getInstances([
                  ...new Set(positions.map((position) => position.instanceId)),
                ])
                .catch(translate)
            ).map((record) => [record.instanceId, record] as const),
      );
      const at = nowSeconds();
      const stats = await store
        .poolTradeStats({
          instanceId: null,
          walletAddresses: [...byAddress.keys()],
        })
        .catch(translate);
      // Decision 0176: every trade of the wallets in one read, replayed in
      // memory per (instance, wallet).
      const costTradesOf = new Map<string, Launch2CostTradeRecord[]>();
      if (pnlEmit && positions.length > 0) {
        const costTrades = await store
          .listCostTrades({
            holderAddresses: [...byAddress.keys()],
            instanceId: null,
          })
          .catch(translate);
        for (const trade of costTrades) {
          const key = `${trade.instanceId}|${trade.holderAddress}`;
          const list = costTradesOf.get(key) ?? [];
          list.push(trade);
          costTradesOf.set(key, list);
        }
      }
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
          const balances = balancesOf.get(key) ?? notGraduatedBalances;
          return [
            Object.freeze({
              instanceId: record.instanceId,
              name: record.name,
              ticker: record.ticker,
              logoUrl: record.logoUrl,
              ...(nftImageEmit ? { nftImageUrl: record.nftImageUrl } : {}),
              memeAddress: record.addresses.meme,
              stage: stageOf(record, at).stage,
              walletId: wallet.walletId,
              nft: Object.freeze({
                mintedTokenId: position.nftMintedTokenId,
                held: position.nftHeld,
              }),
              snapshotMember: position.snapshotMember,
              curve: positionCurveOf(position, curvePurchaseCapOf(record)),
              lastActivityAt: position.lastActivityAt,
              ...balances,
              ...poolTradeStatsOf(statsOf.get(key)),
              ...(positionValueEmit
                ? positionValueOf(record, position, balances)
                : {}),
              ...(pnlEmit
                ? positionPnlOf(
                    record,
                    position,
                    balances,
                    costTradesOf.get(key) ?? [],
                  )
                : {}),
            }),
          ];
        }),
        contractVersion: v2ContractVersion,
      });
    },

    async getNftMetadata(input) {
      if (
        !new RegExp(launch2NftLaunchIdPatternSource).test(input.launchId) ||
        !new RegExp(launch2NftTokenIdPatternSource).test(input.tokenId)
      ) {
        throw V2ApiError.notFound();
      }
      const record = await repository()
        .getInstanceByLaunchId(input.launchId.toLowerCase())
        .catch(translate);
      if (
        record === null ||
        record.chainId !== deps.chainId ||
        (record.activatedAt === null && record.holdReason === null)
      ) {
        throw V2ApiError.fromCode("NOT_FOUND", {
          reasonCode: launch2ReasonCodes.instanceNotFound,
        });
      }
      const tokenId = Number(input.tokenId);
      if (BigInt(input.tokenId) > BigInt(record.nftMintedCount)) {
        throw V2ApiError.fromCode("NOT_FOUND", {
          reasonCode: launch2ReasonCodes.nftNotMinted,
        });
      }
      return launch2NftMetadataOf(
        record,
        tokenId,
        stageOf(record, nowSeconds()).stage,
      );
    },

    async listAddressHoldings(input) {
      const store = repository();
      const address = input.address.toLowerCase();
      const positions = await store
        .listPositions({ holderAddresses: [address], instanceId: null })
        .catch(translate);
      const at = nowSeconds();
      const rows: Launch2AddressHolding[] = [];
      for (const position of positions) {
        const record = await store
          .getInstance(position.instanceId)
          .catch(translate);
        if (record === null || record.chainId !== deps.chainId) continue;
        let memeRaw: bigint | null;
        if (record.graduation === null) {
          const bought = BigInt(position.curveBought);
          const sold = BigInt(position.curveSold);
          memeRaw = bought > sold ? bought - sold : 0n;
        } else {
          const balances = await walletBalancesOf(record, address);
          const meme = balances["memeBalance"];
          memeRaw =
            balances["balanceStatus"] === "available" &&
            typeof meme === "string"
              ? parseLaunch2Amount(meme)
              : null;
        }
        rows.push(
          Object.freeze({
            instanceId: record.instanceId,
            chainId: record.chainId,
            ticker: record.ticker,
            name: record.name,
            logoUrl: record.logoUrl,
            stage: stageOf(record, at).stage,
            nftHeld: position.nftHeld,
            memeRaw,
            priceE18: publicLastPriceE18(record),
          }),
        );
      }
      return Object.freeze(rows);
    },

    async prepareNftMint(input) {
      const writes = writesOrUnavailable();
      const body = parseWalletBody(input.body);
      const record = await visibleInstance(input.instanceId);
      await requireNoTradingHold();
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
      await requireNoTradingHold();
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
          if (numbers.max.amountIn === 0n || numbers.expectedOut === 0n) {
            refuseZeroForBalance(body.side, state, numbers, body.amount);
          }
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
