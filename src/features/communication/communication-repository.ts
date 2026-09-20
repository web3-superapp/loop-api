import type {
  CommunityChannelMemberState,
  CommunityChannelState,
  CommunityChannelSyncKind,
  HandRaiseState,
  VoiceRoomMemberRoleFilter,
  VoiceRoomProvisionState,
  VoiceRoomRole,
  VoiceRoomState,
} from "./communication-contract.js";

/**
 * PostgreSQL ports for the V2 communication module (Decision 0032). The API
 * process reads channel/voice state and issues durable commands; the
 * standalone worker lane leases outbox rows. Neither port performs a provider
 * call: every Stream write is made by the caller after the transaction has
 * committed.
 */

export interface CommunityChannelRecord {
  readonly communityId: string;
  readonly streamChannelId: string;
  readonly state: CommunityChannelState;
  readonly memberCap: number;
  readonly provisioned: boolean;
}

export interface CommunityChannelViewerRecord {
  readonly channel: CommunityChannelRecord | null;
  readonly viewerMemberState: CommunityChannelMemberState | null;
  readonly viewerIsCommunityMember: boolean;
  /**
   * The viewer's own community persona (Decision 0055), or null before the
   * first `add` sync job generated one.
   */
  readonly viewerPersona: CommunityChannelViewerPersonaRecord | null;
  /** The community's live room, or null when nothing is broadcasting. */
  readonly currentVoiceRoomId: string | null;
  readonly currentVoiceRoomProvisioned: boolean;
}

export type CommunityChannelPersonaProjectionState = "pending" | "confirmed";

export interface CommunityChannelViewerPersonaRecord {
  readonly alias: string;
  readonly projectionState: CommunityChannelPersonaProjectionState;
}

/**
 * Decision 0055 persona: one immutable, community-unique, server-generated
 * name per (community, account). `personaId` is the opaque value projected to
 * Stream as `loop_group_alias_id`.
 */
export interface CommunityChannelPersonaRecord {
  readonly personaId: string;
  readonly communityId: string;
  readonly ownerUserId: string;
  readonly alias: string;
  readonly aliasVersion: 1;
  readonly projectionState: CommunityChannelPersonaProjectionState;
  readonly projectionAttempts: number;
}

/**
 * A persona plus the projection lease the caller must present to record the
 * outcome. Issued by `ensurePersona` (the add path) and by
 * `claimPendingProjections` (the persona lane and the backfill).
 */
export interface CommunityChannelPersonaLease {
  readonly persona: CommunityChannelPersonaRecord;
  readonly leaseToken: string;
}

/** A leased persona together with the Stream coordinates its projection needs. */
export interface CommunityChannelPersonaProjectionTarget extends CommunityChannelPersonaLease {
  readonly streamChannelId: string;
  readonly memberStreamUserId: string;
}

/** One `synced` official-channel member that has no persona row yet. */
export interface CommunityChannelMemberWithoutPersona {
  readonly communityId: string;
  readonly ownerUserId: string;
  readonly streamChannelId: string;
  readonly memberStreamUserId: string;
}

