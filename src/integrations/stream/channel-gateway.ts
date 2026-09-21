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

/**
 * A deterministic provider rejection: Stream answered with a client error that
 * the identical request will keep producing (a malformed member, an unknown
 * channel, a revoked permission). It is terminal, so the caller must not spend
 * its retry budget on it.
 */
export class StreamChannelRequestRejectedError extends Error {
  readonly code = "stream_channel_request_rejected";

  constructor() {
    super("Stream rejected the channel request deterministically");
    this.name = "StreamChannelRequestRejectedError";
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

/**
 * Official community channel (Decision 0032). It is the same `messaging`
 * channel type with `loop_channel_kind = "community"`, but unlike `group` and
 * `direct` it is never validated against an exact member set: membership is
 * synchronized incrementally through `addMembers`/`removeMembers`, and a
 * member that is already in (or already out of) the channel is a success.
 * The `group` and `direct` contracts above are unchanged.
 */
const communityChannelIdPattern = /^loop_community_[0-9a-f]{32}$/;
/**
 * Membership mutation also covers the small `group` channels created by
 * Decision 0025, because `DELETE /v2/chat/groups/{groupId}/membership`
 * removes exactly one member from one of them.
 */
const membershipChannelIdPattern = /^loop_(community|group)_[0-9a-f]{32}$/;

export interface UpsertStreamCommunityChannelInput {
  readonly channelId: string;
  readonly createdByStreamUserId: string;
  readonly name: string;
  readonly signal: AbortSignal;
}

/**
 * Decision 0055 persona carried on `add_members` as server-reserved member
 * custom data. The three keys are exactly the Decision 0024 group-alias
 * shape so one client renderer serves both channel kinds.
 */
export interface StreamCommunityMemberPersona {
  readonly streamUserId: string;
  readonly personaId: string;
  readonly alias: string;
}

export interface StreamCommunityChannelMemberInput {
  readonly channelId: string;
  readonly actingStreamUserId: string;
  readonly memberStreamUserIds: readonly string[];
  /**
   * Personas to attach on add. Every entry must name one of
   * `memberStreamUserIds`; ignored on remove.
   */
  readonly memberPersonas?: readonly StreamCommunityMemberPersona[];
  readonly signal: AbortSignal;
}

export interface StreamCommunityChannelProjection {
  readonly channelId: string;
  readonly streamCid: string;
  /** Stream's own member count when it publishes one; otherwise null. */
  readonly memberCount: number | null;
}

export interface StreamCommunityChannelMemberProjection extends StreamCommunityChannelProjection {
  /**
   * Members whose echoed `custom` carried exactly the requested persona.
   * Anything else (no echo, different values) is simply absent here: the
   * caller keeps the persona `pending` and re-projects it later.
   */
  readonly confirmedPersonaStreamUserIds: readonly string[];
}

export interface ProjectStreamCommunityMemberPersonaInput {
  readonly channelId: string;
  readonly streamUserId: string;
  readonly personaId: string;
  readonly alias: string;
  readonly signal: AbortSignal;
}

export interface ReadStreamCommunityChannelPresenceInput {
  readonly channelId: string;
  readonly signal: AbortSignal;
}

/**
 * Community presence as Stream lets a server read it (Decision 0047).
 * `watcher_count` is never published to a server-side (API secret) read,
 * even while a client is watching the channel, so the only presence fact a
 * server can observe is each channel member's `user.online` flag returned
 * by the member query. `observed` counts the members that flag is `true`
 * for; `bound_exceeded` means the channel has more members than the paging
 * budget covers, and no partial count is ever published as a total.
 */
export type StreamCommunityChannelPresenceResult =
  | Readonly<{
      status: "observed";
      channelId: string;
      /** Channel members whose Stream user currently holds a connection. */
      onlineMemberCount: number;
      /** Members the count covers: every member of the channel. */
      memberCount: number;
    }>
  | Readonly<{
      status: "bound_exceeded";
      channelId: string;
      memberBound: number;
    }>;

export interface ReadStreamCommunityChannelActivityInput {
  /** Community channel IDs to observe in one query; at most the batch size. */
  readonly channelIds: readonly string[];
  /** Start of the window; messages at or after it are counted. */
  readonly since: Date;
  readonly signal: AbortSignal;
}

/**
 * One channel's activity as a server may observe it (Decision 0061).
 *
 * Stream publishes no "messages in the last seven days" number, so the
 * window is counted from the newest messages `queryChannels` returns for
 * the channel. `bounded` is true when that page came back full and its
 * oldest message is still inside the window: more messages exist than were
 * counted, so `messageCount` is a floor and is published as one.
 * `totalMessageCount` is Stream's own lifetime count when it publishes one,
 * kept for operators and never used for ordering.
 */
export interface StreamCommunityChannelActivity {
  readonly channelId: string;
  readonly messageCount: number;
  readonly bounded: boolean;
  readonly totalMessageCount: number | null;
  readonly lastMessageAt: string | null;
}

export interface StreamCommunityChannelGateway {
  upsertCommunityChannel(
    input: UpsertStreamCommunityChannelInput,
  ): Promise<StreamCommunityChannelProjection>;
  addMembers(
    input: StreamCommunityChannelMemberInput,
  ): Promise<StreamCommunityChannelMemberProjection>;
  removeMembers(
    input: StreamCommunityChannelMemberInput,
  ): Promise<StreamCommunityChannelProjection>;
  /**
   * Writes the Decision 0055 persona onto an existing channel member with
   * `updateMemberPartial` and resolves only when Stream echoes the exact
   * three fields. A member Stream does not know is a deterministic
   * rejection; a different echo is `unavailable`.
   */
  projectMemberPersona(
    input: ProjectStreamCommunityMemberPersonaInput,
  ): Promise<void>;
  readCommunityChannelPresence(
    input: ReadStreamCommunityChannelPresenceInput,
  ): Promise<StreamCommunityChannelPresenceResult>;
  /**
   * Observes the recent message activity of several community channels in
   * one `queryChannels` call (Decision 0061). A channel Stream does not
   * return is simply absent from the result: nothing is assumed about a
   * channel that was not observed.
   */
  readCommunityChannelActivity(
    input: ReadStreamCommunityChannelActivityInput,
  ): Promise<readonly StreamCommunityChannelActivity[]>;
}

const maximumCommunityChannelMemberBatch = 100;
/** Stream's member query page size; the presence read never asks for more. */
export const communityPresencePageSize = 100;
/**
 * Pages the presence read is allowed to spend on one community. Beyond
 * `communityPresencePageSize * communityPresenceMaximumPages` members the
 * read reports `bound_exceeded` instead of a count it did not finish.
 */
export const communityPresenceMaximumPages = 5;
export const communityPresenceMemberBound =
  communityPresencePageSize * communityPresenceMaximumPages;

/**
 * Status codes Stream returns for a client error that is worth retrying: a
 * quota window (429), a request timeout (408), and the "too early" replay
 * hint (425). Every other 4xx is deterministic.
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

/**
 * Community-channel failure classification. An aborted request stays an abort,
 * a deterministic 4xx becomes terminal, and everything else (5xx, timeout,
 * transport failure, quota) stays "unavailable" so the outbox retries it.
 */
function sanitizeCommunityProviderFailure(
  error: unknown,
  signal: AbortSignal,
): never {
  signal.throwIfAborted();
  if (isDeterministicProviderRejection(error)) {
    throw new StreamChannelRequestRejectedError();
  }
  return unavailable();
}

function isCommunityChannelId(value: unknown): value is string {
  return typeof value === "string" && communityChannelIdPattern.test(value);
}

function isMembershipChannelId(value: unknown): value is string {
  return typeof value === "string" && membershipChannelIdPattern.test(value);
}

function parseUpsertCommunityInput(
  value: unknown,
): UpsertStreamCommunityChannelInput {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "channelId",
      "createdByStreamUserId",
      "name",
      "signal",
    ]) ||
    !isCommunityChannelId(value["channelId"]) ||
    !isStreamUserId(value["createdByStreamUserId"]) ||
    !isCanonicalGroupName(value["name"])
  ) {
    return unavailable();
  }
  return Object.freeze({
    channelId: value["channelId"],
    createdByStreamUserId: value["createdByStreamUserId"],
    name: value["name"],
    signal: parseSignal(value["signal"]),
  });
}

