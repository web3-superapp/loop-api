import { defaultNotificationPreferences } from "../alerts/notification-contract.js";
import type { FcmSender } from "../../integrations/fcm/fcm-sender.js";
import {
  createPushPayload,
  pushCommunityAudienceLimit,
  pushEventDictionary,
  pushOwnerAudienceLimit,
  pushPreferenceCategory,
  pushRateLimits,
  pushReasonCodes,
  type PushEventType,
} from "./push-contract.js";
import type {
  PushCategoryGate,
  PushDeliveryTarget,
  PushRepository,
} from "./push-repository.js";

/**
 * Push dispatch (Decision 0067).
 *
 * Push is the second copy of a fact the in-app feed already holds. Every
 * outcome here — no credential, preference off, no device, duplicate, budget
 * spent, Provider failure — leaves the feed row untouched and never fails the
 * producer's own command. The dispatcher therefore returns a summary and
 * throws nothing.
 *
 * Ordering is deliberate: the at-most-once slot and the per-device hourly
 * budget are taken *before* the Provider call, so a Provider timeout can
 * never turn into a second push for the same event.
 */

export interface PushDispatchLogger {
  warn(context: Record<string, unknown>, message: string): void;
}

export interface PushDispatchSummary {
  readonly status: "delivered" | "suppressed" | "unavailable";
  /** Set when nothing was attempted at all. */
  readonly reasonCode: string | null;
  readonly attemptedCount: number;
  readonly sentCount: number;
  readonly duplicateCount: number;
  readonly rateLimitedCount: number;
  readonly failedCount: number;
  readonly invalidTokenCount: number;
  readonly audienceTruncated: boolean;
}

export interface OwnerPushDispatchInput {
  readonly ownerUserId: string;
  readonly eventType: PushEventType;
  readonly entityRef: string;
  readonly contextRoute: string;
  /**
   * Producer-chosen collapse key. One `(device, eventKey)` pair is delivered
   * at most once, for the lifetime of the token row.
   */
  readonly eventKey: string;
  readonly signal?: AbortSignal;
}

export interface CommunityPushDispatchInput extends Omit<
  OwnerPushDispatchInput,
  "ownerUserId"
> {
  readonly communityId: string;
  /** Usually the actor: nobody is pushed about their own action. */
  readonly excludeOwnerUserId: string | null;
}

export interface PushDispatchService {
  readonly available: boolean;
  dispatchToOwner(input: OwnerPushDispatchInput): Promise<PushDispatchSummary>;
  dispatchToCommunity(
    input: CommunityPushDispatchInput,
  ): Promise<PushDispatchSummary>;
}

export interface CreatePushDispatchServiceInput {
  readonly repository: PushRepository;
  /** `null` whenever the Firebase credential is missing or unusable. */
  readonly sender: FcmSender | null;
  readonly logger: PushDispatchLogger;
}

function summary(
  overrides: Partial<PushDispatchSummary> & {
    readonly status: PushDispatchSummary["status"];
  },
): PushDispatchSummary {
  return Object.freeze({
    reasonCode: null,
    attemptedCount: 0,
    sentCount: 0,
    duplicateCount: 0,
    rateLimitedCount: 0,
    failedCount: 0,
    invalidTokenCount: 0,
    audienceTruncated: false,
    ...overrides,
  });
}

function categoryGate(eventType: PushEventType): PushCategoryGate | null {
  const category = pushPreferenceCategory(eventType);
  return category === null
    ? null
    : Object.freeze({
        category,
        defaultEnabled: defaultNotificationPreferences[category],
      });
}

