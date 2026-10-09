import { z } from "zod";

import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import {
  ProfileRepositoryUnavailableError,
  ProfileRepositoryVersionConflictError,
  type ProfileRecord,
  type ProfileRepository,
  type PrivacyRecord,
} from "../../database/profile-repository.js";
import { deriveStreamUserId } from "../identity/loop-identifiers.js";
import {
  defaultPrivacyValues,
  defaultProfileValues,
  parseProfileResource,
  parsePrivacyResource,
  parseReplacePrivacyRequest,
  parseReplaceProfileRequest,
  type ProfileResource,
  type PrivacyResource,
} from "./profile-contract.js";

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

export interface GetProfileInput {
  readonly principal: AuthenticatedLoopPrincipal;
}

export interface ReplaceProfileInput extends GetProfileInput {
  readonly body: unknown;
}

export interface ProfileService {
  getProfile(input: GetProfileInput): Promise<ProfileResource>;
  replaceProfile(input: ReplaceProfileInput): Promise<ProfileResource>;
  getPrivacy(input: GetProfileInput): Promise<PrivacyResource>;
  replacePrivacy(input: ReplaceProfileInput): Promise<PrivacyResource>;
}

export class InvalidProfileRequestError extends Error {
  readonly code = "invalid_profile_request";

  constructor() {
    super("The Profile request is invalid");
    this.name = "InvalidProfileRequestError";
  }
}

export class ProfileVersionConflictError extends Error {
  readonly code = "profile_version_conflict";

  constructor() {
    super("The Profile resource version conflicts");
    this.name = "ProfileVersionConflictError";
  }
}

function assertPrincipal(
  principal: AuthenticatedLoopPrincipal,
): AuthenticatedLoopPrincipal {
  const parsed = principalSchema.safeParse(principal);
  if (!parsed.success) {
    throw new InvalidProfileRequestError();
  }

  let expectedStreamUserId: string;
  try {
    expectedStreamUserId = deriveStreamUserId(parsed.data.userId);
  } catch {
    throw new InvalidProfileRequestError();
  }

  if (parsed.data.streamUserId !== expectedStreamUserId) {
    throw new InvalidProfileRequestError();
  }
  return parsed.data;
}

function toProfileResource(
  record: ProfileRecord | null,
  expectedOwnerUserId: string,
): ProfileResource {
  try {
    if (record !== null && record.ownerUserId !== expectedOwnerUserId) {
      throw new ProfileRepositoryUnavailableError();
    }
    return parseProfileResource(
      record === null
        ? {
            version: 0,
            profile: defaultProfileValues,
            updated_at: null,
          }
        : {
            version: record.version,
            profile: {
              alias: record.alias,
              avatar_ref: record.avatarRef,
            },
            updated_at: record.updatedAt,
          },
    );
  } catch {
    throw new ProfileRepositoryUnavailableError();
  }
}

function toPrivacyResource(
  record: PrivacyRecord | null,
  expectedOwnerUserId: string,
): PrivacyResource {
  try {
    if (record !== null && record.ownerUserId !== expectedOwnerUserId) {
      throw new ProfileRepositoryUnavailableError();
    }
    return parsePrivacyResource(
      record === null
        ? {
            version: 0,
            privacy: defaultPrivacyValues,
            updated_at: null,
          }
        : {
            version: record.version,
            privacy: {
              discoverable: record.discoverable,
              copy_trade_visibility: record.copyTradeVisibility,
            },
            updated_at: record.updatedAt,
          },
    );
  } catch {
    throw new ProfileRepositoryUnavailableError();
  }
}

function translateVersionConflict(error: unknown): never {
  if (error instanceof ProfileRepositoryVersionConflictError) {
    throw new ProfileVersionConflictError();
  }
  throw error;
}

export function createProfileService(
  repository: ProfileRepository,
): ProfileService {
  return Object.freeze({
    async getProfile(input: GetProfileInput): Promise<ProfileResource> {
      const principal = assertPrincipal(input.principal);
      return toProfileResource(
        await repository.getProfile(principal.userId),
        principal.userId,
      );
    },

    async replaceProfile(input: ReplaceProfileInput): Promise<ProfileResource> {
      const principal = assertPrincipal(input.principal);
      let request;
      try {
        request = parseReplaceProfileRequest(input.body);
      } catch {
        throw new InvalidProfileRequestError();
      }

      try {
        return toProfileResource(
          await repository.replaceProfile({
            ownerUserId: principal.userId,
            expectedVersion: request.expected_version,
            profile: request.profile,
          }),
          principal.userId,
        );
      } catch (error) {
        return translateVersionConflict(error);
      }
    },

    async getPrivacy(input: GetProfileInput): Promise<PrivacyResource> {
      const principal = assertPrincipal(input.principal);
      return toPrivacyResource(
        await repository.getPrivacy(principal.userId),
        principal.userId,
      );
    },

    async replacePrivacy(input: ReplaceProfileInput): Promise<PrivacyResource> {
      const principal = assertPrincipal(input.principal);
      let request;
      try {
        request = parseReplacePrivacyRequest(input.body);
      } catch {
        throw new InvalidProfileRequestError();
      }

      try {
        return toPrivacyResource(
          await repository.replacePrivacy({
            ownerUserId: principal.userId,
            expectedVersion: request.expected_version,
            privacy: request.privacy,
          }),
          principal.userId,
        );
      } catch (error) {
        return translateVersionConflict(error);
      }
    },
  });
}
