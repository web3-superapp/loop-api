import type { FastifyBaseLogger } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import {
  createPostgresDatabase,
  type Database,
} from "../src/database/database.js";

const { Pool } = pg;
const databaseUrl = process.env["DATABASE_URL"];

if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error("DATABASE_URL is required for the integration test suite");
}

const config = loadConfig({
  NODE_ENV: "test",
  API_DOCS_ENABLED: "false",
  LOG_LEVEL: "silent",
  DATABASE_URL: databaseUrl,
});
const logger = {
  error: () => undefined,
} as unknown as FastifyBaseLogger;
const truncateControlPlane = `
  truncate table
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
    public.loop_users
`;

describe("PostgreSQL internal-user repository", () => {
  let database: Database;
  const inspectionPool = new Pool({ connectionString: databaseUrl });

  beforeAll(() => {
    database = createPostgresDatabase(config, logger);
  });

  beforeEach(async () => {
    await inspectionPool.query(truncateControlPlane);
  });

  afterAll(async () => {
    await database.close();
    await inspectionPool.query(truncateControlPlane);
    await inspectionPool.end();
  });

  it("returns one stable UUID for sequential calls", async () => {
    const first = await database.internalUsers.getOrCreateByPrivyUserId(
      "did:privy:sequential",
    );
    const second = await database.internalUsers.getOrCreateByPrivyUserId(
      "did:privy:sequential",
    );
    const count = await inspectionPool.query<{ count: string }>(
      "select count(*)::text as count from public.loop_users",
    );

    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toEqual(first);
    expect(count.rows[0]?.count).toBe("1");
  });

  it("returns one UUID under concurrent first bootstrap", async () => {
    const users = await Promise.all(
      Array.from({ length: 20 }, async () =>
        database.internalUsers.getOrCreateByPrivyUserId("did:privy:concurrent"),
      ),
    );
    const ids = new Set(users.map((user) => user.id));
    const count = await inspectionPool.query<{ count: string }>(
      "select count(*)::text as count from public.loop_users",
    );

    expect(ids.size).toBe(1);
    expect(count.rows[0]?.count).toBe("1");
  });

  it("creates distinct UUIDs for distinct verified identities", async () => {
    const first =
      await database.internalUsers.getOrCreateByPrivyUserId("did:privy:first");
    const second =
      await database.internalUsers.getOrCreateByPrivyUserId("did:privy:second");

    expect(first.id).not.toBe(second.id);
  });

  it("finds only an existing verified identity without creating one", async () => {
    const missing =
      await database.internalUsers.findByPrivyUserId("did:privy:missing");
    const created =
      await database.internalUsers.getOrCreateByPrivyUserId(
        "did:privy:existing",
      );
    const found =
      await database.internalUsers.findByPrivyUserId("did:privy:existing");
    const count = await inspectionPool.query<{ count: string }>(
      "select count(*)::text as count from public.loop_users",
    );

    expect(missing).toBeNull();
    expect(found).toEqual(created);
    expect(count.rows[0]?.count).toBe("1");
  });

  it("rejects an invalid provider ID before insertion", async () => {
    await expect(
      database.internalUsers.getOrCreateByPrivyUserId("x".repeat(256)),
    ).rejects.toThrow();
    const count = await inspectionPool.query<{ count: string }>(
      "select count(*)::text as count from public.loop_users",
    );

    expect(count.rows[0]?.count).toBe("0");
  });
});
