import { randomUUID } from "node:crypto";
import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  InvalidPushPayloadError,
  createPushPayload,
  pushEventDictionary,
  pushEventTypes,
  pushPreferenceCategory,
  pushRateLimits,
  pushReasonCodes,
} from "../src/features/push/push-contract.js";
import {
  createPushDispatchService,
  createUnavailablePushDispatchService,
} from "../src/features/push/push-dispatch-service.js";
import type {
  PushDeliveryTarget,
  PushRepository,
  ReserveDeliveryResult,
} from "../src/features/push/push-repository.js";
import {
  classifyFcmFailure,
  createFcmMessage,
  createFcmSender,
  createServiceAccountAssertion,
  type FcmFetch,
  type FcmSender,
} from "../src/integrations/fcm/fcm-sender.js";
import {
  loadFirebaseServiceAccount,
  parseFirebaseServiceAccount,
} from "../src/integrations/fcm/service-account.js";

/**
 * Decision 0067. Nothing here reads a real credential file or reaches FCM:
 * the sender is driven by an injected fetch and a key pair generated in
 * memory, so the suite proves the contract without a Provider account.
 */

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();

const serviceAccountJson = JSON.stringify({
  type: "service_account",
  project_id: "loop-test",
  private_key: privateKeyPem,
  client_email: "push@loop-test.iam.gserviceaccount.com",
  token_uri: "https://oauth2.googleapis.com/token",
});

const account = parseFirebaseServiceAccount(serviceAccountJson);

const logger = { warn: vi.fn() };

function target(
  overrides: Partial<PushDeliveryTarget> = {},
): PushDeliveryTarget {
  return {
    pushTokenId: randomUUID(),
    ownerUserId: randomUUID(),
    platform: "ios",
    tokenSha256: "a".repeat(64),
    token: "d".repeat(64),
    ...overrides,
  };
}

interface RepositoryFake {
  readonly repository: PushRepository;
  readonly completed: {
    deliveryId: string;
    status: string;
    reasonCode: string | null;
  }[];
  readonly revoked: { pushTokenId: string; reason: string }[];
  readonly reservations: unknown[];
}

function repositoryFake(input: {
  readonly targets: readonly PushDeliveryTarget[];
  readonly reserve?: (index: number) => ReserveDeliveryResult;
}): RepositoryFake {
  const completed: RepositoryFake["completed"] = [];
  const revoked: RepositoryFake["revoked"] = [];
  const reservations: unknown[] = [];
  let index = -1;
  const repository: PushRepository = {
    registerToken: () => Promise.reject(new Error("not used")),
    unregisterToken: () => Promise.reject(new Error("not used")),
    findActiveTokenBySession: () => Promise.resolve(null),
    listOwnerTargets: vi.fn(() => Promise.resolve(input.targets)),
    listCommunityTargets: vi.fn(() => Promise.resolve(input.targets)),
    reserveDelivery: (reservation) => {
      reservations.push(reservation);
      index += 1;
      return Promise.resolve(
        input.reserve?.(index) ?? {
          outcome: "reserved" as const,
          deliveryId: randomUUID(),
        },
      );
    },
    completeDelivery: (completion) => {
      completed.push({
        deliveryId: completion.deliveryId,
        status: completion.status,
        reasonCode: completion.reasonCode,
      });
      return Promise.resolve();
    },
    revokeToken: (revocation) => {
      revoked.push(revocation);
      return Promise.resolve();
    },
  };
  return { repository, completed, revoked, reservations };
}

function senderFake(
  outcomes: readonly Awaited<ReturnType<FcmSender["send"]>>[],
): { readonly sender: FcmSender; readonly sent: unknown[] } {
  const sent: unknown[] = [];
  let index = 0;
  return {
    sent,
    sender: {
      projectId: "loop-test",
      send: (message) => {
        sent.push(message);
        const outcome = outcomes[Math.min(index, outcomes.length - 1)];
        index += 1;
        if (outcome === undefined) {
          throw new Error("no outcome configured");
        }
        return Promise.resolve(outcome);
      },
    },
  };
}

const dispatchRequest = {
  ownerUserId: randomUUID(),
  eventType: "price_alert_triggered" as const,
  entityRef: `priceAlert:${randomUUID()}`,
  contextRoute: "token",
  eventKey: "trade.priceAlert:alert:0",
};

