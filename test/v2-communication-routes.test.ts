import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createUnavailableAlertRepository } from "../src/database/alert-repository.js";
import { createUnavailableAgentAuthorizationRepository } from "../src/database/agent-authorization-repository.js";
import {
  createUnavailableControlPlaneRepository,
  type ControlPlaneRepository,
} from "../src/database/control-plane-repository.js";
import type { Database } from "../src/database/database.js";
import { createUnavailablePerpIntentRepository } from "../src/database/perp-intent-repository.js";
import { createUnavailablePerpWalletBindingRepository } from "../src/database/perp-wallet-binding-repository.js";
import { createUnavailableProfileRepository } from "../src/database/profile-repository.js";
import { createUnavailableWatchlistRepository } from "../src/database/watchlist-repository.js";
import { createUnavailableCommunityRepository } from "../src/features/community/community-repository.js";
import {
  CommunicationDataStaleError,
  CommunicationPermissionDeniedError,
  CommunicationUnprovisionedRoomError,
  createUnavailableCommunicationRepository,
  type CommunicationRepository,
  type VoiceRoomViewerRecord,
} from "../src/features/communication/communication-repository.js";
import type { InternalUserRepository } from "../src/features/identity/internal-user-repository.js";
import { createUnavailableDeviceSessionRepository } from "../src/features/session/device-session-repository.js";
import type { PrivyAccessTokenVerifier } from "../src/integrations/privy/access-token-verifier.js";
import {
  createUnavailableStreamCallGateway,
  type StreamCallGateway,
} from "../src/integrations/stream/call-gateway.js";
import {
  createUnavailableStreamCommunityChannelGateway,
  type StreamCommunityChannelGateway,
} from "../src/integrations/stream/channel-gateway.js";

const accountId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const communityId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const voiceRoomId = "8c7b6a59-4d3e-4f21-8a0b-1c2d3e4f5a6b";
const callId = "loop_voice_8c7b6a594d3e4f218a0b1c2d3e4f5a6b";
const targetProfileId = "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f";
const groupId = "2b3c4d5e-6f70-4182-9394-a5b6c7d8e9f0";
const validToken = "header.payload.signature";
const cursorSecret = "0123456789abcdef0123456789abcdef";
const quotaSecret = "fedcba9876543210fedcba9876543210";
const createdAt = "2026-09-08T01:00:00.000Z";

type Mocks = Record<string, ReturnType<typeof vi.fn>>;

function jsonOf<T>(response: { readonly json: () => unknown }): T {
  return response.json() as T;
}

function idempotencyKey(suffix = "a"): string {
  return `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${suffix}`;
}

const profile = Object.freeze({
  publicProfileId: targetProfileId,
  loopId: "LOOP-7HJKMNPQ",
  alias: "frog_maxi",
  avatarRef: "avatar:preset/people-03",
});

function room(
  overrides: Partial<VoiceRoomViewerRecord> = {},
): VoiceRoomViewerRecord {
  return Object.freeze({
    room: Object.freeze({
      voiceRoomId,
      communityId,
      communityName: "Builders Guild",
      callId,
      state: "live" as const,
      provisionState: "provisioned" as const,
      backstage: true,
      createdAt,
      endedAt: null,
    }),
    viewerRole: "host" as const,
    viewerHandRaise: null,
    hostStreamUserId: `loop_${accountId.replaceAll("-", "")}`,
    speakerCount: 1,
    listenerCount: 4,
    joinedCount: 6,
    ...overrides,
  });
}

function testConfig(overrides: Readonly<Record<string, string>> = {}) {
  return loadConfig({
    NODE_ENV: "test",
    API_DOCS_ENABLED: "false",
    LOG_LEVEL: "silent",
    V2_MODULES_ENABLED: "community,communication",
    V2_CURSOR_HMAC_SECRET: cursorSecret,
    STREAM_TOKEN_QUOTA_HMAC_SECRET: quotaSecret,
    PRIVY_APP_ID: "app_test",
    PRIVY_APP_SECRET: "secret_test",
    DATABASE_URL:
      "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
    ...overrides,
  });
}

