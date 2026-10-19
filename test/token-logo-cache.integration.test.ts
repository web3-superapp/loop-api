import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createPostgresMarketFactCacheRepository } from "../src/database/market-fact-cache-repository.js";
import { randomUUID } from "node:crypto";

import {
  createPostgresTokenLogoCacheRepository,
  tokenLogoNeverExpires,
  type TokenLogoCacheAutomaticRecord,
} from "../src/database/token-logo-cache-repository.js";
import { tokenLogoEtag } from "../src/features/market/token-logo-proxy.js";
import { createTokenLogoProxyService } from "../src/features/market/token-logo-proxy.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";
import {
  dexscreenerWbnb,
  logoPng,
  png,
  trustWalletWbnb,
  upstreamFetch,
  wbnb,
} from "./token-logo-fakes.js";

/**
 * Decision 0089: migration 000045 (`token_logo_cache`) against PostgreSQL,
 * the repository round trip, and the proxy over real storage.
 */

const { Pool } = pg;
const pool = new Pool({ connectionString: requireIntegrationDatabaseUrl() });
const repository = createPostgresTokenLogoCacheRepository(pool);
const facts = createPostgresMarketFactCacheRepository(pool);
const chainId = "eip155:56";
const other = "0x00000000000000000000000000000000000000ff";

function found(
  overrides: Partial<TokenLogoCacheAutomaticRecord> = {},
): TokenLogoCacheAutomaticRecord {
  const bytes = png(300);
  return {
    chainId,
    address: other,
    status: "found",
    bytes,
    contentType: "image/png",
    etag: '"abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"',
    source: "trustwallet",
    sourceUrl: trustWalletWbnb,
    candidateUrl: trustWalletWbnb,
    fetchedAt: "2026-09-28T08:00:00.000Z",
    expiresAt: "2026-10-05T08:00:00.000Z",
    ...overrides,
  };
}

async function clean(): Promise<void> {
  await pool.query(
    `delete from public.token_logo_cache where address in ($1, $2, 'native')`,
    [wbnb, other],
  );
  await pool.query(
    `delete from public.market_fact_cache where subject_key in ($1, $2)`,
    [`token:${wbnb}`, `tokenbatch:${wbnb}`],
  );
}

const audit = () => ({
  actor: "platform-admin-s238",
  actorAccountId: null,
  requestId: randomUUID(),
});

