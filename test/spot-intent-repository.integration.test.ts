import { createHash, randomUUID } from "node:crypto";

import pg from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  createPostgresControlPlaneRepository,
  IdempotencyConflictError,
  StaleProviderOperationLeaseError,
} from "../src/database/control-plane-repository.js";
import { HYPERLIQUID_SIGNER_NONCE_FUTURE_WINDOW_MILLISECONDS } from "../src/database/hyperliquid-signer-nonce.js";
import {
  createPostgresSpotAgentAuthorizationRepository,
  SPOT_AGENT_AUTHORIZATION_ADMISSION_MAX_MILLISECONDS,
  SPOT_AGENT_AUTHORIZATION_POLICY_VERSION,
  type ComputeSpotAgentAuthorizationSigningDigest,
  type IssueSpotAgentAuthorizationInput,
  type MaterializeSpotAgentAuthorizationForNonce,
  type SpotAgentAuthorizationMaterializationContext,
} from "../src/database/spot-agent-authorization-repository.js";
import {
  createPostgresSpotIntentRepository,
  SPOT_INTENT_PENDING_CLAIM_LEASE_MILLISECONDS,
  SPOT_INTENT_PENDING_CLAIM_LIMIT_PER_OWNER,
  SPOT_INTENT_PREPARE_AUTHORITY_LEASE_MILLISECONDS,
  SPOT_INTENT_SUBMISSION_ACCOUNT_EVIDENCE_LEASE_MILLISECONDS,
  SPOT_INTENT_SUBMISSION_AUTHORITY_LEASE_MILLISECONDS,
  SPOT_INTENT_SUBMISSION_ATTEMPT_MILLISECONDS,
  SPOT_INTENT_SUBMISSION_METADATA_LEASE_MILLISECONDS,
  SpotIntentAuthorityStaleError,
  SpotIntentClaimLimitExceededError,
  SpotIntentPrepareClaimRequiredError,
  SpotIntentPrepareExpiredError,
  SpotIntentRepositoryUnavailableError,
  SpotIntentSubmissionConflictError,
  type BeginSpotIntentSubmissionInput,
  type PostgresSpotIntentRepository,
  type PrepareSpotIntentInput,
  type SpotIntentRecord,
  type SpotIntentRepository,
} from "../src/database/spot-intent-repository.js";
import {
  createSpotReview,
  parseSpotIntentResource,
  parseSpotReview,
  SPOT_INTENT_IDEMPOTENCY_SCOPE,
  SPOT_INTENT_REQUEST_DIGEST_VERSION,
} from "../src/features/spot/spot-intent-contract.js";
import type {
  SpotIntentSubmissionPreflight,
  SpotIocExchangeWriter,
  SpotIocSigner,
} from "../src/features/spot/spot-intent-submission.js";
import { createSpotIntentSubmissionWorkflow } from "../src/features/spot/spot-intent-submission-workflow.js";

const { Pool } = pg;
const databaseUrl = process.env["DATABASE_URL"];

if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error("DATABASE_URL is required for the integration test suite");
}

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const metadataSha256 = "c".repeat(64);
const accountAddress = `0x${"1".repeat(40)}`;
const rotatedAccountAddress = `0x${"9".repeat(40)}`;
const baseTokenId = `0x${"2".repeat(32)}`;
const quoteTokenId = `0x${"3".repeat(32)}`;
const metadataVersion = metadataSha256;
const policyVersion = "spot_ioc_v1";

interface OwnerFixture {
  readonly ownerUserId: string;
  readonly privyUserId: string;
}

interface AuthorityFixture extends OwnerFixture {
  readonly agentIdentityId: string;
  readonly authorizationId: string;
  readonly walletId: string;
  readonly walletVerifiedAt: string;
  readonly walletExpiresAt: string;
  readonly agentValidUntil: string;
}

interface AuthorityTimes {
  readonly verifiedAt: string;
  readonly expiresAt: string;
  readonly signingExpiresAt: string;
  readonly agentValidUntil: string;
}

function randomHex(length: number): string {
  return Array.from({ length: Math.ceil(length / 32) }, () =>
    randomUUID().replaceAll("-", ""),
  )
    .join("")
    .slice(0, length);
}

function timestampWindow(
  overrides: {
    readonly factsOffsetMs?: number;
    readonly referenceOffsetMs?: number;
    readonly feeOffsetMs?: number;
    readonly expiresOffsetMs?: number;
  } = {},
): {
  readonly factsObservedAt: string;
  readonly referenceSourceTime: string;
  readonly feeObservedAt: string;
  readonly expiresAt: string;
} {
  const now = Date.now();
  return {
    factsObservedAt: new Date(
      now + (overrides.factsOffsetMs ?? -1_000),
    ).toISOString(),
    referenceSourceTime: new Date(
      now + (overrides.referenceOffsetMs ?? -1_500),
    ).toISOString(),
    feeObservedAt: new Date(
      now + (overrides.feeOffsetMs ?? -1_250),
    ).toISOString(),
    expiresAt: new Date(
      now + (overrides.expiresOffsetMs ?? 55_000),
    ).toISOString(),
  };
}

async function insertOwner(
  pool: InstanceType<typeof Pool>,
  label: string,
): Promise<OwnerFixture> {
  const privyUserId = `did:privy:spot-intent:${label}:${randomUUID()}`;
  const inserted = await pool.query<{ id: string }>({
    text: `
      insert into public.loop_users (privy_user_id)
      values ($1)
      returning id
    `,
    values: [privyUserId],
  });
  const ownerUserId = inserted.rows[0]?.id;
  if (ownerUserId === undefined) {
    throw new Error("Spot intent owner fixture failed");
  }
  return Object.freeze({ ownerUserId, privyUserId });
}

async function authorityTimes(
  pool: InstanceType<typeof Pool>,
  overrides: {
    readonly signingExpiresOffsetMs?: number;
    readonly agentValidUntilOffsetMs?: number;
  } = {},
): Promise<AuthorityTimes> {
  const result = await pool.query<{
    verified_at: Date;
    expires_at: Date;
    signing_expires_at: Date;
    agent_valid_until: Date;
  }>({
    text: `
      with database_clock as (
        select clock_timestamp() as observed_at
      )
      select
        observed_at - interval '100 milliseconds' as verified_at,
        observed_at + interval '14 seconds' as expires_at,
        observed_at
          + ($1::bigint * interval '1 millisecond') as signing_expires_at,
        observed_at
          + ($2::bigint * interval '1 millisecond') as agent_valid_until
      from database_clock
    `,
    values: [
      overrides.signingExpiresOffsetMs ?? 120_000,
      overrides.agentValidUntilOffsetMs ?? 3_600_000,
    ],
  });
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("Spot intent Agent authority clock fixture failed");
  }
  return Object.freeze({
    verifiedAt: row.verified_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    signingExpiresAt: row.signing_expires_at.toISOString(),
    agentValidUntil: row.agent_valid_until.toISOString(),
  });
}

function authorizationTypedData(
  context: SpotAgentAuthorizationMaterializationContext,
): Record<string, unknown> {
  return {
    domain: {
      name: "HyperliquidSignTransaction",
      version: "1",
      chainId: 421_614,
      verifyingContract: `0x${"0".repeat(40)}`,
    },
    types: {
      "HyperliquidTransaction:ApproveAgent": [
        { name: "hyperliquidChain", type: "string" },
        { name: "agentAddress", type: "address" },
        { name: "agentName", type: "string" },
        { name: "nonce", type: "uint64" },
      ],
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
    },
    primaryType: "HyperliquidTransaction:ApproveAgent",
    message: {
      type: "approveAgent",
      agentAddress: context.agentAddress,
      agentName: context.agentName,
      nonce: Number(context.authorizationNonce),
      signatureChainId: "0x66eee",
      hyperliquidChain: "Testnet",
    },
  };
}

function digestTypedData(value: unknown): string {
  return `0x${createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex")}`;
}

const computeAuthorizationSigningDigest: ComputeSpotAgentAuthorizationSigningDigest =
  digestTypedData;

const materializeAuthorizationForNonce: MaterializeSpotAgentAuthorizationForNonce =
  (context) => {
    const typedData = authorizationTypedData(context);
    return Object.freeze({
      typedData,
      signingDigest: digestTypedData(typedData),
    });
  };

async function activateAuthorization(
  pool: InstanceType<typeof Pool>,
  authority: Pick<
    AuthorityFixture,
    "ownerUserId" | "agentIdentityId" | "authorizationId"
  >,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const attemptId = randomUUID();
    await client.query({
      text: `
        with database_clock as (
          select clock_timestamp() as observed_at
        )
        update public.provider_operations as operation
        set
          state = 'submitting',
          attempt_count = 1,
          transport_attempt_id = $2,
          attempt_committed_at = database_clock.observed_at,
          attempt_deadline_at = database_clock.observed_at + interval '5 seconds',
          record_version = 1,
          updated_at = database_clock.observed_at
        from database_clock
        where operation.id = $1 and operation.state = 'prepared'
      `,
      values: [authority.authorizationId, attemptId],
    });
    await client.query({
      text: `
        update public.spot_agent_authorizations
        set
          state = 'submitting',
          record_version = 1,
          updated_at = clock_timestamp()
        where id = $1 and state = 'prepared'
      `,
      values: [authority.authorizationId],
    });
    await client.query({
      text: `
        update public.provider_operations
        set
          state = 'succeeded',
          record_version = 2,
          updated_at = clock_timestamp()
        where id = $1 and state = 'submitting'
      `,
      values: [authority.authorizationId],
    });
    await client.query({
      text: `
        update public.spot_agent_authorizations
        set
          state = 'active',
          result_observed_at = clock_timestamp(),
          record_version = 2,
          updated_at = clock_timestamp()
        where id = $1 and state = 'submitting'
      `,
      values: [authority.authorizationId],
    });
    await client.query({
      text: `
        update public.spot_agent_identities
        set
          lifecycle_state = 'active',
          record_version = 2,
          updated_at = clock_timestamp()
        where id = $1
          and owner_user_id = $2
          and lifecycle_state = 'authorization_pending'
      `,
      values: [authority.agentIdentityId, authority.ownerUserId],
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
        values
          ($1, $2, $3, 'api', 'authorization_submitting', 'prepared',
           'submitting', 'attempt_committed', 1),
          ($1, $2, $4, 'worker', 'authorization_activated', 'submitting',
           'active', 'active', 2)
      `,
      values: [
        authority.authorizationId,
        authority.ownerUserId,
        randomUUID(),
        randomUUID(),
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
        values (
          $1, $2, $3, 'worker', 'authorization_activated',
          'authorization_pending', 'active', 'active', 2
        )
      `,
      values: [authority.agentIdentityId, authority.ownerUserId, randomUUID()],
    });
    await client.query("set constraints all immediate");
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function seedAuthority(
  pool: InstanceType<typeof Pool>,
  label: string,
  options: {
    readonly activate?: boolean;
    readonly signingExpiresOffsetMs?: number;
    readonly agentValidUntilOffsetMs?: number;
  } = {},
): Promise<AuthorityFixture> {
  const owner = await insertOwner(pool, label);
  const walletId = `wallet-${randomUUID()}`;
  await pool.query({
    text: `
      insert into public.perp_wallet_bindings (
        owner_user_id,
        privy_user_id,
        binding_state,
        wallet_id,
        account_address,
        account_kind,
        binding_version,
        last_verified_at
      )
      values ($1, $2, 'bound', $3, $4, 'master', 1, clock_timestamp())
    `,
    values: [owner.ownerUserId, owner.privyUserId, walletId, accountAddress],
  });

  const times = await authorityTimes(pool, options);
  const agentIdentityId = randomUUID();
  const authorizationId = randomUUID();
  const agentAddress = `0x${randomHex(40)}`;
  const agentName = `Loop-${agentAddress.slice(2, 13)} valid_until ${Date.parse(
    times.agentValidUntil,
  )}`;
  const issueInput: IssueSpotAgentAuthorizationInput = Object.freeze({
    authorizationId,
    agentIdentityId,
    agentGeneration: "1",
    ownerUserId: owner.ownerUserId,
    privyUserId: owner.privyUserId,
    requestId: randomUUID(),
    walletId,
    accountAddress,
    accountKind: "master",
    bindingVersion: "1",
    verifiedAt: times.verifiedAt,
    expiresAt: times.expiresAt,
    policyOwnerUserId: owner.ownerUserId,
    policyNetwork: "testnet",
    policyAction: "approve_agent",
    policyCheckedAt: times.verifiedAt,
    policyExpiresAt: times.expiresAt,
    admissionStartedAt: times.verifiedAt,
    admissionExpiresAt: new Date(
      Date.parse(times.verifiedAt) +
        SPOT_AGENT_AUTHORIZATION_ADMISSION_MAX_MILLISECONDS,
    ).toISOString(),
    agentAddress,
    agentName,
    signerRef: `privy-server-wallet:${randomUUID()}`,
    agentValidUntil: times.agentValidUntil,
    signingExpiresAt: times.signingExpiresAt,
    policyVersion: SPOT_AGENT_AUTHORIZATION_POLICY_VERSION,
  });
  const issued = await createPostgresSpotAgentAuthorizationRepository(
    pool,
  ).issueOrReplayCurrent(
    issueInput,
    materializeAuthorizationForNonce,
    computeAuthorizationSigningDigest,
  );
  if (issued.kind !== "issued") {
    throw new Error("Spot intent Agent authorization fixture was not issued");
  }

  const authority = Object.freeze({
    ...owner,
    agentIdentityId,
    authorizationId,
    walletId,
    walletVerifiedAt: times.verifiedAt,
    walletExpiresAt: times.expiresAt,
    agentValidUntil: times.agentValidUntil,
  });
  if (options.activate === false) {
    await pool.query({
      text: `
        update public.spot_agent_identities
        set
          lifecycle_state = 'active',
          record_version = 2,
          updated_at = clock_timestamp()
        where id = $1 and lifecycle_state = 'authorization_pending'
      `,
      values: [agentIdentityId],
    });
  } else {
    await activateAuthorization(pool, authority);
  }
  return authority;
}

function prepareInput(
  authority: AuthorityFixture,
  claimId: string,
  overrides: Partial<PrepareSpotIntentInput> = {},
): PrepareSpotIntentInput {
  const times = timestampWindow();
  const marketId = randomUUID();
  const clientOrderId = `0x${randomHex(32)}`;
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
    reference_source_time: times.referenceSourceTime,
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
      observed_at: times.feeObservedAt,
    },
    metadata_version: metadataVersion,
    policy_version: policyVersion,
    binding_epoch: "1",
    expires_at: times.expiresAt,
  });

  return {
    ownerUserId: authority.ownerUserId,
    claimId,
    idempotencyKey: randomUUID(),
    requestSha256: digestA,
    requestId: randomUUID(),
    marketId,
    providerCoin: "PURR/USDC",
    baseTokenIndex: 1,
    baseTokenId,
    quoteTokenIndex: 0,
    quoteTokenId,
    spotPairIndex: 0,
    exchangeOrderAsset: 10_000,
    metadataVersion,
    metadataSha256,
    policyVersion,
    side: "buy",
    amountMode: "quote",
    amountValue: "10",
    computedBaseSize: "0.2",
    referencePrice: "49.5",
    worstIocLimitPrice: "50",
    maximumSpendOrMinimumReceive: "10",
    feeRate: "0.001",
    feeEstimate: "0.01",
    privyUserId: authority.privyUserId,
    walletId: authority.walletId,
    accountAddress,
    accountKind: "master",
    bindingVersion: "1",
    agentIdentityId: authority.agentIdentityId,
    clientOrderId,
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
          c: clientOrderId,
        },
      ],
      grouping: "na",
    },
    publicReview,
    reviewSha256: publicReview.review_digest,
    factsObservedAt: times.factsObservedAt,
    referenceSourceTime: times.referenceSourceTime,
    expiresAt: times.expiresAt,
    walletVerifiedAt: authority.walletVerifiedAt,
    walletExpiresAt: authority.walletExpiresAt,
    ...overrides,
  };
}

