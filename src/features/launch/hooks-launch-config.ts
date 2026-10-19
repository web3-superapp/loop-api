import { encodeAbiParameters, keccak256, parseAbiParameters } from "viem";

import {
  normalizeLaunchTokenDescription,
  normalizeLaunchTokenName,
  normalizeLaunchTokenTicker,
} from "./launch-token-text.js";

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

/**
 * Decision 0131 (loop-contracts S164 + S165, Decision 0009 §4.2 / §13): the
 * Hook parameters a LoopDynamic Factory commits in its `TEMPLATE_HASH`
 * (`LoopDynamicLaunchFactory.loopDynamicTemplateHash`). OfficialTax keeps
 * the bare `keccak256("hooks_launch_v1")`.
 */
export interface HooksLaunchLoopDynamicParams {
  readonly router: string;
  readonly baseSellFeePpm: number;
  readonly baseFeeRecipient: string;
  /** 0 PRE_SWAP, 1 POST_SWAP (ruled: POST_SWAP). */
  readonly priceTiming: 0 | 1;
  /** 0 LoopRouterOnly, 1 Open (ruled: Open). */
  readonly routingPolicy: 0 | 1;
  readonly routerRegistryAdmin: string;
  readonly excludeBuybackFromRewards: boolean;
  /** S165: buy fee in ppm of the MEME output (ruled: 20,000). */
  readonly buyFeePpm: number;
  /**
   * Decision 0144 (loop-contracts Decision 0012, S193): the dynamic sell
   * rate cap, a raw 18-decimal integer string, read from the Factory /
   * manifest, never hard-coded (`"500000000000000000"` = 50 %, the S242
   * ruling; S193 Factories carry `"200000000000000000"` = 20 %; `"0"` =
   * uncapped). Absent = a pre-S193 (S165) Factory, which has
   * no such parameter: its `TEMPLATE_HASH` has no trailing word and its
   * Hooks are uncapped.
   */
  readonly maxDynamicFeeWad?: string;
  /**
   * Decision 0152 (loop-contracts Decision 0015, S209): the Factory's
   * per-address curve purchase cap `maxCumulativeBuy()`, a raw MEME integer
   * string in (0, 1e27] (default `"5000000000000000000000000"`). Present =
   * an S209 Factory: `TEMPLATE_HASH` gets a trailing `uint256
   * maxCumulativeBuy`, its Hooks carry permission bits 0x10CC and take the
   * buy fee from the USD1 input. Absent = a pre-S209 Factory (5,000,000
   * constant, 0x10C4, MEME buy fee). Requires `maxDynamicFeeWad`.
   */
  readonly maxCumulativeBuy?: string;
}

/** Decision 0152: `MAX_CUMULATIVE_BUY_LIMIT` = the MEME total supply. */
export const hooksLaunchMaxCumulativeBuyLimit = 10n ** 27n;

/** A uint256 in (0, 1e27] as a canonical decimal string. */
export function isHooksLaunchMaxCumulativeBuy(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^[1-9][0-9]{0,27}$/u.test(value) &&
    BigInt(value) <= hooksLaunchMaxCumulativeBuyLimit
  );
}

/**
 * Decision 0152 (loop-contracts Decision 0015 §7): the v4 permission bits
 * a LoopDynamic Factory's Hooks carry — 0x10CC for an S209 Factory
 * (`maxCumulativeBuy` present; + beforeSwapReturnDelta, the USD1 buy fee),
 * 0x10C4 before.
 */
export const hooksLaunchLoopDynamicHookPermissionBitsByGeneration =
  Object.freeze({ legacy: 0x10c4n, s209: 0x10ccn } as const);

export function hooksLaunchLoopDynamicHookPermissionBits(
  params: Pick<HooksLaunchLoopDynamicParams, "maxCumulativeBuy">,
): bigint {
  return params.maxCumulativeBuy === undefined
    ? hooksLaunchLoopDynamicHookPermissionBitsByGeneration.legacy
    : hooksLaunchLoopDynamicHookPermissionBitsByGeneration.s209;
}