describe("token_logo_cache (Decision 0089, migration 000045)", () => {
  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await pool.end();
  });

  it("is created by migration 000045 with its primary key", async () => {
    const migration = await pool.query<{ name: string }>(
      "select name from public.pgmigrations where name = '000045_v2_token_logo_cache'",
    );
    expect(migration.rows[0]?.name).toBe("000045_v2_token_logo_cache");
    const key = await pool.query<{ column_name: string }>(`
      select a.attname as column_name
      from pg_index i
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = 'public.token_logo_cache'::regclass and i.indisprimary
      order by a.attnum
    `);
    expect(key.rows.map((row) => row.column_name)).toEqual([
      "chain_id",
      "address",
    ]);
  });

  it("round-trips bytes exactly and upserts on (chain, address)", async () => {
    const first = found();
    await repository.put(first);
    const read = await repository.get(chainId, other);
    expect(read).toEqual(first);
    expect(read?.bytes?.equals(first.bytes as Buffer)).toBe(true);

    await repository.put({
      ...first,
      status: "missing",
      bytes: null,
      contentType: null,
      etag: null,
      source: null,
      sourceUrl: null,
      expiresAt: "2026-09-29T08:00:00.000Z",
    });
    expect(await repository.get(chainId, other)).toMatchObject({
      status: "missing",
      bytes: null,
    });
    const rows = await pool.query<{ n: number }>(
      "select count(*)::int as n from public.token_logo_cache where address = $1",
      [other],
    );
    expect(rows.rows[0]?.n).toBe(1);
    expect(await repository.get(chainId, wbnb)).toBeNull();
  });

  it("refuses rows the proxy must never write", async () => {
    for (const [label, record] of [
      ["over 256 KiB", found({ bytes: png(256 * 1024 + 1) })],
      ["svg type", found({ contentType: "image/svg+xml" as "image/png" })],
      ["found without bytes", found({ bytes: null })],
      ["missing with bytes", found({ status: "missing" })],
      [
        "oversize with bytes",
        found({ status: "oversize", contentType: null, etag: null }),
      ],
      [
        "checksummed address",
        found({ address: other.toUpperCase().replace("0X", "0x") }),
      ],
      ["unknown address form", found({ address: "WBNB" })],
      [
        "http upstream",
        found({ sourceUrl: "http://raw.githubusercontent.com/x.png" }),
      ],
      ["expiry before fetch", found({ expiresAt: "2026-09-28T07:00:00.000Z" })],
      ["bad chain", found({ chainId: "bsc" })],
    ] as const) {
      await expect(repository.put(record), label).rejects.toThrow(
        /token_logo_cache/,
      );
    }
    const oversize: TokenLogoCacheAutomaticRecord = {
      ...found(),
      status: "oversize",
      bytes: null,
      contentType: null,
      etag: null,
    };
    await repository.put(oversize);
    expect(await repository.get(chainId, other)).toMatchObject({
      status: "oversize",
    });
  });

  it("serves the proxy from Postgres: the Provider image cached with the pair fact first, one fetch, then hits", async () => {
    await facts.put({
      subjectKey: `token:${wbnb}`,
      factKind: "token_pairs",
      source: "dexscreener",
      value: {
        tokenAddress: wbnb,
        pairs: [
          {
            pairAddress: "0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae",
            baseTokenAddress: wbnb,
            liquidityUsd: "1",
            imageUrl: dexscreenerWbnb,
          },
        ],
      },
      rawDigest: "a".repeat(64),
      fetchedAt: "2026-09-28T08:00:00.000Z",
      ttlSeconds: 30,
    });
    const bytes = await logoPng({ width: 300, height: 300 });
    const fetch = upstreamFetch({
      [dexscreenerWbnb]: { kind: "body", body: bytes },
    });
    const proxy = createTokenLogoProxyService({
      cache: repository,
      facts,
      fetch,
      now: () => new Date("2026-09-28T09:00:00.000Z"),
      upstreamTimeoutMs: 1_000,
    });
    const first = await proxy.resolve({ chainId, address: wbnb });
    const second = await proxy.resolve({ chainId, address: wbnb });
    expect(first).toMatchObject({ kind: "image" });
    expect(second).toEqual(first);
    expect(fetch.calls).toEqual([dexscreenerWbnb]);
    expect(await repository.get(chainId, wbnb)).toMatchObject({
      status: "found",
      source: "dexscreener",
      contentType: "image/webp",
      sourceUrl: dexscreenerWbnb,
      candidateUrl: dexscreenerWbnb,
      expiresAt: "2026-10-05T09:00:00.000Z",
    });
  });

  it("stores 'no picture' for 24 h and nothing on a timeout", async () => {
    const missing = createTokenLogoProxyService({
      cache: repository,
      facts,
      fetch: upstreamFetch({}),
      now: () => new Date("2026-09-28T09:00:00.000Z"),
    });
    expect(await missing.resolve({ chainId, address: null })).toEqual({
      kind: "missing",
    });
    expect(await repository.get(chainId, "native")).toMatchObject({
      status: "missing",
      expiresAt: "2026-09-29T09:00:00.000Z",
    });

    const timeout = createTokenLogoProxyService({
      cache: repository,
      facts,
      fetch: upstreamFetch({ [trustWalletWbnb]: { kind: "hang" } }),
      upstreamTimeoutMs: 20,
    });
    expect(await timeout.resolve({ chainId, address: wbnb })).toEqual({
      kind: "unreachable",
    });
    expect(await repository.get(chainId, wbnb)).toBeNull();
  });

  it("is migrated by 000092: manual source allowed, candidate_url nullable only for manual rows", async () => {
    const migration = await pool.query<{ name: string }>(
      "select name from public.pgmigrations where name = '000092_token_logo_normalized_manual'",
    );
    expect(migration.rows[0]?.name).toBe("000092_token_logo_normalized_manual");
    const bytes = await logoPng();
    const insert = (values: {
      source: string | null;
      candidate: string | null;
      sourceUrl: string | null;
      status?: string;
    }) =>
      pool.query(
        `insert into public.token_logo_cache (
           chain_id, address, status, bytes, content_type, etag, source,
           source_url, candidate_url, fetched_at, expires_at
         ) values ('eip155:56', $1, $2, $3, 'image/webp', $4, $5, $6, $7,
           '2026-10-19T00:00:00Z', '9999-12-31T23:59:59.999Z')`,
        [
          other,
          values.status ?? "found",
          bytes,
          tokenLogoEtag(bytes),
          values.source,
          values.sourceUrl,
          values.candidate,
        ],
      );
    await expect(
      insert({
        source: "trustwallet",
        candidate: null,
        sourceUrl: trustWalletWbnb,
      }),
    ).rejects.toThrow(/token_logo_cache_candidate_check/);
    await expect(
      insert({ source: "manual", candidate: trustWalletWbnb, sourceUrl: null }),
    ).rejects.toThrow(/token_logo_cache_candidate_check/);
    await expect(
      insert({
        source: "other",
        candidate: trustWalletWbnb,
        sourceUrl: trustWalletWbnb,
      }),
    ).rejects.toThrow(/token_logo_cache_source_check/);
    await insert({ source: "manual", candidate: null, sourceUrl: null });
    expect(await repository.get(chainId, other)).toMatchObject({
      source: "manual",
      candidateUrl: null,
      sourceUrl: null,
      expiresAt: tokenLogoNeverExpires,
    });
  });

  it("stores a manual picture with its audit row, keeps it against automatic writes, and clears it", async () => {
    await repository.put(found({ address: wbnb }));
    const bytes = await logoPng({ red: 30 });
    const requestAudit = audit();
    const written = await repository.putManual?.(
      {
        chainId,
        address: wbnb,
        bytes,
        contentType: "image/webp",
        etag: tokenLogoEtag(bytes),
        at: "2026-10-19T08:00:00.000Z",
      },
      requestAudit,
    );
    expect(written?.before).toMatchObject({ source: "trustwallet" });
    expect(written?.record).toMatchObject({
      status: "found",
      source: "manual",
      sourceUrl: null,
      candidateUrl: null,
      fetchedAt: "2026-10-19T08:00:00.000Z",
      expiresAt: tokenLogoNeverExpires,
    });
    const auditRow = await pool.query<{
      action: string;
      target_type: string;
      target_id: string;
      before: { source: string; byteLength: number };
      after: { source: string; etag: string; byteLength: number };
    }>(
      `select action, target_type, target_id, before, after
       from public.admin_audit_log where audit_id = $1`,
      [written?.audit.auditId],
    );
    expect(auditRow.rows[0]).toMatchObject({
      action: "market.logo.override",
      target_type: "token_logo",
      target_id: `${chainId}/${wbnb}`,
      before: { source: "trustwallet", byteLength: 300 },
      after: {
        source: "manual",
        etag: tokenLogoEtag(bytes),
        byteLength: bytes.length,
      },
    });

    // An automatic refetch racing the upload never replaces it.
    await repository.put(
      found({
        address: wbnb,
        fetchedAt: "2026-10-20T00:00:00.000Z",
        expiresAt: "2026-10-27T00:00:00.000Z",
      }),
    );
    await repository.put({
      ...found({ address: wbnb }),
      status: "missing",
      bytes: null,
      contentType: null,
      etag: null,
      source: null,
      sourceUrl: null,
    });
    const kept = await repository.get(chainId, wbnb);
    expect(kept?.source).toBe("manual");
    expect(kept?.bytes?.equals(bytes)).toBe(true);

    // The proxy serves it and never asks an upstream, even years later.
    const fetch = upstreamFetch({
      [trustWalletWbnb]: { kind: "body", body: await logoPng() },
    });
    const proxy = createTokenLogoProxyService({
      cache: repository,
      facts,
      fetch,
      now: () => new Date("2030-01-01T00:00:00.000Z"),
    });
    expect(await proxy.resolve({ chainId, address: wbnb })).toMatchObject({
      kind: "image",
      etag: tokenLogoEtag(bytes),
    });
    expect(await proxy.warm({ chainId, address: wbnb })).toBe("manual");
    expect(fetch.calls).toEqual([]);

    const states = await repository.listStates?.(chainId, [wbnb, other]);
    expect(states?.get(wbnb)).toMatchObject({ source: "manual", bytes: null });
    expect(states?.has(other)).toBe(false);

    const cleared = await repository.clearManual?.(chainId, wbnb, audit());
    expect(cleared?.before.source).toBe("manual");
    expect(await repository.get(chainId, wbnb)).toBeNull();
    expect(await repository.clearManual?.(chainId, wbnb, audit())).toBeNull();
    const clearAudit = await pool.query<{ action: string; after: unknown }>(
      `select action, after from public.admin_audit_log where audit_id = $1`,
      [cleared?.audit.auditId],
    );
    expect(clearAudit.rows[0]).toEqual({
      action: "market.logo.override_clear",
      after: null,
    });
  });
});
