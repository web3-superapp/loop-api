import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import {
  InvalidV2CursorError,
  type V2CursorCodec,
} from "../../core/http/v2-cursor.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import {
  AlertRepositoryUnavailableError,
  AlertVersionConflictError,
} from "../../database/alert-repository.js";
import type {
  NotificationPreferenceValues,
  NotificationRecord,
  NotificationRepository,
} from "../../database/notification-repository.js";
import { isOpaqueId } from "../../core/ids/opaque-id.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import {
  mandatoryNotificationCategory,
  notificationCategories,
  notificationFeedLimits,
  notificationReasonCodes,
  optionalNotificationCategories,
  type NotificationCategory,
} from "./notification-contract.js";

/**
 * Context notification feed, read acknowledgement, and the ten-category V2
 * preferences (D14, Decision 0034).
 *
 * There is no notification centre: the feed is the source the client reads
 * from inside the contexts that own its entries (Token page, alerts page).
 * Push delivery is always `unavailable` with `PUSH_RUNTIME_DEFERRED`.
 */

export interface NotificationProjection {
  readonly notificationId: string;
  readonly type: NotificationCategory;
  readonly entityRef: string;
  readonly contextRoute: string;
  readonly contextParams: Readonly<Record<string, string>>;
  readonly payload: Readonly<Record<string, string | null>>;
  readonly source: string | null;
  readonly observedAt: string | null;
  readonly readAt: string | null;
  readonly createdAt: string;
}

export interface UnavailableDelivery {
  readonly status: "unavailable";
  readonly reasonCode: string;
}

export interface NotificationFeedResource {
  readonly items: readonly NotificationProjection[];
  readonly nextCursor: string | null;
  readonly unreadCount: number;
  readonly push: UnavailableDelivery;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface NotificationEnvelope {
  readonly notification: NotificationProjection;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface NotificationPreferenceCategoryProjection {
  readonly enabled: boolean;
  /** `true` only for `security.event`, which cannot be disabled. */
  readonly locked: boolean;
}

export interface NotificationPreferencesResource {
  readonly version: number;
  readonly updatedAt: string | null;
  readonly categories: Readonly<
    Record<NotificationCategory, NotificationPreferenceCategoryProjection>
  >;
  readonly push: UnavailableDelivery;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface NotificationService {
  listFeed(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly cursor?: unknown;
    readonly limit?: unknown;
  }): Promise<NotificationFeedResource>;
  markRead(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly notificationId: string;
  }): Promise<NotificationEnvelope>;
  getPreferences(input: {
    readonly principal: AuthenticatedLoopPrincipal;
  }): Promise<NotificationPreferencesResource>;
  replacePreferences(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly body: unknown;
  }): Promise<NotificationPreferencesResource>;
}

export interface CreateNotificationServiceInput {
  readonly repository: NotificationRepository;
  readonly cursorCodec: V2CursorCodec | null;
}

const feedCursorRoute = "notificationsFeed";
const feedCursorFilter = "all";

const pushUnavailable: UnavailableDelivery = Object.freeze({
  status: "unavailable",
  reasonCode: notificationReasonCodes.pushDeferred,
});

function project(record: NotificationRecord): NotificationProjection {
  return Object.freeze({
    notificationId: record.notificationId,
    type: record.type,
    entityRef: record.entityRef,
    contextRoute: record.contextRoute,
    contextParams: record.contextParams,
    payload: record.payload,
    source: record.source,
    observedAt: record.observedAt,
    readAt: record.readAt,
    createdAt: record.createdAt,
  });
}

function projectPreferences(record: {
  readonly recordVersion: number;
  readonly updatedAt: string | null;
  readonly values: NotificationPreferenceValues;
}): NotificationPreferencesResource {
  const categories: Record<string, NotificationPreferenceCategoryProjection> =
    {};
  for (const category of optionalNotificationCategories) {
    categories[category] = Object.freeze({
      enabled: record.values[category],
      locked: false,
    });
  }
  categories[mandatoryNotificationCategory] = Object.freeze({
    enabled: true,
    locked: true,
  });
  return Object.freeze({
    version: record.recordVersion,
    updatedAt: record.updatedAt,
    categories: Object.freeze(categories),
    push: pushUnavailable,
    contractVersion: v2ContractVersion,
  });
}

