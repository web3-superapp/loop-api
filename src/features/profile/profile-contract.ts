import { z } from "zod";

const maximumRecordVersion = 2_147_483_647;
const maximumRawAliasLength = 256;
const maximumAliasCodePoints = 40;
const forbiddenAliasCharacters = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const avatarReferencePattern = /^avatar:[A-Za-z0-9][A-Za-z0-9._/-]{0,126}$/;

const expectedVersionSchema = z.number().int().min(0).max(maximumRecordVersion);

const aliasSchema = z
  .string()
  .max(maximumRawAliasLength)
  .superRefine((value, context) => {
    const normalized = value.trim();
    const codePointLength = Array.from(normalized).length;

    if (
      codePointLength < 1 ||
      codePointLength > maximumAliasCodePoints ||
      forbiddenAliasCharacters.test(value)
    ) {
      context.addIssue({ code: "custom" });
    }
  })
  .transform((value) => value.trim());

const profileValuesSchema = z
  .object({
    alias: aliasSchema.nullable(),
    avatar_ref: z.string().regex(avatarReferencePattern).nullable(),
  })
  .strict();

const privacyValuesSchema = z
  .object({
    discoverable: z.boolean(),
    copy_trade_visibility: z.enum(["private", "followers", "public"]),
  })
  .strict();

const replaceProfileRequestSchema = z
  .object({
    expected_version: expectedVersionSchema,
    profile: profileValuesSchema,
  })
  .strict();

const replacePrivacyRequestSchema = z
  .object({
    expected_version: expectedVersionSchema,
    privacy: privacyValuesSchema,
  })
  .strict();

const updatedAtSchema = z
  .string()
  .max(64)
  .datetime({ offset: true })
  .nullable();

const profileResourceSchema = z
  .object({
    version: expectedVersionSchema,
    profile: profileValuesSchema,
    updated_at: updatedAtSchema,
  })
  .strict()
  .superRefine((resource, context) => {
    if ((resource.version === 0) !== (resource.updated_at === null)) {
      context.addIssue({ code: "custom" });
    }
  });

const privacyResourceSchema = z
  .object({
    version: expectedVersionSchema,
    privacy: privacyValuesSchema,
    updated_at: updatedAtSchema,
  })
  .strict()
  .superRefine((resource, context) => {
    if ((resource.version === 0) !== (resource.updated_at === null)) {
      context.addIssue({ code: "custom" });
    }
  });

export type ProfileValues = Readonly<z.infer<typeof profileValuesSchema>>;
export type PrivacyValues = Readonly<z.infer<typeof privacyValuesSchema>>;
export type ReplaceProfileRequest = Readonly<
  z.infer<typeof replaceProfileRequestSchema>
>;
export type ReplacePrivacyRequest = Readonly<
  z.infer<typeof replacePrivacyRequestSchema>
>;
export type ProfileResource = Readonly<
  Omit<z.infer<typeof profileResourceSchema>, "profile"> & {
    readonly profile: ProfileValues;
  }
>;
export type PrivacyResource = Readonly<
  Omit<z.infer<typeof privacyResourceSchema>, "privacy"> & {
    readonly privacy: PrivacyValues;
  }
>;

export const defaultProfileValues: ProfileValues = Object.freeze({
  alias: null,
  avatar_ref: null,
});

export const defaultPrivacyValues: PrivacyValues = Object.freeze({
  discoverable: false,
  copy_trade_visibility: "private",
});

function freezeProfileValues(value: ProfileValues): ProfileValues {
  return Object.freeze({
    alias: value.alias,
    avatar_ref: value.avatar_ref,
  });
}

function freezePrivacyValues(value: PrivacyValues): PrivacyValues {
  return Object.freeze({
    discoverable: value.discoverable,
    copy_trade_visibility: value.copy_trade_visibility,
  });
}

export function parseProfileValues(value: unknown): ProfileValues {
  return freezeProfileValues(profileValuesSchema.parse(value));
}

export function parsePrivacyValues(value: unknown): PrivacyValues {
  return freezePrivacyValues(privacyValuesSchema.parse(value));
}

export function parseReplaceProfileRequest(
  value: unknown,
): ReplaceProfileRequest {
  const parsed = replaceProfileRequestSchema.parse(value);
  return Object.freeze({
    expected_version: parsed.expected_version,
    profile: freezeProfileValues(parsed.profile),
  });
}

export function parseReplacePrivacyRequest(
  value: unknown,
): ReplacePrivacyRequest {
  const parsed = replacePrivacyRequestSchema.parse(value);
  return Object.freeze({
    expected_version: parsed.expected_version,
    privacy: freezePrivacyValues(parsed.privacy),
  });
}

export function parseProfileResource(value: unknown): ProfileResource {
  const parsed = profileResourceSchema.parse(value);
  return Object.freeze({
    version: parsed.version,
    profile: freezeProfileValues(parsed.profile),
    updated_at: parsed.updated_at,
  });
}

export function parsePrivacyResource(value: unknown): PrivacyResource {
  const parsed = privacyResourceSchema.parse(value);
  return Object.freeze({
    version: parsed.version,
    privacy: freezePrivacyValues(parsed.privacy),
    updated_at: parsed.updated_at,
  });
}

export function profileValuesEqual(
  left: ProfileValues,
  right: ProfileValues,
): boolean {
  return left.alias === right.alias && left.avatar_ref === right.avatar_ref;
}

export function privacyValuesEqual(
  left: PrivacyValues,
  right: PrivacyValues,
): boolean {
  return (
    left.discoverable === right.discoverable &&
    left.copy_trade_visibility === right.copy_trade_visibility
  );
}
