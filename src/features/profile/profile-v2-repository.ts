import type {
  PrivacyV2Values,
  ProfileInterest,
  ProfileStatus,
  ProfileV2ActivationValues,
  ProfileV2Values,
} from "./profile-v2-contract.js";

/**
 * V2 profile persistence boundary. Alias and avatar reference are shared with
 * the frozen V1 `user_profiles` columns and CAS `record_version`; V2 privacy
 * lives in the independent `privacy_preferences_v2` relation.
 */

export interface ProfileV2Record extends ProfileV2Values {
  readonly ownerUserId: string;
  readonly loopId: string;
  readonly profileStatus: ProfileStatus;
  readonly activatedAt: string | null;
  /** 0 when the owner has no `user_profiles` row yet. */
  readonly version: number;
  readonly updatedAt: string | null;
}

export interface PrivacyV2Record extends PrivacyV2Values {
  readonly ownerUserId: string;
  readonly version: number;
  readonly updatedAt: string;
}

export interface ReplaceProfileV2RecordInput {
  readonly ownerUserId: string;
  readonly expectedVersion: number;
  readonly profile: ProfileV2Values;
}

export interface ActivateProfileV2RecordInput {
  readonly ownerUserId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly requestId: string;
  readonly profile: ProfileV2ActivationValues;
}

export interface ReplacePrivacyV2RecordInput {
  readonly ownerUserId: string;
  readonly expectedVersion: number;
  readonly privacy: PrivacyV2Values;
}

export interface ProfileV2Repository {
  /** Null only when the owner account does not exist. */
  getProfile(ownerUserId: string): Promise<ProfileV2Record | null>;
  replaceProfile(input: ReplaceProfileV2RecordInput): Promise<ProfileV2Record>;
  activateProfile(
    input: ActivateProfileV2RecordInput,
  ): Promise<ProfileV2Record>;
  /** Null when no privacy row exists (version-0 fail-closed default). */
  getPrivacy(ownerUserId: string): Promise<PrivacyV2Record | null>;
  replacePrivacy(
    input: ReplacePrivacyV2RecordInput,
  ): Promise<PrivacyV2Record | null>;
}

export class ProfileV2RepositoryUnavailableError extends Error {
  readonly code = "profile_v2_repository_unavailable";

  constructor() {
    super("The V2 profile repository is unavailable");
    this.name = "ProfileV2RepositoryUnavailableError";
  }
}

export class ProfileV2VersionConflictError extends Error {
  readonly code = "profile_v2_version_conflict";

  constructor() {
    super("The stored V2 profile resource version conflicts");
    this.name = "ProfileV2VersionConflictError";
  }
}

export class ProfileV2IdempotencyConflictError extends Error {
  readonly code = "profile_v2_idempotency_conflict";

  constructor() {
    super("The profile activation idempotency key conflicts");
    this.name = "ProfileV2IdempotencyConflictError";
  }
}

export function createUnavailableProfileV2Repository(): ProfileV2Repository {
  const unavailable = (): Promise<never> =>
    Promise.reject(new ProfileV2RepositoryUnavailableError());
  return Object.freeze({
    getProfile: unavailable,
    replaceProfile: unavailable,
    activateProfile: unavailable,
    getPrivacy: unavailable,
    replacePrivacy: unavailable,
  });
}

export function profileV2RecordValues(
  record: ProfileV2Record,
): ProfileV2Values {
  return Object.freeze({
    alias: record.alias,
    avatarRef: record.avatarRef,
    bio: record.bio,
    interests: Object.freeze([...record.interests] as ProfileInterest[]),
  });
}

export function privacyV2RecordValues(
  record: PrivacyV2Record,
): PrivacyV2Values {
  return Object.freeze({
    discoverable: record.discoverable,
    anonymousMode: record.anonymousMode,
    visibility: Object.freeze({ ...record.visibility }),
  });
}
