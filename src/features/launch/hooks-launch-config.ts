import { encodeAbiParameters, keccak256, parseAbiParameters } from "viem";

/** Immutable economics for the user-approved LOOP Hooks launch template. */
export const hooksLaunchTemplateVersion = "hooks_launch_v1" as const;
export const hooksLaunchTemplateHash = keccak256(
  new TextEncoder().encode(hooksLaunchTemplateVersion),
);

/**
 * Decision 0119: the NFT sale period is a property of the target Factory
 * (`LoopLaunchFactory.nftSaleDuration()`, immutable, 3,600..604,800 s;
 * loop-contracts Decision 0004). Mainnet stays 7 days, so this object — the
 * 604,800 s template — is byte-for-byte the `fixedEconomics` it always was
 * and its configHash is unchanged; a 1-hour testnet Factory yields a
 * different `fixedEconomicsHash`, i.e. a different template.
 */
export const hooksLaunchMinNftSaleDurationSeconds = 3_600;
export const hooksLaunchMaxNftSaleDurationSeconds = 604_800;
/** The 7-day period of the mainnet template and of pre-S141 Factories. */
export const hooksLaunchLegacyNftSaleDurationSeconds = 604_800;

export const hooksLaunchFixedEconomics = Object.freeze({
  chainId: "56",
  memeTotalSupplyRaw: "1000000000000000000000000000",
  curveSaleSupplyRaw: "800000000000000000000000000",
  initialLiquiditySupplyRaw: "200000000000000000000000000",
  graduationReserveUsd1Raw: "133333332000000000000000",
  nftPriceUsd1Raw: "100000000000000000000",
  nftSaleDurationSeconds: 604_800,
  earlyRoundDurationSeconds: 3_600,
  perAddressLifetimeBuyCapRaw: "5000000000000000000000000",
  curveBuyTaxBps: 1_000,
  curveSellTaxBps: 1_000,
  officialPoolBuyTaxBps: 200,
  officialPoolSellTaxBps: 200,
  lpFee: 2_500,
  tickSpacing: 60,
  buybackOrderUsd1Raw: "100000000000000000000",
  buybackMinIntervalSeconds: 10,
});

export type HooksLaunchFixedEconomics = typeof hooksLaunchFixedEconomics;

export function isHooksLaunchNftSaleDuration(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= hooksLaunchMinNftSaleDurationSeconds &&
    value <= hooksLaunchMaxNftSaleDurationSeconds
  );
}

/**
 * The template economics for a Factory whose `nftSaleDuration()` is
 * `nftSaleDurationSeconds`. Overwriting the existing key keeps its
 * position, so the canonical JSON (and the hash) differs from the 7-day
 * template only in that one number.
 */
export function hooksLaunchFixedEconomicsFor(
  nftSaleDurationSeconds: number,
): HooksLaunchFixedEconomics {
  if (!isHooksLaunchNftSaleDuration(nftSaleDurationSeconds)) {
    throw new InvalidHooksLaunchDraftError();
  }
  if (
    nftSaleDurationSeconds === hooksLaunchFixedEconomics.nftSaleDurationSeconds
  ) {
    return hooksLaunchFixedEconomics;
  }
  return Object.freeze({
    ...hooksLaunchFixedEconomics,
    nftSaleDurationSeconds,
  }) as HooksLaunchFixedEconomics;
}

const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const unsignedDecimalPattern = /^(0|[1-9][0-9]{0,19})$/;
const tickerPattern = /^[A-Za-z0-9]{2,12}$/;
const UINT64_MAX = (1n << 64n) - 1n;
const allowedDraftKeys = new Set([
  "name",
  "ticker",
  "logoAssetUrl",
  "description",
  "links",
  "nftSaleStartAt",
  "buybackRecipient",
]);

function hasForbiddenControlCharacters(
  value: string,
  allowWhitespace: boolean,
): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 0x7f) return true;
    if (codePoint < 0x20) {
      if (
        allowWhitespace &&
        (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d)
      ) {
        continue;
      }
      return true;
    }
  }
  return false;
}

export interface HooksLaunchDraftInput {
  readonly name: string;
  readonly ticker: string;
  readonly logoAssetUrl: string;
  readonly description: string;
  readonly links: readonly string[];
  readonly nftSaleStartAt: string;
  readonly buybackRecipient: string;
}

export interface HooksLaunchDraft {
  readonly templateVersion: typeof hooksLaunchTemplateVersion;
  readonly templateHash: string;
  readonly name: string;
  readonly ticker: string;
  readonly logoAssetUrl: string;
  readonly description: string;
  readonly links: readonly string[];
  readonly nftSaleStartAt: string;
  readonly buybackRecipient: string;
  readonly fixedEconomics: HooksLaunchFixedEconomics;
  readonly configHash: string;
}