/** `maxDynamicFeeWad` is a uint256 below 1e18 (the Hook rejects ≥ 1e18). */
export function isHooksLaunchMaxDynamicFeeWad(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^(0|[1-9][0-9]{0,17})$/u.test(value) &&
    BigInt(value) < 10n ** 18n
  );
}

/**
 * `keccak256(abi.encode(keccak256("hooks_launch_v1"), uint8(1), router,
 * uint24 baseSellFeePpm, baseFeeRecipient, uint8 priceTiming, uint8
 * routingPolicy, routerRegistryAdmin, excludeBuybackFromRewards, uint24
 * buyFeePpm, uint256 maxDynamicFeeWad))` — the LoopDynamic Factory's
 * `TEMPLATE_HASH`. Decision 0144: the trailing `uint256 maxDynamicFeeWad`
 * (loop-contracts Decision 0012 §3) is encoded whenever the parameter is
 * present — a cap of 0 still adds a zero word, so an S193 Factory's hash
 * differs from the S165 one even uncapped. Without it (an S165 Factory)
 * the hash is the ten-field S165 formula, unchanged. Decision 0152: an
 * S209 Factory appends `uint256 maxCumulativeBuy` (twelve fields); without
 * it the eleven-field S193 formula is unchanged.
 */
export function hooksLaunchLoopDynamicTemplateHash(
  params: HooksLaunchLoopDynamicParams,
): `0x${string}` {
  const head = [
    hooksLaunchTemplateHash,
    1,
    params.router as `0x${string}`,
    params.baseSellFeePpm,
    params.baseFeeRecipient as `0x${string}`,
    params.priceTiming,
    params.routingPolicy,
    params.routerRegistryAdmin as `0x${string}`,
    params.excludeBuybackFromRewards,
    params.buyFeePpm,
  ] as const;
  const s165 =
    "bytes32, uint8, address, uint24, address, uint8, uint8, address, bool, uint24";
  if (params.maxDynamicFeeWad === undefined) {
    if (params.maxCumulativeBuy !== undefined) {
      throw new InvalidHooksLaunchDraftError();
    }
    return keccak256(encodeAbiParameters(parseAbiParameters(s165), head));
  }
  if (!isHooksLaunchMaxDynamicFeeWad(params.maxDynamicFeeWad)) {
    throw new InvalidHooksLaunchDraftError();
  }
  if (params.maxCumulativeBuy !== undefined) {
    // Decision 0152: S209 — loop-contracts Decision 0015 §5 appends
    // `uint256 maxCumulativeBuy` after the cap word.
    if (!isHooksLaunchMaxCumulativeBuy(params.maxCumulativeBuy)) {
      throw new InvalidHooksLaunchDraftError();
    }
    return keccak256(
      encodeAbiParameters(parseAbiParameters(`${s165}, uint256, uint256`), [
        ...head,
        BigInt(params.maxDynamicFeeWad),
        BigInt(params.maxCumulativeBuy),
      ]),
    );
  }
  return keccak256(
    encodeAbiParameters(parseAbiParameters(`${s165}, uint256`), [
      ...head,
      BigInt(params.maxDynamicFeeWad),
    ]),
  );
}

/**
 * Decision 0131: the `fixedEconomics` of a LoopDynamic template — the
 * OfficialTax object with the pool tax rates taken from the Hook
 * parameters and the Hook parameters appended (so the configHash binds
 * them, `buyFeePpm` and — Decision 0144 — `maxDynamicFeeWad` included). The OfficialTax object is never changed.
 */
