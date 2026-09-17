import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import {
  InvalidV2CursorError,
  type V2CursorCodec,
  type V2CursorContinuation,
} from "../../core/http/v2-cursor.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import {
  streamSendAudioPermission,
  StreamCallGatewayUnavailableError,
  type StreamCallGateway,
} from "../../integrations/stream/call-gateway.js";
import { parseListLimit } from "../community/community-contract.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import {
  communicationCommandDigest,
  communicationUnavailableReasonCodes,
  parseCommunicationOpaqueId,
  parseCommunicationPublicProfileId,
  voiceCallCid,
  voiceRoomCursorRoutes,
  voiceRoomMemberAnonymousKey,
  voiceRoomMemberDisplayRuleKey,
  voiceRoomMemberListLimits,
  voiceRoomMemberRoleFilters,
  voiceRoomMembersFilter,
  type CommunicationUnavailableProjection,
  type HandRaiseState,
  type VoiceRoomMemberCommand,
  type VoiceRoomMemberRoleFilter,
  type VoiceRoomProvisionState,
  type VoiceRoomRole,
  type VoiceRoomState,
} from "./communication-contract.js";
import {
  CommunicationDataStaleError,
  CommunicationIdempotencyConflictError,
  CommunicationNotFoundError,
  CommunicationPermissionDeniedError,
  CommunicationProfileRequiredError,
  CommunicationRepositoryUnavailableError,
  CommunicationResourceConflictError,
  CommunicationUnprovisionedRoomError,
  type CommunicationRepository,
  type HandRaiseQueueEntryRecord,
  type VoiceRoomIdentity,
  type VoiceRoomMemberRecord,
  type VoiceRoomViewerRecord,
} from "./communication-repository.js";

/**
 * V2 voice-room service (Decision 0032).
 *
 * LOOP PostgreSQL is authoritative for the room lifecycle, the host identity,
 * the LOOP-side role intent, and the hand-raise queue. Stream stays
 * authoritative for participants, media state, and live permissions. Every
 * command commits locally first and then attempts exactly one Stream call; the
 * response always reports whether that call was confirmed, so a committed LOOP
 * transition is never presented as a confirmed provider fact.
 */

const joinGrantSeconds = 3_600;

export type VoiceRoomProviderSync =
  | Readonly<{ status: "confirmed"; reasonCode: null }>
  | Readonly<{ status: "unconfirmed"; reasonCode: string }>;

export interface VoiceRoomHandRaiseProjection {
  readonly handRaiseId: string;
  readonly sequence: string;
  readonly state: HandRaiseState;
  readonly createdAt: string;
}

/**
 * Three counts with three meanings (Decision 0051). `speakerCount` and
 * `listenerCount` are LOOP role intent and exclude the host; `joinedCount` is
 * every joined LOOP member including the host; `observed.memberCount` is the
 * accounts Stream lets into the call; `observed.participantCount` is the
 * devices connected to the live session right now.
 */
export interface VoiceRoomParticipantsProjection {
  readonly speakerCount: number;
  readonly listenerCount: number;
  readonly joinedCount: number;
  readonly observed:
    | Readonly<{
        status: "available";
        participantCount: number;
        memberCount: number;
        observedAt: string;
      }>
    | CommunicationUnavailableProjection;
}