describe("push contract (Decision 0067)", () => {
  it("defines every first-batch event with exactly one category", () => {
    expect([...pushEventTypes]).toEqual([
      "price_alert_triggered",
      "security_event",
      "community_voice_room_started",
      "community_application_verified",
      "community_application_rejected",
    ]);
    // Decision 0073: both review outcomes are optional community events.
    expect(pushEventDictionary.community_application_verified).toMatchObject({
      category: "community.announcement",
      mandatory: false,
      titleLocKey: "push.communityApplicationVerified.title",
      bodyLocKey: "push.communityApplicationVerified.body",
    });
    expect(pushEventDictionary.community_application_rejected).toMatchObject({
      category: "community.announcement",
      mandatory: false,
      titleLocKey: "push.communityApplicationRejected.title",
      bodyLocKey: "push.communityApplicationRejected.body",
    });
    expect(pushEventDictionary.security_event.mandatory).toBe(true);
    expect(pushEventDictionary.price_alert_triggered.mandatory).toBe(false);
    expect(pushEventDictionary.community_voice_room_started.mandatory).toBe(
      false,
    );
    expect(pushPreferenceCategory("security_event")).toBeNull();
    expect(pushPreferenceCategory("price_alert_triggered")).toBe(
      "trade.priceAlert",
    );
    expect(pushPreferenceCategory("community_voice_room_started")).toBe(
      "community.announcement",
    );
  });

  it("keeps the mandatory and optional hourly budgets separate", () => {
    expect(pushRateLimits.optionalPerDevicePerHour).toBeGreaterThan(0);
    expect(pushRateLimits.mandatoryPerDevicePerHour).toBeGreaterThan(0);
    expect(pushRateLimits.windowSeconds).toBe(3_600);
  });

  it("builds a pointer payload and nothing else", () => {
    const payload = createPushPayload({
      eventType: "security_event",
      entityRef: `deviceSession:${randomUUID()}`,
      contextRoute: "devices",
    });
    expect(Object.keys(payload).sort()).toEqual([
      "contextRoute",
      "entityRef",
      "eventVersion",
      "type",
    ]);
  });

  it("refuses an entityRef that could carry an address or an amount", () => {
    expect(() =>
      createPushPayload({
        eventType: "price_alert_triggered",
        entityRef: "token:eip155:56:0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
        contextRoute: "token",
      }),
    ).toThrow(InvalidPushPayloadError);
    expect(() =>
      createPushPayload({
        eventType: "price_alert_triggered",
        entityRef: `priceAlert:${randomUUID()}`,
        contextRoute: "Token Page 747.39",
      }),
    ).toThrow(InvalidPushPayloadError);
  });
});

describe("Firebase service account loading", () => {
  it("accepts a well-formed service account and keeps the key out of the projection", () => {
    expect(account.projectId).toBe("loop-test");
    expect(account.clientEmail).toBe("push@loop-test.iam.gserviceaccount.com");
    expect(Object.keys(account).sort()).toEqual([
      "clientEmail",
      "privateKeyPem",
      "projectId",
      "tokenUri",
    ]);
  });

  it("reports an unreadable file without repeating its path content", () => {
    expect(() =>
      loadFirebaseServiceAccount("/nowhere/service-account.json", () => {
        throw new Error("ENOENT");
      }),
    ).toThrow(
      expect.objectContaining({
        reasonCode: "PUSH_CREDENTIAL_FILE_UNREADABLE",
      }),
    );
  });

  it("refuses malformed JSON and a JSON document that is not a key", () => {
    expect(() => parseFirebaseServiceAccount("{")).toThrow(
      expect.objectContaining({
        reasonCode: "PUSH_CREDENTIAL_FILE_MALFORMED",
      }),
    );
    expect(() =>
      parseFirebaseServiceAccount(JSON.stringify({ type: "authorized_user" })),
    ).toThrow(
      expect.objectContaining({
        reasonCode: "PUSH_CREDENTIAL_FILE_INVALID",
      }),
    );
  });

  it("refuses a service account whose private key node:crypto cannot parse", () => {
    expect(() =>
      parseFirebaseServiceAccount(
        JSON.stringify({
          type: "service_account",
          project_id: "loop-test",
          private_key: "definitely not a key",
          client_email: "push@loop-test.iam.gserviceaccount.com",
        }),
      ),
    ).toThrow(
      expect.objectContaining({
        reasonCode: "PUSH_CREDENTIAL_FILE_INVALID",
      }),
    );
  });
});

