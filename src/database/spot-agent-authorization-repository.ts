import { createHash, timingSafeEqual } from "node:crypto";

import type { Pool, PoolClient, QueryResult } from "pg";
import { z } from "zod";

import {
  parseSpotAgentAuthorizationCreationResource,
  parseSpotAgentAuthorizationResource,
  type SpotAgentAuthorizationCreationResource,
  type SpotAgentAuthorizationResource,
} from "../features/spot/spot-agent-authorization-contract.js";

export const SPOT_AGENT_AUTHORIZATION_IDEMPOTENCY_SCOPE =
  "spot_agent_authorization_issue";
export const SPOT_AGENT_AUTHORIZATION_REQUEST_DIGEST_VERSION =
  "spot_agent_authorization_issue_v1";
export const SPOT_AGENT_AUTHORIZATION_REVIEW_VERSION =
  "spot_agent_authorization_review_v1";
export const SPOT_AGENT_AUTHORIZATION_AUTHORITY_LEASE_MILLISECONDS = 15_000;
export const SPOT_AGENT_AUTHORIZATION_BASE_NAME_MAX_CHARACTERS = 16;
export const SPOT_AGENT_AUTHORIZATION_MAX_AGENT_LIFETIME_MILLISECONDS = 86_400_000;
export const SPOT_AGENT_AUTHORIZATION_POLICY_VERSION = "spot_agent_v1";
export const SPOT_AGENT_AUTHORIZATION_SIGNING_TTL_MILLISECONDS = 300_000;
export const SPOT_AGENT_AUTHORIZATION_EXPIRY_SWEEP_MAX_ITEMS = 100;
export const SPOT_AGENT_AUTHORIZATION_EXPIRY_SWEEP_LOCK_TIMEOUT_MILLISECONDS = 50;
export const HYPERLIQUID_SIGNER_NONCE_FUTURE_WINDOW_MILLISECONDS = 86_400_000;

const requestDigestDomain = "loop.spot.agent-authorization.issue.v1\0";
const reviewDigestDomain = "loop.spot.agent-authorization.review.v1\0";
const issueLockDomain = "loop.spot.agent-authorization.issue-lock.v1";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const lowercaseAddressPattern = /^0x[0-9a-f]{40}$/;
const zeroAddress = `0x${"0".repeat(40)}`;
const sha256Pattern = /^[0-9a-f]{64}$/;
const signingDigestPattern = /^0x[0-9a-f]{64}$/;
const bindingVersionPattern = /^[1-9][0-9]{0,18}$/;
const maximumBindingVersion = 9_223_372_036_854_775_807n;
const uint64Pattern = /^(?:0|[1-9][0-9]{0,19})$/;
const maximumUint64 = 18_446_744_073_709_551_615n;
const safeReasonCodePattern = /^[a-z][a-z0-9_]{0,63}$/;

const uuidSchema = z.string().regex(uuidPattern);
const privyUserIdSchema = z.string().min(1).max(255);
const sha256Schema = z.string().regex(sha256Pattern);
const signingDigestSchema = z.string().regex(signingDigestPattern);
const validDateSchema = z
  .instanceof(Date)
  .refine((value) => !Number.isNaN(value.getTime()));
const rfc3339Schema = z.string().max(64).datetime({ offset: true });
const addressSchema = z
  .string()
  .regex(lowercaseAddressPattern)
  .refine((value) => value !== zeroAddress);
const bindingVersionSchema = z
  .string()
  .regex(bindingVersionPattern)
  .refine((value) => {
    try {
      return BigInt(value) <= maximumBindingVersion;
    } catch {
      return false;
    }
  });
const agentGenerationSchema = bindingVersionSchema;
const recordVersionSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,18})$/)
  .refine((value) => {
    try {
      return BigInt(value) <= maximumBindingVersion;
    } catch {
      return false;
    }
  });
const nonceSchema = z
  .string()
  .regex(uint64Pattern)
  .refine((value) => {
    try {
      return BigInt(value) <= maximumUint64;
    } catch {
      return false;
    }
  });
const agentNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/)
  .refine((value) => value === value.trim());
const signerRefSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value === value.trim())
  .refine((value) =>
    [...value].every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint > 31 && codePoint !== 127;
    }),
  );
const walletIdSchema = signerRefSchema;

const preflightInputSchema = z
  .object({
    ownerUserId: uuidSchema,
    privyUserId: privyUserIdSchema,
    requestId: uuidSchema,
    walletId: walletIdSchema,
    accountAddress: addressSchema,
    accountKind: z.literal("master"),
    bindingVersion: bindingVersionSchema,
    verifiedAt: rfc3339Schema,
    expiresAt: rfc3339Schema,
    policyVersion: z.literal(SPOT_AGENT_AUTHORIZATION_POLICY_VERSION),
  })
  .strict();

const issueInputSchema = preflightInputSchema
  .extend({
    authorizationId: uuidSchema,
    agentIdentityId: uuidSchema,
    agentGeneration: agentGenerationSchema,
    agentAddress: addressSchema,
    agentName: agentNameSchema,
    signerRef: signerRefSchema,
    agentValidUntil: rfc3339Schema,
    signingExpiresAt: rfc3339Schema,
  })
  .strict()
  .refine((input) => input.accountAddress !== input.agentAddress);

const materializedIssueSchema = z
  .object({
    typedData: z.unknown(),
    signingDigest: signingDigestSchema,
  })
  .strict();

const expireElapsedPreparedInputSchema = z
  .object({
    requestId: uuidSchema,
    limit: z
      .number()
      .int()
      .min(1)
      .max(SPOT_AGENT_AUTHORIZATION_EXPIRY_SWEEP_MAX_ITEMS),
  })
  .strict();

const publicReviewSchema = z
  .object({
    version: z.literal(SPOT_AGENT_AUTHORIZATION_REVIEW_VERSION),
    provider: z.literal("hyperliquid"),
    network: z.literal("testnet"),
    action: z.literal("approve_agent"),
    account: z
      .object({ address: addressSchema, kind: z.literal("master") })
      .strict(),
    binding_epoch: bindingVersionSchema,
    agent: z
      .object({
        address: addressSchema,
        name: agentNameSchema,
        valid_until: rfc3339Schema,
      })
      .strict(),
    nonce: nonceSchema,
    policy_version: z.literal(SPOT_AGENT_AUTHORIZATION_POLICY_VERSION),
  })
  .strict();

const storedAuthorizationStateSchema = z.enum([
  "prepared",
  "submitting",
  "accepted",
  "active",
  "rejected",
  "failed",
  "unknown",
  "reconciling",
  "operator_required",
  "expired",
]);

const authorizationRowSchema = z
  .object({
    id: uuidSchema,
    owner_user_id: uuidSchema,
    request_sha256: sha256Schema,
    request_digest_version: z.literal(
      SPOT_AGENT_AUTHORIZATION_REQUEST_DIGEST_VERSION,
    ),
    agent_identity_id: uuidSchema,
    agent_generation: agentGenerationSchema,
    network: z.literal("testnet"),
    action: z.literal("approve_agent"),
    account_address: addressSchema,
    account_kind: z.literal("master"),
    binding_version: bindingVersionSchema,
    signer_wallet_address: addressSchema,
    agent_address: addressSchema,
    agent_name: agentNameSchema,
    signer_ref: signerRefSchema,
    authorization_nonce: nonceSchema,
    agent_valid_until: validDateSchema,
    public_review: z.unknown(),
    review_sha256: sha256Schema,
    typed_data_primary_type: z.literal("HyperliquidTransaction:ApproveAgent"),
    signing_digest: signingDigestSchema,
    typed_data_json_sha256: sha256Schema,
    signing_expires_at: validDateSchema,
    stored_state: storedAuthorizationStateSchema,
    effective_state: storedAuthorizationStateSchema,
    result_observed_at: validDateSchema.nullable(),
    result_reason_code: z.string().regex(safeReasonCodePattern).nullable(),
    record_version: recordVersionSchema,
    created_at: validDateSchema,
    updated_at: validDateSchema,
    identity_state: z.enum([
      "reserved",
      "authorization_pending",
      "active",
      "revoked",
      "retired",
      "operator_hold",
    ]),
    identity_version: recordVersionSchema,
    operation_domain: z.literal("hyperliquid"),
    operation_kind: z.literal("spot_agent_authorization"),
    idempotency_scope: z.literal(SPOT_AGENT_AUTHORIZATION_IDEMPOTENCY_SCOPE),
    idempotency_key: uuidSchema,
    idempotency_key_source: z.literal("server"),
    idempotency_digest_version: z.literal(
      SPOT_AGENT_AUTHORIZATION_REQUEST_DIGEST_VERSION,
    ),
  })
  .strict();

const identityRowSchema = z
  .object({
    id: uuidSchema,
    owner_user_id: uuidSchema,
    network: z.literal("testnet"),
    binding_version: bindingVersionSchema,
    agent_generation: agentGenerationSchema,
    agent_address: addressSchema,
    agent_name: agentNameSchema,
    signer_ref: signerRefSchema,
    lifecycle_state: z.enum([
      "reserved",
      "authorization_pending",
      "active",
      "revoked",
      "retired",
      "operator_hold",
    ]),
    record_version: recordVersionSchema,
  })
  .strict();

const ownerRowSchema = z
  .object({
    id: uuidSchema,
    privy_user_id: privyUserIdSchema,
  })
  .strict();

const walletBindingRowSchema = z
  .object({
    privy_user_id: privyUserIdSchema,
    binding_state: z.literal("bound"),
    wallet_id: walletIdSchema,
    account_address: addressSchema,
    account_kind: z.literal("master"),
    binding_version: bindingVersionSchema,
    lease_is_current: z.literal(true),
    lease_is_bounded: z.literal(true),
  })
  .strict();