export function createPushDispatchService(
  input: CreatePushDispatchServiceInput,
): PushDispatchService {
  const available = input.sender !== null;

  async function deliver(
    targets: readonly PushDeliveryTarget[],
    request: {
      readonly eventType: PushEventType;
      readonly entityRef: string;
      readonly contextRoute: string;
      readonly eventKey: string;
      readonly signal?: AbortSignal;
    },
    audienceTruncated: boolean,
  ): Promise<PushDispatchSummary> {
    const sender = input.sender;
    if (sender === null) {
      return summary({
        status: "unavailable",
        reasonCode: pushReasonCodes.runtimeDeferred,
      });
    }
    if (targets.length === 0) {
      return summary({
        status: "suppressed",
        reasonCode: pushReasonCodes.noRegisteredDevice,
        audienceTruncated,
      });
    }
    const definition = pushEventDictionary[request.eventType];
    // Throws on a producer bug (an address or an amount in the pointer)
    // before any row or Provider call exists.
    const payload = createPushPayload({
      eventType: request.eventType,
      entityRef: request.entityRef,
      contextRoute: request.contextRoute,
    });
    let attemptedCount = 0;
    let sentCount = 0;
    let duplicateCount = 0;
    let rateLimitedCount = 0;
    let failedCount = 0;
    let invalidTokenCount = 0;

    for (const target of targets) {
      const reservation = await input.repository.reserveDelivery({
        ownerUserId: target.ownerUserId,
        pushTokenId: target.pushTokenId,
        eventType: request.eventType,
        eventKey: request.eventKey,
        mandatory: definition.mandatory,
        windowSeconds: pushRateLimits.windowSeconds,
        limit: definition.mandatory
          ? pushRateLimits.mandatoryPerDevicePerHour
          : pushRateLimits.optionalPerDevicePerHour,
      });
      if (reservation.outcome === "duplicate") {
        duplicateCount += 1;
        continue;
      }
      if (reservation.outcome === "rateLimited") {
        rateLimitedCount += 1;
        continue;
      }
      attemptedCount += 1;
      const result = await sender.send({
        token: target.token,
        platform: target.platform,
        payload,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      if (result.outcome === "sent") {
        sentCount += 1;
        await input.repository.completeDelivery({
          deliveryId: reservation.deliveryId,
          status: "sent",
          reasonCode: null,
          providerMessageRef: result.providerMessageRef,
        });
        continue;
      }
      if (result.outcome === "invalidToken") {
        invalidTokenCount += 1;
        await input.repository.completeDelivery({
          deliveryId: reservation.deliveryId,
          status: "invalid_token",
          reasonCode: result.reasonCode,
          providerMessageRef: null,
        });
        // The handset no longer accepts this token: stop addressing it.
        await input.repository.revokeToken({
          pushTokenId: target.pushTokenId,
          reason: "provider_unregistered",
        });
        continue;
      }
      failedCount += 1;
      await input.repository.completeDelivery({
        deliveryId: reservation.deliveryId,
        status: "failed",
        reasonCode: result.reasonCode,
        providerMessageRef: null,
      });
      input.logger.warn(
        {
          eventType: request.eventType,
          tokenSha256: target.tokenSha256,
          reasonCode: result.reasonCode,
        },
        "LOOP push delivery was not confirmed by the Provider",
      );
    }

    if (sentCount > 0) {
      return summary({
        status: "delivered",
        attemptedCount,
        sentCount,
        duplicateCount,
        rateLimitedCount,
        failedCount,
        invalidTokenCount,
        audienceTruncated,
      });
    }
    return summary({
      status: "suppressed",
      reasonCode:
        attemptedCount > 0
          ? pushReasonCodes.providerUnreachable
          : duplicateCount > 0
            ? pushReasonCodes.duplicateEvent
            : rateLimitedCount > 0
              ? pushReasonCodes.rateLimited
              : pushReasonCodes.noRegisteredDevice,
      attemptedCount,
      sentCount,
      duplicateCount,
      rateLimitedCount,
      failedCount,
      invalidTokenCount,
      audienceTruncated,
    });
  }

  async function guarded(
    operation: () => Promise<PushDispatchSummary>,
    context: Record<string, unknown>,
  ): Promise<PushDispatchSummary> {
    try {
      return await operation();
    } catch (error) {
      // Push is best effort. A repository or Provider failure is logged
      // with safe fields only and never reaches the producer's command.
      input.logger.warn(
        {
          ...context,
          errorName: error instanceof Error ? error.name : "unknown",
        },
        "LOOP push dispatch failed",
      );
      return summary({
        status: "unavailable",
        reasonCode: pushReasonCodes.runtimeUnavailable,
      });
    }
  }

  const service: PushDispatchService = {
    available,

    dispatchToOwner(request) {
      if (input.sender === null) {
        return Promise.resolve(
          summary({
            status: "unavailable",
            reasonCode: pushReasonCodes.runtimeDeferred,
          }),
        );
      }
      return guarded(
        async () => {
          const targets = await input.repository.listOwnerTargets({
            ownerUserId: request.ownerUserId,
            categoryGate: categoryGate(request.eventType),
            limit: pushOwnerAudienceLimit,
          });
          if (targets.length === 0) {
            // Either the owner has no device or the category is switched
            // off; both are reported as "nothing to deliver to", and the
            // preference itself is never echoed back to a producer.
            return summary({
              status: "suppressed",
              reasonCode: pushReasonCodes.noRegisteredDevice,
            });
          }
          return deliver(targets, request, false);
        },
        { eventType: request.eventType },
      );
    },

    dispatchToCommunity(request) {
      if (input.sender === null) {
        return Promise.resolve(
          summary({
            status: "unavailable",
            reasonCode: pushReasonCodes.runtimeDeferred,
          }),
        );
      }
      return guarded(
        async () => {
          const targets = await input.repository.listCommunityTargets({
            communityId: request.communityId,
            excludeOwnerUserId: request.excludeOwnerUserId,
            categoryGate: categoryGate(request.eventType),
            limit: pushCommunityAudienceLimit + 1,
          });
          const truncated = targets.length > pushCommunityAudienceLimit;
          if (truncated) {
            input.logger.warn(
              {
                eventType: request.eventType,
                reasonCode: pushReasonCodes.audienceTruncated,
                audienceLimit: pushCommunityAudienceLimit,
              },
              "LOOP community push audience was truncated",
            );
          }
          return deliver(
            targets.slice(0, pushCommunityAudienceLimit),
            request,
            truncated,
          );
        },
        { eventType: request.eventType },
      );
    },
  };
  return Object.freeze(service);
}

/** Composed when no push runtime exists; every call is a no-op. */
export function createUnavailablePushDispatchService(): PushDispatchService {
  const unavailable = (): Promise<PushDispatchSummary> =>
    Promise.resolve(
      summary({
        status: "unavailable",
        reasonCode: pushReasonCodes.runtimeDeferred,
      }),
    );
  return Object.freeze({
    available: false,
    dispatchToOwner: unavailable,
    dispatchToCommunity: unavailable,
  });
}
