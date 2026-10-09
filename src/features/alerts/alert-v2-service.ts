import { createHash } from "node:crypto";

import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import {
  InvalidV2CursorError,
  type V2CursorCodec,
} from "../../core/http/v2-cursor.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import {
  AlertExpiryNotFutureError,
  AlertIdempotencyConflictError,
  AlertIdempotencyResourceDeletedError,
  AlertRepositoryUnavailableError,
  AlertVersionConflictError,
} from "../../database/alert-repository.js";
import {
  priceAlertV2Conditions,
  type AlertV2Repository,
  type PriceAlertV2Condition,
  type PriceAlertV2Definition,
  type PriceAlertV2Record,
} from "../../database/alert-v2-repository.js";
import type {
  AssetRecord,
  ChainRegistryRepository,
} from "../../database/chain-registry-repository.js";
import { decomposeAssetId, isAssetId } from "../chain/chain-contract.js";
import {
  isCanonicalDecimalString,
  normalizeDecimalString,
  InvalidMarketDecimalError,
} from "../market/market-contract.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import type { MarketFactService } from "../market/market-fact-service.js";
import {
  notificationReasonCodes,
  priceAlertListLimits,
} from "./notification-contract.js";

/**
 * V2 price alerts (D14, Decision 0034).
 *
 * A definition names a registry asset, a comparison, and a decimal threshold.
 * It is `active` until the evaluator lane observes a fresh price that
 * satisfies it, then `triggered` (one-shot); a replacement re-arms it. Push
 * delivery does not exist: a trigger becomes a context notification in the
 * feed and nothing else.
 */

export const PRICE_ALERT_V2_DIGEST_DOMAIN = "loop.price-alert.create.v2\0";

export type PriceAlertV2PublicState = "active" | "triggered" | "expired";

export interface PriceAlertV2Resource {
  readonly alertId: string;
  readonly assetId: string;
  readonly asset: {
    readonly symbol: string;
    readonly name: string;
    readonly decimals: number;
    readonly status: AssetRecord["status"];
  } | null;
  readonly condition: PriceAlertV2Condition;
  readonly threshold: string;
  readonly expiresAt: string | null;
  readonly state: PriceAlertV2PublicState;
  readonly triggeredAt: string | null;
  readonly lastEvaluatedAt: string | null;
  /** Whether a trigger also reaches this owner's devices (Decision 0067). */
  readonly delivery: {
    readonly status: "available" | "unavailable";
    readonly reasonCode: string | null;
  };
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PriceAlertV2Envelope {
  readonly alert: PriceAlertV2Resource;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface PriceAlertV2ListResource {
  readonly items: readonly PriceAlertV2Resource[];
  readonly nextCursor: string | null;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface AlertV2Service {
  list(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly cursor?: unknown;
    readonly limit?: unknown;
  }): Promise<PriceAlertV2ListResource>;
  create(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly idempotencyKey: string;
    readonly body: unknown;
  }): Promise<{
    readonly created: boolean;
    readonly resource: PriceAlertV2Envelope;
  }>;
  get(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly alertId: string;
  }): Promise<PriceAlertV2Envelope>;
  replace(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly alertId: string;
    readonly body: unknown;
  }): Promise<PriceAlertV2Envelope>;
  delete(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly alertId: string;
    readonly expectedVersion: unknown;
  }): Promise<void>;
}

export interface CreateAlertV2ServiceInput {
  readonly repository: AlertV2Repository;
  readonly registry: ChainRegistryRepository;
  /** Market facts used to refuse an alert the evaluator could never price. */
  readonly facts: MarketFactService | null;
  readonly cursorCodec: V2CursorCodec | null;
  readonly chainId: string;
  /** Decision 0067; defaults to closed. */
  readonly pushRuntimeAvailable?: boolean;
  readonly now?: () => Date;
}

const listCursorRoute = "priceAlerts";
const listCursorFilter = "all";

export function digestPriceAlertV2Create(
  definition: PriceAlertV2Definition,
): string {
  return createHash("sha256")
    .update(PRICE_ALERT_V2_DIGEST_DOMAIN, "utf8")
    .update(
      JSON.stringify([
        "price_alert_create_v2",
        definition.assetId,
        definition.condition,
        definition.threshold,
        definition.expiresAt,
      ]),
      "utf8",
    )
    .digest("hex");
}

