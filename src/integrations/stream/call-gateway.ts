import { StreamClient } from "@stream-io/node-sdk";

import type { StreamConfig } from "../../config.js";

/**
 * Stream Video `audio_room` boundary (Decision 0032). Every method performs at
 * most one provider call, times out with the shared 3s budget, sanitizes the
 * provider failure, and fails closed. Participants, media state, and live
 * permissions remain Stream facts; LOOP owns only the room lifecycle, the host
 * identity, and the hand-raise queue.
 */
const streamCallType = "audio_room";
const streamCallSchemaVersion = 1;
const streamProviderTimeoutMilliseconds = 3_000;
const streamUserIdPattern = /^loop_[0-9a-f]{32}$/;
const callIdPattern = /^loop_voice_[0-9a-f]{32}$/;
const maximumCallMemberBatch = 100;
const maximumQueriedMembers = 100;
const maximumQueriedMemberPages = 10;

/** Stream permission that lets a call member publish audio. */
export const streamSendAudioPermission = "send-audio" as const;

/**
 * Permissions a host needs when it has to be carried by the plain `user` call
 * role: publish audio, mute the room, and end the call. Every value is a
 * member of the SDK's `OwnCapability` union (`send-audio`, `mute-users`,
 * `end-call`).
 */
export const streamHostFallbackPermissions: readonly string[] = Object.freeze([
  streamSendAudioPermission,
  "mute-users",
  "end-call",
]);

export type StreamCallMemberRole = "host" | "speaker" | "listener";

/**
 * LOOP call roles are not Stream call roles (S4 integration, BUG-03). The
 * Stream application has no `listener` role — `UpdateCallMembers` answers
 * `role "listener" is invalid` — so a LOOP listener is carried by the built-in
 * `user` role, which is also the role whose permission set the Decision 0005
 * evidence must show does not contain `create-call`. A speaker keeps the
 * `speaker` role the application does define, and a host prefers `admin`.
 */
const streamRoleByLoopRole: Readonly<Record<StreamCallMemberRole, string>> =
  Object.freeze({
    host: "admin",
    speaker: "speaker",
    listener: "user",
  });

/** The role a host falls back to when the application defines no `admin`. */
const streamHostFallbackRole = "user";

/**
 * Status codes that mean "this exact request will keep being rejected": every
 * 4xx except the quota window, the request timeout, and the replay hint. The
 * host role fallback is attempted only for those, so a provider fault or a
 * quota answer is never mistaken for a missing role.
 */
const retryableClientStatusCodes: readonly number[] = Object.freeze([
  408, 425, 429,
]);

function isDeterministicProviderRejection(error: unknown): boolean {
  if (!isRecord(error) || !isRecord(error["metadata"])) {
    return false;
  }
  const responseCode = error["metadata"]["responseCode"];
  return (
    typeof responseCode === "number" &&
    responseCode >= 400 &&
    responseCode < 500 &&
    !retryableClientStatusCodes.includes(responseCode)
  );
}

export interface StreamCallProjection {
  readonly callId: string;
  readonly callCid: string;
  readonly backstage: boolean;
}

export interface CreateStreamAudioRoomInput {
  readonly callId: string;
  readonly createdByStreamUserId: string;
  readonly signal: AbortSignal;
}

export interface StreamCallMembersInput {
  readonly callId: string;
  readonly addStreamUserIds: readonly string[];
  readonly removeStreamUserIds: readonly string[];
  readonly role: StreamCallMemberRole;
  readonly signal: AbortSignal;
}

export interface StreamCallPermissionsInput {
  readonly callId: string;
  readonly streamUserId: string;
  readonly grantPermissions: readonly string[];
  readonly revokePermissions: readonly string[];
  readonly signal: AbortSignal;
}

export interface StreamCallMuteAllInput {
  readonly callId: string;
  readonly mutedByStreamUserId: string;
  readonly signal: AbortSignal;
}

export interface StreamCallEndInput {
  readonly callId: string;
  readonly signal: AbortSignal;
}

export interface StreamCallMemberObservation {
  readonly memberCount: number;
  readonly observedAt: string;
  /**
   * False when Stream still had more member pages after the bounded page
   * budget. The count is then a floor, not a fact, so callers must report it
   * as unavailable rather than publish a truncated number.
   */
  readonly complete: boolean;
}

