import { StreamClient } from "@stream-io/node-sdk";

import type { StreamConfig } from "../../config.js";

const streamChannelType = "messaging";
const streamChannelSchemaVersion = 1;
const streamProviderTimeoutMilliseconds = 3_000;
const minimumGroupMembers = 3;
const maximumGroupMembers = 30;
const directMembers = 2;
const maximumGroupNameCodePoints = 60;
const maximumRawGroupNameLength = 256;
const streamUserIdPattern = /^loop_[a-z0-9_-]{8,58}$/;
const channelIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const forbiddenGroupNameCharacters = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

export type StreamMessagingChannelKind = "group" | "direct";

interface FixedStreamMessagingChannelInputBase {
  readonly channelId: string;
  readonly createdByStreamUserId: string;
  readonly memberStreamUserIds: readonly string[];
  readonly signal: AbortSignal;
}

export interface UpsertFixedStreamGroupInput extends FixedStreamMessagingChannelInputBase {
  readonly kind: "group";
  readonly name: string;
}

export interface UpsertFixedStreamDirectInput extends FixedStreamMessagingChannelInputBase {
  readonly kind: "direct";
}

export type UpsertFixedStreamMessagingChannelInput =
  UpsertFixedStreamGroupInput | UpsertFixedStreamDirectInput;

export type ReadFixedStreamMessagingChannelInput =
  UpsertFixedStreamMessagingChannelInput;

interface StreamMessagingChannelProjectionBase {
  readonly channelId: string;
  readonly streamCid: string;
  readonly memberStreamUserIds: readonly string[];
}

export interface StreamGroupChannelProjection extends StreamMessagingChannelProjectionBase {
  readonly kind: "group";
  readonly name: string;
}

export interface StreamDirectChannelProjection extends StreamMessagingChannelProjectionBase {
  readonly kind: "direct";
}

export type StreamMessagingChannelProjection =
  StreamGroupChannelProjection | StreamDirectChannelProjection;

export type ReadFixedStreamMessagingChannelResult =
  | Readonly<{
      status: "found";
      channel: StreamMessagingChannelProjection;
    }>
  | Readonly<{
      status: "not_found";
    }>;

export interface StreamChannelGateway {
  upsertFixedMessagingChannel(
    input: UpsertFixedStreamMessagingChannelInput,
  ): Promise<StreamMessagingChannelProjection>;
  readFixedMessagingChannel(
    input: ReadFixedStreamMessagingChannelInput,
  ): Promise<ReadFixedStreamMessagingChannelResult>;
}

export class StreamChannelGatewayUnavailableError extends Error {
  constructor() {
    super("The Stream channel gateway is unavailable");
    this.name = "StreamChannelGatewayUnavailableError";
  }
}

export class StreamChannelProjectionMismatchError extends Error {
  constructor() {
    super("The fixed Stream channel projection does not match LOOP intent");
    this.name = "StreamChannelProjectionMismatchError";
  }
}

function unavailable(): never {
  throw new StreamChannelGatewayUnavailableError();
}

function projectionMismatch(): never {
  throw new StreamChannelProjectionMismatchError();
}

function unavailablePromise(): Promise<never> {
  return Promise.reject(new StreamChannelGatewayUnavailableError());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isStreamUserId(value: unknown): value is string {
  return typeof value === "string" && streamUserIdPattern.test(value);
}

function isChannelIdForKind(
  value: unknown,
  kind: StreamMessagingChannelKind,
): value is string {
  if (typeof value !== "string" || !channelIdPattern.test(value)) {
    return false;
  }
  const prefix = kind === "group" ? "loop_group_" : "loop_direct_";
  return value.startsWith(prefix) && value.length >= prefix.length + 8;
}

function isCanonicalGroupName(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > maximumRawGroupNameLength ||
    value !== value.trim() ||
    forbiddenGroupNameCharacters.test(value)
  ) {
    return false;
  }
  const length = Array.from(value).length;
  return length >= 1 && length <= maximumGroupNameCodePoints;
}

function parseSignal(value: unknown): AbortSignal {
  if (!(value instanceof AbortSignal)) {
    return unavailable();
  }
  value.throwIfAborted();
  return value;
}

