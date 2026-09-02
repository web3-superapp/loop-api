import { createHash, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createPostgresPerpWalletBindingRepository } from "../src/database/perp-wallet-binding-repository.js";
import {
  createPostgresSpotAgentAuthorizationRepository,
  HYPERLIQUID_SIGNER_NONCE_FUTURE_WINDOW_MILLISECONDS,
  SPOT_AGENT_AUTHORIZATION_ADMISSION_MAX_MILLISECONDS,
  SPOT_AGENT_AUTHORIZATION_AUTHORITY_LEASE_MILLISECONDS,
  SPOT_AGENT_AUTHORIZATION_MAX_AGENT_LIFETIME_MILLISECONDS,
  SPOT_AGENT_AUTHORIZATION_POLICY_VERSION,
  SPOT_AGENT_AUTHORIZATION_SIGNING_TTL_MILLISECONDS,
  SpotAgentAuthorizationAuthorityStaleError,
  SpotAgentAuthorizationNonceUnavailableError,
  SpotAgentAuthorizationPrepareExpiredError,
  SpotAgentAuthorizationRepositoryUnavailableError,
  type ComputeSpotAgentAuthorizationSigningDigest,
  type IssueSpotAgentAuthorizationInput,
  type MaterializeSpotAgentAuthorizationForNonce,
  type PreflightSpotAgentAuthorizationInput,
  type PostgresSpotAgentAuthorizationRepository,
  type ResolveCurrentSpotAgentAuthorityInput,
  type SpotAgentAuthorizationMaterializationContext,
} from "../src/database/spot-agent-authorization-repository.js";
import { createPerpWalletBindingResolver } from "../src/features/perp/wallet-binding-resolver.js";
import { createSpotIntentPrepareAuthorityResolver } from "../src/features/spot/spot-intent-prepare-authority-resolver.js";
import type { PrivyUserReader } from "../src/integrations/privy/user-reader.js";

const { Pool } = pg;
const databaseUrl = process.env["DATABASE_URL"];

if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error("DATABASE_URL is required for the integration test suite");
}

const truncateAll = `
  truncate table
    public.chat_operation_events,
    public.communication_group_members,
    public.direct_channels,
    public.social_operation_events,
    public.social_operations,
    public.friendships,
    public.friend_requests,
    public.social_privacy_preferences,
    public.chat_operations,
    public.price_alert_events,
    public.notification_preferences,
    public.notification_preference_versions,
    public.price_alert_definitions,
    public.watchlist_items,
    public.watchlist_groups,
    public.watchlist_versions,
    public.group_alias_reservations,
    public.communication_groups,
    public.privacy_preferences,
    public.user_profiles,
    public.spot_agent_authorization_events,
    public.spot_intent_events,
    public.spot_agent_identity_events,
    public.hyperliquid_signer_nonce_allocations,
    public.hyperliquid_signer_nonce_state,
    public.spot_agent_authorizations,
    public.spot_intents,
    public.spot_agent_identities,
    public.perp_wallet_binding_events,
    public.perp_wallet_bindings,
    public.perp_agent_authorization_events,
    public.perp_agent_authorizations,
    public.perp_agent_identities,
    public.perp_intent_events,
    public.perp_intent_items,
    public.perp_intents,
    public.audit_events,
    public.provider_operations,
    public.idempotency_records,
    public.issuance_rate_records,
    public.device_session_events,
    public.device_session_commands,
    public.device_sessions,
    public.loop_users
`;

interface AuthorityFixture {
  readonly ownerUserId: string;
  readonly privyUserId: string;
  readonly walletId: string;
  readonly accountAddress: string;
}

interface DatabaseTimes {
  readonly verifiedAt: string;
  readonly expiresAt: string;
  readonly policyCheckedAt: string;
  readonly policyExpiresAt: string;
  readonly admissionStartedAt: string;
  readonly admissionExpiresAt: string;
  readonly signingExpiresAt: string;
  readonly agentValidUntil: string;
}

interface DurableCounts {
  readonly allocation_count: string;
  readonly audit_count: string;
  readonly authorization_count: string;
  readonly authorization_event_count: string;
  readonly idempotency_count: string;
  readonly identity_count: string;
  readonly identity_event_count: string;
  readonly nonce_state_count: string;
  readonly operation_count: string;
}

interface DurableAuthoritySnapshot {
  readonly authorization: Readonly<Record<string, unknown>>;
  readonly idempotency: Readonly<Record<string, unknown>>;
  readonly identity: Readonly<Record<string, unknown>>;
  readonly operation: Readonly<Record<string, unknown>>;
  readonly wallet_binding: Readonly<Record<string, unknown>>;
}

function randomHex(length: number): string {
  return Array.from({ length: Math.ceil(length / 32) }, () =>
    randomUUID().replaceAll("-", ""),
  )
    .join("")
    .slice(0, length);
}

function randomAddress(): string {
  return `0x${randomHex(40)}`;
}

async function databaseTimes(
  pool: InstanceType<typeof Pool>,
  overrides: {
    readonly verifiedOffsetMs?: number;
    readonly authorityExpiresOffsetMs?: number;
    readonly policyCheckedOffsetMs?: number;
    readonly policyExpiresOffsetMs?: number;
    readonly admissionStartedOffsetMs?: number;
    readonly admissionExpiresOffsetMs?: number;
    readonly signingExpiresOffsetMs?: number;
    readonly agentValidUntilOffsetMs?: number;
  } = {},
): Promise<DatabaseTimes> {
  const verifiedOffsetMs = overrides.verifiedOffsetMs ?? -100;
  const authorityExpiresOffsetMs = overrides.authorityExpiresOffsetMs ?? 14_000;
  const policyCheckedOffsetMs = overrides.policyCheckedOffsetMs ?? -100;
  const policyExpiresOffsetMs = overrides.policyExpiresOffsetMs ?? 14_000;
  const admissionStartedOffsetMs = overrides.admissionStartedOffsetMs ?? -100;
  const admissionExpiresOffsetMs =
    overrides.admissionExpiresOffsetMs ??
    Math.min(
      authorityExpiresOffsetMs,
      policyExpiresOffsetMs,
      admissionStartedOffsetMs +
        SPOT_AGENT_AUTHORIZATION_ADMISSION_MAX_MILLISECONDS,
    );
  const result = await pool.query<{
    admission_expires_at: Date;
    admission_started_at: Date;
    agent_valid_until: Date;
    expires_at: Date;
    policy_checked_at: Date;
    policy_expires_at: Date;
    signing_expires_at: Date;
    verified_at: Date;
  }>({
    text: `
      with database_clock as (
        select clock_timestamp() as observed_at
      )
      select
        database_clock.observed_at
          + ($1::bigint * interval '1 millisecond') as verified_at,
        database_clock.observed_at
          + ($2::bigint * interval '1 millisecond') as expires_at,
        database_clock.observed_at
          + ($3::bigint * interval '1 millisecond') as policy_checked_at,
        database_clock.observed_at
          + ($4::bigint * interval '1 millisecond') as policy_expires_at,
        database_clock.observed_at
          + ($5::bigint * interval '1 millisecond') as admission_started_at,
        database_clock.observed_at
          + ($6::bigint * interval '1 millisecond') as admission_expires_at,
        database_clock.observed_at
          + ($7::bigint * interval '1 millisecond') as signing_expires_at,
        database_clock.observed_at
          + ($8::bigint * interval '1 millisecond') as agent_valid_until
      from database_clock
    `,
    values: [
      verifiedOffsetMs,
      authorityExpiresOffsetMs,
      policyCheckedOffsetMs,
      policyExpiresOffsetMs,
      admissionStartedOffsetMs,
      admissionExpiresOffsetMs,
      overrides.signingExpiresOffsetMs ?? 120_000,
      overrides.agentValidUntilOffsetMs ?? 3_600_000,
    ],
  });
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("Database clock fixture failed");
  }
  return Object.freeze({
    verifiedAt: row.verified_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    policyCheckedAt: row.policy_checked_at.toISOString(),
    policyExpiresAt: row.policy_expires_at.toISOString(),
    admissionStartedAt: row.admission_started_at.toISOString(),
    admissionExpiresAt: row.admission_expires_at.toISOString(),
    signingExpiresAt: row.signing_expires_at.toISOString(),
    agentValidUntil: row.agent_valid_until.toISOString(),
  });
}

async function seedAuthority(
  pool: InstanceType<typeof Pool>,
  label: string,
): Promise<AuthorityFixture> {
  const privyUserId = `did:privy:spot-agent:${label}:${randomUUID()}`;
  const owner = await pool.query<{ id: string }>({
    text: `
      insert into public.loop_users (privy_user_id)
      values ($1)
      returning id
    `,
    values: [privyUserId],
  });
  const ownerUserId = owner.rows[0]?.id;
  if (ownerUserId === undefined) {
    throw new Error("Spot Agent owner fixture failed");
  }
  const walletId = `wallet-${randomUUID()}`;
  const accountAddress = randomAddress();
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
    values: [ownerUserId, privyUserId, walletId, accountAddress],
  });
  return Object.freeze({
    ownerUserId,
    privyUserId,
    walletId,
    accountAddress,
  });
}

async function issueInput(
  pool: InstanceType<typeof Pool>,
  authority: AuthorityFixture,
  overrides: Partial<IssueSpotAgentAuthorizationInput> = {},
  timeOverrides: Parameters<typeof databaseTimes>[1] = {},
): Promise<IssueSpotAgentAuthorizationInput> {
  const times = await databaseTimes(pool, timeOverrides);
  const agentValidUntil = overrides.agentValidUntil ?? times.agentValidUntil;
  const agentAddress = overrides.agentAddress ?? randomAddress();
  const agentName =
    overrides.agentName ??
    `Loop-${agentAddress.slice(2, 13)} valid_until ${Date.parse(agentValidUntil)}`;
  return Object.freeze({
    authorizationId: randomUUID(),
    agentIdentityId: randomUUID(),
    agentGeneration: "1",
    ownerUserId: authority.ownerUserId,
    privyUserId: authority.privyUserId,
    requestId: randomUUID(),
    walletId: authority.walletId,
    accountAddress: authority.accountAddress,
    accountKind: "master",
    bindingVersion: "1",
    verifiedAt: times.verifiedAt,
    expiresAt: times.expiresAt,
    policyOwnerUserId: authority.ownerUserId,
    policyNetwork: "testnet",
    policyAction: "approve_agent",
    policyCheckedAt: times.policyCheckedAt,
    policyExpiresAt: times.policyExpiresAt,
    admissionStartedAt: times.admissionStartedAt,
    admissionExpiresAt: times.admissionExpiresAt,
    agentAddress,
    agentName,
    signerRef: `privy-server-wallet:${randomUUID()}`,
    agentValidUntil,
    signingExpiresAt: times.signingExpiresAt,
    policyVersion: SPOT_AGENT_AUTHORIZATION_POLICY_VERSION,
    ...overrides,
  });
}

