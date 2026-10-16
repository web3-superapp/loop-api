/**
 * Decision 0114: the fixed `hooks_launch_v1` template as the MEME v2
 * (`launch2`) read model sees it, the instance stages, and every reason
 * code the `/v2/launch2/*` routes and the `launch2_event` lane publish.
 * The numbers are the contract's constants (loop-contracts `protocol/`,
 * Decision 0002); nothing here is operator-editable.
 */

export const launch2Wad = 10n ** 18n;

export const launch2Template = Object.freeze({
  templateVersion: "hooks_launch_v1",
  memeTotalSupply: 1_000_000_000n * launch2Wad,
  curveSaleSupply: 800_000_000n * launch2Wad,
  initialLiquiditySupply: 200_000_000n * launch2Wad,
  graduationReserve: 133_333_332_000_000_000_000_000n,
  curveBuyTaxBps: 1_000n,
  curveSellTaxBps: 1_000n,
  taxDenominator: 10_000n,
  /**
   * The pre-S209 constant `MAX_CUMULATIVE_BUY` (5,000,000 MEME). Decision
   * 0152: S209 curves take `maxCumulativeBuy` from their Factory — read
   * models use the instance's verified value, quotes the chain's.
   */
  perAddressCap: 5_000_000n * launch2Wad,
  earlyRoundSeconds: 3_600,
  nftPrice: 100n * launch2Wad,
  officialPoolTaxBps: 200,
  lpFee: 2_500,
  tickSpacing: 60,
  buybackOrderUsd1: 100n * launch2Wad,
  buybackMinIntervalSeconds: 10,
});

/**
 * Instance stages (Decision 0114 §2). `upcoming` (activated, before the NFT
 * sale opens) is added to the design's six; `paused` is an integrity hold
 * (the contracts have no curve / NFT pause), never the buyback pause.
 * Decision 0120: `closed_no_holders` — the NFT sale ended with no holder,
 * so no snapshot can be published (the registry needs a non-zero root) and
 * the launch ends there (terminal, no next change).
 */
export const launch2Stages = Object.freeze([
  "upcoming",
  "nft_sale",
  "snapshot_pending",
  "closed_no_holders",
  "priority",
  "public",
  "graduated",
  "paused",
] as const);

export type Launch2Stage = (typeof launch2Stages)[number];

export function isLaunch2Stage(value: unknown): value is Launch2Stage {
  return (
    typeof value === "string" &&
    (launch2Stages as readonly string[]).includes(value)
  );
}

/** Decision 0124: `pool_buy` / `pool_sell` are official-pool swaps. */
export const launch2IntentKinds = Object.freeze([
  "nft_mint",
  "buy",
  "sell",
  "pool_buy",
  "pool_sell",
  /** Decision 0131: `LoopDynamicHook.claim(roundId)`. */
  "dynamic_claim",
] as const);

export type Launch2IntentKind = (typeof launch2IntentKinds)[number];

export const launch2EventLane = "launch2_event" as const;

export const launch2ReasonCodes = Object.freeze({
  // Availability (503 CAPABILITY_UNAVAILABLE).
  moduleDeferred: "V2_LAUNCH2_MODULE_DEFERRED",
  runtimeUnavailable: "LAUNCH2_RUNTIME_UNAVAILABLE",
  factoryNotConfigured: "LAUNCH2_FACTORY_NOT_CONFIGURED",
  chainNotConfigured: "LAUNCH2_CHAIN_NOT_CONFIGURED",
  mainnetClosed: "LAUNCH2_MAINNET_SIGNING_CLOSED",
  writesDisabled: "LAUNCH2_WRITES_DISABLED",
  repositoryUnavailable: "LAUNCH2_REPOSITORY_UNAVAILABLE",
  walletsUnavailable: "LAUNCH2_WALLETS_UNAVAILABLE",
  chainReadFailed: "LAUNCH2_CHAIN_READ_FAILED",
  snapshotUnverified: "LAUNCH2_SNAPSHOT_UNVERIFIED",
  // Not found.
  instanceNotFound: "LAUNCH2_INSTANCE_NOT_FOUND",
  // Stale (409 DATA_STALE / QUOTE_EXPIRED).
  stageMismatch: "LAUNCH2_STAGE_MISMATCH",
  instancePaused: "LAUNCH2_INSTANCE_PAUSED",
  soldOut: "LAUNCH2_SOLD_OUT",
  quotaExhausted: "LAUNCH2_QUOTA_EXHAUSTED",
  nftAlreadyMinted: "LAUNCH2_NFT_ALREADY_MINTED",
  priceMoved: "LAUNCH2_PRICE_MOVED",
  quoteExpired: "LAUNCH2_QUOTE_EXPIRED",
  sellNotOpen: "LAUNCH2_SELL_NOT_OPEN",
  // Validation (422 VALIDATION_FAILED).
  amountInvalid: "LAUNCH2_AMOUNT_INVALID",
  amountAboveMax: "LAUNCH2_AMOUNT_ABOVE_MAX",
  minOutAboveQuote: "LAUNCH2_MIN_OUT_ABOVE_QUOTE",
  deadlineTooFar: "LAUNCH2_DEADLINE_TOO_FAR",
  quoteZero: "LAUNCH2_QUOTE_ZERO",
  walletNotEmbedded: "LAUNCH2_WALLET_NOT_EMBEDDED",
  // Balance (409 INSUFFICIENT_BALANCE).
  usd1Insufficient: "LAUNCH2_USD1_BALANCE_INSUFFICIENT",
  memeInsufficient: "LAUNCH2_MEME_BALANCE_INSUFFICIENT",
  gasInsufficient: "LAUNCH2_GAS_INSUFFICIENT",
  // Policy (403 POLICY_BLOCKED).
  notInSnapshot: "LAUNCH2_NOT_IN_SNAPSHOT",
  /** Decision 0117: a prepare target outside the activated instance. */
  counterpartyNotInstance: "LAUNCH2_COUNTERPARTY_NOT_INSTANCE",
  // Intent signing state.
  approvalRequired: "LAUNCH2_APPROVAL_REQUIRED",
  simulationReverted: "LAUNCH2_SIMULATION_REVERTED",
  simulationUnavailable: "LAUNCH2_SIMULATION_UNAVAILABLE",
  intentExpired: "LAUNCH2_INTENT_EXPIRED",
  // Lane.
  noInstances: "LAUNCH2_NO_INSTANCES",
  laneDisabled: "LAUNCH2_INDEXER_DISABLED",
});