function parseInput(value: unknown): UpsertFixedStreamMessagingChannelInput {
  if (
    !isRecord(value) ||
    (value["kind"] !== "group" && value["kind"] !== "direct")
  ) {
    return unavailable();
  }
  if (
    !hasOnlyKeys(value, [
      "channelId",
      "kind",
      "createdByStreamUserId",
      "memberStreamUserIds",
      "name",
      "signal",
    ]) ||
    !hasExactKeys(
      value,
      value["kind"] === "group"
        ? [
            "channelId",
            "kind",
            "createdByStreamUserId",
            "memberStreamUserIds",
            "name",
            "signal",
          ]
        : [
            "channelId",
            "kind",
            "createdByStreamUserId",
            "memberStreamUserIds",
            "signal",
          ],
    ) ||
    !isChannelIdForKind(value["channelId"], value["kind"]) ||
    !isStreamUserId(value["createdByStreamUserId"]) ||
    !Array.isArray(value["memberStreamUserIds"]) ||
    !value["memberStreamUserIds"].every(isStreamUserId)
  ) {
    return unavailable();
  }

  const memberStreamUserIds = [...value["memberStreamUserIds"]];
  const uniqueMemberStreamUserIds = new Set(memberStreamUserIds);
  const expectedMemberCount =
    value["kind"] === "group" ? undefined : directMembers;
  if (
    uniqueMemberStreamUserIds.size !== memberStreamUserIds.length ||
    !uniqueMemberStreamUserIds.has(value["createdByStreamUserId"]) ||
    (value["kind"] === "group" &&
      (memberStreamUserIds.length < minimumGroupMembers ||
        memberStreamUserIds.length > maximumGroupMembers)) ||
    (expectedMemberCount !== undefined &&
      memberStreamUserIds.length !== expectedMemberCount)
  ) {
    return unavailable();
  }

  const signal = parseSignal(value["signal"]);
  if (value["kind"] === "group") {
    if (!isCanonicalGroupName(value["name"])) {
      return unavailable();
    }
    return Object.freeze({
      channelId: value["channelId"],
      kind: "group",
      createdByStreamUserId: value["createdByStreamUserId"],
      memberStreamUserIds: Object.freeze(memberStreamUserIds),
      name: value["name"],
      signal,
    });
  }

  return Object.freeze({
    channelId: value["channelId"],
    kind: "direct",
    createdByStreamUserId: value["createdByStreamUserId"],
    memberStreamUserIds: Object.freeze(memberStreamUserIds),
    signal,
  });
}

function isProviderNotFound(error: unknown): boolean {
  return (
    isRecord(error) &&
    isRecord(error["metadata"]) &&
    error["metadata"]["responseCode"] === 404
  );
}

function sanitizeProviderFailure(error: unknown, signal: AbortSignal): never {
  signal.throwIfAborted();
  void error;
  return unavailable();
}

function readProviderUserId(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const directUserId = value["user_id"];
  const nestedUserId = isRecord(value["user"])
    ? value["user"]["id"]
    : undefined;
  if (
    directUserId !== undefined &&
    (!isStreamUserId(directUserId) ||
      (nestedUserId !== undefined && nestedUserId !== directUserId))
  ) {
    return undefined;
  }
  if (nestedUserId !== undefined && !isStreamUserId(nestedUserId)) {
    return undefined;
  }
  return isStreamUserId(directUserId)
    ? directUserId
    : isStreamUserId(nestedUserId)
      ? nestedUserId
      : undefined;
}

function validateUpsertedUsers(
  value: unknown,
  expectedUserIds: readonly string[],
): void {
  if (!isRecord(value) || !isRecord(value["users"])) {
    return unavailable();
  }
  const expected = new Set(expectedUserIds);
  const actual = Object.keys(value["users"]);
  if (
    actual.length !== expected.size ||
    !actual.every((id) => expected.has(id))
  ) {
    return unavailable();
  }
  for (const id of actual) {
    const user = value["users"][id];
    if (!isRecord(user) || user["id"] !== id) {
      return unavailable();
    }
  }
}

function expectedCustom(
  input: UpsertFixedStreamMessagingChannelInput,
): Readonly<Record<string, string | number>> {
  return input.kind === "group"
    ? Object.freeze({
        loop_channel_kind: "group",
        loop_channel_schema_version: streamChannelSchemaVersion,
        name: input.name,
      })
    : Object.freeze({
        loop_channel_kind: "direct",
        loop_channel_schema_version: streamChannelSchemaVersion,
      });
}

function validateExactMembers(
  value: unknown,
  expectedUserIds: readonly string[],
): void {
  if (!Array.isArray(value) || value.length !== expectedUserIds.length) {
    return projectionMismatch();
  }
  const expected = new Set(expectedUserIds);
  const seen = new Set<string>();
  for (const member of value) {
    const userId = readProviderUserId(member);
    if (userId === undefined || !expected.has(userId) || seen.has(userId)) {
      return projectionMismatch();
    }
    seen.add(userId);
  }
}

