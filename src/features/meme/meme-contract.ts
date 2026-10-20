import { keccak256, toHex } from "viem";

import { canonicalJson } from "../../core/json/canonical-json.js";
import {
  launchTokenTextRejectionReason,
  type LaunchTokenTextReasonCode,
  normalizeLaunchTokenName,
  normalizeLaunchTokenTicker,
} from "../launch/launch-token-text.js";

/**
 * MEME curve launchpad contract (Decision 0101): entity states, list tabs,
 * K-line intervals, Intent kinds and states, every refusal reason code, and
 * the metadata canonicalisation whose keccak256 is `metadataHash` on chain.
 * Pure values and functions; no I/O.
 */

export const memeTokenStatuses = Object.freeze([
  "draft",
  "pending_chain",
  "trading",
  "full",
  "graduated",
  "paused",
] as const);
export type MemeTokenStatus = (typeof memeTokenStatuses)[number];

/** Statuses a non-creator may read: the token exists on chain. */
export const memeOnChainStatuses = Object.freeze([
  "trading",
  "full",
  "graduated",
  "paused",
] as const satisfies readonly MemeTokenStatus[]);

export const memeListTabs = Object.freeze([
  "new",
  "hot",
  "graduating",
  "graduated",
] as const);
export type MemeListTab = (typeof memeListTabs)[number];

export const memeCandleIntervals = Object.freeze({
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3_600,
  "4h": 14_400,
  "1d": 86_400,
} as const);
export type MemeCandleInterval = keyof typeof memeCandleIntervals;

export const memeIntentKinds = Object.freeze([
  "create",
  "buy",
  "sell",
] as const);
export type MemeIntentKind = (typeof memeIntentKinds)[number];

export const memeIntentStates = Object.freeze([
  "prepared",
  "broadcast_reported",
  "confirmed",
  "failed",
  "expired",
] as const);
export type MemeIntentState = (typeof memeIntentStates)[number];

export const memeSaltStatuses = Object.freeze([
  "free",
  "reserved",
  "used",
] as const);
export type MemeSaltStatus = (typeof memeSaltStatuses)[number];

export const memeRules = Object.freeze({
  configVersion: "memeLaunchpadV1",
  effectiveAt: "2026-10-08T00:00:00.000Z",
  listDefaultLimit: 30,
  listMaximumLimit: 50,
  pageDefaultLimit: 50,
  pageMaximumLimit: 100,
  candleDefaultLimit: 200,
  candleMaximumLimit: 300,
  /** `graduating` tab: trading and at least half sold. */
  graduatingProgressBps: 5_000,
  /** `hot` tab ranking window and cache. */
  hotWindowSeconds: 3_600,
  hotCacheMs: 60_000,
  hotCandidateLimit: 500,
  /** Decision 0142: weekly best trades (window, size, query cache). */
  bestTradesWindowSeconds: 7 * 86_400,
  bestTradesLimit: 10,
  bestTradesCacheMs: 300_000,
  intentDefaultDeadlineSeconds: 300,
  intentMinimumDeadlineSeconds: 30,
  intentMaximumDeadlineSeconds: 1_800,
  defaultSlippageBps: 100,
  maximumSlippageBps: 5_000,
  saltReservationMinutes: 30,
  /** Chain reads of the detail and quote are reused this long (S83b8). */
  chainReadCacheMs: 1_500,
  /** Recomputation vs. chain quote: more than 0.1% is a logged warning. */
  quoteDriftWarningBps: 10n,
});

/** Decision 0142: `GET /v2/meme/best-trades?window=`. */
export const memeBestTradeWindows = ["7d"] as const;
export type MemeBestTradeWindow = (typeof memeBestTradeWindows)[number];

