import { createHash } from "node:crypto";

import { z } from "zod";

import { V2ApiError } from "../../core/http/v2-error.js";
import { v2ContractVersion } from "../meta/product-policy.js";

/**
 * Shared V2 communication contract (Decision 0032): official community
 * channels and community voice rooms. Public fields are camelCase, every
 * identifier is opaque, and every fact that has no backend is reported as an
 * explicit `unavailable` projection rather than as a zero or a fixture.
 */

export const communicationCommandDigestVersion =
  "communication_command_v1" as const;
export const communicationCommandIdempotencyScope =
  "v2_communication_command" as const;

export const communityChannelStates = [
  "created",
  "capacityPending",
  "failed",
] as const;
export type CommunityChannelState = (typeof communityChannelStates)[number];

export const communityChannelMemberStates = [
  "synced",
  "pending",
  "removed",
  "capacityPending",
] as const;
export type CommunityChannelMemberState =
  (typeof communityChannelMemberStates)[number];

export const communityChannelSyncKinds = ["add", "remove"] as const;
export type CommunityChannelSyncKind =
  (typeof communityChannelSyncKinds)[number];

export const communityChannelSyncStates = [
  "pending",
  "reconciling",
  "succeeded",
  "failed",
] as const;
export type CommunityChannelSyncState =
  (typeof communityChannelSyncStates)[number];

export const voiceRoomStates = ["live", "ended"] as const;
export type VoiceRoomState = (typeof voiceRoomStates)[number];

export const voiceRoomProvisionStates = [
  "pending",
  "provisioned",
  "reconciling",
  "failed",
] as const;
export type VoiceRoomProvisionState = (typeof voiceRoomProvisionStates)[number];

export const voiceRoomRoles = ["host", "speaker", "listener"] as const;
export type VoiceRoomRole = (typeof voiceRoomRoles)[number];

export const voiceRoomMemberStates = ["joined", "left", "removed"] as const;
export type VoiceRoomMemberState = (typeof voiceRoomMemberStates)[number];

export const handRaiseStates = ["pending", "invited", "cancelled"] as const;
export type HandRaiseState = (typeof handRaiseStates)[number];

/**
 * Roster views (Decision 0052 §2). The roster lists LOOP `joined` members by
 * role intent; the host is neither a speaker nor a listener and appears in
 * neither view.
 */
export const voiceRoomMemberRoleFilters = ["speaker", "listener"] as const;
export type VoiceRoomMemberRoleFilter =
  (typeof voiceRoomMemberRoleFilters)[number];

/**
 * Row commands the server hands the viewer (the S17 pattern): computed from
 * the viewer's role, the row's stored state, and whether the row is the
 * viewer itself, re-checked by the same predicate on the write. A non-host
 * viewer receives an empty list on every row except its own muted speaker
 * row, which carries `unmute_self` (Decision 0053 §1): the only command a
 * non-host may run. `unmute` is the host's form of the same route.
 */
export const voiceRoomMemberCommands = [
  "invite_speaker",
  "remove_speaker",
  "mute",
  "unmute",
  "unmute_self",
] as const;
export type VoiceRoomMemberCommand = (typeof voiceRoomMemberCommands)[number];

/** The mining leaderboard's display rule reused: anonymous mode alone decides. */
export const voiceRoomMemberAnonymousKey =
  "voiceRoom.member.anonymousMember" as const;
export const voiceRoomMemberDisplayRuleKey =
  "voiceRoom.member.display.anonymousModeOnly" as const;

export const voiceRoomMemberListLimits = Object.freeze({
  default: 50,
  maximum: 100,
});

export const voiceRoomCursorRoutes = Object.freeze({
  members: "voiceRoomMembers",
} as const);

/** Canonical cursor filter: the room and the role view are both bound. */
export function voiceRoomMembersFilter(
  voiceRoomId: string,
  role: VoiceRoomMemberRoleFilter,
): string {
  return `${voiceRoomId}:${role}`;
}

/**
 * Decision 0056: the direct channel inbox read. The list is small (one row
 * per accepted friend that ever opened a DM), so one page carries up to 50
 * rows and the default is the maximum.
 */
export const directChannelListLimits = Object.freeze({
  default: 50,
  maximum: 50,
});

export const directChannelCursorRoutes = Object.freeze({
  list: "v2DirectChannels",
} as const);

/** Canonical cursor filter: only `active` channels are ever listed. */
export function directChannelsFilter(): string {
  return "state=active";
}

export const streamDirectChannelCidPatternSource =
  "^messaging:loop_direct_[0-9a-f]{32}$";
export const streamChannelCidPatternSource =
  "^messaging:loop_community_[0-9a-f]{32}$";
export const streamCallCidPatternSource =
  "^audio_room:loop_voice_[0-9a-f]{32}$";
export const communityChannelIdPatternSource = "^loop_community_[0-9a-f]{32}$";
export const voiceCallIdPatternSource = "^loop_voice_[0-9a-f]{32}$";

