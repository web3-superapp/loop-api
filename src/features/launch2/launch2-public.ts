import { launch2Wad } from "./launch2-contract.js";
import { launch2PriceAt } from "./launch2-curve-math.js";
import { launch2ProjectSummary } from "./launch2-project-profile.js";

/**
 * Decision 0147: pure helpers of the public MEME page read surface
 * (`/public/v1/meme*`). No I/O. The surface exposes only facts that are
 * public on chain or that any signed-in App user already sees: no wallet,
 * user, viewer, or owner field ever appears.
 */

export const launch2PublicReasonCodes = Object.freeze({
  rateLimited: "PUBLIC_RATE_LIMITED",
  intervalUnsupported: "PUBLIC_CANDLE_INTERVAL_UNSUPPORTED",
  limitInvalid: "PUBLIC_LIMIT_INVALID",
  stageInvalid: "PUBLIC_STAGE_INVALID",
  notFound: "PUBLIC_NOT_FOUND",
} as const);

/** `stage` filter of the public list. */
export const launch2PublicStageFilters = Object.freeze([
  "all",
  "graduated",
  "curve",
] as const);
export type Launch2PublicStageFilter =
  (typeof launch2PublicStageFilters)[number];

export const launch2PublicListDefaultLimit = 50;
export const launch2PublicListMaximumLimit = 50;
export const launch2PublicCandleMaximumLimit = 300;
export const launch2PublicCandleIntervals = Object.freeze(["5m"] as const);

/** Block explorer of the launch chains (CAIP-2 → base URL). */
const explorerBaseUrls: Readonly<Record<string, string>> = Object.freeze({
  "eip155:56": "https://bscscan.com",
  "eip155:97": "https://testnet.bscscan.com",
});

export function launch2PublicExplorerBaseUrl(chainId: string): string | null {
  return explorerBaseUrls[chainId] ?? null;
}

function hostOf(link: string): string | null {
  try {
    return new URL(link).hostname.toLowerCase().replace(/^www\./u, "");
  } catch {
    return null;
  }
}

/**
 * The creator's saved project links (Decision 0138: http(s) only, ≤ 5, in
 * saved order) sorted into the page's three slots: the first x.com /
 * twitter.com link is `x`, the first t.me / telegram.me / telegram.org
 * link is `telegram`, the first other link is `website`.
 */
export function launch2PublicSocials(links: readonly string[]): {
  readonly website: string | null;
  readonly x: string | null;
  readonly telegram: string | null;
} {
  let website: string | null = null;
  let x: string | null = null;
  let telegram: string | null = null;
  for (const link of links) {
    const host = hostOf(link);
    if (host === null) continue;
    if (host === "x.com" || host === "twitter.com") {
      x ??= link;
    } else if (
      host === "t.me" ||
      host === "telegram.me" ||
      host === "telegram.org"
    ) {
      telegram ??= link;
    } else {
      website ??= link;
    }
  }
  return Object.freeze({ website, x, telegram });
}

/**
 * The community's slogan. Communities keep no separate tagline, so the
 * slogan is the first non-empty line of the public description, collapsed
 * and cut to 60 code points like the launch summary (Decision 0138); null
 * without a description.
 */
export function launch2PublicSlogan(description: string | null): string | null {
  if (description === null) return null;
  const line = description
    .split(/\r?\n/u)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return launch2ProjectSummary(line ?? null);
}

/**
 * `(last − reference) / reference × 100`, truncated toward zero to two
 * decimals (e.g. "-3.21"); null when there is no reference or it is 0.
 */
export function launch2PublicChangePct(
  lastE18: bigint,
  referenceE18: bigint | null,
): string | null {
  if (referenceE18 === null || referenceE18 <= 0n) return null;
  const hundredths = ((lastE18 - referenceE18) * 10_000n) / referenceE18;
  const negative = hundredths < 0n;
  const magnitude = negative ? -hundredths : hundredths;
  const text = `${(magnitude / 100n).toString(10)}.${(magnitude % 100n)
    .toString(10)
    .padStart(2, "0")}`;
  return negative && magnitude !== 0n ? `-${text}` : text;
}

/** The curve's marginal price at a sold supply (null outside the curve). */
export function launch2PublicCurvePriceAt(sold: bigint): bigint | null {
  try {
    return launch2PriceAt(sold);
  } catch {
    return null;
  }
}

/**
 * Every tax in USD1: the USD1 parts as they are plus the MEME buy fee at
 * the latest price (floor). Null when there is a MEME fee and no price.
 */
export function launch2PublicTotalTaxUsd1(input: {
  readonly usd1Parts: readonly bigint[];
  readonly memeFee: bigint;
  readonly priceE18: bigint | null;
}): bigint | null {
  const usd1 = input.usd1Parts.reduce((sum, part) => sum + part, 0n);
  if (input.memeFee === 0n) return usd1;
  if (input.priceE18 === null) return null;
  return usd1 + (input.memeFee * input.priceE18) / launch2Wad;
}