const authorizationReturningColumns = `
  agent_auth.id,
  agent_auth.owner_user_id,
  agent_auth.request_sha256,
  agent_auth.request_digest_version,
  agent_auth.agent_identity_id,
  identity.agent_generation::text as agent_generation,
  agent_auth.network,
  agent_auth.action,
  agent_auth.account_address,
  agent_auth.account_kind,
  agent_auth.binding_version::text as binding_version,
  agent_auth.signer_wallet_address,
  agent_auth.agent_address,
  agent_auth.agent_name,
  identity.signer_ref,
  agent_auth.authorization_nonce::text as authorization_nonce,
  agent_auth.agent_valid_until,
  agent_auth.public_review,
  agent_auth.review_sha256,
  agent_auth.typed_data_primary_type,
  agent_auth.signing_digest,
  agent_auth.typed_data_json_sha256,
  agent_auth.signing_expires_at,
  agent_auth.state as stored_state,
  case
    when agent_auth.state = 'prepared'
      and agent_auth.signing_expires_at <= clock_timestamp()
    then 'expired'
    else agent_auth.state
  end as effective_state,
  agent_auth.result_observed_at,
  agent_auth.result_reason_code,
  agent_auth.record_version::text as record_version,
  agent_auth.created_at,
  agent_auth.updated_at,
  identity.lifecycle_state as identity_state,
  identity.record_version::text as identity_version,
  operation.domain as operation_domain,
  operation.operation_kind as operation_kind,
  idempotency.scope as idempotency_scope,
  idempotency.idempotency_key::text as idempotency_key,
  idempotency.key_source as idempotency_key_source,
  idempotency.digest_version as idempotency_digest_version
`;

export interface SpotAgentAuthorizationPublicReview {
  readonly version: typeof SPOT_AGENT_AUTHORIZATION_REVIEW_VERSION;
  readonly provider: "hyperliquid";
  readonly network: "testnet";
  readonly action: "approve_agent";
  readonly account: Readonly<{ address: string; kind: "master" }>;
  readonly binding_epoch: string;
  readonly agent: Readonly<{
    address: string;
    name: string;
    valid_until: string;
  }>;
  readonly nonce: string;
  readonly policy_version: typeof SPOT_AGENT_AUTHORIZATION_POLICY_VERSION;
}

export interface SpotAgentAuthorizationRecord {
  readonly id: string;
  readonly ownerUserId: string;
  readonly requestSha256: string;
  readonly agentIdentityId: string;
  readonly agentGeneration: string;
  readonly accountAddress: string;
  readonly bindingVersion: string;
  readonly agentAddress: string;
  readonly agentName: string;
  readonly signerRef: string;
  readonly authorizationNonce: string;
  readonly agentValidUntil: string;
  readonly publicReview: SpotAgentAuthorizationPublicReview;
  readonly reviewSha256: string;
  readonly typedDataPrimaryType: "HyperliquidTransaction:ApproveAgent";
  readonly signingDigest: string;
  readonly typedDataJsonSha256: string;
  readonly signingExpiresAt: string;
  readonly storedState:
    | "prepared"
    | "submitting"
    | "accepted"
    | "active"
    | "rejected"
    | "failed"
    | "unknown"
    | "reconciling"
    | "operator_required"
    | "expired";
  readonly recordVersion: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resource: SpotAgentAuthorizationResource;
}

export interface IssueSpotAgentAuthorizationInput {
  readonly authorizationId: string;
  readonly agentIdentityId: string;
  readonly agentGeneration: string;
  readonly ownerUserId: string;
  readonly privyUserId: string;
  readonly requestId: string;
  readonly walletId: string;
  readonly accountAddress: string;
  readonly accountKind: "master";
  readonly bindingVersion: string;
  readonly verifiedAt: string;
  readonly expiresAt: string;
  readonly agentAddress: string;
  readonly agentName: string;
  readonly signerRef: string;
  readonly agentValidUntil: string;
  readonly signingExpiresAt: string;
  readonly policyVersion: typeof SPOT_AGENT_AUTHORIZATION_POLICY_VERSION;
}

export interface PreflightSpotAgentAuthorizationInput {
  readonly ownerUserId: string;
  readonly privyUserId: string;
  readonly requestId: string;
  readonly walletId: string;
  readonly accountAddress: string;
  readonly accountKind: "master";
  readonly bindingVersion: string;
  readonly verifiedAt: string;
  readonly expiresAt: string;
  readonly policyVersion: typeof SPOT_AGENT_AUTHORIZATION_POLICY_VERSION;
}

export interface SpotAgentAuthorizationMaterializationContext {
  readonly authorizationId: string;
  readonly ownerUserId: string;
  readonly network: "testnet";
  readonly action: "approve_agent";
  readonly accountAddress: string;
  readonly bindingVersion: string;
  readonly agentIdentityId: string;
  readonly agentGeneration: string;
  readonly agentAddress: string;
  readonly agentName: string;
  readonly authorizationNonce: string;
  readonly agentValidUntil: string;
  readonly signingExpiresAt: string;
  readonly policyVersion: typeof SPOT_AGENT_AUTHORIZATION_POLICY_VERSION;
}

export interface MaterializedSpotAgentAuthorizationIssue {
  /** Exact public approveAgent typed data. The repository validates it. */
  readonly typedData: unknown;
  readonly signingDigest: string;
}

/**
 * This callback must be synchronous, deterministic, and side-effect free. It
 * must never call Privy, Hyperliquid, another provider, or a remote signer.
 */
export type MaterializeSpotAgentAuthorizationForNonce = (
  context: SpotAgentAuthorizationMaterializationContext,
) => MaterializedSpotAgentAuthorizationIssue;

/** This callback must be synchronous, deterministic, and side-effect free. */
export type ComputeSpotAgentAuthorizationSigningDigest = (
  typedData: SpotAgentAuthorizationCreationResource["signable_payload"]["typed_data"],
) => string;

export type IssueSpotAgentAuthorizationResult =
  | Readonly<{
      kind: "issued";
      created: true;
      authorization: SpotAgentAuthorizationRecord;
      signablePayload: SpotAgentAuthorizationCreationResource["signable_payload"];
    }>
  | Readonly<{
      kind: "replayed";
      created: false;
      authorization: SpotAgentAuthorizationRecord;
      signablePayload: SpotAgentAuthorizationCreationResource["signable_payload"];
    }>
  | Readonly<{
      kind: "expired";
      created: false;
      authorization: SpotAgentAuthorizationRecord;
      signablePayload: null;
    }>;

export type PreflightSpotAgentAuthorizationResult =
  | Extract<IssueSpotAgentAuthorizationResult, { kind: "replayed" | "expired" }>
  | Readonly<{
      kind: "issue_required";
      created: false;
      agentGeneration: string;
      authorization: null;
      signablePayload: null;
    }>;

export interface SpotAgentAuthorizationRepository {
  preflightCurrent(
    input: PreflightSpotAgentAuthorizationInput,
    materializeForNonce: MaterializeSpotAgentAuthorizationForNonce,
    computeSigningDigest: ComputeSpotAgentAuthorizationSigningDigest,
  ): Promise<PreflightSpotAgentAuthorizationResult>;
  issueOrReplayCurrent(
    input: IssueSpotAgentAuthorizationInput,
    materializeForNonce: MaterializeSpotAgentAuthorizationForNonce,
    computeSigningDigest: ComputeSpotAgentAuthorizationSigningDigest,
  ): Promise<IssueSpotAgentAuthorizationResult>;
  expireElapsedPrepared(input: {
    readonly requestId: string;
    readonly limit: number;
  }): Promise<Readonly<{ expiredCount: number }>>;
  retireElapsedAgentIdentities(input: {
    readonly requestId: string;
    readonly limit: number;
  }): Promise<Readonly<{ retiredCount: number }>>;
  findOwned(
    ownerUserId: string,
    authorizationId: string,
  ): Promise<SpotAgentAuthorizationRecord | null>;
}

export class SpotAgentAuthorizationPrepareExpiredError extends Error {
  readonly code = "spot_agent_authorization_expired";

  constructor() {
    super("The Spot Agent authorization signing handoff is already expired");
    this.name = "SpotAgentAuthorizationPrepareExpiredError";
  }
}

export class SpotAgentAuthorizationAuthorityStaleError extends Error {
  readonly code = "spot_agent_authorization_authority_stale";

  constructor() {
    super("The Spot wallet binding or Agent epoch changed");
    this.name = "SpotAgentAuthorizationAuthorityStaleError";
  }
}

export class SpotAgentAuthorizationNonceUnavailableError extends Error {
  readonly code = "spot_agent_authorization_nonce_unavailable";

  constructor() {
    super("A safe Hyperliquid authorization nonce is unavailable");
    this.name = "SpotAgentAuthorizationNonceUnavailableError";
  }
}

export class SpotAgentAuthorizationRepositoryUnavailableError extends Error {
  readonly code = "spot_agent_authorization_unavailable";

  constructor() {
    super("The Spot Agent authorization repository is unavailable");
    this.name = "SpotAgentAuthorizationRepositoryUnavailableError";
  }
}

function unavailable(): Promise<never> {
  return Promise.reject(new SpotAgentAuthorizationRepositoryUnavailableError());
}

export function createUnavailableSpotAgentAuthorizationRepository(): SpotAgentAuthorizationRepository {
  return Object.freeze({
    preflightCurrent: unavailable,
    issueOrReplayCurrent: unavailable,
    expireElapsedPrepared: unavailable,
    retireElapsedAgentIdentities: unavailable,
    findOwned: unavailable,
  });
}

interface ParsedIssueInput extends IssueSpotAgentAuthorizationInput {
  readonly agentValidUntil: string;
  readonly signingExpiresAt: string;
  readonly verifiedAt: string;
  readonly expiresAt: string;
}