/** Integrity holds that put an instance into the `paused` stage. */
export const launch2HoldReasons = Object.freeze([
  "LAUNCH2_DEPLOYED_EVENT_MISMATCH",
  "LAUNCH2_ACTIVATION_MISSING",
] as const);

export type Launch2HoldReason = (typeof launch2HoldReasons)[number];

export const launch2SnapshotVerifications = Object.freeze([
  "verified",
  "mismatch",
] as const);

export type Launch2SnapshotVerification =
  (typeof launch2SnapshotVerifications)[number];

/** Decimal string of a raw 18-decimal amount (no trailing zeros). */
export function formatLaunch2Amount(raw: bigint): string {
  const negative = raw < 0n;
  const value = negative ? -raw : raw;
  const whole = value / launch2Wad;
  const fraction = value % launch2Wad;
  const text =
    fraction === 0n
      ? whole.toString(10)
      : `${whole.toString(10)}.${fraction.toString(10).padStart(18, "0").replace(/0+$/u, "")}`;
  return negative ? `-${text}` : text;
}

const decimalPattern = /^(0|[1-9][0-9]{0,40})(\.[0-9]{1,18})?$/u;

/** Parses a human decimal string with at most 18 fraction digits; null when malformed. */
export function parseLaunch2Amount(value: unknown): bigint | null {
  if (typeof value !== "string" || !decimalPattern.test(value)) {
    return null;
  }
  const [whole, fraction = ""] = value.split(".");
  return (
    BigInt(whole as string) * launch2Wad +
    BigInt(fraction.padEnd(18, "0") || "0")
  );
}

/**
 * The template card the App shows read-only (decimal strings).
 * `nftSaleSeconds` is the instance's own sale period (Decision 0119:
 * `saleEnd − saleStart` of its ProjectNFT, 3,600 on the testnet Factory).
 */
export function launch2TemplateProjection(
  nftSaleSeconds: number,
  /**
   * Decision 0152: the instance curve's per-address cap (S209: a Factory
   * parameter); absent = the pre-S209 constant.
   */
  perAddressCap: bigint = launch2Template.perAddressCap,
): Record<string, unknown> {
  const t = launch2Template;
  return Object.freeze({
    templateVersion: t.templateVersion,
    memeTotalSupply: formatLaunch2Amount(t.memeTotalSupply),
    curveSaleSupply: formatLaunch2Amount(t.curveSaleSupply),
    initialLiquiditySupply: formatLaunch2Amount(t.initialLiquiditySupply),
    graduationReserveUsd1: formatLaunch2Amount(t.graduationReserve),
    curveBuyTaxBps: Number(t.curveBuyTaxBps),
    curveSellTaxBps: Number(t.curveSellTaxBps),
    officialPoolTaxBps: t.officialPoolTaxBps,
    lpFee: t.lpFee,
    tickSpacing: t.tickSpacing,
    perAddressCap: formatLaunch2Amount(perAddressCap),
    // bps of the MEME total supply, floored (5,000,000 MEME = 50).
    perAddressCapBps: Number((perAddressCap * 10_000n) / t.memeTotalSupply),
    nftPriceUsd1: formatLaunch2Amount(t.nftPrice),
    nftSaleSeconds,
    earlyRoundSeconds: t.earlyRoundSeconds,
    buybackOrderUsd1: formatLaunch2Amount(t.buybackOrderUsd1),
    buybackMinIntervalSeconds: t.buybackMinIntervalSeconds,
  });
}