function validateChannelResponse(
  value: unknown,
  input: UpsertFixedStreamMessagingChannelInput,
): StreamMessagingChannelProjection {
  if (!isRecord(value) || !isRecord(value["channel"])) {
    return projectionMismatch();
  }
  const channel = value["channel"];
  const streamCid = `${streamChannelType}:${input.channelId}`;
  if (
    channel["id"] !== input.channelId ||
    channel["type"] !== streamChannelType ||
    channel["cid"] !== streamCid ||
    !isRecord(channel["created_by"]) ||
    channel["created_by"]["id"] !== input.createdByStreamUserId ||
    !isRecord(channel["custom"]) ||
    !hasExactKeys(channel["custom"], Object.keys(expectedCustom(input)))
  ) {
    return projectionMismatch();
  }
  const custom = channel["custom"];
  for (const [key, expectedValue] of Object.entries(expectedCustom(input))) {
    if (custom[key] !== expectedValue) {
      return projectionMismatch();
    }
  }
  if (
    !Number.isSafeInteger(channel["member_count"]) ||
    channel["member_count"] !== input.memberStreamUserIds.length
  ) {
    return projectionMismatch();
  }
  validateExactMembers(value["members"], input.memberStreamUserIds);

  const base = {
    channelId: input.channelId,
    streamCid,
    memberStreamUserIds: Object.freeze([...input.memberStreamUserIds]),
  };
  return input.kind === "group"
    ? Object.freeze({ ...base, kind: "group", name: input.name })
    : Object.freeze({ ...base, kind: "direct" });
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

export function createUnavailableStreamChannelGateway(): StreamChannelGateway {
  return Object.freeze({
    upsertFixedMessagingChannel: unavailablePromise,
    readFixedMessagingChannel: unavailablePromise,
  });
}

export function createStreamChannelGateway(
  config: StreamConfig,
): StreamChannelGateway {
  if (!isValidConfig(config)) {
    return createUnavailableStreamChannelGateway();
  }
  const client = new StreamClient(config.apiKey, config.apiSecret, {
    timeout: streamProviderTimeoutMilliseconds,
  });

  return Object.freeze({
    async upsertFixedMessagingChannel(
      rawInput: UpsertFixedStreamMessagingChannelInput,
    ): Promise<StreamMessagingChannelProjection> {
      const input = parseInput(rawInput);
      try {
        input.signal.throwIfAborted();
        const usersResponse = await client.upsertUsers(
          input.memberStreamUserIds.map((id) => ({ id })),
        );
        input.signal.throwIfAborted();
        validateUpsertedUsers(usersResponse, input.memberStreamUserIds);

        input.signal.throwIfAborted();
        const response = await client.chat
          .channel(streamChannelType, input.channelId)
          .getOrCreate({
            state: true,
            data: {
              created_by_id: input.createdByStreamUserId,
              members: input.memberStreamUserIds.map((userId) => ({
                user_id: userId,
              })),
              custom: expectedCustom(input),
            },
            members: { limit: input.memberStreamUserIds.length + 1 },
            messages: { limit: 0 },
            watchers: { limit: 0 },
          });
        input.signal.throwIfAborted();
        return validateChannelResponse(response, input);
      } catch (error) {
        if (error instanceof StreamChannelProjectionMismatchError) {
          throw error;
        }
        return sanitizeProviderFailure(error, input.signal);
      }
    },

    async readFixedMessagingChannel(
      rawInput: ReadFixedStreamMessagingChannelInput,
    ): Promise<ReadFixedStreamMessagingChannelResult> {
      const input = parseInput(rawInput);
      try {
        input.signal.throwIfAborted();
        const response = await client.chat
          .channel(streamChannelType, input.channelId)
          .get({
            state: true,
            members_limit: input.memberStreamUserIds.length + 1,
            messages_limit: 0,
            watchers_limit: 0,
          });
        input.signal.throwIfAborted();
        return Object.freeze({
          status: "found" as const,
          channel: validateChannelResponse(response, input),
        });
      } catch (error) {
        input.signal.throwIfAborted();
        if (error instanceof StreamChannelProjectionMismatchError) {
          throw error;
        }
        if (isProviderNotFound(error)) {
          return Object.freeze({ status: "not_found" as const });
        }
        return sanitizeProviderFailure(error, input.signal);
      }
    },
  });
}
