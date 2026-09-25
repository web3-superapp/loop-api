import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresLaunchRepository } from "../src/database/launch-repository.js";
import { launchCommandDigest } from "../src/features/launch/launch-contract.js";
import type { LaunchRepository } from "../src/features/launch/launch-repository.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

const { Client, Pool } = pg;

const databaseUrl = requireIntegrationDatabaseUrl();
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);
const contractAddress = "0x1111111111111111111111111111111111111111";

function databaseConnectionUrl(source: string, databaseName: string): string {
  const url = new URL(source);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function migrate(
  targetDatabaseUrl: string,
  direction: "up" | "down",
  count?: number,
): Promise<void> {
  await runner({
    databaseUrl: targetDatabaseUrl,
    dir: migrationsDirectory,
    direction,
    migrationsTable: "pgmigrations",
    log: () => undefined,
    ...(count === undefined ? {} : { count }),
  });
}

describe("PostgreSQL Launch contract registry (migration 000041, Decision 0076)", () => {
  const databaseName = `loop_s83a_${randomUUID().replaceAll("-", "")}`;
  let temporaryDatabaseUrl: string;
  let pool: InstanceType<typeof Pool>;
  let launch: LaunchRepository;

  async function approvedLaunch(ticker: string): Promise<{
    readonly launchId: string;
    readonly ownerUserId: string;
  }> {
    const user = await pool.query<{ id: string }>({
      text: "insert into public.loop_users (privy_user_id) values ($1) returning id",
      values: [`did:privy:${randomUUID()}`],
    });
    const ownerUserId = user.rows[0]?.id as string;
    const created = await launch.createProject({
      ownerUserId,
      idempotencyKey: randomUUID(),
      requestSha256: launchCommandDigest("createProject", [ticker]),
      requestId: randomUUID(),
      values: {
        name: `Project ${ticker}`,
        ticker,
        narrative: null,
        officialLinks: {
          website: null,
          x: null,
          telegram: null,
          discord: null,
        },
      },
    });
    await launch.submitProject({
      ownerUserId,
      projectId: created.projectId,
      idempotencyKey: randomUUID(),
      requestSha256: launchCommandDigest("submitProject", [created.projectId]),
      requestId: randomUUID(),
    });
    const approved = await launch.reviewProject({
      projectId: created.projectId,
      decision: "approve",
      reasonCode: "operator_manual_review",
      requestId: randomUUID(),
    });
    return {
      launchId: approved.launch?.launchId as string,
      ownerUserId,
    };
  }

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
    await migrate(temporaryDatabaseUrl, "up");
    pool = new Pool({ connectionString: temporaryDatabaseUrl });
    launch = createPostgresLaunchRepository(pool);
  });

  afterAll(async () => {
    await pool.end();
    const admin = new Client({
      connectionString: databaseConnectionUrl(databaseUrl, "postgres"),
    });
    await admin.connect();
    try {
      await admin.query(
        `drop database if exists "${databaseName}" with (force)`,
      );
    } finally {
      await admin.end();
    }
  });

  it("creates a launch with every axis unavailable and an empty registry", async () => {
    const { launchId } = await approvedLaunch("UNAV");
    const detail = await launch.getLaunch(launchId);
    expect(detail?.launch).toMatchObject({
      contractAddress: null,
      saleId: null,
      contractVersion: null,
      configVersionOnchain: null,
    });
    const row = await pool.query({
      text: `select sale_state, entitlement_state, liquidity_state, operational_state
             from public.launches where launch_id = $1`,
      values: [launchId],
    });
    expect(row.rows[0]).toEqual({
      sale_state: "unavailable",
      entitlement_state: "unavailable",
      liquidity_state: "unavailable",
      operational_state: "unavailable",
    });
  });

  it("admits every 06 §2 axis value and still admits unavailable", async () => {
    const { launchId } = await approvedLaunch("AXES");
    const tuples = [
      ["SCHEDULED", "NONE", "NOT_STARTED", "ACTIVE"],
      ["LIVE", "NONE", "NOT_STARTED", "PAUSED"],
      ["ENDED", "NONE", "NOT_STARTED", "ACTIVE"],
      ["SUCCEEDED", "FROZEN", "PREPARING", "ACTIVE"],
      ["SUCCEEDED", "VESTING", "V3_LIVE", "ACTIVE"],
      ["SUCCEEDED", "COMPLETED", "LP_LOCKED", "ACTIVE"],
      ["SUCCEEDED", "VESTING", "COMPLETED", "ACTIVE"],
      ["SUCCEEDED", "FROZEN", "RETRY_SCHEDULED", "ACTIVE"],
      ["FAILED", "REFUNDING", "NOT_STARTED", "ACTIVE"],
      ["CANCELLED", "REFUNDED", "NOT_STARTED", "ACTIVE"],
      ["unavailable", "unavailable", "unavailable", "unavailable"],
    ] as const;
    for (const [sale, entitlement, liquidity, operational] of tuples) {
      await pool.query({
        text: `update public.launches
               set sale_state = $2, entitlement_state = $3,
                   liquidity_state = $4, operational_state = $5
               where launch_id = $1`,
        values: [launchId, sale, entitlement, liquidity, operational],
      });
    }
    for (const [column, value] of [
      ["sale_state", "ACTIVE"],
      ["sale_state", "live"],
      ["entitlement_state", "CLAIMABLE"],
      ["liquidity_state", "GRADUATED"],
      ["operational_state", "LIVE"],
    ] as const) {
      await expect(
        pool.query({
          text: `update public.launches set ${column} = $2 where launch_id = $1`,
          values: [launchId, value],
        }),
        `${column}=${value}`,
      ).rejects.toThrow(/launches_axes_unavailable_check/);
    }
  });

  it("registers a sale only with its contract and version, once per contract", async () => {
    const first = await approvedLaunch("SALE");
    await expect(
      pool.query({
        text: "update public.launches set sale_id = 7 where launch_id = $1",
        values: [first.launchId],
      }),
    ).rejects.toThrow(/launches_sale_registry_check/);
    await expect(
      pool.query({
        text: `update public.launches
               set sale_id = 0, contract_address = $2, contract_version = '1.0.0'
               where launch_id = $1`,
        values: [first.launchId, contractAddress],
      }),
    ).rejects.toThrow(/launches_sale_id_check/);
    await expect(
      pool.query({
        text: `update public.launches
               set sale_id = 7, contract_address = $2, contract_version = 'v1'
               where launch_id = $1`,
        values: [first.launchId, contractAddress],
      }),
    ).rejects.toThrow(/launches_contract_version_check/);
    await expect(
      pool.query({
        text: `update public.launches set config_version_onchain = 'abc'
               where launch_id = $1`,
        values: [first.launchId],
      }),
    ).rejects.toThrow(/launches_config_version_onchain_check/);
    const configVersion = `0x${"ab".repeat(32)}`;
    await pool.query({
      text: `update public.launches
             set sale_id = 9223372036854775807, contract_address = $2,
                 contract_version = '1.0.0', config_version_onchain = $3
             where launch_id = $1`,
      values: [first.launchId, contractAddress, configVersion],
    });
    const detail = await launch.getLaunch(first.launchId);
    expect(detail?.launch).toMatchObject({
      contractAddress,
      saleId: "9223372036854775807",
      contractVersion: "1.0.0",
      configVersionOnchain: configVersion,
    });
    const catalog = await launch.listLaunches();
    expect(
      catalog.find((row) => row.launch.launchId === first.launchId)?.launch
        .saleId,
    ).toBe("9223372036854775807");

    const second = await approvedLaunch("SALB");
    await expect(
      pool.query({
        text: `update public.launches
               set sale_id = 9223372036854775807, contract_address = $2,
                   contract_version = '1.0.0'
               where launch_id = $1`,
        values: [second.launchId, contractAddress],
      }),
    ).rejects.toThrow(/launches_sale_unique_idx/);
  });

  it("admits launch_intent_v1 idempotency records", async () => {
    const { ownerUserId } = await approvedLaunch("IDEM");
    await pool.query({
      text: `insert into public.idempotency_records
               (owner_user_id, scope, idempotency_key, key_source, request_sha256, digest_version)
             values ($1, 'v2_launch_intent', $2, 'client', $3, 'launch_intent_v1')`,
      values: [ownerUserId, randomUUID(), "a".repeat(64)],
    });
    await expect(
      pool.query({
        text: `insert into public.idempotency_records
                 (owner_user_id, scope, idempotency_key, key_source, request_sha256, digest_version)
               values ($1, 'v2_launch_intent', $2, 'client', $3, 'launch_intent_v9')`,
        values: [ownerUserId, randomUUID(), "b".repeat(64)],
      }),
    ).rejects.toThrow(/idempotency_records_digest_version_check/);
  });

  it("refuses to roll back while chain facts exist, then rolls back cleanly", async () => {
    // 000042 (Decision 0077) sits on top and holds no lane facts here.
    await migrate(temporaryDatabaseUrl, "down", 1);
    await expect(migrate(temporaryDatabaseUrl, "down", 1)).rejects.toThrow(
      /refusing to roll back 000041/,
    );
    await pool.query(`
      update public.launches
      set sale_state = 'unavailable', entitlement_state = 'unavailable',
          liquidity_state = 'unavailable', operational_state = 'unavailable',
          sale_id = null, contract_version = null, config_version_onchain = null,
          contract_address = null
    `);
    await expect(migrate(temporaryDatabaseUrl, "down", 1)).rejects.toThrow(
      /launch_intent_v1 records exist/,
    );
    await pool.query(
      "delete from public.idempotency_records where digest_version = 'launch_intent_v1'",
    );
    await migrate(temporaryDatabaseUrl, "down", 1);
    const columns = await pool.query({
      text: `select column_name from information_schema.columns
             where table_schema = 'public' and table_name = 'launches'
               and column_name in ('sale_id', 'contract_version', 'config_version_onchain')`,
    });
    expect(columns.rows).toEqual([]);
    const { launchId } = await pool
      .query<{ launch_id: string }>(
        "select launch_id from public.launches limit 1",
      )
      .then((result) => ({ launchId: result.rows[0]?.launch_id }));
    await expect(
      pool.query({
        text: "update public.launches set sale_state = 'LIVE' where launch_id = $1",
        values: [launchId],
      }),
    ).rejects.toThrow(/launches_axes_unavailable_check/);
    // And forward again, so the append-only chain replays.
    await migrate(temporaryDatabaseUrl, "up");
  });
});
