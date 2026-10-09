import { z } from "zod";

import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import { deriveStreamUserId } from "../identity/loop-identifiers.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import type { V2SessionWriteMetadata } from "../session/session-contract.js";
import type { AliasPolicy } from "./alias-policy.js";
import { avatarPresets, type AvatarPreset } from "./avatar-presets.js";
import {
  defaultPrivacyV2Values,
  InvalidProfileV2RequestError,
  parseProfileV2ActivationValues,
  parseReplacePrivacyV2Request,
  parseReplaceProfileV2Request,
  profileActivationDigest,
  type PrivacyV2Resource,
  type ProfileV2Resource,
} from "./profile-v2-contract.js";
import {
  privacyV2RecordValues,
  ProfileV2IdempotencyConflictError,
  ProfileV2RepositoryUnavailableError,
  ProfileV2VersionConflictError,
  type PrivacyV2Record,
  type ProfileV2Record,
  type ProfileV2Repository,
} from "./profile-v2-repository.js";

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const principalSchema = z
  .object({
    userId: z.string().regex(canonicalUuidPattern),
    privyUserId: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[\x21-\x7e]+$/),
    streamUserId: z.string().min(1).max(63),
  })
  .strict();

export interface ProfileV2ReadInput {
  readonly principal: AuthenticatedLoopPrincipal;
}

export interface ProfileV2WriteInput extends ProfileV2ReadInput {
  readonly body: unknown;
}

export interface ProfileV2ActivateInput extends ProfileV2WriteInput {
  readonly metadata: V2SessionWriteMetadata;
  readonly requestId: string;
}

export interface AvatarPresetsResource {
  readonly avatars: readonly AvatarPreset[];
  readonly contractVersion: typeof v2ContractVersion;
}

export interface ProfileV2Service {
  getProfile(input: ProfileV2ReadInput): Promise<ProfileV2Resource>;
  replaceProfile(input: ProfileV2WriteInput): Promise<ProfileV2Resource>;
  activateProfile(input: ProfileV2ActivateInput): Promise<ProfileV2Resource>;
  getPrivacy(input: ProfileV2ReadInput): Promise<PrivacyV2Resource>;
  replacePrivacy(input: ProfileV2WriteInput): Promise<PrivacyV2Resource>;
  listAvatarPresets(): AvatarPresetsResource;
}

function assertPrincipal(
  principal: AuthenticatedLoopPrincipal,
): AuthenticatedLoopPrincipal {
  const parsed = principalSchema.safeParse(principal);
  if (!parsed.success) {
    throw V2ApiError.invalidRequest();
  }
  let expectedStreamUserId: string;
  try {
    expectedStreamUserId = deriveStreamUserId(parsed.data.userId);
  } catch {
    throw V2ApiError.invalidRequest();
  }
  if (parsed.data.streamUserId !== expectedStreamUserId) {
    throw V2ApiError.invalidRequest();
  }
  return parsed.data;
}

function toProfileResource(
  record: ProfileV2Record | null,
  expectedOwnerUserId: string,
): ProfileV2Resource {
  if (record === null || record.ownerUserId !== expectedOwnerUserId) {
    throw V2ApiError.capabilityUnavailable();
  }
  return Object.freeze({
    profile: Object.freeze({
      loopId: record.loopId,
      alias: record.alias,
      avatarRef: record.avatarRef,
      bio: record.bio,
      interests: Object.freeze([...record.interests]),
      profileStatus: record.profileStatus,
      activatedAt: record.activatedAt,
    }),
    version: record.version,
    updatedAt: record.updatedAt,
    contractVersion: v2ContractVersion,
  });
}

