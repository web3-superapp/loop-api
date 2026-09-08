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
} as const);

/**
 * The 0005 pre-condition: Stream Dashboard evidence that the `listener` role
 * of the `audio_room` call type does not carry `create-call`. Until it is
 * exported the mobile locator stays unavailable even though this contract and
 * backend exist.
 */
export const voiceRoomEvidenceReasonCode =
  "AUDIO_ROOM_ROLE_EVIDENCE_PENDING" as const;

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
export type CommunityChatProjection =
  | Readonly<{
      status: "available";
      channelCid: string;
      memberState: "synced";
      reasonCode: null;
    }>
  | Readonly<{
      status: "unavailable";
      channelCid: null;
      memberState: CommunityChannelMemberState | null;
      reasonCode: string;
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
): CommunityChatProjection {
  return Object.freeze({
    status: "unavailable",
    channelCid: null,
    memberState,
    reasonCode,
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
