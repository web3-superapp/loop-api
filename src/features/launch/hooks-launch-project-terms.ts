/**
 * Decision 0199 (S359, LOOP 2026-11-04 ruling): the per-project launch
 * terms an applicant fills in when applying — the medal NFT price (whole
 * USD1) and the per-address curve purchase cap (whole permille of the
 * 1,000,000,000 MEME supply). Both are written into that project's
 * contracts at deployment and never change afterwards.
 *
 * This module is the ONE place that knows the conversion to on-chain
 * values and the order in which they join the Factory's `LaunchRequest`
 * struct / EIP-712 type (loop-contracts S359, Decision 0019). Aligning
 * with the contracts batch means editing the constants below only.
 */

export const hooksLaunchNftPriceUsd1Default = 100;
export const hooksLaunchNftPriceUsd1Min = 1;
export const hooksLaunchNftPriceUsd1Max = 1_000;
export const hooksLaunchWalletCapPerMilleDefault = 5;
export const hooksLaunchWalletCapPerMilleMin = 1;
export const hooksLaunchWalletCapPerMilleMax = 1_000;

/** 1 USD1 in wei (18 decimals). */
const usd1Wei = 10n ** 18n;
/** 1 ‰ of the 1e9 MEME supply in raw units (18 decimals): 1e6 MEME. */
const perMilleRaw = 10n ** 24n;

export interface HooksLaunchProjectTerms {
  /** Whole USD1, 1..1,000 (buyback order ≤ 1 % of the graduation reserve). */
  readonly nftPriceUsd1: number;
  /** Whole ‰ of the MEME total supply, 1..1,000. */
  readonly walletCapPerMille: number;
}

export const hooksLaunchDefaultProjectTerms: HooksLaunchProjectTerms =
  Object.freeze({
    nftPriceUsd1: hooksLaunchNftPriceUsd1Default,
    walletCapPerMille: hooksLaunchWalletCapPerMilleDefault,
  });

export type HooksLaunchProjectTermsReason =
  "LAUNCH2_NFT_PRICE_INVALID" | "LAUNCH2_WALLET_CAP_INVALID";

/** 422 VALIDATION_FAILED with `reasonCode` and `field` (Decision 0199). */
export class HooksLaunchProjectTermsInvalidError extends Error {
  constructor(
    readonly reasonCode: HooksLaunchProjectTermsReason,
    readonly field: "nftPriceUsd1" | "walletCapPerMille",
  ) {
    super("Invalid launch project terms");
    this.name = "HooksLaunchProjectTermsInvalidError";
  }
}

/**
 * The target Factory predates S359 (no per-launch terms) and the draft
 * asks for non-default terms: 422 VALIDATION_FAILED
 * `HOOKS_LAUNCH_TERMS_UNSUPPORTED_BY_FACTORY`. Lifted once an S359 Factory
 * is configured.
 */
export class HooksLaunchProjectTermsUnsupportedError extends Error {
  constructor() {
    super("The target launch factory does not support per-project terms");
    this.name = "HooksLaunchProjectTermsUnsupportedError";
  }
}

function wholeInRange(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  );
}

export function isHooksLaunchProjectTerms(
  value: unknown,
): value is HooksLaunchProjectTerms {
  if (typeof value !== "object" || value === null) return false;
  const terms = value as Record<string, unknown>;
  return (
    wholeInRange(
      terms["nftPriceUsd1"],
      hooksLaunchNftPriceUsd1Min,
      hooksLaunchNftPriceUsd1Max,
    ) &&
    wholeInRange(
      terms["walletCapPerMille"],
      hooksLaunchWalletCapPerMilleMin,
      hooksLaunchWalletCapPerMilleMax,
    )
  );
}

/**
 * Reads the two optional draft inputs: absent / null = the default; a
 * fraction, zero, negative, non-number or out-of-range value throws
 * `HooksLaunchProjectTermsInvalidError`. Returns the remaining body (the
 * two keys removed) for the existing strict draft parser.
 */
export function takeHooksLaunchProjectTerms(body: Record<string, unknown>): {
  readonly terms: HooksLaunchProjectTerms;
  readonly rest: Record<string, unknown>;
} {
  const { nftPriceUsd1, walletCapPerMille, ...rest } = body;
  const price =
    nftPriceUsd1 === undefined || nftPriceUsd1 === null
      ? hooksLaunchNftPriceUsd1Default
      : nftPriceUsd1;
  if (
    !wholeInRange(price, hooksLaunchNftPriceUsd1Min, hooksLaunchNftPriceUsd1Max)
  ) {
    throw new HooksLaunchProjectTermsInvalidError(
      "LAUNCH2_NFT_PRICE_INVALID",
      "nftPriceUsd1",
    );
  }
  const cap =
    walletCapPerMille === undefined || walletCapPerMille === null
      ? hooksLaunchWalletCapPerMilleDefault
      : walletCapPerMille;
  if (
    !wholeInRange(
      cap,
      hooksLaunchWalletCapPerMilleMin,
      hooksLaunchWalletCapPerMilleMax,
    )
  ) {
    throw new HooksLaunchProjectTermsInvalidError(
      "LAUNCH2_WALLET_CAP_INVALID",
      "walletCapPerMille",
    );
  }
  return {
    terms: Object.freeze({ nftPriceUsd1: price, walletCapPerMille: cap }),
    rest,
  };
}

export function isDefaultHooksLaunchProjectTerms(
  terms: HooksLaunchProjectTerms,
): boolean {
  return (
    terms.nftPriceUsd1 === hooksLaunchNftPriceUsd1Default &&
    terms.walletCapPerMille === hooksLaunchWalletCapPerMilleDefault
  );
}