export interface VoiceRoomResource {
  readonly room: {
    readonly voiceRoomId: string;
    readonly communityId: string;
    /** The community's current name, so a room banner never needs a second read. */
    readonly communityName: string;
    readonly callCid: string;
    readonly state: VoiceRoomState;
    readonly provisionState: VoiceRoomProvisionState;
    readonly backstage: boolean;
    readonly createdAt: string;
    readonly endedAt: string | null;
  };
  readonly viewer: {
    readonly role: VoiceRoomRole | null;
    readonly canInviteSpeakers: boolean;
    readonly canMuteAll: boolean;
    readonly canEndRoom: boolean;
    readonly handRaise: VoiceRoomHandRaiseProjection | null;
    readonly expiresAt: string | null;
  };
  readonly participants: VoiceRoomParticipantsProjection;
  readonly providerSync: VoiceRoomProviderSync;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface VoiceRoomCurrentResource {
  readonly current: VoiceRoomResource | null;
  readonly reasonCode: string | null;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface VoiceRoomHandRaiseQueueEntry {
  readonly handRaiseId: string;
  readonly sequence: string;
  readonly state: HandRaiseState;
  readonly createdAt: string;
  readonly profile: VoiceRoomIdentity;
}

export interface VoiceRoomHandRaiseQueueResource {
  readonly items: readonly VoiceRoomHandRaiseQueueEntry[];
  readonly contractVersion: typeof v2ContractVersion;
}

/**
 * The leaderboard display rule reused (Decision 0049 → 0052 §2): anonymous
 * mode alone decides the name others see; the viewer always sees its own
 * alias, with `audience: "self"` while its anonymous mode is on.
 */
export type VoiceRoomMemberDisplayProjection =
  | Readonly<{
      kind: "alias";
      alias: string;
      publicProfileId: string;
      audience: "everyone" | "self";
    }>
  | Readonly<{
      kind: "anonymous";
      labelKey: typeof voiceRoomMemberAnonymousKey;
    }>;

export interface VoiceRoomMemberRowProjection {
  /**
   * The command target. Null when the row is anonymous to this viewer and
   * the viewer is not the host: an anonymous member is addressable by the
   * host (who must be able to remove or mute anyone) and by nobody else.
   */
  readonly publicProfileId: string | null;
  readonly display: VoiceRoomMemberDisplayProjection;
  readonly role: VoiceRoomMemberRoleFilter;
  readonly joinedAt: string;
  readonly handRaised: boolean;
  readonly muted: boolean;
  readonly isSelf: boolean;
  readonly commands: readonly VoiceRoomMemberCommand[];
}

export interface VoiceRoomMemberListResource {
  readonly role: VoiceRoomMemberRoleFilter;
  readonly items: readonly VoiceRoomMemberRowProjection[];
  readonly nextCursor: string | null;
  readonly display: {
    readonly anonymousMemberKey: typeof voiceRoomMemberAnonymousKey;
    readonly ruleKey: typeof voiceRoomMemberDisplayRuleKey;
  };
  readonly contractVersion: typeof v2ContractVersion;
}

export interface VoiceRoomReadInput {
  readonly principal: AuthenticatedLoopPrincipal;
  readonly signal: AbortSignal;
}

export interface VoiceRoomMemberListInput extends VoiceRoomReadInput {
  readonly voiceRoomId: unknown;
  readonly role: unknown;
  readonly cursor: unknown;
  readonly limit: unknown;
}

export interface VoiceRoomCommunityReadInput extends VoiceRoomReadInput {
  readonly communityId: unknown;
}

export interface VoiceRoomRoomReadInput extends VoiceRoomReadInput {
  readonly voiceRoomId: unknown;
}

export interface VoiceRoomCommandContext {
  readonly principal: AuthenticatedLoopPrincipal;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly signal: AbortSignal;
}

export interface CreateVoiceRoomCommandInput extends VoiceRoomCommandContext {
  readonly communityId: unknown;
}

export interface VoiceRoomCommandInput extends VoiceRoomCommandContext {
  readonly voiceRoomId: unknown;
}

export interface VoiceRoomSpeakerCommandInput extends VoiceRoomCommandInput {
  readonly targetPublicProfileId: unknown;
}

export interface VoiceRoomService {
  createRoom(input: CreateVoiceRoomCommandInput): Promise<VoiceRoomResource>;
  getCurrentRoom(
    input: VoiceRoomCommunityReadInput,
  ): Promise<VoiceRoomCurrentResource>;
  getRoom(input: VoiceRoomRoomReadInput): Promise<VoiceRoomResource>;
  join(input: VoiceRoomCommandInput): Promise<VoiceRoomResource>;
  leave(input: VoiceRoomCommandInput): Promise<VoiceRoomResource>;
  raiseHand(input: VoiceRoomCommandInput): Promise<VoiceRoomResource>;
  cancelHandRaise(input: VoiceRoomCommandInput): Promise<VoiceRoomResource>;
  listHandRaises(
    input: VoiceRoomRoomReadInput,
  ): Promise<VoiceRoomHandRaiseQueueResource>;
  listMembers(
    input: VoiceRoomMemberListInput,
  ): Promise<VoiceRoomMemberListResource>;
  inviteSpeaker(
    input: VoiceRoomSpeakerCommandInput,
  ): Promise<VoiceRoomResource>;
  removeSpeaker(
    input: VoiceRoomSpeakerCommandInput,
  ): Promise<VoiceRoomResource>;
  muteSpeaker(input: VoiceRoomSpeakerCommandInput): Promise<VoiceRoomResource>;
  muteAll(input: VoiceRoomCommandInput): Promise<VoiceRoomResource>;
  endRoom(input: VoiceRoomCommandInput): Promise<VoiceRoomResource>;
}

const confirmedSync: VoiceRoomProviderSync = Object.freeze({
  status: "confirmed",
  reasonCode: null,
});

function unconfirmedSync(reasonCode: string): VoiceRoomProviderSync {
  return Object.freeze({ status: "unconfirmed", reasonCode });
}

function unavailableObservation(
  reasonCode: string,
): CommunicationUnavailableProjection {
  return Object.freeze({ status: "unavailable", reasonCode });
}

function mapRepositoryError(error: unknown): never {
  if (error instanceof CommunicationNotFoundError) {
    throw V2ApiError.notFound();
  }
  if (error instanceof CommunicationPermissionDeniedError) {
    throw V2ApiError.fromCode("PERMISSION_DENIED");
  }
  if (error instanceof CommunicationDataStaleError) {
    throw V2ApiError.fromCode("DATA_STALE");
  }
  if (error instanceof CommunicationIdempotencyConflictError) {
    throw V2ApiError.idempotencyConflict();
  }
  if (error instanceof CommunicationProfileRequiredError) {
    throw V2ApiError.fromCode("PROFILE_ACTIVATION_REQUIRED");
  }
  if (error instanceof CommunicationResourceConflictError) {
    throw V2ApiError.fromCode("RESOURCE_CONFLICT");
  }
  if (
    error instanceof CommunicationRepositoryUnavailableError ||
    error instanceof CommunicationUnprovisionedRoomError
  ) {
    throw V2ApiError.capabilityUnavailable();
  }
  throw error;
}

async function repositoryCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    return mapRepositoryError(error);
  }
}

