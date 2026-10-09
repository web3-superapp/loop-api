import {
  defineIntelPromotions,
  intelPromotions as shippedIntelPromotions,
  intelPromotionsConfigVersion,
  intelPromotionsEffectiveAt,
  intelPromotionsResource,
  isAllowedIntelPromotionImageUrl,
  type IntelPromotion,
  type IntelPromotionsResource,
} from "../market/intel-promotions.js";
import type { AdminRepository, AdminSettingKey } from "./admin-repository.js";

/**
 * Read priority of the operator overrides (Decision 0102): an
 * `admin_settings` row wins; no row means the shipped constant
 * (`intelPromotions`) or the environment (`RECOMMENDED_COMMUNITY_IDS`,
 * Decision 0095) is in force, exactly as before the console existed.
 *
 * Values are cached for 60 seconds; a console write in this process
 * invalidates the cache at once. A stored value that no longer validates,
 * or a database read that fails with nothing cached, falls back to the
 * constant and is logged — the `/v2` routes never fail because of it.
 */

export const adminSettingsCacheTtlMs = 60_000;

const uuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface AdminSettingsLogger {
  warn(context: Record<string, unknown>, message: string): void;
}

export interface DatabaseIntelPromotions {
  readonly items: readonly IntelPromotion[];
  readonly updatedAt: string;
}

export interface AdminSettingsReader {
  /** The database list, or null when the environment list is in force. */
  recommendedCommunityIds(): Promise<readonly string[] | null>;
  /** The database cards, or null when the shipped constant is in force. */
  intelPromotions(): Promise<DatabaseIntelPromotions | null>;
  invalidate(key?: AdminSettingKey): void;
}

/** `intelPromotionsV1+db.<updated_at epoch ms>` for a database list. */
export function databaseIntelPromotionsConfigVersion(
  updatedAt: string,
): string {
  return `${intelPromotionsConfigVersion}+db.${Date.parse(updatedAt)}`;
}

export function parseRecommendedCommunityIdsValue(
  value: unknown,
): readonly string[] | null {
  if (
    !Array.isArray(value) ||
    value.length > 50 ||
    !value.every(
      (item): item is string =>
        typeof item === "string" && uuidV4Pattern.test(item),
    ) ||
    new Set(value).size !== value.length
  ) {
    return null;
  }
  return Object.freeze([...value]);
}

export function parseIntelPromotionsValue(
  value: unknown,
): readonly IntelPromotion[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  try {
    return defineIntelPromotions(
      value.map((raw: unknown): IntelPromotion => {
        if (typeof raw !== "object" || raw === null) {
          throw new Error("invalid");
        }
        const item = raw as Record<string, unknown>;
        if (
          typeof item["id"] !== "string" ||
          typeof item["title"] !== "string" ||
          typeof item["subtitle"] !== "string" ||
          (item["imageUrl"] !== null && typeof item["imageUrl"] !== "string") ||
          typeof item["deeplink"] !== "string" ||
          typeof item["startsAt"] !== "string" ||
          typeof item["endsAt"] !== "string" ||
          typeof item["order"] !== "number"
        ) {
          throw new Error("invalid");
        }
        return {
          id: item["id"],
          title: item["title"],
          subtitle: item["subtitle"],
          imageUrl: item["imageUrl"],
          deeplink: item["deeplink"],
          startsAt: new Date(item["startsAt"]).toISOString(),
          endsAt: new Date(item["endsAt"]).toISOString(),
          order: item["order"],
        };
      }),
    );
  } catch {
    return null;
  }
}

interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

export function createAdminSettingsReader(input: {
  readonly repository: Pick<AdminRepository, "getSetting"> | null;
  readonly logger: AdminSettingsLogger;
  readonly ttlMs?: number;
  readonly now?: () => number;
  /**
   * Decision 0105: `INTEL_PROMOTION_IMAGE_HOSTS`. A stored `imageUrl` whose
   * host is not (or no longer) listed is served as `null`. Absent = none.
   */
  readonly imageHosts?: readonly string[];
}): AdminSettingsReader {
  const imageHosts = input.imageHosts ?? [];
  const ttlMs = input.ttlMs ?? adminSettingsCacheTtlMs;
  const now = input.now ?? (() => Date.now());
  const cache = new Map<AdminSettingKey, CacheEntry<unknown>>();
  const lastKnown = new Map<AdminSettingKey, unknown>();

  async function read<T>(
    key: AdminSettingKey,
    project: (value: unknown, updatedAt: string) => T | "invalid",
  ): Promise<T | null> {
    if (input.repository === null) {
      return null;
    }
    const at = now();
    const cached = cache.get(key);
    if (cached !== undefined && at < cached.expiresAt) {
      return cached.value as T | null;
    }
    let value: T | null;
    try {
      const row = await input.repository.getSetting(key);
      if (row === null) {
        value = null;
      } else {
        const projected = project(row.value, row.updatedAt);
        if (projected === "invalid") {
          input.logger.warn(
            { settingKey: key, reasonCode: "ADMIN_SETTING_INVALID" },
            "Operator setting does not validate; the shipped value is in force",
          );
          value = null;
        } else {
          value = projected;
        }
      }
    } catch (error) {
      input.logger.warn(
        {
          settingKey: key,
          reasonCode: "ADMIN_SETTING_UNREADABLE",
          errorName: error instanceof Error ? error.name : "unknown",
        },
        "Operator setting could not be read",
      );
      return lastKnown.has(key) ? (lastKnown.get(key) as T | null) : null;
    }
    cache.set(key, { value, expiresAt: at + ttlMs });
    lastKnown.set(key, value);
    return value;
  }

  return Object.freeze({
    recommendedCommunityIds() {
      return read<readonly string[]>(
        "recommended_community_ids",
        (value) => parseRecommendedCommunityIdsValue(value) ?? "invalid",
      );
    },
    intelPromotions() {
      return read<DatabaseIntelPromotions>(
        "intel_promotions",
        (value, updatedAt) => {
          const items = parseIntelPromotionsValue(value);
          return items === null
            ? "invalid"
            : Object.freeze({
                items: Object.freeze(
                  items.map((item) =>
                    item.imageUrl === null ||
                    isAllowedIntelPromotionImageUrl(item.imageUrl, imageHosts)
                      ? item
                      : Object.freeze({ ...item, imageUrl: null }),
                  ),
                ),
                updatedAt,
              });
        },
      );
    },
    invalidate(key?: AdminSettingKey) {
      if (key === undefined) {
        cache.clear();
      } else {
        cache.delete(key);
      }
    },
  });
}

/** The `/v2/intel/promotions` resource under the read priority. */
export async function resolveIntelPromotions(
  reader: AdminSettingsReader | null,
  at: Date,
): Promise<IntelPromotionsResource> {
  const database = reader === null ? null : await reader.intelPromotions();
  if (database === null) {
    return intelPromotionsResource(at, shippedIntelPromotions);
  }
  return intelPromotionsResource(at, database.items, {
    configVersion: databaseIntelPromotionsConfigVersion(database.updatedAt),
    effectiveAt: database.updatedAt,
  });
}

export const shippedIntelPromotionsVersion = Object.freeze({
  configVersion: intelPromotionsConfigVersion,
  effectiveAt: intelPromotionsEffectiveAt,
});