const personaAliasPattern = /^[A-Z][a-z]{2,15}-[0-9]{4}$/;
const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const personaCustomKeys = Object.freeze({
  id: "loop_group_alias_id",
  alias: "loop_group_alias",
  version: "loop_group_alias_version",
});
const personaCustomVersion = 1;

function isPersonaAlias(value: unknown): value is string {
  return typeof value === "string" && personaAliasPattern.test(value);
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && canonicalUuidPattern.test(value);
}

function parseMemberPersona(value: unknown): StreamCommunityMemberPersona {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["streamUserId", "personaId", "alias"]) ||
    !isStreamUserId(value["streamUserId"]) ||
    !isCanonicalUuid(value["personaId"]) ||
    !isPersonaAlias(value["alias"])
  ) {
    return unavailable();
  }
  return Object.freeze({
    streamUserId: value["streamUserId"],
    personaId: value["personaId"],
    alias: value["alias"],
  });
}

function personaCustom(
  persona: StreamCommunityMemberPersona,
): Record<string, unknown> {
  return {
    [personaCustomKeys.id]: persona.personaId,
    [personaCustomKeys.alias]: persona.alias,
    [personaCustomKeys.version]: personaCustomVersion,
  };
}

function customMatchesPersona(
  custom: unknown,
  persona: StreamCommunityMemberPersona,
): boolean {
  return (
    isRecord(custom) &&
    custom[personaCustomKeys.id] === persona.personaId &&
    custom[personaCustomKeys.alias] === persona.alias &&
    custom[personaCustomKeys.version] === personaCustomVersion
  );
}

