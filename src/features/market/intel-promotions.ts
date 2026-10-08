import { v2ContractVersion } from "../meta/product-policy.js";

/**
 * Intel page promotion cards (Decision 0100). A versioned list: the shipped
 * constant below, or — Decision 0102 — the operator console's
 * `admin_settings.intel_promotions` row, which wins when present and is
 * validated by the same `defineIntelPromotions`. Each card opens an
 * in-app route only; an external URL, a scheme, or any path outside the
 * allow-list is refused when the module loads, so a bad entry fails the
 * process at start-up instead of reaching a client.
 */

export const intelPromotionsConfigVersion = "intelPromotionsV1" as const;
export const intelPromotionsEffectiveAt = "2026-10-08T00:00:00.000Z" as const;
export const intelPromotionsMaximumItems = 20;

/** In-app routes a promotion may open. `/community/profile` takes an opaque community ID. */
export const intelPromotionDeeplinkPatternSource =
  "^(/intel|/square|/meme|/community/profile\\?id=[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$";
const intelPromotionDeeplinkPattern = new RegExp(
  intelPromotionDeeplinkPatternSource,
);

export function isAllowedIntelDeeplink(value: unknown): value is string {
  return typeof value === "string" && intelPromotionDeeplinkPattern.test(value);
}

export interface IntelPromotion {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  /** No image is hosted for the placeholders; the client draws its own card. */
  readonly imageUrl: string | null;
  readonly deeplink: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly order: number;
}

export interface IntelPromotionsResource {
  readonly items: readonly IntelPromotion[];
  /** `intelPromotionsV1`, or `intelPromotionsV1+db.<epoch ms>` (Decision 0102). */
  readonly configVersion: string;
  readonly effectiveAt: string;
  readonly contractVersion: typeof v2ContractVersion;
}

/** `intelPromotionsV1` or `intelPromotionsV1+db.<epoch ms>`. */
export const intelPromotionsConfigVersionPatternSource =
  "^intelPromotionsV1(\\+db\\.[0-9]{1,16})?$";

export class InvalidIntelPromotionError extends Error {
  readonly code = "invalid_intel_promotion";

  constructor() {
    super("An intel promotion entry is not admissible");
    this.name = "InvalidIntelPromotionError";
  }
}

const opaqueIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Validates and freezes a promotion list. Exported so the allow-list rule is
 * testable with entries the shipped constant does not contain.
 */
export function defineIntelPromotions(
  entries: readonly IntelPromotion[],
): readonly IntelPromotion[] {
  const ids = new Set<string>();
  for (const entry of entries) {
    const startsAt = Date.parse(entry.startsAt);
    const endsAt = Date.parse(entry.endsAt);
    if (
      !opaqueIdPattern.test(entry.id) ||
      ids.has(entry.id) ||
      entry.title.trim().length === 0 ||
      entry.title.length > 40 ||
      entry.subtitle.length > 80 ||
      !isAllowedIntelDeeplink(entry.deeplink) ||
      (entry.imageUrl !== null && !entry.imageUrl.startsWith("https://")) ||
      !Number.isFinite(startsAt) ||
      !Number.isFinite(endsAt) ||
      endsAt <= startsAt ||
      !Number.isInteger(entry.order) ||
      entry.order < 0
    ) {
      throw new InvalidIntelPromotionError();
    }
    ids.add(entry.id);
  }
  if (entries.length > intelPromotionsMaximumItems) {
    throw new InvalidIntelPromotionError();
  }
  return Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
}

/** The two placeholder cards of the first release (S112). */
export const intelPromotions: readonly IntelPromotion[] = defineIntelPromotions(
  [
    {
      id: "5b0f8a2e-6d1c-4e7a-9b3f-2c8d4e6f1a01",
      title: "LOOP 挖矿算力周榜",
      subtitle: "看看本周谁的算力最高",
      imageUrl: null,
      deeplink: "/intel",
      startsAt: "2026-10-08T00:00:00.000Z",
      endsAt: "2027-01-01T00:00:00.000Z",
      order: 1,
    },
    {
      id: "5b0f8a2e-6d1c-4e7a-9b3f-2c8d4e6f1a02",
      title: "推荐社区",
      subtitle: "发现正在活跃的社区",
      imageUrl: null,
      deeplink: "/square",
      startsAt: "2026-10-08T00:00:00.000Z",
      endsAt: "2027-01-01T00:00:00.000Z",
      order: 2,
    },
  ],
);

/** The cards in force at `now`, ordered by `order` then `id`. */
export function intelPromotionsResource(
  now: Date,
  entries: readonly IntelPromotion[] = intelPromotions,
  version: {
    readonly configVersion: string;
    readonly effectiveAt: string;
  } = {
    configVersion: intelPromotionsConfigVersion,
    effectiveAt: intelPromotionsEffectiveAt,
  },
): IntelPromotionsResource {
  const nowMs = now.getTime();
  const items = entries
    .filter(
      (entry) =>
        Date.parse(entry.startsAt) <= nowMs && nowMs < Date.parse(entry.endsAt),
    )
    .sort((left, right) =>
      left.order !== right.order
        ? left.order - right.order
        : left.id < right.id
          ? -1
          : 1,
    );
  return Object.freeze({
    items: Object.freeze(items),
    configVersion: version.configVersion,
    effectiveAt: version.effectiveAt,
    contractVersion: v2ContractVersion,
  });
}
