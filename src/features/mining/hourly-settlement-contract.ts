/**
 * Decision 0116: constants, states, reason codes, and the parameter document
 * of the hourly two-track Mining settlement. Every amount is a raw integer
 * (LOOP 18 decimals, legacy prices USD 1e18, weights / coefficients 1e18 fixed
 * point); nothing here is a JavaScript number except bps and counts.
 */

export const miningLoopDecimals = 18;
export const miningFixedScale = 10n ** 18n;
export const miningHourSeconds = 3_600n;
export const miningReferralLevels = 5;
export const miningBpsDenominator = 10_000n;

export const miningEpochStates = Object.freeze([
  "pending",
  "settling",
  "settled",
  "failed",
] as const);
export type MiningEpochState = (typeof miningEpochStates)[number];

export const miningClaimStates = Object.freeze([
  "claimable",
  "submitting",
  "confirming",
  "succeeded",
  "failed",
  "expired",
] as const);
export type MiningClaimState = (typeof miningClaimStates)[number];

export const miningParameterStates = Object.freeze([
  "pending_approval",
  "approved",
  "withdrawn",
] as const);
export type MiningParameterState = (typeof miningParameterStates)[number];

export const miningDisplayStates = Object.freeze([
  "awaiting_first_settlement",
  "displaying",
  "settling",
  "unavailable",
] as const);
export type MiningDisplayState = (typeof miningDisplayStates)[number];

export const miningSettlementLane = "mining_hourly_settlement" as const;

export const miningSettlementReasonCodes = Object.freeze({
  settlementUnavailable: "MINING_SETTLEMENT_UNAVAILABLE",
  parametersPending: "MINING_PARAMETERS_PENDING",
  /** Decision 0123: no hour has been settled yet (claim not executable). */
  nothingSettled: "MINING_NOTHING_SETTLED",
  indexerBehind: "MINING_SETTLEMENT_INDEXER_BEHIND",
  outsideRelease: "MINING_SETTLEMENT_OUTSIDE_RELEASE",
  hourNotComplete: "MINING_SETTLEMENT_HOUR_NOT_COMPLETE",
  inputInvalid: "MINING_SETTLEMENT_INPUT_INVALID",
  assetSourceUnknown: "MINING_SETTLEMENT_ASSET_SOURCE_UNKNOWN",
  priceMissing: "MINING_SETTLEMENT_PRICE_MISSING",
  testTriggerDisabled: "MINING_SETTLEMENT_TEST_TRIGGER_DISABLED",
  /**
   * Decision 0123 / 0126: a graduated launch2 asset excluded from a
   * valuation-basis (pre-0123) hour — no post-graduation price existed.
   * Kept only for those replayed hours.
   */
  assetGraduatedUnreadable: "MINING_ASSET_GRADUATED_UNREADABLE",
  /**
   * Decision 0126: a graduated launch2 asset excluded from a quantity-basis
   * hour because the post-graduation MEME Transfer coverage (Decision 0125)
   * had not completed for that hour. No price is involved.
   */
  assetGraduatedBalancePending: "MINING_ASSET_GRADUATED_BALANCE_PENDING",
  // Claim (prepare / report).
  claimSignerNotConfigured: "MINING_CLAIM_SIGNER_NOT_CONFIGURED",
  claimContractNotConfigured: "MINING_CLAIM_CONTRACT_NOT_CONFIGURED",
  claimChainNotConfigured: "MINING_CLAIM_CHAIN_NOT_CONFIGURED",
  claimMainnetClosed: "MINING_CLAIM_MAINNET_CLOSED",
  claimWritesDisabled: "MINING_CLAIM_WRITES_DISABLED",
  claimChainReadFailed: "MINING_CLAIM_CHAIN_READ_FAILED",
  claimContractPaused: "MINING_CLAIM_CONTRACT_PAUSED",
  claimFundingInsufficient: "MINING_CLAIM_FUNDING_INSUFFICIENT",
  claimNothingToClaim: "MINING_CLAIM_NOTHING_TO_CLAIM",
  claimBelowMinimum: "MINING_CLAIM_BELOW_MINIMUM",
  claimInFlight: "MINING_CLAIM_IN_FLIGHT",
  claimLedgerMismatch: "MINING_CLAIM_LEDGER_MISMATCH",
  claimSimulationReverted: "MINING_CLAIM_SIMULATION_REVERTED",
  claimWalletNotEmbedded: "MINING_CLAIM_WALLET_NOT_EMBEDDED",
  claimGasInsufficient: "CLAIM_GAS_INSUFFICIENT",
  claimNoGasSource: "CLAIM_NO_GAS_SOURCE",
  claimNotFound: "MINING_CLAIM_NOT_FOUND",
  claimHashConflict: "MINING_CLAIM_TRANSACTION_CONFLICT",
  claimTransactionMismatch: "MINING_CLAIM_TRANSACTION_MISMATCH",
  claimExpired: "MINING_CLAIM_EXPIRED",
  claimReverted: "MINING_CLAIM_REVERTED",
});