function readEchoedMemberUserId(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const direct = value["user_id"];
  if (isStreamUserId(direct)) {
    return direct;
  }
  const nested = isRecord(value["user"]) ? value["user"]["id"] : undefined;
  return isStreamUserId(nested) ? nested : undefined;
}

/**
 * Which requested personas the `add_members` response proves. Stream echoes
 * the affected members in `members[]`; a member entry whose `custom` carries
 * exactly the requested three fields is confirmed. Everything else is left
 * unconfirmed rather than guessed.
 */
function confirmedPersonas(
  response: unknown,
  personas: readonly StreamCommunityMemberPersona[],
): readonly string[] {
  if (personas.length === 0 || !isRecord(response)) {
    return Object.freeze([]);
  }
  const members = response["members"];
  if (!Array.isArray(members)) {
    return Object.freeze([]);
  }
  const echoed = new Map<string, unknown>();
  for (const member of members as unknown[]) {
    const userId = readEchoedMemberUserId(member);
    if (userId !== undefined && isRecord(member)) {
      echoed.set(userId, member["custom"]);
    }
  }
  return Object.freeze(
    personas
      .filter((persona) =>
        customMatchesPersona(echoed.get(persona.streamUserId), persona),
      )
      .map((persona) => persona.streamUserId),
  );
}

function parseCommunityMemberInput(
  value: unknown,
): StreamCommunityChannelMemberInput {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "channelId",
      "actingStreamUserId",
      "memberStreamUserIds",
      "memberPersonas",
      "signal",
    ]) ||
    !isMembershipChannelId(value["channelId"]) ||
    !isStreamUserId(value["actingStreamUserId"]) ||
    !Array.isArray(value["memberStreamUserIds"]) ||
    value["memberStreamUserIds"].length < 1 ||
    value["memberStreamUserIds"].length > maximumCommunityChannelMemberBatch ||
    !value["memberStreamUserIds"].every(isStreamUserId) ||
    new Set(value["memberStreamUserIds"]).size !==
      value["memberStreamUserIds"].length
  ) {
    return unavailable();
  }
  const memberStreamUserIds = Object.freeze([...value["memberStreamUserIds"]]);
  const rawPersonas = value["memberPersonas"];
  if (rawPersonas === undefined) {
    return Object.freeze({
      channelId: value["channelId"],
      actingStreamUserId: value["actingStreamUserId"],
      memberStreamUserIds,
      signal: parseSignal(value["signal"]),
    });
  }
  if (!Array.isArray(rawPersonas)) {
    return unavailable();
  }
  const memberPersonas = Object.freeze(
    (rawPersonas as unknown[]).map(parseMemberPersona),
  );
  const allowed = new Set(memberStreamUserIds);
  const seen = new Set<string>();
  for (const persona of memberPersonas) {
    if (!allowed.has(persona.streamUserId) || seen.has(persona.streamUserId)) {
      return unavailable();
    }
    seen.add(persona.streamUserId);
  }
  return Object.freeze({
    channelId: value["channelId"],
    actingStreamUserId: value["actingStreamUserId"],
    memberStreamUserIds,
    memberPersonas,
    signal: parseSignal(value["signal"]),
  });
}