interface ParsedPreflightInput extends PreflightSpotAgentAuthorizationInput {
  readonly verifiedAt: string;
  readonly expiresAt: string;
}

interface AuthorityDigestSnapshot {
  readonly privyUserId: string;
  readonly walletId: string;
}

interface PreparedIssueBinding {
  readonly context: SpotAgentAuthorizationMaterializationContext;
  readonly publicReview: SpotAgentAuthorizationPublicReview;
  readonly reviewSha256: string;
  readonly typedDataPrimaryType: "HyperliquidTransaction:ApproveAgent";
  readonly signingDigest: string;
  readonly typedDataJsonSha256: string;
  readonly requestSha256: string;
  readonly signablePayload: SpotAgentAuthorizationCreationResource["signable_payload"];
}

interface DatabaseClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    config:
      string | { readonly text: string; readonly values?: readonly unknown[] },
  ): Promise<QueryResult<Row>>;
}

function failUnavailable(): never {
  throw new SpotAgentAuthorizationRepositoryUnavailableError();
}

function assertCanonicalAgentExpiryBinding(
  agentName: string,
  agentValidUntil: string,
): void {
  const validUntilMilliseconds = Date.parse(agentValidUntil);
  if (!Number.isSafeInteger(validUntilMilliseconds)) {
    return failUnavailable();
  }
  const suffix = ` valid_until ${validUntilMilliseconds}`;
  if (!agentName.endsWith(suffix)) {
    return failUnavailable();
  }
  const baseName = agentName.slice(0, -suffix.length);
  if (
    baseName.length === 0 ||
    baseName.length > SPOT_AGENT_AUTHORIZATION_BASE_NAME_MAX_CHARACTERS ||
    baseName !== baseName.trim() ||
    baseName.includes(" valid_until ")
  ) {
    return failUnavailable();
  }
}

function parseIssueInput(
  rawInput: IssueSpotAgentAuthorizationInput,
): ParsedIssueInput {
  try {
    const input = issueInputSchema.parse(rawInput);
    const parsed = Object.freeze({
      ...input,
      verifiedAt: new Date(input.verifiedAt).toISOString(),
      expiresAt: new Date(input.expiresAt).toISOString(),
      agentValidUntil: new Date(input.agentValidUntil).toISOString(),
      signingExpiresAt: new Date(input.signingExpiresAt).toISOString(),
    });
    assertCanonicalAgentExpiryBinding(parsed.agentName, parsed.agentValidUntil);
    return parsed;
  } catch {
    return failUnavailable();
  }
}

function parsePreflightInput(
  rawInput: PreflightSpotAgentAuthorizationInput,
): ParsedPreflightInput {
  try {
    const input = preflightInputSchema.parse(rawInput);
    return Object.freeze({
      ...input,
      verifiedAt: new Date(input.verifiedAt).toISOString(),
      expiresAt: new Date(input.expiresAt).toISOString(),
    });
  } catch {
    return failUnavailable();
  }
}

function buildReview(
  context: SpotAgentAuthorizationMaterializationContext,
): SpotAgentAuthorizationPublicReview {
  const review = {
    version: SPOT_AGENT_AUTHORIZATION_REVIEW_VERSION,
    provider: "hyperliquid",
    network: "testnet",
    action: "approve_agent",
    account: { address: context.accountAddress, kind: "master" },
    binding_epoch: context.bindingVersion,
    agent: {
      address: context.agentAddress,
      name: context.agentName,
      valid_until: context.agentValidUntil,
    },
    nonce: context.authorizationNonce,
    policy_version: context.policyVersion,
  } as const;
  return publicReviewSchema.parse(review);
}

function digestReview(review: SpotAgentAuthorizationPublicReview): string {
  return createHash("sha256")
    .update(reviewDigestDomain, "utf8")
    .update(JSON.stringify(review), "utf8")
    .digest("hex");
}

function digestIssue(
  context: SpotAgentAuthorizationMaterializationContext,
  signerRef: string,
  authority: AuthorityDigestSnapshot,
  reviewSha256: string,
  typedDataPrimaryType: string,
  signingDigest: string,
  typedDataJsonSha256: string,
): string {
  return createHash("sha256")
    .update(requestDigestDomain, "utf8")
    .update(
      JSON.stringify([
        SPOT_AGENT_AUTHORIZATION_REQUEST_DIGEST_VERSION,
        context.authorizationId,
        context.agentIdentityId,
        context.ownerUserId,
        context.network,
        context.action,
        context.accountAddress,
        context.bindingVersion,
        context.agentAddress,
        context.agentName,
        signerRef,
        authority.privyUserId,
        authority.walletId,
        context.authorizationNonce,
        context.agentValidUntil,
        context.signingExpiresAt,
        context.policyVersion,
        reviewSha256,
        typedDataPrimaryType,
        signingDigest,
        typedDataJsonSha256,
      ]),
      "utf8",
    )
    .digest("hex");
}

function materializeIssue(
  context: SpotAgentAuthorizationMaterializationContext,
  signerRef: string,
  authority: AuthorityDigestSnapshot,
  materializeForNonce: MaterializeSpotAgentAuthorizationForNonce,
  computeSigningDigest: ComputeSpotAgentAuthorizationSigningDigest,
): PreparedIssueBinding {
  try {
    assertCanonicalAgentExpiryBinding(
      context.agentName,
      context.agentValidUntil,
    );
    if (typeof materializeForNonce !== "function") {
      return failUnavailable();
    }
    const materialized = materializedIssueSchema.parse(
      materializeForNonce(Object.freeze({ ...context })),
    );
    const validationTimestamp = new Date(
      Date.parse(context.signingExpiresAt) - 1,
    ).toISOString();
    const creation = parseSpotAgentAuthorizationCreationResource({
      authorization_id: context.authorizationId,
      state: "prepared",
      binding_epoch: context.bindingVersion,
      signing_state: "required",
      protocol_scope_warning:
        "hyperliquid_agent_authorization_is_protocol_broad",
      expires_at: context.signingExpiresAt,
      result: null,
      created_at: validationTimestamp,
      updated_at: validationTimestamp,
      signable_payload: {
        format: "privy_eip712_json_v1",
        agent_address: context.agentAddress,
        agent_name: context.agentName,
        nonce: context.authorizationNonce,
        domain: {
          name: "HyperliquidSignTransaction",
          version: "1",
          chain_id: 421_614,
          verifying_contract: zeroAddress,
        },
        typed_data: materialized.typedData,
        expires_at: context.signingExpiresAt,
      },
    });
    const publicReview = buildReview(context);
    const reviewSha256 = digestReview(publicReview);
    const typedDataJson = JSON.stringify(creation.signable_payload.typed_data);
    if (typedDataJson.length > 32_768) {
      return failUnavailable();
    }
    const typedDataJsonSha256 = createHash("sha256")
      .update(typedDataJson, "utf8")
      .digest("hex");
    if (typeof computeSigningDigest !== "function") {
      return failUnavailable();
    }
    const computedSigningDigest = signingDigestSchema.parse(
      computeSigningDigest(creation.signable_payload.typed_data),
    );
    if (
      !timingSafeEqual(
        Buffer.from(materialized.signingDigest.slice(2), "hex"),
        Buffer.from(computedSigningDigest.slice(2), "hex"),
      )
    ) {
      return failUnavailable();
    }
    return Object.freeze({
      context,
      publicReview,
      reviewSha256,
      typedDataPrimaryType: "HyperliquidTransaction:ApproveAgent",
      signingDigest: computedSigningDigest,
      typedDataJsonSha256,
      requestSha256: digestIssue(
        context,
        signerRef,
        authority,
        reviewSha256,
        "HyperliquidTransaction:ApproveAgent",
        computedSigningDigest,
        typedDataJsonSha256,
      ),
      signablePayload: creation.signable_payload,
    });
  } catch (error) {
    if (error instanceof SpotAgentAuthorizationRepositoryUnavailableError) {
      throw error;
    }
    return failUnavailable();
  }
}

function resourceResult(
  state: SpotAgentAuthorizationRecord["storedState"] | "expired",
  observedAt: Date | null,
  reasonCode: string | null,
): SpotAgentAuthorizationResource["result"] {
  if (state === "prepared" || state === "submitting" || state === "expired") {
    if (state !== "expired" && (observedAt !== null || reasonCode !== null)) {
      return failUnavailable();
    }
    return null;
  }
  if (observedAt === null) {
    return failUnavailable();
  }
  const resultState = state === "reconciling" ? "unknown" : state;
  return {
    state: resultState,
    observed_at: observedAt.toISOString(),
    reason_code: reasonCode,
  };
}

