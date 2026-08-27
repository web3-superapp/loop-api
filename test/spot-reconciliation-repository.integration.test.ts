import { randomUUID } from "node:crypto";

import pg, { type PoolClient } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { StaleProviderOperationLeaseError } from "../src/database/control-plane-repository.js";
import {
  createPostgresSpotReconciliationRepository,
  SpotReconciliationRepositoryUnavailableError,
} from "../src/database/spot-reconciliation-repository.js";
import { createSpotReview } from "../src/features/spot/spot-intent-contract.js";

const { Pool } = pg;
const databaseUrl = process.env["DATABASE_URL"];

if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error("DATABASE_URL is required for the integration test suite");
}

const requestSha256 = "a".repeat(64);
const metadataSha256 = "b".repeat(64);
const baseTokenId = `0x${"2".repeat(32)}`;
const quoteTokenId = `0x${"3".repeat(32)}`;
const accountAddress = `0x${"1".repeat(40)}`;

function randomHex(length: number): string {
  return Array.from({ length: Math.ceil(length / 32) }, () =>
    randomUUID().replaceAll("-", ""),
  )
    .join("")
    .slice(0, length);
}

interface FixtureAuthority {
  readonly ownerUserId: string;
  readonly agentIdentityId: string;
  readonly agentAddress: string;
}

interface UnknownSpotIntentFixture extends FixtureAuthority {
  readonly operationId: string;
  readonly transportAttemptId: string;
  readonly marketId: string;
  readonly clientOrderId: string;
}

interface UnknownSpotAgentAuthorizationFixture extends FixtureAuthority {
  readonly operationId: string;
}

interface IntentProjectionSnapshot {
  readonly operation_state: string;
  readonly reconciliation_status: string;
  readonly reconciliation_attempt_count: number;
  readonly reconcile_after: Date | null;
  readonly operator_required_at: Date | null;
  readonly lease_owner: string | null;
  readonly lease_expires_at: Date | null;
  readonly fence_token: string;
  readonly operation_version: string;
  readonly intent_state: string;
  readonly intent_version: string;
  readonly operation_event_count: string;
  readonly intent_event_count: string;
  readonly latest_operation_from_status: string | null;
  readonly latest_operation_to_status: string;
  readonly latest_operation_reason_code: string | null;
  readonly latest_operation_event_version: string;
  readonly latest_intent_from_state: string | null;
  readonly latest_intent_to_state: string;
  readonly latest_intent_reason_code: string | null;
  readonly latest_intent_event_version: string;
}

async function withTransaction<T>(
  pool: InstanceType<typeof Pool>,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await operation(client);
    await client.query("set constraints all immediate");
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function insertFixtureAuthority(
  client: PoolClient,
  label: string,
): Promise<FixtureAuthority> {
  const ownerUserId = randomUUID();
  const agentIdentityId = randomUUID();
  const agentAddress = `0x${randomHex(40)}`;
  await client.query({
    text: `
      insert into public.loop_users (id, privy_user_id)
      values ($1, $2)
    `,
    values: [
      ownerUserId,
      `did:privy:spot-reconciliation:${label}:${randomUUID()}`,
    ],
  });
  await client.query({
    text: `
      insert into public.spot_agent_identities (
        id,
        owner_user_id,
        binding_version,
        agent_generation,
        agent_address,
        agent_name,
        signer_ref,
        lifecycle_state,
        record_version
      )
      values ($1, $2, 1, 1, $3, $4, $5, 'reserved', 0)
    `,
    values: [
      agentIdentityId,
      ownerUserId,
      agentAddress,
      `Loop-${randomHex(8)}`,
      `fixture-signer:${randomUUID()}`,
    ],
  });
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
      values ($1, $2, $3, 'api', 'agent_reserved', null, 'reserved',
        'reserved', 0)
    `,
    values: [agentIdentityId, ownerUserId, randomUUID()],
  });
  return Object.freeze({ ownerUserId, agentIdentityId, agentAddress });
}

async function insertPreparedProviderOperation(
  client: PoolClient,
  input: Readonly<{
    ownerUserId: string;
    operationId: string;
    operationKind: "spot_intent" | "spot_agent_authorization";
    transportAttemptId: string;
  }>,
): Promise<void> {
  const idempotencyRecordId = randomUUID();
  await client.query({
    text: `
      insert into public.idempotency_records (
        id,
        owner_user_id,
        scope,
        idempotency_key,
        key_source,
        request_sha256,
        digest_version
      )
      values ($1, $2, $3, $4, 'server', $5, $6)
    `,
    values: [
      idempotencyRecordId,
      input.ownerUserId,
      input.operationKind === "spot_intent"
        ? "spot_intent_prepare"
        : "spot_agent_authorization_issue",
      randomUUID(),
      requestSha256,
      input.operationKind === "spot_intent"
        ? "spot_intent_request_v1"
        : "spot_agent_authorization_issue_v1",
    ],
  });
  await client.query({
    text: `
      insert into public.provider_operations (
        id,
        owner_user_id,
        idempotency_record_id,
        domain,
        operation_kind,
        request_sha256,
        state,
        record_version
      )
      values ($1, $2, $3, 'hyperliquid', $4, $5, 'prepared', 0)
    `,
    values: [
      input.operationId,
      input.ownerUserId,
      idempotencyRecordId,
      input.operationKind,
      requestSha256,
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
        $1, $2, $3, 'api', 'provider_operation_prepared', null, 'prepared',
        null, 'not_required', 'prepared', 0, 0, null
      )
    `,
    values: [input.ownerUserId, input.operationId, randomUUID()],
  });
}

async function insertSubmissionAudit(
  client: PoolClient,
  input: Readonly<{
    ownerUserId: string;
    operationId: string;
    transportAttemptId: string;
    eventType: string;
    fromState: "prepared" | "submitting";
    toState: "submitting" | "unknown";
    fromReconciliationStatus: "not_required";
    toReconciliationStatus: "not_required" | "pending";
    outcome: string;
    reasonCode: string | null;
    operationVersion: 1 | 2;
  }>,
): Promise<void> {
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
        reason_code,
        operation_version,
        fence_token,
        transport_attempt_id
      )
      values ($1, $2, $3, 'api', $4, $5, $6, $7, $8, $9, $10, $11, 0, $12)
    `,
    values: [
      input.ownerUserId,
      input.operationId,
      randomUUID(),
      input.eventType,
      input.fromState,
      input.toState,
      input.fromReconciliationStatus,
      input.toReconciliationStatus,
      input.outcome,
      input.reasonCode,
      input.operationVersion,
      input.transportAttemptId,
    ],
  });
}

async function insertSpotNonceAllocation(
  client: PoolClient,
  input: Readonly<{
    operationId: string;
    ownerUserId: string;
    signerAddress: string;
    signerKind: "spot_agent" | "owner_wallet";
    purpose: "spot_ioc_order" | "spot_agent_authorization";
  }>,
): Promise<void> {
  await client.query({
    text: `
      insert into public.hyperliquid_signer_nonce_state (
        network,
        signer_address,
        signer_kind,
        last_allocated_nonce
      )
      values ('testnet', $1, $2, 1)
    `,
    values: [input.signerAddress, input.signerKind],
  });
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
      values ($1, $2, 'testnet', $3, $4, $5, 1)
    `,
    values: [
      input.operationId,
      input.ownerUserId,
      input.signerAddress,
      input.signerKind,
      input.purpose,
    ],
  });
}

