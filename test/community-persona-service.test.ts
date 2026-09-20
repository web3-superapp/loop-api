import { describe, expect, it, vi } from "vitest";

import {
  createUnavailableCommunityChannelPersonaRepository,
  type CommunityChannelPersonaRecord,
  type CommunityChannelPersonaRepository,
} from "../src/features/communication/communication-repository.js";
import {
  COMMUNITY_PERSONA_PROJECTION_BATCH_LIMIT,
  COMMUNITY_PERSONA_PROJECTION_LEASE_SECONDS,
  createCommunityPersonaService,
  personaRetryDelaySeconds,
} from "../src/features/communication/community-persona-service.js";
import {
  StreamChannelGatewayUnavailableError,
  StreamChannelRequestRejectedError,
} from "../src/integrations/stream/channel-gateway.js";

const communityId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const ownerUserId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const personaId = "b5d6f0c2-2d1e-4c3a-9f6b-7a8c9d0e1f2a";
const streamChannelId = `loop_community_${communityId.replaceAll("-", "")}`;
const memberStreamUserId = `loop_${ownerUserId.replaceAll("-", "")}`;

function persona(
  overrides: Partial<CommunityChannelPersonaRecord> = {},
): CommunityChannelPersonaRecord {
  return Object.freeze({
    personaId,
    communityId,
    ownerUserId,
    alias: "Harbor-4821",
    aliasVersion: 1 as const,
    projectionState: "pending" as const,
    projectionAttempts: 1,
    ...overrides,
  });
}