describe("FCM HTTP v1 sender", () => {
  const payload = createPushPayload({
    eventType: "price_alert_triggered",
    entityRef: `priceAlert:${randomUUID()}`,
    contextRoute: "token",
  });

  it("signs an RS256 assertion with the service-account claims", () => {
    const assertion = createServiceAccountAssertion({
      account,
      issuedAtSeconds: 1_700_000_000,
    });
    const [header, claims, signature] = assertion.split(".");
    expect(signature).toBeDefined();
    expect(
      JSON.parse(Buffer.from(String(header), "base64url").toString("utf8")),
    ).toEqual({ alg: "RS256", typ: "JWT" });
    expect(
      JSON.parse(Buffer.from(String(claims), "base64url").toString("utf8")),
    ).toMatchObject({
      iss: account.clientEmail,
      aud: account.tokenUri,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
  });

  it("puts only the pointer and localization keys on the wire", () => {
    const message = createFcmMessage({ token: "t".repeat(64), payload }) as {
      readonly message: {
        readonly data: Record<string, string>;
        readonly android: { readonly notification: Record<string, string> };
        readonly apns: {
          readonly payload: {
            readonly aps: { readonly alert: Record<string, string> };
          };
        };
      };
    };
    expect(Object.keys(message.message.data).sort()).toEqual([
      "contextRoute",
      "entityRef",
      "eventVersion",
      "type",
    ]);
    expect(message.message.android.notification).toEqual({
      title_loc_key: "push_priceAlertTriggered_title",
      body_loc_key: "push_priceAlertTriggered_body",
    });
    expect(message.message.apns.payload.aps.alert).toEqual({
      "title-loc-key": "push.priceAlertTriggered.title",
      "loc-key": "push.priceAlertTriggered.body",
    });
    expect(JSON.stringify(message)).not.toContain("747");
  });

  it("exchanges the assertion once and reuses the access token", async () => {
    const calls: string[] = [];
    const fetchFake: FcmFetch = (url) => {
      calls.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            url.includes("oauth2")
              ? JSON.stringify({ access_token: "ya29.test", expires_in: 3600 })
              : JSON.stringify({ name: "projects/loop-test/messages/1" }),
          ),
      });
    };
    const sender = createFcmSender({ account, fetch: fetchFake });
    const first = await sender.send({
      token: "t".repeat(64),
      platform: "android",
      payload,
    });
    const second = await sender.send({
      token: "t".repeat(64),
      platform: "ios",
      payload,
    });
    expect(first).toEqual({
      outcome: "sent",
      providerMessageRef: "projects/loop-test/messages/1",
    });
    expect(second.outcome).toBe("sent");
    expect(calls.filter((url) => url.includes("oauth2"))).toHaveLength(1);
    expect(calls.filter((url) => url.includes("messages:send"))).toHaveLength(
      2,
    );
  });

  it("reports an unusable credential as unauthorized rather than sent", async () => {
    const fetchFake: FcmFetch = (url) =>
      Promise.resolve({
        ok: !url.includes("oauth2"),
        status: url.includes("oauth2") ? 400 : 200,
        text: () => Promise.resolve("{}"),
      });
    const sender = createFcmSender({ account, fetch: fetchFake });
    await expect(
      sender.send({ token: "t".repeat(64), platform: "ios", payload }),
    ).resolves.toEqual({
      outcome: "unauthorized",
      reasonCode: pushReasonCodes.providerUnauthorized,
    });
  });

  it("classifies UNREGISTERED and 404 as an invalid token, 5xx as transient", () => {
    expect(
      classifyFcmFailure(
        404,
        JSON.stringify({ error: { status: "NOT_FOUND" } }),
      ),
    ).toEqual({
      outcome: "invalidToken",
      reasonCode: pushReasonCodes.tokenUnregistered,
    });
    expect(
      classifyFcmFailure(
        400,
        JSON.stringify({
          error: {
            status: "INVALID_ARGUMENT",
            details: [{ errorCode: "INVALID_ARGUMENT" }],
          },
        }),
      ).outcome,
    ).toBe("invalidToken");
    expect(classifyFcmFailure(503, "upstream").outcome).toBe("transient");
    expect(classifyFcmFailure(401, "{}").outcome).toBe("unauthorized");
  });
});