export interface CommunityChannelPersonaRepository {
  /**
   * Returns the existing persona or generates one, and issues a fresh
   * projection lease either way (the row's `next_projection_at` moves 60 s
   * out so the persona lane does not race the caller). `generateAlias` is
   * called once per attempt; a community-local alias collision is retried
   * with a fresh draw, and a concurrent insert for the same pair yields that
   * row.
   */
  ensurePersona(input: {
    readonly communityId: string;
    readonly ownerUserId: string;
    readonly generateAlias: () => string;
  }): Promise<CommunityChannelPersonaLease>;
  findPersona(input: {
    readonly communityId: string;
    readonly ownerUserId: string;
  }): Promise<CommunityChannelPersonaRecord | null>;
  /**
   * Fenced: writes `confirmed` only while the row is `pending` and still
   * carries `leaseToken`. Returns whether the row was written.
   */
  confirmProjection(input: {
    readonly personaId: string;
    readonly leaseToken: string;
  }): Promise<boolean>;
  /**
   * Fenced like `confirmProjection`: keeps the row `pending`, clears the
   * lease, and schedules the next projection attempt. Returns whether the
   * row was written.
   */
  resetProjection(input: {
    readonly personaId: string;
    readonly leaseToken: string;
    readonly retryDelaySeconds: number;
  }): Promise<boolean>;
  /**
   * Unfenced, for the `remove` path: the membership authority knows Stream
   * dropped the member custom, so the persona becomes `pending` (lease
   * cleared) regardless of who holds it. No-op without a persona.
   */
  resetProjectionForMember(input: {
    readonly communityId: string;
    readonly ownerUserId: string;
    readonly retryDelaySeconds: number;
  }): Promise<void>;
  /**
   * Claims due `pending` personas whose LOOP member is `synced` on a
   * provisioned, non-failed channel. Each claim issues a new lease, advances
   * `next_projection_at` by `leaseSeconds`, and increments
   * `projection_attempts`, so the persona lane, a second replica, and the
   * backfill script never project the same persona concurrently.
   */
  claimPendingProjections(input: {
    readonly limit: number;
    readonly leaseSeconds: number;
  }): Promise<readonly CommunityChannelPersonaProjectionTarget[]>;
  /**
   * Keyset page of `synced` members on provisioned channels that have no
   * persona row, ordered by `(community_id, owner_user_id)`.
   */
  listMembersWithoutPersona(input: {
    readonly limit: number;
    readonly after: {
      readonly communityId: string;
      readonly ownerUserId: string;
    } | null;
  }): Promise<readonly CommunityChannelMemberWithoutPersona[]>;
}

export interface VoiceRoomIdentity {
  readonly publicProfileId: string;
  readonly loopId: string;
  readonly alias: string | null;
  readonly avatarRef: string | null;
}

export interface VoiceRoomRecord {
  readonly voiceRoomId: string;
  readonly communityId: string;
  /** `communities.name` at read time; the same value `GET /v2/communities/{id}` publishes (Decision 0052). */
  readonly communityName: string;
  readonly callId: string;
  readonly state: VoiceRoomState;
  readonly provisionState: VoiceRoomProvisionState;
  readonly backstage: boolean;
  readonly createdAt: string;
  readonly endedAt: string | null;
}

export interface VoiceRoomViewerRecord {
  readonly room: VoiceRoomRecord;
  readonly viewerRole: VoiceRoomRole | null;
  readonly viewerHandRaise: HandRaiseProjectionRecord | null;
  readonly hostStreamUserId: string;
  /** LOOP role intent: joined members with role=speaker (never the host). */
  readonly speakerCount: number;
  /** LOOP role intent: joined members with role=listener (never the host). */
  readonly listenerCount: number;
  /** Every joined LOOP member including the host (Decision 0051). */
  readonly joinedCount: number;
}

export interface HandRaiseProjectionRecord {
  readonly handRaiseId: string;
  readonly sequence: string;
  readonly state: HandRaiseState;
  readonly createdAt: string;
}

/**
 * One pending hand raise with the same identity columns as a roster row
 * (Decision 0053 §2), so the service applies the one display rule to both.
 */
export interface HandRaiseQueueEntryRecord extends HandRaiseProjectionRecord {
  readonly ownerUserId: string;
  readonly publicProfileId: string;
  readonly alias: string | null;
  readonly anonymousMode: boolean;
}

export interface HandRaiseQueuePageRecord {
  readonly room: VoiceRoomViewerRecord;
  readonly items: readonly HandRaiseQueueEntryRecord[];
}

export interface VoiceRoomTargetRecord {
  readonly room: VoiceRoomViewerRecord;
  readonly targetStreamUserId: string;
  readonly targetRole: VoiceRoomRole;
  readonly profile: VoiceRoomIdentity;
}

/**
 * One roster row (Decision 0052 §2): a LOOP `joined` member with its role
 * intent. `anonymousMode` is the member's `privacy_preferences_v2` flag so the
 * service can apply the leaderboard display rule; `muted` is the host's
 * LOOP-side mute intent, never Stream media state.
 */