function toAuthorizationRecord(value: unknown): SpotAgentAuthorizationRecord {
  try {
    const row = authorizationRowSchema.parse(value);
    const publicReview = publicReviewSchema.parse(row.public_review);
    const reviewSha256 = digestReview(publicReview);
    assertCanonicalAgentExpiryBinding(
      row.agent_name,
      row.agent_valid_until.toISOString(),
    );
    if (
      row.signer_wallet_address !== row.account_address ||
      row.agent_address === row.account_address ||
      row.idempotency_key !== row.id ||
      row.review_sha256 !== reviewSha256 ||
      publicReview.account.address !== row.account_address ||
      publicReview.binding_epoch !== row.binding_version ||
      publicReview.agent.address !== row.agent_address ||
      publicReview.agent.name !== row.agent_name ||
      Date.parse(publicReview.agent.valid_until) !==
        row.agent_valid_until.getTime() ||
      publicReview.nonce !== row.authorization_nonce ||
      row.signing_expires_at.getTime() >= row.agent_valid_until.getTime() ||
      row.agent_valid_until.getTime() - row.created_at.getTime() >
        SPOT_AGENT_AUTHORIZATION_MAX_AGENT_LIFETIME_MILLISECONDS ||
      row.signing_expires_at.getTime() - row.created_at.getTime() >
        SPOT_AGENT_AUTHORIZATION_SIGNING_TTL_MILLISECONDS ||
      (row.effective_state !== row.stored_state &&
        !(row.stored_state === "prepared" && row.effective_state === "expired"))
    ) {
      return failUnavailable();
    }
    const result = resourceResult(
      row.effective_state,
      row.result_observed_at,
      row.result_reason_code,
    );
    const resource = parseSpotAgentAuthorizationResource({
      authorization_id: row.id,
      state: row.effective_state,
      binding_epoch: row.binding_version,
      signing_state:
        row.effective_state === "prepared"
          ? "required"
          : row.effective_state === "expired"
            ? "expired"
            : "consumed",
      protocol_scope_warning:
        "hyperliquid_agent_authorization_is_protocol_broad",
      expires_at: row.signing_expires_at.toISOString(),
      result,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    });
    return Object.freeze({
      id: row.id,
      ownerUserId: row.owner_user_id,
      requestSha256: row.request_sha256,
      agentIdentityId: row.agent_identity_id,
      agentGeneration: row.agent_generation,
      accountAddress: row.account_address,
      bindingVersion: row.binding_version,
      agentAddress: row.agent_address,
      agentName: row.agent_name,
      signerRef: row.signer_ref,
      authorizationNonce: row.authorization_nonce,
      agentValidUntil: row.agent_valid_until.toISOString(),
      publicReview,
      reviewSha256,
      typedDataPrimaryType: row.typed_data_primary_type,
      signingDigest: row.signing_digest,
      typedDataJsonSha256: row.typed_data_json_sha256,
      signingExpiresAt: row.signing_expires_at.toISOString(),
      storedState: row.stored_state,
      recordVersion: row.record_version,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      resource,
    });
  } catch (error) {
    if (error instanceof SpotAgentAuthorizationRepositoryUnavailableError) {
      throw error;
    }
    return failUnavailable();
  }
}

async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
  validateBeforeCommit?: (client: PoolClient, result: T) => Promise<void>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await operation(client);
    await client.query("set constraints all immediate");
    await validateBeforeCommit?.(client, result);
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      throw new SpotAgentAuthorizationRepositoryUnavailableError();
    }
    throw error;
  } finally {
    client.release();
  }
}

async function assertAuthorityLeaseStillCurrent(
  client: DatabaseClient,
  input: ParsedPreflightInput,
): Promise<void> {
  const result = await client.query<{
    lease_is_bounded: boolean;
    lease_is_current: boolean;
  }>({
    text: `
      with database_clock as (
        select clock_timestamp() as observed_at
      )
      select
        $1::timestamptz <= database_clock.observed_at
          and database_clock.observed_at < $2::timestamptz
          as lease_is_current,
        $2::timestamptz > $1::timestamptz
          and $2::timestamptz <= $1::timestamptz
            + ($3::bigint * interval '1 millisecond')
          as lease_is_bounded
      from database_clock
    `,
    values: [
      input.verifiedAt,
      input.expiresAt,
      SPOT_AGENT_AUTHORIZATION_AUTHORITY_LEASE_MILLISECONDS,
    ],
  });
  const row = result.rows[0];
  if (row?.lease_is_current !== true || row.lease_is_bounded !== true) {
    throw new SpotAgentAuthorizationAuthorityStaleError();
  }
}

async function readOwnedAuthorization(
  client: DatabaseClient,
  ownerUserId: string,
  authorizationId: string,
  lock = false,
): Promise<SpotAgentAuthorizationRecord | null> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select ${authorizationReturningColumns}
      from public.spot_agent_authorizations as agent_auth
      join public.spot_agent_identities as identity
        on identity.id = agent_auth.agent_identity_id
       and identity.owner_user_id = agent_auth.owner_user_id
      join public.provider_operations as operation
        on operation.id = agent_auth.id
       and operation.owner_user_id = agent_auth.owner_user_id
       and operation.request_sha256 = agent_auth.request_sha256
      join public.idempotency_records as idempotency
        on idempotency.id = operation.idempotency_record_id
       and idempotency.owner_user_id = operation.owner_user_id
       and idempotency.request_sha256 = operation.request_sha256
      where agent_auth.owner_user_id = $1 and agent_auth.id = $2
      limit 1
      ${lock ? "for update of agent_auth, identity" : ""}
    `,
    values: [ownerUserId, authorizationId],
  });
  const row = result.rows[0];
  return row === undefined ? null : toAuthorizationRecord(row);
}

async function lockCurrentWalletBinding(
  client: DatabaseClient,
  input: ParsedPreflightInput,
): Promise<void> {
  const ownerResult = await client.query<Record<string, unknown>>({
    text: `
      select id, privy_user_id
      from public.loop_users
      where id = $1
      limit 1
      for update
    `,
    values: [input.ownerUserId],
  });
  const owner = ownerRowSchema.safeParse(ownerResult.rows[0]);
  if (
    !owner.success ||
    owner.data.id !== input.ownerUserId ||
    owner.data.privy_user_id !== input.privyUserId
  ) {
    throw new SpotAgentAuthorizationAuthorityStaleError();
  }

  const result = await client.query<Record<string, unknown>>({
    text: `
      with database_clock as (
        select clock_timestamp() as observed_at
      )
      select
        binding.privy_user_id,
        binding.binding_state,
        binding.wallet_id,
        binding.account_address,
        binding.account_kind,
        binding.binding_version::text as binding_version,
        $2::timestamptz <= database_clock.observed_at
          and database_clock.observed_at < $3::timestamptz
          as lease_is_current,
        $3::timestamptz > $2::timestamptz
          and $3::timestamptz <= $2::timestamptz
            + ($4::bigint * interval '1 millisecond')
          as lease_is_bounded
      from public.perp_wallet_bindings as binding
      cross join database_clock
      where binding.owner_user_id = $1
      limit 1
      for update of binding
    `,
    values: [
      input.ownerUserId,
      input.verifiedAt,
      input.expiresAt,
      SPOT_AGENT_AUTHORIZATION_AUTHORITY_LEASE_MILLISECONDS,
    ],
  });
  const binding = walletBindingRowSchema.safeParse(result.rows[0]);
  if (
    !binding.success ||
    binding.data.privy_user_id !== input.privyUserId ||
    binding.data.wallet_id !== input.walletId ||
    binding.data.account_address !== input.accountAddress ||
    binding.data.binding_version !== input.bindingVersion
  ) {
    throw new SpotAgentAuthorizationAuthorityStaleError();
  }
}

async function readCurrentIdentity(
  client: DatabaseClient,
  ownerUserId: string,
  bindingVersion: string,
): Promise<z.output<typeof identityRowSchema> | null> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select
        id,
        owner_user_id,
        network,
        binding_version::text as binding_version,
        agent_generation::text as agent_generation,
        agent_address,
        agent_name,
        signer_ref,
        lifecycle_state,
        record_version::text as record_version
      from public.spot_agent_identities
      where owner_user_id = $1
        and network = 'testnet'
        and binding_version = $2::bigint
        and lifecycle_state in (
          'reserved', 'authorization_pending', 'active', 'operator_hold'
        )
      limit 1
      for update
    `,
    values: [ownerUserId, bindingVersion],
  });
  const row = result.rows[0];
  return row === undefined ? null : identityRowSchema.parse(row);
}

async function readNextAgentGeneration(
  client: DatabaseClient,
  ownerUserId: string,
  bindingVersion: string,
): Promise<string> {
  const result = await client.query<{ agent_generation: string }>({
    text: `
      select (
        coalesce(max(agent_generation), 0)::numeric + 1
      )::text as agent_generation
      from public.spot_agent_identities
      where owner_user_id = $1
        and network = 'testnet'
        and binding_version = $2::bigint
    `,
    values: [ownerUserId, bindingVersion],
  });
  const generation = result.rows[0]?.agent_generation;
  if (
    generation === undefined ||
    !agentGenerationSchema.safeParse(generation).success
  ) {
    return failUnavailable();
  }
  return generation;
}

async function readLiveAuthorizationForIdentity(
  client: DatabaseClient,
  ownerUserId: string,
  agentIdentityId: string,
): Promise<SpotAgentAuthorizationRecord | null> {
  const result = await client.query<{ id: string }>({
    text: `
      select id
      from public.spot_agent_authorizations
      where owner_user_id = $1
        and agent_identity_id = $2
        and state in (
          'prepared', 'submitting', 'accepted', 'active', 'unknown',
          'reconciling', 'operator_required'
        )
      limit 1
      for update
    `,
    values: [ownerUserId, agentIdentityId],
  });
  const authorizationId = result.rows[0]?.id;
  return authorizationId === undefined
    ? null
    : readOwnedAuthorization(client, ownerUserId, authorizationId, true);
}

async function readLatestAuthorizationForIdentity(
  client: DatabaseClient,
  ownerUserId: string,
  agentIdentityId: string,
): Promise<SpotAgentAuthorizationRecord | null> {
  const result = await client.query<{ id: string }>({
    text: `
      select id
      from public.spot_agent_authorizations
      where owner_user_id = $1 and agent_identity_id = $2
      order by agent_valid_until desc, created_at desc, id desc
      limit 1
      for update
    `,
    values: [ownerUserId, agentIdentityId],
  });
  const authorizationId = result.rows[0]?.id;
  return authorizationId === undefined
    ? null
    : readOwnedAuthorization(client, ownerUserId, authorizationId);
}

async function hasAgentValidityElapsed(
  client: DatabaseClient,
  agentValidUntil: string,
): Promise<boolean> {
  const result = await client.query<{ elapsed: boolean }>({
    text: `
      select $1::timestamptz <= clock_timestamp() as elapsed
    `,
    values: [agentValidUntil],
  });
  return result.rows[0]?.elapsed === true;
}