/** Signature validity window of a voucher (docs/16 §6: now + 10 minutes). */
export const miningClaimDeadlineSeconds = 600;
/** Slack added to a voucher deadline before another wallet may be prepared. */
export const miningClaimDeadlineGraceSeconds = 60;
export const miningClaimFallbackGas = 150_000n;
/** Blocks after the prepare block searched for an unreported `Claimed` log. */
export const miningClaimLogSearchBlocks = 2_000n;

const rawPattern = /^(0|[1-9][0-9]{0,77})$/u;
const decimalPattern = /^(0|[1-9][0-9]{0,40})(\.[0-9]{1,18})?$/u;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const assetIdPattern = /^eip155:[1-9][0-9]{0,9}:0x[0-9a-f]{40}$/u;

export interface MiningAssetWeight {
  readonly assetId: string;
  /** Decimal string, at most 18 fraction digits. */
  readonly weight: string;
}

/**
 * Decision 0123 (requirer ruling 2026-10-10, docs/17 item 17): the asset
 * track weighs token **quantity** (balance TWAB × Mining Weight), not value.
 * `valuation` (balance × curve price × weight) is the Decision 0116 rule and
 * survives only so that documents approved before 0123 (which carry no
 * `assetPowerBasis` key) replay to the same digest and rewards. New drafts
 * are always `quantity`; a `valuation` draft cannot be created or approved.
 */
export const miningAssetPowerBases = Object.freeze([
  "quantity",
  "valuation",
] as const);
export type MiningAssetPowerBasis = (typeof miningAssetPowerBases)[number];
export const miningCurrentAssetPowerBasis = "quantity" as const;
/** Stored documents without the key were approved under Decision 0116. */
export const miningLegacyAssetPowerBasis = "valuation" as const;
/** docs/17 item 18: a community nobody set has coefficient 1.0. */
export const miningDefaultCommunityCoefficient = "1";
/** Decision 0116: an unset community had coefficient 0. */
export const miningLegacyDefaultCommunityCoefficient = "0";

export interface MiningCommunityCoefficient {
  readonly communityId: string;
  readonly coefficient: string;
}

/** The versioned parameters a reviewer approves (Decision 0116). */
export interface MiningParameterDocument {
  /** L1..L5 in basis points (10% = 1000). */
  readonly referralRatiosBps: readonly number[];
  readonly dailyBudgetNftRaw: string;
  readonly dailyBudgetAssetRaw: string;
  /** UTC midnight ISO instant; the first budgeted hour. */
  readonly releaseStartAt: string;
  readonly releaseDays: number;
  readonly timezone: "UTC";
  readonly minimumClaimRaw: string;
  readonly assetWeights: readonly MiningAssetWeight[];
  readonly communityCoefficients: readonly MiningCommunityCoefficient[];
  /** Decision 0123; absent in documents stored before it (→ valuation). */
  readonly assetPowerBasis: MiningAssetPowerBasis;
  /**
   * Decision 0123 (docs/17 item 18: every community 1.0 unless set): the
   * coefficient of a community that `communityCoefficients` does not list.
   * Absent in documents stored before 0123 (→ "0", the 0116 rule).
   */
  readonly defaultCommunityCoefficient: string;
}

export class MiningParameterDocumentError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`Invalid mining parameter document: ${field}`);
    this.name = "MiningParameterDocumentError";
    this.field = field;
  }
}

