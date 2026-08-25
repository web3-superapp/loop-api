import { z } from "zod";

import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import {
  AlertExpiryNotFutureError,
  type AlertRepository,
  type NotificationPreferencesRecord,
  type PriceAlertEventRecord,
  type PriceAlertRecord,
} from "../../database/alert-repository.js";
import { deriveStreamUserId } from "../identity/loop-identifiers.js";
import {
  digestPriceAlertCreate,
  InvalidAlertContractError,
  parseNotificationPreferencesResource,
  parsePriceAlertDefinition,
  parsePriceAlertHistory,
  parsePriceAlertList,
  parsePriceAlertResource,
  parseReplaceNotificationPreferencesRequest,
  parseReplacePriceAlertRequest,
  type NotificationPreferencesResource,
  type PriceAlertHistory,
  type PriceAlertHistoryItem,
  type PriceAlertList,
  type PriceAlertResource,
} from "./alert-contract.js";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const principalSchema = z
  .object({
    userId: z.string().regex(uuidPattern),
    privyUserId: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[\x21-\x7e]+$/),
    streamUserId: z.string().min(1).max(63),
  })
  .strict();

const paginationSchema = z
  .object({
    limit: z.number().int().min(1).max(100),
    offset: z.number().int().min(0).max(10_000),
  })
  .strict();

export interface ListAlertsInput {
  readonly principal: AuthenticatedLoopPrincipal;
  readonly limit: number;
  readonly offset: number;
}

export interface CreateAlertInput {
  readonly principal: AuthenticatedLoopPrincipal;
  readonly idempotencyKey: string;
  readonly body: unknown;
}

export interface GetAlertInput {
  readonly principal: AuthenticatedLoopPrincipal;
  readonly alertId: string;
}

export interface ReplaceAlertInput extends GetAlertInput {
  readonly body: unknown;
}

export interface DeleteAlertInput extends GetAlertInput {
  readonly expectedVersion: number;
}

export interface ReplaceNotificationPreferencesInput {
  readonly principal: AuthenticatedLoopPrincipal;
  readonly body: unknown;
}

export interface AlertService {
  list(input: ListAlertsInput): Promise<PriceAlertList>;
  create(input: CreateAlertInput): Promise<PriceAlertResource>;
  get(input: GetAlertInput): Promise<PriceAlertResource>;
  replace(input: ReplaceAlertInput): Promise<PriceAlertResource>;
  delete(input: DeleteAlertInput): Promise<void>;
  history(input: ListAlertsInput): Promise<PriceAlertHistory>;
  getNotificationPreferences(
    principal: AuthenticatedLoopPrincipal,
  ): Promise<NotificationPreferencesResource>;
  replaceNotificationPreferences(
    input: ReplaceNotificationPreferencesInput,
  ): Promise<NotificationPreferencesResource>;
}

export class InvalidAlertRequestError extends Error {
  readonly code = "invalid_alert_request";

  constructor() {
    super("The alert request is invalid");
    this.name = "InvalidAlertRequestError";
  }
}

export class AlertNotFoundError extends Error {
  readonly code = "alert_not_found";

  constructor() {
    super("The alert was not found");
    this.name = "AlertNotFoundError";
  }
}

function invalidRequest(): never {
  throw new InvalidAlertRequestError();
}

function assertPrincipal(
  value: AuthenticatedLoopPrincipal,
): AuthenticatedLoopPrincipal {
  const parsed = principalSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.streamUserId !== deriveStreamUserId(parsed.data.userId)
  ) {
    return invalidRequest();
  }
  return parsed.data;
}

function assertUuid(value: unknown): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    return invalidRequest();
  }
  return value;
}

function parsePagination(
  limit: unknown,
  offset: unknown,
): { readonly limit: number; readonly offset: number } {
  const parsed = paginationSchema.safeParse({ limit, offset });
  if (!parsed.success) {
    return invalidRequest();
  }
  return parsed.data;
}

function toResource(record: PriceAlertRecord): PriceAlertResource {
  return parsePriceAlertResource({
    alert_id: record.id,
    asset_key: record.assetKey,
    condition: record.condition,
    threshold_decimal: record.thresholdDecimal,
    expires_at: record.expiresAt,
    state: "inactive",
    evaluation: { state: "unavailable" },
    delivery: { state: "unavailable" },
    version: record.recordVersion,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  });
}

function assertOwnedRecord(
  record: PriceAlertRecord,
  ownerUserId: string,
): PriceAlertRecord {
  if (record.ownerUserId !== ownerUserId || record.deletedAt !== null) {
    throw new AlertNotFoundError();
  }
  return record;
}

function toHistoryItem(
  record: PriceAlertEventRecord,
  ownerUserId: string,
): PriceAlertHistoryItem {
  if (record.ownerUserId !== ownerUserId) {
    throw new Error("Alert history ownership invariant failed");
  }
  return {
    event_id: record.id,
    alert_id: record.alertId,
    asset_key: record.assetKey,
    condition: record.condition,
    threshold_decimal: record.thresholdDecimal,
    value_decimal: record.valueDecimal,
    source: record.source,
    source_fact_ref: record.sourceFactRef,
    observed_at: record.observedAt,
    created_at: record.createdAt,
  };
}

