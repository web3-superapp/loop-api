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

/** Stream permission that lets a call member publish audio. */
export const streamSendAudioPermission = "send-audio" as const;

export type StreamCallMemberRole = "host" | "speaker" | "listener";

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
      try {
        signal.throwIfAborted();
        await client.upsertUsers([{ id: createdByStreamUserId }]);
        signal.throwIfAborted();
        const response = await client.video
          .call(streamCallType, callId)
          .create({
            data: {
              created_by_id: createdByStreamUserId,
              members: [{ user_id: createdByStreamUserId, role: "host" }],
              custom: {
                loop_call_kind: "communityVoiceRoom",
                loop_call_schema_version: streamCallSchemaVersion,
              },
              settings_override: { backstage: { enabled: true } },
            },
          });
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
      try {
        signal.throwIfAborted();
        await client.video.call(streamCallType, callId).updateCallMembers({
          update_members: addStreamUserIds.map((userId) => ({
            user_id: userId,
            role,
          })),
          remove_members: removeStreamUserIds,
        });
        signal.throwIfAborted();
      } catch (error) {
        return sanitizeProviderFailure(error, signal);
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
        signal.throwIfAborted();
        const response = await client.video
          .call(streamCallType, callId)
          .queryMembers({ limit: maximumQueriedMembers });
        signal.throwIfAborted();
        if (!isRecord(response) || !Array.isArray(response["members"])) {
          return projectionMismatch();
        }
        return Object.freeze({
          memberCount: response["members"].length,
          observedAt: new Date().toISOString(),
        });
      } catch (error) {
        if (error instanceof StreamCallProjectionMismatchError) {
          throw error;
        }
        return sanitizeProviderFailure(error, signal);
      }
    },
  });
}
