import { mediaAbsoluteUrl } from "../media/media-contract.js";
import {
  bscTestnetChainId,
  type LaunchChainId,
} from "../chain/chain-contract.js";
import {
  formatE18,
  memeBps,
  memeE18,
  memeGraduationUsd1Estimate,
  memeMarketCapRaw,
  memeMinBuyUsd1,
  memePoolSupply,
  memePriceE18,
  memeProgressBps,
  memeSaleSupply,
  memeTotalSupply,
  memeTradeFeeBps,
  memeV0,
  memeT0,
  memeWalletCap,
} from "./meme-curve-math.js";
import { memeReasonCodes } from "./meme-contract.js";
import type {
  MemeCreatorProjection,
  MemeTokenListRecord,
  MemeTokenRecord,
} from "./meme-repository.js";

/**
 * Wire projections of the MEME launchpad (Decision 0101). Raw amounts are
 * 18-decimal base-unit integer strings; prices, market caps, and volumes
 * are decimal strings in USD1 (USD1 counted at par, the Launch rule);
 * percentages are decimal strings with two decimals.
 */

/**
 * The quote of a graduated token (decimal strings): DexScreener (USD), or
 * Decision 0103's `pool_slot0` read of its own pool (USD1 at par).
 */
export interface MemeDexQuote {
  readonly priceUsd: string;
  readonly marketCapUsd: string | null;
  readonly observedAt: string;
  /** Absent = `dexscreener`. */
  readonly source?: "dexscreener" | "pool_slot0";
}

export type MemeDexQuoteReader = (
  chainId: LaunchChainId,
  tokenAddresses: readonly string[],
) => Promise<
  ReadonlyMap<string, MemeDexQuote | { readonly reasonCode: string }>
>;

export function explorerBaseFor(chainId: LaunchChainId): string {
  return chainId === bscTestnetChainId
    ? "https://testnet.bscscan.com"
    : "https://bscscan.com";
}

function creatorProjection(
  creator: MemeCreatorProjection,
): MemeCreatorProjection | null {
  return creator.publicProfileId === null
    ? null
    : Object.freeze({
        publicProfileId: creator.publicProfileId,
        displayName: creator.displayName,
        avatarRef: creator.avatarRef,
      });
}

/** Signed percentage with two decimals, truncated toward zero. */
export function percentChange(nowE18: bigint, thenE18: bigint): string | null {
  if (thenE18 <= 0n) {
    return null;
  }
  const hundredths = ((nowE18 - thenE18) * 10_000n) / thenE18;
  const negative = hundredths < 0n;
  const absolute = negative ? -hundredths : hundredths;
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString(10).padStart(2, "0");
  return `${negative ? "-" : ""}${whole.toString(10)}.${fraction}`;
}

const initialPriceE18 = (memeV0 * memeE18) / memeT0;

export function curveOf(record: MemeTokenRecord): {
  readonly vUsd1: bigint;
  readonly vToken: bigint;
} {
  return { vUsd1: BigInt(record.vUsd1), vToken: BigInt(record.vToken) };
}

export interface MemeRowContext {
  readonly publicBaseUrl: string;
  readonly now: Date;
  readonly dexQuotes: ReadonlyMap<
    string,
    MemeDexQuote | { readonly reasonCode: string }
  >;
}

