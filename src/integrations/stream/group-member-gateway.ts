import { StreamClient } from "@stream-io/node-sdk";

import type { StreamConfig } from "../../config.js";

const streamChannelType = "messaging";
const streamProviderTimeoutMilliseconds = 3_000;
const maximumStreamMembersPerQuery = 100;
const maximumRawAliasLength = 256;
const maximumAliasCodePoints = 40;
const channelIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const streamUserIdPattern = /^loop_[a-z0-9_-]{8,58}$/;
const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const forbiddenAliasCharacters = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

export interface AssertCurrentStreamGroupMemberInput {
  readonly channelId: string;
  readonly streamUserId: string;
  readonly signal: AbortSignal;
}

export interface FilterCurrentStreamGroupMembersInput {
  readonly channelId: string;
  readonly streamUserIds: readonly string[];
  readonly signal: AbortSignal;
}

export interface ProjectStreamGroupAliasInput {
  readonly channelId: string;
  readonly streamUserId: string;
  readonly groupAliasId: string;
  readonly alias: string;
  readonly signal: AbortSignal;
}

export interface StreamGroupMemberGateway {
  assertCurrentMember(
    input: AssertCurrentStreamGroupMemberInput,
  ): Promise<void>;
  filterCurrentMembers(
    input: FilterCurrentStreamGroupMembersInput,
  ): Promise<ReadonlySet<string>>;
  projectAlias(input: ProjectStreamGroupAliasInput): Promise<void>;
}

export class StreamGroupMemberNotFoundError extends Error {
  constructor() {
    super("The Stream group member does not exist");
    this.name = "StreamGroupMemberNotFoundError";
  }
}

export class StreamGroupMemberGatewayUnavailableError extends Error {
  constructor() {
    super("The Stream group member gateway is unavailable");
    this.name = "StreamGroupMemberGatewayUnavailableError";
  }
}

function unavailable(): never {
  throw new StreamGroupMemberGatewayUnavailableError();
}

function unavailablePromise(): Promise<never> {
  return Promise.reject(new StreamGroupMemberGatewayUnavailableError());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function isChannelId(value: unknown): value is string {
  return typeof value === "string" && channelIdPattern.test(value);
}

function isStreamUserId(value: unknown): value is string {
  return typeof value === "string" && streamUserIdPattern.test(value);
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && canonicalUuidPattern.test(value);
}

function isCanonicalAlias(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= maximumRawAliasLength &&
    value === value.trim() &&
    Array.from(value).length >= 1 &&
    Array.from(value).length <= maximumAliasCodePoints &&
    !forbiddenAliasCharacters.test(value)
  );
}

function parseSignal(value: unknown): AbortSignal {
  if (!(value instanceof AbortSignal)) {
    return unavailable();
  }
  value.throwIfAborted();
  return value;
}

function parseMemberInput(
  value: AssertCurrentStreamGroupMemberInput,
): AssertCurrentStreamGroupMemberInput {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["channelId", "streamUserId", "signal"]) ||
    !isChannelId(value["channelId"]) ||
    !isStreamUserId(value["streamUserId"])
  ) {
    return unavailable();
  }
  return Object.freeze({
    channelId: value["channelId"],
    streamUserId: value["streamUserId"],
    signal: parseSignal(value["signal"]),
  });
}

function parseFilterInput(
  value: FilterCurrentStreamGroupMembersInput,
): FilterCurrentStreamGroupMembersInput {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["channelId", "streamUserIds", "signal"]) ||
    !isChannelId(value["channelId"]) ||
    !Array.isArray(value["streamUserIds"]) ||
    value["streamUserIds"].length > maximumStreamMembersPerQuery ||
    !value["streamUserIds"].every(isStreamUserId)
  ) {
    return unavailable();
  }
  return Object.freeze({
    channelId: value["channelId"],
    streamUserIds: Object.freeze([...value["streamUserIds"]]),
    signal: parseSignal(value["signal"]),
  });
}

function parseProjectionInput(
  value: ProjectStreamGroupAliasInput,
): ProjectStreamGroupAliasInput {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "channelId",
      "streamUserId",
      "groupAliasId",
      "alias",
      "signal",
    ]) ||
    !isChannelId(value["channelId"]) ||
    !isStreamUserId(value["streamUserId"]) ||
    !isCanonicalUuid(value["groupAliasId"]) ||
    !isCanonicalAlias(value["alias"])
  ) {
    return unavailable();
  }
  return Object.freeze({
    channelId: value["channelId"],
    streamUserId: value["streamUserId"],
    groupAliasId: value["groupAliasId"],
    alias: value["alias"],
    signal: parseSignal(value["signal"]),
  });
}

function isProviderNotFound(error: unknown): boolean {
  if (!isRecord(error) || !isRecord(error["metadata"])) {
    return false;
  }
  return error["metadata"]["responseCode"] === 404;
}

function validateGroupChannelState(value: unknown, channelId: string): void {
  if (!isRecord(value) || !isRecord(value["channel"])) {
    return unavailable();
  }
  const channel = value["channel"];
  if (
    channel["id"] !== channelId ||
    channel["type"] !== streamChannelType ||
    channel["cid"] !== `${streamChannelType}:${channelId}` ||
    !isRecord(channel["custom"])
  ) {
    return unavailable();
  }
  const custom = channel["custom"];
  const kind = custom["loop_channel_kind"];
  const schemaVersion = custom["loop_channel_schema_version"];
  if (kind === undefined && schemaVersion === undefined) {
    return;
  }
  if ((kind !== "group" && kind !== "direct") || schemaVersion !== 1) {
    return unavailable();
  }
  if (kind === "direct") {
    throw new StreamGroupMemberNotFoundError();
  }
}