function isCondition(value: unknown): value is PriceAlertV2Condition {
  return (
    typeof value === "string" &&
    (priceAlertV2Conditions as readonly string[]).includes(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses the definition fields. Shape errors are `INVALID_REQUEST`; a
 * semantically wrong value that the schema cannot express (a threshold that
 * is not a positive decimal, an expiry that is not in the future) is
 * `VALIDATION_FAILED` so the client can show the field.
 */
export function parsePriceAlertV2Definition(
  body: unknown,
  now: Date,
): PriceAlertV2Definition {
  if (!isRecord(body)) {
    throw V2ApiError.invalidRequest();
  }
  const { assetId, condition, threshold, expiresAt } = body;
  if (!isAssetId(assetId) || !isCondition(condition)) {
    throw V2ApiError.invalidRequest();
  }
  let normalizedThreshold: string;
  try {
    normalizedThreshold = normalizeDecimalString(threshold);
  } catch (error) {
    if (error instanceof InvalidMarketDecimalError) {
      throw V2ApiError.invalidRequest();
    }
    throw error;
  }
  if (
    normalizedThreshold.startsWith("-") ||
    normalizedThreshold === "0" ||
    normalizedThreshold.length > 96 ||
    !isCanonicalDecimalString(normalizedThreshold)
  ) {
    throw V2ApiError.fromCode("VALIDATION_FAILED");
  }
  let normalizedExpiry: string | null = null;
  if (expiresAt !== null) {
    if (typeof expiresAt !== "string") {
      throw V2ApiError.invalidRequest();
    }
    const parsed = Date.parse(expiresAt);
    if (!Number.isFinite(parsed)) {
      throw V2ApiError.invalidRequest();
    }
    if (parsed <= now.getTime()) {
      throw V2ApiError.fromCode("VALIDATION_FAILED");
    }
    normalizedExpiry = new Date(parsed).toISOString();
  }
  return Object.freeze({
    assetId,
    condition,
    threshold: normalizedThreshold,
    expiresAt: normalizedExpiry,
  });
}

function translateRepositoryError(error: unknown): never {
  if (error instanceof AlertIdempotencyConflictError) {
    throw V2ApiError.idempotencyConflict();
  }
  if (error instanceof AlertIdempotencyResourceDeletedError) {
    throw V2ApiError.idempotencyConflict();
  }
  if (error instanceof AlertVersionConflictError) {
    throw V2ApiError.versionConflict();
  }
  if (error instanceof AlertExpiryNotFutureError) {
    throw V2ApiError.fromCode("VALIDATION_FAILED");
  }
  if (error instanceof AlertRepositoryUnavailableError) {
    throw V2ApiError.capabilityUnavailable();
  }
  throw error;
}

export function projectPriceAlertV2(
  record: PriceAlertV2Record,
  asset: AssetRecord | null,
  now: Date,
  pushRuntimeAvailable = false,
): PriceAlertV2Resource {
  const expired =
    record.state === "active" &&
    record.expiresAt !== null &&
    Date.parse(record.expiresAt) <= now.getTime();
  return Object.freeze({
    alertId: record.alertId,
    assetId: record.assetId,
    asset:
      asset === null
        ? null
        : Object.freeze({
            symbol: asset.symbol,
            name: asset.name,
            decimals: asset.decimals,
            status: asset.status,
          }),
    condition: record.condition,
    threshold: record.threshold,
    expiresAt: record.expiresAt,
    state: expired ? "expired" : record.state,
    triggeredAt: record.triggeredAt,
    lastEvaluatedAt: record.lastEvaluatedAt,
    delivery: Object.freeze(
      pushRuntimeAvailable
        ? { status: "available" as const, reasonCode: null }
        : {
            status: "unavailable" as const,
            reasonCode: notificationReasonCodes.pushDeferred,
          },
    ),
    version: record.recordVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function createAlertV2Service(
  input: CreateAlertV2ServiceInput,
): AlertV2Service {
  const now = input.now ?? ((): Date => new Date());

  async function requireReadableAsset(assetId: string): Promise<AssetRecord> {
    if (decomposeAssetId(assetId).chainId !== input.chainId) {
      throw V2ApiError.fromCode("CHAIN_MISMATCH");
    }
    const asset = await input.registry.getAsset(assetId);
    if (asset === null || asset.status === "blocked") {
      throw V2ApiError.fromCode("VALIDATION_FAILED");
    }
    // An alert must be priceable: the asset needs a DexScreener base pair
    // (the native asset through its proxy). A Provider outage at write time
    // is a retryable unavailability, not a validation verdict.
    if (input.facts === null) {
      throw V2ApiError.capabilityUnavailable();
    }
    const price = await input.facts.readAssetPrice(asset);
    if (price.fact.value === null) {
      throw V2ApiError.capabilityUnavailable();
    }
    if (price.pair === null || price.pair.priceUsd === null) {
      throw V2ApiError.fromCode("VALIDATION_FAILED");
    }
    return asset;
  }

  async function envelope(
    record: PriceAlertV2Record,
  ): Promise<PriceAlertV2Envelope> {
    const asset = await input.registry.getAsset(record.assetId);
    return Object.freeze({
      alert: projectPriceAlertV2(
        record,
        asset,
        now(),
        input.pushRuntimeAvailable === true,
      ),
      contractVersion: v2ContractVersion,
    });
  }

  const service: AlertV2Service = {
    async list({ principal, cursor, limit }) {
      const codec = input.cursorCodec;
      if (codec === null) {
        throw V2ApiError.capabilityUnavailable();
      }
      if (cursor !== undefined && limit !== undefined) {
        throw V2ApiError.invalidRequest();
      }
      let pageSize: number = priceAlertListLimits.default;
      let before:
        { readonly createdAt: string; readonly alertId: string } | undefined;
      if (typeof cursor === "string") {
        let continuation;
        try {
          continuation = codec.decode({
            ownerId: principal.userId,
            route: listCursorRoute,
            filter: listCursorFilter,
            cursor,
          });
        } catch (error) {
          if (error instanceof InvalidV2CursorError) {
            throw V2ApiError.invalidRequest();
          }
          throw error;
        }
        const createdAt = continuation["createdAt"];
        const alertId = continuation["alertId"];
        const size = continuation["limit"];
        if (
          typeof createdAt !== "string" ||
          typeof alertId !== "string" ||
          typeof size !== "number"
        ) {
          throw V2ApiError.invalidRequest();
        }
        before = { createdAt, alertId };
        pageSize = size;
      } else if (limit !== undefined) {
        if (
          typeof limit !== "number" ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > priceAlertListLimits.maximum
        ) {
          throw V2ApiError.invalidRequest();
        }
        pageSize = limit;
      } else if (cursor !== undefined) {
        throw V2ApiError.invalidRequest();
      }
      let page;
      try {
        page = await input.repository.listOwned({
          ownerUserId: principal.userId,
          limit: pageSize,
          ...(before === undefined ? {} : { before }),
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
      const assetIds = [...new Set(page.items.map((item) => item.assetId))];
      const assets = new Map(
        (await input.registry.listAssets(assetIds)).map((asset) => [
          asset.assetId,
          asset,
        ]),
      );
      const current = now();
      const last = page.items.at(-1);
      return Object.freeze({
        items: Object.freeze(
          page.items.map((record) =>
            projectPriceAlertV2(
              record,
              assets.get(record.assetId) ?? null,
              current,
              input.pushRuntimeAvailable === true,
            ),
          ),
        ),
        nextCursor:
          page.hasMore && last !== undefined
            ? codec.encode({
                ownerId: principal.userId,
                route: listCursorRoute,
                filter: listCursorFilter,
                continuation: {
                  createdAt: last.createdAt,
                  alertId: last.alertId,
                  limit: pageSize,
                },
              })
            : null,
        contractVersion: v2ContractVersion,
      });
    },

    async create({ principal, idempotencyKey, body }) {
      const definition = parsePriceAlertV2Definition(body, now());
      await requireReadableAsset(definition.assetId);
      try {
        const result = await input.repository.create({
          ownerUserId: principal.userId,
          idempotencyKey,
          requestSha256: digestPriceAlertV2Create(definition),
          definition,
        });
        if (result.alert.ownerUserId !== principal.userId) {
          throw new Error("Alert creation ownership invariant failed");
        }
        return Object.freeze({
          created: result.created,
          resource: await envelope(result.alert),
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async get({ principal, alertId }) {
      let record;
      try {
        record = await input.repository.findOwned(principal.userId, alertId);
      } catch (error) {
        return translateRepositoryError(error);
      }
      if (record === null) {
        throw V2ApiError.notFound();
      }
      return envelope(record);
    },

    async replace({ principal, alertId, body }) {
      if (!isRecord(body)) {
        throw V2ApiError.invalidRequest();
      }
      const { expectedVersion, ...definitionBody } = body;
      if (
        typeof expectedVersion !== "number" ||
        !Number.isInteger(expectedVersion) ||
        expectedVersion < 1
      ) {
        throw V2ApiError.invalidRequest();
      }
      const definition = parsePriceAlertV2Definition(definitionBody, now());
      await requireReadableAsset(definition.assetId);
      let record;
      try {
        record = await input.repository.replaceOwned({
          ownerUserId: principal.userId,
          alertId,
          expectedVersion,
          definition,
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
      if (record === null) {
        throw V2ApiError.notFound();
      }
      return envelope(record);
    },

    async delete({ principal, alertId, expectedVersion }) {
      if (
        typeof expectedVersion !== "number" ||
        !Number.isInteger(expectedVersion) ||
        expectedVersion < 1
      ) {
        throw V2ApiError.invalidRequest();
      }
      try {
        await input.repository.softDeleteOwned({
          ownerUserId: principal.userId,
          alertId,
          expectedVersion,
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },
  };
  return Object.freeze(service);
}
