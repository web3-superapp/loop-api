import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresChainGuardRepository } from "../src/database/chain-guard-repository.js";
import type { ChainGuardRepository } from "../src/features/chain-guard/chain-guard-contract.js";
import { createChainGuardHoldGate } from "../src/features/chain-guard/chain-guard-hold.js";
import { createChainGuardLane } from "../src/features/chain-guard/chain-guard-lane.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";
import {
  createFakeChainGuardChain,
  factory,
  guardAddress,
  guardPoolId,
  usd1,
} from "./helpers/chain-guard-fakes.js";

/**
 * Decision 0134 on PostgreSQL (migration 000079), in a throwaway database:
 * the incident table's shape constraints, one unresolved row per
 * (chain, kind, subject) with `last_seen_at` moving, resolution and
 * re-opening, event expiry, the hold query, the cursor, the watch-set read
 * of `launch2_instances`, and the lane end to end on the real tables.
 */

const { Client, Pool } = pg;
const databaseUrl = requireIntegrationDatabaseUrl();
const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);
const chainId = "eip155:97";
const T0 = new Date("2026-10-14T00:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

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

describe("Decision 0134 chain guard incidents on PostgreSQL", () => {
  const databaseName = `loop_s174_${randomUUID().replaceAll("-", "")}`;
  let pool: InstanceType<typeof Pool>;
  let repository: ChainGuardRepository;

  beforeAll(async () => {
    await admin((client) => client.query(`create database "${databaseName}"`));
    const url = connectionUrl(databaseUrl, databaseName);
    await runner({
      databaseUrl: url,
      dir: migrationsDirectory,
      direction: "up",
      migrationsTable: "pgmigrations",
      log: () => undefined,
    });
    pool = new Pool({ connectionString: url });
    repository = createPostgresChainGuardRepository(pool);
  });

  afterAll(async () => {
    await pool.end();
    await admin((client) =>
      client.query(`drop database if exists "${databaseName}" with (force)`),
    );
  });

  it("keeps one unresolved row per (chain, kind, subject) and moves last_seen", async () => {
    const subject = guardAddress(0xe5c);
    const first = await repository.openOrTouch({
      incidentId: randomUUID(),
      chainId,
      kind: "usd1_address_frozen",
      subject,
      details: { source: "event", labels: ["instance:x:escrow"] },
      now: at(0),
    });
    expect(first.opened).toBe(true);
    const again = await repository.openOrTouch({
      incidentId: randomUUID(),
      chainId,
      kind: "usd1_address_frozen",
      subject,
      details: { source: "state", labels: ["instance:x:escrow"] },
      now: at(60),
    });
    expect(again.opened).toBe(false);
    expect(again.incident).toMatchObject({
      incidentId: first.incident.incidentId,
      firstSeenAt: at(0).toISOString(),
      lastSeenAt: at(60).toISOString(),
      details: { source: "state", labels: ["instance:x:escrow"] },
      resolvedAt: null,
    });
    // An older sighting never moves last_seen backwards.
    const late = await repository.openOrTouch({
      incidentId: randomUUID(),
      chainId,
      kind: "usd1_address_frozen",
      subject,
      details: { source: "state" },
      now: at(30),
    });
    expect(late.incident.lastSeenAt).toBe(at(60).toISOString());
    // Same subject, other kind / chain: separate rows.
    expect(
      (
        await repository.openOrTouch({
          incidentId: randomUUID(),
          chainId,
          kind: "account_balance_low",
          subject,
          details: {},
          now: at(60),
        })
      ).opened,
    ).toBe(true);
    expect(
      (
        await repository.openOrTouch({
          incidentId: randomUUID(),
          chainId: "eip155:56",
          kind: "usd1_address_frozen",
          subject,
          details: {},
          now: at(60),
        })
      ).opened,
    ).toBe(true);

    const holds = await createChainGuardHoldGate(repository, chainId).holds();
    expect(holds.map((row) => row.incidentId)).toEqual([
      first.incident.incidentId,
    ]);

    // The condition clears: resolved; kinds outside `kinds` are untouched.
    const resolved = await repository.resolve({
      chainId,
      kinds: ["usd1_address_frozen", "usd1_paused"],
      keep: [],
      eventsSeenBefore: at(-86_400),
      now: at(120),
    });
    expect(resolved.map((row) => row.incidentId)).toEqual([
      first.incident.incidentId,
    ]);
    expect(resolved[0]?.resolvedAt).toBe(at(120).toISOString());
    expect(await createChainGuardHoldGate(repository, chainId).holds()).toEqual(
      [],
    );
    // Seen again later: a new row; the old one stays resolved.
    const reopened = await repository.openOrTouch({
      incidentId: randomUUID(),
      chainId,
      kind: "usd1_address_frozen",
      subject,
      details: {},
      now: at(180),
    });
    expect(reopened.opened).toBe(true);
    expect(reopened.incident.incidentId).not.toBe(first.incident.incidentId);
    const rows = await pool.query<{ count: string }>(
      `select count(*)::text as count from public.chain_guard_incidents
       where chain_id = $1 and kind = 'usd1_address_frozen'`,
      [chainId],
    );
    expect(rows.rows[0]?.count).toBe("2");

    // `keep` protects a still-present condition.
    expect(
      await repository.resolve({
        chainId,
        kinds: ["usd1_address_frozen"],
        keep: [`usd1_address_frozen|${subject}`],
        eventsSeenBefore: at(-86_400),
        now: at(240),
      }),
    ).toEqual([]);
  });

  it("expires event incidents by last sighting only", async () => {
    const subject = guardAddress(0x3333);
    await repository.openOrTouch({
      incidentId: randomUUID(),
      chainId,
      kind: "usd1_upgraded",
      subject,
      details: { source: "event" },
      now: at(0),
    });
    const kinds = ["usd1_upgraded"] as const;
    expect(
      await repository.resolve({
        chainId,
        kinds,
        keep: [],
        eventsSeenBefore: at(0),
        now: at(10),
      }),
    ).toEqual([]);
    const expired = await repository.resolve({
      chainId,
      kinds,
      keep: [],
      eventsSeenBefore: at(1),
      now: at(86_401),
    });
    expect(expired.map((row) => row.subject)).toEqual([subject]);
  });

  it("refuses malformed rows and a second open row", async () => {
    const insert = (values: {
      kind?: string;
      subject?: string;
      details?: string;
      chain?: string;
      first?: Date;
      last?: Date;
      resolved?: Date | null;
    }) =>
      pool.query(
        `insert into public.chain_guard_incidents
           (incident_id, chain_id, kind, subject, details, first_seen_at, last_seen_at, resolved_at)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
        [
          randomUUID(),
          values.chain ?? chainId,
          values.kind ?? "usd1_paused",
          values.subject ?? guardAddress(0xa1),
          values.details ?? "{}",
          values.first ?? at(0),
          values.last ?? at(0),
          values.resolved ?? null,
        ],
      );
    await expect(insert({ kind: "made_up" })).rejects.toThrow();
    await expect(insert({ subject: "0xABC" })).rejects.toThrow();
    await expect(
      insert({ subject: guardAddress(0xa1).toUpperCase().replace("0X", "0x") }),
    ).rejects.toThrow();
    await expect(insert({ details: "[]" })).rejects.toThrow();
    await expect(insert({ chain: "eip155:1" })).rejects.toThrow();
    await expect(insert({ first: at(10), last: at(0) })).rejects.toThrow();
    await expect(insert({ resolved: at(-1) })).rejects.toThrow();
    await insert({ subject: guardPoolId(0x77) });
    await expect(insert({ subject: guardPoolId(0x77) })).rejects.toThrow(
      /chain_guard_incidents_open_key/u,
    );
    // A resolved row does not block a new open one.
    await insert({ subject: guardPoolId(0x78), resolved: at(5), last: at(5) });
    await insert({ subject: guardPoolId(0x78) });
  });

  it("stores the cursor monotonically and reads the watch set", async () => {
    expect(await repository.getCursor(chainId)).toBeNull();
    await repository.setCursor({ chainId, blockNumber: 1_000n, now: at(0) });
    await repository.setCursor({ chainId, blockNumber: 900n, now: at(1) });
    expect(await repository.getCursor(chainId)).toBe(1_000n);
    await repository.setCursor({ chainId, blockNumber: 1_500n, now: at(2) });
    expect(await repository.getCursor(chainId)).toBe(1_500n);
    // No launch2 instance registered in this database: an empty watch set
    // (the query and its column names are checked by PostgreSQL).
    expect(await repository.listWatchInstances(chainId)).toEqual([]);
  });

  it("runs the lane end to end on the real tables", async () => {
    const chainGuardChain = "eip155:56";
    const chain = createFakeChainGuardChain({ chainId: 56, paused: true });
    let clock = at(1_000);
    const lane = createChainGuardLane({
      repository,
      chain,
      targets: {
        chainId: chainGuardChain,
        chainReference: 56,
        usd1Address: usd1,
        factories: [factory],
        poolManagerAddress: null,
        poolRouterAddress: null,
        watch: [],
        balanceAccounts: [],
      },
      policy: {
        expectedImplementation: guardAddress(0x1111),
        expectedProtocolFeeController: null,
        protocolFeeAlertPips: 500,
        minBnbWei: 5n * 10n ** 16n,
      },
      confirmations: 15,
      intervalSeconds: 60,
      now: () => clock,
    });
    // Leftovers of the first test on this chain id are resolved by the lane
    // (frozen() reads false for them now).
    await lane.runOnce();
    let open = await repository.listUnresolved({
      chainId: chainGuardChain,
      limit: 50,
    });
    expect(open.map((row) => row.kind)).toEqual(["usd1_paused"]);
    expect(
      await createChainGuardHoldGate(repository, chainGuardChain).holds(),
    ).toHaveLength(1);
    expect(await repository.getCursor(chainGuardChain)).toBe(10_000n - 15n);

    chain.state.paused = false;
    clock = at(1_060);
    await lane.runOnce();
    open = await repository.listUnresolved({
      chainId: chainGuardChain,
      limit: 50,
    });
    expect(open).toEqual([]);
  });
});