function translate(error: unknown): never {
  if (error instanceof AlertVersionConflictError) {
    throw V2ApiError.versionConflict();
  }
  if (error instanceof AlertRepositoryUnavailableError) {
    throw V2ApiError.capabilityUnavailable();
  }
  throw error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The write must carry all ten categories. `security.event` must be `true`:
 * a request that tries to disable it is rejected (INVALID_REQUEST), not
 * silently corrected, so a client cannot believe it succeeded.
 */
export function parseNotificationPreferencesWrite(body: unknown): {
  readonly expectedVersion: number;
  readonly values: NotificationPreferenceValues;
} {
  if (!isRecord(body)) {
    throw V2ApiError.invalidRequest();
  }
  const { expectedVersion, categories } = body;
  if (
    typeof expectedVersion !== "number" ||
    !Number.isInteger(expectedVersion) ||
    expectedVersion < 0 ||
    !isRecord(categories)
  ) {
    throw V2ApiError.invalidRequest();
  }
  const keys = Object.keys(categories);
  if (
    keys.length !== notificationCategories.length ||
    !notificationCategories.every((category) => category in categories)
  ) {
    throw V2ApiError.invalidRequest();
  }
  const values: Record<string, boolean> = {};
  for (const category of notificationCategories) {
    const value = categories[category];
    if (typeof value !== "boolean") {
      throw V2ApiError.invalidRequest();
    }
    if (category === mandatoryNotificationCategory) {
      if (!value) {
        throw V2ApiError.invalidRequest();
      }
      continue;
    }
    values[category] = value;
  }
  return Object.freeze({
    expectedVersion,
    values: Object.freeze(values),
  });
}

export function createNotificationService(
  input: CreateNotificationServiceInput,
): NotificationService {
  const service: NotificationService = {
    async listFeed({ principal, cursor, limit }) {
      const codec = input.cursorCodec;
      if (codec === null) {
        throw V2ApiError.capabilityUnavailable();
      }
      if (cursor !== undefined && limit !== undefined) {
        throw V2ApiError.invalidRequest();
      }
      let pageSize: number = notificationFeedLimits.default;
      let before:
        | { readonly createdAt: string; readonly notificationId: string }
        | undefined;
      if (typeof cursor === "string") {
        let continuation;
        try {
          continuation = codec.decode({
            ownerId: principal.userId,
            route: feedCursorRoute,
            filter: feedCursorFilter,
            cursor,
          });
        } catch (error) {
          if (error instanceof InvalidV2CursorError) {
            throw V2ApiError.invalidRequest();
          }
          throw error;
        }
        const createdAt = continuation["createdAt"];
        const notificationId = continuation["notificationId"];
        const size = continuation["limit"];
        if (
          typeof createdAt !== "string" ||
          typeof notificationId !== "string" ||
          typeof size !== "number"
        ) {
          throw V2ApiError.invalidRequest();
        }
        before = { createdAt, notificationId };
        pageSize = size;
      } else if (limit !== undefined) {
        if (
          typeof limit !== "number" ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > notificationFeedLimits.maximum
        ) {
          throw V2ApiError.invalidRequest();
        }
        pageSize = limit;
      } else if (cursor !== undefined) {
        throw V2ApiError.invalidRequest();
      }
      let page;
      try {
        page = await input.repository.listFeed({
          ownerUserId: principal.userId,
          limit: pageSize,
          ...(before === undefined ? {} : { before }),
        });
      } catch (error) {
        return translate(error);
      }
      const last = page.items.at(-1);
      return Object.freeze({
        items: Object.freeze(page.items.map(project)),
        nextCursor:
          page.hasMore && last !== undefined
            ? codec.encode({
                ownerId: principal.userId,
                route: feedCursorRoute,
                filter: feedCursorFilter,
                continuation: {
                  createdAt: last.createdAtCursor,
                  notificationId: last.notificationId,
                  limit: pageSize,
                },
              })
            : null,
        unreadCount: page.unreadCount,
        push: pushUnavailable,
        contractVersion: v2ContractVersion,
      });
    },

    async markRead({ principal, notificationId }) {
      if (!isOpaqueId(notificationId)) {
        throw V2ApiError.invalidRequest();
      }
      let record;
      try {
        record = await input.repository.markRead(
          principal.userId,
          notificationId,
        );
      } catch (error) {
        return translate(error);
      }
      if (record === null) {
        throw V2ApiError.notFound();
      }
      return Object.freeze({
        notification: project(record),
        contractVersion: v2ContractVersion,
      });
    },

    async getPreferences({ principal }) {
      try {
        return projectPreferences(
          await input.repository.getPreferences(principal.userId),
        );
      } catch (error) {
        return translate(error);
      }
    },

    async replacePreferences({ principal, body }) {
      const request = parseNotificationPreferencesWrite(body);
      try {
        return projectPreferences(
          await input.repository.replacePreferences({
            ownerUserId: principal.userId,
            expectedVersion: request.expectedVersion,
            values: request.values,
          }),
        );
      } catch (error) {
        return translate(error);
      }
    },
  };
  return Object.freeze(service);
}