/** Decimal string → 1e18 fixed point; null when malformed. */
export function parseMiningDecimal(value: unknown): bigint | null {
  if (typeof value !== "string" || !decimalPattern.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return (
    BigInt(whole as string) * miningFixedScale +
    BigInt(fraction.padEnd(18, "0") || "0")
  );
}

/** 1e18 fixed point → canonical decimal string (no trailing zeros). */
export function formatMiningDecimal(raw: bigint): string {
  const negative = raw < 0n;
  const value = negative ? -raw : raw;
  const whole = value / miningFixedScale;
  const fraction = value % miningFixedScale;
  const text =
    fraction === 0n
      ? whole.toString(10)
      : `${whole.toString(10)}.${fraction.toString(10).padStart(18, "0").replace(/0+$/u, "")}`;
  return negative ? `-${text}` : text;
}

export function isMiningRaw(value: unknown): value is string {
  return typeof value === "string" && rawPattern.test(value);
}

/**
 * Validates and normalises a **stored** parameter document; throws with the
 * field. A document without `assetPowerBasis` was written under Decision
 * 0116 and reads as `valuation` so that its hours replay unchanged.
 */
export function parseMiningParameterDocument(
  value: unknown,
): MiningParameterDocument {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MiningParameterDocumentError("document");
  }
  const doc = value as Record<string, unknown>;
  const allowed = new Set([
    "referralRatiosBps",
    "dailyBudgetNftRaw",
    "dailyBudgetAssetRaw",
    "releaseStartAt",
    "releaseDays",
    "timezone",
    "minimumClaimRaw",
    "assetWeights",
    "communityCoefficients",
    "assetPowerBasis",
    "defaultCommunityCoefficient",
  ]);
  for (const key of Object.keys(doc)) {
    if (!allowed.has(key)) throw new MiningParameterDocumentError(key);
  }
  const ratios = doc["referralRatiosBps"];
  if (
    !Array.isArray(ratios) ||
    ratios.length !== miningReferralLevels ||
    ratios.some(
      (ratio) =>
        typeof ratio !== "number" ||
        !Number.isInteger(ratio) ||
        ratio < 0 ||
        ratio > 10_000,
    )
  ) {
    throw new MiningParameterDocumentError("referralRatiosBps");
  }
  for (const key of [
    "dailyBudgetNftRaw",
    "dailyBudgetAssetRaw",
    "minimumClaimRaw",
  ] as const) {
    if (!isMiningRaw(doc[key])) throw new MiningParameterDocumentError(key);
  }
  const start = doc["releaseStartAt"];
  if (typeof start !== "string" || Number.isNaN(Date.parse(start))) {
    throw new MiningParameterDocumentError("releaseStartAt");
  }
  const startMs = Date.parse(start);
  if (startMs % 86_400_000 !== 0) {
    throw new MiningParameterDocumentError("releaseStartAt");
  }
  const days = doc["releaseDays"];
  if (
    typeof days !== "number" ||
    !Number.isInteger(days) ||
    days < 1 ||
    days > 3_650
  ) {
    throw new MiningParameterDocumentError("releaseDays");
  }
  if (doc["timezone"] !== "UTC") {
    throw new MiningParameterDocumentError("timezone");
  }
  const weights = doc["assetWeights"];
  if (!Array.isArray(weights) || weights.length > 500) {
    throw new MiningParameterDocumentError("assetWeights");
  }
  const seenAssets = new Set<string>();
  const assetWeights = weights.map((entry: unknown) => {
    const row = entry as Record<string, unknown> | null;
    if (
      typeof row !== "object" ||
      row === null ||
      Object.keys(row).some((key) => key !== "assetId" && key !== "weight") ||
      typeof row["assetId"] !== "string" ||
      !assetIdPattern.test(row["assetId"]) ||
      seenAssets.has(row["assetId"]) ||
      parseMiningDecimal(row["weight"]) === null
    ) {
      throw new MiningParameterDocumentError("assetWeights");
    }
    seenAssets.add(row["assetId"]);
    return Object.freeze({
      assetId: row["assetId"],
      weight: formatMiningDecimal(parseMiningDecimal(row["weight"]) as bigint),
    });
  });
  const coefficients = doc["communityCoefficients"];
  if (!Array.isArray(coefficients) || coefficients.length > 2_000) {
    throw new MiningParameterDocumentError("communityCoefficients");
  }
  const seenCommunities = new Set<string>();
  const communityCoefficients = coefficients.map((entry: unknown) => {
    const row = entry as Record<string, unknown> | null;
    if (
      typeof row !== "object" ||
      row === null ||
      Object.keys(row).some(
        (key) => key !== "communityId" && key !== "coefficient",
      ) ||
      typeof row["communityId"] !== "string" ||
      !uuidPattern.test(row["communityId"]) ||
      seenCommunities.has(row["communityId"]) ||
      parseMiningDecimal(row["coefficient"]) === null
    ) {
      throw new MiningParameterDocumentError("communityCoefficients");
    }
    seenCommunities.add(row["communityId"]);
    return Object.freeze({
      communityId: row["communityId"],
      coefficient: formatMiningDecimal(
        parseMiningDecimal(row["coefficient"]) as bigint,
      ),
    });
  });
  const basis = doc["assetPowerBasis"] ?? miningLegacyAssetPowerBasis;
  if (!(miningAssetPowerBases as readonly unknown[]).includes(basis)) {
    throw new MiningParameterDocumentError("assetPowerBasis");
  }
  const defaultCoefficient = parseMiningDecimal(
    doc["defaultCommunityCoefficient"] ??
      miningLegacyDefaultCommunityCoefficient,
  );
  if (defaultCoefficient === null) {
    throw new MiningParameterDocumentError("defaultCommunityCoefficient");
  }
  return Object.freeze({
    referralRatiosBps: Object.freeze([...(ratios as number[])]),
    dailyBudgetNftRaw: doc["dailyBudgetNftRaw"] as string,
    dailyBudgetAssetRaw: doc["dailyBudgetAssetRaw"] as string,
    releaseStartAt: new Date(startMs).toISOString(),
    releaseDays: days,
    timezone: "UTC" as const,
    minimumClaimRaw: doc["minimumClaimRaw"] as string,
    assetWeights: Object.freeze(
      [...assetWeights].sort((a, b) => (a.assetId < b.assetId ? -1 : 1)),
    ),
    communityCoefficients: Object.freeze(
      [...communityCoefficients].sort((a, b) =>
        a.communityId < b.communityId ? -1 : 1,
      ),
    ),
    assetPowerBasis: basis as MiningAssetPowerBasis,
    defaultCommunityCoefficient: formatMiningDecimal(defaultCoefficient),
  });
}

