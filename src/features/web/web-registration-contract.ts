import { V2ApiError } from "../../core/http/v2-error.js";
import { v2ContractVersion } from "../meta/product-policy.js";

/**
 * Decision 0179: request metadata and reason codes of the web registration
 * surface `/v2/web/*`. A browser is not an App install: there is no device
 * ID, platform, client version, or LOOP device session. Writes carry exactly
 * one `X-Loop-Contract-Version: 2.0` and one lower-case UUIDv4
 * `Idempotency-Key`; reads carry nothing but (where needed) the Bearer.
 */

export const webReasonCodes = Object.freeze({
  sessionDisabled: "WEB_SESSION_DISABLED",
  repositoryUnavailable: "WEB_REPOSITORY_UNAVAILABLE",
  profileModuleDeferred: "V2_PROFILE_MODULE_DEFERRED",
  referralModuleDeferred: "V2_REFERRAL_MODULE_DEFERRED",
  rateLimited: "WEB_RATE_LIMITED",
  usernameInvalid: "WEB_USERNAME_INVALID",
  codeInvalid: "REFERRAL_CODE_INVALID",
  codeUnknown: "REFERRAL_CODE_UNKNOWN",
  claimWindowClosed: "REFERRAL_CLAIM_WINDOW_CLOSED",
  activationRequired: "PROFILE_ACTIVATION_REQUIRED",
  selfInvite: "REFERRAL_SELF_INVITE",
  cycle: "REFERRAL_CYCLE",
  alreadyBound: "REFERRAL_ALREADY_BOUND",
} as const);

export const webHeaderNames = Object.freeze({
  contractVersion: "x-loop-contract-version",
  idempotencyKey: "idempotency-key",
} as const);

const canonicalUuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const webWriteHeadersSchema = {
  type: "object",
  additionalProperties: true,
  required: [webHeaderNames.contractVersion, webHeaderNames.idempotencyKey],
  properties: {
    [webHeaderNames.contractVersion]: {
      type: "string",
      const: v2ContractVersion,
    },
    [webHeaderNames.idempotencyKey]: {
      type: "string",
      pattern:
        "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
      description: "Lower-case canonical UUIDv4, new per user action.",
    },
  },
} as const;

export interface WebWriteMetadata {
  readonly contractVersion: typeof v2ContractVersion;
  readonly idempotencyKey: string;
}

function headerValues(
  rawHeaders: readonly string[],
  name: string,
): readonly string[] {
  if (rawHeaders.length % 2 !== 0) {
    throw V2ApiError.invalidRequest();
  }
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) {
      values.push(rawHeaders[index + 1] ?? "");
    }
  }
  return values;
}

/**
 * Missing or repeated contract version → 400; another version → 409
 * VERSION_CONFLICT (same as the App surface). The Idempotency-Key must be
 * exactly one lower-case canonical UUIDv4.
 */
export function parseWebWriteMetadata(
  rawHeaders: readonly string[],
): WebWriteMetadata {
  const versions = headerValues(rawHeaders, webHeaderNames.contractVersion);
  if (versions.length !== 1) {
    throw V2ApiError.invalidRequest();
  }
  if (versions[0] !== v2ContractVersion) {
    throw V2ApiError.versionConflict();
  }
  const keys = headerValues(rawHeaders, webHeaderNames.idempotencyKey);
  const idempotencyKey = keys[0];
  if (
    keys.length !== 1 ||
    idempotencyKey === undefined ||
    !canonicalUuidV4Pattern.test(idempotencyKey)
  ) {
    throw V2ApiError.invalidRequest();
  }
  return Object.freeze({ contractVersion: v2ContractVersion, idempotencyKey });
}

export interface WebInviteState {
  readonly bound: boolean;
  readonly windowEndsAt: string | null;
  readonly canClaim: boolean;
}

export interface WebSessionResource {
  readonly loopId: string;
  readonly username: string | null;
  readonly usernameRequired: boolean;
  readonly walletAddress: string | null;
  readonly invite: WebInviteState;
  readonly observedAt: string;
}

export interface WebUsernameResource {
  readonly username: string;
}

export interface WebClaimResource {
  readonly status: "bound" | "already_bound";
  readonly inviterLoopId?: string;
}

export interface WebInvitePreviewResource {
  readonly valid: boolean;
  readonly inviter: {
    readonly username: string | null;
    readonly loopId: string;
  } | null;
}

export interface WebMetaResource {
  readonly appStore: {
    readonly ios: string | null;
    readonly android: string | null;
    readonly testflight: string | null;
  };
  readonly observedAt: string;
}