function repositoryFake(
  overrides: Partial<CommunityChannelPersonaRepository> = {},
) {
  const ensurePersona = vi.fn(
    (input: { readonly generateAlias: () => string }) =>
      Promise.resolve(persona({ alias: input.generateAlias() })),
  );
  const confirmProjection = vi.fn(() => Promise.resolve());
  const resetProjection = vi.fn(() => Promise.resolve());
  const resetProjectionForMember = vi.fn(() => Promise.resolve());
  const claimPendingProjections = vi.fn(() => Promise.resolve([]));
  const repository: CommunityChannelPersonaRepository = {
    ...createUnavailableCommunityChannelPersonaRepository(),
    ensurePersona,
    confirmProjection,
    resetProjection,
    resetProjectionForMember,
    claimPendingProjections,
    ...overrides,
  };
  return {
    repository,
    ensurePersona,
    confirmProjection,
    resetProjection,
    resetProjectionForMember,
    claimPendingProjections,
  };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe("community persona service (Decision 0055)", () => {
  it("generates through the injected alias generator", async () => {
    const personas = repositoryFake();
    const service = createCommunityPersonaService({
      personas: personas.repository,
      gateway: { projectMemberPersona: vi.fn(() => Promise.resolve()) },
      generateAlias: () => "Comet-0042",
    });

    const record = await service.ensurePersona({ communityId, ownerUserId });

    expect(record.alias).toBe("Comet-0042");
    expect(personas.ensurePersona).toHaveBeenCalledWith(
      expect.objectContaining({ communityId, ownerUserId }),
    );
  });

  it("uses the real generator when none is injected", async () => {
    const personas = repositoryFake();
    const service = createCommunityPersonaService({
      personas: personas.repository,
      gateway: { projectMemberPersona: vi.fn(() => Promise.resolve()) },
    });

    const record = await service.ensurePersona({ communityId, ownerUserId });

    expect(record.alias).toMatch(/^[A-Z][a-z]{2,15}-[0-9]{4}$/);
  });

  it("confirms only after the gateway resolved", async () => {
    const personas = repositoryFake();
    const projectMemberPersona = vi.fn(() => Promise.resolve());
    const service = createCommunityPersonaService({
      personas: personas.repository,
      gateway: { projectMemberPersona },
    });

    const outcome = await service.projectPersona({
      persona: persona(),
      streamChannelId,
      memberStreamUserId,
      signal: signal(),
    });

    expect(outcome).toBe("confirmed");
    expect(projectMemberPersona).toHaveBeenCalledWith({
      channelId: streamChannelId,
      streamUserId: memberStreamUserId,
      personaId,
      alias: "Harbor-4821",
      signal: expect.any(AbortSignal) as AbortSignal,
    });
    expect(personas.confirmProjection).toHaveBeenCalledWith({ personaId });
    expect(personas.resetProjection).not.toHaveBeenCalled();
  });

  it("keeps the persona pending with backoff when the provider is unavailable", async () => {
    const personas = repositoryFake();
    const service = createCommunityPersonaService({
      personas: personas.repository,
      gateway: {
        projectMemberPersona: vi.fn(() =>
          Promise.reject(new StreamChannelGatewayUnavailableError()),
        ),
      },
    });

    const outcome = await service.projectPersona({
      persona: persona({ projectionAttempts: 3 }),
      streamChannelId,
      memberStreamUserId,
      signal: signal(),
    });

    expect(outcome).toBe("pending");
    expect(personas.confirmProjection).not.toHaveBeenCalled();
    expect(personas.resetProjection).toHaveBeenCalledWith({
      personaId,
      retryDelaySeconds: 20,
    });
  });

  it("treats a deterministic rejection the same way (no terminal persona state)", async () => {
    const personas = repositoryFake();
    const service = createCommunityPersonaService({
      personas: personas.repository,
      gateway: {
        projectMemberPersona: vi.fn(() =>
          Promise.reject(new StreamChannelRequestRejectedError()),
        ),
      },
    });

    const outcome = await service.projectPersona({
      persona: persona({ projectionAttempts: 20 }),
      streamChannelId,
      memberStreamUserId,
      signal: signal(),
    });

    expect(outcome).toBe("pending");
    expect(personas.resetProjection).toHaveBeenCalledWith({
      personaId,
      retryDelaySeconds: 3_600,
    });
  });

  it("never sends a malformed alias to the provider", async () => {
    const personas = repositoryFake();
    const projectMemberPersona = vi.fn(() => Promise.resolve());
    const service = createCommunityPersonaService({
      personas: personas.repository,
      gateway: { projectMemberPersona },
    });

    const outcome = await service.projectPersona({
      persona: persona({ alias: "loop_3bb585972e3145e7b5f0957803a824ed" }),
      streamChannelId,
      memberStreamUserId,
      signal: signal(),
    });

    expect(outcome).toBe("pending");
    expect(projectMemberPersona).not.toHaveBeenCalled();
    expect(personas.resetProjection).toHaveBeenCalledWith({
      personaId,
      retryDelaySeconds: 3_600,
    });
  });

  it("rethrows an abort instead of recording a backoff", async () => {
    const personas = repositoryFake();
    const controller = new AbortController();
    const service = createCommunityPersonaService({
      personas: personas.repository,
      gateway: {
        projectMemberPersona: vi.fn(() => {
          controller.abort();
          return Promise.reject(new StreamChannelGatewayUnavailableError());
        }),
      },
    });

    await expect(
      service.projectPersona({
        persona: persona(),
        streamChannelId,
        memberStreamUserId,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(StreamChannelGatewayUnavailableError);
    expect(personas.resetProjection).not.toHaveBeenCalled();
  });

  it("claims pending projections with the compiled batch and lease, then projects each once", async () => {
    const targets = [
      {
        persona: persona(),
        streamChannelId,
        memberStreamUserId,
      },
      {
        persona: persona({
          personaId: "c6e7a1d3-3e2f-4d4b-8a7c-8b9d0e1f2a3b",
          alias: "Owl-0007",
        }),
        streamChannelId,
        memberStreamUserId,
      },
    ];
    const claimPendingProjections = vi.fn(() => Promise.resolve(targets));
    const personas = repositoryFake({ claimPendingProjections });
    const projectMemberPersona = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new StreamChannelGatewayUnavailableError());
    const service = createCommunityPersonaService({
      personas: personas.repository,
      gateway: { projectMemberPersona },
    });

    const result = await service.syncPendingProjections({ signal: signal() });

    expect(claimPendingProjections).toHaveBeenCalledWith({
      limit: COMMUNITY_PERSONA_PROJECTION_BATCH_LIMIT,
      leaseSeconds: COMMUNITY_PERSONA_PROJECTION_LEASE_SECONDS,
    });
    expect(projectMemberPersona).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      claimedCount: 2,
      confirmedCount: 1,
      deferredCount: 1,
    });
  });

  it("requests an immediate projection and resets a removed member's persona", async () => {
    const personas = repositoryFake();
    const service = createCommunityPersonaService({
      personas: personas.repository,
      gateway: { projectMemberPersona: vi.fn(() => Promise.resolve()) },
    });

    await service.requestProjection({ personaId });
    await service.resetProjectionForMember({ communityId, ownerUserId });

    expect(personas.resetProjection).toHaveBeenCalledWith({
      personaId,
      retryDelaySeconds: 0,
    });
    expect(personas.resetProjectionForMember).toHaveBeenCalledWith({
      communityId,
      ownerUserId,
      retryDelaySeconds: 0,
    });
  });

  it("doubles the retry delay from 5 s and caps it at one hour", () => {
    expect(personaRetryDelaySeconds(0)).toBe(5);
    expect(personaRetryDelaySeconds(1)).toBe(5);
    expect(personaRetryDelaySeconds(2)).toBe(10);
    expect(personaRetryDelaySeconds(5)).toBe(80);
    expect(personaRetryDelaySeconds(30)).toBe(3_600);
  });
});