export function hooksLaunchLoopDynamicFixedEconomics(
  base: HooksLaunchFixedEconomics,
  params: HooksLaunchLoopDynamicParams,
): Readonly<Record<string, unknown>> {
  if (
    params.maxCumulativeBuy !== undefined &&
    !isHooksLaunchMaxCumulativeBuy(params.maxCumulativeBuy)
  ) {
    throw new InvalidHooksLaunchDraftError();
  }
  return Object.freeze({
    ...base,
    // Decision 0152: an S209 Factory's cap replaces the constant in place
    // (same key position); a pre-S209 template's JSON is unchanged.
    ...(params.maxCumulativeBuy === undefined
      ? {}
      : { perAddressLifetimeBuyCapRaw: params.maxCumulativeBuy }),
    officialPoolBuyTaxBps: params.buyFeePpm / 100,
    officialPoolSellTaxBps: params.baseSellFeePpm / 100,
    officialPoolHookKind: "loopDynamic",
    loopDynamic: Object.freeze({
      router: params.router.toLowerCase(),
      buyFeePpm: params.buyFeePpm,
      baseSellFeePpm: params.baseSellFeePpm,
      baseFeeRecipient: params.baseFeeRecipient.toLowerCase(),
      priceTiming: params.priceTiming === 1 ? "POST_SWAP" : "PRE_SWAP",
      routingPolicy: params.routingPolicy === 1 ? "Open" : "LoopRouterOnly",
      routerRegistryAdmin: params.routerRegistryAdmin.toLowerCase(),
      excludeBuybackFromRewards: params.excludeBuybackFromRewards,
      // Decision 0144: an S193 Factory's cap (raw WAD string, "0" =
      // uncapped); an S165 template's JSON (and configHash) is unchanged.
      ...(params.maxDynamicFeeWad === undefined
        ? {}
        : { maxDynamicFeeWad: params.maxDynamicFeeWad }),
      // Decision 0152: an S209 Factory's cap, and the buy fee token its
      // Hooks charge (code, not a TEMPLATE_HASH parameter — bound here so
      // the project signs what its buyers will pay).
      ...(params.maxCumulativeBuy === undefined
        ? {}
        : {
            maxCumulativeBuy: params.maxCumulativeBuy,
            buyFeeToken: "usd1",
          }),
    }),
  });
}

const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const unsignedDecimalPattern = /^(0|[1-9][0-9]{0,19})$/;
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
  /** Decision 0131: present only for a LoopDynamic template. */
  readonly poolHookKind?: "loopDynamic";
  readonly name: string;
  readonly ticker: string;
  readonly logoAssetUrl: string;
  readonly description: string;
  readonly links: readonly string[];
  readonly nftSaleStartAt: string;
  readonly buybackRecipient: string;
  readonly fixedEconomics:
    HooksLaunchFixedEconomics | Readonly<Record<string, unknown>>;
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
    /**
     * Decision 0131: a LoopDynamic target Factory's Hook parameters. Absent
     * (default) = OfficialTax: the template hash, fixedEconomics and
     * configHash are byte-for-byte unchanged.
     */
    readonly loopDynamic?: HooksLaunchLoopDynamicParams;
  },
): HooksLaunchDraft {
  const officialEconomics = hooksLaunchFixedEconomicsFor(
    policy.nftSaleDurationSeconds,
  );
  const fixedEconomics =
    policy.loopDynamic === undefined
      ? officialEconomics
      : hooksLaunchLoopDynamicFixedEconomics(
          officialEconomics,
          policy.loopDynamic,
        );
  const templateHash =
    policy.loopDynamic === undefined
      ? hooksLaunchTemplateHash
      : hooksLaunchLoopDynamicTemplateHash(policy.loopDynamic);
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
    !Number.isSafeInteger(policy.minimumLeadSeconds) ||
    policy.minimumLeadSeconds < 0 ||
    !unsignedDecimalPattern.test(policy.nowUnixSeconds) ||
    !unsignedDecimalPattern.test(input.nftSaleStartAt) ||
    !addressPattern.test(input.buybackRecipient) ||
    /^0x0{40}$/i.test(input.buybackRecipient)
  ) {
    throw new InvalidHooksLaunchDraftError();
  }

  // Decision 0164: name and ticker share the four.meme rule (any script,
  // 1–20 UTF-16 units after NFC + trim); the ticker is kept as typed — never
  // upper-cased — because the factory's `symbol()` returns the signed bytes.
  const name = normalizeLaunchTokenName(input.name);
  const ticker = normalizeLaunchTokenTicker(input.ticker);
  const description = normalizeLaunchTokenDescription(input.description);
  if (name === null || ticker === null || description === null) {
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
    templateHash,
    ...(policy.loopDynamic === undefined
      ? {}
      : { poolHookKind: "loopDynamic" as const }),
    name,
    ticker,
    logoAssetUrl: logoUrl.toString(),
    description,
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
      templateHash,
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