/** A record written before Decision 0199 carries no terms: the defaults. */
export function hooksLaunchRecordTerms(record: {
  readonly terms?: HooksLaunchProjectTerms | null;
}): HooksLaunchProjectTerms {
  return record.terms ?? hooksLaunchDefaultProjectTerms;
}

/** `nftPrice` in USD1 wei: n × 1e18. */
export function hooksLaunchNftPriceWei(nftPriceUsd1: number): bigint {
  return BigInt(nftPriceUsd1) * usd1Wei;
}

/** `maxCumulativeBuy` in raw MEME: n × 1e24. */
export function hooksLaunchWalletCapRaw(walletCapPerMille: number): bigint {
  return BigInt(walletCapPerMille) * perMilleRaw;
}

/**
 * The on-chain values the API always passes (never 0 — 0 would mean "the
 * Factory default" to an S359 Factory), as canonical decimal strings.
 */
export interface HooksLaunchProjectTermsOnChain {
  /** `LaunchRequest.nftPrice`, USD1 wei. */
  readonly nftPrice: string;
  /** `LaunchRequest.maxCumulativeBuy`, raw MEME. */
  readonly maxCumulativeBuy: string;
}

export function hooksLaunchProjectTermsOnChain(
  terms: HooksLaunchProjectTerms,
): HooksLaunchProjectTermsOnChain {
  return Object.freeze({
    nftPrice: hooksLaunchNftPriceWei(terms.nftPriceUsd1).toString(10),
    maxCumulativeBuy: hooksLaunchWalletCapRaw(terms.walletCapPerMille).toString(
      10,
    ),
  });
}

/**
 * ALIGNMENT POINT (loop-contracts S359): the fields appended to the
 * EIP-712 `LaunchRequest` type, in order, after `bytes32 templateHash`
 * — `LaunchRequest(…,uint256 nonce,bytes32 templateHash,uint256
 * nftPrice,uint256 maxCumulativeBuy)`.
 */
export const hooksLaunchProjectTermsTypedFields = Object.freeze([
  Object.freeze({ name: "nftPrice", type: "uint256" }),
  Object.freeze({ name: "maxCumulativeBuy", type: "uint256" }),
] as const);

/**
 * The last two components of the Solidity `LaunchRequest` tuple (after
 * `bytes32 memeSalt`). Decision 0200: the encoders use the generated
 * protocol ABI (`pnpm hooks:abi-sync`, S359 build); this constant must
 * equal that tuple's tail (asserted field by field in the tests).
 */
export const hooksLaunchProjectTermsTupleComponents = Object.freeze([
  Object.freeze({ name: "nftPrice", type: "uint256" }),
  Object.freeze({ name: "maxCumulativeBuy", type: "uint256" }),
] as const);

/**
 * Decision 0200: a `deployLaunch` call or Hook init-code preview without
 * the launch terms. Only S359 Factories deploy new launches (older ones are
 * index-only), so the 9-field pre-S359 request is never encoded; reaching
 * this is a programming / data error, never retried.
 */
export class HooksLaunchRequestTermsMissingError extends Error {
  constructor() {
    super("The launch request carries no per-launch terms");
    this.name = "HooksLaunchRequestTermsMissingError";
  }
}

/** The terms as bigint struct values for viem encoders (empty when absent). */
export function hooksLaunchProjectTermsArgs(request: {
  readonly nftPrice?: string | undefined;
  readonly maxCumulativeBuy?: string | undefined;
}): { readonly nftPrice: bigint; readonly maxCumulativeBuy: bigint } | null {
  if (request.nftPrice === undefined || request.maxCumulativeBuy === undefined)
    return null;
  return {
    nftPrice: BigInt(request.nftPrice),
    maxCumulativeBuy: BigInt(request.maxCumulativeBuy),
  };
}

/**
 * Reverse conversion for a deployed launch: the curve's
 * `maxCumulativeBuy()` and the NFT's `PRICE()` the executor verified.
 * A value that is not a whole USD1 / whole ‰ (pre-S359 caps set by the
 * Factory admin) reads as null; `maxCumulativeBuyRaw` is always exact.
 */
export function hooksLaunchProjectTermsFromChain(input: {
  readonly nftPriceWei: bigint;
  readonly maxCumulativeBuyRaw: bigint;
}): {
  readonly nftPriceUsd1: number | null;
  readonly walletCapPerMille: number | null;
  readonly maxCumulativeBuyRaw: string;
} {
  const price =
    input.nftPriceWei > 0n && input.nftPriceWei % usd1Wei === 0n
      ? input.nftPriceWei / usd1Wei
      : null;
  const cap =
    input.maxCumulativeBuyRaw > 0n &&
    input.maxCumulativeBuyRaw % perMilleRaw === 0n
      ? input.maxCumulativeBuyRaw / perMilleRaw
      : null;
  return Object.freeze({
    nftPriceUsd1:
      price !== null && price <= BigInt(hooksLaunchNftPriceUsd1Max)
        ? Number(price)
        : null,
    walletCapPerMille:
      cap !== null && cap <= BigInt(hooksLaunchWalletCapPerMilleMax)
        ? Number(cap)
        : null,
    maxCumulativeBuyRaw: input.maxCumulativeBuyRaw.toString(10),
  });
}

/** The three response keys of an application (Decision 0199, behind the switch). */
export function hooksLaunchProjectTermsView(terms: HooksLaunchProjectTerms): {
  readonly nftPriceUsd1: number;
  readonly walletCapPerMille: number;
  readonly maxCumulativeBuyRaw: string;
} {
  return Object.freeze({
    nftPriceUsd1: terms.nftPriceUsd1,
    walletCapPerMille: terms.walletCapPerMille,
    maxCumulativeBuyRaw: hooksLaunchWalletCapRaw(
      terms.walletCapPerMille,
    ).toString(10),
  });
}
