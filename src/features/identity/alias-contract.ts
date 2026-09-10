import { z } from "zod";

const maximumRawAliasLength = 256;
const maximumAliasCodePoints = 40;
const minimumSearchPrefixCodePoints = 2;
const minimumMemberSearchPrefixCodePoints = 1;
const maximumSearchResults = 20;
const forbiddenAliasCharacters = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const streamChannelIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const boundedAliasSchema = z
  .string()
  .max(maximumRawAliasLength)
  .superRefine((value, context) => {
    const trimmed = value.trim();
    const length = Array.from(trimmed).length;

    if (
      length < 1 ||
      length > maximumAliasCodePoints ||
      forbiddenAliasCharacters.test(value)
    ) {
      context.addIssue({ code: "custom" });
    }
  })
  .transform((value) => value.trim());

/**
 * Shared alias prefix normalization: trim, NFKC, ASCII-space fold, then the
 * alias character-safety rules. Only the minimum length differs between the
 * public alias directory (2 code points) and the community member directory
 * (1 code point, because that directory is already scoped to one community).
 */
function createAliasPrefixSchema(minimumCodePoints: number) {
  return z
    .string()
    .max(maximumRawAliasLength)
    .superRefine((value, context) => {
      const normalizedForValidation = normalizeAliasSearchPrefix(value);
      const length = Array.from(normalizedForValidation).length;

      if (
        length < minimumCodePoints ||
        length > maximumAliasCodePoints ||
        forbiddenAliasCharacters.test(value) ||
        forbiddenAliasCharacters.test(normalizedForValidation)
      ) {
        context.addIssue({ code: "custom" });
      }
    })
    .transform((value) => value.trim());
}

/**
 * Length and character screening form: trim, NFKC, and fold runs of ASCII
 * spaces. Case is deliberately preserved here so the accepted code-point
 * range matches the alias itself; the stored lookup key is still produced by
 * PostgreSQL.
 */
export function normalizeAliasSearchPrefix(value: string): string {
  return value.trim().normalize("NFKC").replace(/ +/g, " ");
}

/**
 * The client-side mirror of `loop_alias_search_key_unicode17_v1`. Two queries
 * with the same key return the same rows, so a list cursor binds this and not
 * the caller's raw text.
 */
export function aliasSearchPrefixKey(value: string): string {
  return normalizeAliasSearchPrefix(value).toLowerCase();
}

const aliasPrefixSchema = createAliasPrefixSchema(
  minimumSearchPrefixCodePoints,
);

const memberSearchPrefixSchema = createAliasPrefixSchema(
  minimumMemberSearchPrefixCodePoints,
);

const searchLimitSchema = z.number().int().min(1).max(maximumSearchResults);
const uuidSchema = z.string().regex(canonicalUuidPattern);
const channelIdSchema = z.string().regex(streamChannelIdPattern);

export const aliasSearchLimits = Object.freeze({
  default: maximumSearchResults,
  maximum: maximumSearchResults,
  minimumPrefixCodePoints: minimumSearchPrefixCodePoints,
});

export const memberSearchLimits = Object.freeze({
  minimumPrefixCodePoints: minimumMemberSearchPrefixCodePoints,
  maximumPrefixCodePoints: maximumAliasCodePoints,
  maximumRawLength: maximumRawAliasLength,
});

export type GroupAliasProjectionState = "pending" | "confirmed";

export interface PublicAliasSearchItem {
  readonly public_profile_id: string;
  readonly profile_code: string;
  readonly alias: string;
  readonly avatar_ref: string | null;
}

export interface PublicAliasSearchResource {
  readonly items: readonly PublicAliasSearchItem[];
  readonly truncated: boolean;
}

export interface CommunicationGroupResource {
  readonly group_id: string;
}

export interface GroupAliasResource {
  readonly group_alias_id: string;
  readonly alias: string;
  readonly projection_state: GroupAliasProjectionState;
}

export interface GroupAliasSearchItem {
  readonly group_alias_id: string;
  readonly alias: string;
}

export interface GroupAliasSearchResource {
  readonly items: readonly GroupAliasSearchItem[];
  readonly truncated: boolean;
}

export function parseAliasSearchPrefix(value: unknown): string {
  return aliasPrefixSchema.parse(value);
}

/**
 * Community member-directory prefix (Decision 0040). Same normalization and
 * character-safety rules as the public alias prefix; one code point is enough
 * because the search is already narrowed to a single community.
 */
export function parseMemberSearchPrefix(value: unknown): string {
  return memberSearchPrefixSchema.parse(value);
}

export function parseAliasSearchLimit(value: unknown): number {
  return value === undefined
    ? aliasSearchLimits.default
    : searchLimitSchema.parse(value);
}

export function parseGroupAlias(value: unknown): string {
  return boundedAliasSchema.parse(value);
}

export function parseCommunicationGroupId(value: unknown): string {
  return uuidSchema.parse(value);
}

export function parseStreamChannelId(value: unknown): string {
  return channelIdSchema.parse(value);
}

export function parseOpaqueAliasId(value: unknown): string {
  return uuidSchema.parse(value);
}