function parseProjectPersonaInput(
  value: unknown,
): ProjectStreamCommunityMemberPersonaInput {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "channelId",
      "streamUserId",
      "personaId",
      "alias",
      "signal",
    ]) ||
    !isCommunityChannelId(value["channelId"]) ||
    !isStreamUserId(value["streamUserId"]) ||
    !isCanonicalUuid(value["personaId"]) ||
    !isPersonaAlias(value["alias"])
  ) {
    return unavailable();
  }
  return Object.freeze({
    channelId: value["channelId"],
    streamUserId: value["streamUserId"],
    personaId: value["personaId"],
    alias: value["alias"],
    signal: parseSignal(value["signal"]),
  });
}

/**
 * `updateMemberPartial` must echo the member with the exact persona fields.
 * A differing echo is not a confirmation, so it stays `unavailable` and the
 * persona stays pending.
 */
function validatePersonaProjectionResponse(
  value: unknown,
  input: ProjectStreamCommunityMemberPersonaInput,
): void {
  if (!isRecord(value) || !isRecord(value["channel_member"])) {
    return unavailable();
  }
  const member = value["channel_member"];
  const persona: StreamCommunityMemberPersona = {
    streamUserId: input.streamUserId,
    personaId: input.personaId,
    alias: input.alias,
  };
  if (
    readEchoedMemberUserId(member) !== input.streamUserId ||
    !customMatchesPersona(member["custom"], persona)
  ) {
    return unavailable();
  }
}

/**
 * A community channel projection is accepted only when the authoritative
 * response proves the exact channel ID, type, CID, and LOOP channel kind. The
 * member set is deliberately not compared: a `community` channel can hold
 * thousands of members and one page of a Stream response is not evidence
 * about the whole set.
 */
function validateMembershipChannelResponse(
  value: unknown,
  channelId: string,
): StreamCommunityChannelProjection {
  if (!isRecord(value) || !isRecord(value["channel"])) {
    return projectionMismatch();
  }
  const channel = value["channel"];
  const streamCid = `${streamChannelType}:${channelId}`;
  const kind = channelId.startsWith("loop_community_") ? "community" : "group";
  if (
    channel["id"] !== channelId ||
    channel["type"] !== streamChannelType ||
    channel["cid"] !== streamCid ||
    !isRecord(channel["custom"]) ||
    channel["custom"]["loop_channel_kind"] !== kind ||
    channel["custom"]["loop_channel_schema_version"] !==
      streamChannelSchemaVersion
  ) {
    return projectionMismatch();
  }
  const memberCount = channel["member_count"];
  return Object.freeze({
    channelId,
    streamCid,
    memberCount:
      Number.isSafeInteger(memberCount) && (memberCount as number) >= 0
        ? (memberCount as number)
        : null,
  });
}

function validateCommunityChannelResponse(
  value: unknown,
  channelId: string,
): StreamCommunityChannelProjection {
  if (!isRecord(value) || !isRecord(value["channel"])) {
    return projectionMismatch();
  }
  const channel = value["channel"];
  const streamCid = `${streamChannelType}:${channelId}`;
  if (
    channel["id"] !== channelId ||
    channel["type"] !== streamChannelType ||
    channel["cid"] !== streamCid ||
    !isRecord(channel["custom"]) ||
    channel["custom"]["loop_channel_kind"] !== "community" ||
    channel["custom"]["loop_channel_schema_version"] !==
      streamChannelSchemaVersion
  ) {
    return projectionMismatch();
  }
  const memberCount = channel["member_count"];
  return Object.freeze({
    channelId,
    streamCid,
    memberCount:
      Number.isSafeInteger(memberCount) && (memberCount as number) >= 0
        ? (memberCount as number)
        : null,
  });
}

