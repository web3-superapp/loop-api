import {
  createCommunityPersonaAliasGenerator,
  isCommunityPersonaAlias,
} from "./community-persona-generator.js";
import type {
  CommunityChannelPersonaLease,
  CommunityChannelPersonaRepository,
} from "./communication-repository.js";
import type { StreamCommunityChannelGateway } from "../../integrations/stream/channel-gateway.js";

export const COMMUNITY_PERSONA_PROJECTION_BATCH_LIMIT = 20;
export const COMMUNITY_PERSONA_PROJECTION_LEASE_SECONDS = 60;
export const COMMUNITY_PERSONA_RETRY_BASE_SECONDS = 5;
export const COMMUNITY_PERSONA_RETRY_MAX_SECONDS = 3_600;

export type CommunityPersonaProjectionOutcome = "confirmed" | "pending";

export interface ProjectCommunityPersonaInput extends CommunityChannelPersonaLease {
  readonly streamChannelId: string;
  readonly memberStreamUserId: string;
  readonly signal: AbortSignal;
}

export type CommunityPersonaSyncResult = Readonly<{
  claimedCount: number;
  confirmedCount: number;
  deferredCount: number;
}>;

export type CommunityPersonaServiceLogMessage =
  | "Community persona projection lease was lost; outcome not recorded"
  | "Community persona projection was not confirmed";

/** Sanitized warn lines only: identifiers and an error class, never a body. */
export interface CommunityPersonaLogContext {
  readonly personaId: string;
  readonly write?: "confirm" | "reset";
  readonly projectionAttempts?: number;
  readonly errorName?: string;
}

export interface CommunityPersonaServiceLogger {
  warn(
    context: CommunityPersonaLogContext,
    message: CommunityPersonaServiceLogMessage,
  ): void;
}

/**
 * Decision 0055 persona service: the single place that generates a persona,
 * projects it onto the Stream channel member, and records the outcome. The
 * database is the authority; a projection is `confirmed` only after Stream
 * echoed the exact custom fields, otherwise it stays `pending` and is retried
 * with bounded backoff. Every bookkeeping write presents the projection lease
 * it was issued, so a stale holder never overwrites a newer outcome.
 */
export interface CommunityPersonaService {
  ensurePersona(input: {
    readonly communityId: string;
    readonly ownerUserId: string;
  }): Promise<CommunityChannelPersonaLease>;
  /** Fenced confirm; false when the lease was lost. */
  confirmProjection(input: {
    readonly personaId: string;
    readonly leaseToken: string;
  }): Promise<boolean>;
  /**
   * Schedule the next projection with the persona's backoff (5 s base) after
   * an `add` whose response did not echo the persona. Fenced; false when the
   * lease was lost.
   */
  requestProjection(input: CommunityChannelPersonaLease): Promise<boolean>;
  /** Mark the member's persona pending (after a `remove`); unfenced. */
  resetProjectionForMember(input: {
    readonly communityId: string;
    readonly ownerUserId: string;
  }): Promise<void>;
  /** One `updateMemberPartial` for a leased persona; never throws on a provider failure. */
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
  readonly logger?: CommunityPersonaServiceLogger;
}

export function personaRetryDelaySeconds(projectionAttempts: number): number {
  return Math.min(
    COMMUNITY_PERSONA_RETRY_BASE_SECONDS *
      2 ** Math.max(projectionAttempts - 1, 0),
    COMMUNITY_PERSONA_RETRY_MAX_SECONDS,
  );
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

export function createCommunityPersonaService(
  options: CreateCommunityPersonaServiceOptions,
): CommunityPersonaService {
  const generateAlias =
    options.generateAlias ?? createCommunityPersonaAliasGenerator();

  function warnLeaseLost(personaId: string, write: "confirm" | "reset"): void {
    options.logger?.warn(
      { personaId, write },
      "Community persona projection lease was lost; outcome not recorded",
    );
  }

  async function reset(
    lease: CommunityChannelPersonaLease,
    retryDelaySeconds: number,
  ): Promise<boolean> {
    const written = await options.personas.resetProjection({
      personaId: lease.persona.personaId,
      leaseToken: lease.leaseToken,
      retryDelaySeconds,
    });
    if (!written) {
      warnLeaseLost(lease.persona.personaId, "reset");
    }
    return written;
  }

  async function projectPersona(
    input: ProjectCommunityPersonaInput,
  ): Promise<CommunityPersonaProjectionOutcome> {
    if (!isCommunityPersonaAlias(input.persona.alias)) {
      // A row that violates the alias shape is never sent to the provider.
      await reset(input, COMMUNITY_PERSONA_RETRY_MAX_SECONDS);
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
      if (input.signal.aborted) {
        throw error;
      }
      options.logger?.warn(
        {
          personaId: input.persona.personaId,
          projectionAttempts: input.persona.projectionAttempts,
          errorName: errorName(error),
        },
        "Community persona projection was not confirmed",
      );
      await reset(
        input,
        personaRetryDelaySeconds(input.persona.projectionAttempts),
      );
      return "pending";
    }
    const written = await options.personas.confirmProjection({
      personaId: input.persona.personaId,
      leaseToken: input.leaseToken,
    });
    if (!written) {
      warnLeaseLost(input.persona.personaId, "confirm");
      return "pending";
    }
    return "confirmed";
  }

  return Object.freeze({
    ensurePersona(input: {
      readonly communityId: string;
      readonly ownerUserId: string;
    }): Promise<CommunityChannelPersonaLease> {
      return options.personas.ensurePersona({
        communityId: input.communityId,
        ownerUserId: input.ownerUserId,
        generateAlias,
      });
    },

    async confirmProjection(input: {
      readonly personaId: string;
      readonly leaseToken: string;
    }): Promise<boolean> {
      const written = await options.personas.confirmProjection(input);
      if (!written) {
        warnLeaseLost(input.personaId, "confirm");
      }
      return written;
    },

    requestProjection(input: CommunityChannelPersonaLease): Promise<boolean> {
      return reset(
        input,
        personaRetryDelaySeconds(input.persona.projectionAttempts),
      );
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
          leaseToken: target.leaseToken,
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
