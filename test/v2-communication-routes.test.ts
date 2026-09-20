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
  CommunicationNotFoundError,
  CommunicationPermissionDeniedError,
  CommunicationUnprovisionedRoomError,
  createUnavailableCommunicationRepository,
  type CommunicationRepository,
  type VoiceRoomViewerRecord,
} from "../src/features/communication/communication-repository.js";
import { createVoiceRoomService } from "../src/features/communication/voice-room-service.js";
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
      // A provisioned room is a live call (Decision 0054).
      backstage: false,
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

const anonymousProfileId = "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b";
const selfProfileId = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

/** Three listeners: an alias, an anonymous member, and the viewer itself (anonymous). */
function rosterRows() {
  return [
    {
      ownerUserId: "7d23b97f-5245-48f7-a423-d6f086b41f66",
      publicProfileId: targetProfileId,
      alias: "frog_maxi",
      anonymousMode: false,
      role: "listener" as const,
      joinedAt: createdAt,
      handRaised: true,
      muted: false,
    },
    {
      ownerUserId: "8e34ca80-6356-49a8-b534-e7a197c52a77",
      publicProfileId: anonymousProfileId,
      alias: "hidden_frog",
      anonymousMode: true,
      role: "listener" as const,
      joinedAt: "2026-09-08T01:00:01.000Z",
      handRaised: false,
      muted: false,
    },
    {
      ownerUserId: accountId,
      publicProfileId: selfProfileId,
      alias: "cy",
      anonymousMode: true,
      role: "listener" as const,
      joinedAt: "2026-09-08T01:00:02.000Z",
      handRaised: false,
      muted: false,
    },
  ];
}

