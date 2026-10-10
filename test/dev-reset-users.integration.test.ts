import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  disabledByDevReset,
  retiredPrivyUserIdPrefix,
  runDevResetUsers,
  sentinelPrivyUserId,
  tableClassification,
} from "../scripts/dev-reset-users.js";
import { createPostgresHooksLaunchProjectConfigRepository } from "../src/database/hooks-launch-project-config-repository.js";
import { parseHooksLaunchDraft } from "../src/features/launch/hooks-launch-config.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0113 on PostgreSQL, in a throwaway `loop_api_test_*` database:
 * a fixture covering every mixed table plus a spread of user-rooted ones is
 * reset; user-rooted tables end empty (loop_users keeps the sentinel and the
 * retired `ops_audit` actor), platform tables and audit logs keep every
 * row, mixed rows point at the sentinel or lose the user column, guard
 * triggers are back on, and a second run changes nothing.
 */

const { Client, Pool } = pg;
const databaseUrl = requireIntegrationDatabaseUrl();
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

function connectionUrl(source: string, name: string): string {
  const url = new URL(source);
  url.pathname = `/${name}`;
  return url.toString();
}

async function admin<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new Client({
    connectionString: connectionUrl(databaseUrl, "postgres"),
  });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

function writer() {
  let contents = "";
  return {
    write: (chunk: string) => {
      contents += chunk;
      return true;
    },
    contents: () => contents,
  };
}

const sha = (seed: string) => createHash("sha256").update(seed).digest("hex");
const hex32 = () => randomUUID().replaceAll("-", "");
const argonHash =
  "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2g";

const launchDraft = parseHooksLaunchDraft(
  {
    name: "Project",
    ticker: "MEME",
    logoAssetUrl: "https://example.com/logo.png",
    description: "Test",
    links: [],
    nftSaleStartAt: "1900000000",
    buybackRecipient: "0x3333333333333333333333333333333333333333",
  },
  { nowUnixSeconds: "1800000000", minimumLeadSeconds: 86_400 },
);