export interface VoiceRoomMemberRecord {
  readonly ownerUserId: string;
  readonly publicProfileId: string;
  readonly alias: string | null;
  readonly anonymousMode: boolean;
  readonly role: VoiceRoomMemberRoleFilter;
  readonly joinedAt: string;
  readonly handRaised: boolean;
  readonly muted: boolean;
}

export interface VoiceRoomMemberPageRecord {
  readonly room: VoiceRoomViewerRecord;
  readonly items: readonly VoiceRoomMemberRecord[];
}

export interface ListVoiceRoomMembersInput {
  readonly voiceRoomId: string;
  readonly viewerUserId: string;
  readonly role: VoiceRoomMemberRoleFilter;
  readonly limit: number;
  readonly after?: {
    readonly lastJoinedAt: string;
    readonly lastPublicProfileId: string;
  };
}

export interface CommunicationCommandInput {
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly requestId: string;
}

export interface VoiceRoomCommandInput extends CommunicationCommandInput {
  readonly voiceRoomId: string;
}

export interface VoiceRoomTargetCommandInput extends VoiceRoomCommandInput {
  readonly targetPublicProfileId: string;
}

export interface CreateVoiceRoomInput extends CommunicationCommandInput {
  readonly communityId: string;
}

export interface ChatGroupLeavePreparation {
  readonly groupId: string;
  readonly streamChannelId: string;
  readonly channelCreatedByStreamUserId: string;
  readonly memberStreamUserId: string;
  /** True when this key already committed; only the provider call replays. */
  readonly alreadyCommitted: boolean;
}

/**
 * Decision 0056: one `active` direct channel the viewer is a member of. `peer`
 * is the other member's public identity (the `GET /v2/connections` shape) or
 * null when that account has no presentable public profile. No Stream user
 * ID is carried.
 */
export interface DirectChannelRecord {
  readonly streamChannelId: string;
  readonly peer: VoiceRoomIdentity | null;
  readonly createdAt: string;
}

export interface ListDirectChannelsInput {
  readonly viewerUserId: string;
  readonly limit: number;
  readonly after?: {
    readonly lastCreatedAt: string;
    readonly lastStreamChannelId: string;
  };
}