/** The pending queue: the alias listener, then the anonymous one, then the viewer. */
function handRaiseRows() {
  const rows = rosterRows();
  return rows.map((row, index) => ({
    handRaiseId: [voiceRoomId, communityId, groupId][index]!,
    sequence: String(index + 1),
    state: "pending" as const,
    createdAt,
    ownerUserId: row.ownerUserId,
    publicProfileId: row.publicProfileId,
    alias: row.alias,
    anonymousMode: row.anonymousMode,
  }));
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
        viewerPersona: null,
        currentVoiceRoomProvisioned: false,
      }),
    ),
    createVoiceRoom: vi.fn(() =>
      Promise.resolve(
        room({
          // Freshly inserted: not provisioned, and the call type starts in
          // backstage until the service takes it live.
          room: { ...room().room, provisionState: "pending", backstage: true },
        }),
      ),
    ),
    recordVoiceRoomProvisioning: vi.fn(() => Promise.resolve(room().room)),
    recordVoiceRoomLive: vi.fn(() => Promise.resolve(room().room)),
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
      Promise.resolve({ room: room(), items: handRaiseRows() }),
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
    muteSpeaker: vi.fn(() =>
      Promise.resolve({
        room: room(),
        targetStreamUserId: `loop_${targetProfileId.replaceAll("-", "")}`,
        targetRole: "speaker" as const,
        profile,
      }),
    ),
    unmuteSpeaker: vi.fn(() =>
      Promise.resolve({
        room: room({ viewerRole: "speaker" }),
        targetStreamUserId: `loop_${accountId.replaceAll("-", "")}`,
        targetRole: "speaker" as const,
        profile,
      }),
    ),
    listVoiceRoomMembers: vi.fn(() =>
      Promise.resolve({ room: room(), items: rosterRows() }),
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
            backstage: false,
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
    goLive: vi.fn(() =>
      Promise.resolve({
        callId,
        callCid: `audio_room:${callId}`,
        backstage: false,
      }),
    ),
    updateCallMembers: vi.fn(() => Promise.resolve()),
    updateUserPermissions: vi.fn(() => Promise.resolve()),
    muteUsers: vi.fn(() => Promise.resolve()),
    muteUser: vi.fn(() => Promise.resolve()),
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
        confirmedPersonaStreamUserIds: [],
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

  it("creates a voice room, takes the call live, and records backstage false (Decision 0054)", async () => {
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
        backstage: false,
      },
      viewer: { role: "host", canInviteSpeakers: true, canEndRoom: true },
      providerSync: { status: "confirmed", reasonCode: null },
      contractVersion: "2.0",
    });
    expect(callMocks["createAudioRoom"]).toHaveBeenCalledTimes(1);
    expect(callMocks["goLive"]).toHaveBeenCalledTimes(1);
    expect(callMocks["goLive"]).toHaveBeenCalledWith({
      callId,
      signal: expect.any(AbortSignal) as AbortSignal,
    });
    expect(
      communicationMocks["recordVoiceRoomProvisioning"],
    ).toHaveBeenCalledWith({
      voiceRoomId,
      provisionState: "provisioned",
      errorCode: null,
      backstage: false,
    });
  });

  it("keeps a room reconciling and unconfirmed when go-live is rejected", async () => {
    const callGateway = callGatewayFake({
      goLive: vi.fn(() => Promise.reject(new Error("provider"))),
    });
    const communication = communicationRepositoryFake({
      recordVoiceRoomProvisioning: vi.fn(() =>
        Promise.resolve({
          ...room().room,
          provisionState: "reconciling" as const,
          backstage: true,
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
      room: { provisionState: "reconciling", backstage: true },
      providerSync: {
        status: "unconfirmed",
        reasonCode: "STREAM_CALL_GO_LIVE_UNCONFIRMED",
      },
    });
    expect(callMocks["createAudioRoom"]).toHaveBeenCalledTimes(1);
    expect(callMocks["goLive"]).toHaveBeenCalledTimes(1);
    expect(
      communicationMocks["recordVoiceRoomProvisioning"],
    ).toHaveBeenCalledWith({
      voiceRoomId,
      provisionState: "reconciling",
      errorCode: "stream_call_go_live_unconfirmed",
      backstage: true,
    });
  });

  it("does not claim the room provisioned when Stream answers go-live but still reports backstage", async () => {
    const callGateway = callGatewayFake({
      goLive: vi.fn(() =>
        Promise.resolve({
          callId,
          callCid: `audio_room:${callId}`,
          backstage: true,
        }),
      ),
    });
    const communication = communicationRepositoryFake({
      recordVoiceRoomProvisioning: vi.fn(() =>
        Promise.resolve({
          ...room().room,
          provisionState: "reconciling" as const,
          backstage: true,
        }),
      ),
    });
    const { app, communicationMocks } = await createApp(
      fakes({ callGateway, communication }),
    );
    const response = await app.inject({
      method: "POST",
      url: `/v2/communities/${communityId}/voice-rooms`,
      headers: commandHeaders(),
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      room: { provisionState: "reconciling", backstage: true },
      providerSync: {
        status: "unconfirmed",
        reasonCode: "STREAM_CALL_GO_LIVE_UNCONFIRMED",
      },
    });
    expect(
      communicationMocks["recordVoiceRoomProvisioning"],
    ).toHaveBeenCalledWith({
      voiceRoomId,
      provisionState: "reconciling",
      errorCode: "stream_call_go_live_unconfirmed",
      backstage: true,
    });
  });

  describe("existing backstage rooms self-heal (Decision 0054 §2)", () => {
    const backstageRoom = () =>
      room({ room: { ...room().room, backstage: true } });

    it("takes a backstage room live once on read and writes the flag back", async () => {
      const communication = communicationRepositoryFake({
        getVoiceRoom: vi.fn(() => Promise.resolve(backstageRoom())),
      });
      const { app, callMocks, communicationMocks } = await createApp(
        fakes({ communication }),
      );
      const response = await app.inject({
        method: "GET",
        url: `/v2/voice-rooms/${voiceRoomId}`,
        headers: commonHeaders(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        room: { provisionState: "provisioned", backstage: false },
        providerSync: { status: "confirmed", reasonCode: null },
        participants: { observed: { status: "available" } },
      });
      expect(callMocks["goLive"]).toHaveBeenCalledTimes(1);
      expect(communicationMocks["recordVoiceRoomLive"]).toHaveBeenCalledWith({
        voiceRoomId,
      });
      expect(
        communicationMocks["recordVoiceRoomProvisioning"],
      ).not.toHaveBeenCalled();
    });

    it("heals through the community current-room read as well", async () => {
      const communication = communicationRepositoryFake({
        getCurrentVoiceRoom: vi.fn(() => Promise.resolve(backstageRoom())),
      });
      const { app, callMocks } = await createApp(fakes({ communication }));
      const response = await app.inject({
        method: "GET",
        url: `/v2/communities/${communityId}/voice-rooms/current`,
        headers: commonHeaders(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        current: {
          room: { backstage: false },
          providerSync: { status: "confirmed", reasonCode: null },
        },
      });
      expect(callMocks["goLive"]).toHaveBeenCalledTimes(1);
    });

    it("still answers the read when go-live fails, reporting the call as not live", async () => {
      const callGateway = callGatewayFake({
        goLive: vi.fn(() => Promise.reject(new Error("provider"))),
      });
      const communication = communicationRepositoryFake({
        getVoiceRoom: vi.fn(() => Promise.resolve(backstageRoom())),
      });
      const { app, callMocks, communicationMocks } = await createApp(
        fakes({ callGateway, communication }),
      );
      const response = await app.inject({
        method: "GET",
        url: `/v2/voice-rooms/${voiceRoomId}`,
        headers: commonHeaders(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        room: { provisionState: "provisioned", backstage: true },
        providerSync: {
          status: "unconfirmed",
          reasonCode: "STREAM_CALL_GO_LIVE_UNCONFIRMED",
        },
      });
      expect(callMocks["goLive"]).toHaveBeenCalledTimes(1);
      expect(communicationMocks["recordVoiceRoomLive"]).not.toHaveBeenCalled();
    });

    it("logs one sanitized warning per unconfirmed go-live, with the request ID as correlationId", async () => {
      const warn = vi.fn();
      const dependencies = fakes({
        callGateway: callGatewayFake({
          goLive: vi.fn(() => Promise.reject(new TypeError("provider"))),
        }),
        communication: communicationRepositoryFake({
          getVoiceRoom: vi.fn(() => Promise.resolve(backstageRoom())),
        }),
      });
      const app = await buildApp({
        config: testConfig(),
        contractSurface: "v2",
        database: dependencies.database,
        privyAccessTokenVerifier: dependencies.privyAccessTokenVerifier,
        streamCallGateway: dependencies.callGateway,
        streamCommunityChannelGateway: dependencies.channelGateway,
        voiceRoomService: createVoiceRoomService({
          repository: dependencies.communication,
          callGateway: dependencies.callGateway,
          cursorCodec: null,
          logger: { warn },
        }),
        logger: false,
      });
      apps.push(app);
      const response = await app.inject({
        method: "POST",
        url: `/v2/voice-rooms/${voiceRoomId}/join`,
        headers: commandHeaders(),
      });
      expect(response.statusCode).toBe(503);
      expect(warn).toHaveBeenCalledTimes(1);
      const [context, message] = warn.mock.calls[0] as [
        Record<string, unknown>,
        string,
      ];
      expect(message).toBe("Voice room go_live was not confirmed");
      expect(context).toEqual({
        voiceRoomId,
        callId,
        requestId: response.json<{ correlationId: string }>().correlationId,
        outcome: "rejected",
        errorName: "TypeError",
      });
      expect(JSON.stringify(context)).not.toContain("provider");
    });

    it("never calls go-live for a room that is already live", async () => {
      const { app, callMocks } = await createApp();
      const read = await app.inject({
        method: "GET",
        url: `/v2/voice-rooms/${voiceRoomId}`,
        headers: commonHeaders(),
      });
      expect(read.statusCode).toBe(200);
      const joined = await app.inject({
        method: "POST",
        url: `/v2/voice-rooms/${voiceRoomId}/join`,
        headers: commandHeaders(),
      });
      expect(joined.statusCode).toBe(200);
      expect(callMocks["goLive"]).not.toHaveBeenCalled();
    });

    it("heals a backstage room before committing a join", async () => {
      const order: string[] = [];
      const callGateway = callGatewayFake({
        goLive: vi.fn(() => {
          order.push("goLive");
          return Promise.resolve({
            callId,
            callCid: `audio_room:${callId}`,
            backstage: false,
          });
        }),
        updateCallMembers: vi.fn(() => {
          order.push("updateCallMembers");
          return Promise.resolve();
        }),
      });
      const communication = communicationRepositoryFake({
        getVoiceRoom: vi.fn(() => Promise.resolve(backstageRoom())),
        recordVoiceRoomLive: vi.fn(() => {
          order.push("recordVoiceRoomLive");
          return Promise.resolve({ ...room().room, backstage: false });
        }),
        joinVoiceRoom: vi.fn(() => {
          order.push("joinVoiceRoom");
          return Promise.resolve(room({ viewerRole: "listener" }));
        }),
      });
      const { app } = await createApp(fakes({ callGateway, communication }));
      const response = await app.inject({
        method: "POST",
        url: `/v2/voice-rooms/${voiceRoomId}/join`,
        headers: commandHeaders(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        room: { backstage: false },
        viewer: { role: "listener" },
        providerSync: { status: "confirmed", reasonCode: null },
      });
      expect(order).toEqual([
        "goLive",
        "recordVoiceRoomLive",
        "joinVoiceRoom",
        "updateCallMembers",
      ]);
    });

    it("keeps the join refusal order NOT_FOUND, PERMISSION_DENIED, DATA_STALE, CAPABILITY_UNAVAILABLE", async () => {
      const cases: ReadonlyArray<{
        readonly name: string;
        readonly getVoiceRoom: () => Promise<VoiceRoomViewerRecord>;
        readonly joinVoiceRoom: () => Promise<VoiceRoomViewerRecord>;
        readonly status: number;
        readonly code: string;
        readonly joinCalled: boolean;
      }> = [
        {
          name: "unknown room",
          getVoiceRoom: () => Promise.reject(new CommunicationNotFoundError()),
          joinVoiceRoom: () => Promise.resolve(room()),
          status: 404,
          code: "NOT_FOUND",
          joinCalled: false,
        },
        {
          // A banned or non-member viewer is refused by the preview read,
          // before the room's own state is judged: 403 even for an ended or
          // reconciling room.
          name: "non-member of a reconciling room",
          getVoiceRoom: () =>
            Promise.reject(new CommunicationPermissionDeniedError()),
          joinVoiceRoom: () =>
            Promise.reject(new CommunicationUnprovisionedRoomError()),
          status: 403,
          code: "PERMISSION_DENIED",
          joinCalled: false,
        },
        {
          name: "member of an ended room",
          getVoiceRoom: () =>
            Promise.resolve(
              room({
                room: {
                  ...room().room,
                  state: "ended",
                  backstage: true,
                  endedAt: createdAt,
                },
              }),
            ),
          joinVoiceRoom: () =>
            Promise.reject(new CommunicationDataStaleError()),
          status: 409,
          code: "DATA_STALE",
          joinCalled: true,
        },
        {
          name: "member of a reconciling room",
          getVoiceRoom: () =>
            Promise.resolve(
              room({
                room: {
                  ...room().room,
                  provisionState: "reconciling",
                  backstage: true,
                },
              }),
            ),
          joinVoiceRoom: () =>
            Promise.reject(new CommunicationUnprovisionedRoomError()),
          status: 503,
          code: "CAPABILITY_UNAVAILABLE",
          joinCalled: true,
        },
      ];
      for (const entry of cases) {
        const communication = communicationRepositoryFake({
          getVoiceRoom: vi.fn(entry.getVoiceRoom),
          joinVoiceRoom: vi.fn(entry.joinVoiceRoom),
        });
        const { app, callMocks, communicationMocks } = await createApp(
          fakes({ communication }),
        );
        const response = await app.inject({
          method: "POST",
          url: `/v2/voice-rooms/${voiceRoomId}/join`,
          headers: commandHeaders(),
        });
        expect([entry.name, response.statusCode]).toEqual([
          entry.name,
          entry.status,
        ]);
        expect(response.json()).toMatchObject({ code: entry.code });
        // Not-live or not-provisioned rooms never trigger go-live.
        expect(callMocks["goLive"]).not.toHaveBeenCalled();
        expect(
          (communicationMocks["joinVoiceRoom"] as ReturnType<typeof vi.fn>).mock
            .calls.length > 0,
        ).toBe(entry.joinCalled);
      }
    });

    it("refuses the join with a named reason, and writes nothing, while the call stays in backstage", async () => {
      const callGateway = callGatewayFake({
        goLive: vi.fn(() => Promise.reject(new Error("provider"))),
      });
      const communication = communicationRepositoryFake({
        getVoiceRoom: vi.fn(() => Promise.resolve(backstageRoom())),
      });
      const { app, callMocks, communicationMocks } = await createApp(
        fakes({ callGateway, communication }),
      );
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
        detailsSafe: { reasonCode: "VOICE_ROOM_BACKSTAGE_NOT_LIVE" },
        providerReferenceSafe: null,
      });
      expect(callMocks["goLive"]).toHaveBeenCalledTimes(1);
      expect(communicationMocks["joinVoiceRoom"]).not.toHaveBeenCalled();
      expect(callMocks["updateCallMembers"]).not.toHaveBeenCalled();
    });

    it("refuses the join when Stream answers go-live but still reports backstage", async () => {
      const callGateway = callGatewayFake({
        goLive: vi.fn(() =>
          Promise.resolve({
            callId,
            callCid: `audio_room:${callId}`,
            backstage: true,
          }),
        ),
      });
      const communication = communicationRepositoryFake({
        getVoiceRoom: vi.fn(() => Promise.resolve(backstageRoom())),
      });
      const { app, communicationMocks } = await createApp(
        fakes({ callGateway, communication }),
      );
      const response = await app.inject({
        method: "POST",
        url: `/v2/voice-rooms/${voiceRoomId}/join`,
        headers: commandHeaders(),
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        code: "CAPABILITY_UNAVAILABLE",
        detailsSafe: { reasonCode: "VOICE_ROOM_BACKSTAGE_NOT_LIVE" },
      });
      expect(communicationMocks["recordVoiceRoomLive"]).not.toHaveBeenCalled();
      expect(communicationMocks["joinVoiceRoom"]).not.toHaveBeenCalled();
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
    expect(callMocks["goLive"]).not.toHaveBeenCalled();
    expect(
      communicationMocks["recordVoiceRoomProvisioning"],
    ).toHaveBeenCalledWith({
      voiceRoomId,
      provisionState: "reconciling",
      errorCode: "stream_call_create_unconfirmed",
      backstage: true,
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
      muteSpeaker: vi.fn(denied),
      recordMuteAll: vi.fn(denied),
      endVoiceRoom: vi.fn(denied),
    });
    const { app, callMocks } = await createApp(fakes({ communication }));
    for (const [method, url] of [
      ["POST", `/v2/voice-rooms/${voiceRoomId}/speakers/${targetProfileId}`],
      ["DELETE", `/v2/voice-rooms/${voiceRoomId}/speakers/${targetProfileId}`],
      [
        "POST",
        `/v2/voice-rooms/${voiceRoomId}/speakers/${targetProfileId}/mute`,
      ],
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
    expect(callMocks["muteUser"]).not.toHaveBeenCalled();
    expect(callMocks["endCall"]).not.toHaveBeenCalled();
    expect(callMocks["updateUserPermissions"]).not.toHaveBeenCalled();
  });

  describe("roster (Decision 0052)", () => {
    it("lists the host's row commands and applies the anonymous display rule", async () => {
      const { app, communicationMocks } = await createApp();
      const response = await app.inject({
        method: "GET",
        url: `/v2/voice-rooms/${voiceRoomId}/members?role=listener`,
        headers: commonHeaders(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual({
        role: "listener",
        items: [
          {
            publicProfileId: targetProfileId,
            display: {
              kind: "alias",
              alias: "frog_maxi",
              publicProfileId: targetProfileId,
              audience: "everyone",
            },
            role: "listener",
            joinedAt: createdAt,
            handRaised: true,
            muted: false,
            isSelf: false,
            commands: ["invite_speaker"],
          },
          {
            // Anonymous to everyone but addressable by the host.
            publicProfileId: anonymousProfileId,
            display: {
              kind: "anonymous",
              labelKey: "voiceRoom.member.anonymousMember",
            },
            role: "listener",
            joinedAt: "2026-09-08T01:00:01.000Z",
            handRaised: false,
            muted: false,
            isSelf: false,
            commands: ["invite_speaker"],
          },
          {
            // The viewer's own row while its anonymous mode is on.
            publicProfileId: selfProfileId,
            display: {
              kind: "alias",
              alias: "cy",
              publicProfileId: selfProfileId,
              audience: "self",
            },
            role: "listener",
            joinedAt: "2026-09-08T01:00:02.000Z",
            handRaised: false,
            muted: false,
            isSelf: true,
            commands: ["invite_speaker"],
          },
        ],
        nextCursor: null,
        display: {
          anonymousMemberKey: "voiceRoom.member.anonymousMember",
          ruleKey: "voiceRoom.member.display.anonymousModeOnly",
        },
        contractVersion: "2.0",
      });
      expect(communicationMocks["listVoiceRoomMembers"]).toHaveBeenCalledWith({
        voiceRoomId,
        viewerUserId: accountId,
        role: "listener",
        limit: 51,
      });
    });

    it("gives a non-host no commands and hides the anonymous member's target", async () => {
      const communication = communicationRepositoryFake({
        listVoiceRoomMembers: vi.fn(() =>
          Promise.resolve({
            room: room({ viewerRole: "listener" }),
            items: rosterRows(),
          }),
        ),
      });
      const { app } = await createApp(fakes({ communication }));
      const response = await app.inject({
        method: "GET",
        url: `/v2/voice-rooms/${voiceRoomId}/members?role=listener`,
        headers: commonHeaders(),
      });
      expect(response.statusCode).toBe(200);
      const body = jsonOf<{
        items: readonly {
          publicProfileId: string | null;
          commands: readonly string[];
          display: { kind: string };
        }[];
      }>(response);
      expect(body.items.map((item) => item.commands)).toEqual([[], [], []]);
      expect(body.items.map((item) => item.publicProfileId)).toEqual([
        targetProfileId,
        null,
        selfProfileId,
      ]);
      expect(body.items[1]?.display.kind).toBe("anonymous");
    });

    it("offers remove and mute on an unmuted speaker, remove and unmute once muted", async () => {
      const communication = communicationRepositoryFake({
        listVoiceRoomMembers: vi.fn(() =>
          Promise.resolve({
            room: room(),
            items: [
              { ...rosterRows()[0]!, role: "speaker" as const, muted: false },
              { ...rosterRows()[1]!, role: "speaker" as const, muted: true },
            ],
          }),
        ),
      });
      const { app } = await createApp(fakes({ communication }));
      const response = await app.inject({
        method: "GET",
        url: `/v2/voice-rooms/${voiceRoomId}/members?role=speaker`,
        headers: commonHeaders(),
      });
      expect(response.statusCode).toBe(200);
      expect(
        jsonOf<{ items: readonly { commands: readonly string[] }[] }>(
          response,
        ).items.map((item) => item.commands),
      ).toEqual([
        ["remove_speaker", "mute"],
        ["remove_speaker", "unmute"],
      ]);
    });

    it("offers a non-host exactly unmute_self on its own muted speaker row (Decision 0053)", async () => {
      const rows = rosterRows();
      const communication = communicationRepositoryFake({
        listVoiceRoomMembers: vi.fn(() =>
          Promise.resolve({
            room: room({ viewerRole: "speaker" }),
            items: [
              { ...rows[0]!, role: "speaker" as const, muted: true },
              { ...rows[2]!, role: "speaker" as const, muted: true },
            ],
          }),
        ),
      });
      const { app } = await createApp(fakes({ communication }));
      const response = await app.inject({
        method: "GET",
        url: `/v2/voice-rooms/${voiceRoomId}/members?role=speaker`,
        headers: commonHeaders(),
      });
      expect(response.statusCode).toBe(200);
      const body = jsonOf<{
        items: readonly { isSelf: boolean; commands: readonly string[] }[];
      }>(response);
      expect(body.items.map((item) => [item.isSelf, item.commands])).toEqual([
        [false, []],
        [true, ["unmute_self"]],
      ]);
    });

    it("hands nothing out once the room has ended, not even unmute_self", async () => {
      const rows = rosterRows();
      const communication = communicationRepositoryFake({
        listVoiceRoomMembers: vi.fn(() =>
          Promise.resolve({
            room: room({
              viewerRole: "speaker",
              room: { ...room().room, state: "ended" as const },
            }),
            items: [{ ...rows[2]!, role: "speaker" as const, muted: true }],
          }),
        ),
      });
      const { app } = await createApp(fakes({ communication }));
      const response = await app.inject({
        method: "GET",
        url: `/v2/voice-rooms/${voiceRoomId}/members?role=speaker`,
        headers: commonHeaders(),
      });
      expect(response.statusCode).toBe(200);
      expect(
        jsonOf<{ items: readonly { commands: readonly string[] }[] }>(
          response,
        ).items.map((item) => item.commands),
      ).toEqual([[]]);
    });

    it("pages with an owner-bound cursor that carries the page size", async () => {
      const rows = rosterRows();
      const communication = communicationRepositoryFake({
        listVoiceRoomMembers: vi.fn((input: { readonly after?: unknown }) =>
          Promise.resolve({
            room: room(),
            items: input.after === undefined ? rows : rows.slice(2),
          }),
        ),
      });
      const { app, communicationMocks } = await createApp(
        fakes({ communication }),
      );
      const first = await app.inject({
        method: "GET",
        url: `/v2/voice-rooms/${voiceRoomId}/members?role=listener&limit=2`,
        headers: commonHeaders(),
      });
      expect(first.statusCode).toBe(200);
      const firstBody = jsonOf<{
        items: readonly unknown[];
        nextCursor: string | null;
      }>(first);
      expect(firstBody.items).toHaveLength(2);
      expect(typeof firstBody.nextCursor).toBe("string");

      const second = await app.inject({
        method: "GET",
        url: `/v2/voice-rooms/${voiceRoomId}/members?role=listener&cursor=${encodeURIComponent(firstBody.nextCursor ?? "")}`,
        headers: commonHeaders(),
      });
      expect(second.statusCode).toBe(200);
      expect(jsonOf<{ nextCursor: string | null }>(second).nextCursor).toBe(
        null,
      );
      expect(
        communicationMocks["listVoiceRoomMembers"],
      ).toHaveBeenLastCalledWith({
        voiceRoomId,
        viewerUserId: accountId,
        role: "listener",
        limit: 3,
        after: {
          lastJoinedAt: "2026-09-08T01:00:01.000Z",
          lastPublicProfileId: anonymousProfileId,
        },
      });

      for (const url of [
        // cursor and limit are mutually exclusive
        `/v2/voice-rooms/${voiceRoomId}/members?role=listener&limit=2&cursor=${encodeURIComponent(firstBody.nextCursor ?? "")}`,
        // the view is bound into the cursor
        `/v2/voice-rooms/${voiceRoomId}/members?role=speaker&cursor=${encodeURIComponent(firstBody.nextCursor ?? "")}`,
        // role is required and enumerated
        `/v2/voice-rooms/${voiceRoomId}/members`,
        `/v2/voice-rooms/${voiceRoomId}/members?role=host`,
      ]) {
        const rejected = await app.inject({
          method: "GET",
          url,
          headers: commonHeaders(),
        });
        expect(rejected.statusCode).toBe(400);
        expect(rejected.json()).toMatchObject({ code: "INVALID_REQUEST" });
      }
    });

    it("keeps the roster closed without a cursor codec", async () => {
      const dependencies = fakes();
      const app = await buildApp({
        config: testConfig(),
        contractSurface: "v2",
        database: dependencies.database,
        privyAccessTokenVerifier: dependencies.privyAccessTokenVerifier,
        streamCallGateway: dependencies.callGateway,
        streamCommunityChannelGateway: dependencies.channelGateway,
        voiceRoomService: createVoiceRoomService({
          repository: dependencies.communication,
          callGateway: dependencies.callGateway,
          cursorCodec: null,
        }),
        logger: false,
      });
      apps.push(app);
      // A page that would need a continuation cannot be signed, so it fails
      // closed instead of publishing an unpageable list.
      const response = await app.inject({
        method: "GET",
        url: `/v2/voice-rooms/${voiceRoomId}/members?role=listener&limit=2`,
        headers: commonHeaders(),
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    });

    it("mutes one speaker through the host's row command", async () => {
      const { app, callMocks, communicationMocks } = await createApp();
      const response = await app.inject({
        method: "POST",
        url: `/v2/voice-rooms/${voiceRoomId}/speakers/${targetProfileId}/mute`,
        headers: commandHeaders(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        viewer: { role: "host" },
        providerSync: { status: "confirmed", reasonCode: null },
      });
      expect(communicationMocks["muteSpeaker"]).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: accountId,
          voiceRoomId,
          targetPublicProfileId: targetProfileId,
        }),
      );
      expect(callMocks["muteUser"]).toHaveBeenCalledWith(
        expect.objectContaining({
          callId,
          mutedByStreamUserId: `loop_${accountId.replaceAll("-", "")}`,
          streamUserId: `loop_${targetProfileId.replaceAll("-", "")}`,
        }),
      );
      expect(callMocks["muteUsers"]).not.toHaveBeenCalled();
    });

    it("reports an unconfirmed per-member mute without failing the command", async () => {
      const callGateway = callGatewayFake({
        muteUser: vi.fn(() => Promise.reject(new Error("provider"))),
      });
      const { app } = await createApp(fakes({ callGateway }));
      const response = await app.inject({
        method: "POST",
        url: `/v2/voice-rooms/${voiceRoomId}/speakers/${targetProfileId}/mute`,
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

    it("lets a muted speaker clear its own mute intent without any Stream write (Decision 0053)", async () => {
      const { app, callMocks, communicationMocks } = await createApp();
      const response = await app.inject({
        method: "DELETE",
        url: `/v2/voice-rooms/${voiceRoomId}/speakers/${selfProfileId}/mute`,
        headers: commandHeaders(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toMatchObject({
        viewer: { role: "speaker" },
        providerSync: { status: "confirmed", reasonCode: null },
        participants: { observed: { status: "available" } },
      });
      expect(communicationMocks["unmuteSpeaker"]).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: accountId,
          voiceRoomId,
          targetPublicProfileId: selfProfileId,
        }),
      );
      expect(callMocks["muteUser"]).not.toHaveBeenCalled();
      expect(callMocks["muteUsers"]).not.toHaveBeenCalled();
      expect(callMocks["updateUserPermissions"]).not.toHaveBeenCalled();
      expect(callMocks["updateCallMembers"]).not.toHaveBeenCalled();
    });

    it("keeps unmute closed to anyone but the target and the host", async () => {
      const communication = communicationRepositoryFake({
        unmuteSpeaker: vi.fn(() =>
          Promise.reject(new CommunicationPermissionDeniedError()),
        ),
      });
      const { app } = await createApp(fakes({ communication }));
      const response = await app.inject({
        method: "DELETE",
        url: `/v2/voice-rooms/${voiceRoomId}/speakers/${targetProfileId}/mute`,
        headers: commandHeaders(),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        code: "PERMISSION_DENIED",
        category: "authorization",
        retryable: false,
      });
    });

    it("rejects unmuting a speaker that is not muted as DATA_STALE", async () => {
      const communication = communicationRepositoryFake({
        unmuteSpeaker: vi.fn(() =>
          Promise.reject(new CommunicationDataStaleError()),
        ),
      });
      const { app } = await createApp(fakes({ communication }));
      const response = await app.inject({
        method: "DELETE",
        url: `/v2/voice-rooms/${voiceRoomId}/speakers/${selfProfileId}/mute`,
        headers: commandHeaders(),
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "DATA_STALE" });
    });

    it("requires the write headers on unmute like every other command", async () => {
      const { app, communicationMocks } = await createApp();
      const response = await app.inject({
        method: "DELETE",
        url: `/v2/voice-rooms/${voiceRoomId}/speakers/${selfProfileId}/mute`,
        headers: commonHeaders(),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "INVALID_REQUEST" });
      expect(communicationMocks["unmuteSpeaker"]).not.toHaveBeenCalled();
    });

    it("rejects muting a listener or an already muted speaker as DATA_STALE", async () => {
      const communication = communicationRepositoryFake({
        muteSpeaker: vi.fn(() =>
          Promise.reject(new CommunicationDataStaleError()),
        ),
      });
      const { app, callMocks } = await createApp(fakes({ communication }));
      const response = await app.inject({
        method: "POST",
        url: `/v2/voice-rooms/${voiceRoomId}/speakers/${targetProfileId}/mute`,
        headers: commandHeaders(),
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "DATA_STALE" });
      expect(callMocks["muteUser"]).not.toHaveBeenCalled();
    });
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

  it("publishes the hand-raise queue in sequence order with the roster's identity projection (Decision 0053)", async () => {
    const { app, communicationMocks } = await createApp();
    const response = await app.inject({
      method: "GET",
      url: `/v2/voice-rooms/${voiceRoomId}/hand-raises`,
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    // The host sees every target and may invite from the queue.
    expect(response.json()).toEqual({
      items: [
        {
          handRaiseId: voiceRoomId,
          sequence: "1",
          state: "pending",
          createdAt,
          publicProfileId: targetProfileId,
          display: {
            kind: "alias",
            alias: "frog_maxi",
            publicProfileId: targetProfileId,
            audience: "everyone",
          },
          isSelf: false,
          commands: ["invite_speaker"],
        },
        {
          handRaiseId: communityId,
          sequence: "2",
          state: "pending",
          createdAt,
          publicProfileId: anonymousProfileId,
          display: {
            kind: "anonymous",
            labelKey: "voiceRoom.member.anonymousMember",
          },
          isSelf: false,
          commands: ["invite_speaker"],
        },
        {
          handRaiseId: groupId,
          sequence: "3",
          state: "pending",
          createdAt,
          publicProfileId: selfProfileId,
          display: {
            kind: "alias",
            alias: "cy",
            publicProfileId: selfProfileId,
            audience: "self",
          },
          isSelf: true,
          commands: ["invite_speaker"],
        },
      ],
      display: {
        anonymousMemberKey: "voiceRoom.member.anonymousMember",
        ruleKey: "voiceRoom.member.display.anonymousModeOnly",
      },
      contractVersion: "2.0",
    });
    expect(communicationMocks["listHandRaises"]).toHaveBeenCalledWith({
      voiceRoomId,
      viewerUserId: accountId,
      limit: 50,
    });
  });

  it("hides the anonymous hand raiser's target from a non-host and hands out no command", async () => {
    const communication = communicationRepositoryFake({
      listHandRaises: vi.fn(() =>
        Promise.resolve({
          room: room({ viewerRole: "listener" }),
          items: handRaiseRows(),
        }),
      ),
    });
    const { app } = await createApp(fakes({ communication }));
    const response = await app.inject({
      method: "GET",
      url: `/v2/voice-rooms/${voiceRoomId}/hand-raises`,
      headers: commonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    const body = jsonOf<{
      items: readonly {
        publicProfileId: string | null;
        display: { kind: string };
        isSelf: boolean;
        commands: readonly string[];
      }[];
    }>(response);
    expect(body.items.map((entry) => entry.publicProfileId)).toEqual([
      targetProfileId,
      null,
      selfProfileId,
    ]);
    expect(body.items.map((entry) => entry.display.kind)).toEqual([
      "alias",
      "anonymous",
      "alias",
    ]);
    expect(body.items.map((entry) => entry.isSelf)).toEqual([
      false,
      false,
      true,
    ]);
    expect(body.items.map((entry) => entry.commands)).toEqual([[], [], []]);
    expect(JSON.stringify(body)).not.toContain("loopId");
    expect(JSON.stringify(body)).not.toContain("avatarRef");
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
              backstage: false,
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
