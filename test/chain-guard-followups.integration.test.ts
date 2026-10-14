import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresChainGuardRepository } from "../src/database/chain-guard-repository.js";
import type { ChainGuardRepository } from "../src/features/chain-guard/chain-guard-contract.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";
import { guardAddress, guardPoolId } from "./helpers/chain-guard-fakes.js";

/**
 * Decision 0135 on PostgreSQL (migration 000080), in a throwaway database:
 * the backfill of `resolution = 'auto'` on rows resolved before 000080, the
 * resolution shape constraint, the two policy kinds, the auto resolve
 * marking, and the manual resolve with its admin_audit_log row in one
 * transaction (409 / 404 paths write nothing).
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

describe("Decision 0135 chain guard follow-ups on PostgreSQL", () => {
  const databaseName = `loop_s176_${randomUUID().replaceAll("-", "")}`;
  let url = "";
  let pool: InstanceType<typeof Pool>;
  let repository: ChainGuardRepository;
  let resolvedBefore = "";
  let openBefore = "";

  beforeAll(async () => {
    await admin((client) => client.query(`create database "${databaseName}"`));
    url = connectionUrl(databaseUrl, databaseName);
    const migrate = (count?: number) =>
      runner({
        databaseUrl: url,
        dir: migrationsDirectory,
        direction: "up",
        ...(count === undefined ? {} : { count }),
        migrationsTable: "pgmigrations",
        log: () => undefined,
      });
    // Up to 000079: rows written by the Decision 0134 lane.
    await migrate(79);
    pool = new Pool({ connectionString: url });
    resolvedBefore = randomUUID();
    openBefore = randomUUID();
    await pool.query(
      `insert into public.chain_guard_incidents
         (incident_id, chain_id, kind, subject, details, first_seen_at, last_seen_at, resolved_at)
       values ($1, $3, 'usd1_paused', $4, '{}', $5, $5, $6),
              ($2, $3, 'account_balance_low', $4, '{}', $5, $5, null)`,
      [resolvedBefore, openBefore, chainId, guardAddress(0xa1), at(0), at(10)],
    );
    await migrate();
    repository = createPostgresChainGuardRepository(pool);
  });

  afterAll(async () => {
    await pool.end();
    await admin((client) =>
      client.query(`drop database if exists "${databaseName}" with (force)`),
    );
  });

  it("backfills resolved rows as auto and leaves open rows without a resolution", async () => {
    const rows = await pool.query<{
      incident_id: string;
      resolution: string | null;
    }>(
      `select incident_id::text, resolution from public.chain_guard_incidents
       where incident_id = any($1::uuid[])`,
      [[resolvedBefore, openBefore]],
    );
    expect(
      Object.fromEntries(
        rows.rows.map((row) => [row.incident_id, row.resolution]),
      ),
    ).toEqual({ [resolvedBefore]: "auto", [openBefore]: null });
  });

  it("enforces the resolution shape and accepts the policy kinds", async () => {
    const insert = (values: {
      kind?: string;
      resolved?: Date | null;
      resolution?: string | null;
      by?: string | null;
      note?: string | null;
    }) =>
      pool.query(
        `insert into public.chain_guard_incidents
           (incident_id, chain_id, kind, subject, details, first_seen_at,
            last_seen_at, resolved_at, resolution, resolved_by, resolution_note)
         values ($1, $2, $3, $4, '{}', $5, $5, $6, $7, $8, $9)`,
        [
          randomUUID(),
          chainId,
          values.kind ?? "pool_protocol_fee_policy_high",
          guardPoolId(Math.floor(Math.random() * 1_000_000) + 1),
          at(0),
          values.resolved ?? null,
          values.resolution ?? null,
          values.by ?? null,
          values.note ?? null,
        ],
      );
    await insert({});
    await insert({ kind: "pool_protocol_fee_policy_nonzero" });
    await expect(insert({ resolution: "auto" })).rejects.toThrow(
      /chain_guard_incidents_resolution_shape/u,
    );
    await expect(insert({ resolved: at(1) })).rejects.toThrow(
      /chain_guard_incidents_resolution_shape/u,
    );
    await expect(
      insert({ resolved: at(1), resolution: "manual" }),
    ).rejects.toThrow(/chain_guard_incidents_resolution_shape/u);
    await expect(
      insert({ resolved: at(1), resolution: "auto", note: "x" }),
    ).rejects.toThrow(/chain_guard_incidents_resolution_shape/u);
    await expect(
      insert({ resolved: at(1), resolution: "done" }),
    ).rejects.toThrow();
    await expect(
      insert({ resolved: at(1), resolution: "manual", note: "" }),
    ).rejects.toThrow();
    await insert({ resolved: at(1), resolution: "manual", note: "ok" });
    await insert({
      resolved: at(1),
      resolution: "manual",
      by: randomUUID(),
      note: "ok",
    });
  });

  it("marks the lane's resolutions auto", async () => {
    const opened = await repository.openOrTouch({
      incidentId: randomUUID(),
      chainId,
      kind: "pool_protocol_fee_policy_nonzero",
      subject: guardPoolId(0x5151),
      details: { policyZeroForOnePips: 25 },
      now: at(0),
    });
    expect(opened.incident).toMatchObject({
      resolution: null,
      resolvedBy: null,
      resolutionNote: null,
    });
    const resolved = await repository.resolve({
      chainId,
      kinds: ["pool_protocol_fee_policy_nonzero"],
      keep: [],
      eventsSeenBefore: at(-86_400),
      now: at(60),
    });
    expect(
      resolved.find((row) => row.incidentId === opened.incident.incidentId),
    ).toMatchObject({ resolution: "auto", resolvedAt: at(60).toISOString() });
  });

  it("resolves by hand with an audit row in the same transaction", async () => {
    const accountId = randomUUID();
    const requestId = randomUUID();
    const opened = await repository.openOrTouch({
      incidentId: randomUUID(),
      chainId,
      kind: "usd1_address_frozen",
      subject: guardAddress(0xe5c),
      details: { source: "state" },
      now: at(0),
    });
    const id = opened.incident.incidentId;
    const result = await repository.resolveManually({
      chainId,
      incidentId: id,
      note: "Issuer unfroze after review",
      now: at(30),
      audit: { actor: "alice", actorAccountId: accountId, requestId },
    });
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.incident).toMatchObject({
      incidentId: id,
      resolvedAt: at(30).toISOString(),
      resolution: "manual",
      resolvedBy: accountId,
      resolutionNote: "Issuer unfroze after review",
    });
    const audit = await pool.query<{
      audit_id: string;
      actor: string;
      actor_account_id: string;
      action: string;
      target_type: string;
      target_id: string;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
      request_id: string;
    }>(
      `select audit_id::text, actor, actor_account_id::text, action,
         target_type, target_id, before, after, request_id::text
       from public.admin_audit_log where target_id = $1`,
      [id],
    );
    expect(audit.rows).toEqual([
      {
        audit_id: result.audit.auditId,
        actor: "alice",
        actor_account_id: accountId,
        action: "chain_guard.incident.resolve",
        target_type: "chain_guard_incident",
        target_id: id,
        before: {
          kind: "usd1_address_frozen",
          subject: guardAddress(0xe5c),
          lastSeenAt: at(0).toISOString(),
          resolvedAt: null,
        },
        after: {
          resolvedAt: at(30).toISOString(),
          resolution: "manual",
          note: "Issuer unfroze after review",
        },
        request_id: requestId,
      },
    ]);
    // The hold query no longer sees it.
    expect(await repository.listHolds(chainId)).toEqual([]);

    // Again: 409 path, nothing written.
    const again = await repository.resolveManually({
      chainId,
      incidentId: id,
      note: "twice",
      now: at(40),
      audit: { actor: "alice", actorAccountId: accountId, requestId },
    });
    expect(again.status).toBe("already_resolved");
    // Unknown, or another chain's: 404 path.
    for (const [chain, incidentId] of [
      [chainId, randomUUID()],
      ["eip155:56", id],
    ] as const) {
      expect(
        (
          await repository.resolveManually({
            chainId: chain,
            incidentId,
            note: "x",
            now: at(40),
            audit: { actor: "alice", actorAccountId: null, requestId },
          })
        ).status,
      ).toBe("not_found");
    }
    const count = await pool.query<{ n: number }>(
      `select count(*)::int as n from public.admin_audit_log
       where action = 'chain_guard.incident.resolve'`,
    );
    expect(count.rows[0]?.n).toBe(1);
    // The lane sees the condition again: a new open row.
    const reopened = await repository.openOrTouch({
      incidentId: randomUUID(),
      chainId,
      kind: "usd1_address_frozen",
      subject: guardAddress(0xe5c),
      details: { source: "state" },
      now: at(60),
    });
    expect(reopened.opened).toBe(true);
  });

  it("rolls back the resolve when the audit row cannot be written", async () => {
    const opened = await repository.openOrTouch({
      incidentId: randomUUID(),
      chainId,
      kind: "account_balance_low",
      subject: guardAddress(0xe7),
      details: {},
      now: at(0),
    });
    await expect(
      repository.resolveManually({
        chainId,
        incidentId: opened.incident.incidentId,
        note: "x",
        now: at(10),
        // Not a UUID: admin_audit_log.request_id refuses it.
        audit: { actor: "alice", actorAccountId: null, requestId: "nope" },
      }),
    ).rejects.toThrow();
    const row = await pool.query<{ resolved_at: Date | null }>(
      "select resolved_at from public.chain_guard_incidents where incident_id = $1",
      [opened.incident.incidentId],
    );
    expect(row.rows[0]?.resolved_at).toBeNull();
  });
});