describe("push dispatch", () => {
  it("is unavailable with PUSH_RUNTIME_DEFERRED when no credential is composed", async () => {
    const repository = repositoryFake({ targets: [target()] });
    const service = createPushDispatchService({
      repository: repository.repository,
      sender: null,
      logger,
    });
    expect(service.available).toBe(false);
    await expect(service.dispatchToOwner(dispatchRequest)).resolves.toEqual(
      expect.objectContaining({
        status: "unavailable",
        reasonCode: pushReasonCodes.runtimeDeferred,
      }),
    );
    // Nothing was reserved: an absent Provider writes no delivery row.
    expect(repository.reservations).toHaveLength(0);
  });

  it("sends one push per active device and records the outcome", async () => {
    const targets = [target(), target()];
    const repository = repositoryFake({ targets });
    const sender = senderFake([
      { outcome: "sent", providerMessageRef: "projects/loop-test/messages/1" },
    ]);
    const service = createPushDispatchService({
      repository: repository.repository,
      sender: sender.sender,
      logger,
    });
    const summary = await service.dispatchToOwner(dispatchRequest);
    expect(summary).toMatchObject({
      status: "delivered",
      attemptedCount: 2,
      sentCount: 2,
    });
    expect(sender.sent).toHaveLength(2);
    expect(repository.completed.map((row) => row.status)).toEqual([
      "sent",
      "sent",
    ]);
  });

  it("retires a token the Provider reports as unregistered", async () => {
    const only = target();
    const repository = repositoryFake({ targets: [only] });
    const sender = senderFake([
      {
        outcome: "invalidToken",
        reasonCode: pushReasonCodes.tokenUnregistered,
      },
    ]);
    const service = createPushDispatchService({
      repository: repository.repository,
      sender: sender.sender,
      logger,
    });
    const summary = await service.dispatchToOwner(dispatchRequest);
    expect(summary).toMatchObject({ status: "suppressed", sentCount: 0 });
    expect(repository.completed[0]?.status).toBe("invalid_token");
    expect(repository.revoked).toEqual([
      { pushTokenId: only.pushTokenId, reason: "provider_unregistered" },
    ]);
  });

  it("never sends twice for the same event and device", async () => {
    const repository = repositoryFake({
      targets: [target()],
      reserve: () => ({ outcome: "duplicate" }),
    });
    const sender = senderFake([{ outcome: "sent", providerMessageRef: null }]);
    const service = createPushDispatchService({
      repository: repository.repository,
      sender: sender.sender,
      logger,
    });
    await expect(service.dispatchToOwner(dispatchRequest)).resolves.toEqual(
      expect.objectContaining({
        status: "suppressed",
        reasonCode: pushReasonCodes.duplicateEvent,
        duplicateCount: 1,
      }),
    );
    expect(sender.sent).toHaveLength(0);
  });

  it("stops at the device's hourly budget without calling the Provider", async () => {
    const repository = repositoryFake({
      targets: [target()],
      reserve: () => ({ outcome: "rateLimited" }),
    });
    const sender = senderFake([{ outcome: "sent", providerMessageRef: null }]);
    const service = createPushDispatchService({
      repository: repository.repository,
      sender: sender.sender,
      logger,
    });
    await expect(service.dispatchToOwner(dispatchRequest)).resolves.toEqual(
      expect.objectContaining({
        status: "suppressed",
        reasonCode: pushReasonCodes.rateLimited,
        rateLimitedCount: 1,
      }),
    );
    expect(sender.sent).toHaveLength(0);
  });

  it("asks the repository for the preference gate of an optional event only", async () => {
    const repository = repositoryFake({ targets: [target()] });
    const sender = senderFake([{ outcome: "sent", providerMessageRef: null }]);
    const service = createPushDispatchService({
      repository: repository.repository,
      sender: sender.sender,
      logger,
    });
    await service.dispatchToOwner(dispatchRequest);
    await service.dispatchToOwner({
      ...dispatchRequest,
      eventType: "security_event",
      entityRef: `deviceSession:${randomUUID()}`,
      contextRoute: "devices",
      eventKey: "security_event:session:revoked",
    });
    const calls = (
      repository.repository.listOwnerTargets as unknown as {
        mock: { calls: readonly (readonly { categoryGate: unknown }[])[] };
      }
    ).mock.calls;
    expect(calls[0]?.[0]?.categoryGate).toEqual({
      category: "trade.priceAlert",
      defaultEnabled: true,
    });
    expect(calls[1]?.[0]?.categoryGate).toBeNull();
  });

  it("reports a repository failure as unavailable instead of failing the producer", async () => {
    const repository = repositoryFake({ targets: [target()] });
    const failing: PushRepository = {
      ...repository.repository,
      listOwnerTargets: () => Promise.reject(new Error("db down")),
    };
    const sender = senderFake([{ outcome: "sent", providerMessageRef: null }]);
    const service = createPushDispatchService({
      repository: failing,
      sender: sender.sender,
      logger,
    });
    await expect(service.dispatchToOwner(dispatchRequest)).resolves.toEqual(
      expect.objectContaining({
        status: "unavailable",
        reasonCode: pushReasonCodes.runtimeUnavailable,
      }),
    );
  });

  it("keeps the unavailable dispatcher inert", async () => {
    const service = createUnavailablePushDispatchService();
    expect(service.available).toBe(false);
    await expect(
      service.dispatchToCommunity({
        communityId: randomUUID(),
        excludeOwnerUserId: null,
        eventType: "community_voice_room_started",
        entityRef: `voiceRoom:${randomUUID()}`,
        contextRoute: "voice-room",
        eventKey: "voice-room",
      }),
    ).resolves.toMatchObject({ status: "unavailable" });
  });
});