/**
 * The live call session as Stream reports it (Decision 0051). A call member
 * is an account Stream lets into the call; a session participant is a device
 * connected to it right now. The two are different facts and carry different
 * field names on purpose.
 */
export interface StreamCallSessionObservation {
  /** Devices connected to the current session; 0 when no session is live. */
  readonly participantCount: number;
  /** Whether Stream reported a session that has started and not ended. */
  readonly sessionActive: boolean;
  readonly observedAt: string;
}

export interface StreamCallGateway {
  createAudioRoom(
    input: CreateStreamAudioRoomInput,
  ): Promise<StreamCallProjection>;
  updateCallMembers(input: StreamCallMembersInput): Promise<void>;
  updateUserPermissions(input: StreamCallPermissionsInput): Promise<void>;
  muteUsers(input: StreamCallMuteAllInput): Promise<void>;
  endCall(input: StreamCallEndInput): Promise<void>;
  queryMembers(input: StreamCallEndInput): Promise<StreamCallMemberObservation>;
  observeSession(
    input: StreamCallEndInput,
  ): Promise<StreamCallSessionObservation>;
}

export class StreamCallGatewayUnavailableError extends Error {
  readonly code = "stream_call_gateway_unavailable";

  constructor() {
    super("The Stream call gateway is unavailable");
    this.name = "StreamCallGatewayUnavailableError";
  }
}

export class StreamCallProjectionMismatchError extends Error {
  readonly code = "stream_call_projection_mismatch";

  constructor() {
    super("The Stream call projection does not match LOOP intent");
    this.name = "StreamCallProjectionMismatchError";
  }
}

function unavailable(): never {
  throw new StreamCallGatewayUnavailableError();
}

function projectionMismatch(): never {
  throw new StreamCallProjectionMismatchError();
}

function unavailablePromise(): Promise<never> {
  return Promise.reject(new StreamCallGatewayUnavailableError());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return (
    actual.length === sorted.length &&
    actual.every((key, index) => key === sorted[index])
  );
}

function isStreamUserId(value: unknown): value is string {
  return typeof value === "string" && streamUserIdPattern.test(value);
}

function isCallId(value: unknown): value is string {
  return typeof value === "string" && callIdPattern.test(value);
}

function isStreamUserIdList(
  value: unknown,
  maximum: number,
): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximum &&
    value.every(isStreamUserId) &&
    new Set(value).size === value.length
  );
}

function isCallMemberRole(value: unknown): value is StreamCallMemberRole {
  return value === "host" || value === "speaker" || value === "listener";
}

function isPermissionList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= 16 &&
    value.every(
      (entry) =>
        typeof entry === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(entry),
    ) &&
    new Set(value).size === value.length
  );
}

function parseSignal(value: unknown): AbortSignal {
  if (!(value instanceof AbortSignal)) {
    return unavailable();
  }
  value.throwIfAborted();
  return value;
}

function sanitizeProviderFailure(error: unknown, signal: AbortSignal): never {
  signal.throwIfAborted();
  void error;
  return unavailable();
}