function preflightInput(
  input: IssueSpotAgentAuthorizationInput,
  overrides: Partial<PreflightSpotAgentAuthorizationInput> = {},
): PreflightSpotAgentAuthorizationInput {
  return Object.freeze({
    ownerUserId: input.ownerUserId,
    privyUserId: input.privyUserId,
    requestId: input.requestId,
    walletId: input.walletId,
    accountAddress: input.accountAddress,
    accountKind: input.accountKind,
    bindingVersion: input.bindingVersion,
    verifiedAt: input.verifiedAt,
    expiresAt: input.expiresAt,
    policyOwnerUserId: input.policyOwnerUserId,
    policyNetwork: input.policyNetwork,
    policyAction: input.policyAction,
    policyCheckedAt: input.policyCheckedAt,
    policyExpiresAt: input.policyExpiresAt,
    admissionStartedAt: input.admissionStartedAt,
    admissionExpiresAt: input.admissionExpiresAt,
    policyVersion: input.policyVersion,
    ...overrides,
  });
}

function activeAuthorityInput(
  input: IssueSpotAgentAuthorizationInput,
  overrides: Partial<ResolveCurrentSpotAgentAuthorityInput> = {},
): ResolveCurrentSpotAgentAuthorityInput {
  return Object.freeze({
    ownerUserId: input.ownerUserId,
    privyUserId: input.privyUserId,
    requestId: input.requestId,
    walletId: input.walletId,
    accountAddress: input.accountAddress,
    accountKind: input.accountKind,
    bindingVersion: input.bindingVersion,
    verifiedAt: input.verifiedAt,
    expiresAt: input.expiresAt,
    policyVersion: input.policyVersion,
    ...overrides,
  });
}

function typedData(
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

const computeSigningDigest: ComputeSpotAgentAuthorizationSigningDigest =
  digestTypedData;

const materializeForNonce: MaterializeSpotAgentAuthorizationForNonce = (
  context,
) => {
  const value = typedData(context);
  return Object.freeze({
    typedData: value,
    signingDigest: digestTypedData(value),
  });
};

async function durableCounts(
  pool: InstanceType<typeof Pool>,
): Promise<DurableCounts> {
  const result = await pool.query<DurableCounts>(`
    select
      (select count(*)::text from public.idempotency_records)
        as idempotency_count,
      (select count(*)::text from public.provider_operations)
        as operation_count,
      (select count(*)::text from public.spot_agent_identities)
        as identity_count,
      (select count(*)::text from public.spot_agent_identity_events)
        as identity_event_count,
      (select count(*)::text from public.spot_agent_authorizations)
        as authorization_count,
      (select count(*)::text from public.spot_agent_authorization_events)
        as authorization_event_count,
      (select count(*)::text from public.hyperliquid_signer_nonce_state)
        as nonce_state_count,
      (select count(*)::text from public.hyperliquid_signer_nonce_allocations)
        as allocation_count,
      (select count(*)::text from public.audit_events)
        as audit_count
  `);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("Spot Agent durable-count query failed");
  }
  return row;
}

async function durableAuthoritySnapshot(
  pool: InstanceType<typeof Pool>,
  input: IssueSpotAgentAuthorizationInput,
): Promise<DurableAuthoritySnapshot> {
  const result = await pool.query<DurableAuthoritySnapshot>({
    text: `
      select
        (
          select to_jsonb(binding)
          from public.perp_wallet_bindings as binding
          where binding.owner_user_id = $1
        ) as wallet_binding,
        (
          select to_jsonb(identity)
          from public.spot_agent_identities as identity
          where identity.id = $2
        ) as identity,
        (
          select to_jsonb(agent_auth)
          from public.spot_agent_authorizations as agent_auth
          where agent_auth.id = $3
        ) as authorization,
        (
          select to_jsonb(operation)
          from public.provider_operations as operation
          where operation.id = $3
        ) as operation,
        (
          select to_jsonb(idempotency)
          from public.idempotency_records as idempotency
          join public.provider_operations as operation
            on operation.idempotency_record_id = idempotency.id
          where operation.id = $3
        ) as idempotency
    `,
    values: [input.ownerUserId, input.agentIdentityId, input.authorizationId],
  });
  const row = result.rows[0];
  if (
    row === undefined ||
    Object.values(row).some(
      (value) =>
        typeof value !== "object" || value === null || Array.isArray(value),
    )
  ) {
    throw new Error("Spot Agent durable-snapshot query failed");
  }
  return row;
}

function expectNoIssuedRows(counts: DurableCounts): void {
  expect(counts).toEqual({
    idempotency_count: "0",
    operation_count: "0",
    identity_count: "0",
    identity_event_count: "0",
    authorization_count: "0",
    authorization_event_count: "0",
    nonce_state_count: "0",
    allocation_count: "0",
    audit_count: "0",
  });
}