function withReviewExpiry(
  input: PrepareSpotIntentInput,
  expiresAt: string,
): PrepareSpotIntentInput {
  const { review_digest: _reviewDigest, ...baseReview } = parseSpotReview(
    input.publicReview,
  );
  void _reviewDigest;
  const publicReview = createSpotReview({
    ...baseReview,
    expires_at: expiresAt,
  });
  return Object.freeze({
    ...input,
    publicReview,
    reviewSha256: publicReview.review_digest,
    expiresAt,
  });
}

async function prepareAuthorityLease(
  pool: InstanceType<typeof Pool>,
  input: Readonly<{
    verifiedOffsetMs: number;
    expiresOffsetMs: number;
  }>,
): Promise<
  Pick<PrepareSpotIntentInput, "walletVerifiedAt" | "walletExpiresAt">
> {
  const result = await pool.query<{
    verified_at: Date;
    expires_at: Date;
  }>({
    text: `
      with database_clock as (
        select clock_timestamp() as observed_at
      )
      select
        observed_at + ($1::integer * interval '1 millisecond')
          as verified_at,
        observed_at + ($2::integer * interval '1 millisecond')
          as expires_at
      from database_clock
    `,
    values: [input.verifiedOffsetMs, input.expiresOffsetMs],
  });
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("Spot intent prepare authority lease fixture failed");
  }
  return Object.freeze({
    walletVerifiedAt: row.verified_at.toISOString(),
    walletExpiresAt: row.expires_at.toISOString(),
  });
}

async function submissionInput(
  pool: InstanceType<typeof Pool>,
  authority: AuthorityFixture,
  intent: SpotIntentRecord,
): Promise<BeginSpotIntentSubmissionInput> {
  const windowResult = await pool.query<{
    observed_at: Date;
    expires_at: Date;
    account_expires_at: Date;
  }>(`
    select
      clock_timestamp() - interval '100 milliseconds' as observed_at,
      clock_timestamp() + interval '14 seconds' as expires_at,
      clock_timestamp() + interval '1900 milliseconds' as account_expires_at
  `);
  const window = windowResult.rows[0];
  if (window === undefined) {
    throw new Error("Spot intent submission evidence clock fixture failed");
  }
  const observedAt = window.observed_at.toISOString();
  const expiresAt = window.expires_at.toISOString();
  const accountExpiresAt = window.account_expires_at.toISOString();
  const balanceTarget =
    intent.publicReview.side === "buy"
      ? Object.freeze({
          tokenIndex: intent.quoteTokenIndex,
          tokenId: intent.quoteTokenId,
          available: intent.publicReview.maximum_spend_or_minimum_receive.value,
        })
      : Object.freeze({
          tokenIndex: intent.baseTokenIndex,
          tokenId: intent.baseTokenId,
          available: intent.publicReview.computed_base_size,
        });
  return Object.freeze({
    ownerUserId: authority.ownerUserId,
    intentId: intent.id,
    requestId: randomUUID(),
    expectedReviewSha256: intent.reviewSha256,
    walletEvidence: Object.freeze({
      ownerUserId: authority.ownerUserId,
      privyUserId: authority.privyUserId,
      walletId: authority.walletId,
      accountAddress: intent.accountAddress,
      accountKind: "master" as const,
      bindingVersion: intent.bindingVersion,
      verifiedAt: observedAt,
      expiresAt,
    }),
    marketEvidence: Object.freeze({
      provider: "hyperliquid" as const,
      network: "testnet" as const,
      dataset: "spotMetaAndAssetCtxs" as const,
      marketId: intent.marketId,
      providerCoin: intent.providerCoin,
      baseTokenIndex: intent.baseTokenIndex,
      baseTokenId: intent.baseTokenId,
      quoteTokenIndex: intent.quoteTokenIndex,
      quoteTokenId: intent.quoteTokenId,
      spotPairIndex: intent.spotPairIndex,
      exchangeOrderAsset: intent.exchangeOrderAsset,
      metadataVersion: intent.metadataVersion,
      metadataSha256: intent.metadataSha256,
      fetchedAt: observedAt,
      expiresAt,
    }),
    accountEvidence: Object.freeze({
      provider: "hyperliquid" as const,
      network: "testnet" as const,
      accountAddress: intent.accountAddress,
      metadataVersion: intent.metadataVersion,
      balance: Object.freeze({
        dataset: "spotClearinghouseState" as const,
        tokenIndex: balanceTarget.tokenIndex,
        tokenId: balanceTarget.tokenId,
        available: balanceTarget.available,
        fetchedAt: observedAt,
        expiresAt: accountExpiresAt,
      }),
      fees: Object.freeze({
        dataset: "userFees" as const,
        currentTakerRate: intent.publicReview.fee_rate,
        fetchedAt: observedAt,
        expiresAt: accountExpiresAt,
      }),
    }),
    policyEvidence: Object.freeze({
      ownerUserId: authority.ownerUserId,
      intentId: intent.id,
      network: "testnet" as const,
      action: "spot_ioc_order" as const,
      decision: "allow" as const,
      policyVersion: intent.policyVersion,
      productEnabled: true as const,
      legalEligible: true as const,
      sanctionsEligible: true as const,
      killSwitchOpen: true as const,
      signerReady: true as const,
      reconciliationReady: true as const,
      checkedAt: observedAt,
      expiresAt,
    }),
  });
}

async function prepareStoredIntent(
  repository: SpotIntentRepository,
  authority: AuthorityFixture,
  overrides: Partial<PrepareSpotIntentInput> = {},
): Promise<SpotIntentRecord> {
  const provisional = prepareInput(authority, randomUUID(), overrides);
  const claimId = await claim(repository, provisional);
  const prepared = await repository.prepare({ ...provisional, claimId });
  return prepared.intent;
}

async function spotAttemptSnapshot(
  pool: InstanceType<typeof Pool>,
  intentId: string,
): Promise<{
  readonly operation_state: string;
  readonly attempt_count: number;
  readonly transport_attempt_id: string | null;
  readonly attempt_committed_at: Date | null;
  readonly attempt_deadline_at: Date | null;
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
  readonly result_observed_at: Date | null;
  readonly result_reason_code: string | null;
  readonly allocation_count: string;
  readonly allocation_nonce: string | null;
  readonly signer_kind: string | null;
  readonly purpose: string | null;
  readonly audit_count: string;
  readonly event_count: string;
}> {
  const result = await pool.query<{
    operation_state: string;
    attempt_count: number;
    transport_attempt_id: string | null;
    attempt_committed_at: Date | null;
    attempt_deadline_at: Date | null;
    reconciliation_status: string;
    reconciliation_attempt_count: number;
    reconcile_after: Date | null;
    operator_required_at: Date | null;
    lease_owner: string | null;
    lease_expires_at: Date | null;
    fence_token: string;
    operation_version: string;
    intent_state: string;
    intent_version: string;
    result_observed_at: Date | null;
    result_reason_code: string | null;
    allocation_count: string;
    allocation_nonce: string | null;
    signer_kind: string | null;
    purpose: string | null;
    audit_count: string;
    event_count: string;
  }>({
    text: `
      select
        operation.state as operation_state,
        operation.attempt_count,
        operation.transport_attempt_id,
        operation.attempt_committed_at,
        operation.attempt_deadline_at,
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
        intent.result_observed_at,
        intent.result_reason_code,
        (
          select count(*)::text
          from public.hyperliquid_signer_nonce_allocations as allocation
          where allocation.operation_id = operation.id
        ) as allocation_count,
        allocation.nonce::text as allocation_nonce,
        allocation.signer_kind,
        allocation.purpose,
        (
          select count(*)::text
          from public.audit_events as audit
          where audit.operation_id = operation.id
        ) as audit_count,
        (
          select count(*)::text
          from public.spot_intent_events as event
          where event.intent_id = operation.id
        ) as event_count
      from public.provider_operations as operation
      join public.spot_intents as intent on intent.id = operation.id
      left join public.hyperliquid_signer_nonce_allocations as allocation
        on allocation.operation_id = operation.id
      where operation.id = $1
    `,
    values: [intentId],
  });
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("Spot intent attempt snapshot failed");
  }
  return row;
}

async function writeGenericLeaseWithoutSpotProjection(
  pool: InstanceType<typeof Pool>,
  operationId: string,
): Promise<void> {
  await pool.query({
    text: `
      update public.provider_operations
      set
        reconciliation_status = 'leased',
        reconciliation_attempt_count = reconciliation_attempt_count + 1,
        lease_owner = $2,
        lease_expires_at = clock_timestamp() + interval '30 seconds',
        fence_token = fence_token + 1,
        record_version = record_version + 1,
        updated_at = clock_timestamp()
      where id = $1
        and domain = 'hyperliquid'
        and operation_kind in ('spot_intent', 'spot_agent_authorization')
        and state = 'unknown'
        and reconciliation_status = 'pending'
    `,
    values: [operationId, randomUUID()],
  });
}

async function expireSubmissionDeadline(
  pool: InstanceType<typeof Pool>,
  intentId: string,
): Promise<void> {
  const result = await pool.query({
    text: `
      update public.provider_operations
      set
        attempt_committed_at = clock_timestamp() - interval '20 seconds',
        attempt_deadline_at = clock_timestamp() - interval '10 seconds'
      where id = $1
        and domain = 'hyperliquid'
        and operation_kind = 'spot_intent'
        and state = 'submitting'
    `,
    values: [intentId],
  });
  if (result.rowCount !== 1) {
    throw new Error("Spot intent deadline fixture failed");
  }
}

async function claim(
  repository: SpotIntentRepository,
  input: Pick<
    PrepareSpotIntentInput,
    "ownerUserId" | "idempotencyKey" | "requestSha256"
  >,
): Promise<string> {
  const result = await repository.claimPrepare({
    ownerUserId: input.ownerUserId,
    idempotencyKey: input.idempotencyKey,
    requestSha256: input.requestSha256,
  });
  if (result.kind !== "claimed") {
    throw new Error("Expected a new Spot intent claim");
  }
  return result.claimId;
}

async function counts(pool: InstanceType<typeof Pool>): Promise<{
  readonly idempotency_count: string;
  readonly operation_count: string;
  readonly intent_count: string;
  readonly audit_count: string;
  readonly event_count: string;
}> {
  const result = await pool.query<{
    idempotency_count: string;
    operation_count: string;
    intent_count: string;
    audit_count: string;
    event_count: string;
  }>(`
    select
      (
        select count(*)::text
        from public.idempotency_records
        where scope = '${SPOT_INTENT_IDEMPOTENCY_SCOPE}'
      ) as idempotency_count,
      (
        select count(*)::text
        from public.provider_operations
        where operation_kind = 'spot_intent'
      ) as operation_count,
      (select count(*)::text from public.spot_intents) as intent_count,
      (
        select count(*)::text
        from public.audit_events as audit
        join public.provider_operations as operation
          on operation.id = audit.operation_id
        where operation.operation_kind = 'spot_intent'
      ) as audit_count,
      (select count(*)::text from public.spot_intent_events) as event_count
  `);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("Spot intent count inspection failed");
  }
  return row;
}

