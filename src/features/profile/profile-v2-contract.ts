import { createHash } from "node:crypto";

import { z } from "zod";

import { loopIdPatternSource } from "../identity/loop-id.js";
import type { v2ContractVersion } from "../meta/product-policy.js";
import { isAvatarPresetRef } from "./avatar-presets.js";

/**
 * V2 profile and privacy wire contract (Decision 0030). Public fields are
 * camelCase; every value here is untrusted presentation data and never an
 * identity or authorization key.
 */

export const maximumRecordVersion = 2_147_483_647;
export const maximumRawTextLength = 1_024;
export const maximumAliasCodePoints = 40;
export const maximumBioCodePoints = 160;
export const maximumInterests = 6;
export const profileInterestValues = Object.freeze([
  "MEME",
  "DEFI",
  "AI",
  "GAMEFI",
  "NFT",
  "RWA",
] as const);
export const profileStatusValues = Object.freeze([
  "pending",
  "active",
] as const);
export const privacyVisibilityValues = Object.freeze([
  "self",
  "everyone",
] as const);
export const profileActivationDigestVersion = "profile_activation_v1" as const;

export type ProfileInterest = (typeof profileInterestValues)[number];
export type ProfileStatus = (typeof profileStatusValues)[number];
export type PrivacyVisibility = (typeof privacyVisibilityValues)[number];

const forbiddenTextCharacters = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const loopIdPattern = new RegExp(loopIdPatternSource);

function boundedText(maximumCodePoints: number) {
  return z
    .string()
    .max(maximumRawTextLength)
    .superRefine((value, context) => {
      const trimmed = value.trim();
      const codePoints = Array.from(trimmed).length;
      if (
        codePoints < 1 ||
        codePoints > maximumCodePoints ||
        forbiddenTextCharacters.test(value)
      ) {
        context.addIssue({ code: "custom" });
      }
    })
    .transform((value) => value.trim());
}

const aliasSchema = boundedText(maximumAliasCodePoints);
const bioSchema = boundedText(maximumBioCodePoints);
const avatarRefSchema = z
  .string()
  .max(160)
  .refine((value) => isAvatarPresetRef(value));
const interestsSchema = z
  .array(z.enum(profileInterestValues))
  .max(maximumInterests)
  .transform((values) => Object.freeze([...new Set(values)]));
const expectedVersionSchema = z.number().int().min(0).max(maximumRecordVersion);

const profileValuesSchema = z
  .object({
    alias: aliasSchema.nullable(),
    avatarRef: avatarRefSchema.nullable(),
    bio: bioSchema.nullable(),
    interests: interestsSchema,
  })
  .strict();

const activationValuesSchema = z
  .object({
    alias: aliasSchema,
    avatarRef: avatarRefSchema.nullable(),
    interests: interestsSchema,
  })
  .strict();

const replaceProfileRequestSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    profile: profileValuesSchema,
  })
  .strict();

const visibilitySchema = z
  .object({
    totalAssets: z.enum(privacyVisibilityValues),
    miningPower: z.enum(privacyVisibilityValues),
    communities: z.enum(privacyVisibilityValues),
    tradeHistory: z.enum(privacyVisibilityValues),
  })
  .strict();

const privacyValuesSchema = z
  .object({
    discoverable: z.boolean(),
    anonymousMode: z.boolean(),
    visibility: visibilitySchema,
  })
  .strict();

const replacePrivacyRequestSchema = z
  .object({
    expectedVersion: expectedVersionSchema,
    privacy: privacyValuesSchema,
  })
  .strict();

const loopIdSchema = z.string().regex(loopIdPattern);

export interface ProfileV2Values {
  readonly alias: string | null;
  readonly avatarRef: string | null;
  readonly bio: string | null;
  readonly interests: readonly ProfileInterest[];
}

export interface ProfileV2ActivationValues {
  readonly alias: string;
  readonly avatarRef: string | null;
  readonly interests: readonly ProfileInterest[];
}

export interface ReplaceProfileV2Request {
  readonly expectedVersion: number;
  readonly profile: ProfileV2Values;
}

export interface ProfileV2Projection extends ProfileV2Values {
  readonly loopId: string;
  readonly profileStatus: ProfileStatus;
  readonly activatedAt: string | null;
}

export interface ProfileV2Resource {
  readonly profile: ProfileV2Projection;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface PrivacyV2Visibility {
  readonly totalAssets: PrivacyVisibility;
  readonly miningPower: PrivacyVisibility;
  readonly communities: PrivacyVisibility;
  readonly tradeHistory: PrivacyVisibility;
}

export interface PrivacyV2Values {
  readonly discoverable: boolean;
  readonly anonymousMode: boolean;
  readonly visibility: PrivacyV2Visibility;
}

export interface ReplacePrivacyV2Request {
  readonly expectedVersion: number;
  readonly privacy: PrivacyV2Values;
}

export interface PrivacyV2Resource {
  readonly privacy: PrivacyV2Values;
  readonly version: number;
  readonly updatedAt: string | null;
  readonly contractVersion: typeof v2ContractVersion;
}

export class InvalidProfileV2RequestError extends Error {
  readonly code = "invalid_profile_v2_request";

