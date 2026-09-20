import {
  createCommunityPersonaAliasGenerator,
  isCommunityPersonaAlias,
} from "./community-persona-generator.js";
import type {
  CommunityChannelPersonaRecord,
  CommunityChannelPersonaRepository,
} from "./communication-repository.js";
import type { StreamCommunityChannelGateway } from "../../integrations/stream/channel-gateway.js";

export const COMMUNITY_PERSONA_PROJECTION_BATCH_LIMIT = 20;
export const COMMUNITY_PERSONA_PROJECTION_LEASE_SECONDS = 60;
export const COMMUNITY_PERSONA_RETRY_BASE_SECONDS = 5;
export const COMMUNITY_PERSONA_RETRY_MAX_SECONDS = 3_600;

export type CommunityPersonaProjectionOutcome = "confirmed" | "pending";

export interface ProjectCommunityPersonaInput {
  readonly persona: CommunityChannelPersonaRecord;
  readonly streamChannelId: string;
  readonly memberStreamUserId: string;
  readonly signal: AbortSignal;
}

export type CommunityPersonaSyncResult = Readonly<{
  claimedCount: number;
  confirmedCount: number;
  deferredCount: number;
}>;

/**
 * Decision 0055 persona service: the single place that generates a persona,
 * projects it onto the Stream channel member, and records the outcome. The
 * database is the authority; a projection is `confirmed` only after Stream
 * echoed the exact custom fields, otherwise it stays `pending` and is retried
 * with bounded backoff.
 */
export interface CommunityPersonaService {
  ensurePersona(input: {
    readonly communityId: string;
    readonly ownerUserId: string;
  }): Promise<CommunityChannelPersonaRecord>;
  confirmProjection(input: { readonly personaId: string }): Promise<void>;
  /** Mark the projection due now (after an `add` that did not echo it). */
  requestProjection(input: { readonly personaId: string }): Promise<void>;
  /** Mark the member's projection pending (after a `remove`). */
  resetProjectionForMember(input: {
    readonly communityId: string;
    readonly ownerUserId: string;
  }): Promise<void>;
  /** One `updateMemberPartial` for an existing member; never throws on a provider failure. */
  projectPersona(
    input: ProjectCommunityPersonaInput,
  ): Promise<CommunityPersonaProjectionOutcome>;
  /** Claim due pending personas and project each once. */
  syncPendingProjections(input: {
    readonly limit?: number;
    readonly signal: AbortSignal;
  }): Promise<CommunityPersonaSyncResult>;
}

export interface CreateCommunityPersonaServiceOptions {
  readonly personas: CommunityChannelPersonaRepository;
  readonly gateway: Pick<StreamCommunityChannelGateway, "projectMemberPersona">;
  readonly generateAlias?: () => string;
}

export function personaRetryDelaySeconds(projectionAttempts: number): number {
  return Math.min(
    COMMUNITY_PERSONA_RETRY_BASE_SECONDS *
      2 ** Math.max(projectionAttempts - 1, 0),
    COMMUNITY_PERSONA_RETRY_MAX_SECONDS,
  );
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export function createCommunityPersonaService(
  options: CreateCommunityPersonaServiceOptions,
): CommunityPersonaService {
  const generateAlias =
    options.generateAlias ?? createCommunityPersonaAliasGenerator();

  async function projectPersona(
    input: ProjectCommunityPersonaInput,
  ): Promise<CommunityPersonaProjectionOutcome> {
    if (!isCommunityPersonaAlias(input.persona.alias)) {
      // A row that violates the alias shape is never sent to the provider.
      await options.personas.resetProjection({
        personaId: input.persona.personaId,
        retryDelaySeconds: COMMUNITY_PERSONA_RETRY_MAX_SECONDS,
      });
      return "pending";
    }
    try {
      await options.gateway.projectMemberPersona({
        channelId: input.streamChannelId,
        streamUserId: input.memberStreamUserId,
        personaId: input.persona.personaId,
        alias: input.persona.alias,
        signal: input.signal,
      });
    } catch (error) {
      if (isAborted(input.signal)) {
        throw error;
      }
      await options.personas.resetProjection({
        personaId: input.persona.personaId,
        retryDelaySeconds: personaRetryDelaySeconds(
          input.persona.projectionAttempts,
        ),
      });
      return "pending";
    }
    await options.personas.confirmProjection({
      personaId: input.persona.personaId,
    });
    return "confirmed";
  }

  return Object.freeze({
    ensurePersona(input: {
      readonly communityId: string;
      readonly ownerUserId: string;
    }): Promise<CommunityChannelPersonaRecord> {
      return options.personas.ensurePersona({
        communityId: input.communityId,
        ownerUserId: input.ownerUserId,
        generateAlias,
      });
    },

    confirmProjection(input: { readonly personaId: string }): Promise<void> {
      return options.personas.confirmProjection(input);
    },

    requestProjection(input: { readonly personaId: string }): Promise<void> {
      return options.personas.resetProjection({
        personaId: input.personaId,
        retryDelaySeconds: 0,
      });
    },

    resetProjectionForMember(input: {
      readonly communityId: string;
      readonly ownerUserId: string;
    }): Promise<void> {
      return options.personas.resetProjectionForMember({
        communityId: input.communityId,
        ownerUserId: input.ownerUserId,
        retryDelaySeconds: 0,
      });
    },

    projectPersona,

    async syncPendingProjections(input: {
      readonly limit?: number;
      readonly signal: AbortSignal;
    }): Promise<CommunityPersonaSyncResult> {
      input.signal.throwIfAborted();
      const targets = await options.personas.claimPendingProjections({
        limit: input.limit ?? COMMUNITY_PERSONA_PROJECTION_BATCH_LIMIT,
        leaseSeconds: COMMUNITY_PERSONA_PROJECTION_LEASE_SECONDS,
      });
      let confirmedCount = 0;
      let deferredCount = 0;
      for (const target of targets) {
        input.signal.throwIfAborted();
        const outcome = await projectPersona({
          persona: target.persona,
          streamChannelId: target.streamChannelId,
          memberStreamUserId: target.memberStreamUserId,
          signal: input.signal,
        });
        if (outcome === "confirmed") {
          confirmedCount += 1;
        } else {
          deferredCount += 1;
        }
      }
      return Object.freeze({
        claimedCount: targets.length,
        confirmedCount,
        deferredCount,
      });
    },
  });
}