export const memeReasonCodes = Object.freeze({
  tokenNotFound: "MEME_TOKEN_NOT_FOUND",
  /** Decision 0151: classic launch creation retired (410). */
  classicLaunchRetired: "MEME_CLASSIC_LAUNCH_RETIRED",
  curveNotTrading: "MEME_CURVE_NOT_TRADING",
  curveFull: "MEME_CURVE_FULL",
  walletCapExceeded: "MEME_WALLET_CAP_EXCEEDED",
  belowMinBuy: "MEME_BELOW_MIN_BUY",
  createRateLimited: "MEME_CREATE_RATE_LIMITED",
  /** Internal only: the client sees `vanity: false`. */
  saltUnavailable: "MEME_SALT_UNAVAILABLE",
  metadataInvalid: "MEME_METADATA_INVALID",
  imageNotOwned: "MEME_IMAGE_NOT_OWNED",
  tokenNotDraft: "MEME_TOKEN_NOT_DRAFT",
  tokenNotOnChain: "MEME_TOKEN_NOT_ON_CHAIN",
  sellExceedsBalance: "MEME_SELL_EXCEEDS_BALANCE",
  usd1BalanceInsufficient: "MEME_USD1_BALANCE_INSUFFICIENT",
  gasInsufficient: "MEME_GAS_INSUFFICIENT",
  quoteZero: "MEME_QUOTE_ZERO",
  slippageExceeded: "MEME_MIN_OUT_ABOVE_QUOTE",
  simulationReverted: "MEME_SIMULATION_REVERTED",
  simulationUnavailable: "MEME_SIMULATION_UNAVAILABLE",
  approvalRequired: "MEME_APPROVAL_REQUIRED",
  intentExpired: "MEME_INTENT_EXPIRED",
  intentNotSignable: "MEME_INTENT_NOT_SIGNABLE",
  intentAlreadyReported: "MEME_INTENT_ALREADY_REPORTED",
  /** Decision 0104 M2: the draft already has a live create Intent. */
  intentCreateInFlight: "MEME_INTENT_CREATE_IN_FLIGHT",
  /** Decision 0104 m6: a chain read on a POST path failed or timed out. */
  contractReadFailed: "MEME_CONTRACT_READ_FAILED",
  /** Decision 0104 m3: lane-only warning, never on the wire. */
  createdCreatorMismatch: "MEME_CREATED_CREATOR_MISMATCH",
  txPayloadMismatch: "MEME_TX_PAYLOAD_MISMATCH",
  txReverted: "MEME_TX_REVERTED",
  txNotObserved: "MEME_TX_NOT_OBSERVED",
  saltTaken: "MEME_SALT_TAKEN",
  mainnetSigningClosed: "MEME_MAINNET_SIGNING_CLOSED",
  dexQuoteUnavailable: "MEME_DEX_QUOTE_UNAVAILABLE",
  chainNotPriced: "MEME_DEX_CHAIN_NOT_PRICED",
  viewerWalletMissing: "MEME_VIEWER_WALLET_MISSING",
} as const);

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const linkKeys = ["twitter", "telegram", "website"] as const;
export type MemeLinkKey = (typeof linkKeys)[number];

export interface MemeTokenMetadata {
  readonly name: string;
  readonly symbol: string;
  readonly description: string;
  readonly imageMediaId: string | null;
  readonly links: Readonly<Record<MemeLinkKey, string | null>>;
}

export class MemeMetadataInvalidError extends Error {
  readonly code = "meme_metadata_invalid";

  constructor(
    readonly field: string,
    /** Decision 0168: set when only the visibility rule refused the text. */
    readonly textReasonCode: LaunchTokenTextReasonCode | null = null,
  ) {
    super("The MEME token metadata is invalid");
    this.name = "MemeMetadataInvalidError";
  }
}

function httpsLink(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || value.length > 256) {
    throw new MemeMetadataInvalidError(field);
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new MemeMetadataInvalidError(field);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hostname === ""
  ) {
    throw new MemeMetadataInvalidError(field);
  }
  return url.toString();
}

/**
 * Validates `POST /v2/meme/tokens` material: name and symbol under the
 * shared Decision 0164 rule (any script, NFC + trim, 1–20 UTF-16 units,
 * never upper-cased; `launch-token-text.ts`), description ≤ 500 characters, an
 * optional media id, and optional https links. Unknown keys are refused by
 * the route schema before this runs.
 */
