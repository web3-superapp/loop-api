/**
 * Decision 0116: constants, states, reason codes, and the parameter document
 * of the hourly two-track Mining settlement. Every amount is a raw integer
 * (LOOP 18 decimals, prices USD 1e18, weights / coefficients 1e18 fixed
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
  indexerBehind: "MINING_SETTLEMENT_INDEXER_BEHIND",
  outsideRelease: "MINING_SETTLEMENT_OUTSIDE_RELEASE",
  hourNotComplete: "MINING_SETTLEMENT_HOUR_NOT_COMPLETE",
  inputInvalid: "MINING_SETTLEMENT_INPUT_INVALID",
  assetSourceUnknown: "MINING_SETTLEMENT_ASSET_SOURCE_UNKNOWN",
  priceMissing: "MINING_SETTLEMENT_PRICE_MISSING",
  testTriggerDisabled: "MINING_SETTLEMENT_TEST_TRIGGER_DISABLED",
  assetGraduatedUnreadable: "MINING_ASSET_GRADUATED_UNREADABLE",
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

/** Validates and normalises a parameter document; throws with the field. */
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
  });
}

/** docs/16 §1/§5 defaults a draft starts from (500,000 LOOP/day per pool, 900 days). */
export const miningDefaultParameterDocument = Object.freeze({
  referralRatiosBps: Object.freeze([1_000, 500, 300, 200, 100]),
  dailyBudgetNftRaw: (500_000n * miningFixedScale).toString(),
  dailyBudgetAssetRaw: (500_000n * miningFixedScale).toString(),
  releaseDays: 900,
  timezone: "UTC" as const,
  minimumClaimRaw: miningFixedScale.toString(),
});