async function persistAgentValidityRetirement(
  client: DatabaseClient,
  identity: z.output<typeof identityRowSchema>,
  authorization: SpotAgentAuthorizationRecord,
  requestId: string,
  actorType: "api" | "worker",
): Promise<void> {
  if (
    authorization.agentIdentityId !== identity.id ||
    authorization.ownerUserId !== identity.owner_user_id ||
    authorization.bindingVersion !== identity.binding_version ||
    authorization.agentGeneration !== identity.agent_generation ||
    authorization.agentAddress !== identity.agent_address ||
    authorization.agentName !== identity.agent_name ||
    !(await hasAgentValidityElapsed(client, authorization.agentValidUntil))
  ) {
    throw new SpotAgentAuthorizationAuthorityStaleError();
  }

  const retired = await client.query<{ record_version: string }>({
    text: `
      update public.spot_agent_identities as identity
      set
        lifecycle_state = 'retired',
        record_version = identity.record_version + 1,
        updated_at = clock_timestamp()
      where identity.id = $1
        and identity.owner_user_id = $2
        and identity.lifecycle_state = $3
        and identity.record_version = $4::bigint
      returning identity.record_version::text as record_version
    `,
    values: [
      identity.id,
      identity.owner_user_id,
      identity.lifecycle_state,
      identity.record_version,
    ],
  });
  const recordVersion = retired.rows[0]?.record_version;
  if (recordVersion === undefined) {
    throw new SpotAgentAuthorizationAuthorityStaleError();
  }
  await client.query({
    text: `
      insert into public.spot_agent_identity_events (
        agent_identity_id,
        owner_user_id,
        request_id,
        actor_type,
        event_type,
        from_state,
        to_state,
        outcome,
        reason_code,
        identity_version
      )
      values (
        $1, $2, $3, $4, 'agent_validity_elapsed', $5, 'retired',
        'retired', 'agent_validity_elapsed', $6::bigint
      )
    `,
    values: [
      identity.id,
      identity.owner_user_id,
      requestId,
      actorType,
      identity.lifecycle_state,
      recordVersion,
    ],
  });
}

async function persistElapsedPreparedAuthorizationExpiry(
  client: DatabaseClient,
  authorization: SpotAgentAuthorizationRecord,
  requestId: string,
  actorType: "api" | "worker",
): Promise<SpotAgentAuthorizationRecord> {
  const expired = await client.query<{
    id: string;
    record_version: string;
  }>({
    text: `
      with database_clock as (
        select clock_timestamp() as observed_at
      )
      update public.spot_agent_authorizations as agent_auth
      set
        state = 'expired',
        result_observed_at = database_clock.observed_at,
        result_reason_code = 'signing_expired',
        record_version = agent_auth.record_version + 1,
        updated_at = database_clock.observed_at
      from database_clock
      where agent_auth.id = $1
        and agent_auth.owner_user_id = $2
        and agent_auth.state = 'prepared'
        and agent_auth.signing_expires_at <= database_clock.observed_at
      returning
        agent_auth.id,
        agent_auth.record_version::text as record_version
    `,
    values: [authorization.id, authorization.ownerUserId],
  });
  const expiredRow = expired.rows[0];
  if (expiredRow === undefined) {
    throw new SpotAgentAuthorizationAuthorityStaleError();
  }
  await client.query({
    text: `
      insert into public.spot_agent_authorization_events (
        authorization_id,
        owner_user_id,
        request_id,
        actor_type,
        event_type,
        from_state,
        to_state,
        outcome,
        reason_code,
        authorization_version
      )
      values (
        $1, $2, $3, $4, 'authorization_expired', 'prepared', 'expired',
        'expired', 'signing_expired', $5
      )
    `,
    values: [
      authorization.id,
      authorization.ownerUserId,
      requestId,
      actorType,
      expiredRow.record_version,
    ],
  });

  const record = await readOwnedAuthorization(
    client,
    authorization.ownerUserId,
    authorization.id,
    true,
  );
  return record ?? failUnavailable();
}

async function persistElapsedPreparedExpiry(
  client: DatabaseClient,
  authorization: SpotAgentAuthorizationRecord,
  requestId: string,
  identityTargetState: "reserved" | "retired",
  actorType: "api" | "worker",
): Promise<SpotAgentAuthorizationRecord> {
  await persistElapsedPreparedAuthorizationExpiry(
    client,
    authorization,
    requestId,
    actorType,
  );

  const released = await client.query<{
    id: string;
    record_version: string;
  }>({
    text: `
      update public.spot_agent_identities as identity
      set
        lifecycle_state = $3,
        record_version = identity.record_version + 1,
        updated_at = clock_timestamp()
      where identity.id = $1
        and identity.owner_user_id = $2
        and identity.lifecycle_state = 'authorization_pending'
      returning identity.id, identity.record_version::text as record_version
    `,
    values: [
      authorization.agentIdentityId,
      authorization.ownerUserId,
      identityTargetState,
    ],
  });
  const releasedRow = released.rows[0];
  if (releasedRow === undefined) {
    throw new SpotAgentAuthorizationAuthorityStaleError();
  }
  await client.query({
    text: `
      insert into public.spot_agent_identity_events (
        agent_identity_id,
        owner_user_id,
        request_id,
        actor_type,
        event_type,
        from_state,
        to_state,
        outcome,
        reason_code,
        identity_version
      )
      values (
        $1, $2, $3, $4, 'authorization_handoff_expired',
        'authorization_pending', $5, $6,
        'signing_expired', $7
      )
    `,
    values: [
      authorization.agentIdentityId,
      authorization.ownerUserId,
      requestId,
      actorType,
      identityTargetState,
      identityTargetState === "reserved" ? "released" : "retired",
      releasedRow.record_version,
    ],
  });
  const record = await readOwnedAuthorization(
    client,
    authorization.ownerUserId,
    authorization.id,
    true,
  );
  return record ?? failUnavailable();
}

async function allocateAuthorizationNonce(
  client: DatabaseClient,
  signerAddress: string,
): Promise<string> {
  const result = await client.query<{ nonce: string }>({
    text: `
      with database_clock as (
        select
          clock_timestamp() as observed_at,
          floor(extract(epoch from clock_timestamp()) * 1000)::numeric
            as unix_milliseconds
      )
      insert into public.hyperliquid_signer_nonce_state (
        network,
        signer_address,
        signer_kind,
        last_allocated_nonce,
        created_at,
        updated_at
      )
      select
        'testnet',
        $1,
        'owner_wallet',
        database_clock.unix_milliseconds,
        database_clock.observed_at,
        database_clock.observed_at
      from database_clock
      on conflict (network, signer_address)
      do update set
        last_allocated_nonce = greatest(
          hyperliquid_signer_nonce_state.last_allocated_nonce + 1,
          excluded.last_allocated_nonce
        ),
        updated_at = greatest(
          hyperliquid_signer_nonce_state.updated_at,
          excluded.updated_at
        )
      where hyperliquid_signer_nonce_state.signer_kind = excluded.signer_kind
        and greatest(
          hyperliquid_signer_nonce_state.last_allocated_nonce + 1,
          excluded.last_allocated_nonce
        ) < excluded.last_allocated_nonce + $2::numeric
      returning last_allocated_nonce::text as nonce
    `,
    values: [
      signerAddress,
      HYPERLIQUID_SIGNER_NONCE_FUTURE_WINDOW_MILLISECONDS,
    ],
  });
  const nonce = result.rows[0]?.nonce;
  if (nonce === undefined || !nonceSchema.safeParse(nonce).success) {
    throw new SpotAgentAuthorizationNonceUnavailableError();
  }
  return nonce;
}

function contextFromRecord(
  record: SpotAgentAuthorizationRecord,
): SpotAgentAuthorizationMaterializationContext {
  return Object.freeze({
    authorizationId: record.id,
    ownerUserId: record.ownerUserId,
    network: "testnet",
    action: "approve_agent",
    accountAddress: record.accountAddress,
    bindingVersion: record.bindingVersion,
    agentIdentityId: record.agentIdentityId,
    agentGeneration: record.agentGeneration,
    agentAddress: record.agentAddress,
    agentName: record.agentName,
    authorizationNonce: record.authorizationNonce,
    agentValidUntil: record.agentValidUntil,
    signingExpiresAt: record.signingExpiresAt,
    policyVersion: record.publicReview.policy_version,
  });
}

function assertReplayMatches(
  record: SpotAgentAuthorizationRecord,
  input: ParsedPreflightInput,
  prepared: PreparedIssueBinding,
): void {
  if (
    record.ownerUserId !== input.ownerUserId ||
    record.accountAddress !== input.accountAddress ||
    record.bindingVersion !== input.bindingVersion ||
    record.requestSha256 !== prepared.requestSha256 ||
    record.reviewSha256 !== prepared.reviewSha256 ||
    record.signingDigest !== prepared.signingDigest ||
    record.typedDataJsonSha256 !== prepared.typedDataJsonSha256
  ) {
    failUnavailable();
  }
}

function authorityDigestSnapshot(
  input: ParsedPreflightInput,
): AuthorityDigestSnapshot {
  return Object.freeze({
    privyUserId: input.privyUserId,
    walletId: input.walletId,
  });
}

function validatedSignablePayload(
  record: SpotAgentAuthorizationRecord,
  prepared: PreparedIssueBinding,
): SpotAgentAuthorizationCreationResource["signable_payload"] {
  const creation = parseSpotAgentAuthorizationCreationResource({
    ...record.resource,
    signable_payload: prepared.signablePayload,
  });
  return creation.signable_payload;
}

