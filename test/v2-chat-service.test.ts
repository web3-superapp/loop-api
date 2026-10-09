import { describe, expect, it, vi } from "vitest";

import { V2ApiError } from "../src/core/http/v2-error.js";
import type { AuthenticatedLoopPrincipal } from "../src/core/http/authentication.js";
import type { ChatOperationResource } from "../src/features/communication/chat-channel-contract.js";
import {
  ChatChannelIdempotencyConflictError,
  ChatChannelTargetUnavailableError,
  ChatChannelUnavailableError,
  ChatOperationNotFoundError,
  type ChatChannelService,
} from "../src/features/communication/chat-channel-service.js";
import { createUnavailableCommunicationRepository } from "../src/features/communication/communication-repository.js";
import {
  createUnavailableV2ChatService,
  createV2ChatService,
} from "../src/features/communication/v2-chat-service.js";
import {
  StreamTokenQuotaExceededError,
  StreamTokenUnavailableError,
  type StreamTokenService,
} from "../src/features/communication/stream-token-service.js";
import { createUnavailableStreamCommunityChannelGateway } from "../src/integrations/stream/channel-gateway.js";

const accountId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const targetProfileId = "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f";
const secondProfileId = "1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d";
const operationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbba";
const requestId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const groupChannelId = "loop_group_0123456789abcdef0123456789abcdef";
const createdAt = "2026-09-08T01:00:00.000Z";

const principal: AuthenticatedLoopPrincipal = Object.freeze({
  userId: accountId,
  privyUserId: "did:privy:verified-user",
  streamUserId: `loop_${accountId.replaceAll("-", "")}`,
});

function operation(
  overrides: Partial<ChatOperationResource> = {},
): ChatOperationResource {
  return Object.freeze({
    operation_id: operationId,
    kind: "group_create" as const,
    status: "succeeded" as const,
    terminal: true,
    retry_after_ms: null,
    result: {
      group_id: targetProfileId,
      name: "Frog Squad",
      friend_public_profile_ids: [targetProfileId, secondProfileId],
      stream_cid: `messaging:${groupChannelId}`,
    },
    error: null,
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides,
  });
}

function chatChannelServiceFake(
  overrides: Partial<ChatChannelService> = {},
): ChatChannelService {
  return {
    createGroup: vi.fn(() => Promise.resolve(operation())),
    getOrCreateDirect: vi.fn(() => Promise.resolve(operation())),
    getOperation: vi.fn(() => Promise.resolve(operation())),
    ...overrides,
  };
}

function streamTokenServiceFake(
  overrides: Partial<StreamTokenService> = {},
): StreamTokenService {
  return {
    issueToken: vi.fn(() =>
      Promise.resolve({
        api_key: "stream_key",
        token: "a".repeat(40),
        expires_at: createdAt,
        user: { id: principal.streamUserId },
      }),
    ),
    ...overrides,
  };
}

function service(overrides: Partial<ChatChannelService> = {}) {
  return createV2ChatService({
    chatChannelService: chatChannelServiceFake(overrides),
    streamTokenService: streamTokenServiceFake(),
    repository: createUnavailableCommunicationRepository(),
    channelGateway: createUnavailableStreamCommunityChannelGateway(),
  });
}

function command(body: unknown) {
  return {
    principal,
    idempotencyKey: operationId,
    requestId,
    body,
    signal: new AbortController().signal,
  };
}