function validateCallResponse(
  value: unknown,
  callId: string,
): StreamCallProjection {
  if (!isRecord(value) || !isRecord(value["call"])) {
    return projectionMismatch();
  }
  const call = value["call"];
  const callCid = `${streamCallType}:${callId}`;
  if (
    call["id"] !== callId ||
    call["type"] !== streamCallType ||
    call["cid"] !== callCid ||
    typeof call["backstage"] !== "boolean" ||
    !isRecord(call["custom"]) ||
    call["custom"]["loop_call_kind"] !== "communityVoiceRoom" ||
    call["custom"]["loop_call_schema_version"] !== streamCallSchemaVersion
  ) {
    return projectionMismatch();
  }
  return Object.freeze({
    callId,
    callCid,
    backstage: call["backstage"],
  });
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Project `GetCallResponse.call.session` into a participant count. No
 * session, or a session with `ended_at`, means nobody is connected. A session
 * reports `participants_count_by_role`; the `participants` list is the
 * fallback when the per-role map is absent. Anything else is a mismatch.
 */
function projectSessionObservation(
  value: unknown,
  callId: string,
): StreamCallSessionObservation {
  if (!isRecord(value) || !isRecord(value["call"])) {
    return projectionMismatch();
  }
  const call = value["call"];
  if (call["id"] !== callId || call["type"] !== streamCallType) {
    return projectionMismatch();
  }
  const observedAt = new Date().toISOString();
  const session = call["session"];
  if (session === undefined || session === null) {
    return Object.freeze({
      participantCount: 0,
      sessionActive: false,
      observedAt,
    });
  }
  if (!isRecord(session)) {
    return projectionMismatch();
  }
  if (session["ended_at"] !== undefined && session["ended_at"] !== null) {
    return Object.freeze({
      participantCount: 0,
      sessionActive: false,
      observedAt,
    });
  }
  const byRole = session["participants_count_by_role"];
  if (isRecord(byRole)) {
    let participantCount = 0;
    for (const count of Object.values(byRole)) {
      if (!isNonNegativeInteger(count)) {
        return projectionMismatch();
      }
      participantCount += count;
    }
    return Object.freeze({
      participantCount,
      sessionActive: true,
      observedAt,
    });
  }
  const participants = session["participants"];
  if (!Array.isArray(participants)) {
    return projectionMismatch();
  }
  return Object.freeze({
    participantCount: participants.length,
    sessionActive: true,
    observedAt,
  });
}

function isValidConfig(value: StreamConfig): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["apiKey", "apiSecret"]) &&
    typeof value["apiKey"] === "string" &&
    value["apiKey"].length >= 1 &&
    value["apiKey"].length <= 255 &&
    value["apiKey"] === value["apiKey"].trim() &&
    typeof value["apiSecret"] === "string" &&
    value["apiSecret"].length >= 1 &&
    value["apiSecret"].length <= 4_096
  );
}

export function createUnavailableStreamCallGateway(): StreamCallGateway {
  return Object.freeze({
    createAudioRoom: unavailablePromise,
    updateCallMembers: unavailablePromise,
    updateUserPermissions: unavailablePromise,
    muteUsers: unavailablePromise,
    endCall: unavailablePromise,
    queryMembers: unavailablePromise,
    observeSession: unavailablePromise,
  });
}