export interface CommunicationRepository {
  /**
   * The viewer's `active` direct channels, newest first, keyed by
   * (millisecond created_at, stream_channel_id). `direct_channels` is the
   * authority; Stream is never read (Decision 0056).
   */
  listDirectChannels(
    input: ListDirectChannelsInput,
  ): Promise<readonly DirectChannelRecord[]>;
  readCommunityChannel(input: {
    readonly communityId: string;
    readonly viewerUserId: string;
  }): Promise<CommunityChannelViewerRecord>;
  createVoiceRoom(input: CreateVoiceRoomInput): Promise<VoiceRoomViewerRecord>;
  /**
   * Write back the provider outcome of provisioning (Decision 0032) and the
   * `backstage` flag Stream reported (Decision 0054). `provisioned` means the
   * call exists and went live, so it is always written with `backstage:
   * false`; an unconfirmed create or go-live keeps `reconciling` and the flag
   * as last observed. The self-heal of a room created before 0054 uses the
   * same write once its go-live is confirmed.
   */
  recordVoiceRoomProvisioning(input: {
    readonly voiceRoomId: string;
    readonly provisionState: VoiceRoomProvisionState;
    readonly errorCode: string | null;
    readonly backstage: boolean;
  }): Promise<VoiceRoomRecord>;
  /**
   * The self-heal write-back (Decision 0054 §2.2): flips `backstage` to
   * false only while the room is still `live`, `provisioned`, and in
   * backstage. Zero matched rows means another request already healed it
   * or the room ended meanwhile; that is not an error, and the room as it
   * now stands is returned.
   */
  recordVoiceRoomLive(input: {
    readonly voiceRoomId: string;
  }): Promise<VoiceRoomRecord>;
  getCurrentVoiceRoom(input: {
    readonly communityId: string;
    readonly viewerUserId: string;
  }): Promise<VoiceRoomViewerRecord | null>;
  getVoiceRoom(input: {
    readonly voiceRoomId: string;
    readonly viewerUserId: string;
  }): Promise<VoiceRoomViewerRecord>;
  joinVoiceRoom(input: VoiceRoomCommandInput): Promise<VoiceRoomViewerRecord>;
  leaveVoiceRoom(input: VoiceRoomCommandInput): Promise<VoiceRoomViewerRecord>;
  raiseHand(input: VoiceRoomCommandInput): Promise<VoiceRoomViewerRecord>;
  cancelHandRaise(input: VoiceRoomCommandInput): Promise<VoiceRoomViewerRecord>;
  /** The pending queue in sequence order, with the viewer's room record. */
  listHandRaises(input: {
    readonly voiceRoomId: string;
    readonly viewerUserId: string;
    readonly limit: number;
  }): Promise<HandRaiseQueuePageRecord>;
  /**
   * The roster: LOOP `joined` members of one role view in join order, keyed
   * by (millisecond joined_at, publicProfileId). It reads no Stream state.
   */
  listVoiceRoomMembers(
    input: ListVoiceRoomMembersInput,
  ): Promise<VoiceRoomMemberPageRecord>;
  inviteSpeaker(
    input: VoiceRoomTargetCommandInput,
  ): Promise<VoiceRoomTargetRecord>;
  removeSpeaker(
    input: VoiceRoomTargetCommandInput,
  ): Promise<VoiceRoomTargetRecord>;
  /** Host only; the target must be a joined, not yet muted speaker. */
  muteSpeaker(
    input: VoiceRoomTargetCommandInput,
  ): Promise<VoiceRoomTargetRecord>;
  /**
   * The target itself or the host (Decision 0053 §1); the target must be a
   * joined, muted speaker. Clears the LOOP mute intent only: it makes no
   * Stream write, the device opens its own microphone.
   */
  unmuteSpeaker(
    input: VoiceRoomTargetCommandInput,
  ): Promise<VoiceRoomTargetRecord>;
  recordMuteAll(input: VoiceRoomCommandInput): Promise<VoiceRoomViewerRecord>;
  endVoiceRoom(input: VoiceRoomCommandInput): Promise<VoiceRoomViewerRecord>;
  /**
   * Authorize a small-group leave and return the exact Stream identities the
   * caller must remove. It changes no membership: removal from Stream is
   * idempotent, so the provider call is made first and only a confirmed
   * removal is committed by `commitChatGroupLeave`. It claims the durable
   * idempotency record, so a retry after a lost response finds the original
   * commit and replays only the provider call instead of failing stale.
   */
  prepareChatGroupLeave(input: {
    readonly actorUserId: string;
    readonly groupId: string;
    readonly idempotencyKey: string;
    readonly requestSha256: string;
  }): Promise<ChatGroupLeavePreparation>;
  commitChatGroupLeave(input: {
    readonly actorUserId: string;
    readonly groupId: string;
    readonly idempotencyKey: string;
    readonly requestSha256: string;
    readonly requestId: string;
  }): Promise<void>;
}

export interface CommunityChannelSyncJobRecord {
  readonly communityId: string;
  readonly ownerUserId: string;
  readonly streamChannelId: string;
  readonly channelCreatedByStreamUserId: string;
  readonly memberStreamUserId: string;
  readonly kind: CommunityChannelSyncKind;
  readonly attempts: number;
  readonly channelProvisioned: boolean;
  readonly channelName: string;
  readonly memberCap: number;
  readonly syncedMemberCount: number;
}

/**
 * Worker-side outbox port. `claimDueJobs` takes a fenced lease under
 * `for update skip locked`, so replicas never claim the same row.
 */