function parsePresenceInput(
  value: unknown,
): ReadStreamCommunityChannelPresenceInput {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["channelId", "signal"]) ||
    !isCommunityChannelId(value["channelId"]) ||
    !(value["signal"] instanceof AbortSignal)
  ) {
    return unavailable();
  }
  return Object.freeze({
    channelId: value["channelId"],
    signal: value["signal"],
  });
}

/**
 * One page of the member query, reduced to the two numbers the presence
 * read needs. A member without a user object, or a user whose `online` is
 * not a boolean, is a projection mismatch: the count must not silently
 * treat "unknown" as "offline".
 */
function reduceMemberPage(value: unknown): {
  readonly pageSize: number;
  readonly online: number;
} {
  if (!isRecord(value) || !Array.isArray(value["members"])) {
    return projectionMismatch();
  }
  let online = 0;
  for (const member of value["members"] as unknown[]) {
    if (
      !isRecord(member) ||
      !isRecord(member["user"]) ||
      typeof member["user"]["online"] !== "boolean"
    ) {
      return projectionMismatch();
    }
    if (member["user"]["online"]) {
      online += 1;
    }
  }
  return { pageSize: (value["members"] as unknown[]).length, online };
}

/**
 * Channels one activity sweep reads in a single `queryChannels` call, and
 * the messages it asks for per channel. The message page is the whole
 * evidence for the window count: when it comes back full and still starts
 * inside the window, the count is published as a floor (`bounded`).
 */
export const communityActivityChannelBatch = 25;
export const communityActivityMessagePage = 100;

function parseActivityInput(
  value: unknown,
): ReadStreamCommunityChannelActivityInput {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["channelIds", "since", "signal"]) ||
    !Array.isArray(value["channelIds"]) ||
    value["channelIds"].length === 0 ||
    value["channelIds"].length > communityActivityChannelBatch ||
    !(value["channelIds"] as unknown[]).every(isCommunityChannelId) ||
    !(value["since"] instanceof Date) ||
    Number.isNaN(value["since"].getTime()) ||
    !(value["signal"] instanceof AbortSignal)
  ) {
    return unavailable();
  }
  return Object.freeze({
    channelIds: Object.freeze([...(value["channelIds"] as string[])]),
    since: value["since"],
    signal: value["signal"],
  });
}

function readDateValue(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  return null;
}

/**
 * One channel of the `queryChannels` answer, reduced to the activity
 * observation. A channel whose `messages` is not an array, or whose channel
 * object carries no usable `id`, is a projection mismatch: the lane records
 * nothing rather than a count it cannot justify. A message without a
 * readable `created_at` is not counted — it is evidence of nothing.
 */
function reduceActivityChannel(
  value: unknown,
  since: Date,
  requested: readonly string[],
): StreamCommunityChannelActivity | null {
  if (!isRecord(value) || !Array.isArray(value["messages"])) {
    return projectionMismatch();
  }
  const channel = value["channel"];
  if (!isRecord(channel) || typeof channel["id"] !== "string") {
    return projectionMismatch();
  }
  const channelId = channel["id"];
  if (!requested.includes(channelId)) {
    return null;
  }
  const messages = value["messages"] as unknown[];
  let messageCount = 0;
  let oldest: number | null = null;
  for (const message of messages) {
    const createdAt = isRecord(message)
      ? readDateValue(message["created_at"])
      : null;
    if (createdAt === null) {
      continue;
    }
    const time = Date.parse(createdAt);
    oldest = oldest === null || time < oldest ? time : oldest;
    if (time >= since.getTime()) {
      messageCount += 1;
    }
  }
  const totalMessageCount =
    typeof channel["message_count"] === "number" &&
    Number.isInteger(channel["message_count"]) &&
    channel["message_count"] >= 0
      ? channel["message_count"]
      : null;
  return Object.freeze({
    channelId,
    messageCount,
    // A full page whose oldest message is still inside the window means the
    // window is not covered: the count is a floor.
    bounded:
      messages.length >= communityActivityMessagePage &&
      oldest !== null &&
      oldest >= since.getTime(),
    totalMessageCount,
    lastMessageAt: readDateValue(channel["last_message_at"]),
  });
}