export interface VoiceRoomServiceOptions {
  readonly repository: CommunicationRepository;
  readonly callGateway: StreamCallGateway;
  /** Null keeps the roster closed (CAPABILITY_UNAVAILABLE); no cursor secret, no page. */
  readonly cursorCodec?: V2CursorCodec | null;
  readonly now?: () => Date;
}

/**
 * The host's row commands (0052 §2), computed from the viewer's role and the
 * row's stored state; the write path re-checks the same predicate. A
 * listener can be invited; a speaker can be removed and, until muted, muted.
 * A non-host viewer receives no command on any row.
 */
export function voiceRoomMemberRowCommands(input: {
  readonly viewerIsHost: boolean;
  readonly roomLive: boolean;
  readonly row: Pick<VoiceRoomMemberRecord, "role" | "muted">;
}): readonly VoiceRoomMemberCommand[] {
  if (!input.viewerIsHost || !input.roomLive) {
    return Object.freeze([]);
  }
  if (input.row.role === "listener") {
    return Object.freeze(["invite_speaker"]);
  }
  return Object.freeze(
    input.row.muted ? ["remove_speaker"] : ["remove_speaker", "mute"],
  );
}

export function createUnavailableVoiceRoomService(): VoiceRoomService {
  const unavailable = (): Promise<never> =>
    Promise.reject(V2ApiError.capabilityUnavailable());
  return Object.freeze({
    createRoom: unavailable,
    getCurrentRoom: unavailable,
    getRoom: unavailable,
    join: unavailable,
    leave: unavailable,
    raiseHand: unavailable,
    cancelHandRaise: unavailable,
    listHandRaises: unavailable,
    listMembers: unavailable,
    inviteSpeaker: unavailable,
    removeSpeaker: unavailable,
    muteSpeaker: unavailable,
    muteAll: unavailable,
    endRoom: unavailable,
  });
}

