import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createPostgresDeviceSessionRepository } from "../src/database/device-session-repository.js";
import { clientVersionMaximumLength } from "../src/features/session/client-version.js";
import {
  DeviceSessionIdempotencyConflictError,
  DeviceSessionRateLimitedError,
  type BootstrapVerifiedPrivyUserInput,
  type CreateDeviceSessionInput,
  type DeviceSessionRepository,
  type RevokeDeviceSessionInput,
} from "../src/features/session/device-session-repository.js";
import type { PrivyAccessTokenVerifier } from "../src/integrations/privy/access-token-verifier.js";

const { Client, Pool } = pg;

function requireDatabaseUrl(): string {
  const value = process.env["DATABASE_URL"];
  if (value === undefined || value.trim() === "") {
    throw new Error("DATABASE_URL is required for the integration test suite");
  }
  return value;
}

const databaseUrl = requireDatabaseUrl();
const fixturePrivyPrefix = "did:privy:device-session-test:";
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

function digest(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

function databaseConnectionUrl(source: string, databaseName: string): string {
  const url = new URL(source);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function dropTemporaryDatabase(databaseName: string): Promise<void> {
  const admin = new Client({
    connectionString: databaseConnectionUrl(databaseUrl, "postgres"),
  });
  await admin.connect();
  try {
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
  } finally {
    await admin.end();
  }
}

describe("PostgreSQL V2 device-session migration and repository", () => {
  const databaseName = `loop_device_session_${randomUUID().replaceAll("-", "")}`;
  let pool: InstanceType<typeof Pool>;
  let repository: DeviceSessionRepository;
  let temporaryDatabaseUrl: string;

  beforeAll(async () => {
    const admin = new Client({
      connectionString: databaseConnectionUrl(databaseUrl, "postgres"),
    });
    await admin.connect();
    try {
      await admin.query(`create database "${databaseName}"`);
    } finally {
      await admin.end();
    }
    temporaryDatabaseUrl = databaseConnectionUrl(databaseUrl, databaseName);
    try {
      await runner({
        databaseUrl: temporaryDatabaseUrl,
        dir: migrationsDirectory,
        direction: "up",
        migrationsTable: "pgmigrations",
        log: () => undefined,
      });
    } catch (error) {
      await dropTemporaryDatabase(databaseName);
      throw error;
    }
    pool = new Pool({ connectionString: temporaryDatabaseUrl });
    repository = createPostgresDeviceSessionRepository(pool);
  });

  async function cleanFixtures(): Promise<void> {
    await pool.query(`
      truncate table
        public.device_session_events,
        public.device_session_commands,
        public.device_sessions
    `);
    await pool.query({
      text: `
        delete from public.loop_users
        where privy_user_id like $1
      `,
      values: [`${fixturePrivyPrefix}%`],
    });
  }

  afterEach(cleanFixtures);

  afterAll(async () => {
    await pool.end();
    await dropTemporaryDatabase(databaseName);
  });

  async function createOwner(label: string): Promise<string> {
    const result = await pool.query<{ id: string }>({
      text: `
        insert into public.loop_users (privy_user_id)
        values ($1)
        returning id
      `,
      values: [`${fixturePrivyPrefix}${label}:${randomUUID()}`],
    });
    const ownerUserId = result.rows[0]?.id;
    if (ownerUserId === undefined) {
      throw new Error("Device-session integration owner setup failed");
    }
    return ownerUserId;
  }

  function createInput(
    ownerUserId: string,
    label: string,
    overrides: Partial<CreateDeviceSessionInput> = {},
  ): CreateDeviceSessionInput {
    return {
      ownerUserId,
      idempotencyKey: randomUUID(),
      requestSha256: digest(`bootstrap:${label}`),
      requestId: randomUUID(),
      deviceId: randomUUID(),
      clientPlatform: "ios",
      clientVersion: "1.2.3",
      ...overrides,
    };
  }

  function verifiedBootstrapInput(
    privyUserId: string,
    label: string,
    overrides: Partial<BootstrapVerifiedPrivyUserInput> = {},
  ): BootstrapVerifiedPrivyUserInput {
    return {
      privyUserId,
      idempotencyKey: randomUUID(),
      requestSha256: digest(`bootstrap:${label}`),
      requestId: randomUUID(),
      deviceId: randomUUID(),
      clientPlatform: "ios",
      clientVersion: "1.2.3",
      ...overrides,
    };
  }

  function revokeInput(
    ownerUserId: string,
    sessionId: string,
    label: string,
    overrides: Partial<RevokeDeviceSessionInput> = {},
  ): RevokeDeviceSessionInput {
    return {
      ownerUserId,
      sessionId,
      idempotencyKey: randomUUID(),
      requestSha256: digest(`logout:${label}`),
      requestId: randomUUID(),
      ...overrides,
    };
  }

  async function seedSession(input: {
    readonly ownerUserId: string;
    readonly deviceId?: string;
    readonly status: "active" | "revoked";
    readonly hoursAgo: number;
  }): Promise<void> {
    await pool.query({
      text: `
        with observed as (
          select clock_timestamp() - ($6::int * interval '1 hour') as created_at
        )
        insert into public.device_sessions (
          owner_user_id,
          bootstrap_idempotency_key,
          bootstrap_request_sha256,
          device_id,
          client_platform,
          client_version,
          status,
          created_at,
          last_seen_at,
          revoked_at
        )
        select
          $1,
          $2,
          $3,
          $4,
          'ios',
          '1.2.3',
          $5,
          observed.created_at,
          observed.created_at,
          case when $5 = 'revoked' then clock_timestamp() else null end
        from observed
      `,
      values: [
        input.ownerUserId,
        randomUUID(),
        digest(`seed:${randomUUID()}`),
        input.deviceId ?? randomUUID(),
        input.status,
        input.hoursAgo,
      ],
    });
  }

  it("installs the complete schema, constraints, indexes, and mutation guards", async () => {
    const columns = await pool.query<{
      column_name: string;
      table_name: string;
    }>({
      text: `
        select table_name, column_name
        from information_schema.columns
        where table_schema = 'public'
          and table_name = any($1::text[])
        order by table_name, ordinal_position
      `,
      values: [
        ["device_sessions", "device_session_commands", "device_session_events"],
      ],
    });
    const columnsByTable = Object.groupBy(
      columns.rows,
      ({ table_name }) => table_name,
    );
    expect(
      columnsByTable["device_sessions"]?.map(({ column_name }) => column_name),
    ).toEqual([
      "session_id",
      "owner_user_id",
      "bootstrap_idempotency_key",
      "bootstrap_digest_version",
      "bootstrap_request_sha256",
      "device_id",
      "client_platform",
      "client_version",
      "contract_version",
      "auth_strength",
      "policy_version",
      "status",
      "created_at",
      "last_seen_at",
      "revoked_at",
    ]);
    expect(
      columnsByTable["device_session_commands"]?.map(
        ({ column_name }) => column_name,
      ),
    ).toEqual([
      "command_id",
      "owner_user_id",
      "requested_session_id",
      "resolved_session_id",
      "command_kind",
      "idempotency_key",
      "request_digest_version",
      "request_sha256",
      "request_id",
      "result_status",
      "result_revoked_at",
      "created_at",
      "last_seen_at",
    ]);
    expect(
      columnsByTable["device_session_events"]?.map(
        ({ column_name }) => column_name,
      ),
    ).toEqual([
      "event_id",
      "owner_user_id",
      "session_id",
      "event_version",
      "event_type",
      "request_id",
      "occurred_at",
    ]);

    const constraints = await pool.query<{ constraint_name: string }>({
      text: `
        select conname as constraint_name
        from pg_constraint
        where conrelid = any($1::regclass[])
        order by conname
      `,
      values: [
        [
          "public.device_sessions",
          "public.device_session_commands",
          "public.device_session_events",
        ],
      ],
    });
    expect(
      constraints.rows.map(({ constraint_name }) => constraint_name),
    ).toEqual(
      expect.arrayContaining([
        "device_sessions_request_sha256_check",
        "device_sessions_bootstrap_digest_version_check",
        "device_sessions_client_platform_check",
        "device_sessions_client_version_check",
        "device_sessions_revocation_state_check",
        "device_sessions_time_order_check",
        "device_session_commands_kind_key_unique",
        "device_session_commands_digest_version_check",
        "device_session_commands_request_sha256_check",
        "device_session_commands_result_check",
        "device_session_events_session_owner_fk",
        "device_session_events_version_unique",
        "device_session_events_type_version_check",
      ]),
    );

    const indexes = await pool.query<{ indexname: string }>({
      text: `
        select indexname
        from pg_indexes
        where schemaname = 'public'
          and tablename = any($1::text[])
        order by indexname
      `,
      values: [["device_sessions", "device_session_commands"]],
    });
    expect(indexes.rows.map(({ indexname }) => indexname)).toEqual(
      expect.arrayContaining([
        "device_sessions_owner_status_created_idx",
        "device_sessions_owner_device_idx",
        "device_session_commands_owner_created_idx",
        "device_session_commands_resolved_owner_idx",
      ]),
    );

    const triggers = await pool.query<{ trigger_name: string }>({
      text: `
        select tgname as trigger_name
        from pg_trigger
        where tgrelid = any($1::regclass[])
          and not tgisinternal
        order by tgname
      `,
      values: [
        [
          "public.device_sessions",
          "public.device_session_commands",
          "public.device_session_events",
        ],
      ],
    });
    expect(triggers.rows.map(({ trigger_name }) => trigger_name)).toEqual([
      "device_session_commands_guard_mutation",
      "device_session_events_immutable",
      "device_sessions_guard_mutation",
    ]);
  });

  it.each([
    "0.0.0",
    "1.2.3-beta.1+42",
    "1.2.3-0A",
    "1.2.3+001",
    `1.2.3+${"a".repeat(clientVersionMaximumLength - 6)}`,
  ])(
    "accepts strict SemVer 2.0 client version %s through Zod and PostgreSQL",
    async (clientVersion) => {
      const ownerUserId = await createOwner("valid-semver");

      await expect(
        repository.create(
          createInput(ownerUserId, `valid-semver:${clientVersion}`, {
            clientVersion,
          }),
        ),
      ).resolves.toMatchObject({ clientVersion });
    },
  );

  it.each([
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2.3-01",
    "1.2.3-.",
    "1.2.3+.",
    "1.2.3-alpha..1",
    "1.2.3+build..1",
    "1.2.3-beta+build+extra",
    "1.2.3\n",
    `1.2.3+${"a".repeat(clientVersionMaximumLength - 5)}`,
  ])(
    "rejects non-SemVer client version %j in Zod and PostgreSQL",
    async (clientVersion) => {
      const ownerUserId = await createOwner("invalid-semver");
      const input = createInput(
        ownerUserId,
        `invalid-semver:${clientVersion}`,
        { clientVersion },
      );

      await expect(repository.create(input)).rejects.toMatchObject({
        name: "ZodError",
      });
      await expect(
        pool.query({
          text: `
            insert into public.device_sessions (
              owner_user_id,
              bootstrap_idempotency_key,
              bootstrap_request_sha256,
              device_id,
              client_platform,
              client_version
            ) values ($1, $2, $3, $4, 'ios', $5)
          `,
          values: [
            ownerUserId,
            randomUUID(),
            digest(`invalid-semver:postgres:${clientVersion}`),
            randomUUID(),
            clientVersion,
          ],
        }),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "device_sessions_client_version_check",
      });
    },
  );

  it("creates one active session and replays the original bootstrap result", async () => {
    const ownerUserId = await createOwner("create-replay");
    const input = createInput(ownerUserId, "create-replay");

    const created = await repository.create(input);
    const replayed = await repository.create({
      ...input,
      requestId: randomUUID(),
    });

    expect(replayed).toEqual(created);
    expect(created).toMatchObject({
      ownerUserId,
      deviceId: input.deviceId,
      clientPlatform: "ios",
      clientVersion: "1.2.3",
      authStrength: "providerAuthenticated",
      policyVersion: "sessionPolicyV1",
      status: "active",
      revokedAt: null,
    });
    expect(created.createdAt).toBe(created.lastSeenAt);
    await expect(
      repository.findById(ownerUserId, created.sessionId),
    ).resolves.toEqual(created);

    const durable = await pool.query<{
      bootstrap_digest_version: string;
      contract_version: string;
      event_count: string;
      session_count: string;
    }>({
      text: `
        select
          (select count(*)::text from public.device_sessions
            where owner_user_id = $1) as session_count,
          (select count(*)::text from public.device_session_events
            where owner_user_id = $1 and event_type = 'session_created')
            as event_count,
          (select bootstrap_digest_version from public.device_sessions
            where owner_user_id = $1) as bootstrap_digest_version,
          (select contract_version from public.device_sessions
            where owner_user_id = $1) as contract_version
      `,
      values: [ownerUserId],
    });
    expect(durable.rows[0]).toEqual({
      bootstrap_digest_version: "device_session_bootstrap_v1",
      contract_version: "2.0",
      event_count: "1",
      session_count: "1",
    });
  });

  it("rejects bootstrap key reuse by another owner or changed content", async () => {
    const ownerA = await createOwner("bootstrap-conflict-a");
    const ownerB = await createOwner("bootstrap-conflict-b");
    const original = createInput(ownerA, "bootstrap-conflict");
    await repository.create(original);

    await expect(
      repository.create({
        ...original,
        ownerUserId: ownerB,
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(DeviceSessionIdempotencyConflictError);
    await expect(
      repository.create({
        ...original,
        requestSha256: digest("bootstrap:changed-content"),
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(DeviceSessionIdempotencyConflictError);

    const count = await pool.query<{ count: string }>({
      text: `
        select count(*)::text as count
        from public.device_sessions
        where bootstrap_idempotency_key = $1
      `,
      values: [original.idempotencyKey],
    });
    expect(count.rows[0]?.count).toBe("1");
  });

  it("does not leave a LOOP account when another Privy subject conflicts on a used bootstrap key", async () => {
    const suffix = randomUUID();
    const privyUserA = `${fixturePrivyPrefix}atomic-a:${suffix}`;
    const privyUserB = `${fixturePrivyPrefix}atomic-b:${suffix}`;
    const tokenA = "atomic-a.payload.signature";
    const tokenB = "atomic-b.payload.signature";
    const verifier = {
      verifyAccessToken(token: string) {
        if (token === tokenA) {
          return Promise.resolve({ privyUserId: privyUserA });
        }
        if (token === tokenB) {
          return Promise.resolve({ privyUserId: privyUserB });
        }
        throw new Error("Unexpected integration bearer");
      },
    } satisfies PrivyAccessTokenVerifier;
    const app = await buildApp({
      config: loadConfig({
        NODE_ENV: "test",
        API_DOCS_ENABLED: "false",
        LOG_LEVEL: "silent",
        V2_SESSION_ENABLED: "true",
        PRIVY_APP_ID: "app_device_session_integration",
        PRIVY_APP_SECRET: "secret_device_session_integration",
        DATABASE_URL: temporaryDatabaseUrl,
      }),
      contractSurface: "v2",
      privyAccessTokenVerifier: verifier,
      logger: false,
    });
    const idempotencyKey = randomUUID();
    const deviceId = randomUUID();
    const writeHeaders = (token: string) => ({
      authorization: `Bearer ${token}`,
      "idempotency-key": idempotencyKey,
      "x-loop-client-version": "1.2.3",
      "x-loop-contract-version": "2.0",
      "x-loop-device-id": deviceId,
      "x-loop-platform": "ios",
    });

    try {
      const first = await app.inject({
        method: "POST",
        url: "/v2/session/bootstrap",
        headers: writeHeaders(tokenA),
      });
      const conflict = await app.inject({
        method: "POST",
        url: "/v2/session/bootstrap",
        headers: writeHeaders(tokenB),
      });
      const account = await app.inject({
        method: "GET",
        url: "/v2/account/me",
        headers: {
          authorization: `Bearer ${tokenB}`,
          "x-loop-client-version": "1.2.3",
          "x-loop-contract-version": "2.0",
        },
      });

      expect(first.statusCode).toBe(200);
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      expect(account.statusCode).toBe(409);
      expect(account.json()).toMatchObject({
        code: "ACCOUNT_BOOTSTRAP_REQUIRED",
      });
      const persistedB = await pool.query<{ count: string }>({
        text: `
          select count(*)::text as count
          from public.loop_users
          where privy_user_id = $1
        `,
        values: [privyUserB],
      });
      expect(persistedB.rows[0]?.count).toBe("0");
    } finally {
      await app.close();
    }
  });

  it("rolls back a newly mapped account when session creation audit fails", async () => {
    const privyUserId = `${fixturePrivyPrefix}event-failure:${randomUUID()}`;
    await pool.query(`
      create function public.fail_test_session_creation_event()
      returns trigger
      language plpgsql
      as $function$
      begin
        raise exception 'injected session creation event failure'
          using errcode = '55000';
      end;
      $function$;

      create trigger fail_test_session_creation_event
        before insert on public.device_session_events
        for each row
        when (new.event_type = 'session_created')
        execute function public.fail_test_session_creation_event();
    `);

    try {
      await expect(
        repository.bootstrapVerifiedPrivyUser(
          verifiedBootstrapInput(privyUserId, "event-failure"),
        ),
      ).rejects.toMatchObject({ code: "55000" });
      const durable = await pool.query<{
        event_count: string;
        session_count: string;
        user_count: string;
      }>({
        text: `
          select
            (select count(*)::text from public.loop_users
              where privy_user_id = $1) as user_count,
            (select count(*)::text from public.device_sessions) as session_count,
            (select count(*)::text from public.device_session_events)
              as event_count
        `,
        values: [privyUserId],
      });
      expect(durable.rows[0]).toEqual({
        event_count: "0",
        session_count: "0",
        user_count: "0",
      });
    } finally {
      await pool.query(`
        drop trigger fail_test_session_creation_event
          on public.device_session_events;
        drop function public.fail_test_session_creation_event();
      `);
    }
  });

  it("persists one successful logout and deterministically replays it", async () => {
    const ownerUserId = await createOwner("logout-replay");
    const session = await repository.create(
      createInput(ownerUserId, "logout-replay"),
    );
    const input = revokeInput(ownerUserId, session.sessionId, "logout-replay");

    const revoked = await repository.revoke(input);
    const beforeReplay = await pool.query<{ last_seen_at: string }>({
      text: `
        select last_seen_at::text
        from public.device_session_commands
        where idempotency_key = $1
      `,
      values: [input.idempotencyKey],
    });
    const replayed = await repository.revoke({
      ...input,
      requestId: randomUUID(),
    });
    const afterReplay = await pool.query<{ last_seen_at: string }>({
      text: `
        select last_seen_at::text
        from public.device_session_commands
        where idempotency_key = $1
      `,
      values: [input.idempotencyKey],
    });

    expect(revoked).not.toBeNull();
    expect(revoked).toEqual(replayed);
    expect(afterReplay.rows[0]?.last_seen_at).toBe(
      beforeReplay.rows[0]?.last_seen_at,
    );
    expect(revoked).toMatchObject({
      sessionId: session.sessionId,
      ownerUserId,
      status: "revoked",
    });
    expect(revoked?.revokedAt).toEqual(expect.any(String));
    await expect(
      repository.findById(ownerUserId, session.sessionId),
    ).resolves.toEqual(revoked);

    const durable = await pool.query<{
      command_count: string;
      event_count: string;
      original_request_id: string;
      request_digest_version: string;
    }>({
      text: `
        select
          (select count(*)::text from public.device_session_commands
            where owner_user_id = $1) as command_count,
          (select count(*)::text from public.device_session_events
            where owner_user_id = $1 and event_type = 'session_revoked')
            as event_count,
          (select request_id::text from public.device_session_commands
            where owner_user_id = $1) as original_request_id,
          (select request_digest_version from public.device_session_commands
            where owner_user_id = $1) as request_digest_version
      `,
      values: [ownerUserId],
    });
    expect(durable.rows[0]).toEqual({
      command_count: "1",
      event_count: "1",
      original_request_id: input.requestId,
      request_digest_version: "device_session_logout_v1",
    });
  });

  it("replays the original active bootstrap projection after the durable session is revoked", async () => {
    const ownerUserId = await createOwner("bootstrap-replay-after-logout");
    const bootstrap = createInput(ownerUserId, "bootstrap-replay-after-logout");
    const original = await repository.create(bootstrap);
    const revoked = await repository.revoke(
      revokeInput(
        ownerUserId,
        original.sessionId,
        "bootstrap-replay-after-logout",
      ),
    );
    if (revoked === null) {
      throw new Error("Expected the created session to be revoked");
    }

    const replayed = await repository.create({
      ...bootstrap,
      requestId: randomUUID(),
    });

    expect(replayed).toEqual(original);
    expect(replayed).toMatchObject({ status: "active", revokedAt: null });
    await expect(
      repository.findById(ownerUserId, original.sessionId),
    ).resolves.toEqual(revoked);
    const counts = await pool.query<{
      create_event_count: string;
      revoke_event_count: string;
      session_count: string;
    }>({
      text: `
        select
          (select count(*)::text from public.device_sessions
            where owner_user_id = $1) as session_count,
          (select count(*)::text from public.device_session_events
            where owner_user_id = $1 and event_type = 'session_created')
            as create_event_count,
          (select count(*)::text from public.device_session_events
            where owner_user_id = $1 and event_type = 'session_revoked')
            as revoke_event_count
      `,
      values: [ownerUserId],
    });
    expect(counts.rows[0]).toEqual({
      create_event_count: "1",
      revoke_event_count: "1",
      session_count: "1",
    });
  });

  it("rejects a successful logout key replay with changed content", async () => {
    const ownerUserId = await createOwner("logout-conflict");
    const session = await repository.create(
      createInput(ownerUserId, "logout-conflict"),
    );
    const input = revokeInput(
      ownerUserId,
      session.sessionId,
      "logout-conflict",
    );
    await repository.revoke(input);

    await expect(
      repository.revoke({
        ...input,
        requestSha256: digest("logout:changed-content"),
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(DeviceSessionIdempotencyConflictError);
  });

  it("counts successful and already-revoked logout commands toward the per-session daily limit", async () => {
    const ownerUserId = await createOwner("logout-session-limit");
    const session = await repository.create(
      createInput(ownerUserId, "logout-session-limit"),
    );
    const firstInput = revokeInput(
      ownerUserId,
      session.sessionId,
      "logout-session-limit:first",
    );
    const first = await repository.revoke(firstInput);
    if (first === null) {
      throw new Error("Expected the first logout to resolve the session");
    }
    for (let index = 1; index < 5; index += 1) {
      await expect(
        repository.revoke(
          revokeInput(
            ownerUserId,
            session.sessionId,
            `logout-session-limit:${index}`,
          ),
        ),
      ).resolves.toMatchObject({ status: "revoked" });
    }

    await expect(
      repository.revoke(
        revokeInput(
          ownerUserId,
          session.sessionId,
          "logout-session-limit:exhausted",
        ),
      ),
    ).rejects.toBeInstanceOf(DeviceSessionRateLimitedError);
    await expect(
      repository.revoke({ ...firstInput, requestId: randomUUID() }),
    ).resolves.toEqual(first);

    const commandCount = await pool.query<{ count: string }>({
      text: `
        select count(*)::text as count
        from public.device_session_commands
        where owner_user_id = $1 and requested_session_id = $2
      `,
      values: [ownerUserId, session.sessionId],
    });
    expect(commandCount.rows[0]?.count).toBe("5");
  });

  it("counts not-found commands toward the owner daily limit while replay remains available", async () => {
    const ownerUserId = await createOwner("logout-owner-limit");
    const firstInput = revokeInput(
      ownerUserId,
      randomUUID(),
      "logout-owner-limit:first",
    );
    await expect(repository.revoke(firstInput)).resolves.toBeNull();
    for (let index = 1; index < 40; index += 1) {
      await expect(
        repository.revoke(
          revokeInput(ownerUserId, randomUUID(), `logout-owner-limit:${index}`),
        ),
      ).resolves.toBeNull();
    }

    await expect(
      repository.revoke({ ...firstInput, requestId: randomUUID() }),
    ).resolves.toBeNull();
    await expect(
      repository.revoke(
        revokeInput(ownerUserId, randomUUID(), "logout-owner-limit:exhausted"),
      ),
    ).rejects.toBeInstanceOf(DeviceSessionRateLimitedError);

    const commandCount = await pool.query<{ count: string }>({
      text: `
        select count(*)::text as count
        from public.device_session_commands
        where owner_user_id = $1
      `,
      values: [ownerUserId],
    });
    expect(commandCount.rows[0]?.count).toBe("40");
  });

  it("atomically prevents concurrent logout commands from exceeding the owner daily limit", async () => {
    const ownerUserId = await createOwner("concurrent-logout-owner-limit");
    for (let index = 0; index < 39; index += 1) {
      await repository.revoke(
        revokeInput(
          ownerUserId,
          randomUUID(),
          `concurrent-logout-owner-limit:seed:${index}`,
        ),
      );
    }

    const settled = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        repository.revoke(
          revokeInput(
            ownerUserId,
            randomUUID(),
            `concurrent-logout-owner-limit:contender:${index}`,
          ),
        ),
      ),
    );
    const fulfilled = settled.filter((result) => result.status === "fulfilled");
    const rejected = settled.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]).toMatchObject({ status: "fulfilled", value: null });
    expect(rejected).toHaveLength(7);
    expect(
      rejected.every(
        ({ reason }) => reason instanceof DeviceSessionRateLimitedError,
      ),
    ).toBe(true);

    const commandCount = await pool.query<{ count: string }>({
      text: `
        select count(*)::text as count
        from public.device_session_commands
        where owner_user_id = $1
      `,
      values: [ownerUserId],
    });
    expect(commandCount.rows[0]?.count).toBe("40");
  });

  it("atomically prevents concurrent logout keys from exceeding the per-session daily limit", async () => {
    const ownerUserId = await createOwner("concurrent-logout-session-limit");
    const session = await repository.create(
      createInput(ownerUserId, "concurrent-logout-session-limit"),
    );
    for (let index = 0; index < 4; index += 1) {
      await repository.revoke(
        revokeInput(
          ownerUserId,
          session.sessionId,
          `concurrent-logout-session-limit:seed:${index}`,
        ),
      );
    }

    const settled = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) =>
        repository.revoke(
          revokeInput(
            ownerUserId,
            session.sessionId,
            `concurrent-logout-session-limit:contender:${index}`,
          ),
        ),
      ),
    );
    const fulfilled = settled.filter((result) => result.status === "fulfilled");
    const rejected = settled.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]).toMatchObject({
      status: "fulfilled",
      value: { status: "revoked" },
    });
    expect(rejected).toHaveLength(5);
    expect(
      rejected.every(
        ({ reason }) => reason instanceof DeviceSessionRateLimitedError,
      ),
    ).toBe(true);

    const durable = await pool.query<{
      command_count: string;
      revoke_event_count: string;
    }>({
      text: `
        select
          (select count(*)::text from public.device_session_commands
            where owner_user_id = $1 and requested_session_id = $2)
            as command_count,
          (select count(*)::text from public.device_session_events
            where owner_user_id = $1 and session_id = $2
              and event_type = 'session_revoked') as revoke_event_count
      `,
      values: [ownerUserId, session.sessionId],
    });
    expect(durable.rows[0]).toEqual({
      command_count: "5",
      revoke_event_count: "1",
    });
  });

  it("converges different concurrent logout keys on one revocation timestamp and event", async () => {
    const ownerUserId = await createOwner("concurrent-different-logout-keys");
    const session = await repository.create(
      createInput(ownerUserId, "concurrent-different-logout-keys"),
    );
    const firstInput = revokeInput(
      ownerUserId,
      session.sessionId,
      "concurrent-different-logout-keys:first",
    );
    const secondInput = revokeInput(
      ownerUserId,
      session.sessionId,
      "concurrent-different-logout-keys:second",
    );

    const [first, second] = await Promise.all([
      repository.revoke(firstInput),
      repository.revoke(secondInput),
    ]);
    if (first === null || second === null) {
      throw new Error(
        "Both owner-bound logout commands must resolve the session",
      );
    }

    expect(first).toEqual(second);
    expect(first.revokedAt).toEqual(expect.any(String));
    const durable = await pool.query<{
      command_count: string;
      revoke_event_count: string;
    }>({
      text: `
        select
          (select count(*)::text from public.device_session_commands
            where owner_user_id = $1 and requested_session_id = $2)
            as command_count,
          (select count(*)::text from public.device_session_events
            where owner_user_id = $1 and session_id = $2
              and event_type = 'session_revoked') as revoke_event_count
      `,
      values: [ownerUserId, session.sessionId],
    });
    expect(durable.rows[0]).toEqual({
      command_count: "2",
      revoke_event_count: "1",
    });
  });

  it("serializes one logout key aimed concurrently at different sessions", async () => {
    const ownerUserId = await createOwner("concurrent-conflicting-logout-key");
    const sessionA = await repository.create(
      createInput(ownerUserId, "concurrent-conflicting-logout-key:a"),
    );
    const sessionB = await repository.create(
      createInput(ownerUserId, "concurrent-conflicting-logout-key:b"),
    );
    const sharedIdempotencyKey = randomUUID();
    const settled = await Promise.allSettled([
      repository.revoke(
        revokeInput(
          ownerUserId,
          sessionA.sessionId,
          "concurrent-conflicting-logout-key:a",
          { idempotencyKey: sharedIdempotencyKey },
        ),
      ),
      repository.revoke(
        revokeInput(
          ownerUserId,
          sessionB.sessionId,
          "concurrent-conflicting-logout-key:b",
          { idempotencyKey: sharedIdempotencyKey },
        ),
      ),
    ]);
    const fulfilled = settled.filter(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<DeviceSessionRepository["revoke"]>>
      > => result.status === "fulfilled",
    );
    const rejected = settled.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(
      DeviceSessionIdempotencyConflictError,
    );
    const winner = fulfilled[0]?.value;
    if (winner === null || winner === undefined) {
      throw new Error("Expected one logout command to win");
    }
    const durableSessions = await Promise.all([
      repository.findById(ownerUserId, sessionA.sessionId),
      repository.findById(ownerUserId, sessionB.sessionId),
    ]);
    expect(
      durableSessions.filter((session) => session?.status === "revoked"),
    ).toHaveLength(1);
    expect(
      durableSessions.filter((session) => session?.status === "active"),
    ).toHaveLength(1);
    expect(
      durableSessions.find((session) => session?.status === "revoked")
        ?.sessionId,
    ).toBe(winner.sessionId);

    const durable = await pool.query<{
      command_count: string;
      revoke_event_count: string;
    }>({
      text: `
        select
          (select count(*)::text from public.device_session_commands
            where idempotency_key = $1) as command_count,
          (select count(*)::text from public.device_session_events
            where owner_user_id = $2 and event_type = 'session_revoked')
            as revoke_event_count
      `,
      values: [sharedIdempotencyKey, ownerUserId],
    });
    expect(durable.rows[0]).toEqual({
      command_count: "1",
      revoke_event_count: "1",
    });
  });

  it("persists and replays a non-enumerating not-found logout result", async () => {
    const ownerUserId = await createOwner("logout-not-found");
    const input = revokeInput(ownerUserId, randomUUID(), "logout-not-found");

    await expect(repository.revoke(input)).resolves.toBeNull();
    await expect(
      repository.revoke({ ...input, requestId: randomUUID() }),
    ).resolves.toBeNull();

    const command = await pool.query<{
      count: string;
      request_id: string;
      requested_session_id: string;
      resolved_session_id: string | null;
      result_status: string;
    }>({
      text: `
        select
          count(*) over ()::text as count,
          request_id::text,
          requested_session_id::text,
          resolved_session_id::text,
          result_status
        from public.device_session_commands
        where command_kind = 'logout' and idempotency_key = $1
      `,
      values: [input.idempotencyKey],
    });
    expect(command.rows[0]).toEqual({
      count: "1",
      request_id: input.requestId,
      requested_session_id: input.sessionId,
      resolved_session_id: null,
      result_status: "not_found",
    });

    await expect(
      repository.revoke({
        ...input,
        requestSha256: digest("logout:not-found-changed"),
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(DeviceSessionIdempotencyConflictError);
  });

  it("persists and replays the same not-found result for a foreign owner", async () => {
    const ownerA = await createOwner("foreign-session-owner");
    const ownerB = await createOwner("foreign-session-requester");
    const session = await repository.create(
      createInput(ownerA, "foreign-session-owner"),
    );
    const input = revokeInput(ownerB, session.sessionId, "foreign-owner");

    await expect(repository.revoke(input)).resolves.toBeNull();
    await expect(
      repository.revoke({ ...input, requestId: randomUUID() }),
    ).resolves.toBeNull();
    await expect(
      repository.findById(ownerA, session.sessionId),
    ).resolves.toEqual(session);

    const command = await pool.query<{
      count: string;
      owner_user_id: string;
      resolved_session_id: string | null;
      result_status: string;
    }>({
      text: `
        select
          count(*) over ()::text as count,
          owner_user_id::text,
          resolved_session_id::text,
          result_status
        from public.device_session_commands
        where command_kind = 'logout' and idempotency_key = $1
      `,
      values: [input.idempotencyKey],
    });
    expect(command.rows[0]).toEqual({
      count: "1",
      owner_user_id: ownerB,
      resolved_session_id: null,
      result_status: "not_found",
    });

    await expect(
      repository.revoke({
        ...input,
        requestSha256: digest("logout:foreign-owner-changed"),
        requestId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(DeviceSessionIdempotencyConflictError);
  });

  it("creates only one session and creation event under concurrent same-key bootstrap", async () => {
    const ownerUserId = await createOwner("concurrent-bootstrap");
    const input = createInput(ownerUserId, "concurrent-bootstrap");

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        repository.create({
          ...input,
          requestId: index === 0 ? input.requestId : randomUUID(),
        }),
      ),
    );

    expect(new Set(results.map(({ sessionId }) => sessionId)).size).toBe(1);
    const firstResult = results[0];
    if (firstResult === undefined) {
      throw new Error("Concurrent bootstrap returned no results");
    }
    for (const result of results) {
      expect(result).toEqual(firstResult);
    }

    const durable = await pool.query<{
      event_count: string;
      session_count: string;
    }>({
      text: `
        select
          (select count(*)::text from public.device_sessions
            where bootstrap_idempotency_key = $1) as session_count,
          (select count(*)::text from public.device_session_events
            where session_id = $2 and event_version = 0) as event_count
      `,
      values: [input.idempotencyKey, firstResult.sessionId],
    });
    expect(durable.rows[0]).toEqual({
      event_count: "1",
      session_count: "1",
    });
  });

  it("enforces the owner rolling-24-hour creation limit", async () => {
    const ownerUserId = await createOwner("owner-day-limit");
    await Promise.all(
      Array.from({ length: 20 }, () =>
        seedSession({
          ownerUserId,
          status: "revoked",
          hoursAgo: 1,
        }),
      ),
    );

    await expect(
      repository.create(createInput(ownerUserId, "owner-day-limit")),
    ).rejects.toBeInstanceOf(DeviceSessionRateLimitedError);
  });

  it("enforces the same-device rolling-24-hour creation limit", async () => {
    const ownerUserId = await createOwner("device-day-limit");
    const deviceId = randomUUID();
    await Promise.all(
      Array.from({ length: 5 }, () =>
        seedSession({
          ownerUserId,
          deviceId,
          status: "revoked",
          hoursAgo: 1,
        }),
      ),
    );

    await expect(
      repository.create(
        createInput(ownerUserId, "device-day-limit", { deviceId }),
      ),
    ).rejects.toBeInstanceOf(DeviceSessionRateLimitedError);
    await expect(
      repository.create(createInput(ownerUserId, "different-device")),
    ).resolves.toMatchObject({ status: "active" });
  });

  it("resolves an exact bootstrap replay before applying exhausted rolling quota", async () => {
    const ownerUserId = await createOwner("replay-before-quota");
    const input = createInput(ownerUserId, "replay-before-quota");
    const original = await repository.create(input);
    await Promise.all(
      Array.from({ length: 19 }, () =>
        seedSession({
          ownerUserId,
          status: "revoked",
          hoursAgo: 1,
        }),
      ),
    );

    await expect(
      repository.create({ ...input, requestId: randomUUID() }),
    ).resolves.toEqual(original);
    await expect(
      repository.create(createInput(ownerUserId, "new-after-quota")),
    ).rejects.toBeInstanceOf(DeviceSessionRateLimitedError);
  });

  it("rejects invalid revocation states and immutable session identity changes", async () => {
    const ownerUserId = await createOwner("session-constraints");
    await expect(
      pool.query({
        text: `
          insert into public.device_sessions (
            owner_user_id,
            bootstrap_idempotency_key,
            bootstrap_request_sha256,
            device_id,
            client_platform,
            client_version,
            status,
            revoked_at
          ) values ($1, $2, $3, $4, 'ios', '1.2.3', 'revoked', null)
        `,
        values: [
          ownerUserId,
          randomUUID(),
          digest("invalid-revocation-state"),
          randomUUID(),
        ],
      }),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "device_sessions_revocation_state_check",
    });

    const session = await repository.create(
      createInput(ownerUserId, "immutable-session"),
    );
    await expect(
      pool.query({
        text: `
          update public.device_sessions
          set device_id = $2
          where session_id = $1
        `,
        values: [session.sessionId, randomUUID()],
      }),
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("rejects a revoked command whose resolved session is null", async () => {
    const ownerUserId = await createOwner("invalid-command-result");

    await expect(
      pool.query({
        text: `
          insert into public.device_session_commands (
            owner_user_id,
            requested_session_id,
            resolved_session_id,
            command_kind,
            idempotency_key,
            request_sha256,
            request_id,
            result_status,
            result_revoked_at
          ) values (
            $1,
            $2,
            null,
            'logout',
            $3,
            $4,
            $5,
            'revoked',
            clock_timestamp()
          )
        `,
        values: [
          ownerUserId,
          randomUUID(),
          randomUUID(),
          digest("invalid-command-result"),
          randomUUID(),
        ],
      }),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "device_session_commands_result_check",
    });
  });

  it("rejects direct mutation of a persisted logout digest or result", async () => {
    const ownerUserId = await createOwner("immutable-command");
    const session = await repository.create(
      createInput(ownerUserId, "immutable-command"),
    );
    const input = revokeInput(
      ownerUserId,
      session.sessionId,
      "immutable-command",
    );
    const revoked = await repository.revoke(input);
    if (revoked === null) {
      throw new Error("Expected immutable-command session to be revoked");
    }

    await expect(
      pool.query({
        text: `
          update public.device_session_commands
          set request_sha256 = $2
          where idempotency_key = $1
        `,
        values: [input.idempotencyKey, digest("immutable-command:changed")],
      }),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query({
        text: `
          update public.device_session_commands
          set
            resolved_session_id = null,
            result_status = 'not_found',
            result_revoked_at = null
          where idempotency_key = $1
        `,
        values: [input.idempotencyKey],
      }),
    ).rejects.toMatchObject({ code: "55000" });

    const command = await pool.query<{
      request_sha256: string;
      resolved_session_id: string;
      result_status: string;
    }>({
      text: `
        select request_sha256, resolved_session_id::text, result_status
        from public.device_session_commands
        where idempotency_key = $1
      `,
      values: [input.idempotencyKey],
    });
    expect(command.rows[0]).toEqual({
      request_sha256: input.requestSha256,
      resolved_session_id: session.sessionId,
      result_status: "revoked",
    });
  });

  it("rolls back the session and command when the revoke event cannot be inserted", async () => {
    const ownerUserId = await createOwner("revoke-event-failure");
    const session = await repository.create(
      createInput(ownerUserId, "revoke-event-failure"),
    );
    const injectedRequestId = randomUUID();
    await pool.query({
      text: `
        insert into public.device_session_events (
          owner_user_id,
          session_id,
          event_version,
          event_type,
          request_id
        ) values ($1, $2, 1, 'session_revoked', $3)
      `,
      values: [ownerUserId, session.sessionId, injectedRequestId],
    });
    const input = revokeInput(
      ownerUserId,
      session.sessionId,
      "revoke-event-failure",
    );

    await expect(repository.revoke(input)).rejects.toMatchObject({
      code: "23505",
      constraint: "device_session_events_version_unique",
    });
    await expect(
      repository.findById(ownerUserId, session.sessionId),
    ).resolves.toEqual(session);
    const durable = await pool.query<{
      command_count: string;
      event_count: string;
      status: string;
    }>({
      text: `
        select
          device_sessions.status,
          (select count(*)::text from public.device_session_commands
            where idempotency_key = $2) as command_count,
          (select count(*)::text from public.device_session_events
            where session_id = device_sessions.session_id) as event_count
        from public.device_sessions
        where session_id = $1
      `,
      values: [session.sessionId, input.idempotencyKey],
    });
    expect(durable.rows[0]).toEqual({
      command_count: "0",
      event_count: "2",
      status: "active",
    });
  });

  it("keeps device-session events append-only", async () => {
    const ownerUserId = await createOwner("append-only-events");
    const session = await repository.create(
      createInput(ownerUserId, "append-only-events"),
    );

    await expect(
      pool.query({
        text: `
          update public.device_session_events
          set occurred_at = clock_timestamp()
          where session_id = $1 and event_version = 0
        `,
        values: [session.sessionId],
      }),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query({
        text: `
          delete from public.device_session_events
          where session_id = $1 and event_version = 0
        `,
        values: [session.sessionId],
      }),
    ).rejects.toMatchObject({ code: "55000" });

    const event = await pool.query<{
      event_type: string;
      event_version: number;
      request_id: string;
    }>({
      text: `
        select event_type, event_version, request_id::text
        from public.device_session_events
        where session_id = $1
      `,
      values: [session.sessionId],
    });
    expect(event.rows).toHaveLength(1);
    expect(event.rows[0]).toMatchObject({
      event_type: "session_created",
      event_version: 0,
    });
    expect(event.rows[0]?.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