describe("Decision 0113 dev user reset on PostgreSQL", () => {
  const databaseName = `loop_api_test_s133_${hex32()}`;
  let url = "";
  let pool: InstanceType<typeof Pool>;
  const ids = {
    alice: "",
    bob: "",
    carol: "",
    aliceWallet: "",
    aliceIdem: "",
    logoMedia: randomUUID(),
    memeMedia: randomUUID(),
    avatarMedia: randomUUID(),
    communityX: randomUUID(),
    communityY: randomUUID(),
    memeToken: randomUUID(),
    project: randomUUID(),
    launch: randomUUID(),
    reviewerAccount: randomUUID(),
    auditorAccount: randomUUID(),
    snapshot: randomUUID(),
  };

  async function cli(argv: readonly string[], environment = {}) {
    const stdout = writer();
    const stderr = writer();
    const exitCode = await runDevResetUsers({
      argv: ["node", "dev-reset-users", ...argv],
      environment: {
        NODE_ENV: "development",
        DATABASE_URL: url,
        ...environment,
      },
      stdout,
      stderr,
    });
    return { exitCode, stdout: stdout.contents(), stderr: stderr.contents() };
  }

  async function tableCounts(): Promise<Record<string, number>> {
    const tables = await pool.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' order by 1",
    );
    const counts: Record<string, number> = {};
    for (const { tablename } of tables.rows) {
      const result = await pool.query<{ n: number }>(
        `select count(*)::int as n from public."${tablename}"`,
      );
      counts[tablename] = result.rows[0]!.n;
    }
    return counts;
  }

  async function triggerStates(): Promise<string[]> {
    const result = await pool.query<{ state: string }>(
      `select c.relname || '.' || t.tgname || '=' || t.tgenabled::text as state
       from pg_trigger as t join pg_class as c on c.oid = t.tgrelid
       join pg_namespace as n on n.oid = c.relnamespace
       where n.nspname = 'public' and not t.tgisinternal order by 1`,
    );
    return result.rows.map((row) => row.state);
  }

  async function user(label: string): Promise<string> {
    const result = await pool.query<{ id: string }>(
      "insert into public.loop_users (privy_user_id) values ($1) returning id",
      [`did:privy:s133-${label}-${hex32()}`],
    );
    return result.rows[0]!.id;
  }

  async function seed(): Promise<void> {
    ids.alice = await user("alice");
    ids.bob = await user("bob");
    ids.carol = await user("carol");
    const { alice, bob, carol } = ids;
    const q = (text: string, values: readonly unknown[] = []) =>
      pool.query(text, [...values]);

    // Chain facts and market cache (platform).
    await q(`insert into public.chains (chain_id, namespace, reference, name, native_asset_id, confirmations, reorg_depth_blocks)
             values ('eip155:97', 'eip155', 97, 'BSC Testnet', 'eip155:97:native', 15, 30)
             on conflict do nothing`);
    await q(`insert into public.assets (asset_id, chain_id, symbol, name, decimals, source_kind)
             values ('eip155:97:native', 'eip155:97', 'tBNB', 'Test BNB', 18, 'chain_native')
             on conflict do nothing`);
    await q(
      `insert into public.market_fact_cache (subject_key, fact_kind, source, value, raw_digest, fetched_at, ttl_seconds)
             values ('eip155:97:native', 'price', 'dexscreener', '{}', $1, now(), 60)`,
      [sha("m")],
    );
    await q(
      `insert into public.admin_settings (key, value, updated_by)
             values ('recommended_community_ids', $1, 'operator')`,
      [JSON.stringify([ids.communityX])],
    );

    // Identity and profile rows.
    await q(
      "insert into public.user_profiles (owner_user_id) values ($1), ($2)",
      [alice, bob],
    );
    const wallet = await q(
      `insert into public.account_wallets (owner_user_id, address, kind)
       values ($1, '0x00000000000000000000000000000000000000a1', 'external') returning wallet_id`,
      [alice],
    );
    ids.aliceWallet = (wallet.rows[0] as { wallet_id: string }).wallet_id;
    const idem = await q(
      `insert into public.idempotency_records (owner_user_id, scope, idempotency_key, key_source, request_sha256)
       values ($1, 'meme_create', $2, 'client', $3) returning id`,
      [alice, randomUUID(), sha("i")],
    );
    ids.aliceIdem = (idem.rows[0] as { id: string }).id;
    const idem2 = await q(
      `insert into public.idempotency_records (owner_user_id, scope, idempotency_key, key_source, request_sha256)
       values ($1, 'launch_project', $2, 'client', $3) returning id`,
      [alice, randomUUID(), sha("j")],
    );
    const launchIdem = (idem2.rows[0] as { id: string }).id;
    for (const [mediaId, kind] of [
      [ids.logoMedia, "community_logo"],
      [ids.memeMedia, "avatar"],
      [ids.avatarMedia, "avatar"],
    ] as const) {
      await q(
        `insert into public.media_objects (media_id, owner_user_id, kind, content_type, bytes, width, height, sha256, idempotency_key, request_sha256)
         values ($1, $2, $3, 'image/webp', '\\x00', 1, 1, $4, $5, $6)`,
        [mediaId, alice, kind, sha(mediaId), randomUUID(), sha(`r${mediaId}`)],
      );
    }
    await q(
      "update public.user_profiles set avatar_ref = $2 where owner_user_id = $1",
      [alice, `avatar:media/${ids.avatarMedia}`],
    );

    // Communities (mixed) with members, role history, channel, voice room.
    await q(
      `insert into public.communities (community_id, name, slug, created_by_user_id, logo_ref, verification_status, verified_at, reviewed_at)
       values ($1, 'Alpha', 'alpha-s133', $2, $3, 'verified', now(), now()),
              ($4, 'Beta', 'beta-s133', $5, null, 'pending', null, null)`,
      [
        ids.communityX,
        alice,
        `logo:media/${ids.logoMedia}`,
        ids.communityY,
        bob,
      ],
    );
    await q(
      `insert into public.community_memberships (community_id, owner_user_id, role, status)
       values ($1, $2, 'owner', 'active'), ($1, $3, 'member', 'active'), ($1, $4, 'member', 'banned'),
              ($5, $3, 'owner', 'active')`,
      [ids.communityX, alice, bob, carol, ids.communityY],
    );
    await q(
      `insert into public.community_role_events (community_id, actor_type, actor_user_id, target_user_id, event_type)
       values ($1, 'member', $2, $3, 'member_joined'), ($1, 'operator', null, null, 'community_verified')`,
      [ids.communityX, alice, bob],
    );
    await q(
      `insert into public.community_channels (community_id, stream_channel_id, member_cap, created_by_user_id)
       values ($1, $2, 100, $3)`,
      [ids.communityX, `loop_community_${hex32()}`, alice],
    );
    await q(
      `insert into public.community_channel_members (community_id, owner_user_id, stream_user_id)
       values ($1, $2, $3)`,
      [ids.communityX, bob, `loop_${hex32()}`],
    );
    const room = await q(
      `insert into public.voice_rooms (community_id, call_id, created_by_user_id, state, ended_at)
       values ($1, $2, $3, 'ended', now()) returning voice_room_id`,
      [ids.communityX, `loop_voice_${hex32()}`, alice],
    );
    await q(
      "insert into public.voice_room_members (voice_room_id, owner_user_id, role, state) values ($1, $2, 'listener', 'left')",
      [(room.rows[0] as { voice_room_id: string }).voice_room_id, bob],
    );
    await q(
      "insert into public.follow_edges (follower_user_id, followee_user_id) values ($1, $2)",
      [alice, bob],
    );
    await q(
      `insert into public.notifications (owner_user_id, type, entity_ref, context_route, payload, dedupe_key)
       values ($1, 'community.all', 'community:x', 'community', '{}', $2)`,
      [bob, `d-${hex32()}`],
    );

    // MEME token (mixed) with trades and holders (platform chain facts).
    await q(
      `insert into public.meme_tokens (meme_token_id, chain_id, contract_address, contract_version, creator_user_id,
         creator_wallet_id, creator_wallet, name, symbol, metadata_hash, image_media_id, idempotency_record_id,
         status, token_address)
       values ($1, 'eip155:97', '0xe108d45e3e9d7b8c9c02c5e10544ad811cb39b8a', '1.0.0', $2, $3,
         '0x00000000000000000000000000000000000000a1', 'Frog', 'FROG', $4, $5, $6, 'trading',
         '0x00000000000000000000000000000000000000f1')`,
      [
        ids.memeToken,
        alice,
        ids.aliceWallet,
        `0x${sha("meta")}`,
        ids.memeMedia,
        ids.aliceIdem,
      ],
    );
    await q(
      `insert into public.meme_holders (meme_token_id, wallet, balance)
       values ($1, '0x00000000000000000000000000000000000000a1', 5)`,
      [ids.memeToken],
    );
    await q(
      `insert into public.meme_trades (chain_id, transaction_hash, log_index, block_number, block_hash, token_address,
         meme_token_id, wallet, is_buy, usd1_amount, token_amount, fee_usd1, v_usd1_after, v_token_after, sold_after,
         price_after_e18, traded_at)
       values ('eip155:97', $1, 0, 10, $2, '0x00000000000000000000000000000000000000f1', $3,
         '0x00000000000000000000000000000000000000a1', true, 1, 5, 0, 1, 1, 5, 1, now())`,
      [`0x${sha("tx")}`, `0x${sha("bh")}`, ids.memeToken],
    );

    // Launch project (mixed) with applicant + operator history, a sale
    // (platform), and the owner's Hooks config version and approval (user).
    await q(
      `insert into public.launch_projects (project_id, owner_user_id, name, ticker, review_status, submitted_at, reviewed_at)
       values ($1, $2, 'Project', 'MEME', 'approved', now(), now())`,
      [ids.project, alice],
    );
    await q(
      `insert into public.launch_review_events (project_id, actor_type, actor_user_id, event_type, to_status, idempotency_record_id)
       values ($1, 'applicant', $2, 'project_submitted', 'submitted', $3),
              ($1, 'operator', null, 'project_approved', 'approved', null)`,
      [ids.project, alice, launchIdem],
    );
    await q(
      "insert into public.launches (launch_id, project_id) values ($1, $2)",
      [ids.launch, ids.project],
    );
    await createPostgresHooksLaunchProjectConfigRepository(pool).saveOwnedDraft(
      {
        projectId: ids.project,
        ownerUserId: alice,
        expectedVersion: 0,
        templateVersion: launchDraft.templateVersion,
        configHash: launchDraft.configHash,
        config: launchDraft,
        updatedByUserId: alice,
      },
    );

    // Operators: bob is an ops operator with an ops_api audit row (the FK
    // that keeps him as a retired user); carol is bound to a reviewer
    // console account.
    await q(
      "insert into public.ops_operators (user_id, label, enabled) values ($1, 'bob', true), ($2, 'carol', true)",
      [bob, carol],
    );
    await q(
      "insert into public.ops_grants (user_id, permission, scope) values ($1, 'launch.approve', '*'), ($2, 'launch.read', '*')",
      [bob, carol],
    );
    await q(
      `insert into public.hooks_launch_config_approvals (project_id, config_version, config_hash, approver_id, reason)
       values ($1, 1, $2, $3, 'Reviewed')`,
      [ids.project, launchDraft.configHash, bob],
    );
    await q(
      `insert into public.ops_audit (operation_id, actor_id, actor_kind, source, action, target, reason, outcome)
       values ($1, $2, 'user', 'ops_api', 'launch.approve', $3, 'Reviewed', 'succeeded')`,
      [randomUUID(), bob, ids.project],
    );
    await q(
      `insert into public.admin_accounts (id, username, password_hash, role, operator_user_id, created_by)
       values ($1, 'reviewer-s133', $3, 'reviewer', $4, 'operator'),
              ($2, 'auditor-s133', $3, 'auditor', null, 'operator')`,
      [ids.reviewerAccount, ids.auditorAccount, argonHash, carol],
    );
    await q(
      `insert into public.admin_audit_log (audit_id, actor, action, target_type, target_id, request_id)
       values ($1, 'operator', 'account.create', 'admin_account', $2, $3)`,
      [randomUUID(), ids.reviewerAccount, randomUUID()],
    );

    // Mining: platform formula + snapshot, user power rows.
    await q(
      `insert into public.mining_formula_versions (config_version, formula, weight_range, price_guard_rules)
       values ('s133Base', '{}', '{}', '[]')`,
    );
    await q(
      `insert into public.mining_snapshots (snapshot_id, block_number, block_hash, formula_version, price_version,
         total_power, account_count, status, unread_inputs, holdings_source)
       values ($1, 10, $2, 's133Base', 'p1', '1', 1, 'complete', '[]', 'chain')`,
      [ids.snapshot, `0x${sha("snap")}`],
    );
    await q(
      `insert into public.mining_snapshot_powers (snapshot_id, owner_user_id, asset_id, holding, reference_price_usd,
         weight, power, block_number, reference_price_quality)
       values ($1, $2, 'eip155:97:native', '1', '1', '1', '1', 10, 'fresh')`,
      [ids.snapshot, alice],
    );
  }

  beforeAll(async () => {
    await admin((client) => client.query(`create database "${databaseName}"`));
    url = connectionUrl(databaseUrl, databaseName);
    await runner({
      databaseUrl: url,
      dir: migrationsDirectory,
      direction: "up",
      migrationsTable: "pgmigrations",
      log: () => undefined,
    });
    pool = new Pool({ connectionString: url });
    await seed();
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await admin((client) =>
      client.query(`drop database if exists "${databaseName}" with (force)`),
    );
  });

  it("refuses production and databases outside loop_api_dev* / loop_api_test*", async () => {
    const before = await tableCounts();
    const production = await cli(["--yes"], { NODE_ENV: "production" });
    expect(production.exitCode).toBe(1);
    expect(production.stderr).toContain("dev_reset_forbidden_in_production");
    for (const name of [
      "loop_api_staging",
      "loop_s133",
      "postgres",
      "loop_api",
    ]) {
      const refused = await cli(["--yes"], {
        DATABASE_URL: connectionUrl(databaseUrl, name),
      });
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain("dev_reset_database_name_refused");
    }
    const missing = await cli(["--yes"], { DATABASE_URL: "" });
    expect(missing.stderr).toContain("dev_reset_database_unconfigured");
    const bad = await cli(["--yes", "--force"]);
    expect(bad.stderr).toContain("dev_reset_arguments_invalid");
    expect(await tableCounts()).toEqual(before);
  });

  it("refuses to run while a table is unclassified", async () => {
    await pool.query("create table public.s133_unclassified (id int)");
    try {
      const result = await cli(["--yes"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "dev_reset_unclassified_tables: s133_unclassified",
      );
      const users = await pool.query(
        "select 1 from public.loop_users where privy_user_id = $1",
        [sentinelPrivyUserId],
      );
      expect(users.rowCount).toBe(0);
    } finally {
      await pool.query("drop table public.s133_unclassified");
    }
  });

  it("classifies every table of the migrated schema", async () => {
    const tables = await pool.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' order by 1",
    );
    expect(tables.rows.map((row) => row.tablename).sort()).toEqual(
      Object.keys(tableClassification).sort(),
    );
  });

  it("prints a plan without --yes and changes nothing", async () => {
    const before = await tableCounts();
    const triggers = await triggerStates();
    for (const argv of [[], ["--dry-run"], ["--dry-run", "--yes"]]) {
      const plan = await cli(argv);
      expect(plan.stderr).toBe("");
      expect(plan.exitCode).toBe(0);
      expect(plan.stdout).toContain("PLAN (dry run, nothing changed)");
      expect(plan.stdout).toMatch(/loop_users\s+would delete\s+2\n/u);
      expect(plan.stdout).toMatch(
        /communities\s+would update\s+2\s+created_by_user_id -> sentinel/u,
      );
      expect(plan.stdout).toContain("Run again with --yes to execute.");
    }
    expect(await tableCounts()).toEqual(before);
    expect(await triggerStates()).toEqual(triggers);
  });

  it("deletes user-rooted rows, keeps platform rows, rewrites mixed rows; a second run is a no-op", async () => {
    const before = await tableCounts();
    const triggers = await triggerStates();
    const result = await cli(["--yes"]);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("EXECUTED on loop_api_test_s133_");
    expect(result.stdout).toContain("Stream: not touched");

    const sentinel = await pool.query<{ id: string }>(
      "select id from public.loop_users where privy_user_id = $1",
      [sentinelPrivyUserId],
    );
    const sentinelId = sentinel.rows[0]!.id;
    expect(result.stdout).toContain(sentinelId);

    const after = await tableCounts();
    for (const [table, kind] of Object.entries(tableClassification)) {
      if (kind === "platform" || kind === "mixed") {
        // Mixed tables whose user-only rows are deleted, not rewritten.
        if (table !== "media_objects" && table !== "community_role_events") {
          expect({ table, rows: after[table] }).toEqual({
            table,
            rows: before[table],
          });
        }
      } else if (table === "loop_users") {
        expect(after[table]).toBe(2);
      } else {
        expect({ table, rows: after[table] }).toEqual({ table, rows: 0 });
      }
    }
    // Seeded platform and audit rows are really there.
    for (const table of [
      "admin_audit_log",
      "ops_audit",
      "meme_trades",
      "meme_holders",
      "launches",
      "mining_snapshots",
      "mining_formula_versions",
      "market_fact_cache",
      "admin_settings",
    ]) {
      expect({ table, rows: after[table]! > 0 }).toEqual({ table, rows: true });
    }

    // loop_users: the sentinel and bob, retired because ops_audit names him.
    const users = await pool.query<{ id: string; privy_user_id: string }>(
      "select id, privy_user_id from public.loop_users order by privy_user_id",
    );
    expect(users.rows).toEqual(
      [
        { id: ids.bob, privy_user_id: `${retiredPrivyUserIdPrefix}${ids.bob}` },
        { id: sentinelId, privy_user_id: sentinelPrivyUserId },
      ].sort((a, b) => a.privy_user_id.localeCompare(b.privy_user_id)),
    );

    // Mixed rows.
    const communities = await pool.query(
      "select community_id, created_by_user_id, member_count, logo_ref from public.communities order by slug",
    );
    expect(communities.rows).toEqual([
      {
        community_id: ids.communityX,
        created_by_user_id: sentinelId,
        member_count: 0,
        logo_ref: `logo:media/${ids.logoMedia}`,
      },
      {
        community_id: ids.communityY,
        created_by_user_id: sentinelId,
        member_count: 0,
        logo_ref: null,
      },
    ]);
    const channels = await pool.query(
      "select created_by_user_id from public.community_channels",
    );
    expect(channels.rows).toEqual([{ created_by_user_id: sentinelId }]);
    const media = await pool.query(
      "select media_id, owner_user_id from public.media_objects order by media_id",
    );
    expect(media.rows).toEqual(
      [ids.logoMedia, ids.memeMedia]
        .sort()
        .map((mediaId) => ({ media_id: mediaId, owner_user_id: sentinelId })),
    );
    const meme = await pool.query(
      "select creator_user_id, creator_wallet_id, creator_wallet, idempotency_record_id, image_media_id from public.meme_tokens",
    );
    expect(meme.rows).toEqual([
      {
        creator_user_id: sentinelId,
        creator_wallet_id: null,
        creator_wallet: "0x00000000000000000000000000000000000000a1",
        idempotency_record_id: null,
        image_media_id: ids.memeMedia,
      },
    ]);
    const project = await pool.query(
      "select owner_user_id from public.launch_projects",
    );
    expect(project.rows).toEqual([{ owner_user_id: sentinelId }]);
    const review = await pool.query(
      "select actor_type, actor_user_id, idempotency_record_id from public.launch_review_events order by actor_type",
    );
    expect(review.rows).toEqual([
      {
        actor_type: "applicant",
        actor_user_id: sentinelId,
        idempotency_record_id: null,
      },
      {
        actor_type: "operator",
        actor_user_id: null,
        idempotency_record_id: null,
      },
    ]);
    const accounts = await pool.query(
      "select id, operator_user_id, disabled_by, disabled_at is not null as disabled from public.admin_accounts order by username",
    );
    expect(accounts.rows).toEqual([
      {
        id: ids.auditorAccount,
        operator_user_id: null,
        disabled_by: null,
        disabled: false,
      },
      {
        id: ids.reviewerAccount,
        operator_user_id: sentinelId,
        disabled_by: disabledByDevReset,
        disabled: true,
      },
    ]);
    const roleEvents = await pool.query(
      "select actor_type from public.community_role_events",
    );
    expect(roleEvents.rows).toEqual([{ actor_type: "operator" }]);

    // Guard triggers are back exactly as they were, and still guard.
    expect(await triggerStates()).toEqual(triggers);
    await expect(pool.query("delete from public.ops_audit")).rejects.toThrow(
      /append-only/u,
    );
    await expect(
      pool.query("update public.admin_accounts set operator_user_id = null"),
    ).rejects.toThrow();

    // Second run: nothing left to do, same sentinel.
    const again = await cli(["--yes"]);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("Total rows deleted: 0");
    expect(again.stdout).not.toMatch(/update\s+[1-9]/u);
    expect(again.stdout).toContain(sentinelId);
    expect(await tableCounts()).toEqual(after);
  });
});