/** The list row (`GET /v2/meme/tokens`) and the head of the detail. */
export function projectMemeTokenRow(
  record: MemeTokenListRecord,
  context: MemeRowContext,
): Record<string, unknown> {
  const curve = curveOf(record);
  const priceNow = memePriceE18(curve);
  let price: string | null = null;
  let marketCap: string | null = null;
  let change1h: string | null = null;
  let priceSource: Record<string, unknown> | null = null;
  let quoteUnavailable: Record<string, unknown> | null = null;
  if (record.status === "graduated") {
    const dex =
      record.tokenAddress === null
        ? undefined
        : context.dexQuotes.get(record.tokenAddress);
    if (dex !== undefined && "priceUsd" in dex) {
      price = dex.priceUsd;
      marketCap = dex.marketCapUsd;
      priceSource = {
        source: dex.source ?? "dexscreener",
        observedAt: dex.observedAt,
      };
    } else {
      quoteUnavailable = {
        reasonCode:
          dex !== undefined && "reasonCode" in dex
            ? dex.reasonCode
            : memeReasonCodes.dexQuoteUnavailable,
      };
    }
  } else if (record.status === "draft" || record.status === "pending_chain") {
    quoteUnavailable = { reasonCode: memeReasonCodes.tokenNotOnChain };
  } else {
    price = formatE18(priceNow);
    marketCap = formatE18(memeMarketCapRaw(curve));
    const reference =
      record.price1hAgoE18 === null
        ? initialPriceE18
        : BigInt(record.price1hAgoE18);
    change1h = percentChange(priceNow, reference);
    priceSource = {
      source: "loop_curve",
      observedAt:
        record.lastTradeAt ?? record.chainCreatedAt ?? record.updatedAt,
    };
  }
  return {
    memeTokenId: record.memeTokenId,
    tokenAddress: record.tokenAddress,
    name: record.name,
    symbol: record.symbol,
    imageUrl:
      record.imageMediaId === null
        ? null
        : mediaAbsoluteUrl(context.publicBaseUrl, record.imageMediaId),
    creator: creatorProjection(record.creator),
    status: record.status,
    progressBps: memeProgressBps(BigInt(record.sold)),
    priceUsd1: price,
    marketCapUsd1: marketCap,
    change1hPct: change1h,
    volume24hUsd1: formatE18(BigInt(record.volume24hRaw)),
    holderCount: record.holderCount,
    tradeCount: record.tradeCount,
    createdAt: record.chainCreatedAt ?? record.createdAt,
    graduatedAt: record.graduatedAt,
    pool: record.poolAddress,
    priceSource,
    ...(quoteUnavailable === null ? {} : { quoteUnavailable }),
  };
}

export function projectMemeCurve(
  record: MemeTokenRecord,
): Record<string, unknown> {
  return {
    vUsd1: record.vUsd1,
    vToken: record.vToken,
    realUsd1: record.realUsd1,
    sold: record.sold,
    saleSupply: memeSaleSupply.toString(10),
    poolSupply: memePoolSupply.toString(10),
    totalSupply: memeTotalSupply.toString(10),
    graduationUsd1Estimate: memeGraduationUsd1Estimate.toString(10),
    tradeFeeBps: Number(memeTradeFeeBps),
    walletCapTokens: memeWalletCap.toString(10),
    minBuyUsd1: memeMinBuyUsd1.toString(10),
  };
}

export function projectMemeGraduation(
  record: MemeTokenRecord,
): Record<string, unknown> | null {
  if (record.status !== "graduated" || record.graduatedAt === null) {
    return null;
  }
  return {
    pool: record.poolAddress,
    lpBurnTx: record.graduationTxHash,
    lpTokenId: record.lpTokenId,
    usd1ToPool: record.usd1ToPool,
    tokensToPool: record.tokensToPool,
    feeUsd1: record.graduationFeeUsd1,
    at: record.graduatedAt,
    residual: projectMemeResidual(record),
  };
}

/** One whole USD1 / one whole token, both 18 decimals. */
const memeResidualDustThreshold = 10n ** 18n;

/**
 * Decision 0103: a residual below 1 USD1 and below 1 token is the curve's
 * rounding dust (every graduation leaves some), so it projects as null. A
 * non-null residual therefore means the pool already existed at graduation
 * and part of the funds stayed in the contract. The lane keeps every
 * `GraduationResidual` event unchanged.
 */
function projectMemeResidual(
  record: MemeTokenRecord,
): Record<string, string> | null {
  if (record.residualUsd1 === null) {
    return null;
  }
  const usd1Left = record.residualUsd1;
  const tokensLeft = record.residualTokens ?? "0";
  if (
    BigInt(usd1Left) < memeResidualDustThreshold &&
    BigInt(tokensLeft) < memeResidualDustThreshold
  ) {
    return null;
  }
  return { usd1Left, tokensLeft };
}

/** Holder share of the 1e9 total supply, in basis points (rounded down). */
export function shareBpsOf(balance: bigint): number {
  return Number((balance * memeBps) / memeTotalSupply);
}