async function seedUnknownSpotIntent(
  pool: InstanceType<typeof Pool>,
  label: string,
  options: Readonly<{ reviewSha256?: string }> = {},
): Promise<UnknownSpotIntentFixture> {
  return withTransaction(pool, async (client) => {
    const authority = await insertFixtureAuthority(client, label);
    const operationId = randomUUID();
    const transportAttemptId = randomUUID();
    const marketId = randomUUID();
    const clientOrderId = `0x${randomHex(32)}`;
    const now = Date.now();
    const referenceSourceTime = new Date(now - 2_000).toISOString();
    const factsObservedAt = new Date(now - 1_000).toISOString();
    const feeObservedAt = new Date(now - 1_500).toISOString();
    const expiresAt = new Date(now + 3_600_000).toISOString();
    const publicReview = createSpotReview({
      version: "spot_review_v1",
      provider: "hyperliquid",
      network: "testnet",
      market_id: marketId,
      base_display_identity: "PURR",
      quote_display_identity: "USDC",
      side: "buy",
      amount_mode: "quote",
      amount_value: "10",
      computed_base_size: "0.2",
      reference_price: "49.5",
      reference_source_time: referenceSourceTime,
      worst_ioc_limit_price: "50",
      maximum_spend_or_minimum_receive: {
        kind: "maximum_spend",
        asset_display_identity: "USDC",
        value: "10",
      },
      fee_rate: "0.001",
      fee_estimate: "0.01",
      fee_source: {
        dataset: "user_fees",
        observed_at: feeObservedAt,
      },
      metadata_version: "testnet_metadata_v1",
      policy_version: "spot_ioc_v1",
      binding_epoch: "1",
      expires_at: expiresAt,
    });
    const canonicalAction = {
      type: "order",
      orders: [
        {
          a: 10_000,
          b: true,
          p: "50",
          s: "0.2",
          r: false,
          t: { limit: { tif: "Ioc" } },
          c: clientOrderId,
        },
      ],
      grouping: "na",
    } as const;

    await insertPreparedProviderOperation(client, {
      ownerUserId: authority.ownerUserId,
      operationId,
      operationKind: "spot_intent",
      transportAttemptId,
    });
    await client.query({
      text: `
        insert into public.spot_intents (
          id,
          owner_user_id,
          request_sha256,
          market_id,
          provider_coin,
          base_token_index,
          base_token_id,
          quote_token_index,
          quote_token_id,
          spot_pair_index,
          exchange_order_asset,
          metadata_version,
          metadata_sha256,
          policy_version,
          side,
          amount_mode,
          amount_value,
          computed_base_size,
          reference_price,
          worst_ioc_limit_price,
          maximum_spend_or_minimum_receive,
          fee_rate,
          fee_estimate,
          account_address,
          binding_version,
          agent_identity_id,
          client_order_id,
          canonical_action,
          public_review,
          review_sha256,
          facts_observed_at,
          reference_source_time,
          expires_at,
          state,
          record_version
        )
        values (
          $1, $2, $3, $4, 'PURR/USDC', 1, $5, 0, $6, 0, 10000,
          'testnet_metadata_v1', $7, 'spot_ioc_v1', 'buy', 'quote', '10',
          '0.2', '49.5', '50', '10', '0.001', '0.01', $8, 1, $9, $10,
          $11::jsonb, $12::jsonb, $13, $14, $15, $16, 'prepared', 0
        )
      `,
      values: [
        operationId,
        authority.ownerUserId,
        requestSha256,
        marketId,
        baseTokenId,
        quoteTokenId,
        metadataSha256,
        accountAddress,
        authority.agentIdentityId,
        clientOrderId,
        JSON.stringify(canonicalAction),
        JSON.stringify(publicReview),
        options.reviewSha256 ?? publicReview.review_digest,
        factsObservedAt,
        referenceSourceTime,
        expiresAt,
      ],
    });
    await client.query({
      text: `
        insert into public.spot_intent_events (
          intent_id,
          owner_user_id,
          request_id,
          actor_type,
          event_type,
          from_state,
          to_state,
          outcome,
          intent_version
        )
        values ($1, $2, $3, 'api', 'intent_prepared', null, 'prepared',
          'prepared', 0)
      `,
      values: [operationId, authority.ownerUserId, randomUUID()],
    });

    await client.query({
      text: `
        with database_clock as (
          select clock_timestamp() as observed_at
        )
        update public.provider_operations
        set
          state = 'submitting',
          attempt_count = 1,
          transport_attempt_id = $2,
          attempt_committed_at = database_clock.observed_at,
          attempt_deadline_at = database_clock.observed_at + interval '10 seconds',
          record_version = 1,
          updated_at = database_clock.observed_at
        from database_clock
        where id = $1 and state = 'prepared'
      `,
      values: [operationId, transportAttemptId],
    });
    await client.query({
      text: `
        update public.spot_intents
        set state = 'submitting', record_version = 1,
          updated_at = clock_timestamp()
        where id = $1 and state = 'prepared'
      `,
      values: [operationId],
    });
    await insertSpotNonceAllocation(client, {
      operationId,
      ownerUserId: authority.ownerUserId,
      signerAddress: authority.agentAddress,
      signerKind: "spot_agent",
      purpose: "spot_ioc_order",
    });
    await insertSubmissionAudit(client, {
      ownerUserId: authority.ownerUserId,
      operationId,
      transportAttemptId,
      eventType: "provider_submission_started",
      fromState: "prepared",
      toState: "submitting",
      fromReconciliationStatus: "not_required",
      toReconciliationStatus: "not_required",
      outcome: "attempt_committed",
      reasonCode: null,
      operationVersion: 1,
    });
    await client.query({
      text: `
        insert into public.spot_intent_events (
          intent_id, owner_user_id, request_id, actor_type, event_type,
          from_state, to_state, outcome, intent_version
        )
        values ($1, $2, $3, 'api', 'intent_submitting', 'prepared',
          'submitting', 'attempt_committed', 1)
      `,
      values: [operationId, authority.ownerUserId, randomUUID()],
    });

    await client.query({
      text: `
        update public.provider_operations
        set
          state = 'unknown',
          reconciliation_status = 'pending',
          reconcile_after = clock_timestamp() - interval '1 millisecond',
          record_version = 2,
          updated_at = clock_timestamp()
        where id = $1 and state = 'submitting'
      `,
      values: [operationId],
    });
    await client.query({
      text: `
        update public.spot_intents
        set
          state = 'unknown',
          result_observed_at = clock_timestamp(),
          result_reason_code = 'submission_transport_ambiguous',
          record_version = 2,
          updated_at = clock_timestamp()
        where id = $1 and state = 'submitting'
      `,
      values: [operationId],
    });
    await insertSubmissionAudit(client, {
      ownerUserId: authority.ownerUserId,
      operationId,
      transportAttemptId,
      eventType: "provider_submission_unknown",
      fromState: "submitting",
      toState: "unknown",
      fromReconciliationStatus: "not_required",
      toReconciliationStatus: "pending",
      outcome: "unknown",
      reasonCode: "submission_transport_ambiguous",
      operationVersion: 2,
    });
    await client.query({
      text: `
        insert into public.spot_intent_events (
          intent_id, owner_user_id, request_id, actor_type, event_type,
          from_state, to_state, outcome, reason_code, intent_version
        )
        values ($1, $2, $3, 'api', 'intent_submission_unknown', 'submitting',
          'unknown', 'unknown', 'submission_transport_ambiguous', 2)
      `,
      values: [operationId, authority.ownerUserId, randomUUID()],
    });

    return Object.freeze({
      ...authority,
      operationId,
      transportAttemptId,
      marketId,
      clientOrderId,
    });
  });
}