async function claimLastSeenAt(
  pool: InstanceType<typeof Pool>,
  claimId: string,
): Promise<string> {
  const result = await pool.query<{ last_seen_at: string }>({
    text: `
      select last_seen_at::text as last_seen_at
      from public.idempotency_records
      where id = $1
    `,
    values: [claimId],
  });
  const lastSeenAt = result.rows[0]?.last_seen_at;
  if (lastSeenAt === undefined) {
    throw new Error("Spot intent claim timestamp inspection failed");
  }
  return lastSeenAt;
}

async function expirePendingClaim(
  pool: InstanceType<typeof Pool>,
  claimId: string,
): Promise<void> {
  await pool.query({
    text: `
      update public.idempotency_records
      set last_seen_at =
        clock_timestamp() - ($2::integer * interval '1 millisecond')
      where id = $1 and scope = $3
    `,
    values: [
      claimId,
      SPOT_INTENT_PENDING_CLAIM_LEASE_MILLISECONDS + 1_000,
      SPOT_INTENT_IDEMPOTENCY_SCOPE,
    ],
  });
}

async function waitForRowLockWait(
  pool: InstanceType<typeof Pool>,
  queryFragment: string,
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
            and position($1 in query) > 0
            and position('for update' in lower(query)) > 0
        ) as waiting
      `,
      values: [queryFragment],
    });
    if (result.rows[0]?.waiting === true) {
      return;
    }
    await pool.query("select pg_sleep(0.01)");
  }
  throw new Error(`Spot intent prepare did not wait at ${queryFragment}`);
}

async function waitForDatabaseLockWait(
  pool: InstanceType<typeof Pool>,
  queryFragment: string,
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
            and position($1 in query) > 0
        ) as waiting
      `,
      values: [queryFragment],
    });
    if (result.rows[0]?.waiting === true) {
      return;
    }
    await pool.query("select pg_sleep(0.01)");
  }
  throw new Error(`Spot intent submission did not wait at ${queryFragment}`);
}

async function submissionOutcomeAfterOperationLockWait(
  pool: InstanceType<typeof Pool>,
  repository: SpotIntentRepository,
  input: BeginSpotIntentSubmissionInput,
  waitSeconds: number,
): Promise<unknown> {
  const blocker = await pool.connect();
  try {
    await blocker.query("begin");
    await blocker.query({
      text: `
        select id
        from public.provider_operations
        where id = $1 and owner_user_id = $2
        for update
      `,
      values: [input.intentId, input.ownerUserId],
    });
    const outcome = repository.beginSubmission(input).then(
      (result) => result,
      (error: unknown) => error,
    );
    await waitForRowLockWait(pool, "from public.provider_operations");
    await blocker.query({
      text: "select pg_sleep($1)",
      values: [waitSeconds],
    });
    await blocker.query("commit");
    return await outcome;
  } catch (error) {
    await blocker.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    blocker.release();
  }
}

