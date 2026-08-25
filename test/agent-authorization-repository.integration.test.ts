import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  AGENT_AUTHORIZATION_REQUEST_DIGEST_VERSION,
  AgentAuthorizationPrepareExpiredError,
  AgentAuthorizationRepositoryUnavailableError,
  createPostgresAgentAuthorizationRepository,
  type AgentAuthorizationRepository,
  type PersistIssuedAgentAuthorizationInput,
} from "../src/database/agent-authorization-repository.js";
import {
  AgentAuthorizationMutationDisabledError,
  AgentAuthorizationUnavailableError,
  createAgentAuthorizationService,
} from "../src/features/perp/agent-authorization-service.js";

const { Pool } = pg;
const databaseUrl = process.env["DATABASE_URL"];

if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error("DATABASE_URL is required for the integration test suite");
}

const accountAddress = "0x1111111111111111111111111111111111111111";
const signerWalletAddress = "0x2222222222222222222222222222222222222222";
const agentAddress = "0x3333333333333333333333333333333333333333";

const truncateAll = `
  truncate table
    public.price_alert_events,
    public.notification_preferences,
    public.notification_preference_versions,
    public.price_alert_definitions,
    public.watchlist_items,
    public.watchlist_groups,
    public.watchlist_versions,
    public.privacy_preferences,
    public.user_profiles,
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
    public.loop_users
`;

function futureTimes(offsetMilliseconds = 60_000): {
  readonly signingExpiresAt: string;
  readonly agentValidUntil: string;
} {
  return {
    signingExpiresAt: new Date(Date.now() + offsetMilliseconds).toISOString(),
    agentValidUntil: new Date(
      Date.now() + Math.max(offsetMilliseconds + 60_000, 120_000),
    ).toISOString(),
  };
}

function persistInput(
  ownerUserId: string,
  overrides: Partial<PersistIssuedAgentAuthorizationInput> = {},
): PersistIssuedAgentAuthorizationInput {
  const { signingExpiresAt, agentValidUntil } = futureTimes();
  const authorizationId = randomUUID();
  const agentIdentityId = randomUUID();
  return {
    authorizationId,
    agentIdentityId,
    ownerUserId,
    requestId: randomUUID(),
    accountAddress,
    accountKind: "master",
    bindingVersion: "1",
    signerWalletAddress,
    agentAddress,
    agentName: "loop-test-agent",
    agentValidUntil,
    publicReview: {
      version: "perp_agent_authorization_review_v1",
      provider: "hyperliquid",
      network: "testnet",
      action: "approve_agent",
      account: { address: accountAddress, kind: "master" },
      signer_wallet_address: signerWalletAddress,
      agent: {
        address: agentAddress,
        name: "loop-test-agent",
        valid_until: agentValidUntil,
      },
    },
    // Storage conformance fixture only; this is not a Hyperliquid field claim.
    typedDataPrimaryType: "TestOnlyOpaquePrimaryType",
    signingDigest: `0x${"a".repeat(64)}`,
    typedDataJsonSha256: "b".repeat(64),
    signingExpiresAt,
    ...overrides,
  };
}

async function createOwner(
  pool: InstanceType<typeof Pool>,
  label: string,
): Promise<string> {
  const result = await pool.query<{ id: string }>({
    text: `
      insert into public.loop_users (privy_user_id)
      values ($1)
      returning id
    `,
    values: [`did:privy:agent-authorization-${label}-${randomUUID()}`],
  });
  const id = result.rows[0]?.id;
  if (id === undefined) {
    throw new Error("Agent authorization owner setup failed");
  }
  return id;
}