/** Default Stream channel member ceiling; overridden per deployment. */
export const defaultCommunityChannelMemberCap = 3_000;
export const maximumCommunityChannelMemberCap = 200_000;

export const communicationUnavailableReasonCodes = Object.freeze({
  channelNotProvisioned: "COMMUNITY_CHANNEL_NOT_PROVISIONED",
  channelSyncing: "COMMUNITY_CHANNEL_MEMBER_SYNCING",
  channelCapacity: "COMMUNITY_CHANNEL_CAPACITY_PENDING",
  channelFailed: "COMMUNITY_CHANNEL_PROVISION_FAILED",
  notMember: "COMMUNITY_MEMBERSHIP_REQUIRED",
  chatRuntime: "COMMUNICATION_RUNTIME_UNAVAILABLE",
  voiceNotLive: "COMMUNITY_VOICE_ROOM_NOT_LIVE",
  voiceNotProvisioned: "COMMUNITY_VOICE_ROOM_NOT_PROVISIONED",
  voiceRuntime: "VOICE_ROOM_RUNTIME_UNAVAILABLE",
  participantCount: "STREAM_PARTICIPANT_COUNT_NOT_OBSERVED",
  /**
   * The Stream call is still in backstage, where only the host may join
   * (Decision 0054). Carried in `detailsSafe.reasonCode` of the
   * CAPABILITY_UNAVAILABLE a `join` answers after its one go-live attempt
   * did not confirm; never a generic runtime outage.
   */
  voiceBackstage: "VOICE_ROOM_BACKSTAGE_NOT_LIVE",
} as const);

/** `providerSync.reasonCode` values a voice-room response can carry. */
export const voiceRoomProviderSyncReasonCodes = Object.freeze({
  create: "STREAM_CALL_CREATE_UNCONFIRMED",
  goLive: "STREAM_CALL_GO_LIVE_UNCONFIRMED",
  member: "STREAM_CALL_MEMBER_UNCONFIRMED",
  permission: "STREAM_CALL_PERMISSION_UNCONFIRMED",
  mute: "STREAM_CALL_MUTE_UNCONFIRMED",
  end: "STREAM_CALL_END_UNCONFIRMED",
  /** The hand-raise custom call event (Decision 0069) was not confirmed. */
  event: "STREAM_CALL_EVENT_UNCONFIRMED",
} as const);

/**
 * The one custom Stream call event LOOP sends (Decision 0069). A hand raise
 * is a LOOP queue fact with no Stream counterpart, so nothing in the call
 * tells the host's device that the queue changed; this event does. It
 * travels on the call every connected device already listens to, is sent
 * by the host's Stream user (the queue's owner), and names the queue entry
 * only: no alias, no profile, no raiser identity, so the roster's anonymous
 * display rule is not undone by an event. Keys are snake_case like the
 * `loop_call_kind` custom on the same call object.
 */
export const voiceRoomCallEventKind = "voiceRoomHandRaise" as const;
export const voiceRoomCallEventSchemaVersion = 1;

/** A type alias, not an interface, so it satisfies the gateway's flat map. */
export type VoiceRoomHandRaiseCallEvent = Readonly<{
  loop_event_kind: typeof voiceRoomCallEventKind;
  loop_event_schema_version: typeof voiceRoomCallEventSchemaVersion;
  voice_room_id: string;
  hand_raise_id: string;
  /** The decimal queue position string, never a JS number. */
  sequence: string;
  state: HandRaiseState;
}>;

export function voiceRoomHandRaiseCallEvent(input: {
  readonly voiceRoomId: string;
  readonly handRaiseId: string;
  readonly sequence: string;
  readonly state: HandRaiseState;
}): VoiceRoomHandRaiseCallEvent {
  return Object.freeze({
    loop_event_kind: voiceRoomCallEventKind,
    loop_event_schema_version: voiceRoomCallEventSchemaVersion,
    voice_room_id: input.voiceRoomId,
    hand_raise_id: input.handRaiseId,
    sequence: input.sequence,
    state: input.state,
  });
}

/**
 * The 0005 pre-condition: Stream Dashboard evidence that the `user` role of
 * the `audio_room` call type does not carry `create-call`. A LOOP listener is
 * given the `user` call role (S4 integration, BUG-03: the application defines
 * no `listener` role), so that is the role the evidence must cover. Until it
 * is exported the mobile locator stays unavailable even though this contract
 * and backend exist.
 */
export const voiceRoomEvidenceReasonCode =
  "AUDIO_ROOM_USER_ROLE_EVIDENCE_PENDING" as const;

export const communityChatCapabilityId = "communityChat" as const;
export const voiceRoomsCapabilityId = "voiceRooms" as const;

/**
 * The official channel ID is a pure function of the community ID, so a lost
 * response can never allocate a second channel for the same community.
 */