async function seedUnknownSpotAgentAuthorization(
  pool: InstanceType<typeof Pool>,
  label: string,
): Promise<UnknownSpotAgentAuthorizationFixture> {
  return withTransaction(pool, async (client) => {
    const authority = await insertFixtureAuthority(client, label);
    const operationId = randomUUID();
    const transportAttemptId = randomUUID();
    const signingDigest = `0x${randomHex(64)}`;
    const typedDataJsonSha256 = randomHex(64);

    await insertPreparedProviderOperation(client, {
      ownerUserId: authority.ownerUserId,
      operationId,
      operationKind: "spot_agent_authorization",
      transportAttemptId,
    });
    const identity = await client.query<{ agent_name: string }>({
      text: `
        select agent_name
        from public.spot_agent_identities
        where id = $1
      `,
      values: [authority.agentIdentityId],
    });
    const agentName = identity.rows[0]?.agent_name;
    if (agentName === undefined) {
      throw new Error("Spot Agent authorization fixture identity is missing");
    }
    await client.query({
      text: `
        insert into public.spot_agent_authorizations (
          id,
          owner_user_id,
          request_sha256,
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
          state,
          record_version
        )
        values (
          $1, $2, $3, $4, $5, 1, $5, $6, $7, 1,
          clock_timestamp() + interval '1 hour', '{}'::jsonb, $8,
          'HyperliquidTransaction:ApproveAgent', $9, $10,
          clock_timestamp() + interval '10 minutes', 'prepared', 0
        )
      `,
      values: [
        operationId,
        authority.ownerUserId,
        requestSha256,
        authority.agentIdentityId,
        accountAddress,
        authority.agentAddress,
        agentName,
        metadataSha256,
        signingDigest,
        typedDataJsonSha256,
      ],
    });
    await client.query({
      text: `
        insert into public.spot_agent_authorization_events (
          authorization_id, owner_user_id, request_id, actor_type, event_type,
          from_state, to_state, outcome, authorization_version
        )
        values ($1, $2, $3, 'api', 'authorization_prepared', null,
          'prepared', 'prepared', 0)
      `,
      values: [operationId, authority.ownerUserId, randomUUID()],
    });
    await insertSpotNonceAllocation(client, {
      operationId,
      ownerUserId: authority.ownerUserId,
      signerAddress: accountAddress,
      signerKind: "owner_wallet",
      purpose: "spot_agent_authorization",
    });

    await client.query({
      text: `
        with database_clock as (
          select clock_timestamp() as observed_at
        )
        update public.provider_operations
        set
          state = 'submitting',
          attempt_count = 1,
          transport_attempt_id = $2,
          attempt_committed_at = database_clock.observed_at,
          attempt_deadline_at = database_clock.observed_at + interval '10 seconds',
          record_version = 1,
          updated_at = database_clock.observed_at
        from database_clock
        where id = $1 and state = 'prepared'
      `,
      values: [operationId, transportAttemptId],
    });
    await client.query({
      text: `
        update public.spot_agent_authorizations
        set state = 'submitting', record_version = 1,
          updated_at = clock_timestamp()
        where id = $1 and state = 'prepared'
      `,
      values: [operationId],
    });
    await insertSubmissionAudit(client, {
      ownerUserId: authority.ownerUserId,
      operationId,
      transportAttemptId,
      eventType: "provider_submission_started",
      fromState: "prepared",
      toState: "submitting",
      fromReconciliationStatus: "not_required",
      toReconciliationStatus: "not_required",
      outcome: "attempt_committed",
      reasonCode: null,
      operationVersion: 1,
    });
    await client.query({
      text: `
        insert into public.spot_agent_authorization_events (
          authorization_id, owner_user_id, request_id, actor_type, event_type,
          from_state, to_state, outcome, authorization_version
        )
        values ($1, $2, $3, 'api', 'authorization_submitting', 'prepared',
          'submitting', 'attempt_committed', 1)
      `,
      values: [operationId, authority.ownerUserId, randomUUID()],
    });

    await client.query({
      text: `
        update public.provider_operations
        set
          state = 'unknown',
          reconciliation_status = 'pending',
          reconcile_after = clock_timestamp() - interval '1 millisecond',
          record_version = 2,
          updated_at = clock_timestamp()
        where id = $1 and state = 'submitting'
      `,
      values: [operationId],
    });
    await client.query({
      text: `
        update public.spot_agent_authorizations
        set
          state = 'unknown',
          result_observed_at = clock_timestamp(),
          result_reason_code = 'submission_transport_ambiguous',
          record_version = 2,
          updated_at = clock_timestamp()
        where id = $1 and state = 'submitting'
      `,
      values: [operationId],
    });
    await insertSubmissionAudit(client, {
      ownerUserId: authority.ownerUserId,
      operationId,
      transportAttemptId,
      eventType: "provider_submission_unknown",
      fromState: "submitting",
      toState: "unknown",
      fromReconciliationStatus: "not_required",
      toReconciliationStatus: "pending",
      outcome: "unknown",
      reasonCode: "submission_transport_ambiguous",
      operationVersion: 2,
    });
    await client.query({
      text: `
        insert into public.spot_agent_authorization_events (
          authorization_id, owner_user_id, request_id, actor_type, event_type,
          from_state, to_state, outcome, reason_code, authorization_version
        )
        values ($1, $2, $3, 'api', 'authorization_submission_unknown',
          'submitting', 'unknown', 'unknown',
          'submission_transport_ambiguous', 2)
      `,
      values: [operationId, authority.ownerUserId, randomUUID()],
    });

    return Object.freeze({ ...authority, operationId });
  });
}