describe("PostgreSQL Agent authorization repository", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  let repository: AgentAuthorizationRepository;

  beforeAll(() => {
    repository = createPostgresAgentAuthorizationRepository(pool);
  });

  beforeEach(async () => {
    await pool.query(truncateAll);
  });

  afterAll(async () => {
    await pool.query(truncateAll);
    await pool.end();
  });

  it("keeps default-denied and unavailable issuance at zero durable rows", async () => {
    const principal = {
      userId: "10000000-0000-4000-8000-000000000001",
      privyUserId: "did:privy:agent-authorization-gate",
      streamUserId: "loop_10000000000040008000000000000001",
    };
    const denied = createAgentAuthorizationService({ repository });
    const allowed = createAgentAuthorizationService({
      repository,
      mutationGate: { assertAllowed: () => Promise.resolve() },
    });

    await expect(
      denied.issue({
        principal,
        requestId: randomUUID(),
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(AgentAuthorizationMutationDisabledError);
    await expect(
      allowed.issue({
        principal,
        requestId: randomUUID(),
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(AgentAuthorizationUnavailableError);

    const counts = await pool.query<{ total: string }>({
      text: `
        select (
          (select count(*) from public.idempotency_records)
          + (select count(*) from public.provider_operations)
          + (select count(*) from public.perp_agent_identities)
          + (select count(*) from public.perp_agent_authorizations)
          + (select count(*) from public.perp_agent_authorization_events)
          + (select count(*) from public.audit_events)
        )::text as total
      `,
    });
    expect(counts.rows[0]?.total).toBe("0");
  });

  it("atomically persists one explicitly issued binding under concurrency", async () => {
    const ownerUserId = await createOwner(pool, "concurrent");
    const input = persistInput(ownerUserId);

    const results = await Promise.all(
      Array.from({ length: 16 }, async () => repository.persistIssued(input)),
    );
    const counts = await pool.query<{
      audit_count: string;
      authorization_count: string;
      authorization_digest_version: string;
      domain_event_count: string;
      idempotency_digest_version: string;
      idempotency_count: string;
      identity_count: string;
      operation_count: string;
    }>({
      text: `
        select
          (select count(*)::text from public.idempotency_records)
            as idempotency_count,
          (select count(*)::text from public.provider_operations)
            as operation_count,
          (select count(*)::text from public.perp_agent_identities)
            as identity_count,
          (select count(*)::text from public.perp_agent_authorizations)
            as authorization_count,
          (select request_digest_version
             from public.perp_agent_authorizations limit 1)
            as authorization_digest_version,
          (select count(*)::text from public.audit_events)
            as audit_count,
          (select count(*)::text from public.perp_agent_authorization_events)
            as domain_event_count,
          (select digest_version from public.idempotency_records limit 1)
            as idempotency_digest_version
      `,
    });

    expect(results.filter(({ created }) => created)).toHaveLength(1);
    expect(
      new Set(results.map(({ authorization }) => authorization.id)),
    ).toEqual(new Set([input.authorizationId]));
    expect(results[0]?.authorization).toMatchObject({
      id: input.authorizationId,
      ownerUserId,
      agentIdentityId: input.agentIdentityId,
      accountAddress,
      signerWalletAddress,
      agentAddress,
      state: "prepared",
      result: null,
    });
    expect(results[0]?.authorization.requestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(counts.rows[0]).toEqual({
      audit_count: "1",
      authorization_count: "1",
      authorization_digest_version: AGENT_AUTHORIZATION_REQUEST_DIGEST_VERSION,
      domain_event_count: "1",
      idempotency_digest_version: AGENT_AUTHORIZATION_REQUEST_DIGEST_VERSION,
      idempotency_count: "1",
      identity_count: "1",
      operation_count: "1",
    });
  });

  it("fails a changed immutable binding under the same authorization UUID closed", async () => {
    const ownerUserId = await createOwner(pool, "changed-replay");
    const input = persistInput(ownerUserId);
    await repository.persistIssued(input);
    const changed = {
      ...input,
      agentName: "loop-changed-agent",
      publicReview: {
        ...input.publicReview,
        agent: {
          ...input.publicReview.agent,
          name: "loop-changed-agent",
        },
      },
    } satisfies PersistIssuedAgentAuthorizationInput;

    await expect(repository.persistIssued(changed)).rejects.toBeInstanceOf(
      AgentAuthorizationRepositoryUnavailableError,
    );
    await expect(repository.persistIssued(input)).resolves.toMatchObject({
      created: false,
      authorization: { id: input.authorizationId },
    });

    const counts = await pool.query<{
      authorization_count: string;
      idempotency_count: string;
      identity_count: string;
      operation_count: string;
    }>({
      text: `
        select
          (select count(*)::text from public.idempotency_records)
            as idempotency_count,
          (select count(*)::text from public.provider_operations)
            as operation_count,
          (select count(*)::text from public.perp_agent_identities)
            as identity_count,
          (select count(*)::text from public.perp_agent_authorizations)
            as authorization_count
      `,
    });
    expect(counts.rows[0]).toEqual({
      authorization_count: "1",
      idempotency_count: "1",
      identity_count: "1",
      operation_count: "1",
    });
  });

  it("keeps owner reads indistinguishable from foreign and missing records", async () => {
    const ownerUserId = await createOwner(pool, "owner");
    const foreignOwnerUserId = await createOwner(pool, "foreign");
    const input = persistInput(ownerUserId);
    await repository.persistIssued(input);

    await expect(
      repository.findOwned(ownerUserId, input.authorizationId),
    ).resolves.toMatchObject({ id: input.authorizationId });
    await expect(
      repository.findOwned(foreignOwnerUserId, input.authorizationId),
    ).resolves.toBeNull();
    await expect(
      repository.findOwned(ownerUserId, randomUUID()),
    ).resolves.toBeNull();
  });

  it("uses the PostgreSQL clock for expiry and rolls back the entire issue", async () => {
    const ownerUserId = await createOwner(pool, "expired");
    const expiredAt = new Date(Date.now() - 1_000).toISOString();
    const validUntil = new Date(Date.now() + 60_000).toISOString();
    const base = persistInput(ownerUserId);
    const input = persistInput(ownerUserId, {
      authorizationId: base.authorizationId,
      agentIdentityId: base.agentIdentityId,
      signingExpiresAt: expiredAt,
      agentValidUntil: validUntil,
      publicReview: {
        ...base.publicReview,
        agent: { ...base.publicReview.agent, valid_until: validUntil },
      },
    });

    await expect(repository.persistIssued(input)).rejects.toBeInstanceOf(
      AgentAuthorizationPrepareExpiredError,
    );

    const counts = await pool.query<{ total: string }>({
      text: `
        select (
          (select count(*) from public.idempotency_records)
          + (select count(*) from public.provider_operations)
          + (select count(*) from public.perp_agent_identities)
          + (select count(*) from public.perp_agent_authorizations)
          + (select count(*) from public.perp_agent_authorization_events)
          + (select count(*) from public.audit_events)
        )::text as total
      `,
    });
    expect(counts.rows[0]?.total).toBe("0");
  });

  it("projects elapsed prepared issuance as expired from the database clock", async () => {
    const ownerUserId = await createOwner(pool, "projection");
    const base = persistInput(ownerUserId);
    const { signingExpiresAt, agentValidUntil } = futureTimes(1_000);
    const input = persistInput(ownerUserId, {
      authorizationId: base.authorizationId,
      agentIdentityId: base.agentIdentityId,
      signingExpiresAt,
      agentValidUntil,
      publicReview: {
        ...base.publicReview,
        agent: { ...base.publicReview.agent, valid_until: agentValidUntil },
      },
    });
    await repository.persistIssued(input);
    await pool.query("select pg_sleep(1.1)");

    await expect(
      repository.findOwned(ownerUserId, input.authorizationId),
    ).resolves.toMatchObject({ state: "expired" });
  });

  it("never reuses an Agent address across authorization identities", async () => {
    const ownerUserId = await createOwner(pool, "nonreuse");
    const first = persistInput(ownerUserId);
    await repository.persistIssued(first);
    const secondBase = persistInput(ownerUserId);
    const second = persistInput(ownerUserId, {
      authorizationId: secondBase.authorizationId,
      agentIdentityId: secondBase.agentIdentityId,
      agentAddress: first.agentAddress,
      publicReview: {
        ...secondBase.publicReview,
        agent: {
          ...secondBase.publicReview.agent,
          address: first.agentAddress,
        },
      },
      signingDigest: `0x${"c".repeat(64)}`,
      typedDataJsonSha256: "d".repeat(64),
    });

    await expect(repository.persistIssued(second)).rejects.toBeInstanceOf(
      AgentAuthorizationRepositoryUnavailableError,
    );

    const counts = await pool.query<{
      authorization_count: string;
      identity_count: string;
      operation_count: string;
    }>({
      text: `
        select
          (select count(*)::text from public.provider_operations)
            as operation_count,
          (select count(*)::text from public.perp_agent_identities)
            as identity_count,
          (select count(*)::text from public.perp_agent_authorizations)
            as authorization_count
      `,
    });
    expect(counts.rows[0]).toEqual({
      authorization_count: "1",
      identity_count: "1",
      operation_count: "1",
    });
  });

  it("rejects an Agent identity that is also the owner-wallet signer atomically", async () => {
    const ownerUserId = await createOwner(pool, "self-signer");
    const base = persistInput(ownerUserId);
    const input = persistInput(ownerUserId, {
      authorizationId: base.authorizationId,
      agentIdentityId: base.agentIdentityId,
      signerWalletAddress: agentAddress,
      publicReview: {
        ...base.publicReview,
        signer_wallet_address: agentAddress,
      },
    });

    await expect(repository.persistIssued(input)).rejects.toBeInstanceOf(
      AgentAuthorizationRepositoryUnavailableError,
    );

    const counts = await pool.query<{ total: string }>({
      text: `
        select (
          (select count(*) from public.idempotency_records)
          + (select count(*) from public.provider_operations)
          + (select count(*) from public.perp_agent_identities)
          + (select count(*) from public.perp_agent_authorizations)
          + (select count(*) from public.perp_agent_authorization_events)
          + (select count(*) from public.audit_events)
        )::text as total
      `,
    });
    expect(counts.rows[0]?.total).toBe("0");
  });

  it("enforces immutable issue facts, append-only events, and no secret-bearing columns", async () => {
    const ownerUserId = await createOwner(pool, "schema-guards");
    const input = persistInput(ownerUserId);
    await repository.persistIssued(input);

    await expect(
      pool.query({
        text: `
          update public.perp_agent_authorizations
          set public_review = '{}'::jsonb
          where id = $1
        `,
        values: [input.authorizationId],
      }),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query({
        text: `
          delete from public.perp_agent_authorization_events
          where authorization_id = $1
        `,
        values: [input.authorizationId],
      }),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query({
        text: `
          delete from public.perp_agent_identities
          where id = $1
        `,
        values: [input.agentIdentityId],
      }),
    ).rejects.toMatchObject({ code: "55000" });

    const columns = await pool.query<{ column_name: string }>({
      text: `
        select column_name
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'perp_agent_authorizations'
      `,
    });
    const names = columns.rows.map(({ column_name }) => column_name);
    expect(names).not.toContain("signature");
    expect(names).not.toContain("nonce");
    expect(names).not.toContain("typed_data_json");
    expect(names).not.toContain("provider_response");
    expect(names).not.toContain("private_key");
  });
});
