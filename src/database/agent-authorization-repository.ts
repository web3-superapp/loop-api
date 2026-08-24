import { createHash } from "node:crypto";

import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import {
  digestAgentAuthorizationReview,
  parseAgentAuthorizationReview,
  type AgentAuthorizationResourceState,
  type AgentAuthorizationResult,
  type AgentAuthorizationReview,
} from "../features/perp/agent-authorization-contract.js";

export const AGENT_AUTHORIZATION_IDEMPOTENCY_SCOPE =
  "perp_agent_authorization_issue";
export const AGENT_AUTHORIZATION_REQUEST_DIGEST_VERSION =
  "perp_agent_authorization_issue_v1";

const requestDigestDomain = "loop.perp.agent-authorization.issue.v1\0";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const lowercaseAddressPattern = /^0x[0-9a-f]{40}$/;
const zeroAddress = `0x${"0".repeat(40)}`;
const sha256Pattern = /^[0-9a-f]{64}$/;
const signingDigestPattern = /^0x[0-9a-f]{64}$/;
const primaryTypePattern = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const bindingVersionPattern = /^[1-9][0-9]{0,18}$/;
const maximumBindingVersion = 9_223_372_036_854_775_807n;
const safeReasonCodePattern = /^[a-z][a-z0-9_]{0,63}$/;

const uuidSchema = z.string().regex(uuidPattern);
const sha256Schema = z.string().regex(sha256Pattern);
const signingDigestSchema = z.string().regex(signingDigestPattern);
const primaryTypeSchema = z.string().regex(primaryTypePattern);
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
const validDateSchema = z
  .instanceof(Date)
  .refine((value) => !Number.isNaN(value.getTime()));
const stateSchema = z.enum([
  "prepared",
  "submitting",
  "accepted",
  "active",
  "rejected",
  "failed",
  "unknown",
  "reconciling",
  "expired",
]);

const persistIssuedInputSchema = z
  .object({
    authorizationId: uuidSchema,
    agentIdentityId: uuidSchema,
    ownerUserId: uuidSchema,
    requestId: uuidSchema,
    accountAddress: addressSchema,
    accountKind: z.enum(["master", "subaccount"]),
    bindingVersion: bindingVersionSchema,
    signerWalletAddress: addressSchema,
    agentAddress: addressSchema,
    agentName: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/)
      .refine((value) => value === value.trim()),
    agentValidUntil: rfc3339Schema,
    publicReview: z.unknown(),
    typedDataPrimaryType: primaryTypeSchema,
    signingDigest: signingDigestSchema,
    typedDataJsonSha256: sha256Schema,
    signingExpiresAt: rfc3339Schema,
  })
  .strict();

const authorizationRowSchema = z
  .object({
    id: uuidSchema,
    owner_user_id: uuidSchema,
    request_sha256: sha256Schema,
    request_digest_version: z.literal(
      AGENT_AUTHORIZATION_REQUEST_DIGEST_VERSION,
    ),
    agent_identity_id: uuidSchema,
    account_address: addressSchema,
    account_kind: z.enum(["master", "subaccount"]),
    binding_version: bindingVersionSchema,
    signer_wallet_address: addressSchema,
    agent_address: addressSchema,
    agent_name: z.string().min(1).max(64),
    agent_valid_until: validDateSchema,
    public_review: z.unknown(),
    review_sha256: sha256Schema,
    typed_data_primary_type: primaryTypeSchema,
    signing_digest: signingDigestSchema,
    typed_data_json_sha256: sha256Schema,
    signing_expires_at: validDateSchema,
    state: stateSchema,
    result_observed_at: validDateSchema.nullable(),
    result_reason_code: z.string().regex(safeReasonCodePattern).nullable(),
    created_at: validDateSchema,
    updated_at: validDateSchema,
  })
  .strict();