export function parseMemeTokenMetadata(body: unknown): MemeTokenMetadata {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new MemeMetadataInvalidError("body");
  }
  const value = body as Record<string, unknown>;
  const rawName = value["name"];
  if (typeof rawName !== "string") {
    throw new MemeMetadataInvalidError("name");
  }
  const name = normalizeLaunchTokenName(rawName);
  if (name === null) {
    throw new MemeMetadataInvalidError(
      "name",
      launchTokenTextRejectionReason(rawName),
    );
  }
  const rawSymbol = value["symbol"];
  const symbol =
    typeof rawSymbol === "string"
      ? normalizeLaunchTokenTicker(rawSymbol)
      : null;
  if (symbol === null) {
    throw new MemeMetadataInvalidError(
      "symbol",
      launchTokenTextRejectionReason(rawSymbol),
    );
  }
  const rawDescription = value["description"] ?? "";
  if (typeof rawDescription !== "string") {
    throw new MemeMetadataInvalidError("description");
  }
  const description = rawDescription.normalize("NFC").trim();
  if (
    [...description].length > 500 ||
    /[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/u.test(description.replace(/\n/gu, ""))
  ) {
    throw new MemeMetadataInvalidError("description");
  }
  const imageMediaId = value["imageMediaId"] ?? null;
  if (
    imageMediaId !== null &&
    (typeof imageMediaId !== "string" || !uuidPattern.test(imageMediaId))
  ) {
    throw new MemeMetadataInvalidError("imageMediaId");
  }
  const rawLinks: unknown = value["links"] ?? {};
  if (
    typeof rawLinks !== "object" ||
    rawLinks === null ||
    Array.isArray(rawLinks)
  ) {
    throw new MemeMetadataInvalidError("links");
  }
  const linkRecord = rawLinks as Record<string, unknown>;
  for (const key of Object.keys(linkRecord)) {
    if (!(linkKeys as readonly string[]).includes(key)) {
      throw new MemeMetadataInvalidError("links");
    }
  }
  const links = Object.freeze({
    twitter: httpsLink(linkRecord["twitter"], "links.twitter"),
    telegram: httpsLink(linkRecord["telegram"], "links.telegram"),
    website: httpsLink(linkRecord["website"], "links.website"),
  });
  return Object.freeze({
    name,
    symbol,
    description,
    imageMediaId,
    links,
  });
}

/**
 * The canonical metadata document. `metadataHash` = keccak256 of its UTF-8
 * canonical JSON (sorted keys, no whitespace); the client passes it to
 * `createToken` and the lane compares it with `TokenCreated.metadataHash`.
 */
export function memeMetadataDocument(input: {
  readonly metadata: MemeTokenMetadata;
  readonly memeTokenId: string;
}): Record<string, unknown> {
  return {
    version: "memeMetadataV1",
    memeTokenId: input.memeTokenId,
    name: input.metadata.name,
    symbol: input.metadata.symbol,
    description: input.metadata.description,
    imageMediaId: input.metadata.imageMediaId,
    links: {
      twitter: input.metadata.links.twitter,
      telegram: input.metadata.links.telegram,
      website: input.metadata.links.website,
    },
  };
}

export function memeMetadataHash(input: {
  readonly metadata: MemeTokenMetadata;
  readonly memeTokenId: string;
}): string {
  return keccak256(toHex(canonicalJson(memeMetadataDocument(input))));
}

/** One deterministic digest of the create request, for Idempotency-Key. */
export function memeCreateRequestParts(
  metadata: MemeTokenMetadata,
): readonly string[] {
  return [
    metadata.name,
    metadata.symbol,
    metadata.description,
    metadata.imageMediaId ?? "",
    metadata.links.twitter ?? "",
    metadata.links.telegram ?? "",
    metadata.links.website ?? "",
  ];
}