function toPrivacyResource(
  record: PrivacyV2Record | null,
  expectedOwnerUserId: string,
): PrivacyV2Resource {
  if (record === null) {
    return Object.freeze({
      privacy: defaultPrivacyV2Values,
      version: 0,
      updatedAt: null,
      contractVersion: v2ContractVersion,
    });
  }
  if (record.ownerUserId !== expectedOwnerUserId) {
    throw V2ApiError.capabilityUnavailable();
  }
  return Object.freeze({
    privacy: privacyV2RecordValues(record),
    version: record.version,
    updatedAt: record.updatedAt,
    contractVersion: v2ContractVersion,
  });
}

function mapFailure(error: unknown): never {
  if (error instanceof InvalidProfileV2RequestError) {
    throw V2ApiError.fromCode("VALIDATION_FAILED");
  }
  if (error instanceof ProfileV2VersionConflictError) {
    throw V2ApiError.versionConflict();
  }
  if (error instanceof ProfileV2IdempotencyConflictError) {
    throw V2ApiError.idempotencyConflict();
  }
  if (error instanceof ProfileV2RepositoryUnavailableError) {
    throw V2ApiError.capabilityUnavailable();
  }
  throw error;
}

export function createProfileV2Service(options: {
  readonly repository: ProfileV2Repository;
  readonly aliasPolicy: AliasPolicy;
}): ProfileV2Service {
  function assertAliasAllowed(alias: string | null): void {
    if (alias === null) {
      return;
    }
    const verdict = options.aliasPolicy.evaluate(alias);
    if (verdict.status === "reserved") {
      throw V2ApiError.fromCode("ALIAS_RESERVED");
    }
    if (verdict.status === "blocked") {
      throw V2ApiError.fromCode("ALIAS_BLOCKED");
    }
  }

  const avatars: AvatarPresetsResource = Object.freeze({
    avatars: avatarPresets,
    contractVersion: v2ContractVersion,
  });

  const service: ProfileV2Service = {
    async getProfile(input) {
      const principal = assertPrincipal(input.principal);
      try {
        return toProfileResource(
          await options.repository.getProfile(principal.userId),
          principal.userId,
        );
      } catch (error) {
        return mapFailure(error);
      }
    },

    async replaceProfile(input) {
      const principal = assertPrincipal(input.principal);
      try {
        const request = parseReplaceProfileV2Request(input.body);
        assertAliasAllowed(request.profile.alias);
        return toProfileResource(
          await options.repository.replaceProfile({
            ownerUserId: principal.userId,
            expectedVersion: request.expectedVersion,
            profile: request.profile,
          }),
          principal.userId,
        );
      } catch (error) {
        return mapFailure(error);
      }
    },

    async activateProfile(input) {
      const principal = assertPrincipal(input.principal);
      try {
        const activation = parseProfileV2ActivationValues(input.body);
        assertAliasAllowed(activation.alias);
        return toProfileResource(
          await options.repository.activateProfile({
            ownerUserId: principal.userId,
            idempotencyKey: input.metadata.idempotencyKey,
            requestSha256: profileActivationDigest(
              activation,
              input.metadata.contractVersion,
            ),
            requestId: input.requestId,
            profile: activation,
          }),
          principal.userId,
        );
      } catch (error) {
        return mapFailure(error);
      }
    },

    async getPrivacy(input) {
      const principal = assertPrincipal(input.principal);
      try {
        return toPrivacyResource(
          await options.repository.getPrivacy(principal.userId),
          principal.userId,
        );
      } catch (error) {
        return mapFailure(error);
      }
    },

    async replacePrivacy(input) {
      const principal = assertPrincipal(input.principal);
      try {
        const request = parseReplacePrivacyV2Request(input.body);
        return toPrivacyResource(
          await options.repository.replacePrivacy({
            ownerUserId: principal.userId,
            expectedVersion: request.expectedVersion,
            privacy: request.privacy,
          }),
          principal.userId,
        );
      } catch (error) {
        return mapFailure(error);
      }
    },

    listAvatarPresets() {
      return avatars;
    },
  };
  return Object.freeze(service);
}