async function readIntentSnapshot(
  pool: InstanceType<typeof Pool>,
  operationId: string,
): Promise<IntentProjectionSnapshot> {
  const result = await pool.query<IntentProjectionSnapshot>({
    text: `
      select
        operation.state as operation_state,
        operation.reconciliation_status,
        operation.reconciliation_attempt_count,
        operation.reconcile_after,
        operation.operator_required_at,
        operation.lease_owner,
        operation.lease_expires_at,
        operation.fence_token::text as fence_token,
        operation.record_version::text as operation_version,
        intent.state as intent_state,
        intent.record_version::text as intent_version,
        (
          select count(*)::text
          from public.audit_events as audit_count
          where audit_count.operation_id = operation.id
        ) as operation_event_count,
        (
          select count(*)::text
          from public.spot_intent_events as intent_count
          where intent_count.intent_id = intent.id
        ) as intent_event_count,
        latest_operation.from_reconciliation_status
          as latest_operation_from_status,
        latest_operation.to_reconciliation_status
          as latest_operation_to_status,
        latest_operation.reason_code as latest_operation_reason_code,
        latest_operation.operation_version::text
          as latest_operation_event_version,
        latest_intent.from_state as latest_intent_from_state,
        latest_intent.to_state as latest_intent_to_state,
        latest_intent.reason_code as latest_intent_reason_code,
        latest_intent.intent_version::text as latest_intent_event_version
      from public.provider_operations as operation
      join public.spot_intents as intent on intent.id = operation.id
      join lateral (
        select
          from_reconciliation_status,
          to_reconciliation_status,
          reason_code,
          operation_version
        from public.audit_events
        where operation_id = operation.id
        order by operation_version desc
        limit 1
      ) as latest_operation on true
      join lateral (
        select from_state, to_state, reason_code, intent_version
        from public.spot_intent_events
        where intent_id = intent.id
        order by intent_version desc
        limit 1
      ) as latest_intent on true
      where operation.id = $1
    `,
    values: [operationId],
  });
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("Spot reconciliation projection fixture is missing");
  }
  return row;
}

async function readAgentAuthorizationProjection(
  pool: InstanceType<typeof Pool>,
  operationId: string,
): Promise<
  Readonly<{
    operation_state: string;
    reconciliation_status: string;
    reconciliation_attempt_count: number;
    lease_owner: string | null;
    fence_token: string;
    operation_version: string;
    authorization_state: string;
    authorization_version: string;
  }>
> {
  const result = await pool.query<{
    operation_state: string;
    reconciliation_status: string;
    reconciliation_attempt_count: number;
    lease_owner: string | null;
    fence_token: string;
    operation_version: string;
    authorization_state: string;
    authorization_version: string;
  }>({
    text: `
      select
        operation.state as operation_state,
        operation.reconciliation_status,
        operation.reconciliation_attempt_count,
        operation.lease_owner,
        operation.fence_token::text as fence_token,
        operation.record_version::text as operation_version,
        agent_authorization.state as authorization_state,
        agent_authorization.record_version::text as authorization_version
      from public.provider_operations as operation
      join public.spot_agent_authorizations as agent_authorization
        on agent_authorization.id = operation.id
      where operation.id = $1
    `,
    values: [operationId],
  });
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("Spot Agent authorization projection fixture is missing");
  }
  return row;
}

async function waitForClaimedOperationLockWait(
  pool: InstanceType<typeof Pool>,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query<{ waiting: boolean }>({
      text: `
        select exists (
          select 1
          from pg_catalog.pg_stat_activity
          where datname = current_database()
            and pid <> pg_backend_pid()
            and wait_event_type = 'Lock'
            and position('loop_lock_claimed_spot_operation' in query) > 0
        ) as waiting
      `,
    });
    if (result.rows[0]?.waiting === true) {
      return;
    }
    await pool.query("select pg_sleep(0.01)");
  }
  throw new Error("The claimed Spot subject read did not wait on its row lock");
}

async function waitForClaimedIntentLockWait(
  pool: InstanceType<typeof Pool>,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await pool.query<{ waiting: boolean }>({
      text: `
        select exists (
          select 1
          from pg_catalog.pg_stat_activity
          where datname = current_database()
            and pid <> pg_backend_pid()
            and wait_event_type = 'Lock'
            and position('loop_lock_claimed_spot_intent' in query) > 0
        ) as waiting
      `,
    });
    if (result.rows[0]?.waiting === true) {
      return;
    }
    await pool.query("select pg_sleep(0.01)");
  }
  throw new Error(
    "The claimed Spot subject read did not wait on its intent lock",
  );
}

async function dropSpotReconciliationFaultInjection(
  pool: InstanceType<typeof Pool>,
): Promise<void> {
  await pool.query(`
    drop trigger if exists fail_spot_reconciliation_lease_audit_for_test
      on public.audit_events;
    drop trigger if exists fail_spot_reconciliation_reschedule_event_for_test
      on public.spot_intent_events;
    drop trigger if exists fail_spot_reconciliation_operator_commit_for_test
      on public.spot_intent_events;
    drop function if exists
      public.fail_spot_reconciliation_lease_audit_for_test();
    drop function if exists
      public.fail_spot_reconciliation_reschedule_event_for_test();
    drop function if exists
      public.fail_spot_reconciliation_operator_commit_for_test();
  `);
}