export class InvalidHooksLaunchDraftError extends Error {
  constructor() {
    super("Invalid Hooks launch draft");
    this.name = "InvalidHooksLaunchDraftError";
  }
}

/**
 * Validates the only project-editable on-chain values and produces a canonical
 * summary hash. The backend must still bind ownership and wallet signatures.
 */
export function parseHooksLaunchDraft(
  input: HooksLaunchDraftInput,
  policy: {
    readonly nowUnixSeconds: string;
    readonly minimumLeadSeconds: number;
    /** The target Factory's `nftSaleDuration()` (Decision 0119). */
    readonly nftSaleDurationSeconds: number;
  },
): HooksLaunchDraft {
  const fixedEconomics = hooksLaunchFixedEconomicsFor(
    policy.nftSaleDurationSeconds,
  );
  if (!Array.isArray(input.links)) throw new InvalidHooksLaunchDraftError();
  const linkValues: readonly unknown[] = input.links;
  if (
    linkValues.length > 8 ||
    linkValues.some((value) => typeof value !== "string")
  ) {
    throw new InvalidHooksLaunchDraftError();
  }
  const linksInput = linkValues as readonly string[];

  if (
    Object.keys(input).some((key) => !allowedDraftKeys.has(key)) ||
    typeof input.name !== "string" ||
    typeof input.ticker !== "string" ||
    typeof input.logoAssetUrl !== "string" ||
    typeof input.description !== "string" ||
    !Array.isArray(input.links) ||
    input.links.some((value) => typeof value !== "string") ||
    typeof input.nftSaleStartAt !== "string" ||
    typeof input.buybackRecipient !== "string" ||
    input.name.trim().length === 0 ||
    input.name.trim().length > 64 ||
    hasForbiddenControlCharacters(input.name, false) ||
    !tickerPattern.test(input.ticker) ||
    input.description.length > 2_000 ||
    hasForbiddenControlCharacters(input.description, true) ||
    !Number.isSafeInteger(policy.minimumLeadSeconds) ||
    policy.minimumLeadSeconds < 0 ||
    !unsignedDecimalPattern.test(policy.nowUnixSeconds) ||
    !unsignedDecimalPattern.test(input.nftSaleStartAt) ||
    !addressPattern.test(input.buybackRecipient) ||
    /^0x0{40}$/i.test(input.buybackRecipient)
  ) {
    throw new InvalidHooksLaunchDraftError();
  }

  const startAt = BigInt(input.nftSaleStartAt);
  const now = BigInt(policy.nowUnixSeconds);
  if (
    startAt > UINT64_MAX ||
    now > UINT64_MAX ||
    startAt < now + BigInt(policy.minimumLeadSeconds)
  ) {
    throw new InvalidHooksLaunchDraftError();
  }

  let logoUrl: URL;
  try {
    logoUrl = new URL(input.logoAssetUrl);
  } catch {
    throw new InvalidHooksLaunchDraftError();
  }
  if (logoUrl.protocol !== "https:" || logoUrl.username || logoUrl.password) {
    throw new InvalidHooksLaunchDraftError();
  }

  const links = linksInput.map((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new InvalidHooksLaunchDraftError();
    }
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new InvalidHooksLaunchDraftError();
    }
    return url.toString();
  });

  const normalized = {
    templateVersion: hooksLaunchTemplateVersion,
    templateHash: hooksLaunchTemplateHash,
    name: input.name.trim(),
    ticker: input.ticker.toUpperCase(),
    logoAssetUrl: logoUrl.toString(),
    description: input.description.trim(),
    links: [...new Set(links)].sort(),
    nftSaleStartAt: startAt.toString(),
    buybackRecipient: input.buybackRecipient.toLowerCase(),
    fixedEconomics,
  } as const;

  const encoded = encodeAbiParameters(
    parseAbiParameters(
      "bytes32 templateHash, string name, string ticker, string logoAssetUrl, string description, bytes32 linksHash, uint64 nftSaleStartAt, address buybackRecipient, bytes32 fixedEconomicsHash",
    ),
    [
      hooksLaunchTemplateHash,
      normalized.name,
      normalized.ticker,
      normalized.logoAssetUrl,
      normalized.description,
      keccak256(new TextEncoder().encode(JSON.stringify(normalized.links))),
      startAt,
      normalized.buybackRecipient as `0x${string}`,
      keccak256(new TextEncoder().encode(JSON.stringify(fixedEconomics))),
    ],
  );

  return Object.freeze({
    ...normalized,
    configHash: keccak256(encoded),
  });
}