async function assertGroupChannelState(
  client: StreamClient,
  channelId: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const response = await client.chat.channel(streamChannelType, channelId).get({
    state: false,
    members_limit: 0,
    messages_limit: 0,
    watchers_limit: 0,
  });
  signal.throwIfAborted();
  validateGroupChannelState(response, channelId);
}

function sanitizeProviderFailure(error: unknown, signal: AbortSignal): never {
  signal.throwIfAborted();
  if (isProviderNotFound(error)) {
    throw new StreamGroupMemberNotFoundError();
  }
  return unavailable();
}

function readMemberUserId(
  value: unknown,
  channelId: string,
): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const cid = value["cid"];
  if (
    cid !== undefined &&
    (typeof cid !== "string" || cid !== `${streamChannelType}:${channelId}`)
  ) {
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

function readMembers(value: unknown): readonly unknown[] {
  if (!isRecord(value) || !Array.isArray(value["members"])) {
    return unavailable();
  }
  return value["members"];
}

function validateProjectionResponse(
  value: unknown,
  input: ProjectStreamGroupAliasInput,
): void {
  if (!isRecord(value) || !isRecord(value["channel_member"])) {
    return unavailable();
  }
  const member = value["channel_member"];
  if (
    readMemberUserId(member, input.channelId) !== input.streamUserId ||
    !isRecord(member["custom"]) ||
    member["custom"]["loop_group_alias_id"] !== input.groupAliasId ||
    member["custom"]["loop_group_alias"] !== input.alias ||
    member["custom"]["loop_group_alias_version"] !== 1
  ) {
    return unavailable();
  }
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

export function createUnavailableStreamGroupMemberGateway(): StreamGroupMemberGateway {
  return Object.freeze({
    assertCurrentMember: unavailablePromise,
    filterCurrentMembers: unavailablePromise,
    projectAlias: unavailablePromise,
  });
}

export function createStreamGroupMemberGateway(
  config: StreamConfig,
): StreamGroupMemberGateway {
  if (!isValidConfig(config)) {
    return createUnavailableStreamGroupMemberGateway();
  }

  const client = new StreamClient(config.apiKey, config.apiSecret, {
    timeout: streamProviderTimeoutMilliseconds,
  });

  return Object.freeze({
    async assertCurrentMember(
      rawInput: AssertCurrentStreamGroupMemberInput,
    ): Promise<void> {
      const input = parseMemberInput(rawInput);
      try {
        await assertGroupChannelState(client, input.channelId, input.signal);
        input.signal.throwIfAborted();
        const response = await client.chat
          .channel(streamChannelType, input.channelId)
          .queryMembers({
            payload: {
              filter_conditions: {
                user_id: input.streamUserId,
                joined: true,
              },
              limit: 1,
            },
          });
        input.signal.throwIfAborted();
        const members = readMembers(response);
        if (members.length === 0) {
          throw new StreamGroupMemberNotFoundError();
        }
        if (
          members.length !== 1 ||
          readMemberUserId(members[0], input.channelId) !== input.streamUserId
        ) {
          return unavailable();
        }
      } catch (error) {
        if (error instanceof StreamGroupMemberNotFoundError) {
          throw error;
        }
        return sanitizeProviderFailure(error, input.signal);
      }
    },

    async filterCurrentMembers(
      rawInput: FilterCurrentStreamGroupMembersInput,
    ): Promise<ReadonlySet<string>> {
      const input = parseFilterInput(rawInput);
      const requestedIds = [...new Set(input.streamUserIds)];
      if (requestedIds.length === 0) {
        return new Set<string>();
      }
      try {
        await assertGroupChannelState(client, input.channelId, input.signal);
        input.signal.throwIfAborted();
        const response = await client.chat
          .channel(streamChannelType, input.channelId)
          .queryMembers({
            payload: {
              filter_conditions: {
                user_id: { $in: requestedIds },
                joined: true,
              },
              limit: requestedIds.length,
            },
          });
        input.signal.throwIfAborted();
        const members = readMembers(response);
        if (members.length > requestedIds.length) {
          return unavailable();
        }
        const allowed = new Set(requestedIds);
        const current = new Set<string>();
        for (const member of members) {
          const userId = readMemberUserId(member, input.channelId);
          if (
            userId === undefined ||
            !allowed.has(userId) ||
            current.has(userId)
          ) {
            return unavailable();
          }
          current.add(userId);
        }
        return current;
      } catch (error) {
        if (error instanceof StreamGroupMemberNotFoundError) {
          throw error;
        }
        return sanitizeProviderFailure(error, input.signal);
      }
    },

    async projectAlias(rawInput: ProjectStreamGroupAliasInput): Promise<void> {
      const input = parseProjectionInput(rawInput);
      try {
        await assertGroupChannelState(client, input.channelId, input.signal);
        input.signal.throwIfAborted();
        const response = await client.chat
          .channel(streamChannelType, input.channelId)
          .updateMemberPartial({
            user_id: input.streamUserId,
            set: {
              loop_group_alias_id: input.groupAliasId,
              loop_group_alias: input.alias,
              loop_group_alias_version: 1,
            },
          });
        input.signal.throwIfAborted();
        validateProjectionResponse(response, input);
      } catch (error) {
        if (error instanceof StreamGroupMemberNotFoundError) {
          throw error;
        }
        return sanitizeProviderFailure(error, input.signal);
      }
    },
  });
}
