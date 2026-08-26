import { createHash, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { IdempotencyConflictError } from "../src/database/control-plane-repository.js";
import {
  createPostgresSpotAgentAuthorizationRepository,
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
  SpotIntentAuthorityStaleError,
  SpotIntentClaimLimitExceededError,
  SpotIntentPrepareClaimRequiredError,
  SpotIntentPrepareExpiredError,
  SpotIntentRepositoryUnavailableError,
  type PrepareSpotIntentInput,
  type SpotIntentRepository,
} from "../src/database/spot-intent-repository.js";
import {
  createSpotReview,
  parseSpotReview,
  SPOT_INTENT_IDEMPOTENCY_SCOPE,
  SPOT_INTENT_REQUEST_DIGEST_VERSION,
} from "../src/features/spot/spot-intent-contract.js";

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
const metadataVersion = "testnet_metadata_v1";
const policyVersion = "spot_ioc_v1";

interface OwnerFixture {
  readonly ownerUserId: string;
  readonly privyUserId: string;
}

interface AuthorityFixture extends OwnerFixture {
  readonly agentIdentityId: string;
  readonly authorizationId: string;
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
      nonce: context.authorizationNonce,
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
  const agentName = `Loop-${randomHex(8)} valid_until ${Date.parse(
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
    agentAddress: `0x${randomHex(40)}`,
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
    ...overrides,
  };
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

describe("PostgreSQL Spot intent repository", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  let repository: SpotIntentRepository;

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

  it("checks Agent authorization validity after taking its lock with the database clock", async () => {
    const authority = await seedAuthority(pool, "authorization-expired", {
      signingExpiresOffsetMs: 4_000,
      agentValidUntilOffsetMs: 5_000,
    });
    const provisional = prepareInput(authority, randomUUID());
    const claimId = await claim(repository, provisional);
    const blocker = await pool.connect();
    try {
      await blocker.query("begin");
      await blocker.query({
        text: `
            select id
            from public.spot_agent_authorizations
            where id = $1
            for update
          `,
        values: [authority.authorizationId],
      });
      const prepareOutcome = repository
        .prepare({ ...provisional, claimId })
        .then(
          () => null,
          (error: unknown) => error,
        );
      await waitForRowLockWait(pool, "from public.spot_agent_authorizations");
      await blocker.query({
        text: `
            select pg_sleep(
              greatest(
                extract(
                  epoch from (agent_valid_until - clock_timestamp())
                ),
                0
              ) + 0.05
            )
            from public.spot_agent_authorizations
            where id = $1
        `,
        values: [authority.authorizationId],
      });
      const authorizationRepository =
        createPostgresSpotAgentAuthorizationRepository(pool);
      await expect(
        authorizationRepository.retireElapsedAgentIdentities({
          requestId: randomUUID(),
          limit: 10,
        }),
      ).resolves.toEqual({ retiredCount: 0 });
      await blocker.query("commit");

      expect(await prepareOutcome).toBeInstanceOf(
        SpotIntentAuthorityStaleError,
      );
      await expect(
        authorizationRepository.retireElapsedAgentIdentities({
          requestId: randomUUID(),
          limit: 10,
        }),
      ).resolves.toEqual({ retiredCount: 1 });
    } catch (error) {
      await blocker.query("rollback").catch(() => undefined);
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
    await expect(
      pool.query<{ lifecycle_state: string }>({
        text: `
          select lifecycle_state
          from public.spot_agent_identities
          where id = $1
        `,
        values: [authority.agentIdentityId],
      }),
    ).resolves.toMatchObject({
      rows: [{ lifecycle_state: "retired" }],
    });
  }, 15_000);

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