/**
 * Decision 0123: a **new draft**. `assetPowerBasis` may be omitted (it is
 * stored as `quantity`); any other value than `quantity` is refused with
 * field `assetPowerBasis`. There is no price / reference-price field: the
 * asset track is not valued.
 */
export function parseMiningParameterDraft(
  value: unknown,
): MiningParameterDocument {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const basis = (value as Record<string, unknown>)["assetPowerBasis"];
    if (basis !== undefined && basis !== miningCurrentAssetPowerBasis) {
      throw new MiningParameterDocumentError("assetPowerBasis");
    }
    return parseMiningParameterDocument({
      defaultCommunityCoefficient: miningDefaultCommunityCoefficient,
      ...value,
      assetPowerBasis: miningCurrentAssetPowerBasis,
    });
  }
  return parseMiningParameterDocument(value);
}

/**
 * docs/16 §1/§5 defaults a draft starts from, frozen by the requirer on
 * 2026-10-10 (docs/16 §7, docs/17 items 12–20): 500,000 LOOP/day per pool
 * spread evenly over the 24 UTC hours (Σ two pools = the contract's
 * 1,000,000 LOOP daily claim cap), 900 days (= 900,000,000 LOOP total, the
 * contract's total cap), five-level ratios 10/5/3/2/1 %, minimum claim
 * 1 LOOP, quantity-weighted asset track. Community coefficients: the listed
 * ones (by default a frozen copy of the approved community weights), every
 * other community `defaultCommunityCoefficient` = 1.0; a zero-power hour's
 * budget is void, not carried (calculator, step 8).
 */
export const miningDefaultParameterDocument = Object.freeze({
  referralRatiosBps: Object.freeze([1_000, 500, 300, 200, 100]),
  dailyBudgetNftRaw: (500_000n * miningFixedScale).toString(),
  dailyBudgetAssetRaw: (500_000n * miningFixedScale).toString(),
  releaseDays: 900,
  timezone: "UTC" as const,
  minimumClaimRaw: miningFixedScale.toString(),
  assetPowerBasis: miningCurrentAssetPowerBasis,
  defaultCommunityCoefficient: miningDefaultCommunityCoefficient,
});

/** Contract caps the defaults are sized to (LoopRewardClaim, S138-contracts). */
export const miningClaimDailyCapRaw = 1_000_000n * miningFixedScale;
export const miningClaimTotalCapRaw = 900_000_000n * miningFixedScale;