describe("PostgreSQL Spot intent repository", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  let repository: PostgresSpotIntentRepository;

  beforeAll(() => {
    repository = createPostgresSpotIntentRepository(pool);
  });

  beforeEach(async () => {
    await pool.query("truncate table public.loop_users cascade");
  });

  afterAll(async () => {
    await pool.query("truncate table public.loop_users cascade");
    await pool.end();
  });

  it("keeps a pending claim holder-private, then returns the exact prepared replay", async () => {
    const authority = await seedAuthority(pool, "claim-replay");
    const foreignOwner = await insertOwner(pool, "claim-foreign");
    const idempotencyKey = randomUUID();
    const firstClaim = await repository.claimPrepare({
      ownerUserId: authority.ownerUserId,
      idempotencyKey,
      requestSha256: digestA,
    });
    expect(firstClaim).toMatchObject({ kind: "claimed" });
    if (firstClaim.kind !== "claimed") {
      throw new Error("Expected first claim to win");
    }

    const firstSeenAt = await claimLastSeenAt(pool, firstClaim.claimId);
    await expect(
      repository.claimPrepare({
        ownerUserId: authority.ownerUserId,
        idempotencyKey,
        requestSha256: digestA,
      }),
    ).resolves.toEqual({ kind: "pending" });
    await expect(claimLastSeenAt(pool, firstClaim.claimId)).resolves.toBe(
      firstSeenAt,
    );
    await expect(
      repository.claimPrepare({
        ownerUserId: authority.ownerUserId,
        idempotencyKey,
        requestSha256: digestB,
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(
      repository.claimPrepare({
        ownerUserId: foreignOwner.ownerUserId,
        idempotencyKey,
        requestSha256: digestA,
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    const input = prepareInput(authority, firstClaim.claimId, {
      idempotencyKey,
    });
    const prepared = await repository.prepare(input);
    await expect(
      repository.claimPrepare({
        ownerUserId: authority.ownerUserId,
        idempotencyKey,
        requestSha256: digestA,
      }),
    ).resolves.toMatchObject({
      kind: "replay",
      intent: { id: prepared.intent.id },
    });
    expect(prepared).toMatchObject({
      created: true,
      intent: {
        ownerUserId: authority.ownerUserId,
        state: "prepared",
        bindingVersion: "1",
        agentIdentityId: authority.agentIdentityId,
        result: null,
        resource: {
          intent_id: prepared.intent.id,
          state: "prepared",
          submission: { state: "ready" },
        },
      },
    });
    expect(await counts(pool)).toEqual({
      idempotency_count: "1",
      operation_count: "1",
      intent_count: "1",
      audit_count: "1",
      event_count: "1",
    });
  });

  it("rejects key-source, digest-version, and claim-holder conflicts", async () => {
    const authority = await seedAuthority(pool, "claim-contract");
    const serverKey = randomUUID();
    const legacyVersionKey = randomUUID();
    await pool.query({
      text: `
        insert into public.idempotency_records (
          owner_user_id,
          scope,
          idempotency_key,
          key_source,
          request_sha256,
          digest_version
        )
        values
          ($1, $2, $3, 'server', $4, $5),
          ($1, $2, $6, 'client', $4, 'sha256_v1')
      `,
      values: [
        authority.ownerUserId,
        SPOT_INTENT_IDEMPOTENCY_SCOPE,
        serverKey,
        digestA,
        SPOT_INTENT_REQUEST_DIGEST_VERSION,
        legacyVersionKey,
      ],
    });

    for (const idempotencyKey of [serverKey, legacyVersionKey]) {
      await expect(
        repository.claimPrepare({
          ownerUserId: authority.ownerUserId,
          idempotencyKey,
          requestSha256: digestA,
        }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
    }

    const idempotencyKey = randomUUID();
    const firstClaim = await repository.claimPrepare({
      ownerUserId: authority.ownerUserId,
      idempotencyKey,
      requestSha256: digestA,
    });
    if (firstClaim.kind !== "claimed") {
      throw new Error("Expected holder claim");
    }
    await expect(
      repository.prepare(
        prepareInput(authority, randomUUID(), { idempotencyKey }),
      ),
    ).rejects.toBeInstanceOf(SpotIntentPrepareClaimRequiredError);
    expect(await counts(pool)).toMatchObject({
      idempotency_count: "3",
      operation_count: "0",
      intent_count: "0",
    });
  });

  it("lets original and recovered holders converge on one concurrent prepare", async () => {
    const authority = await seedAuthority(pool, "prepare-concurrent");
    const idempotencyKey = randomUUID();
    const provisional = prepareInput(authority, randomUUID(), {
      idempotencyKey,
    });
    const claimId = await claim(repository, provisional);
    await expirePendingClaim(pool, claimId);
    const recovered = await repository.claimPrepare({
      ownerUserId: authority.ownerUserId,
      idempotencyKey,
      requestSha256: digestA,
    });
    expect(recovered).toEqual({ kind: "claimed", claimId });
    if (recovered.kind !== "claimed") {
      throw new Error("Expected stale claim recovery");
    }
    const originalInput = { ...provisional, claimId };
    const recoveredInput = { ...provisional, claimId: recovered.claimId };
    const results = await Promise.all(
      Array.from({ length: 20 }, async (_, index) =>
        repository.prepare(index % 2 === 0 ? originalInput : recoveredInput),
      ),
    );

    expect(results.filter(({ created }) => created)).toHaveLength(1);
    expect(new Set(results.map(({ intent }) => intent.id)).size).toBe(1);
    expect(await counts(pool)).toEqual({
      idempotency_count: "1",
      operation_count: "1",
      intent_count: "1",
      audit_count: "1",
      event_count: "1",
    });
  });

  it("keeps foreign-owner reads indistinguishable from missing intents", async () => {
    const authority = await seedAuthority(pool, "owned-read");
    const foreignOwner = await insertOwner(pool, "owned-read-foreign");
    const provisional = prepareInput(authority, randomUUID());
    const claimId = await claim(repository, provisional);
    const prepared = await repository.prepare({ ...provisional, claimId });

    await expect(
      repository.findOwned(authority.ownerUserId, prepared.intent.id),
    ).resolves.toMatchObject({ id: prepared.intent.id });
    await expect(
      repository.findOwned(foreignOwner.ownerUserId, prepared.intent.id),
    ).resolves.toBeNull();
    await expect(
      repository.findOwned(authority.ownerUserId, randomUUID()),
    ).resolves.toBeNull();
  });

  it("atomically begins one Spot submission without leaking execution material through the resource", async () => {
    const authority = await seedAuthority(pool, "submit-happy");
    const prepared = await prepareStoredIntent(repository, authority);
    const input = await submissionInput(pool, authority, prepared);

    const result = await repository.beginSubmission(input);
    expect(result).toMatchObject({
      kind: "started",
      intent: {
        id: prepared.id,
        state: "submitting",
        recordVersion: "1",
        resource: {
          intent_id: prepared.id,
          state: "submitting",
          submission: { state: "attempted" },
        },
      },
      attempt: {
        intentId: prepared.id,
        network: "testnet",
        operationRecordVersion: "1",
        vaultAddress: null,
        expiresAfter: String(Date.parse(prepared.resource.expires_at)),
        canonicalAction: prepared.canonicalAction,
      },
    });
    if (result.kind !== "started") {
      throw new Error("Expected the first Spot submission to start");
    }
    expect(
      Date.parse(result.attempt.attemptDeadlineAt) -
        Date.parse(result.attempt.attemptCommittedAt),
    ).toBe(SPOT_INTENT_SUBMISSION_ATTEMPT_MILLISECONDS);

    const publicResource = JSON.stringify(result.intent.resource);
    expect(publicResource).not.toContain(result.attempt.nonce);
    expect(publicResource).not.toContain(result.attempt.agentAddress);
    expect(publicResource).not.toContain(result.attempt.signerRef);

    const snapshot = await spotAttemptSnapshot(pool, prepared.id);
    expect(snapshot).toMatchObject({
      operation_state: "submitting",
      attempt_count: 1,
      transport_attempt_id: result.attempt.transportAttemptId,
      operation_version: "1",
      intent_state: "submitting",
      intent_version: "1",
      allocation_count: "1",
      allocation_nonce: result.attempt.nonce,
      signer_kind: "spot_agent",
      purpose: "spot_ioc_order",
      audit_count: "2",
      event_count: "2",
    });
    expect(snapshot.attempt_committed_at?.toISOString()).toBe(
      result.attempt.attemptCommittedAt,
    );
    expect(snapshot.attempt_deadline_at?.toISOString()).toBe(
      result.attempt.attemptDeadlineAt,
    );
    await expect(
      pool.query({
        text: `
          select event_type, operation_version::text, transport_attempt_id
          from public.audit_events
          where operation_id = $1 and operation_version = 1
        `,
        values: [prepared.id],
      }),
    ).resolves.toMatchObject({
      rows: [
        {
          event_type: "provider_submission_started",
          operation_version: "1",
          transport_attempt_id: result.attempt.transportAttemptId,
        },
      ],
    });

    const replay = await repository.beginSubmission({
      ...input,
      requestId: randomUUID(),
    });
    expect(replay).toMatchObject({
      kind: "already_attempted",
      intent: { id: prepared.id, state: "submitting" },
    });
    expect("attempt" in replay).toBe(false);
    expect(await spotAttemptSnapshot(pool, prepared.id)).toEqual(snapshot);
  });

  it("admits exactly one execution-material winner under concurrent submission", async () => {
    const authority = await seedAuthority(pool, "submit-concurrent");
    const prepared = await prepareStoredIntent(repository, authority);
    const input = await submissionInput(pool, authority, prepared);

    const results = await Promise.all(
      Array.from({ length: 20 }, async () =>
        repository.beginSubmission({ ...input, requestId: randomUUID() }),
      ),
    );
    const started = results.filter((result) => result.kind === "started");
    const alreadyAttempted = results.filter(
      (result) => result.kind === "already_attempted",
    );
    expect(started).toHaveLength(1);
    expect(alreadyAttempted).toHaveLength(19);
    expect(
      results.every(
        (result) => result.kind === "started" || !("attempt" in result),
      ),
    ).toBe(true);
    expect(await spotAttemptSnapshot(pool, prepared.id)).toMatchObject({
      operation_state: "submitting",
      attempt_count: 1,
      intent_state: "submitting",
      allocation_count: "1",
      audit_count: "2",
      event_count: "2",
    });
  });

  it("orchestrates concurrent fake submits through one signer, writer, and nonce", async () => {
    const authority = await seedAuthority(pool, "workflow-concurrent-submit");
    const prepared = await prepareStoredIntent(repository, authority);
    const evidence = await submissionInput(pool, authority, prepared);
    const preflight = {
      prepare: vi.fn<SpotIntentSubmissionPreflight["prepare"]>(() =>
        Promise.resolve({
          walletEvidence: evidence.walletEvidence,
          marketEvidence: evidence.marketEvidence,
          accountEvidence: evidence.accountEvidence,
          policyEvidence: evidence.policyEvidence,
        }),
      ),
    } satisfies SpotIntentSubmissionPreflight;
    const signer = {
      sign: vi.fn<SpotIocSigner["sign"]>(() =>
        Promise.resolve({
          r: `0x${"4".repeat(64)}`,
          s: `0x${"5".repeat(64)}`,
          v: 27,
        }),
      ),
    } satisfies SpotIocSigner;
    const writer = {
      submit: vi.fn<SpotIocExchangeWriter["submit"]>(() => Promise.resolve()),
    } satisfies SpotIocExchangeWriter;
    const workflow = createSpotIntentSubmissionWorkflow({
      repository,
      preflight,
      signer,
      writer,
    });

    const results = await Promise.all(
      Array.from({ length: 20 }, async () =>
        workflow.submit({
          ownerUserId: authority.ownerUserId,
          privyUserId: authority.privyUserId,
          intentId: prepared.id,
          requestId: randomUUID(),
          signal: new AbortController().signal,
        }),
      ),
    );

    expect(
      results.every((result) => {
        const state = parseSpotIntentResource(result).state;
        return state === "submitting" || state === "unknown";
      }),
    ).toBe(true);
    expect(signer.sign).toHaveBeenCalledOnce();
    expect(writer.submit).toHaveBeenCalledOnce();
    const snapshot = await spotAttemptSnapshot(pool, prepared.id);
    expect(snapshot).toMatchObject({
      operation_state: "unknown",
      attempt_count: 1,
      reconciliation_status: "pending",
      operation_version: "2",
      intent_state: "unknown",
      intent_version: "2",
      result_reason_code: "submission_response_unclassified",
      allocation_count: "1",
      audit_count: "3",
      event_count: "3",
    });
    expect(snapshot.transport_attempt_id).not.toBeNull();
    expect(snapshot.allocation_nonce).not.toBeNull();
    expect(snapshot.reconcile_after).not.toBeNull();
  });

  it("atomically records one ambiguous Spot submission and replays it without a second attempt", async () => {
    const authority = await seedAuthority(pool, "submit-unknown");
    const prepared = await prepareStoredIntent(repository, authority);
    const started = await repository.beginSubmission(
      await submissionInput(pool, authority, prepared),
    );
    if (started.kind !== "started") {
      throw new Error("Expected the ambiguous Spot submission to start");
    }
    const unknownInput = Object.freeze({
      ownerUserId: authority.ownerUserId,
      intentId: prepared.id,
      requestId: randomUUID(),
      transportAttemptId: started.attempt.transportAttemptId,
      expectedOperationRecordVersion: started.attempt.operationRecordVersion,
      expectedIntentRecordVersion: started.intent.recordVersion,
      outcome: Object.freeze({
        state: "unknown" as const,
        providerOrderId: null,
        reasonCode: "submission_transport_ambiguous" as const,
      }),
    });

    const recorded = await repository.recordSubmissionUnknown(unknownInput);
    expect(recorded).toMatchObject({
      kind: "recorded",
      intent: {
        id: prepared.id,
        state: "unknown",
        recordVersion: "2",
        result: {
          state: "unknown",
          order_id: null,
          reason_code: "submission_transport_ambiguous",
        },
        resource: {
          intent_id: prepared.id,
          state: "unknown",
          submission: { state: "attempted" },
          result: {
            state: "unknown",
            order_id: null,
            reason_code: "submission_transport_ambiguous",
          },
        },
      },
    });
    if (recorded.kind !== "recorded") {
      throw new Error("Expected the unknown Spot outcome to be recorded");
    }
    const publicResource = JSON.stringify(recorded.intent.resource);
    expect(publicResource).not.toContain(started.attempt.nonce);
    expect(publicResource).not.toContain(started.attempt.agentAddress);
    expect(publicResource).not.toContain(started.attempt.signerRef);

    const snapshot = await spotAttemptSnapshot(pool, prepared.id);
    expect(snapshot).toMatchObject({
      operation_state: "unknown",
      attempt_count: 1,
      transport_attempt_id: started.attempt.transportAttemptId,
      reconciliation_status: "pending",
      operation_version: "2",
      intent_state: "unknown",
      intent_version: "2",
      result_reason_code: "submission_transport_ambiguous",
      allocation_count: "1",
      allocation_nonce: started.attempt.nonce,
      audit_count: "3",
      event_count: "3",
    });
    expect(snapshot.reconcile_after).not.toBeNull();
    expect(snapshot.result_observed_at?.toISOString()).toBe(
      snapshot.reconcile_after?.toISOString(),
    );
    await expect(
      writeGenericLeaseWithoutSpotProjection(pool, prepared.id),
    ).rejects.toMatchObject({ code: "23514" });
    expect(await spotAttemptSnapshot(pool, prepared.id)).toEqual(snapshot);

    const generic = createPostgresControlPlaneRepository(pool);
    const genericPrepared = await generic.prepareProviderOperation({
      ownerUserId: authority.ownerUserId,
      scope: "perp_order_submit",
      idempotencyKey: randomUUID(),
      keySource: "client",
      requestSha256: digestB,
      domain: "hyperliquid",
      operationKind: "perp_order_submit",
      requestId: randomUUID(),
    });
    const genericSubmitting = await generic.markProviderOperationSubmitting({
      ownerUserId: authority.ownerUserId,
      operationId: genericPrepared.operation.id,
      requestId: randomUUID(),
      attemptDurationMs: 30_000,
    });
    await generic.markProviderOperationUnknown({
      ownerUserId: authority.ownerUserId,
      operationId: genericPrepared.operation.id,
      requestId: randomUUID(),
      transportAttemptId: genericSubmitting.transportAttemptId ?? "",
      recordVersion: genericSubmitting.recordVersion,
      reasonCode: "submission_transport_ambiguous",
      retryDelayMs: 0,
    });
    await expect(
      generic.leaseProviderOperationsForReconciliation({
        workerId: randomUUID(),
        requestId: randomUUID(),
        limit: 1,
        leaseDurationMs: 30_000,
      }),
    ).resolves.toMatchObject([
      {
        id: genericPrepared.operation.id,
        domain: "hyperliquid",
        operationKind: "perp_order_submit",
        reconciliationStatus: "leased",
      },
    ]);
    expect(await spotAttemptSnapshot(pool, prepared.id)).toEqual(snapshot);

    await expect(
      repository.recordSubmissionUnknown({
        ...unknownInput,
        requestId: randomUUID(),
      }),
    ).resolves.toMatchObject({
      kind: "already_recorded",
      intent: { id: prepared.id, state: "unknown", recordVersion: "2" },
    });
    expect(await spotAttemptSnapshot(pool, prepared.id)).toEqual(snapshot);
    for (const staleVersion of [
      {
        expectedOperationRecordVersion: "0",
        expectedIntentRecordVersion: "1",
      },
      {
        expectedOperationRecordVersion: "1",
        expectedIntentRecordVersion: "999",
      },
    ]) {
      await expect(
        repository.recordSubmissionUnknown({
          ...unknownInput,
          ...staleVersion,
          requestId: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(SpotIntentSubmissionConflictError);
    }
    await expect(
      repository.recordSubmissionUnknown({
        ...unknownInput,
        requestId: randomUUID(),
        outcome: {
          state: "unknown",
          providerOrderId: null,
          reasonCode: "submission_response_unclassified",
        },
      }),
    ).rejects.toBeInstanceOf(SpotIntentSubmissionConflictError);
    await expect(
      repository.beginSubmission({
        ...(await submissionInput(pool, authority, prepared)),
        requestId: randomUUID(),
      }),
    ).resolves.toMatchObject({
      kind: "already_attempted",
      intent: { id: prepared.id, state: "unknown", recordVersion: "2" },
    });
    expect(await spotAttemptSnapshot(pool, prepared.id)).toEqual(snapshot);
  });

  it("rejects every generic reconciliation mutation for a pre-existing Spot lease", async () => {
    const authority = await seedAuthority(pool, "generic-reconciliation-deny");
    const prepared = await prepareStoredIntent(repository, authority);
    const started = await repository.beginSubmission(
      await submissionInput(pool, authority, prepared),
    );
    if (started.kind !== "started") {
      throw new Error("Expected the guarded Spot submission to start");
    }
    const recorded = await repository.recordSubmissionUnknown({
      ownerUserId: authority.ownerUserId,
      intentId: prepared.id,
      requestId: randomUUID(),
      transportAttemptId: started.attempt.transportAttemptId,
      expectedOperationRecordVersion: started.attempt.operationRecordVersion,
      expectedIntentRecordVersion: started.intent.recordVersion,
      outcome: {
        state: "unknown",
        providerOrderId: null,
        reasonCode: "submission_transport_ambiguous",
      },
    });
    if (recorded.kind !== "recorded") {
      throw new Error("Expected the guarded Spot outcome to be recorded");
    }

    const workerId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query("begin");
      const operation = await client.query({
        text: `
          update public.provider_operations
          set
            reconciliation_status = 'leased',
            reconciliation_attempt_count = reconciliation_attempt_count + 1,
            lease_owner = $2,
            lease_expires_at = clock_timestamp() + interval '30 seconds',
            fence_token = fence_token + 1,
            record_version = record_version + 1,
            updated_at = clock_timestamp()
          where id = $1
            and domain = 'hyperliquid'
            and operation_kind = 'spot_intent'
            and state = 'unknown'
            and reconciliation_status = 'pending'
        `,
        values: [prepared.id, workerId],
      });
      const intent = await client.query({
        text: `
          update public.spot_intents
          set
            state = 'reconciling',
            record_version = record_version + 1,
            updated_at = clock_timestamp()
          where id = $1 and state = 'unknown'
        `,
        values: [prepared.id],
      });
      expect(operation.rowCount).toBe(1);
      expect(intent.rowCount).toBe(1);
      await client.query("set constraints all immediate");
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    const snapshot = await spotAttemptSnapshot(pool, prepared.id);
    expect(snapshot).toMatchObject({
      operation_state: "unknown",
      reconciliation_status: "leased",
      reconciliation_attempt_count: 1,
      lease_owner: workerId,
      fence_token: "1",
      operation_version: "3",
      intent_state: "reconciling",
      intent_version: "3",
    });
    const generic = createPostgresControlPlaneRepository(pool);
    const leaseIdentity = {
      ownerUserId: authority.ownerUserId,
      operationId: prepared.id,
      workerId,
      fenceToken: snapshot.fence_token,
      recordVersion: snapshot.operation_version,
      requestId: randomUUID(),
    } as const;

    await expect(
      generic.completeProviderOperationReconciliation({
        ...leaseIdentity,
        state: "succeeded",
      }),
    ).rejects.toBeInstanceOf(StaleProviderOperationLeaseError);
    await expect(
      generic.rescheduleProviderOperationReconciliation({
        ...leaseIdentity,
        requestId: randomUUID(),
        reasonCode: "provider_pending",
        retryDelayMs: 1_000,
      }),
    ).rejects.toBeInstanceOf(StaleProviderOperationLeaseError);
    await expect(
      generic.holdProviderOperationForOperator({
        ...leaseIdentity,
        requestId: randomUUID(),
        reasonCode: "provider_evidence_conflict",
      }),
    ).rejects.toBeInstanceOf(StaleProviderOperationLeaseError);
    expect(await spotAttemptSnapshot(pool, prepared.id)).toEqual(snapshot);
  });

  it("rejects foreign, missing, mismatched-attempt, and stale-version outcome writes before mutation", async () => {
    const authority = await seedAuthority(pool, "submit-unknown-guard");
    const foreign = await insertOwner(pool, "submit-unknown-guard-foreign");
    const prepared = await prepareStoredIntent(repository, authority);
    const started = await repository.beginSubmission(
      await submissionInput(pool, authority, prepared),
    );
    if (started.kind !== "started") {
      throw new Error("Expected the guarded Spot submission to start");
    }
    const input = {
      ownerUserId: authority.ownerUserId,
      intentId: prepared.id,
      requestId: randomUUID(),
      transportAttemptId: started.attempt.transportAttemptId,
      expectedOperationRecordVersion: started.attempt.operationRecordVersion,
      expectedIntentRecordVersion: "1",
      outcome: {
        state: "unknown" as const,
        providerOrderId: null,
        reasonCode: "submission_response_unclassified" as const,
      },
    };
    const snapshot = await spotAttemptSnapshot(pool, prepared.id);

    await expect(
      repository.recordSubmissionUnknown({
        ...input,
        ownerUserId: foreign.ownerUserId,
      }),
    ).resolves.toEqual({ kind: "not_found" });
    await expect(
      repository.recordSubmissionUnknown({
        ...input,
        intentId: randomUUID(),
      }),
    ).resolves.toEqual({ kind: "not_found" });
    for (const conflicting of [
      { ...input, requestId: randomUUID(), transportAttemptId: randomUUID() },
      {
        ...input,
        requestId: randomUUID(),
        expectedOperationRecordVersion: "0",
      },
      {
        ...input,
        requestId: randomUUID(),
        expectedIntentRecordVersion: "0",
      },
    ]) {
      await expect(
        repository.recordSubmissionUnknown(conflicting),
      ).rejects.toBeInstanceOf(SpotIntentSubmissionConflictError);
    }
    expect(await spotAttemptSnapshot(pool, prepared.id)).toEqual(snapshot);
  });

  it("converges concurrent reports of the same ambiguous transport attempt", async () => {
    const authority = await seedAuthority(pool, "submit-unknown-concurrent");
    const prepared = await prepareStoredIntent(repository, authority);
    const started = await repository.beginSubmission(
      await submissionInput(pool, authority, prepared),
    );
    if (started.kind !== "started") {
      throw new Error("Expected the concurrent unknown submission to start");
    }
    const results = await Promise.all(
      Array.from({ length: 20 }, async () =>
        repository.recordSubmissionUnknown({
          ownerUserId: authority.ownerUserId,
          intentId: prepared.id,
          requestId: randomUUID(),
          transportAttemptId: started.attempt.transportAttemptId,
          expectedOperationRecordVersion:
            started.attempt.operationRecordVersion,
          expectedIntentRecordVersion: "1",
          outcome: {
            state: "unknown",
            providerOrderId: null,
            reasonCode: "submission_transport_ambiguous",
          },
        }),
      ),
    );

    expect(results.filter(({ kind }) => kind === "recorded")).toHaveLength(1);
    expect(
      results.filter(({ kind }) => kind === "already_recorded"),
    ).toHaveLength(19);
    expect(await spotAttemptSnapshot(pool, prepared.id)).toMatchObject({
      operation_state: "unknown",
      reconciliation_status: "pending",
      operation_version: "2",
      intent_state: "unknown",
      intent_version: "2",
      result_reason_code: "submission_transport_ambiguous",
      allocation_count: "1",
      audit_count: "3",
      event_count: "3",
    });
  });

  it("keeps expired Spot attempts out of generic quarantine and atomically quarantines them in the Spot lane", async () => {
    const authority = await seedAuthority(pool, "submit-quarantine");
    const prepared = await prepareStoredIntent(repository, authority);
    const started = await repository.beginSubmission(
      await submissionInput(pool, authority, prepared),
    );
    if (started.kind !== "started") {
      throw new Error("Expected the expiring Spot submission to start");
    }
    await expireSubmissionDeadline(pool, prepared.id);

    await expect(
      createPostgresControlPlaneRepository(pool).quarantineExpiredSubmissions({
        requestId: randomUUID(),
        limit: 10,
      }),
    ).resolves.toEqual([]);
    expect(await spotAttemptSnapshot(pool, prepared.id)).toMatchObject({
      operation_state: "submitting",
      reconciliation_status: "not_required",
      operation_version: "1",
      intent_state: "submitting",
      intent_version: "1",
      audit_count: "2",
      event_count: "2",
    });

    const quarantined = await repository.quarantineExpiredSubmissions({
      requestId: randomUUID(),
      limit: 10,
    });
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]).toMatchObject({
      id: prepared.id,
      state: "unknown",
      recordVersion: "2",
      result: {
        state: "unknown",
        order_id: null,
        reason_code: "submission_deadline_elapsed",
      },
    });
    await expect(
      repository.quarantineExpiredSubmissions({
        requestId: randomUUID(),
        limit: 10,
      }),
    ).resolves.toEqual([]);
    const snapshot = await spotAttemptSnapshot(pool, prepared.id);
    expect(snapshot).toMatchObject({
      operation_state: "unknown",
      attempt_count: 1,
      transport_attempt_id: started.attempt.transportAttemptId,
      reconciliation_status: "pending",
      operation_version: "2",
      intent_state: "unknown",
      intent_version: "2",
      result_reason_code: "submission_deadline_elapsed",
      allocation_count: "1",
      audit_count: "3",
      event_count: "3",
    });
    await expect(
      repository.beginSubmission({
        ...(await submissionInput(pool, authority, prepared)),
        requestId: randomUUID(),
      }),
    ).resolves.toMatchObject({
      kind: "already_attempted",
      intent: { id: prepared.id, state: "unknown", recordVersion: "2" },
    });
    expect(await spotAttemptSnapshot(pool, prepared.id)).toEqual(snapshot);
  });

  it("admits exactly one concurrent Spot deadline quarantine winner", async () => {
    const authority = await seedAuthority(pool, "submit-quarantine-concurrent");
    const prepared = await prepareStoredIntent(repository, authority);
    const started = await repository.beginSubmission(
      await submissionInput(pool, authority, prepared),
    );
    if (started.kind !== "started") {
      throw new Error("Expected the concurrent quarantine submission to start");
    }
    await expireSubmissionDeadline(pool, prepared.id);

    const results = await Promise.all([
      repository.quarantineExpiredSubmissions({
        requestId: randomUUID(),
        limit: 10,
      }),
      repository.quarantineExpiredSubmissions({
        requestId: randomUUID(),
        limit: 10,
      }),
    ]);
    expect(results.flat()).toHaveLength(1);
    expect(await spotAttemptSnapshot(pool, prepared.id)).toMatchObject({
      operation_state: "unknown",
      reconciliation_status: "pending",
      operation_version: "2",
      intent_state: "unknown",
      intent_version: "2",
      result_reason_code: "submission_deadline_elapsed",
      allocation_count: "1",
      audit_count: "3",
      event_count: "3",
    });
  });

  it("rolls back the complete Spot quarantine when its deferred event fails", async () => {
    const authority = await seedAuthority(pool, "submit-quarantine-rollback");
    const prepared = await prepareStoredIntent(repository, authority);
    const started = await repository.beginSubmission(
      await submissionInput(pool, authority, prepared),
    );
    if (started.kind !== "started") {
      throw new Error("Expected the quarantine rollback submission to start");
    }
    await expireSubmissionDeadline(pool, prepared.id);
    const snapshot = await spotAttemptSnapshot(pool, prepared.id);
    await pool.query(`
      create function public.fail_spot_quarantine_event_for_test()
      returns trigger
      language plpgsql
      as $function$
      begin
        raise exception 'forced deferred Spot quarantine event failure'
          using errcode = '23514';
      end;
      $function$;

      create constraint trigger fail_spot_quarantine_event_for_test
        after insert on public.spot_intent_events
        deferrable initially deferred
        for each row
        execute function public.fail_spot_quarantine_event_for_test();
    `);
    try {
      await expect(
        repository.quarantineExpiredSubmissions({
          requestId: randomUUID(),
          limit: 10,
        }),
      ).rejects.toBeInstanceOf(SpotIntentRepositoryUnavailableError);
      expect(await spotAttemptSnapshot(pool, prepared.id)).toEqual(snapshot);
    } finally {
      await pool.query(`
        drop trigger if exists fail_spot_quarantine_event_for_test
          on public.spot_intent_events;
        drop function if exists public.fail_spot_quarantine_event_for_test();
      `);
    }
    await expect(
      repository.quarantineExpiredSubmissions({
        requestId: randomUUID(),
        limit: 10,
      }),
    ).resolves.toMatchObject([
      {
        id: prepared.id,
        state: "unknown",
        recordVersion: "2",
        result: { reason_code: "submission_deadline_elapsed" },
      },
    ]);
  });

  it("also excludes Spot Agent authorization attempts from generic recovery lanes", async () => {
    const authority = await seedAuthority(pool, "authorization-quarantine", {
      activate: false,
    });
    const transportAttemptId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query({
        text: `
          with database_clock as (
            select clock_timestamp() as observed_at
          )
          update public.provider_operations as operation
          set
            state = 'submitting',
            attempt_count = 1,
            transport_attempt_id = $2,
            attempt_committed_at = database_clock.observed_at - interval '20 seconds',
            attempt_deadline_at = database_clock.observed_at - interval '10 seconds',
            record_version = 1,
            updated_at = database_clock.observed_at
          from database_clock
          where operation.id = $1 and operation.state = 'prepared'
        `,
        values: [authority.authorizationId, transportAttemptId],
      });
      await client.query({
        text: `
          update public.spot_agent_authorizations
          set
            state = 'submitting',
            record_version = 1,
            updated_at = clock_timestamp()
          where id = $1 and state = 'prepared'
        `,
        values: [authority.authorizationId],
      });
      await client.query("set constraints all immediate");
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    await expect(
      createPostgresControlPlaneRepository(pool).quarantineExpiredSubmissions({
        requestId: randomUUID(),
        limit: 10,
      }),
    ).resolves.toEqual([]);
    await expect(
      pool.query({
        text: `
          select
            operation.state as operation_state,
            operation.reconciliation_status,
            agent_auth.state as authorization_state
          from public.provider_operations as operation
          join public.spot_agent_authorizations as agent_auth
            on agent_auth.id = operation.id
          where operation.id = $1
        `,
        values: [authority.authorizationId],
      }),
    ).resolves.toMatchObject({
      rows: [
        {
          operation_state: "submitting",
          reconciliation_status: "not_required",
          authorization_state: "submitting",
        },
      ],
    });

    const transition = await pool.connect();
    try {
      await transition.query("begin");
      const operation = await transition.query({
        text: `
          update public.provider_operations
          set
            state = 'unknown',
            reconciliation_status = 'pending',
            reconcile_after = clock_timestamp(),
            record_version = record_version + 1,
            updated_at = clock_timestamp()
          where id = $1
            and state = 'submitting'
            and reconciliation_status = 'not_required'
        `,
        values: [authority.authorizationId],
      });
      const authorization = await transition.query({
        text: `
          update public.spot_agent_authorizations
          set
            state = 'unknown',
            result_observed_at = clock_timestamp(),
            result_reason_code = 'submission_transport_ambiguous',
            record_version = record_version + 1,
            updated_at = clock_timestamp()
          where id = $1 and state = 'submitting'
        `,
        values: [authority.authorizationId],
      });
      expect(operation.rowCount).toBe(1);
      expect(authorization.rowCount).toBe(1);
      await transition.query("set constraints all immediate");
      await transition.query("commit");
    } catch (error) {
      await transition.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      transition.release();
    }

    const beforeLease = await pool.query({
      text: `
        select
          operation.state as operation_state,
          operation.reconciliation_status,
          operation.record_version::text as operation_version,
          operation.lease_owner,
          operation.lease_expires_at,
          operation.fence_token::text as fence_token,
          agent_auth.state as authorization_state,
          agent_auth.record_version::text as authorization_version,
          agent_auth.result_reason_code
        from public.provider_operations as operation
        join public.spot_agent_authorizations as agent_auth
          on agent_auth.id = operation.id
        where operation.id = $1
      `,
      values: [authority.authorizationId],
    });
    await expect(
      writeGenericLeaseWithoutSpotProjection(pool, authority.authorizationId),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      createPostgresControlPlaneRepository(
        pool,
      ).leaseProviderOperationsForReconciliation({
        workerId: randomUUID(),
        requestId: randomUUID(),
        limit: 1,
        leaseDurationMs: 30_000,
      }),
    ).resolves.toEqual([]);
    const afterLease = await pool.query({
      text: `
        select
          operation.state as operation_state,
          operation.reconciliation_status,
          operation.record_version::text as operation_version,
          operation.lease_owner,
          operation.lease_expires_at,
          operation.fence_token::text as fence_token,
          agent_auth.state as authorization_state,
          agent_auth.record_version::text as authorization_version,
          agent_auth.result_reason_code
        from public.provider_operations as operation
        join public.spot_agent_authorizations as agent_auth
          on agent_auth.id = operation.id
        where operation.id = $1
      `,
      values: [authority.authorizationId],
    });
    expect(afterLease.rows).toEqual(beforeLease.rows);
  });

  it("requires exact fresh wallet, market, account, policy, and review evidence before journaling", async () => {
    const authority = await seedAuthority(pool, "submit-evidence");
    const prepared = await prepareStoredIntent(repository, authority);
    const input = await submissionInput(pool, authority, prepared);
    const shortExpiry = new Date(Date.now() + 5_000).toISOString();
    const futureObservedAt = new Date(Date.now() + 1_000).toISOString();
    const futureExpiresAt = new Date(Date.now() + 14_000).toISOString();
    const overlongWalletExpiry = new Date(
      Date.parse(input.walletEvidence.verifiedAt) +
        SPOT_INTENT_SUBMISSION_AUTHORITY_LEASE_MILLISECONDS +
        1,
    ).toISOString();
    const overlongPolicyExpiry = new Date(
      Date.parse(input.policyEvidence.checkedAt) +
        SPOT_INTENT_SUBMISSION_AUTHORITY_LEASE_MILLISECONDS +
        1,
    ).toISOString();
    const overlongMarketExpiry = new Date(
      Date.parse(input.marketEvidence.fetchedAt) +
        SPOT_INTENT_SUBMISSION_METADATA_LEASE_MILLISECONDS +
        1,
    ).toISOString();
    const overlongBalanceExpiry = new Date(
      Date.parse(input.accountEvidence.balance.fetchedAt) +
        SPOT_INTENT_SUBMISSION_ACCOUNT_EVIDENCE_LEASE_MILLISECONDS +
        1,
    ).toISOString();
    const overlongFeeExpiry = new Date(
      Date.parse(input.accountEvidence.fees.fetchedAt) +
        SPOT_INTENT_SUBMISSION_ACCOUNT_EVIDENCE_LEASE_MILLISECONDS +
        1,
    ).toISOString();
    const futureAccountExpiresAt = new Date(Date.now() + 2_900).toISOString();
    const staleInputs: readonly BeginSpotIntentSubmissionInput[] = [
      { ...input, expectedReviewSha256: digestB },
      {
        ...input,
        walletEvidence: {
          ...input.walletEvidence,
          privyUserId: `${authority.privyUserId}:changed`,
        },
      },
      {
        ...input,
        walletEvidence: {
          ...input.walletEvidence,
          walletId: `wallet-${randomUUID()}`,
        },
      },
      {
        ...input,
        marketEvidence: {
          ...input.marketEvidence,
          metadataSha256: digestB,
        },
      },
      {
        ...input,
        policyEvidence: {
          ...input.policyEvidence,
          policyVersion: "spot_ioc_v2",
        },
      },
      {
        ...input,
        accountEvidence: {
          ...input.accountEvidence,
          accountAddress: rotatedAccountAddress,
        },
      },
      {
        ...input,
        accountEvidence: {
          ...input.accountEvidence,
          metadataVersion: digestB,
        },
      },
      {
        ...input,
        accountEvidence: {
          ...input.accountEvidence,
          balance: {
            ...input.accountEvidence.balance,
            tokenId: baseTokenId,
          },
        },
      },
      {
        ...input,
        accountEvidence: {
          ...input.accountEvidence,
          balance: {
            ...input.accountEvidence.balance,
            available: "9.99999999",
          },
        },
      },
      {
        ...input,
        accountEvidence: {
          ...input.accountEvidence,
          fees: {
            ...input.accountEvidence.fees,
            currentTakerRate: "0.0010000001",
          },
        },
      },
      {
        ...input,
        walletEvidence: {
          ...input.walletEvidence,
          expiresAt: shortExpiry,
        },
        marketEvidence: {
          ...input.marketEvidence,
          expiresAt: shortExpiry,
        },
        policyEvidence: {
          ...input.policyEvidence,
          expiresAt: shortExpiry,
        },
      },
      {
        ...input,
        walletEvidence: {
          ...input.walletEvidence,
          verifiedAt: futureObservedAt,
          expiresAt: futureExpiresAt,
        },
      },
      {
        ...input,
        marketEvidence: {
          ...input.marketEvidence,
          fetchedAt: futureObservedAt,
          expiresAt: futureExpiresAt,
        },
      },
      {
        ...input,
        policyEvidence: {
          ...input.policyEvidence,
          checkedAt: futureObservedAt,
          expiresAt: futureExpiresAt,
        },
      },
      {
        ...input,
        accountEvidence: {
          ...input.accountEvidence,
          balance: {
            ...input.accountEvidence.balance,
            fetchedAt: futureObservedAt,
            expiresAt: futureAccountExpiresAt,
          },
        },
      },
      {
        ...input,
        accountEvidence: {
          ...input.accountEvidence,
          fees: {
            ...input.accountEvidence.fees,
            fetchedAt: futureObservedAt,
            expiresAt: futureAccountExpiresAt,
          },
        },
      },
      {
        ...input,
        walletEvidence: {
          ...input.walletEvidence,
          expiresAt: overlongWalletExpiry,
        },
      },
      {
        ...input,
        marketEvidence: {
          ...input.marketEvidence,
          expiresAt: overlongMarketExpiry,
        },
      },
      {
        ...input,
        policyEvidence: {
          ...input.policyEvidence,
          expiresAt: overlongPolicyExpiry,
        },
      },
      {
        ...input,
        accountEvidence: {
          ...input.accountEvidence,
          balance: {
            ...input.accountEvidence.balance,
            expiresAt: overlongBalanceExpiry,
          },
        },
      },
      {
        ...input,
        accountEvidence: {
          ...input.accountEvidence,
          fees: {
            ...input.accountEvidence.fees,
            expiresAt: overlongFeeExpiry,
          },
        },
      },
    ];
    for (const stale of staleInputs) {
      await expect(repository.beginSubmission(stale)).rejects.toBeInstanceOf(
        SpotIntentAuthorityStaleError,
      );
    }
    expect(await spotAttemptSnapshot(pool, prepared.id)).toMatchObject({
      operation_state: "prepared",
      attempt_count: 0,
      transport_attempt_id: null,
      operation_version: "0",
      intent_state: "prepared",
      intent_version: "0",
      allocation_count: "0",
      audit_count: "1",
      event_count: "1",
    });
  });

  it("rechecks the current wallet epoch and active Agent generation at submission", async () => {
    const walletAuthority = await seedAuthority(pool, "submit-wallet-stale");
    const walletIntent = await prepareStoredIntent(repository, walletAuthority);
    const walletInput = await submissionInput(
      pool,
      walletAuthority,
      walletIntent,
    );
    const walletRotator = await pool.connect();
    try {
      await walletRotator.query("begin");
      await walletRotator.query({
        text: `
          select id
          from public.loop_users
          where id = $1
          for update
        `,
        values: [walletAuthority.ownerUserId],
      });
      await walletRotator.query({
        text: `
          update public.perp_wallet_bindings
          set
            account_address = $2,
            binding_version = 2,
            last_verified_at = clock_timestamp(),
            updated_at = clock_timestamp()
          where owner_user_id = $1
        `,
        values: [walletAuthority.ownerUserId, rotatedAccountAddress],
      });
      const outcome = repository.beginSubmission(walletInput).then(
        () => null,
        (error: unknown) => error,
      );
      await waitForRowLockWait(pool, "from public.loop_users");
      await walletRotator.query("commit");
      expect(await outcome).toBeInstanceOf(SpotIntentAuthorityStaleError);
    } catch (error) {
      await walletRotator.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      walletRotator.release();
    }
    expect(await spotAttemptSnapshot(pool, walletIntent.id)).toMatchObject({
      operation_state: "prepared",
      attempt_count: 0,
      allocation_count: "0",
      audit_count: "1",
      event_count: "1",
    });

    await pool.query("truncate table public.loop_users cascade");
    const agentAuthority = await seedAuthority(pool, "submit-agent-stale");
    const agentIntent = await prepareStoredIntent(repository, agentAuthority);
    const agentInput = await submissionInput(pool, agentAuthority, agentIntent);
    const agentRetirer = await pool.connect();
    try {
      await agentRetirer.query("begin");
      await agentRetirer.query({
        text: `
          select id
          from public.spot_agent_identities
          where id = $1 and owner_user_id = $2
          for update
        `,
        values: [agentAuthority.agentIdentityId, agentAuthority.ownerUserId],
      });
      await agentRetirer.query({
        text: `
          update public.spot_agent_identities
          set
            lifecycle_state = 'retired',
            record_version = record_version + 1,
            updated_at = clock_timestamp()
          where id = $1 and lifecycle_state = 'active'
        `,
        values: [agentAuthority.agentIdentityId],
      });
      const outcome = repository.beginSubmission(agentInput).then(
        () => null,
        (error: unknown) => error,
      );
      await waitForRowLockWait(pool, "from public.spot_agent_identities");
      await agentRetirer.query("commit");
      expect(await outcome).toBeInstanceOf(SpotIntentAuthorityStaleError);
    } catch (error) {
      await agentRetirer.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      agentRetirer.release();
    }
    expect(await spotAttemptSnapshot(pool, agentIntent.id)).toMatchObject({
      operation_state: "prepared",
      attempt_count: 0,
      allocation_count: "0",
      audit_count: "1",
      event_count: "1",
    });
  });

  it("recomputes review and authority attempt windows after an operation-lock wait", async () => {
    const reviewAuthority = await seedAuthority(pool, "submit-review-window");
    const provisional = prepareInput(reviewAuthority, randomUUID());
    const shortWindow = timestampWindow({ expiresOffsetMs: 12_000 });
    const { review_digest: _reviewDigest, ...baseReview } = parseSpotReview(
      provisional.publicReview,
    );
    void _reviewDigest;
    const shortReview = createSpotReview({
      ...baseReview,
      reference_source_time: shortWindow.referenceSourceTime,
      fee_source: {
        dataset: "user_fees",
        observed_at: shortWindow.feeObservedAt,
      },
      expires_at: shortWindow.expiresAt,
    });
    const reviewClaimId = await claim(repository, provisional);
    const reviewPrepared = await repository.prepare({
      ...provisional,
      claimId: reviewClaimId,
      publicReview: shortReview,
      reviewSha256: shortReview.review_digest,
      factsObservedAt: shortWindow.factsObservedAt,
      referenceSourceTime: shortWindow.referenceSourceTime,
      expiresAt: shortWindow.expiresAt,
    });
    const reviewInput = await submissionInput(
      pool,
      reviewAuthority,
      reviewPrepared.intent,
    );
    expect(
      await submissionOutcomeAfterOperationLockWait(
        pool,
        repository,
        reviewInput,
        2.2,
      ),
    ).toBeInstanceOf(SpotIntentPrepareExpiredError);
    expect(
      await spotAttemptSnapshot(pool, reviewPrepared.intent.id),
    ).toMatchObject({
      operation_state: "prepared",
      attempt_count: 0,
      allocation_count: "0",
    });

    await pool.query("truncate table public.loop_users cascade");
    const agentAuthority = await seedAuthority(pool, "submit-agent-window", {
      signingExpiresOffsetMs: 4_000,
      agentValidUntilOffsetMs: 12_000,
    });
    const agentProvisional = withReviewExpiry(
      prepareInput(agentAuthority, randomUUID()),
      agentAuthority.agentValidUntil,
    );
    const agentClaimId = await claim(repository, agentProvisional);
    const agentPrepared = await repository.prepare({
      ...agentProvisional,
      claimId: agentClaimId,
    });
    const agentIntent = agentPrepared.intent;
    const agentInput = await submissionInput(pool, agentAuthority, agentIntent);
    expect(
      await submissionOutcomeAfterOperationLockWait(
        pool,
        repository,
        agentInput,
        2.2,
      ),
    ).toBeInstanceOf(SpotIntentPrepareExpiredError);
    expect(await spotAttemptSnapshot(pool, agentIntent.id)).toMatchObject({
      operation_state: "prepared",
      attempt_count: 0,
      allocation_count: "0",
    });

    await pool.query("truncate table public.loop_users cascade");
    const evidenceAuthority = await seedAuthority(
      pool,
      "submit-evidence-window",
    );
    const evidenceIntent = await prepareStoredIntent(
      repository,
      evidenceAuthority,
    );
    const evidenceInput = await submissionInput(
      pool,
      evidenceAuthority,
      evidenceIntent,
    );
    const waitingEvidenceInput: BeginSpotIntentSubmissionInput = {
      ...evidenceInput,
      walletEvidence: {
        ...evidenceInput.walletEvidence,
        expiresAt: new Date(Date.now() + 12_000).toISOString(),
      },
    };
    expect(
      await submissionOutcomeAfterOperationLockWait(
        pool,
        repository,
        waitingEvidenceInput,
        2.2,
      ),
    ).toBeInstanceOf(SpotIntentAuthorityStaleError);
    expect(await spotAttemptSnapshot(pool, evidenceIntent.id)).toMatchObject({
      operation_state: "prepared",
      attempt_count: 0,
      allocation_count: "0",
    });
  }, 15_000);

  it("keeps foreign and missing submission targets indistinguishable and unchanged", async () => {
    const authority = await seedAuthority(pool, "submit-owned");
    const foreign = await insertOwner(pool, "submit-owned-foreign");
    const prepared = await prepareStoredIntent(repository, authority);
    const input = await submissionInput(pool, authority, prepared);

    await expect(
      repository.beginSubmission({
        ...input,
        ownerUserId: foreign.ownerUserId,
        walletEvidence: {
          ...input.walletEvidence,
          ownerUserId: foreign.ownerUserId,
          privyUserId: foreign.privyUserId,
        },
        policyEvidence: {
          ...input.policyEvidence,
          ownerUserId: foreign.ownerUserId,
        },
      }),
    ).resolves.toEqual({ kind: "not_found" });
    const missingIntentId = randomUUID();
    await expect(
      repository.beginSubmission({
        ...input,
        intentId: missingIntentId,
        policyEvidence: {
          ...input.policyEvidence,
          intentId: missingIntentId,
        },
      }),
    ).resolves.toEqual({ kind: "not_found" });
    expect(await spotAttemptSnapshot(pool, prepared.id)).toMatchObject({
      operation_state: "prepared",
      attempt_count: 0,
      allocation_count: "0",
      audit_count: "1",
      event_count: "1",
    });
  });

  it("rolls the journal and Agent nonce high-water back when a deferred submission event fails", async () => {
    const authority = await seedAuthority(pool, "submit-rollback");
    const prepared = await prepareStoredIntent(repository, authority);
    const input = await submissionInput(pool, authority, prepared);
    const identity = await pool.query<{ agent_address: string }>({
      text: `
        select agent_address
        from public.spot_agent_identities
        where id = $1
      `,
      values: [authority.agentIdentityId],
    });
    const agentAddress = identity.rows[0]?.agent_address;
    if (agentAddress === undefined) {
      throw new Error("Spot Agent address fixture failed");
    }
    await pool.query(`
      create sequence public.spot_submission_fault_marker_for_test;

      create function public.fail_spot_submission_event_for_test()
      returns trigger
      language plpgsql
      as $function$
      begin
        perform nextval('public.spot_submission_fault_marker_for_test');
        raise exception 'forced deferred Spot submission event failure'
          using errcode = '23514';
      end;
      $function$;

      create constraint trigger fail_spot_submission_event_for_test
        after insert on public.spot_intent_events
        deferrable initially deferred
        for each row
        execute function public.fail_spot_submission_event_for_test();
    `);
    try {
      await expect(repository.beginSubmission(input)).rejects.toBeInstanceOf(
        SpotIntentRepositoryUnavailableError,
      );
      expect(await spotAttemptSnapshot(pool, prepared.id)).toMatchObject({
        operation_state: "prepared",
        attempt_count: 0,
        transport_attempt_id: null,
        operation_version: "0",
        intent_state: "prepared",
        intent_version: "0",
        allocation_count: "0",
        audit_count: "1",
        event_count: "1",
      });
      await expect(
        pool.query<{ count: string }>({
          text: `
            select count(*)::text as count
            from public.hyperliquid_signer_nonce_state
            where network = 'testnet'
              and signer_address = $1
              and signer_kind = 'spot_agent'
          `,
          values: [agentAddress],
        }),
      ).resolves.toMatchObject({ rows: [{ count: "0" }] });
      await expect(
        pool.query<{ last_value: string; is_called: boolean }>(`
          select last_value::text as last_value, is_called
          from public.spot_submission_fault_marker_for_test
        `),
      ).resolves.toMatchObject({
        rows: [{ last_value: "1", is_called: true }],
      });
    } finally {
      await pool.query(`
        drop trigger if exists fail_spot_submission_event_for_test
          on public.spot_intent_events;
        drop function if exists public.fail_spot_submission_event_for_test();
        drop sequence if exists public.spot_submission_fault_marker_for_test;
      `);
    }
    const retry = await repository.beginSubmission(
      await submissionInput(pool, authority, prepared),
    );
    expect(retry).toMatchObject({
      kind: "started",
      intent: { id: prepared.id, state: "submitting" },
    });
  });

  it("allocates unique monotonic nonces across concurrent intents for one Agent", async () => {
    const authority = await seedAuthority(pool, "submit-nonce-sequence");
    const firstIntent = await prepareStoredIntent(repository, authority);
    const secondIntent = await prepareStoredIntent(repository, authority);
    const [firstInput, secondInput] = await Promise.all([
      submissionInput(pool, authority, firstIntent),
      submissionInput(pool, authority, secondIntent),
    ]);

    const results = await Promise.all([
      repository.beginSubmission(firstInput),
      repository.beginSubmission(secondInput),
    ]);
    expect(results.every((result) => result.kind === "started")).toBe(true);
    const nonces = results.map((result) => {
      if (result.kind !== "started") {
        throw new Error("Expected both independent Spot intents to start");
      }
      return BigInt(result.attempt.nonce);
    });
    expect(new Set(nonces.map(String)).size).toBe(2);

    const allocations = await pool.query<{ nonce: string }>({
      text: `
        select allocation.nonce::text as nonce
        from public.hyperliquid_signer_nonce_allocations as allocation
        where allocation.operation_id = any($1::uuid[])
        order by allocation.nonce
      `,
      values: [[firstIntent.id, secondIntent.id]],
    });
    expect(allocations.rows).toHaveLength(2);
    expect(BigInt(allocations.rows[0]?.nonce ?? "0")).toBeLessThan(
      BigInt(allocations.rows[1]?.nonce ?? "0"),
    );
    expect(await spotAttemptSnapshot(pool, firstIntent.id)).toMatchObject({
      operation_state: "submitting",
      allocation_count: "1",
    });
    expect(await spotAttemptSnapshot(pool, secondIntent.id)).toMatchObject({
      operation_state: "submitting",
      allocation_count: "1",
    });
  });

  it("fails closed without a journal when the persisted Agent nonce is too far ahead", async () => {
    const authority = await seedAuthority(pool, "submit-nonce-window");
    const prepared = await prepareStoredIntent(repository, authority);
    const input = await submissionInput(pool, authority, prepared);
    const identity = await pool.query<{ agent_address: string }>({
      text: `
        select agent_address
        from public.spot_agent_identities
        where id = $1
      `,
      values: [authority.agentIdentityId],
    });
    const agentAddress = identity.rows[0]?.agent_address;
    if (agentAddress === undefined) {
      throw new Error("Spot Agent nonce-window fixture failed");
    }
    const seeded = await pool.query<{ nonce: string }>({
      text: `
        insert into public.hyperliquid_signer_nonce_state (
          network,
          signer_address,
          signer_kind,
          last_allocated_nonce
        )
        values (
          'testnet', $1, 'spot_agent',
          floor(extract(epoch from clock_timestamp()) * 1000)::numeric
            + $2::numeric + 1000
        )
        returning last_allocated_nonce::text as nonce
      `,
      values: [
        agentAddress,
        HYPERLIQUID_SIGNER_NONCE_FUTURE_WINDOW_MILLISECONDS,
      ],
    });
    const highWater = seeded.rows[0]?.nonce;
    if (highWater === undefined) {
      throw new Error("Spot Agent future nonce fixture failed");
    }

    await expect(repository.beginSubmission(input)).rejects.toBeInstanceOf(
      SpotIntentRepositoryUnavailableError,
    );
    expect(await spotAttemptSnapshot(pool, prepared.id)).toMatchObject({
      operation_state: "prepared",
      attempt_count: 0,
      transport_attempt_id: null,
      operation_version: "0",
      intent_state: "prepared",
      intent_version: "0",
      allocation_count: "0",
      audit_count: "1",
      event_count: "1",
    });
    await expect(
      pool.query<{ nonce: string }>({
        text: `
          select last_allocated_nonce::text as nonce
          from public.hyperliquid_signer_nonce_state
          where network = 'testnet' and signer_address = $1
        `,
        values: [agentAddress],
      }),
    ).resolves.toMatchObject({ rows: [{ nonce: highWater }] });
  });

  it("rolls back journal and nonce when private evidence expires during deferred checks", async () => {
    const authority = await seedAuthority(
      pool,
      "submit-account-evidence-deferred-wait",
    );
    const prepared = await prepareStoredIntent(repository, authority);
    const identity = await pool.query<{ agent_address: string }>({
      text: `
        select agent_address
        from public.spot_agent_identities
        where id = $1
      `,
      values: [authority.agentIdentityId],
    });
    const agentAddress = identity.rows[0]?.agent_address;
    if (agentAddress === undefined) {
      throw new Error("Spot Agent account-evidence fixture failed");
    }
    const advisoryLockKey = 824_026_002;
    await pool.query(`
      create function public.wait_spot_submission_account_evidence_for_test()
      returns trigger
      language plpgsql
      as $function$
      begin
        perform pg_advisory_xact_lock(${advisoryLockKey});
        return null;
      end;
      $function$;

      create constraint trigger wait_spot_submission_account_evidence_for_test
        after insert on public.spot_intent_events
        deferrable initially deferred
        for each row
        execute function public.wait_spot_submission_account_evidence_for_test();
    `);

    const blocker = await pool.connect();
    try {
      await blocker.query("begin");
      await blocker.query({
        text: "select pg_advisory_xact_lock($1)",
        values: [advisoryLockKey],
      });
      const input = await submissionInput(pool, authority, prepared);
      const outcome = repository.beginSubmission(input).then(
        () => null,
        (error: unknown) => error,
      );
      await waitForDatabaseLockWait(pool, "set constraints all immediate");
      await blocker.query("select pg_sleep(2.2)");
      await blocker.query("commit");
      expect(await outcome).toBeInstanceOf(SpotIntentAuthorityStaleError);
    } catch (error) {
      await blocker.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      blocker.release();
      await pool.query(`
        drop trigger if exists wait_spot_submission_account_evidence_for_test
          on public.spot_intent_events;
        drop function if exists public.wait_spot_submission_account_evidence_for_test();
      `);
    }
    expect(await spotAttemptSnapshot(pool, prepared.id)).toMatchObject({
      operation_state: "prepared",
      attempt_count: 0,
      transport_attempt_id: null,
      operation_version: "0",
      intent_state: "prepared",
      intent_version: "0",
      allocation_count: "0",
      audit_count: "1",
      event_count: "1",
    });
    await expect(
      pool.query<{ count: string }>({
        text: `
          select count(*)::text as count
          from public.hyperliquid_signer_nonce_state
          where network = 'testnet'
            and signer_address = $1
            and signer_kind = 'spot_agent'
        `,
        values: [agentAddress],
      }),
    ).resolves.toMatchObject({ rows: [{ count: "0" }] });
  }, 10_000);

  it("rolls back a journal whose deferred constraints wait past its fixed attempt deadline", async () => {
    const authority = await seedAuthority(pool, "submit-deadline-wait");
    const prepared = await prepareStoredIntent(repository, authority);
    const input = await submissionInput(pool, authority, prepared);
    const identity = await pool.query<{ agent_address: string }>({
      text: `
        select agent_address
        from public.spot_agent_identities
        where id = $1
      `,
      values: [authority.agentIdentityId],
    });
    const agentAddress = identity.rows[0]?.agent_address;
    if (agentAddress === undefined) {
      throw new Error("Spot Agent deadline fixture failed");
    }
    const advisoryLockKey = 824_026_001;
    await pool.query(`
      create function public.wait_spot_submission_constraint_for_test()
      returns trigger
      language plpgsql
      as $function$
      begin
        perform pg_advisory_xact_lock(${advisoryLockKey});
        return null;
      end;
      $function$;

      create constraint trigger wait_spot_submission_constraint_for_test
        after insert on public.spot_intent_events
        deferrable initially deferred
        for each row
        execute function public.wait_spot_submission_constraint_for_test();
    `);

    const blocker = await pool.connect();
    try {
      await blocker.query("begin");
      await blocker.query({
        text: "select pg_advisory_xact_lock($1)",
        values: [advisoryLockKey],
      });
      const outcome = repository.beginSubmission(input).then(
        () => null,
        (error: unknown) => error,
      );
      await waitForDatabaseLockWait(pool, "set constraints all immediate");
      await blocker.query("select pg_sleep(10.2)");
      await blocker.query("commit");
      expect(await outcome).toBeInstanceOf(SpotIntentAuthorityStaleError);
    } catch (error) {
      await blocker.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      blocker.release();
      await pool.query(`
        drop trigger if exists wait_spot_submission_constraint_for_test
          on public.spot_intent_events;
        drop function if exists public.wait_spot_submission_constraint_for_test();
      `);
    }
    expect(await spotAttemptSnapshot(pool, prepared.id)).toMatchObject({
      operation_state: "prepared",
      attempt_count: 0,
      transport_attempt_id: null,
      operation_version: "0",
      intent_state: "prepared",
      intent_version: "0",
      allocation_count: "0",
      audit_count: "1",
      event_count: "1",
    });
    await expect(
      pool.query<{ count: string }>({
        text: `
          select count(*)::text as count
          from public.hyperliquid_signer_nonce_state
          where network = 'testnet'
            and signer_address = $1
            and signer_kind = 'spot_agent'
        `,
        values: [agentAddress],
      }),
    ).resolves.toMatchObject({ rows: [{ count: "0" }] });
  }, 20_000);

  it("rolls back preparation when the wallet or active Agent epoch changed", async () => {
    const walletAuthority = await seedAuthority(pool, "wallet-stale");
    const walletProvisional = prepareInput(walletAuthority, randomUUID());
    const walletClaimId = await claim(repository, walletProvisional);
    const walletRotator = await pool.connect();
    try {
      await walletRotator.query("begin");
      await walletRotator.query({
        text: `
          select id
          from public.loop_users
          where id = $1
          for update
        `,
        values: [walletAuthority.ownerUserId],
      });
      await walletRotator.query({
        text: `
          update public.perp_wallet_bindings
          set
            account_address = $2,
            binding_version = 2,
            last_verified_at = clock_timestamp(),
            updated_at = clock_timestamp()
          where owner_user_id = $1
        `,
        values: [walletAuthority.ownerUserId, rotatedAccountAddress],
      });
      const prepareOutcome = repository
        .prepare({ ...walletProvisional, claimId: walletClaimId })
        .then(
          () => null,
          (error: unknown) => error,
        );
      await waitForRowLockWait(pool, "from public.loop_users");
      await walletRotator.query("commit");
      expect(await prepareOutcome).toBeInstanceOf(
        SpotIntentAuthorityStaleError,
      );
    } catch (error) {
      await walletRotator.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      walletRotator.release();
    }
    expect(await counts(pool)).toMatchObject({
      idempotency_count: "1",
      operation_count: "0",
      intent_count: "0",
    });

    await pool.query("truncate table public.loop_users cascade");
    const agentAuthority = await seedAuthority(pool, "agent-stale");
    const agentProvisional = prepareInput(agentAuthority, randomUUID());
    const agentClaimId = await claim(repository, agentProvisional);
    await pool.query({
      text: `
        update public.spot_agent_identities
        set
          lifecycle_state = 'revoked',
          record_version = 3,
          updated_at = clock_timestamp()
        where id = $1
      `,
      values: [agentAuthority.agentIdentityId],
    });
    await expect(
      repository.prepare({ ...agentProvisional, claimId: agentClaimId }),
    ).rejects.toBeInstanceOf(SpotIntentAuthorityStaleError);
    expect(await counts(pool)).toMatchObject({
      idempotency_count: "1",
      operation_count: "0",
      intent_count: "0",
    });
  });

  it("requires a matching active authorization even when the Agent identity is active", async () => {
    const authority = await seedAuthority(pool, "authorization-not-active", {
      activate: false,
    });
    const provisional = prepareInput(authority, randomUUID());
    const claimId = await claim(repository, provisional);

    await expect(
      repository.prepare({ ...provisional, claimId }),
    ).rejects.toBeInstanceOf(SpotIntentAuthorityStaleError);
    expect(await counts(pool)).toEqual({
      idempotency_count: "1",
      operation_count: "0",
      intent_count: "0",
      audit_count: "0",
      event_count: "0",
    });
  });

  it("accepts the exact prepare lease and Agent end-boundary", async () => {
    const authority = await seedAuthority(pool, "prepare-boundaries", {
      signingExpiresOffsetMs: 13_000,
      agentValidUntilOffsetMs: 14_000,
    });
    const provisional = withReviewExpiry(
      prepareInput(authority, randomUUID()),
      authority.agentValidUntil,
    );
    const walletLease = await prepareAuthorityLease(pool, {
      verifiedOffsetMs: -100,
      expiresOffsetMs: SPOT_INTENT_PREPARE_AUTHORITY_LEASE_MILLISECONDS - 100,
    });
    const claimId = await claim(repository, provisional);

    await expect(
      repository.prepare({
        ...provisional,
        ...walletLease,
        claimId,
      }),
    ).resolves.toMatchObject({ created: true });
    expect(await counts(pool)).toEqual({
      idempotency_count: "1",
      operation_count: "1",
      intent_count: "1",
      audit_count: "1",
      event_count: "1",
    });
  });

  it.each([
    ["future", 5_000, 10_000],
    ["expired", -2_000, -1_000],
    [
      "overlong",
      -100,
      SPOT_INTENT_PREPARE_AUTHORITY_LEASE_MILLISECONDS - 100 + 1,
    ],
  ] as const)(
    "rejects %s wallet resolver evidence before durable writes",
    async (_label, verifiedOffsetMs, expiresOffsetMs) => {
      const authority = await seedAuthority(pool, `prepare-${_label}-lease`);
      const provisional = prepareInput(authority, randomUUID());
      const walletLease = await prepareAuthorityLease(pool, {
        verifiedOffsetMs,
        expiresOffsetMs,
      });
      const claimId = await claim(repository, provisional);

      await expect(
        repository.prepare({
          ...provisional,
          ...walletLease,
          claimId,
        }),
      ).rejects.toBeInstanceOf(SpotIntentAuthorityStaleError);
      expect(await counts(pool)).toEqual({
        idempotency_count: "1",
        operation_count: "0",
        intent_count: "0",
        audit_count: "0",
        event_count: "0",
      });
    },
  );

  it("requires the active Agent to cover the complete review", async () => {
    const authority = await seedAuthority(pool, "prepare-agent-coverage", {
      signingExpiresOffsetMs: 13_000,
      agentValidUntilOffsetMs: 14_000,
    });
    const provisional = withReviewExpiry(
      prepareInput(authority, randomUUID()),
      new Date(Date.parse(authority.agentValidUntil) + 1).toISOString(),
    );
    const claimId = await claim(repository, provisional);

    await expect(
      repository.prepare({ ...provisional, claimId }),
    ).rejects.toBeInstanceOf(SpotIntentAuthorityStaleError);
    expect(await counts(pool)).toEqual({
      idempotency_count: "1",
      operation_count: "0",
      intent_count: "0",
      audit_count: "0",
      event_count: "0",
    });
  });

  it.each([
    ["Privy identity", { privyUserId: "did:privy:spot-intent:stale" }],
    ["wallet ID", { walletId: `wallet-${randomUUID()}` }],
  ] as const)(
    "rejects a stale %s even when the address and epoch still match",
    async (_label, authorityDrift) => {
      const authority = await seedAuthority(
        pool,
        `prepare-provider-identity-stale-${_label}`,
      );
      const provisional = prepareInput(authority, randomUUID(), authorityDrift);
      const claimId = await claim(repository, provisional);

      await expect(
        repository.prepare({ ...provisional, claimId }),
      ).rejects.toBeInstanceOf(SpotIntentAuthorityStaleError);
      expect(await counts(pool)).toEqual({
        idempotency_count: "1",
        operation_count: "0",
        intent_count: "0",
        audit_count: "0",
        event_count: "0",
      });
    },
  );

  it("uses the database clock for expiry and keeps the durable claim only", async () => {
    const authority = await seedAuthority(pool, "expired");
    const provisional = prepareInput(authority, randomUUID());
    const claimId = await claim(repository, provisional);
    const times = timestampWindow({
      factsOffsetMs: -60_000,
      referenceOffsetMs: -61_000,
      feeOffsetMs: -60_500,
      expiresOffsetMs: -1_000,
    });
    const { review_digest: _reviewDigest, ...baseReview } = parseSpotReview(
      provisional.publicReview,
    );
    void _reviewDigest;
    const publicReview = createSpotReview({
      ...baseReview,
      reference_source_time: times.referenceSourceTime,
      fee_source: {
        dataset: "user_fees",
        observed_at: times.feeObservedAt,
      },
      expires_at: times.expiresAt,
    });
    await expect(
      repository.prepare({
        ...provisional,
        claimId,
        publicReview,
        reviewSha256: publicReview.review_digest,
        factsObservedAt: times.factsObservedAt,
        referenceSourceTime: times.referenceSourceTime,
        expiresAt: times.expiresAt,
      }),
    ).rejects.toBeInstanceOf(SpotIntentPrepareExpiredError);
    expect(await counts(pool)).toEqual({
      idempotency_count: "1",
      operation_count: "0",
      intent_count: "0",
      audit_count: "0",
      event_count: "0",
    });
  });

  it("rechecks the wallet lease after a post-validation database lock wait", async () => {
    const authority = await seedAuthority(pool, "prepare-final-lease-check");
    const provisional = prepareInput(authority, randomUUID());
    const claimId = await claim(repository, provisional);
    const walletLease = await prepareAuthorityLease(pool, {
      verifiedOffsetMs: -100,
      expiresOffsetMs: 2_000,
    });
    const blocker = await pool.connect();
    let prepareOutcome: Promise<unknown> | undefined;
    try {
      await blocker.query("begin");
      await blocker.query(
        "lock table public.spot_intent_events in access exclusive mode",
      );
      prepareOutcome = repository
        .prepare({
          ...provisional,
          ...walletLease,
          claimId,
        })
        .then(
          (result) => result,
          (error: unknown) => error,
        );
      await waitForDatabaseLockWait(
        pool,
        "insert into public.spot_intent_events",
      );
      await blocker.query({
        text: `
          select pg_sleep(
            greatest(
              extract(epoch from ($1::timestamptz - clock_timestamp())),
              0
            ) + 0.05
          )
        `,
        values: [walletLease.walletExpiresAt],
      });
      await blocker.query("commit");

      expect(await prepareOutcome).toBeInstanceOf(
        SpotIntentAuthorityStaleError,
      );
    } catch (error) {
      await blocker.query("rollback").catch(() => undefined);
      if (prepareOutcome !== undefined) {
        await prepareOutcome;
      }
      throw error;
    } finally {
      blocker.release();
    }
    expect(await counts(pool)).toEqual({
      idempotency_count: "1",
      operation_count: "0",
      intent_count: "0",
      audit_count: "0",
      event_count: "0",
    });
  }, 10_000);

  it("rechecks the wallet lease after deferred constraints finish waiting", async () => {
    const advisoryLockKeys = [1_280_262_480, 1_397_772_116] as const;
    const authority = await seedAuthority(
      pool,
      "prepare-deferred-final-lease-check",
    );
    const provisional = prepareInput(authority, randomUUID());
    const claimId = await claim(repository, provisional);
    const walletLease = await prepareAuthorityLease(pool, {
      verifiedOffsetMs: -100,
      expiresOffsetMs: 2_000,
    });
    await pool.query(`
      create function public.wait_spot_intent_projection_for_test()
      returns trigger
      language plpgsql
      as $function$
      begin
        perform pg_advisory_xact_lock(
          ${advisoryLockKeys[0]},
          ${advisoryLockKeys[1]}
        );
        return new;
      end;
      $function$;

      create constraint trigger wait_spot_intent_projection_for_test
        after insert on public.spot_intents
        deferrable initially deferred
        for each row
        execute function public.wait_spot_intent_projection_for_test();
    `);
    const blocker = await pool.connect();
    let lockHeld = false;
    let prepareOutcome: Promise<unknown> | undefined;
    try {
      await blocker.query({
        text: "select pg_advisory_lock($1, $2)",
        values: [...advisoryLockKeys],
      });
      lockHeld = true;
      prepareOutcome = repository
        .prepare({
          ...provisional,
          ...walletLease,
          claimId,
        })
        .then(
          (result) => result,
          (error: unknown) => error,
        );
      await waitForDatabaseLockWait(pool, "set constraints all immediate");
      await blocker.query({
        text: `
          select pg_sleep(
            greatest(
              extract(epoch from ($1::timestamptz - clock_timestamp())),
              0
            ) + 0.05
          )
        `,
        values: [walletLease.walletExpiresAt],
      });
      await blocker.query({
        text: "select pg_advisory_unlock($1, $2)",
        values: [...advisoryLockKeys],
      });
      lockHeld = false;

      expect(await prepareOutcome).toBeInstanceOf(
        SpotIntentAuthorityStaleError,
      );
      expect(await counts(pool)).toEqual({
        idempotency_count: "1",
        operation_count: "0",
        intent_count: "0",
        audit_count: "0",
        event_count: "0",
      });
    } catch (error) {
      if (lockHeld) {
        await blocker
          .query({
            text: "select pg_advisory_unlock($1, $2)",
            values: [...advisoryLockKeys],
          })
          .catch(() => undefined);
        lockHeld = false;
      }
      if (prepareOutcome !== undefined) {
        await prepareOutcome;
      }
      throw error;
    } finally {
      if (lockHeld) {
        await blocker
          .query({
            text: "select pg_advisory_unlock($1, $2)",
            values: [...advisoryLockKeys],
          })
          .catch(() => undefined);
      }
      blocker.release();
      await pool.query(`
        drop trigger if exists wait_spot_intent_projection_for_test
          on public.spot_intents;
        drop function if exists public.wait_spot_intent_projection_for_test();
      `);
    }
  }, 10_000);

  it("forces deferred projection checks before commit and fully rolls back their failure", async () => {
    const authority = await seedAuthority(pool, "deferred-rollback");
    const provisional = prepareInput(authority, randomUUID());
    const claimId = await claim(repository, provisional);
    await pool.query(`
      create function public.fail_spot_intent_projection_for_test()
      returns trigger
      language plpgsql
      as $function$
      begin
        raise exception 'forced deferred Spot projection failure'
          using errcode = '23514';
      end;
      $function$;

      create constraint trigger fail_spot_intent_projection_for_test
        after insert on public.spot_intents
        deferrable initially deferred
        for each row
        execute function public.fail_spot_intent_projection_for_test();
    `);
    try {
      await expect(
        repository.prepare({ ...provisional, claimId }),
      ).rejects.toBeInstanceOf(SpotIntentRepositoryUnavailableError);
      expect(await counts(pool)).toEqual({
        idempotency_count: "1",
        operation_count: "0",
        intent_count: "0",
        audit_count: "0",
        event_count: "0",
      });
    } finally {
      await pool.query(`
        drop trigger if exists fail_spot_intent_projection_for_test
          on public.spot_intents;
        drop function if exists public.fail_spot_intent_projection_for_test();
      `);
    }
  });

  it("bounds active pending claims and recovers stale claims without weakening conflicts", async () => {
    const authority = await seedAuthority(pool, "claim-budget");
    const foreignOwner = await insertOwner(pool, "claim-budget-foreign");
    const recoverableRequest = {
      ownerUserId: authority.ownerUserId,
      idempotencyKey: randomUUID(),
      requestSha256: digestA,
    };
    const recoverableResult = await repository.claimPrepare(recoverableRequest);
    if (recoverableResult.kind !== "claimed") {
      throw new Error("Expected a recoverable pending claim fixture");
    }
    const stableClaimId = recoverableResult.claimId;
    await expirePendingClaim(pool, stableClaimId);

    const requests = Array.from(
      { length: SPOT_INTENT_PENDING_CLAIM_LIMIT_PER_OWNER },
      () => ({
        ownerUserId: authority.ownerUserId,
        idempotencyKey: randomUUID(),
        requestSha256: digestA,
      }),
    );
    const results = await Promise.allSettled(
      requests.map(async (request) => repository.claimPrepare(request)),
    );
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      SPOT_INTENT_PENDING_CLAIM_LIMIT_PER_OWNER,
    );
    expect(await counts(pool)).toMatchObject({
      idempotency_count: String(SPOT_INTENT_PENDING_CLAIM_LIMIT_PER_OWNER + 1),
      operation_count: "0",
      intent_count: "0",
    });

    await expect(
      repository.claimPrepare({
        ...recoverableRequest,
        requestSha256: digestB,
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(
      repository.claimPrepare({
        ...recoverableRequest,
        ownerUserId: foreignOwner.ownerUserId,
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(
      repository.claimPrepare(recoverableRequest),
    ).rejects.toBeInstanceOf(SpotIntentClaimLimitExceededError);
    await expect(
      repository.claimPrepare({
        ownerUserId: authority.ownerUserId,
        idempotencyKey: randomUUID(),
        requestSha256: digestA,
      }),
    ).rejects.toBeInstanceOf(SpotIntentClaimLimitExceededError);

    const activeClaim = results.find(
      (result) =>
        result.status === "fulfilled" && result.value.kind === "claimed",
    );
    if (
      activeClaim?.status !== "fulfilled" ||
      activeClaim.value.kind !== "claimed"
    ) {
      throw new Error("Expected an active pending claim fixture");
    }
    await expirePendingClaim(pool, activeClaim.value.claimId);
    await expect(repository.claimPrepare(recoverableRequest)).resolves.toEqual({
      kind: "claimed",
      claimId: stableClaimId,
    });
    expect(await counts(pool)).toMatchObject({
      idempotency_count: String(SPOT_INTENT_PENDING_CLAIM_LIMIT_PER_OWNER + 1),
      operation_count: "0",
      intent_count: "0",
    });
  });
});