const authorizationReturningColumns = `
  agent_auth.id,
  agent_auth.owner_user_id,
  agent_auth.request_sha256,
  agent_auth.request_digest_version,
  agent_auth.agent_identity_id,
  agent_auth.account_address,
  agent_auth.account_kind,
  agent_auth.binding_version::text as binding_version,
  agent_auth.signer_wallet_address,
  agent_auth.agent_address,
  agent_auth.agent_name,
  agent_auth.agent_valid_until,
  agent_auth.public_review,
  agent_auth.review_sha256,
  agent_auth.typed_data_primary_type,
  agent_auth.signing_digest,
  agent_auth.typed_data_json_sha256,
  agent_auth.signing_expires_at,
  case
    when agent_auth.state = 'prepared'
      and agent_auth.signing_expires_at <= clock_timestamp()
    then 'expired'
    else agent_auth.state
  end as state,
  agent_auth.result_observed_at,
  agent_auth.result_reason_code,
  agent_auth.created_at,
  agent_auth.updated_at
`;

export type AgentAuthorizationAccountKind = "master" | "subaccount";

export interface AgentAuthorizationRecord {
  readonly id: string;
  readonly ownerUserId: string;
  readonly requestSha256: string;
  readonly agentIdentityId: string;
  readonly accountAddress: string;
  readonly accountKind: AgentAuthorizationAccountKind;
  readonly bindingVersion: string;
  readonly signerWalletAddress: string;
  readonly agentAddress: string;
  readonly agentName: string;
  readonly agentValidUntil: string;
  readonly publicReview: AgentAuthorizationReview;
  readonly reviewSha256: string;
  readonly typedDataPrimaryType: string;
  readonly signingDigest: string;
  readonly typedDataJsonSha256: string;
  readonly signingExpiresAt: string;
  readonly state: AgentAuthorizationResourceState;
  readonly result: AgentAuthorizationResult | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * This input means an audited workflow has already issued one exact payload.
 * It is not a payload builder and intentionally contains no typed-data JSON,
 * signature, nonce, signed bytes, key, or provider response.
 */
export interface PersistIssuedAgentAuthorizationInput {
  readonly authorizationId: string;
  readonly agentIdentityId: string;
  readonly ownerUserId: string;
  readonly requestId: string;
  readonly accountAddress: string;
  readonly accountKind: AgentAuthorizationAccountKind;
  readonly bindingVersion: string;
  readonly signerWalletAddress: string;
  readonly agentAddress: string;
  readonly agentName: string;
  readonly agentValidUntil: string;
  readonly publicReview: AgentAuthorizationReview;
  readonly typedDataPrimaryType: string;
  readonly signingDigest: string;
  readonly typedDataJsonSha256: string;
  readonly signingExpiresAt: string;
}

export interface AgentAuthorizationRepository {
  persistIssued(input: PersistIssuedAgentAuthorizationInput): Promise<{
    readonly created: boolean;
    readonly authorization: AgentAuthorizationRecord;
  }>;
  findOwned(
    ownerUserId: string,
    authorizationId: string,
  ): Promise<AgentAuthorizationRecord | null>;
}

export class AgentAuthorizationPrepareExpiredError extends Error {
  readonly code = "agent_authorization_expired";

  constructor() {
    super("The Agent authorization signing handoff is already expired");
    this.name = "AgentAuthorizationPrepareExpiredError";
  }
}

export class AgentAuthorizationRepositoryUnavailableError extends Error {
  readonly code = "agent_authorization_unavailable";