async function insertNewIdentity(
  client: DatabaseClient,
  input: ParsedIssueInput,
): Promise<z.output<typeof identityRowSchema>> {
  const inserted = await client.query<Record<string, unknown>>({
    text: `
      insert into public.spot_agent_identities (
        id,
        owner_user_id,
        binding_version,
        agent_generation,
        agent_address,
        agent_name,
        signer_ref
      )
      values ($1, $2, $3::bigint, $4::bigint, $5, $6, $7)
      returning
        id,
        owner_user_id,
        network,
        binding_version::text as binding_version,
        agent_generation::text as agent_generation,
        agent_address,
        agent_name,
        signer_ref,
        lifecycle_state,
        record_version::text as record_version
    `,
    values: [
      input.agentIdentityId,
      input.ownerUserId,
      input.bindingVersion,
      input.agentGeneration,
      input.agentAddress,
      input.agentName,
      input.signerRef,
    ],
  });
  const identity = identityRowSchema.parse(inserted.rows[0]);
  await client.query({
    text: `
      insert into public.spot_agent_identity_events (
        agent_identity_id,
        owner_user_id,
        request_id,
        actor_type,
        event_type,
        from_state,
        to_state,
        outcome,
        identity_version
      )
      values (
        $1, $2, $3, 'api', 'identity_reserved', null, 'reserved',
        'reserved', 0
      )
    `,
    values: [identity.id, identity.owner_user_id, input.requestId],
  });
  return identity;
}

async function markIdentityAuthorizationPending(
  client: DatabaseClient,
  identity: z.output<typeof identityRowSchema>,
  requestId: string,
): Promise<void> {
  const updated = await client.query<{ record_version: string }>({
    text: `
      update public.spot_agent_identities
      set
        lifecycle_state = 'authorization_pending',
        record_version = record_version + 1,
        updated_at = clock_timestamp()
      where id = $1
        and owner_user_id = $2
        and lifecycle_state = 'reserved'
        and record_version = $3
      returning record_version::text as record_version
    `,
    values: [identity.id, identity.owner_user_id, identity.record_version],
  });
  const version = updated.rows[0]?.record_version;
  if (version === undefined) {
    throw new SpotAgentAuthorizationAuthorityStaleError();
  }
  await client.query({
    text: `
      insert into public.spot_agent_identity_events (
        agent_identity_id,
        owner_user_id,
        request_id,
        actor_type,
        event_type,
        from_state,
        to_state,
        outcome,
        identity_version
      )
      values (
        $1, $2, $3, 'api', 'authorization_prepared', 'reserved',
        'authorization_pending', 'pending', $4
      )
    `,
    values: [identity.id, identity.owner_user_id, requestId, version],
  });
}

async function persistIssuedRows(
  client: DatabaseClient,
  input: ParsedIssueInput,
  identity: z.output<typeof identityRowSchema>,
  prepared: PreparedIssueBinding,
): Promise<SpotAgentAuthorizationRecord> {
  const idempotency = await client.query<{ id: string }>({
    text: `
      insert into public.idempotency_records (
        owner_user_id,
        scope,
        idempotency_key,
        key_source,
        request_sha256,
        digest_version
      )
      values ($1, $2, $3, 'server', $4, $5)
      returning id
    `,
    values: [
      input.ownerUserId,
      SPOT_AGENT_AUTHORIZATION_IDEMPOTENCY_SCOPE,
      prepared.context.authorizationId,
      prepared.requestSha256,
      SPOT_AGENT_AUTHORIZATION_REQUEST_DIGEST_VERSION,
    ],
  });
  const idempotencyId = idempotency.rows[0]?.id;
  if (idempotencyId === undefined) {
    return failUnavailable();
  }
  await client.query({
    text: `
      insert into public.provider_operations (
        id,
        owner_user_id,
        idempotency_record_id,
        domain,
        operation_kind,
        request_sha256
      )
      values ($1, $2, $3, 'hyperliquid', 'spot_agent_authorization', $4)
    `,
    values: [
      prepared.context.authorizationId,
      input.ownerUserId,
      idempotencyId,
      prepared.requestSha256,
    ],
  });
  const authorization = await client.query<{ id: string }>({
    text: `
      with database_clock as (
        select clock_timestamp() as observed_at
      )
      insert into public.spot_agent_authorizations (
        id,
        owner_user_id,
        request_sha256,
        request_digest_version,
        agent_identity_id,
        account_address,
        binding_version,
        signer_wallet_address,
        agent_address,
        agent_name,
        authorization_nonce,
        agent_valid_until,
        public_review,
        review_sha256,
        typed_data_primary_type,
        signing_digest,
        typed_data_json_sha256,
        signing_expires_at,
        created_at,
        updated_at
      )
      select
        $1, $2, $3, $4, $5, $6, $7::bigint, $6, $8, $9,
        $10::numeric, $11::timestamptz, $12::jsonb, $13, $14, $15, $16,
        $17::timestamptz, database_clock.observed_at,
        database_clock.observed_at
      from database_clock
      where $17::timestamptz > database_clock.observed_at
        and $17::timestamptz <= database_clock.observed_at
          + ($18::bigint * interval '1 millisecond')
        and $11::timestamptz > $17::timestamptz
        and $11::timestamptz <= database_clock.observed_at
          + ($19::bigint * interval '1 millisecond')
      returning id
    `,
    values: [
      prepared.context.authorizationId,
      input.ownerUserId,
      prepared.requestSha256,
      SPOT_AGENT_AUTHORIZATION_REQUEST_DIGEST_VERSION,
      identity.id,
      input.accountAddress,
      input.bindingVersion,
      identity.agent_address,
      identity.agent_name,
      prepared.context.authorizationNonce,
      prepared.context.agentValidUntil,
      JSON.stringify(prepared.publicReview),
      prepared.reviewSha256,
      prepared.typedDataPrimaryType,
      prepared.signingDigest,
      prepared.typedDataJsonSha256,
      prepared.context.signingExpiresAt,
      SPOT_AGENT_AUTHORIZATION_SIGNING_TTL_MILLISECONDS,
      SPOT_AGENT_AUTHORIZATION_MAX_AGENT_LIFETIME_MILLISECONDS,
    ],
  });
  if (authorization.rows[0] === undefined) {
    throw new SpotAgentAuthorizationPrepareExpiredError();
  }
  await client.query({
    text: `
      insert into public.hyperliquid_signer_nonce_allocations (
        operation_id,
        owner_user_id,
        network,
        signer_address,
        signer_kind,
        purpose,
        nonce
      )
      values (
        $1, $2, 'testnet', $3, 'owner_wallet',
        'spot_agent_authorization', $4::numeric
      )
    `,
    values: [
      prepared.context.authorizationId,
      input.ownerUserId,
      input.accountAddress,
      prepared.context.authorizationNonce,
    ],
  });
  await client.query({
    text: `
      insert into public.audit_events (
        owner_user_id,
        operation_id,
        request_id,
        actor_type,
        event_type,
        from_state,
        to_state,
        from_reconciliation_status,
        to_reconciliation_status,
        outcome,
        operation_version,
        fence_token,
        transport_attempt_id
      )
      values (
        $1, $2, $3, 'api', 'operation_prepared', null, 'prepared',
        null, 'not_required', 'prepared', 0, 0, null
      )
    `,
    values: [
      input.ownerUserId,
      prepared.context.authorizationId,
      input.requestId,
    ],
  });
  await client.query({
    text: `
      insert into public.spot_agent_authorization_events (
        authorization_id,
        owner_user_id,
        request_id,
        actor_type,
        event_type,
        from_state,
        to_state,
        outcome,
        authorization_version
      )
      values (
        $1, $2, $3, 'api', 'authorization_prepared', null,
        'prepared', 'prepared', 0
      )
    `,
    values: [
      prepared.context.authorizationId,
      input.ownerUserId,
      input.requestId,
    ],
  });
  await markIdentityAuthorizationPending(client, identity, input.requestId);
  const record = await readOwnedAuthorization(
    client,
    input.ownerUserId,
    prepared.context.authorizationId,
    true,
  );
  return record ?? failUnavailable();
}

interface ElapsedPreparedCandidate {
  readonly authorization_id: string;
  readonly agent_identity_id: string;
  readonly binding_version: string;
  readonly owner_user_id: string;
  readonly signing_expires_at: Date;
}

const elapsedPreparedCandidateSchema = z
  .object({
    authorization_id: uuidSchema,
    agent_identity_id: uuidSchema,
    binding_version: bindingVersionSchema,
    owner_user_id: uuidSchema,
    signing_expires_at: validDateSchema,
  })
  .strict();

const sweptBindingRowSchema = z
  .object({
    account_address: addressSchema.nullable(),
    binding_state: z.enum(["bound", "unbound"]),
    binding_version: bindingVersionSchema,
  })
  .strict();

async function listElapsedPreparedCandidates(
  pool: Pool,
  limit: number,
  after: ElapsedPreparedCandidate | null,
): Promise<readonly ElapsedPreparedCandidate[]> {
  const result = await pool.query<ElapsedPreparedCandidate>({
    text: `
      select
        agent_auth.id as authorization_id,
        agent_auth.agent_identity_id,
        agent_auth.binding_version::text as binding_version,
        agent_auth.owner_user_id,
        agent_auth.signing_expires_at
      from public.spot_agent_authorizations as agent_auth
      where agent_auth.state = 'prepared'
        and agent_auth.signing_expires_at <= clock_timestamp()
        and (
          $2::timestamptz is null
          or (agent_auth.signing_expires_at, agent_auth.id)
            > ($2::timestamptz, $3::uuid)
        )
      order by agent_auth.signing_expires_at, agent_auth.id
      limit $1
    `,
    values: [
      limit,
      after?.signing_expires_at ?? null,
      after?.authorization_id ?? null,
    ],
  });
  try {
    return result.rows.map((row) => elapsedPreparedCandidateSchema.parse(row));
  } catch {
    return failUnavailable();
  }
}