  constructor() {
    super("The V2 profile request is invalid");
    this.name = "InvalidProfileV2RequestError";
  }
}

export const defaultProfileV2Values: ProfileV2Values = Object.freeze({
  alias: null,
  avatarRef: null,
  bio: null,
  interests: Object.freeze([]),
});

export const defaultPrivacyV2Values: PrivacyV2Values = Object.freeze({
  discoverable: false,
  anonymousMode: false,
  visibility: Object.freeze({
    totalAssets: "self",
    miningPower: "self",
    communities: "self",
    tradeHistory: "self",
  }),
});

function invalid(): never {
  throw new InvalidProfileV2RequestError();
}

export function freezeProfileV2Values(value: ProfileV2Values): ProfileV2Values {
  return Object.freeze({
    alias: value.alias,
    avatarRef: value.avatarRef,
    bio: value.bio,
    interests: Object.freeze([...value.interests]),
  });
}

export function freezePrivacyV2Values(value: PrivacyV2Values): PrivacyV2Values {
  return Object.freeze({
    discoverable: value.discoverable,
    anonymousMode: value.anonymousMode,
    visibility: Object.freeze({
      totalAssets: value.visibility.totalAssets,
      miningPower: value.visibility.miningPower,
      communities: value.visibility.communities,
      tradeHistory: value.visibility.tradeHistory,
    }),
  });
}

export function parseProfileV2Values(value: unknown): ProfileV2Values {
  const parsed = profileValuesSchema.safeParse(value);
  return parsed.success ? freezeProfileV2Values(parsed.data) : invalid();
}

export function parseProfileV2ActivationValues(
  value: unknown,
): ProfileV2ActivationValues {
  const parsed = activationValuesSchema.safeParse(value);
  if (!parsed.success) {
    return invalid();
  }
  return Object.freeze({
    alias: parsed.data.alias,
    avatarRef: parsed.data.avatarRef,
    interests: Object.freeze([...parsed.data.interests]),
  });
}

export function parseReplaceProfileV2Request(
  value: unknown,
): ReplaceProfileV2Request {
  const parsed = replaceProfileRequestSchema.safeParse(value);
  if (!parsed.success) {
    return invalid();
  }
  return Object.freeze({
    expectedVersion: parsed.data.expectedVersion,
    profile: freezeProfileV2Values(parsed.data.profile),
  });
}

export function parsePrivacyV2Values(value: unknown): PrivacyV2Values {
  const parsed = privacyValuesSchema.safeParse(value);
  return parsed.success ? freezePrivacyV2Values(parsed.data) : invalid();
}

export function parseReplacePrivacyV2Request(
  value: unknown,
): ReplacePrivacyV2Request {
  const parsed = replacePrivacyRequestSchema.safeParse(value);
  if (!parsed.success) {
    return invalid();
  }
  return Object.freeze({
    expectedVersion: parsed.data.expectedVersion,
    privacy: freezePrivacyV2Values(parsed.data.privacy),
  });
}

export function parseLoopIdValue(value: unknown): string {
  const parsed = loopIdSchema.safeParse(value);
  return parsed.success ? parsed.data : invalid();
}

export function profileV2ValuesEqual(
  left: ProfileV2Values,
  right: ProfileV2Values,
): boolean {
  return (
    left.alias === right.alias &&
    left.avatarRef === right.avatarRef &&
    left.bio === right.bio &&
    left.interests.length === right.interests.length &&
    left.interests.every((value, index) => value === right.interests[index])
  );
}

export function privacyV2ValuesEqual(
  left: PrivacyV2Values,
  right: PrivacyV2Values,
): boolean {
  return (
    left.discoverable === right.discoverable &&
    left.anonymousMode === right.anonymousMode &&
    left.visibility.totalAssets === right.visibility.totalAssets &&
    left.visibility.miningPower === right.visibility.miningPower &&
    left.visibility.communities === right.visibility.communities &&
    left.visibility.tradeHistory === right.visibility.tradeHistory
  );
}

/**
 * Canonical SHA-256 request digest for `POST /v2/profile/loop-id`. It binds
 * the operation kind, contract version, and normalized body so a replayed
 * `Idempotency-Key` with different intent is rejected as IDEMPOTENCY_CONFLICT.
 */
export function profileActivationDigest(
  values: ProfileV2ActivationValues,
  contractVersion: typeof v2ContractVersion,
): string {
  const hash = createHash("sha256");
  hash.update(`loop:v2:profile-activation:${profileActivationDigestVersion}`);
  for (const part of [
    "activate",
    contractVersion,
    values.alias,
    values.avatarRef ?? "",
    values.interests.join(","),
  ]) {
    hash.update("\0", "utf8");
    hash.update(part, "utf8");
  }
  return hash.digest("hex");
}