export function createVoiceRoomService(
  options: VoiceRoomServiceOptions,
): VoiceRoomService {
  const now = options.now ?? (() => new Date());

  function resource(
    record: VoiceRoomViewerRecord,
    providerSync: VoiceRoomProviderSync,
    observed: VoiceRoomParticipantsProjection["observed"],
  ): VoiceRoomResource {
    const isHost = record.viewerRole === "host";
    const joined = record.viewerRole !== null && record.room.state === "live";
    return Object.freeze({
      room: Object.freeze({
        voiceRoomId: record.room.voiceRoomId,
        communityId: record.room.communityId,
        communityName: record.room.communityName,
        callCid: voiceCallCid(record.room.callId),
        state: record.room.state,
        provisionState: record.room.provisionState,
        backstage: record.room.backstage,
        createdAt: record.room.createdAt,
        endedAt: record.room.endedAt,
      }),
      viewer: Object.freeze({
        role: record.viewerRole,
        canInviteSpeakers: isHost && record.room.state === "live",
        canMuteAll: isHost && record.room.state === "live",
        canEndRoom: isHost && record.room.state === "live",
        handRaise:
          record.viewerHandRaise === null
            ? null
            : Object.freeze({
                handRaiseId: record.viewerHandRaise.handRaiseId,
                sequence: record.viewerHandRaise.sequence,
                state: record.viewerHandRaise.state,
                createdAt: record.viewerHandRaise.createdAt,
              }),
        expiresAt: joined
          ? new Date(now().getTime() + joinGrantSeconds * 1_000).toISOString()
          : null,
      }),
      participants: Object.freeze({
        speakerCount: record.speakerCount,
        listenerCount: record.listenerCount,
        joinedCount: record.joinedCount,
        observed,
      }),
      providerSync,
      contractVersion: v2ContractVersion,
    });
  }

  const notObserved = unavailableObservation(
    communicationUnavailableReasonCodes.participantCount,
  );

  /**
   * Two Stream reads, taken together: the authorized member count and the
   * live session participant count. Both carry one `observedAt`. If either
   * read fails, is truncated, or is aborted, the whole block is unavailable;
   * half an observation is never published as a number.
   */
  async function observeParticipants(
    callId: string,
    signal: AbortSignal,
  ): Promise<VoiceRoomParticipantsProjection["observed"]> {
    try {
      const [members, session] = await Promise.all([
        options.callGateway.queryMembers({ callId, signal }),
        options.callGateway.observeSession({ callId, signal }),
      ]);
      signal.throwIfAborted();
      if (!members.complete) {
        // A truncated page walk is a floor, not the member count.
        return notObserved;
      }
      return Object.freeze({
        status: "available" as const,
        participantCount: session.participantCount,
        memberCount: members.memberCount,
        observedAt:
          session.observedAt > members.observedAt
            ? session.observedAt
            : members.observedAt,
      });
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof StreamCallGatewayUnavailableError) {
        return notObserved;
      }
      return notObserved;
    }
  }

  /**
   * Command responses observe Stream after their one provider write so the
   * caller reads the counts that include its own change. Only a provisioned
   * live room has a call worth observing.
   */
  async function observeAfterCommand(
    record: VoiceRoomViewerRecord,
    signal: AbortSignal,
  ): Promise<VoiceRoomParticipantsProjection["observed"]> {
    if (
      record.room.provisionState !== "provisioned" ||
      record.room.state !== "live"
    ) {
      return notObserved;
    }
    return observeParticipants(record.room.callId, signal);
  }

  /** Attempt exactly one Stream write and classify its outcome. */
  async function attemptProviderWrite(
    operation: () => Promise<void>,
    signal: AbortSignal,
    reasonCode: string,
  ): Promise<VoiceRoomProviderSync> {
    try {
      await operation();
      signal.throwIfAborted();
      return confirmedSync;
    } catch (error) {
      signal.throwIfAborted();
      void error;
      return unconfirmedSync(reasonCode);
    }
  }

  function commandInputs(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly idempotencyKey: string;
    readonly requestId: string;
  }): { readonly actorUserId: string } {
    return { actorUserId: input.principal.userId };
  }

  function codec(): V2CursorCodec {
    const cursorCodec = options.cursorCodec ?? null;
    if (cursorCodec === null) {
      throw V2ApiError.capabilityUnavailable();
    }
    return cursorCodec;
  }

  /**
   * A cursor carries the page size, so `limit` and `cursor` are mutually
   * exclusive (the community directory rule): passing both would let a caller
   * widen a page bound into a cursor signed for another size.
   */
  function page(
    ownerUserId: string,
    filter: string,
    cursor: unknown,
    limit: unknown,
  ): {
    readonly limit: number;
    readonly continuation: V2CursorContinuation | null;
  } {
    if (cursor === undefined) {
      return {
        limit: parseListLimit(limit, voiceRoomMemberListLimits),
        continuation: null,
      };
    }
    if (limit !== undefined || typeof cursor !== "string") {
      throw V2ApiError.invalidRequest();
    }
    let continuation: V2CursorContinuation;
    try {
      continuation = codec().decode({
        ownerId: ownerUserId,
        route: voiceRoomCursorRoutes.members,
        filter,
        cursor,
      });
    } catch (error) {
      if (error instanceof InvalidV2CursorError) {
        throw V2ApiError.invalidRequest();
      }
      throw error;
    }
    const decodedLimit = continuation["limit"];
    if (
      typeof decodedLimit !== "number" ||
      !Number.isInteger(decodedLimit) ||
      decodedLimit < 1 ||
      decodedLimit > voiceRoomMemberListLimits.maximum
    ) {
      throw V2ApiError.invalidRequest();
    }
    return { limit: decodedLimit, continuation };
  }

  function continuationString(
    continuation: V2CursorContinuation | null,
    key: string,
  ): string | undefined {
    const value = continuation?.[key];
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== "string") {
      throw V2ApiError.invalidRequest();
    }
    return value;
  }

  function memberRow(
    row: VoiceRoomMemberRecord,
    viewer: { readonly userId: string; readonly isHost: boolean },
    roomLive: boolean,
  ): VoiceRoomMemberRowProjection {
    const isSelf = row.ownerUserId === viewer.userId;
    const display: VoiceRoomMemberDisplayProjection =
      row.alias !== null && (isSelf || !row.anonymousMode)
        ? Object.freeze({
            kind: "alias" as const,
            alias: row.alias,
            publicProfileId: row.publicProfileId,
            audience: row.anonymousMode
              ? ("self" as const)
              : ("everyone" as const),
          })
        : Object.freeze({
            kind: "anonymous" as const,
            labelKey: voiceRoomMemberAnonymousKey,
          });
    const addressable = display.kind === "alias" || viewer.isHost;
    return Object.freeze({
      publicProfileId: addressable ? row.publicProfileId : null,
      display,
      role: row.role,
      joinedAt: row.joinedAt,
      handRaised: row.handRaised,
      muted: row.muted,
      isSelf,
      commands: voiceRoomMemberRowCommands({
        viewerIsHost: viewer.isHost,
        roomLive,
        row,
      }),
    });
  }

  return Object.freeze({
    async createRoom(
      input: CreateVoiceRoomCommandInput,
    ): Promise<VoiceRoomResource> {
      const communityId = parseCommunicationOpaqueId(input.communityId);
      const record = await repositoryCall(() =>
        options.repository.createVoiceRoom({
          ...commandInputs(input),
          communityId,
          idempotencyKey: input.idempotencyKey,
          requestSha256: communicationCommandDigest("voiceRoomCreate", [
            communityId,
          ]),
          requestId: input.requestId,
        }),
      );
      if (record.room.provisionState === "provisioned") {
        return resource(record, confirmedSync, notObserved);
      }
      const hostStreamUserId = record.hostStreamUserId;
      let providerSync: VoiceRoomProviderSync;
      let provisionState: VoiceRoomProvisionState;
      try {
        await options.callGateway.createAudioRoom({
          callId: record.room.callId,
          createdByStreamUserId: hostStreamUserId,
          signal: input.signal,
        });
        input.signal.throwIfAborted();
        providerSync = confirmedSync;
        provisionState = "provisioned";
      } catch (error) {
        input.signal.throwIfAborted();
        void error;
        providerSync = unconfirmedSync("STREAM_CALL_CREATE_UNCONFIRMED");
        provisionState = "reconciling";
      }
      const updated = await repositoryCall(() =>
        options.repository.recordVoiceRoomProvisioning({
          voiceRoomId: record.room.voiceRoomId,
          provisionState,
          errorCode:
            provisionState === "provisioned"
              ? null
              : "stream_call_create_unconfirmed",
        }),
      );
      return resource(
        Object.freeze({ ...record, room: updated }),
        providerSync,
        notObserved,
      );
    },

    async getCurrentRoom(
      input: VoiceRoomCommunityReadInput,
    ): Promise<VoiceRoomCurrentResource> {
      const communityId = parseCommunicationOpaqueId(input.communityId);
      const record = await repositoryCall(() =>
        options.repository.getCurrentVoiceRoom({
          communityId,
          viewerUserId: input.principal.userId,
        }),
      );
      if (record === null) {
        return Object.freeze({
          current: null,
          reasonCode: communicationUnavailableReasonCodes.voiceNotLive,
          contractVersion: v2ContractVersion,
        });
      }
      const observed =
        record.room.provisionState === "provisioned"
          ? await observeParticipants(record.room.callId, input.signal)
          : notObserved;
      return Object.freeze({
        current: resource(record, confirmedSync, observed),
        reasonCode: null,
        contractVersion: v2ContractVersion,
      });
    },

    async getRoom(input: VoiceRoomRoomReadInput): Promise<VoiceRoomResource> {
      const voiceRoomId = parseCommunicationOpaqueId(input.voiceRoomId);
      const record = await repositoryCall(() =>
        options.repository.getVoiceRoom({
          voiceRoomId,
          viewerUserId: input.principal.userId,
        }),
      );
      const observed =
        record.room.provisionState === "provisioned"
          ? await observeParticipants(record.room.callId, input.signal)
          : notObserved;
      return resource(record, confirmedSync, observed);
    },

    async join(input: VoiceRoomCommandInput): Promise<VoiceRoomResource> {
      const voiceRoomId = parseCommunicationOpaqueId(input.voiceRoomId);
      const record = await repositoryCall(() =>
        options.repository.joinVoiceRoom({
          ...commandInputs(input),
          voiceRoomId,
          idempotencyKey: input.idempotencyKey,
          requestSha256: communicationCommandDigest("voiceRoomJoin", [
            voiceRoomId,
          ]),
          requestId: input.requestId,
        }),
      );
      const providerSync = await attemptProviderWrite(
        () =>
          options.callGateway.updateCallMembers({
            callId: record.room.callId,
            addStreamUserIds: [
              deriveStreamUserIdForPrincipal(input.principal.userId),
            ],
            removeStreamUserIds: [],
            role: record.viewerRole ?? "listener",
            signal: input.signal,
          }),
        input.signal,
        "STREAM_CALL_MEMBER_UNCONFIRMED",
      );
      return resource(
        record,
        providerSync,
        await observeAfterCommand(record, input.signal),
      );
    },

    async leave(input: VoiceRoomCommandInput): Promise<VoiceRoomResource> {
      const voiceRoomId = parseCommunicationOpaqueId(input.voiceRoomId);
      const record = await repositoryCall(() =>
        options.repository.leaveVoiceRoom({
          ...commandInputs(input),
          voiceRoomId,
          idempotencyKey: input.idempotencyKey,
          requestSha256: communicationCommandDigest("voiceRoomLeave", [
            voiceRoomId,
          ]),
          requestId: input.requestId,
        }),
      );
      const providerSync = await attemptProviderWrite(
        () =>
          options.callGateway.updateCallMembers({
            callId: record.room.callId,
            addStreamUserIds: [],
            removeStreamUserIds: [
              deriveStreamUserIdForPrincipal(input.principal.userId),
            ],
            role: "listener",
            signal: input.signal,
          }),
        input.signal,
        "STREAM_CALL_MEMBER_UNCONFIRMED",
      );
      return resource(
        record,
        providerSync,
        await observeAfterCommand(record, input.signal),
      );
    },

    async raiseHand(input: VoiceRoomCommandInput): Promise<VoiceRoomResource> {
      const voiceRoomId = parseCommunicationOpaqueId(input.voiceRoomId);
      const record = await repositoryCall(() =>
        options.repository.raiseHand({
          ...commandInputs(input),
          voiceRoomId,
          idempotencyKey: input.idempotencyKey,
          requestSha256: communicationCommandDigest("voiceRoomHandRaise", [
            voiceRoomId,
          ]),
          requestId: input.requestId,
        }),
      );
      // Raising a hand is a LOOP queue fact only; it makes no Stream write.
      return resource(
        record,
        confirmedSync,
        await observeAfterCommand(record, input.signal),
      );
    },

    async cancelHandRaise(
      input: VoiceRoomCommandInput,
    ): Promise<VoiceRoomResource> {
      const voiceRoomId = parseCommunicationOpaqueId(input.voiceRoomId);
      const record = await repositoryCall(() =>
        options.repository.cancelHandRaise({
          ...commandInputs(input),
          voiceRoomId,
          idempotencyKey: input.idempotencyKey,
          requestSha256: communicationCommandDigest(
            "voiceRoomHandRaiseCancel",
            [voiceRoomId],
          ),
          requestId: input.requestId,
        }),
      );
      return resource(
        record,
        confirmedSync,
        await observeAfterCommand(record, input.signal),
      );
    },

    async listHandRaises(
      input: VoiceRoomRoomReadInput,
    ): Promise<VoiceRoomHandRaiseQueueResource> {
      const voiceRoomId = parseCommunicationOpaqueId(input.voiceRoomId);
      const items: readonly HandRaiseQueueEntryRecord[] = await repositoryCall(
        () =>
          options.repository.listHandRaises({
            voiceRoomId,
            viewerUserId: input.principal.userId,
            limit: 50,
          }),
      );
      return Object.freeze({
        items: Object.freeze(
          items.map((entry) =>
            Object.freeze({
              handRaiseId: entry.handRaiseId,
              sequence: entry.sequence,
              state: entry.state,
              createdAt: entry.createdAt,
              profile: entry.profile,
            }),
          ),
        ),
        contractVersion: v2ContractVersion,
      });
    },

    async listMembers(
      input: VoiceRoomMemberListInput,
    ): Promise<VoiceRoomMemberListResource> {
      const voiceRoomId = parseCommunicationOpaqueId(input.voiceRoomId);
      if (
        typeof input.role !== "string" ||
        !(voiceRoomMemberRoleFilters as readonly string[]).includes(input.role)
      ) {
        throw V2ApiError.invalidRequest();
      }
      const role = input.role as VoiceRoomMemberRoleFilter;
      const filter = voiceRoomMembersFilter(voiceRoomId, role);
      const request = page(
        input.principal.userId,
        filter,
        input.cursor,
        input.limit,
      );
      const lastJoinedAt = continuationString(request.continuation, "joinedAt");
      const lastPublicProfileId = continuationString(
        request.continuation,
        "publicProfileId",
      );
      const record = await repositoryCall(() =>
        options.repository.listVoiceRoomMembers({
          voiceRoomId,
          viewerUserId: input.principal.userId,
          role,
          limit: request.limit + 1,
          ...(lastJoinedAt === undefined || lastPublicProfileId === undefined
            ? {}
            : { after: { lastJoinedAt, lastPublicProfileId } }),
        }),
      );
      const hasMore = record.items.length > request.limit;
      const items = record.items.slice(0, request.limit);
      const last = items.at(-1);
      const viewer = Object.freeze({
        userId: input.principal.userId,
        isHost: record.room.viewerRole === "host",
      });
      const roomLive = record.room.room.state === "live";
      return Object.freeze({
        role,
        items: Object.freeze(
          items.map((row) => memberRow(row, viewer, roomLive)),
        ),
        nextCursor:
          last === undefined || !hasMore
            ? null
            : codec().encode({
                ownerId: input.principal.userId,
                route: voiceRoomCursorRoutes.members,
                filter,
                continuation: Object.freeze({
                  joinedAt: last.joinedAt,
                  limit: request.limit,
                  publicProfileId: last.publicProfileId,
                }),
              }),
        display: Object.freeze({
          anonymousMemberKey: voiceRoomMemberAnonymousKey,
          ruleKey: voiceRoomMemberDisplayRuleKey,
        }),
        contractVersion: v2ContractVersion,
      });
    },

    async muteSpeaker(
      input: VoiceRoomSpeakerCommandInput,
    ): Promise<VoiceRoomResource> {
      const voiceRoomId = parseCommunicationOpaqueId(input.voiceRoomId);
      const targetPublicProfileId = parseCommunicationPublicProfileId(
        input.targetPublicProfileId,
      );
      const record = await repositoryCall(() =>
        options.repository.muteSpeaker({
          ...commandInputs(input),
          voiceRoomId,
          targetPublicProfileId,
          idempotencyKey: input.idempotencyKey,
          requestSha256: communicationCommandDigest("voiceRoomSpeakerMute", [
            voiceRoomId,
            targetPublicProfileId,
          ]),
          requestId: input.requestId,
        }),
      );
      const providerSync = await attemptProviderWrite(
        () =>
          options.callGateway.muteUser({
            callId: record.room.room.callId,
            mutedByStreamUserId: record.room.hostStreamUserId,
            streamUserId: record.targetStreamUserId,
            signal: input.signal,
          }),
        input.signal,
        "STREAM_CALL_MUTE_UNCONFIRMED",
      );
      return resource(
        record.room,
        providerSync,
        await observeAfterCommand(record.room, input.signal),
      );
    },

    async inviteSpeaker(
      input: VoiceRoomSpeakerCommandInput,
    ): Promise<VoiceRoomResource> {
      const voiceRoomId = parseCommunicationOpaqueId(input.voiceRoomId);
      const targetPublicProfileId = parseCommunicationPublicProfileId(
        input.targetPublicProfileId,
      );
      const record = await repositoryCall(() =>
        options.repository.inviteSpeaker({
          ...commandInputs(input),
          voiceRoomId,
          targetPublicProfileId,
          idempotencyKey: input.idempotencyKey,
          requestSha256: communicationCommandDigest("voiceRoomSpeakerInvite", [
            voiceRoomId,
            targetPublicProfileId,
          ]),
          requestId: input.requestId,
        }),
      );
      const providerSync = await attemptProviderWrite(
        async () => {
          await options.callGateway.updateCallMembers({
            callId: record.room.room.callId,
            addStreamUserIds: [record.targetStreamUserId],
            removeStreamUserIds: [],
            role: "speaker",
            signal: input.signal,
          });
          await options.callGateway.updateUserPermissions({
            callId: record.room.room.callId,
            streamUserId: record.targetStreamUserId,
            grantPermissions: [streamSendAudioPermission],
            revokePermissions: [],
            signal: input.signal,
          });
        },
        input.signal,
        "STREAM_CALL_PERMISSION_UNCONFIRMED",
      );
      return resource(
        record.room,
        providerSync,
        await observeAfterCommand(record.room, input.signal),
      );
    },

    async removeSpeaker(
      input: VoiceRoomSpeakerCommandInput,
    ): Promise<VoiceRoomResource> {
      const voiceRoomId = parseCommunicationOpaqueId(input.voiceRoomId);
      const targetPublicProfileId = parseCommunicationPublicProfileId(
        input.targetPublicProfileId,
      );
      const record = await repositoryCall(() =>
        options.repository.removeSpeaker({
          ...commandInputs(input),
          voiceRoomId,
          targetPublicProfileId,
          idempotencyKey: input.idempotencyKey,
          requestSha256: communicationCommandDigest("voiceRoomSpeakerRemove", [
            voiceRoomId,
            targetPublicProfileId,
          ]),
          requestId: input.requestId,
        }),
      );
      const providerSync = await attemptProviderWrite(
        async () => {
          await options.callGateway.updateUserPermissions({
            callId: record.room.room.callId,
            streamUserId: record.targetStreamUserId,
            grantPermissions: [],
            revokePermissions: [streamSendAudioPermission],
            signal: input.signal,
          });
          await options.callGateway.updateCallMembers({
            callId: record.room.room.callId,
            addStreamUserIds: [record.targetStreamUserId],
            removeStreamUserIds: [],
            role: "listener",
            signal: input.signal,
          });
        },
        input.signal,
        "STREAM_CALL_PERMISSION_UNCONFIRMED",
      );
      return resource(
        record.room,
        providerSync,
        await observeAfterCommand(record.room, input.signal),
      );
    },

    async muteAll(input: VoiceRoomCommandInput): Promise<VoiceRoomResource> {
      const voiceRoomId = parseCommunicationOpaqueId(input.voiceRoomId);
      const record = await repositoryCall(() =>
        options.repository.recordMuteAll({
          ...commandInputs(input),
          voiceRoomId,
          idempotencyKey: input.idempotencyKey,
          requestSha256: communicationCommandDigest("voiceRoomMuteAll", [
            voiceRoomId,
          ]),
          requestId: input.requestId,
        }),
      );
      const providerSync = await attemptProviderWrite(
        () =>
          options.callGateway.muteUsers({
            callId: record.room.callId,
            mutedByStreamUserId: record.hostStreamUserId,
            signal: input.signal,
          }),
        input.signal,
        "STREAM_CALL_MUTE_UNCONFIRMED",
      );
      return resource(
        record,
        providerSync,
        await observeAfterCommand(record, input.signal),
      );
    },

    async endRoom(input: VoiceRoomCommandInput): Promise<VoiceRoomResource> {
      const voiceRoomId = parseCommunicationOpaqueId(input.voiceRoomId);
      const record = await repositoryCall(() =>
        options.repository.endVoiceRoom({
          ...commandInputs(input),
          voiceRoomId,
          idempotencyKey: input.idempotencyKey,
          requestSha256: communicationCommandDigest("voiceRoomEnd", [
            voiceRoomId,
          ]),
          requestId: input.requestId,
        }),
      );
      const providerSync = await attemptProviderWrite(
        () =>
          options.callGateway.endCall({
            callId: record.room.callId,
            signal: input.signal,
          }),
        input.signal,
        "STREAM_CALL_END_UNCONFIRMED",
      );
      return resource(record, providerSync, notObserved);
    },
  });
}

function deriveStreamUserIdForPrincipal(userId: string): string {
  return `loop_${userId.replaceAll("-", "").toLowerCase()}`;
}