async function expireElapsedPreparedCandidate(
  pool: Pool,
  candidate: ElapsedPreparedCandidate,
  requestId: string,
): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    const advisory = await client.query<{ locked: boolean }>({
      text: "select pg_try_advisory_xact_lock(hashtext($1)) as locked",
      values: [
        `${issueLockDomain}:${candidate.owner_user_id}:${candidate.binding_version}`,
      ],
    });
    if (advisory.rows[0]?.locked !== true) {
      return false;
    }
    await client.query(
      `set local lock_timeout = '${SPOT_AGENT_AUTHORIZATION_EXPIRY_SWEEP_LOCK_TIMEOUT_MILLISECONDS}ms'`,
    );

    const owner = await client.query<{ id: string }>({
      text: `
        select id
        from public.loop_users
        where id = $1
        limit 1
        for update
      `,
      values: [candidate.owner_user_id],
    });
    if (owner.rows[0]?.id !== candidate.owner_user_id) {
      return failUnavailable();
    }

    const bindingResult = await client.query<Record<string, unknown>>({
      text: `
        select
          binding_state,
          account_address,
          binding_version::text as binding_version
        from public.perp_wallet_bindings
        where owner_user_id = $1
        limit 1
        for update
      `,
      values: [candidate.owner_user_id],
    });
    const binding = sweptBindingRowSchema.safeParse(bindingResult.rows[0]);
    if (!binding.success) {
      return failUnavailable();
    }

    const identityResult = await client.query<Record<string, unknown>>({
      text: `
        select
          id,
          owner_user_id,
          network,
          binding_version::text as binding_version,
          agent_generation::text as agent_generation,
          agent_address,
          agent_name,
          signer_ref,
          lifecycle_state,
          record_version::text as record_version
        from public.spot_agent_identities
        where id = $1 and owner_user_id = $2
        limit 1
        for update
      `,
      values: [candidate.agent_identity_id, candidate.owner_user_id],
    });
    const identity = identityRowSchema.safeParse(identityResult.rows[0]);
    if (!identity.success) {
      return failUnavailable();
    }

    const authorization = await readOwnedAuthorization(
      client,
      candidate.owner_user_id,
      candidate.authorization_id,
      true,
    );
    if (
      authorization === null ||
      authorization.agentIdentityId !== candidate.agent_identity_id ||
      authorization.storedState !== "prepared" ||
      authorization.resource.state !== "expired"
    ) {
      return false;
    }

    if (identity.data.lifecycle_state !== "authorization_pending") {
      await persistElapsedPreparedAuthorizationExpiry(
        client,
        authorization,
        requestId,
        "worker",
      );
      return true;
    }

    const identityTargetState =
      binding.data.binding_state === "bound" &&
      binding.data.binding_version === identity.data.binding_version &&
      binding.data.account_address === authorization.accountAddress
        ? "reserved"
        : "retired";
    await persistElapsedPreparedExpiry(
      client,
      authorization,
      requestId,
      identityTargetState,
      "worker",
    );
    return true;
  });
}

interface ElapsedAgentIdentityCandidate {
  readonly agent_identity_id: string;
  readonly agent_valid_until: Date;
  readonly binding_version: string;
  readonly owner_user_id: string;
}

const elapsedAgentIdentityCandidateSchema = z
  .object({
    agent_identity_id: uuidSchema,
    agent_valid_until: validDateSchema,
    binding_version: bindingVersionSchema,
    owner_user_id: uuidSchema,
  })
  .strict();

async function listElapsedAgentIdentityCandidates(
  pool: Pool,
  limit: number,
  after: ElapsedAgentIdentityCandidate | null,
): Promise<readonly ElapsedAgentIdentityCandidate[]> {
  const result = await pool.query<ElapsedAgentIdentityCandidate>({
    text: `
      select
        identity.id as agent_identity_id,
        latest.agent_valid_until,
        identity.binding_version::text as binding_version,
        identity.owner_user_id
      from public.spot_agent_identities as identity
      cross join lateral (
        select agent_auth.agent_valid_until
        from public.spot_agent_authorizations as agent_auth
        where agent_auth.agent_identity_id = identity.id
          and agent_auth.owner_user_id = identity.owner_user_id
        order by
          agent_auth.agent_valid_until desc,
          agent_auth.created_at desc,
          agent_auth.id desc
        limit 1
      ) as latest
      where identity.lifecycle_state in (
        'reserved', 'authorization_pending', 'active', 'operator_hold'
      )
        and latest.agent_valid_until <= clock_timestamp()
        and (
          $2::timestamptz is null
          or (latest.agent_valid_until, identity.id)
            > ($2::timestamptz, $3::uuid)
        )
      order by latest.agent_valid_until, identity.id
      limit $1
    `,
    values: [
      limit,
      after?.agent_valid_until ?? null,
      after?.agent_identity_id ?? null,
    ],
  });
  try {
    return result.rows.map((row) =>
      elapsedAgentIdentityCandidateSchema.parse(row),
    );
  } catch {
    return failUnavailable();
  }
}

async function retireElapsedAgentIdentityCandidate(
  pool: Pool,
  candidate: ElapsedAgentIdentityCandidate,
  requestId: string,
): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    const advisory = await client.query<{ locked: boolean }>({
      text: "select pg_try_advisory_xact_lock(hashtext($1)) as locked",
      values: [
        `${issueLockDomain}:${candidate.owner_user_id}:${candidate.binding_version}`,
      ],
    });
    if (advisory.rows[0]?.locked !== true) {
      return false;
    }
    await client.query(
      `set local lock_timeout = '${SPOT_AGENT_AUTHORIZATION_EXPIRY_SWEEP_LOCK_TIMEOUT_MILLISECONDS}ms'`,
    );

    const owner = await client.query<{ id: string }>({
      text: `
        select id
        from public.loop_users
        where id = $1
        limit 1
        for update
      `,
      values: [candidate.owner_user_id],
    });
    if (owner.rows[0]?.id !== candidate.owner_user_id) {
      return failUnavailable();
    }

    const bindingResult = await client.query<Record<string, unknown>>({
      text: `
        select
          binding_state,
          account_address,
          binding_version::text as binding_version
        from public.perp_wallet_bindings
        where owner_user_id = $1
        limit 1
        for update
      `,
      values: [candidate.owner_user_id],
    });
    if (!sweptBindingRowSchema.safeParse(bindingResult.rows[0]).success) {
      return failUnavailable();
    }

    const identityResult = await client.query<Record<string, unknown>>({
      text: `
        select
          id,
          owner_user_id,
          network,
          binding_version::text as binding_version,
          agent_generation::text as agent_generation,
          agent_address,
          agent_name,
          signer_ref,
          lifecycle_state,
          record_version::text as record_version
        from public.spot_agent_identities
        where id = $1 and owner_user_id = $2
        limit 1
        for update
      `,
      values: [candidate.agent_identity_id, candidate.owner_user_id],
    });
    const identity = identityRowSchema.safeParse(identityResult.rows[0]);
    if (!identity.success) {
      return failUnavailable();
    }
    if (
      ![
        "reserved",
        "authorization_pending",
        "active",
        "operator_hold",
      ].includes(identity.data.lifecycle_state)
    ) {
      return false;
    }

    const latest = await readLatestAuthorizationForIdentity(
      client,
      candidate.owner_user_id,
      candidate.agent_identity_id,
    );
    if (
      latest === null ||
      !(await hasAgentValidityElapsed(client, latest.agentValidUntil))
    ) {
      return false;
    }
    const preparedHandoffExpired =
      latest.storedState === "prepared" && latest.resource.state === "expired";
    let retirementAuthorization = latest;
    if (preparedHandoffExpired) {
      retirementAuthorization = await persistElapsedPreparedAuthorizationExpiry(
        client,
        latest,
        requestId,
        "worker",
      );
    }
    await persistAgentValidityRetirement(
      client,
      identity.data,
      retirementAuthorization,
      requestId,
      "worker",
    );
    return true;
  });
}

function isPostgresLockUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "55P03"
  );
}

function translateRepositoryError(error: unknown): never {
  if (
    error instanceof SpotAgentAuthorizationPrepareExpiredError ||
    error instanceof SpotAgentAuthorizationAuthorityStaleError ||
    error instanceof SpotAgentAuthorizationNonceUnavailableError ||
    error instanceof SpotAgentAuthorizationRepositoryUnavailableError
  ) {
    throw error;
  }
  throw new SpotAgentAuthorizationRepositoryUnavailableError();
}

type CurrentIdentity = z.output<typeof identityRowSchema>;

type InspectedCurrentAuthorization =
  | Extract<
      PreflightSpotAgentAuthorizationResult,
      { kind: "replayed" | "expired" }
    >
  | Readonly<{
      kind: "issue_required";
      identity: CurrentIdentity | null;
      agentGeneration: string;
    }>;