  constructor() {
    super("The Agent authorization repository is unavailable");
    this.name = "AgentAuthorizationRepositoryUnavailableError";
  }
}

function unavailable(): Promise<never> {
  return Promise.reject(new AgentAuthorizationRepositoryUnavailableError());
}

export function createUnavailableAgentAuthorizationRepository(): AgentAuthorizationRepository {
  return Object.freeze({ persistIssued: unavailable, findOwned: unavailable });
}

interface ParsedPersistIssuedInput extends Omit<
  PersistIssuedAgentAuthorizationInput,
  "publicReview"
> {
  readonly publicReview: AgentAuthorizationReview;
  readonly reviewSha256: string;
  readonly requestSha256: string;
}

function failUnavailable(): never {
  throw new AgentAuthorizationRepositoryUnavailableError();
}

function digestIssuedBinding(
  input: Omit<ParsedPersistIssuedInput, "requestSha256">,
): string {
  return createHash("sha256")
    .update(requestDigestDomain, "utf8")
    .update(
      JSON.stringify([
        AGENT_AUTHORIZATION_REQUEST_DIGEST_VERSION,
        input.authorizationId,
        input.agentIdentityId,
        input.ownerUserId,
        input.accountAddress,
        input.accountKind,
        input.bindingVersion,
        input.signerWalletAddress,
        input.agentAddress,
        input.agentName,
        input.agentValidUntil,
        input.reviewSha256,
        input.typedDataPrimaryType,
        input.signingDigest,
        input.typedDataJsonSha256,
        input.signingExpiresAt,
      ]),
      "utf8",
    )
    .digest("hex");
}

function parsePersistIssuedInput(
  rawInput: PersistIssuedAgentAuthorizationInput,
): ParsedPersistIssuedInput {
  try {
    const envelope = persistIssuedInputSchema.parse(rawInput);
    const publicReview = parseAgentAuthorizationReview(envelope.publicReview);
    if (
      publicReview.account.address !== envelope.accountAddress ||
      publicReview.account.kind !== envelope.accountKind ||
      publicReview.signer_wallet_address !== envelope.signerWalletAddress ||
      publicReview.agent.address !== envelope.agentAddress ||
      publicReview.agent.name !== envelope.agentName ||
      Date.parse(publicReview.agent.valid_until) !==
        Date.parse(envelope.agentValidUntil) ||
      Date.parse(envelope.signingExpiresAt) >
        Date.parse(envelope.agentValidUntil)
    ) {
      return failUnavailable();
    }

    const base = Object.freeze({
      ...envelope,
      publicReview,
      reviewSha256: digestAgentAuthorizationReview(publicReview),
    });
    return Object.freeze({
      ...base,
      requestSha256: digestIssuedBinding(base),
    });
  } catch (error) {
    if (error instanceof AgentAuthorizationRepositoryUnavailableError) {
      throw error;
    }
    return failUnavailable();
  }
}

function resultForRow(
  state: AgentAuthorizationResourceState,
  observedAt: Date | null,
  reasonCode: string | null,
): AgentAuthorizationResult | null {
  const resultState =
    state === "active" || state === "rejected" || state === "failed"
      ? state
      : state === "unknown" || state === "reconciling"
        ? "unknown"
        : null;
  if (resultState === null) {
    if (observedAt !== null || reasonCode !== null) {
      return failUnavailable();
    }
    return null;
  }
  if (observedAt === null) {
    return failUnavailable();
  }
  return Object.freeze({
    state: resultState,
    observed_at: observedAt.toISOString(),
    reason_code: reasonCode,
  });
}

function toAgentAuthorizationRecord(value: unknown): AgentAuthorizationRecord {
  try {
    const parsed = authorizationRowSchema.parse(value);
    const publicReview = parseAgentAuthorizationReview(parsed.public_review);
    const reviewSha256 = digestAgentAuthorizationReview(publicReview);
    if (
      parsed.review_sha256 !== reviewSha256 ||
      publicReview.account.address !== parsed.account_address ||
      publicReview.account.kind !== parsed.account_kind ||
      publicReview.signer_wallet_address !== parsed.signer_wallet_address ||
      publicReview.agent.address !== parsed.agent_address ||
      publicReview.agent.name !== parsed.agent_name ||
      Date.parse(publicReview.agent.valid_until) !==
        parsed.agent_valid_until.getTime() ||
      parsed.signing_expires_at.getTime() > parsed.agent_valid_until.getTime()
    ) {
      return failUnavailable();
    }

    return Object.freeze({
      id: parsed.id,
      ownerUserId: parsed.owner_user_id,
      requestSha256: parsed.request_sha256,
      agentIdentityId: parsed.agent_identity_id,
      accountAddress: parsed.account_address,
      accountKind: parsed.account_kind,
      bindingVersion: parsed.binding_version,
      signerWalletAddress: parsed.signer_wallet_address,
      agentAddress: parsed.agent_address,
      agentName: parsed.agent_name,
      agentValidUntil: parsed.agent_valid_until.toISOString(),
      publicReview,
      reviewSha256,
      typedDataPrimaryType: parsed.typed_data_primary_type,
      signingDigest: parsed.signing_digest,
      typedDataJsonSha256: parsed.typed_data_json_sha256,
      signingExpiresAt: parsed.signing_expires_at.toISOString(),
      state: parsed.state,
      result: resultForRow(
        parsed.state,
        parsed.result_observed_at,
        parsed.result_reason_code,
      ),
      createdAt: parsed.created_at.toISOString(),
      updatedAt: parsed.updated_at.toISOString(),
    });
  } catch (error) {
    if (error instanceof AgentAuthorizationRepositoryUnavailableError) {
      throw error;
    }
    return failUnavailable();
  }
}

type DatabaseClient = Pick<PoolClient, "query">;

async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const value = await operation(client);
    await client.query("commit");
    return value;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      throw new AgentAuthorizationRepositoryUnavailableError();
    }
    throw error;
  } finally {
    client.release();
  }
}