describe("V2 chat wrapper over the frozen V1 surface", () => {
  it("projects the V1 operation into camelCase without changing the state machine", async () => {
    const resource = await service().createGroup(
      command({
        name: "Frog Squad",
        friendPublicProfileIds: [targetProfileId, secondProfileId],
      }),
    );

    expect(resource).toEqual({
      operationId,
      kind: "groupCreate",
      status: "succeeded",
      terminal: true,
      retryAfterMs: null,
      result: {
        groupId: targetProfileId,
        name: "Frog Squad",
        friendPublicProfileIds: [targetProfileId, secondProfileId],
        streamCid: `messaging:${groupChannelId}`,
      },
      error: null,
      createdAt,
      updatedAt: createdAt,
      contractVersion: "2.0",
    });
  });

  it("passes the idempotency key through as the durable operation ID", async () => {
    const createGroup = vi.fn(() => Promise.resolve(operation()));
    await service({ createGroup }).createGroup(
      command({
        name: "Frog Squad",
        friendPublicProfileIds: [targetProfileId, secondProfileId],
      }),
    );
    expect(createGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId,
        requestId,
        body: {
          name: "Frog Squad",
          friend_public_profile_ids: [targetProfileId, secondProfileId],
        },
      }),
    );
  });

  it("keeps every nonterminal V1 status, including operatorRequired", async () => {
    for (const [v1, v2] of [
      ["pending", "pending"],
      ["submitting", "submitting"],
      ["reconciling", "reconciling"],
      ["failed", "failed"],
      ["operator_required", "operatorRequired"],
    ] as const) {
      const getOperation = vi.fn(() =>
        Promise.resolve(
          operation({
            status: v1,
            terminal: v1 === "failed" || v1 === "operator_required",
            retry_after_ms:
              v1 === "failed" || v1 === "operator_required" ? null : 2_000,
            result: null,
            error:
              v1 === "failed" || v1 === "operator_required"
                ? { code: "stream_channel_not_created" }
                : null,
          }),
        ),
      );
      const resource = await service({ getOperation }).getOperation({
        principal,
        operationId,
        requestId,
        signal: new AbortController().signal,
      });
      expect(resource.status).toBe(v2);
    }
  });

  it("projects the direct result shape", async () => {
    const getOrCreateDirect = vi.fn(() =>
      Promise.resolve(
        operation({
          kind: "direct_get_or_create",
          result: {
            target_public_profile_id: targetProfileId,
            stream_cid:
              "messaging:loop_direct_0123456789abcdef0123456789abcdef",
          },
        }),
      ),
    );
    const resource = await service({ getOrCreateDirect }).getOrCreateDirect(
      command({ targetPublicProfileId: targetProfileId }),
    );
    expect(resource.kind).toBe("directGetOrCreate");
    expect(resource.result).toEqual({
      targetPublicProfileId: targetProfileId,
      streamCid: "messaging:loop_direct_0123456789abcdef0123456789abcdef",
    });
  });

  it("maps every V1 chat failure onto the V2 catalog", async () => {
    for (const [error, code] of [
      [new ChatChannelIdempotencyConflictError(), "IDEMPOTENCY_CONFLICT"],
      [new ChatChannelTargetUnavailableError(), "NOT_FOUND"],
      [new ChatOperationNotFoundError(), "NOT_FOUND"],
      [new ChatChannelUnavailableError(), "CAPABILITY_UNAVAILABLE"],
    ] as const) {
      const getOperation = vi.fn(() => Promise.reject(error));
      await expect(
        service({ getOperation }).getOperation({
          principal,
          operationId,
          requestId,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code });
    }
  });

  it("rejects a snake_case body so the V2 contract stays camelCase", async () => {
    await expect(
      service().getOrCreateDirect(
        command({ target_public_profile_id: targetProfileId }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      service().createGroup(
        command({
          name: "Frog Squad",
          friend_public_profile_ids: [targetProfileId, secondProfileId],
        }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("projects the Stream token in camelCase and maps its failures", async () => {
    const chat = createV2ChatService({
      chatChannelService: chatChannelServiceFake(),
      streamTokenService: streamTokenServiceFake(),
      repository: createUnavailableCommunicationRepository(),
      channelGateway: createUnavailableStreamCommunityChannelGateway(),
    });
    await expect(
      chat.issueToken({
        principal,
        product: "chat",
        canonicalClientIp: "203.0.113.7",
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      apiKey: "stream_key",
      token: "a".repeat(40),
      expiresAt: createdAt,
      user: { id: principal.streamUserId },
      contractVersion: "2.0",
    });

    for (const [error, code] of [
      [new StreamTokenQuotaExceededError(), "RATE_LIMITED"],
      [new StreamTokenUnavailableError(), "CAPABILITY_UNAVAILABLE"],
    ] as const) {
      const failing = createV2ChatService({
        chatChannelService: chatChannelServiceFake(),
        streamTokenService: streamTokenServiceFake({
          issueToken: vi.fn(() => Promise.reject(error)),
        }),
        repository: createUnavailableCommunicationRepository(),
        channelGateway: createUnavailableStreamCommunityChannelGateway(),
      });
      await expect(
        failing.issueToken({
          principal,
          product: "video",
          canonicalClientIp: "203.0.113.7",
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code });
    }
  });

  it("keeps every operation unavailable when the wrapper is not composed", async () => {
    const unavailable = createUnavailableV2ChatService();
    for (const call of [
      unavailable.issueToken({
        principal,
        product: "chat",
        canonicalClientIp: "203.0.113.7",
        signal: new AbortController().signal,
      }),
      unavailable.createGroup(command({})),
      unavailable.getOrCreateDirect(command({})),
      unavailable.getOperation({
        principal,
        operationId,
        requestId,
        signal: new AbortController().signal,
      }),
      unavailable.leaveGroup({
        principal,
        groupId: operationId,
        idempotencyKey: operationId,
        requestId,
        signal: new AbortController().signal,
      }),
    ]) {
      await expect(call).rejects.toBeInstanceOf(V2ApiError);
      await expect(call).rejects.toMatchObject({
        code: "CAPABILITY_UNAVAILABLE",
      });
    }
  });
});