async function inspectCurrentAuthorization(
  client: DatabaseClient,
  input: ParsedPreflightInput,
  materializeForNonce: MaterializeSpotAgentAuthorizationForNonce,
  computeSigningDigest: ComputeSpotAgentAuthorizationSigningDigest,
): Promise<InspectedCurrentAuthorization> {
  await client.query({
    text: "select pg_advisory_xact_lock(hashtext($1))",
    values: [`${issueLockDomain}:${input.ownerUserId}:${input.bindingVersion}`],
  });
  await lockCurrentWalletBinding(client, input);

  const identity = await readCurrentIdentity(
    client,
    input.ownerUserId,
    input.bindingVersion,
  );
  if (identity === null) {
    return Object.freeze({
      kind: "issue_required" as const,
      identity: null,
      agentGeneration: await readNextAgentGeneration(
        client,
        input.ownerUserId,
        input.bindingVersion,
      ),
    });
  }

  const latest = await readLatestAuthorizationForIdentity(
    client,
    input.ownerUserId,
    identity.id,
  );
  if (
    latest !== null &&
    (await hasAgentValidityElapsed(client, latest.agentValidUntil))
  ) {
    const preparedHandoffExpired =
      latest.storedState === "prepared" && latest.resource.state === "expired";
    let retirementAuthorization = latest;
    if (preparedHandoffExpired) {
      retirementAuthorization = await persistElapsedPreparedAuthorizationExpiry(
        client,
        latest,
        input.requestId,
        "api",
      );
    }
    await persistAgentValidityRetirement(
      client,
      identity,
      retirementAuthorization,
      input.requestId,
      "api",
    );
    if (preparedHandoffExpired) {
      const retiredAuthorization = await readOwnedAuthorization(
        client,
        input.ownerUserId,
        retirementAuthorization.id,
        true,
      );
      return Object.freeze({
        kind: "expired" as const,
        created: false as const,
        authorization: retiredAuthorization ?? failUnavailable(),
        signablePayload: null,
      });
    }
    return Object.freeze({
      kind: "issue_required" as const,
      identity: null,
      agentGeneration: await readNextAgentGeneration(
        client,
        input.ownerUserId,
        input.bindingVersion,
      ),
    });
  }

  const live = await readLiveAuthorizationForIdentity(
    client,
    input.ownerUserId,
    identity.id,
  );
  if (identity.lifecycle_state === "authorization_pending") {
    if (live === null) {
      throw new SpotAgentAuthorizationAuthorityStaleError();
    }
    if (live.storedState === "prepared" && live.resource.state === "prepared") {
      const prepared = materializeIssue(
        contextFromRecord(live),
        live.signerRef,
        authorityDigestSnapshot(input),
        materializeForNonce,
        computeSigningDigest,
      );
      assertReplayMatches(live, input, prepared);
      return Object.freeze({
        kind: "replayed" as const,
        created: false as const,
        authorization: live,
        signablePayload: validatedSignablePayload(live, prepared),
      });
    }
    if (live.storedState !== "prepared" || live.resource.state !== "expired") {
      throw new SpotAgentAuthorizationAuthorityStaleError();
    }
    const expired = await persistElapsedPreparedExpiry(
      client,
      live,
      input.requestId,
      "reserved",
      "api",
    );
    return Object.freeze({
      kind: "expired" as const,
      created: false as const,
      authorization: expired,
      signablePayload: null,
    });
  }

  if (identity.lifecycle_state !== "reserved" || live !== null) {
    throw new SpotAgentAuthorizationAuthorityStaleError();
  }
  return Object.freeze({
    kind: "issue_required" as const,
    identity,
    agentGeneration: identity.agent_generation,
  });
}

async function issueAtomicPass(
  pool: Pool,
  input: ParsedIssueInput,
  materializeForNonce: MaterializeSpotAgentAuthorizationForNonce,
  computeSigningDigest: ComputeSpotAgentAuthorizationSigningDigest,
): Promise<IssueSpotAgentAuthorizationResult> {
  return withTransaction(
    pool,
    async (client) => {
      const inspected = await inspectCurrentAuthorization(
        client,
        input,
        materializeForNonce,
        computeSigningDigest,
      );
      if (inspected.kind !== "issue_required") {
        return inspected;
      }
      if (input.agentGeneration !== inspected.agentGeneration) {
        throw new SpotAgentAuthorizationAuthorityStaleError();
      }

      let identity = inspected.identity;
      if (identity === null) {
        identity = await insertNewIdentity(client, input);
      } else if (
        identity.agent_address !== input.agentAddress ||
        identity.agent_name !== input.agentName ||
        identity.signer_ref !== input.signerRef ||
        identity.agent_generation !== input.agentGeneration
      ) {
        throw new SpotAgentAuthorizationAuthorityStaleError();
      }
      if (identity.lifecycle_state !== "reserved") {
        throw new SpotAgentAuthorizationAuthorityStaleError();
      }

      const existingById = await readOwnedAuthorization(
        client,
        input.ownerUserId,
        input.authorizationId,
        true,
      );
      if (existingById !== null) {
        if (existingById.resource.state === "expired") {
          return Object.freeze({
            kind: "expired" as const,
            created: false as const,
            authorization: existingById,
            signablePayload: null,
          });
        }
        throw new SpotAgentAuthorizationAuthorityStaleError();
      }

      const authorizationNonce = await allocateAuthorizationNonce(
        client,
        input.accountAddress,
      );
      const context = Object.freeze({
        authorizationId: input.authorizationId,
        ownerUserId: input.ownerUserId,
        network: "testnet" as const,
        action: "approve_agent" as const,
        accountAddress: input.accountAddress,
        bindingVersion: input.bindingVersion,
        agentIdentityId: identity.id,
        agentGeneration: identity.agent_generation,
        agentAddress: identity.agent_address,
        agentName: identity.agent_name,
        authorizationNonce,
        agentValidUntil: input.agentValidUntil,
        signingExpiresAt: input.signingExpiresAt,
        policyVersion: input.policyVersion,
      });
      const prepared = materializeIssue(
        context,
        identity.signer_ref,
        authorityDigestSnapshot(input),
        materializeForNonce,
        computeSigningDigest,
      );
      const authorization = await persistIssuedRows(
        client,
        input,
        identity,
        prepared,
      );
      return Object.freeze({
        kind: "issued" as const,
        created: true as const,
        authorization,
        signablePayload: validatedSignablePayload(authorization, prepared),
      });
    },
    async (client, result) => {
      if (result.kind !== "expired") {
        await assertAuthorityLeaseStillCurrent(client, input);
      }
    },
  );
}

export function createPostgresSpotAgentAuthorizationRepository(
  pool: Pool,
): SpotAgentAuthorizationRepository {
  let elapsedPreparedCursor: ElapsedPreparedCandidate | null = null;
  let elapsedAgentIdentityCursor: ElapsedAgentIdentityCandidate | null = null;

  return Object.freeze({
    async preflightCurrent(
      rawInput: PreflightSpotAgentAuthorizationInput,
      materializeForNonce: MaterializeSpotAgentAuthorizationForNonce,
      computeSigningDigest: ComputeSpotAgentAuthorizationSigningDigest,
    ): Promise<PreflightSpotAgentAuthorizationResult> {
      try {
        const input = parsePreflightInput(rawInput);
        const inspected = await withTransaction(
          pool,
          (client) =>
            inspectCurrentAuthorization(
              client,
              input,
              materializeForNonce,
              computeSigningDigest,
            ),
          async (client, result) => {
            if (result.kind !== "expired") {
              await assertAuthorityLeaseStillCurrent(client, input);
            }
          },
        );
        if (inspected.kind === "issue_required") {
          return Object.freeze({
            kind: "issue_required" as const,
            created: false as const,
            agentGeneration: inspected.agentGeneration,
            authorization: null,
            signablePayload: null,
          });
        }
        return inspected;
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async issueOrReplayCurrent(
      rawInput: IssueSpotAgentAuthorizationInput,
      materializeForNonce: MaterializeSpotAgentAuthorizationForNonce,
      computeSigningDigest: ComputeSpotAgentAuthorizationSigningDigest,
    ): Promise<IssueSpotAgentAuthorizationResult> {
      try {
        const input = parseIssueInput(rawInput);
        for (let pass = 0; pass < 4; pass += 1) {
          const result = await issueAtomicPass(
            pool,
            input,
            materializeForNonce,
            computeSigningDigest,
          );
          if (
            result.kind !== "expired" ||
            result.authorization.id === input.authorizationId
          ) {
            return result;
          }
        }
        return failUnavailable();
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async expireElapsedPrepared(rawInput: {
      readonly requestId: string;
      readonly limit: number;
    }): Promise<Readonly<{ expiredCount: number }>> {
      try {
        const input = expireElapsedPreparedInputSchema.parse(rawInput);
        const candidates = await listElapsedPreparedCandidates(
          pool,
          input.limit,
          elapsedPreparedCursor,
        );
        elapsedPreparedCursor =
          candidates.length < input.limit ? null : (candidates.at(-1) ?? null);
        let expiredCount = 0;
        for (const candidate of candidates) {
          try {
            if (
              await expireElapsedPreparedCandidate(
                pool,
                candidate,
                input.requestId,
              )
            ) {
              expiredCount += 1;
            }
          } catch (error) {
            if (isPostgresLockUnavailable(error)) {
              continue;
            }
            throw error;
          }
        }
        return Object.freeze({ expiredCount });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async retireElapsedAgentIdentities(rawInput: {
      readonly requestId: string;
      readonly limit: number;
    }): Promise<Readonly<{ retiredCount: number }>> {
      try {
        const input = expireElapsedPreparedInputSchema.parse(rawInput);
        const candidates = await listElapsedAgentIdentityCandidates(
          pool,
          input.limit,
          elapsedAgentIdentityCursor,
        );
        elapsedAgentIdentityCursor =
          candidates.length < input.limit ? null : (candidates.at(-1) ?? null);
        let retiredCount = 0;
        for (const candidate of candidates) {
          try {
            if (
              await retireElapsedAgentIdentityCandidate(
                pool,
                candidate,
                input.requestId,
              )
            ) {
              retiredCount += 1;
            }
          } catch (error) {
            if (isPostgresLockUnavailable(error)) {
              continue;
            }
            throw error;
          }
        }
        return Object.freeze({ retiredCount });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async findOwned(
      rawOwnerUserId: string,
      rawAuthorizationId: string,
    ): Promise<SpotAgentAuthorizationRecord | null> {
      try {
        const ownerUserId = uuidSchema.parse(rawOwnerUserId);
        const authorizationId = uuidSchema.parse(rawAuthorizationId);
        return await readOwnedAuthorization(pool, ownerUserId, authorizationId);
      } catch (error) {
        return translateRepositoryError(error);
      }
    },
  });
}