export function createStreamCallGateway(
  config: StreamConfig,
): StreamCallGateway {
  if (!isValidConfig(config)) {
    return createUnavailableStreamCallGateway();
  }
  const client = new StreamClient(config.apiKey, config.apiSecret, {
    timeout: streamProviderTimeoutMilliseconds,
  });

  return Object.freeze({
    async createAudioRoom(
      rawInput: CreateStreamAudioRoomInput,
    ): Promise<StreamCallProjection> {
      if (
        !isRecord(rawInput) ||
        !hasExactKeys(rawInput, [
          "callId",
          "createdByStreamUserId",
          "signal",
        ]) ||
        !isCallId(rawInput["callId"]) ||
        !isStreamUserId(rawInput["createdByStreamUserId"])
      ) {
        return unavailable();
      }
      const callId = rawInput["callId"];
      const createdByStreamUserId = rawInput["createdByStreamUserId"];
      const signal = parseSignal(rawInput["signal"]);
      const create = async (streamRole: string): Promise<unknown> =>
        client.video.call(streamCallType, callId).create({
          data: {
            created_by_id: createdByStreamUserId,
            members: [{ user_id: createdByStreamUserId, role: streamRole }],
            custom: {
              loop_call_kind: "communityVoiceRoom",
              loop_call_schema_version: streamCallSchemaVersion,
            },
            settings_override: { backstage: { enabled: true } },
          },
        });
      try {
        signal.throwIfAborted();
        await client.upsertUsers([{ id: createdByStreamUserId }]);
        signal.throwIfAborted();
        let response: unknown;
        try {
          response = await create(streamRoleByLoopRole.host);
        } catch (error) {
          if (!isDeterministicProviderRejection(error)) {
            throw error;
          }
          // The same host fallback as `updateCallMembers`: an application
          // without an `admin` call role gets a `user` host with the explicit
          // permissions its controls need.
          signal.throwIfAborted();
          response = await create(streamHostFallbackRole);
          signal.throwIfAborted();
          await client.video
            .call(streamCallType, callId)
            .updateUserPermissions({
              user_id: createdByStreamUserId,
              grant_permissions: [...streamHostFallbackPermissions],
              revoke_permissions: [],
            });
        }
        signal.throwIfAborted();
        return validateCallResponse(response, callId);
      } catch (error) {
        if (error instanceof StreamCallProjectionMismatchError) {
          throw error;
        }
        return sanitizeProviderFailure(error, signal);
      }
    },

    async updateCallMembers(rawInput: StreamCallMembersInput): Promise<void> {
      if (
        !isRecord(rawInput) ||
        !hasExactKeys(rawInput, [
          "callId",
          "addStreamUserIds",
          "removeStreamUserIds",
          "role",
          "signal",
        ]) ||
        !isCallId(rawInput["callId"]) ||
        !isStreamUserIdList(
          rawInput["addStreamUserIds"],
          maximumCallMemberBatch,
        ) ||
        !isStreamUserIdList(
          rawInput["removeStreamUserIds"],
          maximumCallMemberBatch,
        ) ||
        !isCallMemberRole(rawInput["role"]) ||
        (rawInput["addStreamUserIds"].length === 0 &&
          rawInput["removeStreamUserIds"].length === 0)
      ) {
        return unavailable();
      }
      const callId = rawInput["callId"];
      const role = rawInput["role"];
      const addStreamUserIds = [...rawInput["addStreamUserIds"]];
      const removeStreamUserIds = [...rawInput["removeStreamUserIds"]];
      const signal = parseSignal(rawInput["signal"]);
      const submit = async (streamRole: string): Promise<void> => {
        await client.video.call(streamCallType, callId).updateCallMembers({
          update_members: addStreamUserIds.map((userId) => ({
            user_id: userId,
            role: streamRole,
          })),
          remove_members: removeStreamUserIds,
        });
      };
      try {
        signal.throwIfAborted();
        await submit(streamRoleByLoopRole[role]);
        signal.throwIfAborted();
      } catch (error) {
        signal.throwIfAborted();
        // A host is preferably an `admin`. An application that defines no
        // `admin` call role rejects that deterministically, and the host is
        // then carried by the plain `user` role plus the explicit permissions
        // its controls need. No other role has a fallback: a rejection there
        // stays a failure.
        if (role !== "host" || !isDeterministicProviderRejection(error)) {
          return sanitizeProviderFailure(error, signal);
        }
        try {
          await submit(streamHostFallbackRole);
          signal.throwIfAborted();
          for (const userId of addStreamUserIds) {
            await client.video
              .call(streamCallType, callId)
              .updateUserPermissions({
                user_id: userId,
                grant_permissions: [...streamHostFallbackPermissions],
                revoke_permissions: [],
              });
            signal.throwIfAborted();
          }
        } catch (fallbackError) {
          return sanitizeProviderFailure(fallbackError, signal);
        }
      }
    },

    async updateUserPermissions(
      rawInput: StreamCallPermissionsInput,
    ): Promise<void> {
      if (
        !isRecord(rawInput) ||
        !hasExactKeys(rawInput, [
          "callId",
          "streamUserId",
          "grantPermissions",
          "revokePermissions",
          "signal",
        ]) ||
        !isCallId(rawInput["callId"]) ||
        !isStreamUserId(rawInput["streamUserId"]) ||
        !isPermissionList(rawInput["grantPermissions"]) ||
        !isPermissionList(rawInput["revokePermissions"]) ||
        (rawInput["grantPermissions"].length === 0 &&
          rawInput["revokePermissions"].length === 0)
      ) {
        return unavailable();
      }
      const callId = rawInput["callId"];
      const streamUserId = rawInput["streamUserId"];
      const grantPermissions = [...rawInput["grantPermissions"]];
      const revokePermissions = [...rawInput["revokePermissions"]];
      const signal = parseSignal(rawInput["signal"]);
      try {
        signal.throwIfAborted();
        await client.video.call(streamCallType, callId).updateUserPermissions({
          user_id: streamUserId,
          grant_permissions: grantPermissions,
          revoke_permissions: revokePermissions,
        });
        signal.throwIfAborted();
      } catch (error) {
        return sanitizeProviderFailure(error, signal);
      }
    },

    async muteUsers(rawInput: StreamCallMuteAllInput): Promise<void> {
      if (
        !isRecord(rawInput) ||
        !hasExactKeys(rawInput, ["callId", "mutedByStreamUserId", "signal"]) ||
        !isCallId(rawInput["callId"]) ||
        !isStreamUserId(rawInput["mutedByStreamUserId"])
      ) {
        return unavailable();
      }
      const callId = rawInput["callId"];
      const mutedByStreamUserId = rawInput["mutedByStreamUserId"];
      const signal = parseSignal(rawInput["signal"]);
      try {
        signal.throwIfAborted();
        await client.video.call(streamCallType, callId).muteUsers({
          audio: true,
          mute_all_users: true,
          muted_by_id: mutedByStreamUserId,
        });
        signal.throwIfAborted();
      } catch (error) {
        return sanitizeProviderFailure(error, signal);
      }
    },

    async endCall(rawInput: StreamCallEndInput): Promise<void> {
      if (
        !isRecord(rawInput) ||
        !hasExactKeys(rawInput, ["callId", "signal"]) ||
        !isCallId(rawInput["callId"])
      ) {
        return unavailable();
      }
      const callId = rawInput["callId"];
      const signal = parseSignal(rawInput["signal"]);
      try {
        signal.throwIfAborted();
        await client.video.call(streamCallType, callId).end();
        signal.throwIfAborted();
      } catch (error) {
        return sanitizeProviderFailure(error, signal);
      }
    },

    async queryMembers(
      rawInput: StreamCallEndInput,
    ): Promise<StreamCallMemberObservation> {
      if (
        !isRecord(rawInput) ||
        !hasExactKeys(rawInput, ["callId", "signal"]) ||
        !isCallId(rawInput["callId"])
      ) {
        return unavailable();
      }
      const callId = rawInput["callId"];
      const signal = parseSignal(rawInput["signal"]);
      try {
        // Stream pages call members. The count is accumulated across a bounded
        // number of pages; beyond that the observation is reported incomplete
        // instead of publishing a truncated number as if it were the total.
        let memberCount = 0;
        let cursor: string | undefined;
        let complete = false;
        for (let page = 0; page < maximumQueriedMemberPages; page += 1) {
          signal.throwIfAborted();
          const response = await client.video
            .call(streamCallType, callId)
            .queryMembers({
              limit: maximumQueriedMembers,
              ...(cursor === undefined ? {} : { next: cursor }),
            });
          signal.throwIfAborted();
          if (!isRecord(response) || !Array.isArray(response["members"])) {
            return projectionMismatch();
          }
          memberCount += response["members"].length;
          const next = response["next"];
          if (typeof next !== "string" || next.length === 0) {
            complete = true;
            break;
          }
          cursor = next;
        }
        return Object.freeze({
          memberCount,
          observedAt: new Date().toISOString(),
          complete,
        });
      } catch (error) {
        if (error instanceof StreamCallProjectionMismatchError) {
          throw error;
        }
        return sanitizeProviderFailure(error, signal);
      }
    },

    async observeSession(
      rawInput: StreamCallEndInput,
    ): Promise<StreamCallSessionObservation> {
      if (
        !isRecord(rawInput) ||
        !hasExactKeys(rawInput, ["callId", "signal"]) ||
        !isCallId(rawInput["callId"])
      ) {
        return unavailable();
      }
      const callId = rawInput["callId"];
      const signal = parseSignal(rawInput["signal"]);
      try {
        signal.throwIfAborted();
        // One `GetCall` read. The session block is the only live-presence fact
        // Stream exposes server-side; members are authorization, not presence.
        const response = await client.video.call(streamCallType, callId).get();
        signal.throwIfAborted();
        return projectSessionObservation(response, callId);
      } catch (error) {
        if (error instanceof StreamCallProjectionMismatchError) {
          throw error;
        }
        return sanitizeProviderFailure(error, signal);
      }
    },
  });
}
