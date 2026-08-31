import { createHash } from "node:crypto";

import { z } from "zod";

import type {
  FriendRelationship,
  FriendRequestDirection,
  FriendRequestStatus,
  SocialDirectMessagesPreference,
  SocialFriendRequestsPreference,
  SocialGroupInvitesPreference,
  SocialOperationKind,
  SocialOperationStatus,
  SocialPrivacyValues,
} from "../../database/social-repository.js";

const maximumRecordVersion = 2_147_483_647;
const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const canonicalUuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const profileCodePattern = /^[0-9A-HJKMNP-TV-Z]{10}$/;
const avatarReferencePattern = /^avatar:[A-Za-z0-9][A-Za-z0-9._/-]{0,126}$/;
const socialCommandDigestDomain = "loop.social-command\0v1\0";

const uuidSchema = z.string().regex(canonicalUuidPattern);
const versionSchema = z.number().int().min(0).max(maximumRecordVersion);
const socialPrivacyValuesSchema = z
  .object({
    friend_requests: z.enum(["enabled", "disabled"]),
    group_invites: z.enum(["friends", "disabled"]),
    direct_messages: z.enum(["friends", "disabled"]),
  })
  .strict();
const socialPrivacyReplacementSchema = z
  .object({
    expected_version: versionSchema,
    social_privacy: socialPrivacyValuesSchema,
  })
  .strict();
const friendRequestSendSchema = z
  .object({ target_public_profile_id: uuidSchema })
  .strict();
const friendRequestDecisionSchema = z
  .object({ decision: z.enum(["accept", "reject"]) })
  .strict();
const socialListLimitSchema = z.number().int().min(1).max(50);

export const socialListLimits = Object.freeze({ default: 20, maximum: 50 });

export const defaultSocialPrivacyValues: Readonly<SocialPrivacyValues> =
  Object.freeze({
    friend_requests: "disabled",
    group_invites: "disabled",
    direct_messages: "disabled",
  });

export interface SocialPrivacyResource {
  readonly version: number;
  readonly social_privacy: Readonly<SocialPrivacyValues>;
  readonly updated_at: string | null;
}

export interface SocialPrivacyReplacement {
  readonly expected_version: number;
  readonly social_privacy: Readonly<SocialPrivacyValues>;
}

export interface FriendPresentation {
  readonly public_profile_id: string;
  readonly profile_code: string;
  readonly alias: string | null;
  readonly avatar_ref: string | null;
}

export interface FriendResource extends FriendPresentation {
  readonly accepted_at: string;
}

export interface FriendListResource {
  readonly items: readonly FriendResource[];
  readonly next_cursor: string | null;
}

export interface FriendSearchResourceItem extends Omit<
  FriendPresentation,
  "alias"
> {
  readonly alias: string;
  readonly relationship: FriendRelationship;
  readonly friend_request_id: string | null;
}

export interface FriendSearchResource {
  readonly items: readonly FriendSearchResourceItem[];
  readonly truncated: boolean;
}

export interface FriendRequestResource {
  readonly friend_request_id: string;
  readonly counterparty: FriendPresentation;
  readonly direction: FriendRequestDirection;
  readonly status: FriendRequestStatus;
  readonly created_at: string;
  readonly expires_at: string;
}

export interface FriendRequestListResource {
  readonly items: readonly FriendRequestResource[];
  readonly next_cursor: string | null;
}

export interface FriendRequestSend {
  readonly target_public_profile_id: string;
}

export interface FriendRequestDecision {
  readonly decision: "accept" | "reject";
}

export interface SocialOperationResult {
  readonly friend_request_id: string;
  readonly status: FriendRequestStatus;
}

export interface SocialOperationError {
  readonly code: string;
}

export interface SocialOperationResource {
  readonly operation_id: string;
  readonly kind: SocialOperationKind;
  readonly status: SocialOperationStatus;
  readonly terminal: true;
  readonly retry_after_ms: null;
  readonly result: SocialOperationResult | null;
  readonly error: SocialOperationError | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export function parseSocialPrivacyReplacement(
  value: unknown,
): SocialPrivacyReplacement {
  const parsed = socialPrivacyReplacementSchema.parse(value);
  return Object.freeze({
    expected_version: parsed.expected_version,
    social_privacy: Object.freeze({ ...parsed.social_privacy }),
  });
}

export function parseFriendRequestSend(value: unknown): FriendRequestSend {
  return Object.freeze(friendRequestSendSchema.parse(value));
}

export function parseFriendRequestDecision(
  value: unknown,
): FriendRequestDecision {
  return Object.freeze(friendRequestDecisionSchema.parse(value));
}

export function parseSocialListLimit(value: unknown): number {
  return value === undefined
    ? socialListLimits.default
    : socialListLimitSchema.parse(value);
}

export function parseSocialUuid(value: unknown): string {
  return uuidSchema.parse(value);
}

export function parseSocialIdempotencyKey(
  rawHeaders: readonly unknown[],
): string {
  if (rawHeaders.length % 2 !== 0) {
    throw new TypeError("The social idempotency key is invalid");
  }

  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (typeof name !== "string" || typeof value !== "string") {
      throw new TypeError("The social idempotency key is invalid");
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
    throw new TypeError("The social idempotency key is invalid");
  }
  return value;
}

export function digestFriendRequestSend(request: FriendRequestSend): string {
  return createHash("sha256")
    .update(`${socialCommandDigestDomain}friend_request_send\0`, "utf8")
    .update(request.target_public_profile_id, "utf8")
    .digest("hex");
}

export function digestFriendRequestDecision(
  friendRequestId: string,
  request: FriendRequestDecision,
): string {
  const canonicalFriendRequestId = parseSocialUuid(friendRequestId);
  return createHash("sha256")
    .update(`${socialCommandDigestDomain}friend_request_decide\0`, "utf8")
    .update(canonicalFriendRequestId, "utf8")
    .update(`\0${request.decision}`, "utf8")
    .digest("hex");
}

export function isValidProfileCode(value: string): boolean {
  return profileCodePattern.test(value);
}

export function isValidAvatarReference(value: string): boolean {
  return avatarReferencePattern.test(value);
}

export type {
  FriendRelationship,
  FriendRequestDirection,
  FriendRequestStatus,
  SocialDirectMessagesPreference,
  SocialFriendRequestsPreference,
  SocialGroupInvitesPreference,
  SocialOperationKind,
  SocialOperationStatus,
};