function toPreferencesResource(
  record: NotificationPreferencesRecord,
): NotificationPreferencesResource {
  return parseNotificationPreferencesResource({
    version: record.recordVersion,
    preferences: record.preferences,
    delivery: { state: "unavailable" },
  });
}

function mapInvalidContract(error: unknown): never {
  if (
    error instanceof InvalidAlertContractError ||
    error instanceof AlertExpiryNotFutureError
  ) {
    throw new InvalidAlertRequestError();
  }
  throw error;
}

export function createAlertService(input: {
  readonly repository: AlertRepository;
}): AlertService {
  return Object.freeze({
    async list(rawInput: ListAlertsInput) {
      const principal = assertPrincipal(rawInput.principal);
      const pagination = parsePagination(rawInput.limit, rawInput.offset);
      const result = await input.repository.listOwned({
        ownerUserId: principal.userId,
        ...pagination,
      });
      return parsePriceAlertList({
        items: result.records.map((record) =>
          toResource(assertOwnedRecord(record, principal.userId)),
        ),
        next_offset: result.nextOffset,
      });
    },

    async create(rawInput: CreateAlertInput) {
      const principal = assertPrincipal(rawInput.principal);
      const idempotencyKey = assertUuid(rawInput.idempotencyKey);
      try {
        const definition = parsePriceAlertDefinition(rawInput.body);
        const result = await input.repository.create({
          ownerUserId: principal.userId,
          idempotencyKey,
          requestSha256: digestPriceAlertCreate(definition),
          definition,
        });
        if (result.alert.ownerUserId !== principal.userId) {
          throw new Error("Alert creation ownership invariant failed");
        }
        return toResource(result.alert);
      } catch (error) {
        return mapInvalidContract(error);
      }
    },

    async get(rawInput: GetAlertInput) {
      const principal = assertPrincipal(rawInput.principal);
      const alertId = assertUuid(rawInput.alertId);
      const record = await input.repository.findOwned(
        principal.userId,
        alertId,
      );
      if (record === null) {
        throw new AlertNotFoundError();
      }
      return toResource(assertOwnedRecord(record, principal.userId));
    },

    async replace(rawInput: ReplaceAlertInput) {
      const principal = assertPrincipal(rawInput.principal);
      const alertId = assertUuid(rawInput.alertId);
      try {
        const request = parseReplacePriceAlertRequest(rawInput.body);
        const record = await input.repository.replaceOwned({
          ownerUserId: principal.userId,
          alertId,
          expectedVersion: request.expected_version,
          definition: {
            asset_key: request.asset_key,
            condition: request.condition,
            threshold_decimal: request.threshold_decimal,
            expires_at: request.expires_at,
          },
        });
        if (record === null) {
          throw new AlertNotFoundError();
        }
        return toResource(assertOwnedRecord(record, principal.userId));
      } catch (error) {
        return mapInvalidContract(error);
      }
    },

    async delete(rawInput: DeleteAlertInput) {
      const principal = assertPrincipal(rawInput.principal);
      const alertId = assertUuid(rawInput.alertId);
      if (
        !Number.isInteger(rawInput.expectedVersion) ||
        rawInput.expectedVersion < 1
      ) {
        return invalidRequest();
      }
      await input.repository.softDeleteOwned({
        ownerUserId: principal.userId,
        alertId,
        expectedVersion: rawInput.expectedVersion,
      });
    },

    async history(rawInput: ListAlertsInput) {
      const principal = assertPrincipal(rawInput.principal);
      const pagination = parsePagination(rawInput.limit, rawInput.offset);
      const result = await input.repository.listHistory({
        ownerUserId: principal.userId,
        ...pagination,
      });
      return parsePriceAlertHistory({
        items: result.records.map((record) =>
          toHistoryItem(record, principal.userId),
        ),
        next_offset: result.nextOffset,
      });
    },

    async getNotificationPreferences(rawPrincipal: AuthenticatedLoopPrincipal) {
      const principal = assertPrincipal(rawPrincipal);
      return toPreferencesResource(
        await input.repository.getNotificationPreferences(principal.userId),
      );
    },

    async replaceNotificationPreferences(
      rawInput: ReplaceNotificationPreferencesInput,
    ) {
      const principal = assertPrincipal(rawInput.principal);
      try {
        const request = parseReplaceNotificationPreferencesRequest(
          rawInput.body,
        );
        return toPreferencesResource(
          await input.repository.replaceNotificationPreferences({
            ownerUserId: principal.userId,
            expectedVersion: request.expected_version,
            preferences: request.preferences,
          }),
        );
      } catch (error) {
        return mapInvalidContract(error);
      }
    },
  });
}