describe("PostgreSQL Spot reconciliation repository", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const repository = createPostgresSpotReconciliationRepository(pool);
  const truncateFixtureState = `
    truncate table
      public.hyperliquid_signer_nonce_allocations,
      public.hyperliquid_signer_nonce_state,
      public.loop_users
    cascade
  `;

  beforeEach(async () => {
    await dropSpotReconciliationFaultInjection(pool);
    await pool.query(truncateFixtureState);
  });

  afterAll(async () => {
    await dropSpotReconciliationFaultInjection(pool);
    await pool.query(truncateFixtureState);
    await pool.end();
  });

  it("atomically leases one due Spot intent, excludes Agent authorization, and loads only read authority", async () => {
    const intent = await seedUnknownSpotIntent(pool, "lease-intent");
    const authorization = await seedUnknownSpotAgentAuthorization(
      pool,
      "lease-authorization",
    );
    const workerIds = [randomUUID(), randomUUID()] as const;
    const leases = await Promise.all(
      workerIds.map((workerId) =>
        repository.leaseProviderOperationsForReconciliation({
          workerId,
          requestId: randomUUID(),
          limit: 1,
          leaseDurationMs: 30_000,
        }),
      ),
    );

    expect(leases.flat()).toHaveLength(1);
    const winnerIndex = leases.findIndex((lease) => lease.length === 1);
    expect(winnerIndex).toBeGreaterThanOrEqual(0);
    const workerId = workerIds[winnerIndex];
    const lease = leases[winnerIndex]?.[0];
    if (workerId === undefined || lease === undefined) {
      throw new Error("One Spot intent lease was expected");
    }
    expect(lease).toMatchObject({
      id: intent.operationId,
      ownerUserId: intent.ownerUserId,
      domain: "hyperliquid",
      operationKind: "spot_intent",
      state: "unknown",
      reconciliationStatus: "leased",
      reconciliationAttemptCount: 1,
      leaseOwner: workerId,
      fenceToken: "1",
      recordVersion: "3",
    });
    expect(await readIntentSnapshot(pool, intent.operationId)).toMatchObject({
      operation_state: "unknown",
      reconciliation_status: "leased",
      reconciliation_attempt_count: 1,
      lease_owner: workerId,
      fence_token: "1",
      operation_version: "3",
      intent_state: "reconciling",
      intent_version: "3",
      operation_event_count: "4",
      intent_event_count: "4",
      latest_operation_from_status: "pending",
      latest_operation_to_status: "leased",
      latest_operation_event_version: "3",
      latest_intent_from_state: "unknown",
      latest_intent_to_state: "reconciling",
      latest_intent_event_version: "3",
    });
    expect(
      await readAgentAuthorizationProjection(pool, authorization.operationId),
    ).toEqual({
      operation_state: "unknown",
      reconciliation_status: "pending",
      reconciliation_attempt_count: 0,
      lease_owner: null,
      fence_token: "0",
      operation_version: "2",
      authorization_state: "unknown",
      authorization_version: "2",
    });

    const subject = await repository.loadClaimedSpotIntentSubject({
      ownerUserId: intent.ownerUserId,
      operationId: intent.operationId,
      workerId,
      fenceToken: lease.fenceToken,
      recordVersion: lease.recordVersion,
    });
    expect(Number.isNaN(Date.parse(subject.attemptCommittedAt))).toBe(false);
    expect(subject).toEqual({
      operationId: intent.operationId,
      ownerUserId: intent.ownerUserId,
      network: "testnet",
      transportAttemptId: intent.transportAttemptId,
      attemptCommittedAt: subject.attemptCommittedAt,
      intentRecordVersion: "3",
      marketId: intent.marketId,
      providerCoin: "PURR/USDC",
      baseTokenIndex: 1,
      baseTokenId,
      baseDisplayIdentity: "PURR",
      quoteTokenIndex: 0,
      quoteTokenId,
      quoteDisplayIdentity: "USDC",
      spotPairIndex: 0,
      exchangeOrderAsset: 10_000,
      side: "buy",
      amountMode: "quote",
      amountValue: "10",
      computedBaseSize: "0.2",
      worstIocLimitPrice: "50",
      accountAddress,
      accountKind: "master",
      clientOrderId: intent.clientOrderId,
      canonicalAction: {
        type: "order",
        orders: [
          {
            a: 10_000,
            b: true,
            p: "50",
            s: "0.2",
            r: false,
            t: { limit: { tif: "Ioc" } },
            c: intent.clientOrderId,
          },
        ],
        grouping: "na",
      },
    });
    expect(Object.isFrozen(subject.canonicalAction)).toBe(true);
    expect(Object.isFrozen(subject.canonicalAction.orders)).toBe(true);
    expect(Object.isFrozen(subject.canonicalAction.orders[0])).toBe(true);
    expect(Object.isFrozen(subject.canonicalAction.orders[0].t)).toBe(true);
    expect(Object.isFrozen(subject.canonicalAction.orders[0].t.limit)).toBe(
      true,
    );
    expect(
      Reflect.set(subject.canonicalAction.orders[0].t.limit, "tif", "Gtc"),
    ).toBe(false);
    expect(subject.canonicalAction.orders[0].t.limit.tif).toBe("Ioc");
    const serializedSubject = JSON.stringify(subject).toLowerCase();
    for (const forbidden of [
      "signerref",
      "signer_ref",
      "nonce",
      "signature",
      "rawprovider",
      "raw_provider",
    ]) {
      expect(serializedSubject).not.toContain(forbidden);
    }
  });

  it("fails closed when the stored review digest does not bind the public review", async () => {
    const intent = await seedUnknownSpotIntent(pool, "review-digest-mismatch", {
      reviewSha256: "f".repeat(64),
    });
    const workerId = randomUUID();
    const lease = (
      await repository.leaseProviderOperationsForReconciliation({
        workerId,
        requestId: randomUUID(),
        limit: 1,
        leaseDurationMs: 30_000,
      })
    )[0];
    if (lease === undefined) {
      throw new Error("The review-digest mismatch fixture was not leased");
    }
    const baseline = await readIntentSnapshot(pool, intent.operationId);

    await expect(
      repository.loadClaimedSpotIntentSubject({
        ownerUserId: intent.ownerUserId,
        operationId: intent.operationId,
        workerId,
        fenceToken: lease.fenceToken,
        recordVersion: lease.recordVersion,
      }),
    ).rejects.toBeInstanceOf(SpotReconciliationRepositoryUnavailableError);
    expect(await readIntentSnapshot(pool, intent.operationId)).toEqual(
      baseline,
    );
  });

  it("reclaims an expired lease with a new generic fence while preserving the reconciling projection version", async () => {
    const intent = await seedUnknownSpotIntent(pool, "expired-reclaim");
    const firstWorkerId = randomUUID();
    const firstLease = (
      await repository.leaseProviderOperationsForReconciliation({
        workerId: firstWorkerId,
        requestId: randomUUID(),
        limit: 1,
        leaseDurationMs: 30_000,
      })
    )[0];
    if (firstLease === undefined) {
      throw new Error("The initial Spot intent lease was not created");
    }
    await pool.query({
      text: `
        update public.provider_operations
        set lease_expires_at = clock_timestamp() - interval '1 millisecond'
        where id = $1
      `,
      values: [intent.operationId],
    });

    const secondWorkerId = randomUUID();
    const secondLease = (
      await repository.leaseProviderOperationsForReconciliation({
        workerId: secondWorkerId,
        requestId: randomUUID(),
        limit: 1,
        leaseDurationMs: 30_000,
      })
    )[0];
    expect(secondLease).toMatchObject({
      id: intent.operationId,
      reconciliationStatus: "leased",
      reconciliationAttemptCount: 2,
      leaseOwner: secondWorkerId,
      fenceToken: "2",
      recordVersion: "4",
    });
    const snapshot = await readIntentSnapshot(pool, intent.operationId);
    expect(snapshot).toMatchObject({
      operation_state: "unknown",
      reconciliation_status: "leased",
      reconciliation_attempt_count: 2,
      lease_owner: secondWorkerId,
      fence_token: "2",
      operation_version: "4",
      intent_state: "reconciling",
      intent_version: "3",
      operation_event_count: "5",
      intent_event_count: "4",
      latest_operation_from_status: "leased",
      latest_operation_to_status: "leased",
      latest_operation_event_version: "4",
      latest_intent_from_state: "unknown",
      latest_intent_to_state: "reconciling",
      latest_intent_event_version: "3",
    });
    await expect(
      repository.rescheduleProviderOperationReconciliation({
        ownerUserId: intent.ownerUserId,
        operationId: intent.operationId,
        workerId: firstWorkerId,
        fenceToken: firstLease.fenceToken,
        recordVersion: firstLease.recordVersion,
        requestId: randomUUID(),
        reasonCode: "authoritative_result_pending",
        retryDelayMs: 5_000,
      }),
    ).rejects.toBeInstanceOf(StaleProviderOperationLeaseError);
    expect(await readIntentSnapshot(pool, intent.operationId)).toEqual(
      snapshot,
    );

    if (secondLease === undefined) {
      throw new Error("The expired Spot intent lease was not reclaimed");
    }
    const rescheduled =
      await repository.rescheduleProviderOperationReconciliation({
        ownerUserId: intent.ownerUserId,
        operationId: intent.operationId,
        workerId: secondWorkerId,
        fenceToken: secondLease.fenceToken,
        recordVersion: secondLease.recordVersion,
        requestId: randomUUID(),
        reasonCode: "authoritative_result_pending",
        retryDelayMs: 5_000,
      });
    expect(rescheduled).toMatchObject({
      reconciliationStatus: "pending",
      reconciliationAttemptCount: 2,
      leaseOwner: null,
      leaseExpiresAt: null,
      fenceToken: "2",
      recordVersion: "5",
    });
    expect(await readIntentSnapshot(pool, intent.operationId)).toMatchObject({
      operation_state: "unknown",
      reconciliation_status: "pending",
      reconciliation_attempt_count: 2,
      lease_owner: null,
      lease_expires_at: null,
      fence_token: "2",
      operation_version: "5",
      intent_state: "unknown",
      intent_version: "4",
      operation_event_count: "6",
      intent_event_count: "5",
      latest_operation_from_status: "leased",
      latest_operation_to_status: "pending",
      latest_operation_reason_code: "authoritative_result_pending",
      latest_operation_event_version: "5",
      latest_intent_from_state: "reconciling",
      latest_intent_to_state: "unknown",
      latest_intent_reason_code: "authoritative_result_pending",
      latest_intent_event_version: "4",
    });
  });

  it("rechecks the database-clock lease after a claimed-subject read waits on the operation row", async () => {
    const intent = await seedUnknownSpotIntent(pool, "load-lock-expiry");
    const workerId = randomUUID();
    const lease = (
      await repository.leaseProviderOperationsForReconciliation({
        workerId,
        requestId: randomUUID(),
        limit: 1,
        leaseDurationMs: 30_000,
      })
    )[0];
    if (lease === undefined) {
      throw new Error("The claimed-subject lock fixture was not leased");
    }
    await pool.query({
      text: `
        update public.provider_operations
        set lease_expires_at = clock_timestamp() + interval '300 milliseconds'
        where id = $1
      `,
      values: [intent.operationId],
    });
    const baseline = await readIntentSnapshot(pool, intent.operationId);
    const blocker = await pool.connect();
    let blockerOpen = false;
    try {
      await blocker.query("begin");
      blockerOpen = true;
      await blocker.query({
        text: `
          select id
          from public.provider_operations
          where id = $1
          for update
        `,
        values: [intent.operationId],
      });
      const outcome = repository
        .loadClaimedSpotIntentSubject({
          ownerUserId: intent.ownerUserId,
          operationId: intent.operationId,
          workerId,
          fenceToken: lease.fenceToken,
          recordVersion: lease.recordVersion,
        })
        .then(
          (subject) => subject,
          (error: unknown) => error,
        );
      await waitForClaimedOperationLockWait(pool);
      await blocker.query("select pg_sleep(0.35)");
      await blocker.query("commit");
      blockerOpen = false;

      await expect(outcome).resolves.toBeInstanceOf(
        StaleProviderOperationLeaseError,
      );
      expect(await readIntentSnapshot(pool, intent.operationId)).toEqual(
        baseline,
      );
    } finally {
      if (blockerOpen) {
        await blocker.query("rollback");
      }
      blocker.release();
    }
  });

  it("rechecks the database-clock lease after the operation is locked but the intent row blocks the subject read", async () => {
    const intent = await seedUnknownSpotIntent(pool, "load-intent-lock-expiry");
    const workerId = randomUUID();
    const lease = (
      await repository.leaseProviderOperationsForReconciliation({
        workerId,
        requestId: randomUUID(),
        limit: 1,
        leaseDurationMs: 30_000,
      })
    )[0];
    if (lease === undefined) {
      throw new Error("The claimed intent-lock fixture was not leased");
    }
    await pool.query({
      text: `
        update public.provider_operations
        set lease_expires_at = clock_timestamp() + interval '300 milliseconds'
        where id = $1
      `,
      values: [intent.operationId],
    });
    const baseline = await readIntentSnapshot(pool, intent.operationId);
    const blocker = await pool.connect();
    let blockerOpen = false;
    try {
      await blocker.query("begin");
      blockerOpen = true;
      await blocker.query({
        text: `
          select id
          from public.spot_intents
          where id = $1
          for update
        `,
        values: [intent.operationId],
      });
      const outcome = repository
        .loadClaimedSpotIntentSubject({
          ownerUserId: intent.ownerUserId,
          operationId: intent.operationId,
          workerId,
          fenceToken: lease.fenceToken,
          recordVersion: lease.recordVersion,
        })
        .then(
          (subject) => subject,
          (error: unknown) => error,
        );
      await waitForClaimedIntentLockWait(pool);
      await blocker.query("select pg_sleep(0.35)");
      await blocker.query("commit");
      blockerOpen = false;

      await expect(outcome).resolves.toBeInstanceOf(
        StaleProviderOperationLeaseError,
      );
      expect(await readIntentSnapshot(pool, intent.operationId)).toEqual(
        baseline,
      );
    } finally {
      if (blockerOpen) {
        await blocker.query("rollback");
      }
      blocker.release();
    }
  });

  it("atomically reschedules a leased Spot intent back to unknown and appends both histories", async () => {
    const intent = await seedUnknownSpotIntent(pool, "reschedule");
    const workerId = randomUUID();
    const lease = (
      await repository.leaseProviderOperationsForReconciliation({
        workerId,
        requestId: randomUUID(),
        limit: 1,
        leaseDurationMs: 30_000,
      })
    )[0];
    if (lease === undefined) {
      throw new Error("The reschedule fixture was not leased");
    }

    const rescheduled =
      await repository.rescheduleProviderOperationReconciliation({
        ownerUserId: intent.ownerUserId,
        operationId: intent.operationId,
        workerId,
        fenceToken: lease.fenceToken,
        recordVersion: lease.recordVersion,
        requestId: randomUUID(),
        reasonCode: "authoritative_result_pending",
        retryDelayMs: 60_000,
      });
    expect(rescheduled).toMatchObject({
      state: "unknown",
      reconciliationStatus: "pending",
      reconciliationAttemptCount: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      fenceToken: "1",
      recordVersion: "4",
    });
    expect(rescheduled.reconcileAfter).not.toBeNull();
    expect(await readIntentSnapshot(pool, intent.operationId)).toMatchObject({
      operation_state: "unknown",
      reconciliation_status: "pending",
      reconciliation_attempt_count: 1,
      operator_required_at: null,
      lease_owner: null,
      lease_expires_at: null,
      fence_token: "1",
      operation_version: "4",
      intent_state: "unknown",
      intent_version: "4",
      operation_event_count: "5",
      intent_event_count: "5",
      latest_operation_from_status: "leased",
      latest_operation_to_status: "pending",
      latest_operation_reason_code: "authoritative_result_pending",
      latest_operation_event_version: "4",
      latest_intent_from_state: "reconciling",
      latest_intent_to_state: "unknown",
      latest_intent_reason_code: "authoritative_result_pending",
      latest_intent_event_version: "4",
    });
    await expect(
      repository.leaseProviderOperationsForReconciliation({
        workerId: randomUUID(),
        requestId: randomUUID(),
        limit: 1,
        leaseDurationMs: 30_000,
      }),
    ).resolves.toEqual([]);
  });

  it("atomically places a leased Spot intent on operator hold and never leases it again", async () => {
    const intent = await seedUnknownSpotIntent(pool, "operator-hold");
    const workerId = randomUUID();
    const lease = (
      await repository.leaseProviderOperationsForReconciliation({
        workerId,
        requestId: randomUUID(),
        limit: 1,
        leaseDurationMs: 30_000,
      })
    )[0];
    if (lease === undefined) {
      throw new Error("The operator-hold fixture was not leased");
    }

    const held = await repository.holdProviderOperationForOperator({
      ownerUserId: intent.ownerUserId,
      operationId: intent.operationId,
      workerId,
      fenceToken: lease.fenceToken,
      recordVersion: lease.recordVersion,
      requestId: randomUUID(),
      reasonCode: "provider_evidence_conflict",
    });
    expect(held).toMatchObject({
      state: "unknown",
      reconciliationStatus: "operator_required",
      reconciliationAttemptCount: 1,
      reconcileAfter: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      fenceToken: "1",
      recordVersion: "4",
    });
    expect(held.operatorRequiredAt).not.toBeNull();
    expect(await readIntentSnapshot(pool, intent.operationId)).toMatchObject({
      operation_state: "unknown",
      reconciliation_status: "operator_required",
      reconciliation_attempt_count: 1,
      reconcile_after: null,
      lease_owner: null,
      lease_expires_at: null,
      fence_token: "1",
      operation_version: "4",
      intent_state: "operator_required",
      intent_version: "4",
      operation_event_count: "5",
      intent_event_count: "5",
      latest_operation_from_status: "leased",
      latest_operation_to_status: "operator_required",
      latest_operation_reason_code: "provider_evidence_conflict",
      latest_operation_event_version: "4",
      latest_intent_from_state: "reconciling",
      latest_intent_to_state: "operator_required",
      latest_intent_reason_code: "provider_evidence_conflict",
      latest_intent_event_version: "4",
    });
    await expect(
      repository.leaseProviderOperationsForReconciliation({
        workerId: randomUUID(),
        requestId: randomUUID(),
        limit: 1,
        leaseDurationMs: 30_000,
      }),
    ).resolves.toEqual([]);
  });

  it("rolls the complete first lease back when its generic audit fails after the Spot event append", async () => {
    const intent = await seedUnknownSpotIntent(pool, "lease-audit-rollback");
    const baseline = await readIntentSnapshot(pool, intent.operationId);
    const workerId = randomUUID();
    await pool.query(`
      create function public.fail_spot_reconciliation_lease_audit_for_test()
      returns trigger
      language plpgsql
      as $function$
      begin
        if new.operation_id = '${intent.operationId}'::uuid
          and new.event_type = 'reconciliation_leased'
          and exists (
            select 1
            from public.spot_intent_events as event
            where event.intent_id = new.operation_id
              and event.event_type = 'intent_reconciliation_leased'
              and event.intent_version = 3
          )
        then
          raise exception 'forced Spot lease audit failure after domain event'
            using errcode = '23514';
        end if;
        return new;
      end;
      $function$;

      create trigger fail_spot_reconciliation_lease_audit_for_test
        before insert on public.audit_events
        for each row execute function
          public.fail_spot_reconciliation_lease_audit_for_test();
    `);
    try {
      await expect(
        repository.leaseProviderOperationsForReconciliation({
          workerId,
          requestId: randomUUID(),
          limit: 1,
          leaseDurationMs: 30_000,
        }),
      ).rejects.toBeInstanceOf(SpotReconciliationRepositoryUnavailableError);
      expect(await readIntentSnapshot(pool, intent.operationId)).toEqual(
        baseline,
      );
    } finally {
      await dropSpotReconciliationFaultInjection(pool);
    }

    await expect(
      repository.leaseProviderOperationsForReconciliation({
        workerId,
        requestId: randomUUID(),
        limit: 1,
        leaseDurationMs: 30_000,
      }),
    ).resolves.toMatchObject([
      {
        id: intent.operationId,
        reconciliationStatus: "leased",
        reconciliationAttemptCount: 1,
        leaseOwner: workerId,
        fenceToken: "1",
        recordVersion: "3",
      },
    ]);
    expect(await readIntentSnapshot(pool, intent.operationId)).toMatchObject({
      reconciliation_status: "leased",
      operation_version: "3",
      intent_state: "reconciling",
      intent_version: "3",
      operation_event_count: "4",
      intent_event_count: "4",
    });
  });

  it("rolls the complete reschedule back when its Spot event fails after the generic audit append", async () => {
    const intent = await seedUnknownSpotIntent(
      pool,
      "reschedule-event-rollback",
    );
    const workerId = randomUUID();
    const lease = (
      await repository.leaseProviderOperationsForReconciliation({
        workerId,
        requestId: randomUUID(),
        limit: 1,
        leaseDurationMs: 30_000,
      })
    )[0];
    if (lease === undefined) {
      throw new Error("The reschedule rollback fixture was not leased");
    }
    const baseline = await readIntentSnapshot(pool, intent.operationId);
    await pool.query(`
      create function
        public.fail_spot_reconciliation_reschedule_event_for_test()
      returns trigger
      language plpgsql
      as $function$
      begin
        if new.intent_id = '${intent.operationId}'::uuid
          and new.event_type = 'intent_reconciliation_rescheduled'
          and exists (
            select 1
            from public.audit_events as audit
            where audit.operation_id = new.intent_id
              and audit.event_type = 'reconciliation_rescheduled'
              and audit.operation_version = 4
          )
        then
          raise exception 'forced Spot reschedule event failure after audit'
            using errcode = '23514';
        end if;
        return new;
      end;
      $function$;

      create trigger fail_spot_reconciliation_reschedule_event_for_test
        before insert on public.spot_intent_events
        for each row execute function
          public.fail_spot_reconciliation_reschedule_event_for_test();
    `);
    const transition = {
      ownerUserId: intent.ownerUserId,
      operationId: intent.operationId,
      workerId,
      fenceToken: lease.fenceToken,
      recordVersion: lease.recordVersion,
      requestId: randomUUID(),
      reasonCode: "authoritative_result_pending",
      retryDelayMs: 5_000,
    } as const;
    try {
      await expect(
        repository.rescheduleProviderOperationReconciliation(transition),
      ).rejects.toBeInstanceOf(SpotReconciliationRepositoryUnavailableError);
      expect(await readIntentSnapshot(pool, intent.operationId)).toEqual(
        baseline,
      );
    } finally {
      await dropSpotReconciliationFaultInjection(pool);
    }

    await expect(
      repository.rescheduleProviderOperationReconciliation({
        ...transition,
        requestId: randomUUID(),
      }),
    ).resolves.toMatchObject({
      reconciliationStatus: "pending",
      reconciliationAttemptCount: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      fenceToken: "1",
      recordVersion: "4",
    });
    expect(await readIntentSnapshot(pool, intent.operationId)).toMatchObject({
      reconciliation_status: "pending",
      operation_version: "4",
      intent_state: "unknown",
      intent_version: "4",
      operation_event_count: "5",
      intent_event_count: "5",
    });
  });

  it("rolls the complete operator hold back when its deferred constraint fails at commit", async () => {
    const intent = await seedUnknownSpotIntent(
      pool,
      "operator-commit-rollback",
    );
    const workerId = randomUUID();
    const lease = (
      await repository.leaseProviderOperationsForReconciliation({
        workerId,
        requestId: randomUUID(),
        limit: 1,
        leaseDurationMs: 30_000,
      })
    )[0];
    if (lease === undefined) {
      throw new Error("The operator rollback fixture was not leased");
    }
    const baseline = await readIntentSnapshot(pool, intent.operationId);
    await pool.query(`
      create function
        public.fail_spot_reconciliation_operator_commit_for_test()
      returns trigger
      language plpgsql
      as $function$
      begin
        if new.intent_id = '${intent.operationId}'::uuid
          and new.event_type = 'intent_reconciliation_operator_required'
        then
          raise exception 'forced deferred Spot operator commit failure'
            using errcode = '23514';
        end if;
        return new;
      end;
      $function$;

      create constraint trigger
        fail_spot_reconciliation_operator_commit_for_test
        after insert on public.spot_intent_events
        deferrable initially deferred
        for each row execute function
          public.fail_spot_reconciliation_operator_commit_for_test();
    `);
    const transition = {
      ownerUserId: intent.ownerUserId,
      operationId: intent.operationId,
      workerId,
      fenceToken: lease.fenceToken,
      recordVersion: lease.recordVersion,
      requestId: randomUUID(),
      reasonCode: "provider_evidence_conflict",
    } as const;
    try {
      await expect(
        repository.holdProviderOperationForOperator(transition),
      ).rejects.toBeInstanceOf(SpotReconciliationRepositoryUnavailableError);
      expect(await readIntentSnapshot(pool, intent.operationId)).toEqual(
        baseline,
      );
    } finally {
      await dropSpotReconciliationFaultInjection(pool);
    }

    await expect(
      repository.holdProviderOperationForOperator({
        ...transition,
        requestId: randomUUID(),
      }),
    ).resolves.toMatchObject({
      reconciliationStatus: "operator_required",
      reconciliationAttemptCount: 1,
      reconcileAfter: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      fenceToken: "1",
      recordVersion: "4",
    });
    expect(await readIntentSnapshot(pool, intent.operationId)).toMatchObject({
      reconciliation_status: "operator_required",
      operation_version: "4",
      intent_state: "operator_required",
      intent_version: "4",
      operation_event_count: "5",
      intent_event_count: "5",
    });
  });

  it("rejects stale owner, worker, fence, record version, and database-expired leases without mutation", async () => {
    const intent = await seedUnknownSpotIntent(pool, "stale-lease");
    const workerId = randomUUID();
    const lease = (
      await repository.leaseProviderOperationsForReconciliation({
        workerId,
        requestId: randomUUID(),
        limit: 1,
        leaseDurationMs: 30_000,
      })
    )[0];
    if (lease === undefined) {
      throw new Error("The stale-lease fixture was not leased");
    }
    const baseline = await readIntentSnapshot(pool, intent.operationId);
    const baseInput = {
      ownerUserId: intent.ownerUserId,
      operationId: intent.operationId,
      workerId,
      fenceToken: lease.fenceToken,
      recordVersion: lease.recordVersion,
      requestId: randomUUID(),
      reasonCode: "authoritative_result_pending",
      retryDelayMs: 5_000,
    } as const;
    for (const stale of [
      { ...baseInput, ownerUserId: randomUUID(), requestId: randomUUID() },
      { ...baseInput, workerId: randomUUID(), requestId: randomUUID() },
      {
        ...baseInput,
        fenceToken: String(BigInt(lease.fenceToken) + 1n),
        requestId: randomUUID(),
      },
      {
        ...baseInput,
        recordVersion: String(BigInt(lease.recordVersion) + 1n),
        requestId: randomUUID(),
      },
    ]) {
      await expect(
        repository.rescheduleProviderOperationReconciliation(stale),
      ).rejects.toBeInstanceOf(StaleProviderOperationLeaseError);
      expect(await readIntentSnapshot(pool, intent.operationId)).toEqual(
        baseline,
      );
    }

    await pool.query({
      text: `
        update public.provider_operations
        set lease_expires_at = clock_timestamp() - interval '1 millisecond'
        where id = $1
      `,
      values: [intent.operationId],
    });
    const expiredBaseline = await readIntentSnapshot(pool, intent.operationId);
    await expect(
      repository.rescheduleProviderOperationReconciliation({
        ...baseInput,
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(StaleProviderOperationLeaseError);
    expect(await readIntentSnapshot(pool, intent.operationId)).toEqual(
      expiredBaseline,
    );
  });

  it("keeps generic completion fail closed for Spot and leaves both projections unchanged", async () => {
    const intent = await seedUnknownSpotIntent(pool, "complete-denied");
    const workerId = randomUUID();
    const lease = (
      await repository.leaseProviderOperationsForReconciliation({
        workerId,
        requestId: randomUUID(),
        limit: 1,
        leaseDurationMs: 30_000,
      })
    )[0];
    if (lease === undefined) {
      throw new Error("The completion-denial fixture was not leased");
    }
    const baseline = await readIntentSnapshot(pool, intent.operationId);

    await expect(
      repository.completeProviderOperationReconciliation({
        ownerUserId: intent.ownerUserId,
        operationId: intent.operationId,
        workerId,
        fenceToken: lease.fenceToken,
        recordVersion: lease.recordVersion,
        requestId: randomUUID(),
        state: "succeeded",
      }),
    ).rejects.toBeInstanceOf(StaleProviderOperationLeaseError);
    expect(await readIntentSnapshot(pool, intent.operationId)).toEqual(
      baseline,
    );
  });
});