function commonHeaders(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${validToken}`,
    "x-loop-client-version": "1.2.3",
    "x-loop-contract-version": "2.0",
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete headers[name];
    } else {
      headers[name] = value;
    }
  }
  return headers;
}

function commandHeaders(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  return commonHeaders({ "idempotency-key": idempotencyKey(), ...overrides });
}

function communicationRepositoryFake(
  overrides: Partial<CommunicationRepository> = {},
): { readonly repository: CommunicationRepository; readonly mocks: Mocks } {
  const mocks: Mocks = {
    ...createUnavailableCommunicationRepository(),
    readCommunityChannel: vi.fn(() =>
      Promise.resolve({
        channel: null,
        viewerMemberState: null,
        viewerIsCommunityMember: false,
        currentVoiceRoomId: null,
        currentVoiceRoomProvisioned: false,
      }),
    ),
    createVoiceRoom: vi.fn(() =>
      Promise.resolve(
        room({ room: { ...room().room, provisionState: "pending" } }),
      ),
    ),
    recordVoiceRoomProvisioning: vi.fn(() => Promise.resolve(room().room)),
    getCurrentVoiceRoom: vi.fn(() => Promise.resolve(room())),
    getVoiceRoom: vi.fn(() => Promise.resolve(room())),
    joinVoiceRoom: vi.fn(() =>
      Promise.resolve(room({ viewerRole: "listener" })),
    ),
    leaveVoiceRoom: vi.fn(() => Promise.resolve(room({ viewerRole: null }))),
    raiseHand: vi.fn(() =>
      Promise.resolve(
        room({
          viewerRole: "listener",
          viewerHandRaise: {
            handRaiseId: voiceRoomId,
            sequence: "7",
            state: "pending",
            createdAt,
          },
        }),
      ),
    ),
    cancelHandRaise: vi.fn(() =>
      Promise.resolve(room({ viewerRole: "listener" })),
    ),
    listHandRaises: vi.fn(() =>
      Promise.resolve([
        {
          handRaiseId: voiceRoomId,
          sequence: "1",
          state: "pending" as const,
          createdAt,
          profile,
        },
        {
          handRaiseId: communityId,
          sequence: "2",
          state: "pending" as const,
          createdAt,
          profile,
        },
      ]),
    ),
    inviteSpeaker: vi.fn(() =>
      Promise.resolve({
        room: room(),
        targetStreamUserId: `loop_${targetProfileId.replaceAll("-", "")}`,
        targetRole: "speaker" as const,
        profile,
      }),
    ),
    removeSpeaker: vi.fn(() =>
      Promise.resolve({
        room: room(),
        targetStreamUserId: `loop_${targetProfileId.replaceAll("-", "")}`,
        targetRole: "listener" as const,
        profile,
      }),
    ),
    recordMuteAll: vi.fn(() => Promise.resolve(room())),
    endVoiceRoom: vi.fn(() =>
      Promise.resolve(
        room({
          room: {
            voiceRoomId,
            communityId,
            communityName: "Builders Guild",
            callId,
            state: "ended",
            provisionState: "provisioned",
            backstage: true,
            createdAt,
            endedAt: "2026-09-08T02:00:00.000Z",
          },
        }),
      ),
    ),
    prepareChatGroupLeave: vi.fn(() =>
      Promise.resolve({
        groupId,
        streamChannelId: `loop_group_${groupId.replaceAll("-", "")}`,
        channelCreatedByStreamUserId: `loop_${accountId.replaceAll("-", "")}`,
        memberStreamUserId: `loop_${accountId.replaceAll("-", "")}`,
        alreadyCommitted: false,
      }),
    ),
    commitChatGroupLeave: vi.fn(() => Promise.resolve()),
  };
  for (const [name, value] of Object.entries(overrides)) {
    mocks[name] = value as ReturnType<typeof vi.fn>;
  }
  return {
    repository: {
      ...createUnavailableCommunicationRepository(),
      ...mocks,
    },
    mocks,
  };
}

function callGatewayFake(overrides: Partial<StreamCallGateway> = {}): {
  readonly gateway: StreamCallGateway;
  readonly mocks: Mocks;
} {
  const mocks: Mocks = {
    createAudioRoom: vi.fn(() =>
      Promise.resolve({
        callId,
        callCid: `audio_room:${callId}`,
        backstage: true,
      }),
    ),
    updateCallMembers: vi.fn(() => Promise.resolve()),
    updateUserPermissions: vi.fn(() => Promise.resolve()),
    muteUsers: vi.fn(() => Promise.resolve()),
    endCall: vi.fn(() => Promise.resolve()),
    queryMembers: vi.fn(() =>
      Promise.resolve({
        memberCount: 5,
        observedAt: createdAt,
        complete: true,
      }),
    ),
    observeSession: vi.fn(() =>
      Promise.resolve({
        participantCount: 3,
        sessionActive: true,
        observedAt: createdAt,
      }),
    ),
  };
  for (const [name, value] of Object.entries(overrides)) {
    mocks[name] = value as ReturnType<typeof vi.fn>;
  }
  return {
    gateway: {
      ...createUnavailableStreamCallGateway(),
      ...mocks,
    },
    mocks,
  };
}

function channelGatewayFake(
  overrides: Partial<StreamCommunityChannelGateway> = {},
): StreamCommunityChannelGateway {
  return {
    ...createUnavailableStreamCommunityChannelGateway(),
    upsertCommunityChannel: vi.fn(() =>
      Promise.resolve({
        channelId: `loop_community_${communityId.replaceAll("-", "")}`,
        streamCid: `messaging:loop_community_${communityId.replaceAll("-", "")}`,
        memberCount: 1,
      }),
    ),
    addMembers: vi.fn(() =>
      Promise.resolve({
        channelId: `loop_community_${communityId.replaceAll("-", "")}`,
        streamCid: `messaging:loop_community_${communityId.replaceAll("-", "")}`,
        memberCount: 2,
      }),
    ),
    removeMembers: vi.fn(() =>
      Promise.resolve({
        channelId: `loop_group_${groupId.replaceAll("-", "")}`,
        streamCid: `messaging:loop_group_${groupId.replaceAll("-", "")}`,
        memberCount: 2,
      }),
    ),
    ...overrides,
  };
}

function fakes(
  options: {
    readonly communication?: {
      readonly repository: CommunicationRepository;
      readonly mocks: Mocks;
    };
    readonly callGateway?: {
      readonly gateway: StreamCallGateway;
      readonly mocks: Mocks;
    };
    readonly channelGateway?: StreamCommunityChannelGateway;
  } = {},
) {
  const verifyAccessToken = vi.fn(() =>
    Promise.resolve({ privyUserId: "did:privy:verified-user" }),
  );
  const findByPrivyUserId = vi.fn<InternalUserRepository["findByPrivyUserId"]>(
    () => Promise.resolve({ id: accountId }),
  );
  const consumeIssuanceQuota = vi.fn<
    ControlPlaneRepository["consumeIssuanceQuota"]
  >(() => Promise.resolve([]));
  const communication = options.communication ?? communicationRepositoryFake();
  const call = options.callGateway ?? callGatewayFake();
  const channelGateway = options.channelGateway ?? channelGatewayFake();
  const database = {
    alerts: createUnavailableAlertRepository(),
    agentAuthorizations: createUnavailableAgentAuthorizationRepository(),
    controlPlane: {
      ...createUnavailableControlPlaneRepository(),
      consumeIssuanceQuota,
    },
    deviceSessions: createUnavailableDeviceSessionRepository(),
    perpWalletBindings: createUnavailablePerpWalletBindingRepository(),
    perpIntents: createUnavailablePerpIntentRepository(),
    profiles: createUnavailableProfileRepository(),
    community: createUnavailableCommunityRepository(),
    communication: communication.repository,
    watchlists: createUnavailableWatchlistRepository(),
    internalUsers: {
      findByPrivyUserId,
      getOrCreateByPrivyUserId: vi.fn<
        InternalUserRepository["getOrCreateByPrivyUserId"]
      >(() => Promise.resolve({ id: accountId })),
    },
    ping: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  } satisfies Database;
  return {
    communication: communication.repository,
    communicationMocks: communication.mocks,
    callGateway: call.gateway,
    callMocks: call.mocks,
    channelGateway,
    database,
    privyAccessTokenVerifier: {
      verifyAccessToken,
    } satisfies PrivyAccessTokenVerifier,
    verifyAccessToken,
  };
}

describe("LOOP API V2 communication module", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function createApp(
    dependencies = fakes(),
    overrides: Readonly<Record<string, string>> = {},
  ) {
    const app = await buildApp({
      config: testConfig(overrides),
      contractSurface: "v2",
      database: dependencies.database,
      privyAccessTokenVerifier: dependencies.privyAccessTokenVerifier,
      streamCallGateway: dependencies.callGateway,
      streamCommunityChannelGateway: dependencies.channelGateway,
      logger: false,
    });
    apps.push(app);
    return { app, ...dependencies };
  }

  it("registers no communication route when the module is disabled", async () => {
    const { app, verifyAccessToken } = await createApp(fakes(), {
      V2_MODULES_ENABLED: "community",
    });
    for (const [method, url] of [
      ["POST", "/v2/chat/token"],
      ["POST", "/v2/video/token"],
      ["POST", "/v2/chat/groups"],
      ["POST", "/v2/chat/direct-channels"],
      ["POST", `/v2/communities/${communityId}/voice-rooms`],
      ["GET", `/v2/communities/${communityId}/voice-rooms/current`],
      ["POST", `/v2/voice-rooms/${voiceRoomId}/join`],
      ["POST", `/v2/voice-rooms/${voiceRoomId}/hand-raise`],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: method === "GET" ? commonHeaders() : commandHeaders(),
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        code: "NOT_FOUND",
        category: "validation",
        retryable: false,
        detailsSafe: null,
        providerReferenceSafe: null,
      });
    }
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });

  it("reports communityChat and voiceRooms with the pending role evidence", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: "/v2/meta/capabilities",
    });
    const capabilities = Object.fromEntries(
      jsonOf<{
        capabilities: readonly {
          capabilityId: string;
          availability: string;
          reasonCode: string | null;
          evidence: { status: string; reasonCode: string | null };
        }[];
      }>(response).capabilities.map((entry) => [entry.capabilityId, entry]),
    );
    expect(capabilities["communityChat"]).toEqual({
      capabilityId: "communityChat",
      availability: "available",
      reasonCode: null,
      evidence: { status: "notApplicable", reasonCode: null },
    });
    expect(capabilities["voiceRooms"]).toEqual({
      capabilityId: "voiceRooms",
      availability: "available",
      reasonCode: null,
      evidence: {
        status: "pending",
        reasonCode: "AUDIO_ROOM_USER_ROLE_EVIDENCE_PENDING",
      },
    });
  });

  it("keeps voiceRooms evidence pending even when the module is not enabled", async () => {
    const { app } = await createApp(fakes(), { V2_MODULES_ENABLED: "" });
    const response = await app.inject({
      method: "GET",
      url: "/v2/meta/capabilities",
    });
    const capabilities = jsonOf<{
      capabilities: readonly {
        capabilityId: string;
        availability: string;
        reasonCode: string | null;
        evidence: { status: string; reasonCode: string | null };
      }[];
    }>(response).capabilities;
    expect(
      capabilities.find((entry) => entry.capabilityId === "voiceRooms"),
    ).toEqual({
      capabilityId: "voiceRooms",
      availability: "deferred",
      reasonCode: "V2_COMMUNICATION_RUNTIME_DEFERRED",
      evidence: {
        status: "pending",
        reasonCode: "AUDIO_ROOM_USER_ROLE_EVIDENCE_PENDING",
      },
    });
  });

  describe("audio-room role evidence switch (Decision 0039)", () => {
    const evidenceReference = "dashboard-2026-09-10-user-role-no-create-call";
    type CapabilityDocument = {
      readonly capabilityId: string;
      readonly availability: string;
      readonly reasonCode: string | null;
      readonly evidence: Record<string, unknown>;
    };

    async function readCapabilities(
      app: FastifyInstance,
    ): Promise<Record<string, CapabilityDocument>> {
      const response = await app.inject({
        method: "GET",
        url: "/v2/meta/capabilities",
      });
      expect(response.statusCode).toBe(200);
      return Object.fromEntries(
        jsonOf<{ capabilities: readonly CapabilityDocument[] }>(
          response,
        ).capabilities.map((entry) => [entry.capabilityId, entry]),
      );
    }

    it("confirms the evidence with the configured reference and leaves availability to the runtime", async () => {
      const { app } = await createApp(fakes(), {
        STREAM_AUDIO_ROOM_USER_ROLE_EVIDENCE_REF: ` ${evidenceReference} `,
      });
      const capabilities = await readCapabilities(app);
      expect(capabilities["voiceRooms"]).toEqual({
        capabilityId: "voiceRooms",
        availability: "available",
        reasonCode: null,
        evidence: {
          status: "confirmed",
          reasonCode: null,
          reference: evidenceReference,
        },
      });
      expect(Object.keys(capabilities["voiceRooms"]?.evidence ?? {})).toEqual([
        "status",
        "reasonCode",
        "reference",
      ]);
      // The reference never leaks into any other capability's document, and
      // the sibling communication capability is untouched.
      for (const [capabilityId, capability] of Object.entries(capabilities)) {
        if (capabilityId !== "voiceRooms") {
          expect(Object.keys(capability.evidence), capabilityId).toEqual([
            "status",
            "reasonCode",
          ]);
        }
      }
      expect(capabilities["communityChat"]).toEqual({
        capabilityId: "communityChat",
        availability: "available",
        reasonCode: null,
        evidence: { status: "notApplicable", reasonCode: null },
      });
    });

    it("does not open an unavailable communication runtime: the module gate still fails closed", async () => {
      // `communication` without `community` composes no community runtime,
      // so the module is enabled but unavailable; the confirmed evidence
      // must not turn that into `available`.
      const { app } = await createApp(fakes(), {
        V2_MODULES_ENABLED: "communication",
        STREAM_AUDIO_ROOM_USER_ROLE_EVIDENCE_REF: evidenceReference,
      });
      const capabilities = await readCapabilities(app);
      expect(capabilities["voiceRooms"]).toEqual({
        capabilityId: "voiceRooms",
        availability: "unavailable",
        reasonCode: "COMMUNICATION_RUNTIME_UNAVAILABLE",
        evidence: {
          status: "confirmed",
          reasonCode: null,
          reference: evidenceReference,
        },
      });
    });

    it("reports the confirmed evidence even while the communication module is not enabled", async () => {
      const { app } = await createApp(fakes(), {
        V2_MODULES_ENABLED: "",
        STREAM_AUDIO_ROOM_USER_ROLE_EVIDENCE_REF: evidenceReference,
      });
      const capabilities = await readCapabilities(app);
      expect(capabilities["voiceRooms"]).toEqual({
        capabilityId: "voiceRooms",
        availability: "deferred",
        reasonCode: "V2_COMMUNICATION_RUNTIME_DEFERRED",
        evidence: {
          status: "confirmed",
          reasonCode: null,
          reference: evidenceReference,
        },
      });
    });

    it("changes only the voiceRooms entry of the capabilities document", async () => {
      const { app: pending } = await createApp(fakes(), {
        STREAM_AUDIO_ROOM_USER_ROLE_EVIDENCE_REF: "",
      });
      const { app: confirmed } = await createApp(fakes(), {
        STREAM_AUDIO_ROOM_USER_ROLE_EVIDENCE_REF: evidenceReference,
      });
      const before = await readCapabilities(pending);
      const after = await readCapabilities(confirmed);
      expect(before["voiceRooms"]?.evidence).toEqual({
        status: "pending",
        reasonCode: "AUDIO_ROOM_USER_ROLE_EVIDENCE_PENDING",
      });
      const withoutVoiceRooms = (
        capabilities: Record<string, CapabilityDocument>,
      ): string =>
        JSON.stringify(
          Object.entries(capabilities).filter(
            ([capabilityId]) => capabilityId !== "voiceRooms",
          ),
        );
      expect(withoutVoiceRooms(after)).toBe(withoutVoiceRooms(before));
    });
  });

  it("creates a voice room and confirms the single Stream call", async () => {
    const { app, callMocks, communicationMocks } = await createApp();
    const response = await app.inject({
      method: "POST",
      url: `/v2/communities/${communityId}/voice-rooms`,
      headers: commandHeaders(),
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      room: {
        voiceRoomId,
        communityId,
        communityName: "Builders Guild",
        callCid: `audio_room:${callId}`,
        state: "live",
        provisionState: "provisioned",
        backstage: true,
      },
      viewer: { role: "host", canInviteSpeakers: true, canEndRoom: true },
      providerSync: { status: "confirmed", reasonCode: null },
      contractVersion: "2.0",
    });
    expect(callMocks["createAudioRoom"]).toHaveBeenCalledTimes(1);
    expect(
      communicationMocks["recordVoiceRoomProvisioning"],
    ).toHaveBeenCalledWith({
      voiceRoomId,
      provisionState: "provisioned",
      errorCode: null,
    });
  });

  it("keeps a room reconciling and unconfirmed when the Stream call fails", async () => {
    const callGateway = callGatewayFake({
      createAudioRoom: vi.fn(() => Promise.reject(new Error("provider"))),
    });
    const communication = communicationRepositoryFake({
      recordVoiceRoomProvisioning: vi.fn(() =>
        Promise.resolve({
          ...room().room,
          provisionState: "reconciling" as const,
        }),
      ),
    });
    const { app, callMocks, communicationMocks } = await createApp(
      fakes({ callGateway, communication }),
    );
    const response = await app.inject({
      method: "POST",
      url: `/v2/communities/${communityId}/voice-rooms`,
      headers: commandHeaders(),
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      room: { provisionState: "reconciling" },
      providerSync: {
        status: "unconfirmed",
        reasonCode: "STREAM_CALL_CREATE_UNCONFIRMED",
      },
    });
    expect(callMocks["createAudioRoom"]).toHaveBeenCalledTimes(1);
    expect(
      communicationMocks["recordVoiceRoomProvisioning"],
    ).toHaveBeenCalledWith({
      voiceRoomId,
      provisionState: "reconciling",
      errorCode: "stream_call_create_unconfirmed",
    });
  });

  it("refuses to join a room whose Stream call is not provisioned", async () => {
    const communication = communicationRepositoryFake({
      joinVoiceRoom: vi.fn(() =>
        Promise.reject(new CommunicationUnprovisionedRoomError()),
      ),
    });
    const { app, callMocks } = await createApp(fakes({ communication }));
    const response = await app.inject({
      method: "POST",
      url: `/v2/voice-rooms/${voiceRoomId}/join`,
      headers: commandHeaders(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      category: "availability",
      retryable: true,
    });
    expect(callMocks["updateCallMembers"]).not.toHaveBeenCalled();
  });

  it("returns the current role on an idempotent join", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "POST",
      url: `/v2/voice-rooms/${voiceRoomId}/join`,
      headers: commandHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      viewer: {
        role: "listener",
        canInviteSpeakers: false,
        canMuteAll: false,
        canEndRoom: false,
      },
      room: { callCid: `audio_room:${callId}` },
    });
    expect(
      typeof jsonOf<{ viewer: { expiresAt: string } }>(response).viewer
        .expiresAt,
    ).toBe("string");
  });

  it("keeps host actions closed to a non-host", async () => {
    const denied = () =>
      Promise.reject(new CommunicationPermissionDeniedError());
    const communication = communicationRepositoryFake({
      inviteSpeaker: vi.fn(denied),
      removeSpeaker: vi.fn(denied),
      recordMuteAll: vi.fn(denied),
      endVoiceRoom: vi.fn(denied),
    });
    const { app, callMocks } = await createApp(fakes({ communication }));
    for (const [method, url] of [
      ["POST", `/v2/voice-rooms/${voiceRoomId}/speakers/${targetProfileId}`],
      ["DELETE", `/v2/voice-rooms/${voiceRoomId}/speakers/${targetProfileId}`],
      ["POST", `/v2/voice-rooms/${voiceRoomId}/mute-all`],
      ["POST", `/v2/voice-rooms/${voiceRoomId}/end`],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: commandHeaders(),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        code: "PERMISSION_DENIED",
        category: "authorization",
        retryable: false,
      });
    }
    expect(callMocks["muteUsers"]).not.toHaveBeenCalled();
    expect(callMocks["endCall"]).not.toHaveBeenCalled();
    expect(callMocks["updateUserPermissions"]).not.toHaveBeenCalled();
  });

  it("grants send-audio when the host invites a speaker", async () => {
    const { app, callMocks } = await createApp();
    const response = await app.inject({
      method: "POST",
      url: `/v2/voice-rooms/${voiceRoomId}/speakers/${targetProfileId}`,
      headers: commandHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      providerSync: { status: "confirmed", reasonCode: null },
    });
    expect(callMocks["updateUserPermissions"]).toHaveBeenCalledWith(
      expect.objectContaining({
        callId,
        grantPermissions: ["send-audio"],
        revokePermissions: [],
      }),
    );
  });

  it("reports an unconfirmed Stream write without failing the command", async () => {
    const callGateway = callGatewayFake({
      muteUsers: vi.fn(() => Promise.reject(new Error("provider"))),
    });
    const { app } = await createApp(fakes({ callGateway }));
    const response = await app.inject({
      method: "POST",
      url: `/v2/voice-rooms/${voiceRoomId}/mute-all`,
      headers: commandHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      providerSync: {
        status: "unconfirmed",
        reasonCode: "STREAM_CALL_MUTE_UNCONFIRMED",
      },
    });
  });

  it("rejects every write on an ended room as DATA_STALE", async () => {
    const stale = () => Promise.reject(new CommunicationDataStaleError());
    const communication = communicationRepositoryFake({
      joinVoiceRoom: vi.fn(stale),
      leaveVoiceRoom: vi.fn(stale),
      raiseHand: vi.fn(stale),
      cancelHandRaise: vi.fn(stale),
      recordMuteAll: vi.fn(stale),
      endVoiceRoom: vi.fn(stale),
      inviteSpeaker: vi.fn(stale),
    });
    const { app } = await createApp(fakes({ communication }));
    for (const [method, url] of [
      ["POST", `/v2/voice-rooms/${voiceRoomId}/join`],
      ["POST", `/v2/voice-rooms/${voiceRoomId}/leave`],
      ["POST", `/v2/voice-rooms/${voiceRoomId}/hand-raise`],
      ["DELETE", `/v2/voice-rooms/${voiceRoomId}/hand-raise`],
      ["POST", `/v2/voice-rooms/${voiceRoomId}/mute-all`],
      ["POST", `/v2/voice-rooms/${voiceRoomId}/end`],
      ["POST", `/v2/voice-rooms/${voiceRoomId}/speakers/${targetProfileId}`],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: commandHeaders(),
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: "DATA_STALE",
        category: "stale",
        retryable: false,
      });
    }
  });

  it("publishes the hand-raise queue in sequence order as decimal strings", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: `/v2/voice-rooms/${voiceRoomId}/hand-raises`,
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    const body = jsonOf<{
      items: readonly { sequence: string; state: string }[];
    }>(response);
    expect(body.items.map((entry) => entry.sequence)).toEqual(["1", "2"]);
    expect(body.items.every((entry) => entry.state === "pending")).toBe(true);
  });

  it("projects the observed participant count with observedAt on a read", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: `/v2/communities/${communityId}/voice-rooms/current`,
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      current: {
        participants: {
          speakerCount: 1,
          listenerCount: 4,
          joinedCount: 6,
          observed: {
            status: "available",
            participantCount: 3,
            memberCount: 5,
            observedAt: createdAt,
          },
        },
      },
      reasonCode: null,
    });
  });

  it("reports an unavailable participant count when the Stream session read fails", async () => {
    const callGateway = callGatewayFake({
      observeSession: vi.fn(() => Promise.reject(new Error("provider"))),
    });
    const { app } = await createApp(fakes({ callGateway }));
    const response = await app.inject({
      method: "GET",
      url: `/v2/voice-rooms/${voiceRoomId}`,
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      participants: {
        speakerCount: 1,
        listenerCount: 4,
        joinedCount: 6,
        observed: {
          status: "unavailable",
          reasonCode: "STREAM_PARTICIPANT_COUNT_NOT_OBSERVED",
        },
      },
    });
  });

  it("reports zero live participants when Stream has no session for the call", async () => {
    const callGateway = callGatewayFake({
      observeSession: vi.fn(() =>
        Promise.resolve({
          participantCount: 0,
          sessionActive: false,
          observedAt: createdAt,
        }),
      ),
    });
    const { app } = await createApp(fakes({ callGateway }));
    const response = await app.inject({
      method: "GET",
      url: `/v2/voice-rooms/${voiceRoomId}`,
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      participants: {
        observed: {
          status: "available",
          participantCount: 0,
          memberCount: 5,
        },
      },
    });
  });

  it("observes Stream after the join write so the response includes the caller", async () => {
    const order: string[] = [];
    const callGateway = callGatewayFake({
      updateCallMembers: vi.fn(() => {
        order.push("updateCallMembers");
        return Promise.resolve();
      }),
      queryMembers: vi.fn(() => {
        order.push("queryMembers");
        return Promise.resolve({
          memberCount: 6,
          observedAt: createdAt,
          complete: true,
        });
      }),
      observeSession: vi.fn(() => {
        order.push("observeSession");
        return Promise.resolve({
          participantCount: 2,
          sessionActive: true,
          observedAt: createdAt,
        });
      }),
    });
    const communication = communicationRepositoryFake({
      joinVoiceRoom: vi.fn(() =>
        Promise.resolve(
          room({ viewerRole: "listener", listenerCount: 5, joinedCount: 7 }),
        ),
      ),
    });
    const { app } = await createApp(fakes({ callGateway, communication }));
    const response = await app.inject({
      method: "POST",
      url: `/v2/voice-rooms/${voiceRoomId}/join`,
      headers: commandHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      viewer: { role: "listener" },
      participants: {
        speakerCount: 1,
        listenerCount: 5,
        joinedCount: 7,
        observed: {
          status: "available",
          participantCount: 2,
          memberCount: 6,
          observedAt: createdAt,
        },
      },
      providerSync: { status: "confirmed", reasonCode: null },
    });
    expect(order[0]).toBe("updateCallMembers");
    expect(order.slice(1).sort()).toEqual(["observeSession", "queryMembers"]);
  });

  it("observes Stream after the leave write so the caller is gone from the counts", async () => {
    const callGateway = callGatewayFake({
      queryMembers: vi.fn(() =>
        Promise.resolve({
          memberCount: 4,
          observedAt: createdAt,
          complete: true,
        }),
      ),
    });
    const communication = communicationRepositoryFake({
      leaveVoiceRoom: vi.fn(() =>
        Promise.resolve(
          room({ viewerRole: null, listenerCount: 3, joinedCount: 5 }),
        ),
      ),
    });
    const { app } = await createApp(fakes({ callGateway, communication }));
    const response = await app.inject({
      method: "POST",
      url: `/v2/voice-rooms/${voiceRoomId}/leave`,
      headers: commandHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      viewer: { role: null },
      participants: {
        listenerCount: 3,
        joinedCount: 5,
        observed: { status: "available", participantCount: 3, memberCount: 4 },
      },
    });
  });

  it("keeps the ended room unobserved after the end command", async () => {
    const callGateway = callGatewayFake();
    const communication = communicationRepositoryFake({
      endVoiceRoom: vi.fn(() =>
        Promise.resolve(
          room({
            room: {
              voiceRoomId,
              communityId,
              communityName: "Builders Guild",
              callId,
              state: "ended",
              provisionState: "provisioned",
              backstage: true,
              createdAt,
              endedAt: createdAt,
            },
          }),
        ),
      ),
    });
    const { app } = await createApp(fakes({ callGateway, communication }));
    const response = await app.inject({
      method: "POST",
      url: `/v2/voice-rooms/${voiceRoomId}/end`,
      headers: commandHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      room: { state: "ended" },
      participants: {
        observed: {
          status: "unavailable",
          reasonCode: "STREAM_PARTICIPANT_COUNT_NOT_OBSERVED",
        },
      },
    });
    expect(callGateway.mocks["queryMembers"]).not.toHaveBeenCalled();
    expect(callGateway.mocks["observeSession"]).not.toHaveBeenCalled();
  });

  it("reports an unavailable participant count when Stream cannot be read", async () => {
    const callGateway = callGatewayFake({
      queryMembers: vi.fn(() => Promise.reject(new Error("provider"))),
    });
    const { app } = await createApp(fakes({ callGateway }));
    const response = await app.inject({
      method: "GET",
      url: `/v2/communities/${communityId}/voice-rooms/current`,
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      current: {
        participants: {
          observed: {
            status: "unavailable",
            reasonCode: "STREAM_PARTICIPANT_COUNT_NOT_OBSERVED",
          },
        },
      },
    });
  });

  it("reports an unavailable participant count when the Stream page walk is truncated", async () => {
    const callGateway = callGatewayFake({
      queryMembers: vi.fn(() =>
        Promise.resolve({
          memberCount: 1_000,
          observedAt: createdAt,
          complete: false,
        }),
      ),
    });
    const { app } = await createApp(fakes({ callGateway }));
    const response = await app.inject({
      method: "GET",
      url: `/v2/communities/${communityId}/voice-rooms/current`,
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      current: {
        participants: {
          observed: {
            status: "unavailable",
            reasonCode: "STREAM_PARTICIPANT_COUNT_NOT_OBSERVED",
          },
        },
      },
    });
  });

  it("reports no live room with a machine reason code", async () => {
    const communication = communicationRepositoryFake({
      getCurrentVoiceRoom: vi.fn(() => Promise.resolve(null)),
    });
    const { app } = await createApp(fakes({ communication }));
    const response = await app.inject({
      method: "GET",
      url: `/v2/communities/${communityId}/voice-rooms/current`,
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      current: null,
      reasonCode: "COMMUNITY_VOICE_ROOM_NOT_LIVE",
      contractVersion: "2.0",
    });
  });

  it("rejects a command without exactly one canonical idempotency key", async () => {
    const { app } = await createApp();
    for (const headers of [
      commonHeaders(),
      commandHeaders({ "idempotency-key": "not-a-uuid" }),
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/v2/voice-rooms/${voiceRoomId}/join`,
        headers,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "INVALID_REQUEST" });
    }
  });

  it("rejects an idempotency key on a read", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: `/v2/voice-rooms/${voiceRoomId}/hand-raises`,
      headers: commandHeaders(),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("removes the caller from Stream before committing a group leave", async () => {
    const order: string[] = [];
    const channelGateway = channelGatewayFake({
      removeMembers: vi.fn(() => {
        order.push("stream");
        return Promise.resolve({
          channelId: `loop_group_${groupId.replaceAll("-", "")}`,
          streamCid: `messaging:loop_group_${groupId.replaceAll("-", "")}`,
          memberCount: 2,
        });
      }),
    });
    const communication = communicationRepositoryFake({
      commitChatGroupLeave: vi.fn(() => {
        order.push("commit");
        return Promise.resolve();
      }),
    });
    const { app } = await createApp(fakes({ channelGateway, communication }));
    const response = await app.inject({
      method: "DELETE",
      url: `/v2/chat/groups/${groupId}/membership`,
      headers: commandHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      groupId,
      membership: null,
      contractVersion: "2.0",
    });
    expect(order).toEqual(["stream", "commit"]);
  });

  it("does not commit a group leave when the Stream removal is unknown", async () => {
    const channelGateway = channelGatewayFake({
      removeMembers: vi.fn(() => Promise.reject(new Error("provider"))),
    });
    const communication = communicationRepositoryFake();
    const { app, communicationMocks } = await createApp(
      fakes({ channelGateway, communication }),
    );
    const response = await app.inject({
      method: "DELETE",
      url: `/v2/chat/groups/${groupId}/membership`,
      headers: commandHeaders(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "PROVIDER_DISCONNECTED",
      category: "availability",
      retryable: true,
    });
    expect(communicationMocks["commitChatGroupLeave"]).not.toHaveBeenCalled();
  });

  it("returns 200 for a same-key group-leave retry after a lost response", async () => {
    const communication = communicationRepositoryFake({
      prepareChatGroupLeave: vi.fn(() =>
        Promise.resolve({
          groupId,
          streamChannelId: `loop_group_${groupId.replaceAll("-", "")}`,
          channelCreatedByStreamUserId: `loop_${accountId.replaceAll("-", "")}`,
          memberStreamUserId: `loop_${accountId.replaceAll("-", "")}`,
          alreadyCommitted: true,
        }),
      ),
    });
    const removeMembers = vi.fn(() =>
      Promise.resolve({
        channelId: `loop_group_${groupId.replaceAll("-", "")}`,
        streamCid: `messaging:loop_group_${groupId.replaceAll("-", "")}`,
        memberCount: 2,
      }),
    );
    const channelGateway = channelGatewayFake({ removeMembers });
    const { app, communicationMocks } = await createApp(
      fakes({ communication, channelGateway }),
    );
    const response = await app.inject({
      method: "DELETE",
      url: `/v2/chat/groups/${groupId}/membership`,
      headers: commandHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      groupId,
      membership: null,
      contractVersion: "2.0",
    });
    // Only the idempotent Stream removal replays; nothing commits twice.
    expect(removeMembers).toHaveBeenCalledTimes(1);
    expect(communicationMocks["commitChatGroupLeave"]).not.toHaveBeenCalled();
  });

  it("fails closed on the Stream token routes without provider credentials", async () => {
    const { app } = await createApp();
    for (const url of ["/v2/chat/token", "/v2/video/token"]) {
      const response = await app.inject({
        method: "POST",
        url,
        headers: commandHeaders(),
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        code: "CAPABILITY_UNAVAILABLE",
        category: "availability",
        retryable: true,
        detailsSafe: null,
        providerReferenceSafe: null,
      });
    }
  });

  it("fails closed on the V2 chat operation routes without a chat repository", async () => {
    const { app } = await createApp();
    for (const [method, url, body] of [
      [
        "POST",
        "/v2/chat/groups",
        {
          name: "Frog Squad",
          friendPublicProfileIds: [
            targetProfileId,
            "1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d",
          ],
        },
      ],
      [
        "POST",
        "/v2/chat/direct-channels",
        { targetPublicProfileId: targetProfileId },
      ],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: commandHeaders(),
        payload: body,
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        code: "CAPABILITY_UNAVAILABLE",
      });
    }
  });

  it("rejects snake_case chat bodies so the V2 contract stays camelCase", async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: "POST",
      url: "/v2/chat/direct-channels",
      headers: commandHeaders(),
      payload: { target_public_profile_id: targetProfileId },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "INVALID_REQUEST" });
  });
});