export function deriveCommunityChannelId(communityId: string): string {
  const normalized = communityId.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(normalized)) {
    throw new Error("Community ID is not a UUID");
  }
  return `loop_community_${normalized}`;
}

/** The voice-room call ID is a pure function of the opaque room ID. */
export function deriveVoiceCallId(voiceRoomId: string): string {
  const normalized = voiceRoomId.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(normalized)) {
    throw new Error("Voice room ID is not a UUID");
  }
  return `loop_voice_${normalized}`;
}

export function communityChannelCid(streamChannelId: string): string {
  return `messaging:${streamChannelId}`;
}

export function voiceCallCid(callId: string): string {
  return `audio_room:${callId}`;
}

/**
 * Canonical SHA-256 command digest for the communication domain. The
 * operation name, contract version, and every normalized input are bound, so
 * the same `Idempotency-Key` with a different intent is IDEMPOTENCY_CONFLICT.
 */
export function communicationCommandDigest(
  operation: string,
  parts: readonly string[],
): string {
  const hash = createHash("sha256");
  hash.update(`loop:v2:communication:${communicationCommandDigestVersion}`);
  for (const part of [operation, v2ContractVersion, ...parts]) {
    hash.update("\0", "utf8");
    hash.update(part, "utf8");
  }
  return hash.digest("hex");
}

const opaqueIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );

const publicProfileIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );

export function parseCommunicationOpaqueId(value: unknown): string {
  const parsed = opaqueIdSchema.safeParse(value);
  if (!parsed.success) {
    throw V2ApiError.invalidRequest();
  }
  return parsed.data;
}

export function parseCommunicationPublicProfileId(value: unknown): string {
  const parsed = publicProfileIdSchema.safeParse(value);
  if (!parsed.success) {
    throw V2ApiError.invalidRequest();
  }
  return parsed.data;
}

export interface CommunicationUnavailableProjection {
  readonly status: "unavailable";
  readonly reasonCode: string;
}

export function communicationUnavailable(
  reasonCode: string,
): CommunicationUnavailableProjection {
  return Object.freeze({ status: "unavailable", reasonCode });
}

/**
 * `GET /v2/communities/{id}` chat projection. `available` requires a
 * provisioned official channel *and* a `synced` viewer membership: a member
 * whose Stream side is still catching up sees "syncing", never a CID it
 * cannot use.
 */
/**
 * Three states, never two (S4 integration, OBS-1): `syncing` is the honest
 * answer while LOOP has recorded the intent and the Stream side has not caught
 * up yet — the channel row exists but is not provisioned, or the viewer's
 * membership is still `pending`. `unavailable` means nothing is in flight: no
 * runtime, no channel at all, a terminal failure, no membership, or the member
 * cap. Only `available` ever carries a CID.
 */
/**
 * The viewer's own persona in the official channel (Decision 0055): the name
 * every other member sees for them. `projectionState` says whether Stream has
 * echoed it yet; the client never derives a display name from it for others.
 */
export type CommunityChatViewerPersona = Readonly<{
  alias: string;
  projectionState: "pending" | "confirmed";
}>;

export type CommunityChatProjection =
  | Readonly<{
      status: "available";
      channelCid: string;
      memberState: "synced";
      reasonCode: null;
      viewerPersona: CommunityChatViewerPersona | null;
    }>
  | Readonly<{
      status: "syncing";
      channelCid: null;
      memberState: CommunityChannelMemberState | null;
      reasonCode: string;
      viewerPersona: CommunityChatViewerPersona | null;
    }>
  | Readonly<{
      status: "unavailable";
      channelCid: null;
      memberState: CommunityChannelMemberState | null;
      reasonCode: string;
      viewerPersona: CommunityChatViewerPersona | null;
    }>;

export type CommunityVoiceProjection =
  | Readonly<{
      status: "available";
      currentRoomId: string;
      reasonCode: null;
    }>
  | Readonly<{
      status: "unavailable";
      currentRoomId: null;
      reasonCode: string;
    }>;

export function unavailableCommunityChat(
  reasonCode: string,
  memberState: CommunityChannelMemberState | null = null,
  viewerPersona: CommunityChatViewerPersona | null = null,
): CommunityChatProjection {
  return Object.freeze({
    status: "unavailable",
    channelCid: null,
    memberState,
    reasonCode,
    viewerPersona,
  });
}

export function syncingCommunityChat(
  reasonCode: string,
  memberState: CommunityChannelMemberState | null = null,
  viewerPersona: CommunityChatViewerPersona | null = null,
): CommunityChatProjection {
  return Object.freeze({
    status: "syncing",
    channelCid: null,
    memberState,
    reasonCode,
    viewerPersona,
  });
}

export function unavailableCommunityVoice(
  reasonCode: string,
): CommunityVoiceProjection {
  return Object.freeze({
    status: "unavailable",
    currentRoomId: null,
    reasonCode,
  });
}