export function createUnavailableStreamCommunityChannelGateway(): StreamCommunityChannelGateway {
  return Object.freeze({
    upsertCommunityChannel: unavailablePromise,
    addMembers: unavailablePromise,
    removeMembers: unavailablePromise,
    projectMemberPersona: unavailablePromise,
    readCommunityChannelPresence: unavailablePromise,
    readCommunityChannelActivity: unavailablePromise,
  });
}

export function createStreamCommunityChannelGateway(
  config: StreamConfig,
): StreamCommunityChannelGateway {
  if (!isValidConfig(config)) {
    return createUnavailableStreamCommunityChannelGateway();
  }
  const client = new StreamClient(config.apiKey, config.apiSecret, {
    timeout: streamProviderTimeoutMilliseconds,
  });

  async function mutateMembers(
    rawInput: StreamCommunityChannelMemberInput,
    direction: "add" | "remove",
  ): Promise<StreamCommunityChannelMemberProjection> {
    const input = parseCommunityMemberInput(rawInput);
    const personas = new Map(
      (direction === "add" ? (input.memberPersonas ?? []) : []).map(
        (persona) => [persona.streamUserId, persona] as const,
      ),
    );
    try {
      input.signal.throwIfAborted();
      if (direction === "add") {
        // Stream rejects `add_members` for a user object it has never seen
        // ("users ... don't exist"), which is exactly the account that joins a
        // community before it ever connects to Stream. The joiner is upserted
        // with the same `{id}`-only shape used when the channel is created:
        // LOOP publishes no profile facts to Stream.
        const usersResponse = await client.upsertUsers(
          input.memberStreamUserIds.map((id) => ({ id })),
        );
        input.signal.throwIfAborted();
        validateUpsertedUsers(usersResponse, input.memberStreamUserIds);
        input.signal.throwIfAborted();
      }
      const response = await client.chat
        .channel(streamChannelType, input.channelId)
        .update(
          direction === "add"
            ? {
                user_id: input.actingStreamUserId,
                add_members: input.memberStreamUserIds.map((userId) => {
                  const persona = personas.get(userId);
                  return persona === undefined
                    ? { user_id: userId }
                    : { user_id: userId, custom: personaCustom(persona) };
                }),
              }
            : {
                user_id: input.actingStreamUserId,
                remove_members: [...input.memberStreamUserIds],
              },
        );
      input.signal.throwIfAborted();
      const projection = validateMembershipChannelResponse(
        response,
        input.channelId,
      );
      return Object.freeze({
        ...projection,
        confirmedPersonaStreamUserIds: confirmedPersonas(response, [
          ...personas.values(),
        ]),
      });
    } catch (error) {
      if (error instanceof StreamChannelProjectionMismatchError) {
        throw error;
      }
      return sanitizeCommunityProviderFailure(error, input.signal);
    }
  }

  return Object.freeze({
    async upsertCommunityChannel(
      rawInput: UpsertStreamCommunityChannelInput,
    ): Promise<StreamCommunityChannelProjection> {
      const input = parseUpsertCommunityInput(rawInput);
      try {
        input.signal.throwIfAborted();
        const usersResponse = await client.upsertUsers([
          { id: input.createdByStreamUserId },
        ]);
        input.signal.throwIfAborted();
        validateUpsertedUsers(usersResponse, [input.createdByStreamUserId]);

        input.signal.throwIfAborted();
        const response = await client.chat
          .channel(streamChannelType, input.channelId)
          .getOrCreate({
            state: true,
            data: {
              created_by_id: input.createdByStreamUserId,
              members: [{ user_id: input.createdByStreamUserId }],
              custom: {
                loop_channel_kind: "community",
                loop_channel_schema_version: streamChannelSchemaVersion,
                name: input.name,
              },
            },
            members: { limit: 1 },
            messages: { limit: 0 },
            watchers: { limit: 0 },
          });
        input.signal.throwIfAborted();
        return validateCommunityChannelResponse(response, input.channelId);
      } catch (error) {
        if (error instanceof StreamChannelProjectionMismatchError) {
          throw error;
        }
        return sanitizeCommunityProviderFailure(error, input.signal);
      }
    },

    addMembers(
      rawInput: StreamCommunityChannelMemberInput,
    ): Promise<StreamCommunityChannelMemberProjection> {
      return mutateMembers(rawInput, "add");
    },

    async removeMembers(
      rawInput: StreamCommunityChannelMemberInput,
    ): Promise<StreamCommunityChannelProjection> {
      const projection = await mutateMembers(rawInput, "remove");
      return Object.freeze({
        channelId: projection.channelId,
        streamCid: projection.streamCid,
        memberCount: projection.memberCount,
      });
    },

    async projectMemberPersona(
      rawInput: ProjectStreamCommunityMemberPersonaInput,
    ): Promise<void> {
      const input = parseProjectPersonaInput(rawInput);
      try {
        input.signal.throwIfAborted();
        const response = await client.chat
          .channel(streamChannelType, input.channelId)
          .updateMemberPartial({
            user_id: input.streamUserId,
            set: personaCustom({
              streamUserId: input.streamUserId,
              personaId: input.personaId,
              alias: input.alias,
            }),
          });
        input.signal.throwIfAborted();
        validatePersonaProjectionResponse(response, input);
      } catch (error) {
        if (error instanceof StreamChannelProjectionMismatchError) {
          throw error;
        }
        return sanitizeCommunityProviderFailure(error, input.signal);
      }
    },

    async readCommunityChannelPresence(
      rawInput: ReadStreamCommunityChannelPresenceInput,
    ): Promise<StreamCommunityChannelPresenceResult> {
      const input = parsePresenceInput(rawInput);
      try {
        let memberCount = 0;
        let onlineMemberCount = 0;
        for (let page = 0; page < communityPresenceMaximumPages; page += 1) {
          input.signal.throwIfAborted();
          // Read-only: the member query neither creates the channel nor
          // touches its membership. Stream ignores an `online` filter, so
          // every member is paged and counted here. The sort makes offset
          // paging deterministic across pages.
          const response = await client.chat
            .channel(streamChannelType, input.channelId)
            .queryMembers({
              payload: {
                filter_conditions: {},
                sort: [{ field: "created_at", direction: 1 }],
                limit: communityPresencePageSize,
                offset: page * communityPresencePageSize,
              },
            });
          input.signal.throwIfAborted();
          const reduced = reduceMemberPage(response);
          memberCount += reduced.pageSize;
          onlineMemberCount += reduced.online;
          if (reduced.pageSize < communityPresencePageSize) {
            return Object.freeze({
              status: "observed" as const,
              channelId: input.channelId,
              onlineMemberCount,
              memberCount,
            });
          }
        }
        // Every page came back full: the channel may have more members than
        // the budget covers, and a count of the first N is not a total.
        return Object.freeze({
          status: "bound_exceeded" as const,
          channelId: input.channelId,
          memberBound: communityPresenceMemberBound,
        });
      } catch (error) {
        if (error instanceof StreamChannelProjectionMismatchError) {
          throw error;
        }
        return sanitizeCommunityProviderFailure(error, input.signal);
      }
    },

    async readCommunityChannelActivity(
      rawInput: ReadStreamCommunityChannelActivityInput,
    ): Promise<readonly StreamCommunityChannelActivity[]> {
      const input = parseActivityInput(rawInput);
      try {
        input.signal.throwIfAborted();
        // Read-only: the query neither creates a channel nor joins one. The
        // message page is what the window count is measured from; Stream
        // publishes no per-window count of its own.
        const response = await client.chat.queryChannels({
          filter_conditions: {
            type: streamChannelType,
            id: { $in: [...input.channelIds] },
          },
          sort: [{ field: "last_message_at", direction: -1 }],
          limit: input.channelIds.length,
          message_limit: communityActivityMessagePage,
          member_limit: 0,
          state: true,
        });
        input.signal.throwIfAborted();
        const channels: unknown = isRecord(response)
          ? response["channels"]
          : undefined;
        if (!Array.isArray(channels)) {
          return projectionMismatch();
        }
        return Object.freeze(
          (channels as unknown[]).flatMap((channel) => {
            const reduced = reduceActivityChannel(
              channel,
              input.since,
              input.channelIds,
            );
            return reduced === null ? [] : [reduced];
          }),
        );
      } catch (error) {
        if (error instanceof StreamChannelProjectionMismatchError) {
          throw error;
        }
        return sanitizeCommunityProviderFailure(error, input.signal);
      }
    },
  });
}