export interface CommunityChannelSyncRepository {
  claimDueJobs(input: {
    readonly workerId: string;
    readonly leaseSeconds: number;
    readonly limit: number;
  }): Promise<readonly CommunityChannelSyncJobRecord[]>;
  markChannelProvisioned(input: {
    readonly communityId: string;
    readonly workerId: string;
  }): Promise<void>;
  completeJob(input: {
    readonly communityId: string;
    readonly ownerUserId: string;
    readonly workerId: string;
    readonly memberState: CommunityChannelMemberState;
    readonly channelState: CommunityChannelState;
  }): Promise<void>;
  retryJob(input: {
    readonly communityId: string;
    readonly ownerUserId: string;
    readonly workerId: string;
    readonly errorCode: string;
    readonly retryDelaySeconds: number;
  }): Promise<void>;
  failJob(input: {
    readonly communityId: string;
    readonly ownerUserId: string;
    readonly workerId: string;
    readonly errorCode: string;
  }): Promise<void>;
}

export class CommunicationRepositoryUnavailableError extends Error {
  readonly code = "communication_repository_unavailable";

  constructor() {
    super("The V2 communication repository is unavailable");
    this.name = "CommunicationRepositoryUnavailableError";
  }
}

export class CommunicationNotFoundError extends Error {
  readonly code = "communication_not_found";

  constructor() {
    super("The V2 communication resource was not found");
    this.name = "CommunicationNotFoundError";
  }
}

export class CommunicationPermissionDeniedError extends Error {
  readonly code = "communication_permission_denied";

  constructor() {
    super("The actor may not perform this communication action");
    this.name = "CommunicationPermissionDeniedError";
  }
}

/** The stored state no longer allows the transition (including an ended room). */
export class CommunicationDataStaleError extends Error {
  readonly code = "communication_data_stale";

  constructor() {
    super("The V2 communication state changed before the command was applied");
    this.name = "CommunicationDataStaleError";
  }
}

export class CommunicationIdempotencyConflictError extends Error {
  readonly code = "communication_idempotency_conflict";

  constructor() {
    super("The communication idempotency key conflicts");
    this.name = "CommunicationIdempotencyConflictError";
  }
}

/** The voice room exists but its Stream call is not confirmed yet. */
export class CommunicationUnprovisionedRoomError extends Error {
  readonly code = "communication_room_unprovisioned";

  constructor() {
    super("The voice room has no confirmed Stream call");
    this.name = "CommunicationUnprovisionedRoomError";
  }
}

export class CommunicationProfileRequiredError extends Error {
  readonly code = "communication_profile_required";

  constructor() {
    super("An activated LOOP profile is required for this action");
    this.name = "CommunicationProfileRequiredError";
  }
}

export class CommunicationResourceConflictError extends Error {
  readonly code = "communication_resource_conflict";

  constructor() {
    super("A live voice room already exists for this community");
    this.name = "CommunicationResourceConflictError";
  }
}

export function createUnavailableCommunicationRepository(): CommunicationRepository {
  const unavailable = (): Promise<never> =>
    Promise.reject(new CommunicationRepositoryUnavailableError());
  return Object.freeze({
    listDirectChannels: unavailable,
    readCommunityChannel: unavailable,
    createVoiceRoom: unavailable,
    recordVoiceRoomProvisioning: unavailable,
    recordVoiceRoomLive: unavailable,
    getCurrentVoiceRoom: unavailable,
    getVoiceRoom: unavailable,
    joinVoiceRoom: unavailable,
    leaveVoiceRoom: unavailable,
    raiseHand: unavailable,
    cancelHandRaise: unavailable,
    listHandRaises: unavailable,
    listVoiceRoomMembers: unavailable,
    inviteSpeaker: unavailable,
    removeSpeaker: unavailable,
    muteSpeaker: unavailable,
    unmuteSpeaker: unavailable,
    recordMuteAll: unavailable,
    endVoiceRoom: unavailable,
    prepareChatGroupLeave: unavailable,
    commitChatGroupLeave: unavailable,
  });
}

export function createUnavailableCommunityChannelPersonaRepository(): CommunityChannelPersonaRepository {
  const unavailable = (): Promise<never> =>
    Promise.reject(new CommunicationRepositoryUnavailableError());
  return Object.freeze({
    ensurePersona: unavailable,
    findPersona: unavailable,
    confirmProjection: unavailable,
    resetProjection: unavailable,
    resetProjectionForMember: unavailable,
    claimPendingProjections: unavailable,
    listMembersWithoutPersona: unavailable,
  });
}