async function readOwnedAuthorization(
  client: DatabaseClient,
  ownerUserId: string,
  authorizationId: string,
): Promise<AgentAuthorizationRecord | null> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select ${authorizationReturningColumns}
      from public.perp_agent_authorizations as agent_auth
      where agent_auth.owner_user_id = $1 and agent_auth.id = $2
      limit 1
    `,
    values: [ownerUserId, authorizationId],
  });
  const row = result.rows[0];
  return row === undefined ? null : toAgentAuthorizationRecord(row);
}

function recordMatchesInput(
  record: AgentAuthorizationRecord,
  input: ParsedPersistIssuedInput,
): boolean {
  return (
    record.id === input.authorizationId &&
    record.ownerUserId === input.ownerUserId &&
    record.requestSha256 === input.requestSha256 &&
    record.agentIdentityId === input.agentIdentityId &&
    record.accountAddress === input.accountAddress &&
    record.accountKind === input.accountKind &&
    record.bindingVersion === input.bindingVersion &&
    record.signerWalletAddress === input.signerWalletAddress &&
    record.agentAddress === input.agentAddress &&
    record.agentName === input.agentName &&
    Date.parse(record.agentValidUntil) === Date.parse(input.agentValidUntil) &&
    record.reviewSha256 === input.reviewSha256 &&
    record.typedDataPrimaryType === input.typedDataPrimaryType &&
    record.signingDigest === input.signingDigest &&
    record.typedDataJsonSha256 === input.typedDataJsonSha256 &&
    Date.parse(record.signingExpiresAt) === Date.parse(input.signingExpiresAt)
  );
}

function translateRepositoryError(error: unknown): never {
  if (
    error instanceof AgentAuthorizationPrepareExpiredError ||
    error instanceof AgentAuthorizationRepositoryUnavailableError
  ) {
    throw error;
  }
  throw new AgentAuthorizationRepositoryUnavailableError();
}

export function createPostgresAgentAuthorizationRepository(
  pool: Pool,
): AgentAuthorizationRepository {
  return Object.freeze({
    async persistIssued(
      rawInput: PersistIssuedAgentAuthorizationInput,
    ): Promise<{
      readonly created: boolean;
      readonly authorization: AgentAuthorizationRecord;
    }> {
      try {
        const input = parsePersistIssuedInput(rawInput);
        return await withTransaction(pool, async (client) => {
          const idempotencyResult = await client.query<{ id: string }>({
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
              on conflict (scope, idempotency_key)
              do update set last_seen_at = clock_timestamp()
              where idempotency_records.owner_user_id = excluded.owner_user_id
                and idempotency_records.key_source = excluded.key_source
                and idempotency_records.request_sha256 = excluded.request_sha256
                and idempotency_records.digest_version = excluded.digest_version
              returning id
            `,
            values: [
              input.ownerUserId,
              AGENT_AUTHORIZATION_IDEMPOTENCY_SCOPE,
              input.authorizationId,
              input.requestSha256,
              AGENT_AUTHORIZATION_REQUEST_DIGEST_VERSION,
            ],
          });
          const idempotencyId = idempotencyResult.rows[0]?.id;
          if (idempotencyId === undefined) {
            return failUnavailable();
          }

          const operationResult = await client.query<{ id: string }>({
            text: `
              insert into public.provider_operations (
                id,
                owner_user_id,
                idempotency_record_id,
                domain,
                operation_kind,
                request_sha256
              )
              values ($1, $2, $3, 'hyperliquid', 'agent_authorization', $4)
              on conflict (idempotency_record_id) do nothing
              returning id
            `,
            values: [
              input.authorizationId,
              input.ownerUserId,
              idempotencyId,
              input.requestSha256,
            ],
          });
          const insertedOperationId = operationResult.rows[0]?.id;
          if (insertedOperationId === undefined) {
            const existingOperation = await client.query<{
              id: string;
              owner_user_id: string;
              domain: string;
              operation_kind: string;
              request_sha256: string;
            }>({
              text: `
                select id, owner_user_id, domain, operation_kind, request_sha256
                from public.provider_operations
                where idempotency_record_id = $1
                limit 1
              `,
              values: [idempotencyId],
            });
            const existing = existingOperation.rows[0];
            if (
              existing === undefined ||
              existing.id !== input.authorizationId ||
              existing.owner_user_id !== input.ownerUserId ||
              existing.domain !== "hyperliquid" ||
              existing.operation_kind !== "agent_authorization" ||
              existing.request_sha256 !== input.requestSha256
            ) {
              return failUnavailable();
            }
            const authorization = await readOwnedAuthorization(
              client,
              input.ownerUserId,
              input.authorizationId,
            );
            if (
              authorization === null ||
              !recordMatchesInput(authorization, input)
            ) {
              return failUnavailable();
            }
            return Object.freeze({ created: false, authorization });
          }

          await client.query({
            text: `
              insert into public.perp_agent_identities (
                id,
                owner_user_id,
                agent_address,
                agent_name
              )
              values ($1, $2, $3, $4)
            `,
            values: [
              input.agentIdentityId,
              input.ownerUserId,
              input.agentAddress,
              input.agentName,
            ],
          });

          const authorizationResult = await client.query<{ id: string }>({
            text: `
              with database_clock as (
                select clock_timestamp() as observed_at
              )
              insert into public.perp_agent_authorizations (
                id,
                owner_user_id,
                request_sha256,
                request_digest_version,
                agent_identity_id,
                account_address,
                account_kind,
                binding_version,
                signer_wallet_address,
                agent_address,
                agent_name,
                agent_valid_until,
                public_review,
                review_sha256,
                typed_data_primary_type,
                signing_digest,
                typed_data_json_sha256,
                signing_expires_at
              )
              select
                $1,
                $2,
                $3,
                $4,
                $5,
                $6,
                $7,
                $8::bigint,
                $9,
                $10,
                $11,
                $12::timestamptz,
                $13::jsonb,
                $14,
                $15,
                $16,
                $17,
                $18::timestamptz
              from database_clock
              where $18::timestamptz > database_clock.observed_at
                and $12::timestamptz >= $18::timestamptz
              returning id
            `,
            values: [
              insertedOperationId,
              input.ownerUserId,
              input.requestSha256,
              AGENT_AUTHORIZATION_REQUEST_DIGEST_VERSION,
              input.agentIdentityId,
              input.accountAddress,
              input.accountKind,
              input.bindingVersion,
              input.signerWalletAddress,
              input.agentAddress,
              input.agentName,
              input.agentValidUntil,
              JSON.stringify(input.publicReview),
              input.reviewSha256,
              input.typedDataPrimaryType,
              input.signingDigest,
              input.typedDataJsonSha256,
              input.signingExpiresAt,
            ],
          });
          if (authorizationResult.rows[0] === undefined) {
            throw new AgentAuthorizationPrepareExpiredError();
          }

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
            values: [input.ownerUserId, insertedOperationId, input.requestId],
          });

          await client.query({
            text: `
              insert into public.perp_agent_authorization_events (
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
            values: [input.authorizationId, input.ownerUserId, input.requestId],
          });

          const authorization = await readOwnedAuthorization(
            client,
            input.ownerUserId,
            input.authorizationId,
          );
          if (authorization === null) {
            return failUnavailable();
          }
          return Object.freeze({ created: true, authorization });
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async findOwned(
      rawOwnerUserId: string,
      rawAuthorizationId: string,
    ): Promise<AgentAuthorizationRecord | null> {
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