async function activateAuthorization(
  pool: InstanceType<typeof Pool>,
  input: IssueSpotAgentAuthorizationInput,
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
        where operation.id = $1
      `,
      values: [input.authorizationId, attemptId],
    });
    await client.query({
      text: `
        update public.spot_agent_authorizations
        set
          state = 'submitting',
          record_version = 1,
          updated_at = clock_timestamp()
        where id = $1
      `,
      values: [input.authorizationId],
    });
    await client.query("set constraints all immediate");
    await client.query("commit");

    await client.query("begin");
    await client.query({
      text: `
        update public.provider_operations
        set
          state = 'succeeded',
          record_version = 2,
          updated_at = clock_timestamp()
        where id = $1 and state = 'submitting'
      `,
      values: [input.authorizationId],
    });
    await client.query({
      text: `
        update public.spot_agent_authorizations
        set
          state = 'active',
          result_observed_at = clock_timestamp(),
          result_reason_code = null,
          record_version = 2,
          updated_at = clock_timestamp()
        where id = $1 and state = 'submitting'
      `,
      values: [input.authorizationId],
    });
    await client.query({
      text: `
        update public.spot_agent_identities
        set
          lifecycle_state = 'active',
          record_version = 2,
          updated_at = clock_timestamp()
        where id = $1 and lifecycle_state = 'authorization_pending'
      `,
      values: [input.agentIdentityId],
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
        input.authorizationId,
        input.ownerUserId,
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
      values: [input.agentIdentityId, input.ownerUserId, randomUUID()],
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

async function transitionPreparedIdentity(
  pool: InstanceType<typeof Pool>,
  agentIdentityId: string,
  targetState: "operator_hold" | "revoked",
): Promise<void> {
  const result = await pool.query({
    text: `
      update public.spot_agent_identities
      set
        lifecycle_state = $2,
        record_version = record_version + 1,
        updated_at = clock_timestamp()
      where id = $1 and lifecycle_state = 'authorization_pending'
    `,
    values: [agentIdentityId, targetState],
  });
  expect(result.rowCount).toBe(1);
}

describe("PostgreSQL Spot Agent authorization repository", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  let repository: PostgresSpotAgentAuthorizationRepository;

  beforeEach(async () => {
    await pool.query(truncateAll);
    repository = createPostgresSpotAgentAuthorizationRepository(pool);
  });

  afterAll(async () => {
    await pool.query(truncateAll);
    await pool.end();
  });

  it("reads one exact current active Agent with no durable write", async () => {
    const authority = await seedAuthority(pool, "active-reader");
    const input = await issueInput(pool, authority);
    const issued = await repository.issueOrReplayCurrent(
      input,
      materializeForNonce,
      computeSigningDigest,
    );
    expect(issued.kind).toBe("issued");
    await activateAuthorization(pool, input);
    const before = await durableCounts(pool);
    const beforeSnapshot = await durableAuthoritySnapshot(pool, input);

    await expect(
      repository.findCurrentActive(
        activeAuthorityInput(input, { requestId: randomUUID() }),
      ),
    ).resolves.toEqual({
      authorizationId: input.authorizationId,
      agentIdentityId: input.agentIdentityId,
      agentValidUntil: input.agentValidUntil,
    });
    expect(await durableCounts(pool)).toEqual(before);
    expect(await durableAuthoritySnapshot(pool, input)).toEqual(beforeSnapshot);
  });

  it("joins the real wallet resolver and active-Agent reader without runtime composition", async () => {
    const authority = await seedAuthority(pool, "active-reader-seam");
    const input = await issueInput(pool, authority);
    await repository.issueOrReplayCurrent(
      input,
      materializeForNonce,
      computeSigningDigest,
    );
    await activateAuthorization(pool, input);
    const readCurrentUser = vi.fn<PrivyUserReader["readCurrentUser"]>(() =>
      Promise.resolve({
        id: authority.privyUserId,
        linked_accounts: [
          {
            type: "wallet",
            chain_type: "ethereum",
            wallet_client_type: "privy",
            connector_type: "embedded",
            id: authority.walletId,
            address: authority.accountAddress,
          },
        ],
      }),
    );
    const walletBindingAuthorityResolver = createPerpWalletBindingResolver({
      repository: createPostgresPerpWalletBindingRepository(pool),
      userReader: { readCurrentUser },
    });
    const resolver = createSpotIntentPrepareAuthorityResolver({
      walletBindingAuthorityResolver,
      activeAgentAuthorityReader: repository,
    });

    const resolved = await resolver.resolve({
      ownerUserId: authority.ownerUserId,
      privyUserId: authority.privyUserId,
      network: "testnet",
      requestId: randomUUID(),
      signal: new AbortController().signal,
    });

    if (
      typeof resolved !== "object" ||
      resolved === null ||
      !("verifiedAt" in resolved) ||
      typeof resolved.verifiedAt !== "string" ||
      !("expiresAt" in resolved) ||
      typeof resolved.expiresAt !== "string"
    ) {
      throw new Error("Spot authority seam returned a malformed lease");
    }
    expect(
      Date.parse(resolved.expiresAt) - Date.parse(resolved.verifiedAt),
    ).toBe(SPOT_AGENT_AUTHORIZATION_AUTHORITY_LEASE_MILLISECONDS);
    expect(resolved).toStrictEqual({
      ownerUserId: authority.ownerUserId,
      privyUserId: authority.privyUserId,
      walletId: authority.walletId,
      accountAddress: authority.accountAddress,
      accountKind: "master",
      bindingVersion: "1",
      agentIdentityId: input.agentIdentityId,
      verifiedAt: resolved.verifiedAt,
      expiresAt: resolved.expiresAt,
    });
    expect(readCurrentUser).toHaveBeenCalledOnce();
  });

  it("returns null before an Agent becomes active", async () => {
    const authority = await seedAuthority(pool, "active-reader-required");
    const input = await issueInput(pool, authority);

    await expect(
      repository.findCurrentActive(activeAuthorityInput(input)),
    ).resolves.toBeNull();

    await repository.issueOrReplayCurrent(
      input,
      materializeForNonce,
      computeSigningDigest,
    );
    await expect(
      repository.findCurrentActive(activeAuthorityInput(input)),
    ).resolves.toBeNull();
  });

  it("does not turn an operator-held Agent into user-remediable missing authority", async () => {
    const authority = await seedAuthority(pool, "active-reader-held");
    const input = await issueInput(pool, authority);
    await repository.issueOrReplayCurrent(
      input,
      materializeForNonce,
      computeSigningDigest,
    );
    await transitionPreparedIdentity(
      pool,
      input.agentIdentityId,
      "operator_hold",
    );

    await expect(
      repository.findCurrentActive(activeAuthorityInput(input)),
    ).rejects.toBeInstanceOf(SpotAgentAuthorizationAuthorityStaleError);
  });

  it.each([
    ["Privy subject", { privyUserId: "did:privy:other-subject" }],
    ["wallet ID", { walletId: "wallet-other" }],
    ["account address", { accountAddress: randomAddress() }],
    ["binding epoch", { bindingVersion: "2" }],
  ] as const)("rejects a stale %s coordinate", async (_label, drift) => {
    const authority = await seedAuthority(pool, `active-reader-${_label}`);
    const input = await issueInput(pool, authority);
    await repository.issueOrReplayCurrent(
      input,
      materializeForNonce,
      computeSigningDigest,
    );
    await activateAuthorization(pool, input);

    await expect(
      repository.findCurrentActive(activeAuthorityInput(input, drift)),
    ).rejects.toBeInstanceOf(SpotAgentAuthorizationAuthorityStaleError);
  });

  it.each([
    ["future", { verifiedOffsetMs: 1_000, authorityExpiresOffsetMs: 2_000 }],
    ["expired", { verifiedOffsetMs: -2_000, authorityExpiresOffsetMs: -1_000 }],
    ["overlong", { verifiedOffsetMs: -100, authorityExpiresOffsetMs: 15_001 }],
  ] as const)(
    "rejects %s wallet evidence with the DB clock",
    async (_label, offsets) => {
      const authority = await seedAuthority(
        pool,
        `active-reader-lease-${_label}`,
      );
      const input = await issueInput(pool, authority);
      await repository.issueOrReplayCurrent(
        input,
        materializeForNonce,
        computeSigningDigest,
      );
      await activateAuthorization(pool, input);
      const times = await databaseTimes(pool, offsets);

      await expect(
        repository.findCurrentActive(
          activeAuthorityInput(input, {
            verifiedAt: times.verifiedAt,
            expiresAt: times.expiresAt,
          }),
        ),
      ).rejects.toBeInstanceOf(SpotAgentAuthorizationAuthorityStaleError);
    },
  );

  it("returns null when an otherwise active Agent validity has elapsed", async () => {
    const authority = await seedAuthority(pool, "active-reader-elapsed");
    const input = await issueInput(
      pool,
      authority,
      {},
      {
        signingExpiresOffsetMs: 500,
        agentValidUntilOffsetMs: 1_000,
      },
    );
    await repository.issueOrReplayCurrent(
      input,
      materializeForNonce,
      computeSigningDigest,
    );
    await activateAuthorization(pool, input);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const times = await databaseTimes(pool);

    await expect(
      repository.findCurrentActive(
        activeAuthorityInput(input, {
          verifiedAt: times.verifiedAt,
          expiresAt: times.expiresAt,
        }),
      ),
    ).resolves.toBeNull();
  });

  it("rechecks wallet evidence after a row-lock wait crosses its expiry", async () => {
    const authority = await seedAuthority(pool, "active-reader-lock-wait");
    const input = await issueInput(pool, authority);
    await repository.issueOrReplayCurrent(
      input,
      materializeForNonce,
      computeSigningDigest,
    );
    await activateAuthorization(pool, input);
    const times = await databaseTimes(pool, {
      verifiedOffsetMs: -50,
      authorityExpiresOffsetMs: 250,
    });
    const locker = await pool.connect();
    try {
      await locker.query("begin");
      await locker.query({
        text: `
          select owner_user_id
          from public.perp_wallet_bindings
          where owner_user_id = $1
          for update
        `,
        values: [input.ownerUserId],
      });

      const pending = repository.findCurrentActive(
        activeAuthorityInput(input, {
          verifiedAt: times.verifiedAt,
          expiresAt: times.expiresAt,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 350));
      await locker.query("commit");

      await expect(pending).rejects.toBeInstanceOf(
        SpotAgentAuthorizationAuthorityStaleError,
      );
    } finally {
      await locker.query("rollback").catch(() => undefined);
      locker.release();
    }
  });

  it("returns null after an authorization row-lock wait crosses Agent validity", async () => {
    const authority = await seedAuthority(pool, "active-reader-agent-wait");
    const input = await issueInput(
      pool,
      authority,
      {},
      {
        signingExpiresOffsetMs: 500,
        agentValidUntilOffsetMs: 2_000,
      },
    );
    await repository.issueOrReplayCurrent(
      input,
      materializeForNonce,
      computeSigningDigest,
    );
    await activateAuthorization(pool, input);
    const before = await durableCounts(pool);
    const beforeSnapshot = await durableAuthoritySnapshot(pool, input);
    const locker = await pool.connect();
    try {
      await locker.query("begin");
      await locker.query({
        text: `
          select id
          from public.spot_agent_authorizations
          where id = $1
          for update
        `,
        values: [input.authorizationId],
      });

      const pending = repository.findCurrentActive(activeAuthorityInput(input));
      const earlyState = await Promise.race([
        pending.then(
          () => "settled" as const,
          () => "settled" as const,
        ),
        new Promise<"waiting">((resolve) =>
          setTimeout(() => resolve("waiting"), 100),
        ),
      ]);
      expect(earlyState).toBe("waiting");
      await new Promise((resolve) => setTimeout(resolve, 2_050));
      await locker.query("commit");

      await expect(pending).resolves.toBeNull();
      expect(await durableCounts(pool)).toEqual(before);
      expect(await durableAuthoritySnapshot(pool, input)).toEqual(
        beforeSnapshot,
      );
    } finally {
      await locker.query("rollback").catch(() => undefined);
      locker.release();
    }
  });

  it("issues once under concurrency and reserves one DB-clock nonce with no transport attempt", async () => {
    const authority = await seedAuthority(pool, "concurrent");
    const inputs = await Promise.all(
      Array.from({ length: 12 }, () => issueInput(pool, authority)),
    );

    const results = await Promise.all(
      inputs.map((input) =>
        repository.issueOrReplayCurrent(
          input,
          materializeForNonce,
          computeSigningDigest,
        ),
      ),
    );

    expect(results.filter((result) => result.kind === "issued")).toHaveLength(
      1,
    );
    expect(results.filter((result) => result.kind === "replayed")).toHaveLength(
      11,
    );
    const issued = results.find((result) => result.kind === "issued");
    if (issued === undefined) {
      throw new Error("Concurrent Spot Agent issuance had no winner");
    }
    expect(new Set(results.map((result) => result.authorization.id))).toEqual(
      new Set([issued.authorization.id]),
    );
    expect(
      new Set(
        results.map((result) =>
          JSON.stringify(result.signablePayload?.typed_data),
        ),
      ),
    ).toHaveLength(1);

    expect(await durableCounts(pool)).toEqual({
      idempotency_count: "1",
      operation_count: "1",
      identity_count: "1",
      identity_event_count: "2",
      authorization_count: "1",
      authorization_event_count: "1",
      nonce_state_count: "1",
      allocation_count: "1",
      audit_count: "1",
    });
    const rows = await pool.query<{
      attempt_count: number;
      authorization_version: string;
      identity_state: string;
      identity_version: string;
      nonce: string;
      operation_state: string;
      operation_version: string;
      typed_data_json_sha256: string;
    }>({
      text: `
        select
          operation.attempt_count,
          operation.state as operation_state,
          operation.record_version::text as operation_version,
          identity.lifecycle_state as identity_state,
          identity.record_version::text as identity_version,
          agent_auth.record_version::text as authorization_version,
          agent_auth.typed_data_json_sha256,
          allocation.nonce::text as nonce
        from public.provider_operations as operation
        join public.spot_agent_authorizations as agent_auth
          on agent_auth.id = operation.id
        join public.spot_agent_identities as identity
          on identity.id = agent_auth.agent_identity_id
        join public.hyperliquid_signer_nonce_allocations as allocation
          on allocation.operation_id = agent_auth.id
        where agent_auth.id = $1
      `,
      values: [issued.authorization.id],
    });
    const row = rows.rows[0];
    expect(row).toMatchObject({
      attempt_count: 0,
      operation_state: "prepared",
      operation_version: "0",
      identity_state: "authorization_pending",
      identity_version: "1",
      authorization_version: "0",
    });
    expect(issued.signablePayload).not.toBeNull();
    expect(row?.typed_data_json_sha256).toBe(
      createHash("sha256")
        .update(JSON.stringify(issued.signablePayload.typed_data), "utf8")
        .digest("hex"),
    );
    expect(row?.nonce).toBe(issued.authorization.authorizationNonce);
  });

  it("recovers a response-loss replay from the current owner/DID/binding snapshot without allocating", async () => {
    const authority = await seedAuthority(pool, "response-loss");
    const firstInput = await issueInput(pool, authority);
    const first = await repository.issueOrReplayCurrent(
      firstInput,
      materializeForNonce,
      computeSigningDigest,
    );
    expect(first.kind).toBe("issued");
    const retryInput = await issueInput(pool, authority);
    await pool.query({
      text: `
        update public.hyperliquid_signer_nonce_state
        set
          last_allocated_nonce = last_allocated_nonce + $2::numeric,
          updated_at = clock_timestamp()
        where network = 'testnet' and signer_address = $1
      `,
      values: [
        authority.accountAddress,
        HYPERLIQUID_SIGNER_NONCE_FUTURE_WINDOW_MILLISECONDS + 1_000,
      ],
    });
    const nonceBefore = await pool.query<{
      last_allocated_nonce: string;
      updated_at: Date;
    }>({
      text: `
        select last_allocated_nonce::text as last_allocated_nonce, updated_at
        from public.hyperliquid_signer_nonce_state
        where network = 'testnet' and signer_address = $1
      `,
      values: [authority.accountAddress],
    });
    const replayMaterializer = vi.fn(materializeForNonce);
    const preflight = await repository.preflightCurrent(
      preflightInput(retryInput),
      replayMaterializer,
      computeSigningDigest,
    );
    expect(preflight.kind).toBe("replayed");
    expect(preflight.authorization?.id).toBe(firstInput.authorizationId);
    expect(preflight.signablePayload).toEqual(first.signablePayload);
    expect(replayMaterializer).toHaveBeenCalledTimes(1);

    const replay = await repository.issueOrReplayCurrent(
      retryInput,
      materializeForNonce,
      computeSigningDigest,
    );
    expect(replay).toMatchObject({
      kind: "replayed",
      created: false,
      authorization: {
        id: firstInput.authorizationId,
        authorizationNonce: first.authorization.authorizationNonce,
      },
    });
    expect(replay.signablePayload).toEqual(first.signablePayload);
    expect(await durableCounts(pool)).toMatchObject({
      idempotency_count: "1",
      operation_count: "1",
      authorization_count: "1",
      allocation_count: "1",
      nonce_state_count: "1",
    });
    const nonceAfter = await pool.query<{
      last_allocated_nonce: string;
      updated_at: Date;
    }>({
      text: `
        select last_allocated_nonce::text as last_allocated_nonce, updated_at
        from public.hyperliquid_signer_nonce_state
        where network = 'testnet' and signer_address = $1
      `,
      values: [authority.accountAddress],
    });
    expect(nonceAfter.rows[0]).toEqual(nonceBefore.rows[0]);
  });

  it.each(["preflight", "issue"] as const)(
    "does not return a %s replay whose signing handoff expires during materialization",
    async (operation) => {
      const authority = await seedAuthority(pool, `replay-expiry-${operation}`);
      const firstInput = await issueInput(
        pool,
        authority,
        {},
        { signingExpiresOffsetMs: 900 },
      );
      await expect(
        repository.issueOrReplayCurrent(
          firstInput,
          materializeForNonce,
          computeSigningDigest,
        ),
      ).resolves.toMatchObject({ kind: "issued", created: true });
      const before = await durableCounts(pool);
      const retryInput = await issueInput(pool, authority);
      const slowReplayMaterializer =
        vi.fn<MaterializeSpotAgentAuthorizationForNonce>((context) => {
          void Atomics.wait(
            new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
            0,
            0,
            1_000,
          );
          return materializeForNonce(context);
        });

      const replay =
        operation === "preflight"
          ? repository.preflightCurrent(
              preflightInput(retryInput),
              slowReplayMaterializer,
              computeSigningDigest,
            )
          : repository.issueOrReplayCurrent(
              retryInput,
              slowReplayMaterializer,
              computeSigningDigest,
            );
      await expect(replay).rejects.toBeInstanceOf(
        SpotAgentAuthorizationPrepareExpiredError,
      );
      expect(slowReplayMaterializer).toHaveBeenCalledTimes(1);
      expect(await durableCounts(pool)).toEqual(before);
    },
  );

  it("locks the owner then rejects stale authority identity, wallet, address, and lease snapshots before allocation", async () => {
    const authority = await seedAuthority(pool, "authority-fence");
    const base = await issueInput(pool, authority);
    const materializer = vi.fn(materializeForNonce);
    const hasher = vi.fn(computeSigningDigest);
    const futureLease = await databaseTimes(pool, {
      verifiedOffsetMs: 1_000,
      authorityExpiresOffsetMs: 10_000,
    });
    const expiredLease = await databaseTimes(pool, {
      verifiedOffsetMs: -10_000,
      authorityExpiresOffsetMs: -1,
    });
    const overlongLease = await databaseTimes(pool, {
      verifiedOffsetMs: -100,
      authorityExpiresOffsetMs:
        SPOT_AGENT_AUTHORIZATION_AUTHORITY_LEASE_MILLISECONDS + 1_000,
    });
    const exactBoundaryLease = await databaseTimes(pool, {
      verifiedOffsetMs: -100,
      authorityExpiresOffsetMs:
        SPOT_AGENT_AUTHORIZATION_AUTHORITY_LEASE_MILLISECONDS - 100,
    });
    const foreignOwnerUserId = randomUUID();
    const cases: readonly PreflightSpotAgentAuthorizationInput[] = [
      preflightInput(base, { privyUserId: `did:privy:wrong:${randomUUID()}` }),
      preflightInput(base, {
        ownerUserId: foreignOwnerUserId,
        policyOwnerUserId: foreignOwnerUserId,
      }),
      preflightInput(base, { walletId: `wallet-${randomUUID()}` }),
      preflightInput(base, { accountAddress: randomAddress() }),
      preflightInput(base, {
        verifiedAt: futureLease.verifiedAt,
        expiresAt: futureLease.expiresAt,
      }),
      preflightInput(base, {
        verifiedAt: expiredLease.verifiedAt,
        expiresAt: expiredLease.expiresAt,
      }),
      preflightInput(base, {
        verifiedAt: overlongLease.verifiedAt,
        expiresAt: overlongLease.expiresAt,
      }),
    ];

    for (const value of cases) {
      await expect(
        repository.preflightCurrent(value, materializer, hasher),
      ).rejects.toBeInstanceOf(SpotAgentAuthorizationAuthorityStaleError);
      expectNoIssuedRows(await durableCounts(pool));
    }
    expect(materializer).not.toHaveBeenCalled();
    expect(hasher).not.toHaveBeenCalled();

    await expect(
      repository.preflightCurrent(
        preflightInput(await issueInput(pool, authority), {
          verifiedAt: exactBoundaryLease.verifiedAt,
          expiresAt: exactBoundaryLease.expiresAt,
        }),
        materializer,
        hasher,
      ),
    ).resolves.toEqual({
      kind: "issue_required",
      created: false,
      agentGeneration: "1",
      reservedIdentity: null,
      authorization: null,
      signablePayload: null,
    });
    expectNoIssuedRows(await durableCounts(pool));
  });

  it("rejects a skipped Agent generation before identity or nonce persistence", async () => {
    const authority = await seedAuthority(pool, "generation-skip");
    await expect(
      repository.preflightCurrent(
        preflightInput(await issueInput(pool, authority)),
        materializeForNonce,
        computeSigningDigest,
      ),
    ).resolves.toMatchObject({
      kind: "issue_required",
      agentGeneration: "1",
    });

    await expect(
      repository.issueOrReplayCurrent(
        await issueInput(pool, authority, { agentGeneration: "2" }),
        materializeForNonce,
        computeSigningDigest,
      ),
    ).rejects.toBeInstanceOf(SpotAgentAuthorizationAuthorityStaleError);
    expectNoIssuedRows(await durableCounts(pool));
  });

  it("fails closed before allocation when the Agent generation bigint is exhausted", async () => {
    const authority = await seedAuthority(pool, "generation-overflow");
    const exhaustedIdentityId = randomUUID();
    await pool.query({
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
        values ($1, $2, 1, 9223372036854775807, $3, $4, $5)
      `,
      values: [
        exhaustedIdentityId,
        authority.ownerUserId,
        randomAddress(),
        `Loop-${randomHex(8)}`,
        `privy-server-wallet:${randomUUID()}`,
      ],
    });
    await pool.query({
      text: `
        update public.spot_agent_identities
        set
          lifecycle_state = 'retired',
          record_version = 1,
          updated_at = clock_timestamp()
        where id = $1
      `,
      values: [exhaustedIdentityId],
    });

    await expect(
      repository.preflightCurrent(
        preflightInput(await issueInput(pool, authority)),
        materializeForNonce,
        computeSigningDigest,
      ),
    ).rejects.toBeInstanceOf(SpotAgentAuthorizationRepositoryUnavailableError);
    expect(await durableCounts(pool)).toEqual({
      idempotency_count: "0",
      operation_count: "0",
      identity_count: "1",
      identity_event_count: "0",
      authorization_count: "0",
      authorization_event_count: "0",
      nonce_state_count: "0",
      allocation_count: "0",
      audit_count: "0",
    });
  });

  it("rechecks the authority lease after deferred constraints and rolls back a payload that crossed expiry", async () => {
    const authority = await seedAuthority(pool, "lease-toctou");
    const input = await issueInput(
      pool,
      authority,
      {},
      {
        verifiedOffsetMs: -100,
        authorityExpiresOffsetMs: 500,
      },
    );
    const slowMaterializer: MaterializeSpotAgentAuthorizationForNonce = (
      context,
    ) => {
      void Atomics.wait(
        new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
        0,
        0,
        650,
      );
      return materializeForNonce(context);
    };

    await expect(
      repository.issueOrReplayCurrent(
        input,
        slowMaterializer,
        computeSigningDigest,
      ),
    ).rejects.toBeInstanceOf(SpotAgentAuthorizationAuthorityStaleError);
    expectNoIssuedRows(await durableCounts(pool));
  });

  it("rejects stale or unbounded policy and admission evidence before any durable write", async () => {
    const authority = await seedAuthority(pool, "policy-admission-window");
    const valid = await issueInput(pool, authority);
    const mismatchedPolicyCoordinates = [
      { ...valid, policyOwnerUserId: randomUUID() },
      { ...valid, policyNetwork: "mainnet" },
      { ...valid, policyAction: "approve_builder_fee" },
    ] as unknown as readonly IssueSpotAgentAuthorizationInput[];
    const cases = [
      {
        policyCheckedOffsetMs: 100,
        policyExpiresOffsetMs: 1_000,
      },
      {
        policyCheckedOffsetMs: -2_000,
        policyExpiresOffsetMs: -1,
      },
      {
        policyCheckedOffsetMs: -100,
        policyExpiresOffsetMs:
          SPOT_AGENT_AUTHORIZATION_AUTHORITY_LEASE_MILLISECONDS + 1,
      },
      {
        admissionStartedOffsetMs: -100,
        admissionExpiresOffsetMs:
          SPOT_AGENT_AUTHORIZATION_ADMISSION_MAX_MILLISECONDS + 1,
      },
      {
        policyExpiresOffsetMs: 5_000,
        admissionExpiresOffsetMs: 6_000,
      },
      {
        authorityExpiresOffsetMs: 5_000,
        admissionExpiresOffsetMs: 6_000,
      },
      {
        admissionStartedOffsetMs: 100,
        admissionExpiresOffsetMs: 1_000,
      },
    ] as const;
    const materializer = vi.fn(materializeForNonce);

    for (const input of mismatchedPolicyCoordinates) {
      await expect(
        repository.issueOrReplayCurrent(
          input,
          materializer,
          computeSigningDigest,
        ),
      ).rejects.toBeInstanceOf(
        SpotAgentAuthorizationRepositoryUnavailableError,
      );
      expectNoIssuedRows(await durableCounts(pool));
    }

    for (const timeOverrides of cases) {
      await expect(
        repository.issueOrReplayCurrent(
          await issueInput(pool, authority, {}, timeOverrides),
          materializer,
          computeSigningDigest,
        ),
      ).rejects.toBeInstanceOf(SpotAgentAuthorizationAuthorityStaleError);
      expectNoIssuedRows(await durableCounts(pool));
    }
    expect(materializer).not.toHaveBeenCalled();
  });

  it.each([
    ["policy lease", { policyExpiresOffsetMs: 500 }],
    ["workflow admission", { admissionExpiresOffsetMs: 500 }],
  ] as const)(
    "rolls back identity, nonce, and authorization when the %s expires before commit",
    async (_label, timeOverrides) => {
      const authority = await seedAuthority(pool, `issuance-toctou-${_label}`);
      const input = await issueInput(pool, authority, {}, timeOverrides);
      const slowMaterializer: MaterializeSpotAgentAuthorizationForNonce = (
        context,
      ) => {
        void Atomics.wait(
          new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
          0,
          0,
          650,
        );
        return materializeForNonce(context);
      };

      await expect(
        repository.issueOrReplayCurrent(
          input,
          slowMaterializer,
          computeSigningDigest,
        ),
      ).rejects.toBeInstanceOf(SpotAgentAuthorizationAuthorityStaleError);
      expectNoIssuedRows(await durableCounts(pool));
    },
  );

  it("aborts a saturated pool acquisition and releases the late client without opening a transaction", async () => {
    const authority = await seedAuthority(pool, "issuance-pool-abort");
    const input = await issueInput(pool, authority);
    const constrainedPool = new Pool({ connectionString: databaseUrl, max: 1 });
    const heldClient = await constrainedPool.connect();
    const constrainedRepository =
      createPostgresSpotAgentAuthorizationRepository(constrainedPool);
    const controller = new AbortController();
    const pending = constrainedRepository.issueOrReplayCurrent(
      input,
      materializeForNonce,
      computeSigningDigest,
      controller.signal,
    );
    const pendingExpectation = expect(pending).rejects.toBeInstanceOf(
      SpotAgentAuthorizationAuthorityStaleError,
    );
    const abortTimer = setTimeout(() => controller.abort(), 25);

    try {
      await pendingExpectation;
    } finally {
      clearTimeout(abortTimer);
      heldClient.release();
    }
    await expect(constrainedPool.query("select 1")).resolves.toBeDefined();
    await constrainedPool.end();
    expectNoIssuedRows(await durableCounts(pool));
  });

  it("bounds an advisory-lock wait by the admission deadline and rolls back after abort", async () => {
    const authority = await seedAuthority(pool, "issuance-lock-abort");
    const input = await issueInput(
      pool,
      authority,
      {},
      { admissionExpiresOffsetMs: 300 },
    );
    const blocker = await pool.connect();
    const controller = new AbortController();
    try {
      await blocker.query("begin");
      await blocker.query({
        text: "select pg_advisory_xact_lock(hashtext($1))",
        values: [
          `loop.spot.agent-authorization.issue-lock.v1:${input.ownerUserId}:${input.bindingVersion}`,
        ],
      });
      const pending = repository.issueOrReplayCurrent(
        input,
        materializeForNonce,
        computeSigningDigest,
        controller.signal,
      );
      const pendingExpectation = expect(pending).rejects.toBeInstanceOf(
        SpotAgentAuthorizationRepositoryUnavailableError,
      );
      const abortTimer = setTimeout(() => controller.abort(), 25);
      try {
        await pendingExpectation;
      } finally {
        clearTimeout(abortTimer);
      }
      await blocker.query("rollback");
    } catch (error) {
      await blocker.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      blocker.release();
    }
    await expect(pool.query("select 1")).resolves.toBeDefined();
    expectNoIssuedRows(await durableCounts(pool));
  });

  it("re-arms each SQL wait against one absolute admission deadline", async () => {
    const authority = await seedAuthority(pool, "issuance-absolute-deadline");
    const input = await issueInput(
      pool,
      authority,
      {},
      { admissionExpiresOffsetMs: 1_200 },
    );
    const advisoryBlocker = await pool.connect();
    const ownerBlocker = await pool.connect();
    let releaseAdvisory: Promise<void> | undefined;
    try {
      await advisoryBlocker.query("begin");
      await advisoryBlocker.query({
        text: "select pg_advisory_xact_lock(hashtext($1))",
        values: [
          `loop.spot.agent-authorization.issue-lock.v1:${input.ownerUserId}:${input.bindingVersion}`,
        ],
      });
      await ownerBlocker.query("begin");
      await ownerBlocker.query({
        text: `
          select id
          from public.loop_users
          where id = $1
          for update
        `,
        values: [input.ownerUserId],
      });

      const startedAt = Date.now();
      releaseAdvisory = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          advisoryBlocker.query("commit").then(() => resolve(), reject);
        }, 700);
      });
      const pending = repository.issueOrReplayCurrent(
        input,
        materializeForNonce,
        computeSigningDigest,
      );
      const settlement = pending.then(
        () => "settled" as const,
        () => "settled" as const,
      );
      await releaseAdvisory;
      const afterFirstLock = await Promise.race([
        settlement,
        new Promise<"waiting">((resolve) =>
          setTimeout(() => resolve("waiting"), 100),
        ),
      ]);
      expect(afterFirstLock).toBe("waiting");
      await expect(pending).rejects.toBeInstanceOf(
        SpotAgentAuthorizationRepositoryUnavailableError,
      );
      const elapsedMilliseconds = Date.now() - startedAt;
      expect(elapsedMilliseconds).toBeGreaterThanOrEqual(750);
      expect(elapsedMilliseconds).toBeLessThan(1_550);
      await ownerBlocker.query("rollback");
    } catch (error) {
      await releaseAdvisory?.catch(() => undefined);
      await advisoryBlocker.query("rollback").catch(() => undefined);
      await ownerBlocker.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      advisoryBlocker.release();
      ownerBlocker.release();
    }
    await expect(pool.query("select 1")).resolves.toBeDefined();
    expectNoIssuedRows(await durableCounts(pool));
  });

  it("uses the DB clock to reject expired and over-five-minute signing handoffs with full rollback", async () => {
    const authority = await seedAuthority(pool, "signing-window");
    const expired = await issueInput(
      pool,
      authority,
      {},
      { signingExpiresOffsetMs: -1 },
    );
    await expect(
      repository.issueOrReplayCurrent(
        expired,
        materializeForNonce,
        computeSigningDigest,
      ),
    ).rejects.toBeInstanceOf(SpotAgentAuthorizationPrepareExpiredError);
    expectNoIssuedRows(await durableCounts(pool));

    const overlong = await issueInput(
      pool,
      authority,
      {},
      {
        signingExpiresOffsetMs:
          SPOT_AGENT_AUTHORIZATION_SIGNING_TTL_MILLISECONDS + 1_000,
      },
    );
    await expect(
      repository.issueOrReplayCurrent(
        overlong,
        materializeForNonce,
        computeSigningDigest,
      ),
    ).rejects.toBeInstanceOf(SpotAgentAuthorizationPrepareExpiredError);
    expectNoIssuedRows(await durableCounts(pool));

    const insideBoundary = await issueInput(
      pool,
      authority,
      {},
      {
        signingExpiresOffsetMs:
          SPOT_AGENT_AUTHORIZATION_SIGNING_TTL_MILLISECONDS - 1_000,
      },
    );
    await expect(
      repository.issueOrReplayCurrent(
        insideBoundary,
        materializeForNonce,
        computeSigningDigest,
      ),
    ).resolves.toMatchObject({ kind: "issued", created: true });
  });

  it("locks policy v1 to a DB-clock-bounded 24-hour Agent lifetime", async () => {
    const authority = await seedAuthority(pool, "agent-lifetime");
    const overCap = await issueInput(
      pool,
      authority,
      {},
      {
        agentValidUntilOffsetMs:
          SPOT_AGENT_AUTHORIZATION_MAX_AGENT_LIFETIME_MILLISECONDS + 2_000,
      },
    );
    await expect(
      repository.issueOrReplayCurrent(
        overCap,
        materializeForNonce,
        computeSigningDigest,
      ),
    ).rejects.toBeInstanceOf(SpotAgentAuthorizationPrepareExpiredError);
    expectNoIssuedRows(await durableCounts(pool));

    const multiYear = await issueInput(
      pool,
      authority,
      {},
      { agentValidUntilOffsetMs: 365 * 24 * 60 * 60 * 1_000 },
    );
    await expect(
      repository.issueOrReplayCurrent(
        multiYear,
        materializeForNonce,
        computeSigningDigest,
      ),
    ).rejects.toBeInstanceOf(SpotAgentAuthorizationPrepareExpiredError);
    expectNoIssuedRows(await durableCounts(pool));

    const unknownPolicy = {
      ...(await issueInput(pool, authority)),
      policyVersion: "spot_agent_v2",
    } as unknown as IssueSpotAgentAuthorizationInput;
    await expect(
      repository.issueOrReplayCurrent(
        unknownPolicy,
        materializeForNonce,
        computeSigningDigest,
      ),
    ).rejects.toBeInstanceOf(SpotAgentAuthorizationRepositoryUnavailableError);
    expectNoIssuedRows(await durableCounts(pool));

    const insideCap = await issueInput(
      pool,
      authority,
      {},
      {
        agentValidUntilOffsetMs:
          SPOT_AGENT_AUTHORIZATION_MAX_AGENT_LIFETIME_MILLISECONDS - 1_000,
      },
    );
    await expect(
      repository.issueOrReplayCurrent(
        insideCap,
        materializeForNonce,
        computeSigningDigest,
      ),
    ).resolves.toMatchObject({ kind: "issued", created: true });
  });

  it("rejects missing or tampered canonical agent expiry suffixes before materialization", async () => {
    const authority = await seedAuthority(pool, "agent-expiry-suffix");
    const valid = await issueInput(pool, authority);
    const validUntilMilliseconds = Date.parse(valid.agentValidUntil);
    const cases: readonly IssueSpotAgentAuthorizationInput[] = [
      { ...valid, authorizationId: randomUUID(), agentName: "Loop-agent" },
      {
        ...valid,
        authorizationId: randomUUID(),
        agentName: `Loop-agent valid_until ${validUntilMilliseconds + 1}`,
      },
      {
        ...valid,
        authorizationId: randomUUID(),
        agentName: `Loop-00000000000 valid_until ${validUntilMilliseconds}`,
      },
      {
        ...valid,
        authorizationId: randomUUID(),
        agentValidUntil: new Date(validUntilMilliseconds + 1_000).toISOString(),
      },
      {
        ...valid,
        authorizationId: randomUUID(),
        agentName: `${"a".repeat(17)} valid_until ${validUntilMilliseconds}`,
      },
    ];
    const materializer = vi.fn(materializeForNonce);
    for (const input of cases) {
      await expect(
        repository.issueOrReplayCurrent(
          input,
          materializer,
          computeSigningDigest,
        ),
      ).rejects.toBeInstanceOf(
        SpotAgentAuthorizationRepositoryUnavailableError,
      );
      expectNoIssuedRows(await durableCounts(pool));
    }
    expect(materializer).not.toHaveBeenCalled();
  });

  it("rolls back the nonce and every issued row for payload or independent digest mismatches", async () => {
    const authority = await seedAuthority(pool, "payload-binding");
    const cases: readonly MaterializeSpotAgentAuthorizationForNonce[] = [
      (context) => {
        const value = typedData(context);
        const message = value["message"] as Record<string, unknown>;
        const malformed = {
          ...value,
          message: {
            ...message,
            nonce: Number(context.authorizationNonce) + 1,
          },
        };
        return {
          typedData: malformed,
          signingDigest: digestTypedData(malformed),
        };
      },
      (context) => {
        const value = typedData(context);
        const message = value["message"] as Record<string, unknown>;
        const malformed = {
          ...value,
          message: { ...message, agentAddress: randomAddress() },
        };
        return {
          typedData: malformed,
          signingDigest: digestTypedData(malformed),
        };
      },
      (context) => {
        const value = typedData(context);
        const domain = value["domain"] as Record<string, unknown>;
        const malformed = {
          ...value,
          domain: { ...domain, chainId: 1 },
        };
        return {
          typedData: malformed,
          signingDigest: digestTypedData(malformed),
        };
      },
      (context) => ({
        typedData: typedData(context),
        signingDigest: `0x${"f".repeat(64)}`,
      }),
    ];

    for (const materializer of cases) {
      const input = await issueInput(pool, authority);
      await expect(
        repository.issueOrReplayCurrent(
          input,
          materializer,
          computeSigningDigest,
        ),
      ).rejects.toBeInstanceOf(
        SpotAgentAuthorizationRepositoryUnavailableError,
      );
      expectNoIssuedRows(await durableCounts(pool));
    }
  });

  it("fast-forwards monotonically and fails closed beyond the strict future nonce window", async () => {
    const authority = await seedAuthority(pool, "nonce-window");
    const seed = await pool.query<{ nonce: string }>({
      text: `
        with database_clock as (
          select floor(extract(epoch from clock_timestamp()) * 1000)::numeric
            as unix_milliseconds
        )
        insert into public.hyperliquid_signer_nonce_state (
          network,
          signer_address,
          signer_kind,
          last_allocated_nonce
        )
        select 'testnet', $1, 'owner_wallet', unix_milliseconds + 5000
        from database_clock
        returning last_allocated_nonce::text as nonce
      `,
      values: [authority.accountAddress],
    });
    const seededNonce = seed.rows[0]?.nonce;
    const issued = await repository.issueOrReplayCurrent(
      await issueInput(pool, authority),
      materializeForNonce,
      computeSigningDigest,
    );
    expect(BigInt(issued.authorization.authorizationNonce)).toBe(
      BigInt(seededNonce ?? "0") + 1n,
    );

    await pool.query(truncateAll);
    const blockedAuthority = await seedAuthority(pool, "nonce-blocked");
    const blockedSeed = await pool.query<{ nonce: string }>({
      text: `
        with database_clock as (
          select floor(extract(epoch from clock_timestamp()) * 1000)::numeric
            as unix_milliseconds
        )
        insert into public.hyperliquid_signer_nonce_state (
          network,
          signer_address,
          signer_kind,
          last_allocated_nonce
        )
        select 'testnet', $1, 'owner_wallet', unix_milliseconds + $2::numeric
        from database_clock
        returning last_allocated_nonce::text as nonce
      `,
      values: [
        blockedAuthority.accountAddress,
        HYPERLIQUID_SIGNER_NONCE_FUTURE_WINDOW_MILLISECONDS + 1_000,
      ],
    });
    await expect(
      repository.issueOrReplayCurrent(
        await issueInput(pool, blockedAuthority),
        materializeForNonce,
        computeSigningDigest,
      ),
    ).rejects.toBeInstanceOf(SpotAgentAuthorizationNonceUnavailableError);
    const state = await pool.query<{ nonce: string }>({
      text: `
        select last_allocated_nonce::text as nonce
        from public.hyperliquid_signer_nonce_state
        where network = 'testnet' and signer_address = $1
      `,
      values: [blockedAuthority.accountAddress],
    });
    expect(state.rows[0]?.nonce).toBe(blockedSeed.rows[0]?.nonce);
    expect(await durableCounts(pool)).toMatchObject({
      idempotency_count: "0",
      operation_count: "0",
      identity_count: "0",
      authorization_count: "0",
      authorization_event_count: "0",
      allocation_count: "0",
      audit_count: "0",
      nonce_state_count: "1",
    });
  });

  it("commits elapsed recovery before a new materializer failure and remains recoverable", async () => {
    const authority = await seedAuthority(pool, "elapsed-recovery");
    const firstInput = await issueInput(
      pool,
      authority,
      {},
      { signingExpiresOffsetMs: 250 },
    );
    const first = await repository.issueOrReplayCurrent(
      firstInput,
      materializeForNonce,
      computeSigningDigest,
    );
    expect(first.kind).toBe("issued");
    await pool.query("select pg_sleep(0.35)");

    const existingIdentity = {
      agentAddress: first.authorization.agentAddress,
      agentName: first.authorization.agentName,
      agentValidUntil: first.authorization.agentValidUntil,
      signerRef: first.authorization.signerRef,
    } as const;
    const failedReplacement = await issueInput(
      pool,
      authority,
      existingIdentity,
    );
    await expect(
      repository.issueOrReplayCurrent(
        failedReplacement,
        () => {
          throw new Error("injected materializer failure");
        },
        computeSigningDigest,
      ),
    ).rejects.toBeInstanceOf(SpotAgentAuthorizationRepositoryUnavailableError);

    const recovered = await pool.query<{
      authorization_reason: string | null;
      authorization_state: string;
      authorization_version: string;
      identity_state: string;
      identity_version: string;
      operation_state: string;
      operation_version: string;
    }>({
      text: `
        select
          agent_auth.state as authorization_state,
          agent_auth.result_reason_code as authorization_reason,
          agent_auth.record_version::text as authorization_version,
          identity.lifecycle_state as identity_state,
          identity.record_version::text as identity_version,
          operation.state as operation_state,
          operation.record_version::text as operation_version
        from public.spot_agent_authorizations as agent_auth
        join public.spot_agent_identities as identity
          on identity.id = agent_auth.agent_identity_id
        join public.provider_operations as operation
          on operation.id = agent_auth.id
        where agent_auth.id = $1
      `,
      values: [firstInput.authorizationId],
    });
    expect(recovered.rows[0]).toEqual({
      authorization_state: "expired",
      authorization_reason: "signing_expired",
      authorization_version: "1",
      identity_state: "reserved",
      identity_version: "2",
      operation_state: "prepared",
      operation_version: "0",
    });
    expect(await durableCounts(pool)).toEqual({
      idempotency_count: "1",
      operation_count: "1",
      identity_count: "1",
      identity_event_count: "3",
      authorization_count: "1",
      authorization_event_count: "2",
      nonce_state_count: "1",
      allocation_count: "1",
      audit_count: "1",
    });

    await expect(
      repository.issueOrReplayCurrent(
        await issueInput(pool, authority),
        materializeForNonce,
        computeSigningDigest,
      ),
    ).rejects.toBeInstanceOf(SpotAgentAuthorizationAuthorityStaleError);
    expect(await durableCounts(pool)).toMatchObject({
      idempotency_count: "1",
      operation_count: "1",
      identity_count: "1",
      authorization_count: "1",
      allocation_count: "1",
      nonce_state_count: "1",
    });

    await expect(
      repository.preflightCurrent(
        preflightInput(await issueInput(pool, authority)),
        materializeForNonce,
        computeSigningDigest,
      ),
    ).resolves.toMatchObject({
      kind: "issue_required",
      agentGeneration: "1",
      reservedIdentity: {
        agentIdentityId: first.authorization.agentIdentityId,
        agentGeneration: "1",
        ...existingIdentity,
      },
    });

    const replacement = await repository.issueOrReplayCurrent(
      await issueInput(pool, authority, existingIdentity),
      materializeForNonce,
      computeSigningDigest,
    );
    expect(replacement.kind).toBe("issued");
    expect(replacement.authorization.agentIdentityId).toBe(
      first.authorization.agentIdentityId,
    );
    expect(
      BigInt(replacement.authorization.authorizationNonce),
    ).toBeGreaterThan(BigInt(first.authorization.authorizationNonce));
    const identityEvents = await pool.query<{
      identity_version: string;
      to_state: string;
    }>({
      text: `
        select identity_version::text as identity_version, to_state
        from public.spot_agent_identity_events
        where agent_identity_id = $1
        order by identity_version
      `,
      values: [first.authorization.agentIdentityId],
    });
    expect(identityEvents.rows).toEqual([
      { identity_version: "0", to_state: "reserved" },
      { identity_version: "1", to_state: "authorization_pending" },
      { identity_version: "2", to_state: "reserved" },
      { identity_version: "3", to_state: "authorization_pending" },
    ]);
  });

  it("rolls back expiry-only cleanup when its admission deadline elapses before commit", async () => {
    const authority = await seedAuthority(pool, "expiry-cleanup-lease");
    const issuedInput = await issueInput(
      pool,
      authority,
      {},
      { signingExpiresOffsetMs: 200 },
    );
    await repository.issueOrReplayCurrent(
      issuedInput,
      materializeForNonce,
      computeSigningDigest,
    );
    await pool.query("select pg_sleep(0.25)");

    const shortLease = await issueInput(
      pool,
      authority,
      {},
      { verifiedOffsetMs: -100, authorityExpiresOffsetMs: 500 },
    );
    const blocker = await pool.connect();
    try {
      await blocker.query("begin");
      await blocker.query(
        "lock table public.spot_agent_authorization_events in access exclusive mode",
      );
      const cleanup = repository.preflightCurrent(
        preflightInput(shortLease),
        materializeForNonce,
        computeSigningDigest,
      );
      const cleanupExpectation = expect(cleanup).rejects.toBeInstanceOf(
        SpotAgentAuthorizationRepositoryUnavailableError,
      );
      await new Promise((resolve) => setTimeout(resolve, 650));
      await blocker.query("commit");
      await cleanupExpectation;
    } catch (error) {
      await blocker.query("rollback");
      throw error;
    } finally {
      blocker.release();
    }

    const state = await pool.query<{
      authorization_state: string;
      identity_state: string;
    }>({
      text: `
        select
          agent_auth.state as authorization_state,
          identity.lifecycle_state as identity_state
        from public.spot_agent_authorizations as agent_auth
        join public.spot_agent_identities as identity
          on identity.id = agent_auth.agent_identity_id
        where agent_auth.id = $1
      `,
      values: [issuedInput.authorizationId],
    });
    expect(state.rows[0]).toEqual({
      authorization_state: "prepared",
      identity_state: "authorization_pending",
    });
  });

  it.each(["rotate", "unbind"] as const)(
    "sweeps elapsed prepared authorization after wallet %s without another epoch POST",
    async (transition) => {
      const authority = await seedAuthority(pool, `sweep-${transition}`);
      const input = await issueInput(
        pool,
        authority,
        {},
        { signingExpiresOffsetMs: 200 },
      );
      const issued = await repository.issueOrReplayCurrent(
        input,
        materializeForNonce,
        computeSigningDigest,
      );
      if (transition === "rotate") {
        await pool.query({
          text: `
            update public.perp_wallet_bindings
            set
              wallet_id = $2,
              account_address = $3,
              binding_version = 2,
              last_verified_at = clock_timestamp(),
              updated_at = clock_timestamp()
            where owner_user_id = $1
          `,
          values: [
            authority.ownerUserId,
            `wallet-${randomUUID()}`,
            randomAddress(),
          ],
        });
      } else {
        await pool.query({
          text: `
            update public.perp_wallet_bindings
            set
              binding_state = 'unbound',
              wallet_id = null,
              account_address = null,
              account_kind = null,
              binding_version = 2,
              last_verified_at = null,
              updated_at = clock_timestamp()
            where owner_user_id = $1
          `,
          values: [authority.ownerUserId],
        });
      }
      await pool.query("select pg_sleep(0.25)");

      const sweeps = await Promise.all([
        repository.expireElapsedPrepared({
          requestId: randomUUID(),
          limit: 10,
        }),
        repository.expireElapsedPrepared({
          requestId: randomUUID(),
          limit: 10,
        }),
      ]);
      expect(
        sweeps.reduce((total, result) => total + result.expiredCount, 0),
      ).toBe(1);
      await expect(
        repository.expireElapsedPrepared({
          requestId: randomUUID(),
          limit: 10,
        }),
      ).resolves.toEqual({ expiredCount: 0 });

      const state = await pool.query<{
        actor_type: string;
        authorization_state: string;
        identity_state: string;
        operation_state: string;
        operation_version: string;
      }>({
        text: `
          select
            agent_auth.state as authorization_state,
            identity.lifecycle_state as identity_state,
            operation.state as operation_state,
            operation.record_version::text as operation_version,
            event.actor_type
          from public.spot_agent_authorizations as agent_auth
          join public.spot_agent_identities as identity
            on identity.id = agent_auth.agent_identity_id
          join public.provider_operations as operation
            on operation.id = agent_auth.id
          join public.spot_agent_authorization_events as event
            on event.authorization_id = agent_auth.id
           and event.authorization_version = 1
          where agent_auth.id = $1
        `,
        values: [issued.authorization.id],
      });
      expect(state.rows[0]).toEqual({
        authorization_state: "expired",
        identity_state: "retired",
        operation_state: "prepared",
        operation_version: "0",
        actor_type: "worker",
      });
      expect(await durableCounts(pool)).toEqual({
        idempotency_count: "1",
        operation_count: "1",
        identity_count: "1",
        identity_event_count: "3",
        authorization_count: "1",
        authorization_event_count: "2",
        nonce_state_count: "1",
        allocation_count: "1",
        audit_count: "1",
      });
    },
  );

  it("skips a lock-blocked expiry candidate, advances later candidates, and converges next sweep", async () => {
    const blockedAuthority = await seedAuthority(pool, "sweep-lock-blocked");
    const laterAuthority = await seedAuthority(pool, "sweep-lock-later");
    const blockedInput = await issueInput(
      pool,
      blockedAuthority,
      {},
      { signingExpiresOffsetMs: 150 },
    );
    const laterInput = await issueInput(
      pool,
      laterAuthority,
      {},
      { signingExpiresOffsetMs: 300 },
    );
    await repository.issueOrReplayCurrent(
      blockedInput,
      materializeForNonce,
      computeSigningDigest,
    );
    await repository.issueOrReplayCurrent(
      laterInput,
      materializeForNonce,
      computeSigningDigest,
    );
    await pool.query("select pg_sleep(0.4)");

    const blocker = await pool.connect();
    try {
      await blocker.query("begin");
      await blocker.query({
        text: `
          select id
          from public.loop_users
          where id = $1
          for update
        `,
        values: [blockedAuthority.ownerUserId],
      });
      await blocker.query({
        text: `
          update public.perp_wallet_bindings
          set
            wallet_id = $2,
            account_address = $3,
            binding_version = 2,
            last_verified_at = clock_timestamp(),
            updated_at = clock_timestamp()
          where owner_user_id = $1
        `,
        values: [
          blockedAuthority.ownerUserId,
          `wallet-${randomUUID()}`,
          randomAddress(),
        ],
      });

      await expect(
        repository.expireElapsedPrepared({
          requestId: randomUUID(),
          limit: 1,
        }),
      ).resolves.toEqual({ expiredCount: 0 });
      await expect(
        repository.expireElapsedPrepared({
          requestId: randomUUID(),
          limit: 1,
        }),
      ).resolves.toEqual({ expiredCount: 1 });

      const firstPass = await pool.query<{
        blocked_state: string;
        later_state: string;
      }>({
        text: `
          select
            (select state from public.spot_agent_authorizations where id = $1)
              as blocked_state,
            (select state from public.spot_agent_authorizations where id = $2)
              as later_state
        `,
        values: [blockedInput.authorizationId, laterInput.authorizationId],
      });
      expect(firstPass.rows[0]).toEqual({
        blocked_state: "prepared",
        later_state: "expired",
      });

      await blocker.query("commit");
    } catch (error) {
      await blocker.query("rollback");
      throw error;
    } finally {
      blocker.release();
    }

    await expect(
      repository.expireElapsedPrepared({
        requestId: randomUUID(),
        limit: 1,
      }),
    ).resolves.toEqual({ expiredCount: 0 });
    await expect(
      repository.expireElapsedPrepared({
        requestId: randomUUID(),
        limit: 1,
      }),
    ).resolves.toEqual({ expiredCount: 1 });
    await expect(
      repository.expireElapsedPrepared({
        requestId: randomUUID(),
        limit: 1,
      }),
    ).resolves.toEqual({ expiredCount: 0 });

    const converged = await pool.query<{
      authorization_state: string;
      identity_state: string;
    }>({
      text: `
        select
          agent_auth.state as authorization_state,
          identity.lifecycle_state as identity_state
        from public.spot_agent_authorizations as agent_auth
        join public.spot_agent_identities as identity
          on identity.id = agent_auth.agent_identity_id
        where agent_auth.id = $1
      `,
      values: [blockedInput.authorizationId],
    });
    expect(converged.rows[0]).toEqual({
      authorization_state: "expired",
      identity_state: "retired",
    });
  });

  it("materializes an operator-held prepared expiry so a bounded sweep advances", async () => {
    const heldAuthority = await seedAuthority(pool, "held-expiry-first");
    const laterAuthority = await seedAuthority(pool, "held-expiry-later");
    const heldInput = await issueInput(
      pool,
      heldAuthority,
      {},
      {
        signingExpiresOffsetMs: 150,
        agentValidUntilOffsetMs: 1_200,
      },
    );
    const laterInput = await issueInput(
      pool,
      laterAuthority,
      {},
      { signingExpiresOffsetMs: 250 },
    );
    await repository.issueOrReplayCurrent(
      heldInput,
      materializeForNonce,
      computeSigningDigest,
    );
    await repository.issueOrReplayCurrent(
      laterInput,
      materializeForNonce,
      computeSigningDigest,
    );
    await transitionPreparedIdentity(
      pool,
      heldInput.agentIdentityId,
      "operator_hold",
    );
    await pool.query("select pg_sleep(0.35)");

    await expect(
      repository.expireElapsedPrepared({
        requestId: randomUUID(),
        limit: 1,
      }),
    ).resolves.toEqual({ expiredCount: 1 });
    const firstPass = await pool.query<{
      held_authorization_state: string;
      held_identity_state: string;
      later_authorization_state: string;
    }>({
      text: `
        select
          (select state from public.spot_agent_authorizations where id = $1)
            as held_authorization_state,
          (select lifecycle_state from public.spot_agent_identities where id = $2)
            as held_identity_state,
          (select state from public.spot_agent_authorizations where id = $3)
            as later_authorization_state
      `,
      values: [
        heldInput.authorizationId,
        heldInput.agentIdentityId,
        laterInput.authorizationId,
      ],
    });
    expect(firstPass.rows[0]).toEqual({
      held_authorization_state: "expired",
      held_identity_state: "operator_hold",
      later_authorization_state: "prepared",
    });

    await expect(
      repository.expireElapsedPrepared({
        requestId: randomUUID(),
        limit: 1,
      }),
    ).resolves.toEqual({ expiredCount: 1 });
    await expect(
      repository.expireElapsedPrepared({
        requestId: randomUUID(),
        limit: 1,
      }),
    ).resolves.toEqual({ expiredCount: 0 });
    const laterState = await pool.query<{
      authorization_state: string;
      identity_state: string;
    }>({
      text: `
        select
          agent_auth.state as authorization_state,
          identity.lifecycle_state as identity_state
        from public.spot_agent_authorizations as agent_auth
        join public.spot_agent_identities as identity
          on identity.id = agent_auth.agent_identity_id
        where agent_auth.id = $1
      `,
      values: [laterInput.authorizationId],
    });
    expect(laterState.rows[0]).toEqual({
      authorization_state: "expired",
      identity_state: "reserved",
    });
  });

  it("physically expires a prepared authorization after its identity is revoked", async () => {
    const authority = await seedAuthority(pool, "revoked-prepared-expiry");
    const input = await issueInput(
      pool,
      authority,
      {},
      { signingExpiresOffsetMs: 150 },
    );
    await repository.issueOrReplayCurrent(
      input,
      materializeForNonce,
      computeSigningDigest,
    );
    await transitionPreparedIdentity(pool, input.agentIdentityId, "revoked");
    await pool.query("select pg_sleep(0.2)");

    await expect(
      repository.expireElapsedPrepared({
        requestId: randomUUID(),
        limit: 1,
      }),
    ).resolves.toEqual({ expiredCount: 1 });
    const state = await pool.query<{
      authorization_state: string;
      identity_state: string;
    }>({
      text: `
        select
          agent_auth.state as authorization_state,
          identity.lifecycle_state as identity_state
        from public.spot_agent_authorizations as agent_auth
        join public.spot_agent_identities as identity
          on identity.id = agent_auth.agent_identity_id
        where agent_auth.id = $1
      `,
      values: [input.authorizationId],
    });
    expect(state.rows[0]).toEqual({
      authorization_state: "expired",
      identity_state: "revoked",
    });
    await expect(
      repository.expireElapsedPrepared({
        requestId: randomUUID(),
        limit: 1,
      }),
    ).resolves.toEqual({ expiredCount: 0 });
  });

  it("atomically expires a prepared handoff when its held Agent validity elapses", async () => {
    const authority = await seedAuthority(pool, "held-validity-elapsed");
    const input = await issueInput(
      pool,
      authority,
      {},
      {
        signingExpiresOffsetMs: 300,
        agentValidUntilOffsetMs: 600,
      },
    );
    await repository.issueOrReplayCurrent(
      input,
      materializeForNonce,
      computeSigningDigest,
    );
    await transitionPreparedIdentity(
      pool,
      input.agentIdentityId,
      "operator_hold",
    );
    await pool.query("select pg_sleep(0.7)");

    await expect(
      repository.retireElapsedAgentIdentities({
        requestId: randomUUID(),
        limit: 100,
      }),
    ).resolves.toEqual({ retiredCount: 1 });
    const state = await pool.query<{
      authorization_reason: string | null;
      authorization_state: string;
      identity_reason: string | null;
      identity_state: string;
    }>({
      text: `
        select
          agent_auth.state as authorization_state,
          agent_auth.result_reason_code as authorization_reason,
          identity.lifecycle_state as identity_state,
          identity_event.reason_code as identity_reason
        from public.spot_agent_authorizations as agent_auth
        join public.spot_agent_identities as identity
          on identity.id = agent_auth.agent_identity_id
        join public.spot_agent_identity_events as identity_event
          on identity_event.agent_identity_id = identity.id
         and identity_event.event_type = 'agent_validity_elapsed'
        where agent_auth.id = $1
      `,
      values: [input.authorizationId],
    });
    expect(state.rows[0]).toEqual({
      authorization_state: "expired",
      authorization_reason: "signing_expired",
      identity_state: "retired",
      identity_reason: "agent_validity_elapsed",
    });
  });

  it("does not replay a one-time payload after the authorization starts submitting", async () => {
    const authority = await seedAuthority(pool, "submitting");
    const input = await issueInput(pool, authority);
    await repository.issueOrReplayCurrent(
      input,
      materializeForNonce,
      computeSigningDigest,
    );
    const attemptId = randomUUID();
    const transitionRequestId = randomUUID();
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
            attempt_committed_at = database_clock.observed_at,
            attempt_deadline_at = database_clock.observed_at + interval '5 seconds',
            record_version = 1,
            updated_at = database_clock.observed_at
          from database_clock
          where operation.id = $1
        `,
        values: [input.authorizationId, attemptId],
      });
      await client.query({
        text: `
          update public.spot_agent_authorizations
          set
            state = 'submitting',
            record_version = 1,
            updated_at = clock_timestamp()
          where id = $1
        `,
        values: [input.authorizationId],
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
            $1, $2, $3, 'api', 'authorization_submitting',
            'prepared', 'submitting', 'not_required', 'not_required',
            'attempt_committed', 1, 0, $4
          )
        `,
        values: [
          authority.ownerUserId,
          input.authorizationId,
          transitionRequestId,
          attemptId,
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
            $1, $2, $3, 'api', 'authorization_submitting',
            'prepared', 'submitting', 'attempt_committed', 1
          )
        `,
        values: [
          input.authorizationId,
          authority.ownerUserId,
          transitionRequestId,
        ],
      });
      await client.query("set constraints all immediate");
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    const replayMaterializer = vi.fn(materializeForNonce);
    await expect(
      repository.preflightCurrent(
        preflightInput(await issueInput(pool, authority)),
        replayMaterializer,
        computeSigningDigest,
      ),
    ).rejects.toBeInstanceOf(SpotAgentAuthorizationAuthorityStaleError);
    expect(replayMaterializer).not.toHaveBeenCalled();
    expect(await durableCounts(pool)).toMatchObject({
      operation_count: "1",
      authorization_count: "1",
      allocation_count: "1",
      audit_count: "2",
    });
  });

  it("advances elapsed active-Agent retirement past a lock-blocked candidate", async () => {
    const blockedAuthority = await seedAuthority(pool, "retire-lock-blocked");
    const laterAuthority = await seedAuthority(pool, "retire-lock-later");
    const blockedInput = await issueInput(
      pool,
      blockedAuthority,
      {},
      {
        signingExpiresOffsetMs: 500,
        agentValidUntilOffsetMs: 800,
      },
    );
    const laterInput = await issueInput(
      pool,
      laterAuthority,
      {},
      {
        signingExpiresOffsetMs: 600,
        agentValidUntilOffsetMs: 1_000,
      },
    );
    await repository.issueOrReplayCurrent(
      blockedInput,
      materializeForNonce,
      computeSigningDigest,
    );
    await repository.issueOrReplayCurrent(
      laterInput,
      materializeForNonce,
      computeSigningDigest,
    );
    await activateAuthorization(pool, blockedInput);
    await activateAuthorization(pool, laterInput);
    await pool.query("select pg_sleep(1.1)");

    const blocker = await pool.connect();
    try {
      await blocker.query("begin");
      await blocker.query({
        text: `
          select id
          from public.loop_users
          where id = $1
          for update
        `,
        values: [blockedAuthority.ownerUserId],
      });

      await expect(
        repository.retireElapsedAgentIdentities({
          requestId: randomUUID(),
          limit: 1,
        }),
      ).resolves.toEqual({ retiredCount: 0 });
      await expect(
        repository.retireElapsedAgentIdentities({
          requestId: randomUUID(),
          limit: 1,
        }),
      ).resolves.toEqual({ retiredCount: 1 });
      await blocker.query("commit");
    } catch (error) {
      await blocker.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      blocker.release();
    }

    await expect(
      repository.retireElapsedAgentIdentities({
        requestId: randomUUID(),
        limit: 1,
      }),
    ).resolves.toEqual({ retiredCount: 0 });
    await expect(
      repository.retireElapsedAgentIdentities({
        requestId: randomUUID(),
        limit: 1,
      }),
    ).resolves.toEqual({ retiredCount: 1 });
    await expect(
      repository.retireElapsedAgentIdentities({
        requestId: randomUUID(),
        limit: 1,
      }),
    ).resolves.toEqual({ retiredCount: 0 });
    const states = await pool.query<{
      authorization_state: string;
      identity_state: string;
    }>({
      text: `
        select
          agent_auth.state as authorization_state,
          identity.lifecycle_state as identity_state
        from public.spot_agent_authorizations as agent_auth
        join public.spot_agent_identities as identity
          on identity.id = agent_auth.agent_identity_id
        where agent_auth.id = any($1::uuid[])
        order by agent_auth.id
      `,
      values: [[blockedInput.authorizationId, laterInput.authorizationId]],
    });
    expect(states.rows).toEqual([
      { authorization_state: "active", identity_state: "retired" },
      { authorization_state: "active", identity_state: "retired" },
    ]);
  });

  it("retires an elapsed active Agent and admits exactly one next generation", async () => {
    const authority = await seedAuthority(pool, "generation-renewal");
    const generationOneInput = await issueInput(
      pool,
      authority,
      {},
      { signingExpiresOffsetMs: 300, agentValidUntilOffsetMs: 700 },
    );
    const generationOne = await repository.issueOrReplayCurrent(
      generationOneInput,
      materializeForNonce,
      computeSigningDigest,
    );
    expect(generationOne.authorization.agentGeneration).toBe("1");
    await activateAuthorization(pool, generationOneInput);
    await pool.query("select pg_sleep(0.8)");

    await expect(
      repository.retireElapsedAgentIdentities({
        requestId: randomUUID(),
        limit: 100,
      }),
    ).resolves.toEqual({ retiredCount: 1 });
    const retired = await pool.query<{
      authorization_state: string;
      event_reason: string | null;
      from_state: string | null;
      identity_state: string;
      to_state: string;
    }>({
      text: `
        select
          identity.lifecycle_state as identity_state,
          agent_auth.state as authorization_state,
          event.from_state,
          event.to_state,
          event.reason_code as event_reason
        from public.spot_agent_identities as identity
        join public.spot_agent_authorizations as agent_auth
          on agent_auth.agent_identity_id = identity.id
        join public.spot_agent_identity_events as event
          on event.agent_identity_id = identity.id
         and event.event_type = 'agent_validity_elapsed'
        where identity.id = $1
      `,
      values: [generationOneInput.agentIdentityId],
    });
    expect(retired.rows[0]).toEqual({
      identity_state: "retired",
      authorization_state: "active",
      from_state: "active",
      to_state: "retired",
      event_reason: "agent_validity_elapsed",
    });
    expect(
      (
        await repository.findOwned(
          authority.ownerUserId,
          generationOneInput.authorizationId,
        )
      )?.resource.state,
    ).toBe("active");

    const preflight = await repository.preflightCurrent(
      preflightInput(await issueInput(pool, authority)),
      materializeForNonce,
      computeSigningDigest,
    );
    expect(preflight).toEqual({
      kind: "issue_required",
      created: false,
      agentGeneration: "2",
      reservedIdentity: null,
      authorization: null,
      signablePayload: null,
    });

    const generationTwoInput = await issueInput(pool, authority, {
      agentGeneration: "2",
    });
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () =>
        repository.issueOrReplayCurrent(
          generationTwoInput,
          materializeForNonce,
          computeSigningDigest,
        ),
      ),
    );
    expect(concurrent.filter(({ kind }) => kind === "issued")).toHaveLength(1);
    expect(
      concurrent.every(
        ({ authorization }) => authorization.agentGeneration === "2",
      ),
    ).toBe(true);
    expect(
      new Set(
        concurrent.map(({ authorization }) => authorization.agentIdentityId),
      ),
    ).toEqual(new Set([generationTwoInput.agentIdentityId]));
    expect(await durableCounts(pool)).toMatchObject({
      identity_count: "2",
      authorization_count: "2",
      nonce_state_count: "1",
      allocation_count: "2",
    });
  });

  it("performs the same elapsed-Agent retirement opportunistically during preflight", async () => {
    const authority = await seedAuthority(pool, "generation-preflight");
    const input = await issueInput(
      pool,
      authority,
      {},
      { signingExpiresOffsetMs: 250, agentValidUntilOffsetMs: 600 },
    );
    await repository.issueOrReplayCurrent(
      input,
      materializeForNonce,
      computeSigningDigest,
    );
    await activateAuthorization(pool, input);
    await pool.query("select pg_sleep(0.7)");

    await expect(
      repository.preflightCurrent(
        preflightInput(await issueInput(pool, authority)),
        materializeForNonce,
        computeSigningDigest,
      ),
    ).resolves.toMatchObject({
      kind: "issue_required",
      agentGeneration: "2",
    });
    const identity = await pool.query<{
      agent_generation: string;
      lifecycle_state: string;
    }>({
      text: `
        select
          agent_generation::text as agent_generation,
          lifecycle_state
        from public.spot_agent_identities
        where id = $1
      `,
      values: [input.agentIdentityId],
    });
    expect(identity.rows[0]).toEqual({
      agent_generation: "1",
      lifecycle_state: "retired",
    });
  });

  it("keeps status reads owner-isolated and omits signer and nonce material", async () => {
    const authority = await seedAuthority(pool, "owner-a");
    const foreign = await seedAuthority(pool, "owner-b");
    const input = await issueInput(pool, authority);
    const issued = await repository.issueOrReplayCurrent(
      input,
      materializeForNonce,
      computeSigningDigest,
    );

    const owned = await repository.findOwned(
      authority.ownerUserId,
      input.authorizationId,
    );
    await expect(
      repository.findOwned(foreign.ownerUserId, input.authorizationId),
    ).resolves.toBeNull();
    expect(owned?.resource).toEqual(issued.authorization.resource);
    expect(owned?.recordVersion).toBe("0");
    expect(owned?.resource).not.toHaveProperty("signable_payload");
    expect(owned?.resource).not.toHaveProperty("authorization_nonce");
    expect(owned?.resource).not.toHaveProperty("agent_address");
    expect(owned?.resource).not.toHaveProperty("wallet_id");
    expect(owned?.resource).not.toHaveProperty("privy_user_id");
  });
});
