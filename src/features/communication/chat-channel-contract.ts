import { createHash } from "node:crypto";

import { z } from "zod";

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const canonicalUuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const forbiddenNameCharacters = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const maximumRawNameLength = 512;
const maximumNameCodePoints = 60;

const publicProfileIdSchema = z.string().regex(canonicalUuidPattern);
const groupNameSchema = z
  .string()
  .max(maximumRawNameLength)
  .superRefine((value, context) => {
    const normalized = value.trim();
    const length = Array.from(normalized).length;
    if (
      length < 1 ||
      length > maximumNameCodePoints ||
      forbiddenNameCharacters.test(value)
    ) {
      context.addIssue({ code: "custom" });
    }
  })
  .transform((value) => value.trim());

const createGroupSchema = z
  .object({
    name: groupNameSchema,
    friend_public_profile_ids: z.array(publicProfileIdSchema).min(2).max(29),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.friend_public_profile_ids).size !==
      value.friend_public_profile_ids.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["friend_public_profile_ids"],
      });
    }
  });

const createDirectSchema = z
  .object({ target_public_profile_id: publicProfileIdSchema })
  .strict();

export const chatOperationKinds = [
  "group_create",
  "direct_get_or_create",
] as const;
export type ChatOperationKind = (typeof chatOperationKinds)[number];

export const chatOperationStatuses = [
  "pending",
  "submitting",
  "reconciling",
  "succeeded",
  "failed",
  "operator_required",
] as const;
export type ChatOperationStatus = (typeof chatOperationStatuses)[number];

export interface CreateChatGroupRequest {
  readonly name: string;
  readonly friend_public_profile_ids: readonly string[];
}

export interface CreateDirectChannelRequest {
  readonly target_public_profile_id: string;
}

export interface ChatGroupResult {
  readonly group_id: string;
  readonly name: string;
  readonly friend_public_profile_ids: readonly string[];
  readonly stream_cid: string;
}

export interface DirectChannelResult {
  readonly target_public_profile_id: string;
  readonly stream_cid: string;
}

export type ChatOperationResult = ChatGroupResult | DirectChannelResult;

export interface ChatOperationResource {
  readonly operation_id: string;
  readonly kind: ChatOperationKind;
  readonly status: ChatOperationStatus;
  readonly terminal: boolean;
  readonly retry_after_ms: number | null;
  readonly result: ChatOperationResult | null;
  readonly error: Readonly<{ code: string }> | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export class InvalidChatChannelRequestError extends Error {
  constructor() {
    super("The Chat channel request is invalid");
    this.name = "InvalidChatChannelRequestError";
  }
}

export function parseCreateChatGroupRequest(
  value: unknown,
): CreateChatGroupRequest {
  const parsed = createGroupSchema.parse(value);
  return Object.freeze({
    name: parsed.name,
    friend_public_profile_ids: Object.freeze([
      ...parsed.friend_public_profile_ids,
    ]),
  });
}

export function parseCreateDirectChannelRequest(
  value: unknown,
): CreateDirectChannelRequest {
  const parsed = createDirectSchema.parse(value);
  return Object.freeze({
    target_public_profile_id: parsed.target_public_profile_id,
  });
}

export function parseChatOperationId(value: unknown): string {
  return z.string().regex(canonicalUuidV4Pattern).parse(value);
}

export function parseChatIdempotencyKey(rawHeaders: readonly string[]): string {
  if (rawHeaders.length % 2 !== 0) {
    throw new InvalidChatChannelRequestError();
  }
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (typeof name !== "string" || typeof value !== "string") {
      throw new InvalidChatChannelRequestError();
    }
    if (name.toLowerCase() === "idempotency-key") {
      values.push(value);
    }
  }
  const value = values[0];
  if (
    values.length !== 1 ||
    value === undefined ||
    !canonicalUuidV4Pattern.test(value)
  ) {
    throw new InvalidChatChannelRequestError();
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update("loop_chat_channel_command_v1\0", "utf8")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

export function digestCreateChatGroupRequest(
  request: CreateChatGroupRequest,
): string {
  return digest({
    kind: "group_create",
    name: request.name,
    friend_public_profile_ids: [...request.friend_public_profile_ids].sort(),
  });
}

export function digestCreateDirectChannelRequest(
  request: CreateDirectChannelRequest,
): string {
  return digest({
    kind: "direct_get_or_create",
    target_public_profile_id: request.target_public_profile_id,
  });
}

export function isTerminalChatOperationStatus(
  status: ChatOperationStatus,
): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "operator_required"
  );
}
