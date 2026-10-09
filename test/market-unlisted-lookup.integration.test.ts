import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createPostgresControlPlaneRepository,
  type ControlPlaneRepository,
} from "../src/database/control-plane-repository.js";
import {
  createPostgresMarketFactCacheRepository,
  type MarketFactCacheRepository,
} from "../src/database/market-fact-cache-repository.js";
import { unlistedTokenLookupPolicy } from "../src/features/market/market-contract.js";
import { marketFactKinds } from "../src/features/market/market-fact-service.js";
import { providerImageUrlFromPairs } from "../src/features/market/token-logo.js";
import type { TokenPairSnapshot } from "../src/integrations/market/market-data-provider.js";
import {
  createUnlistedTokenLookupQuota,
  UnlistedTokenLookupRateLimitedError,
  type UnlistedTokenLookupQuota,
} from "../src/features/market/unlisted-token-lookup-quota.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0058 persistence: the unregistered-address lookup consumes the
 * Decision 0024 issuance-quota buckets in PostgreSQL, and its identity and
 * market snapshots live in `market_fact_cache` under their own fact kinds
 * and TTLs. No migration is added; this proves the existing tables accept
 * both.
 */

const { Pool } = pg;
const databaseUrl = requireIntegrationDatabaseUrl();
const pool = new Pool({ connectionString: databaseUrl });
const weth = "0x2170ed0880ac9a755fd29b2688956bd959f933f8";
const secret = new TextEncoder().encode(
  "integration-unlisted-lookup-secret-0123456789abcdef",
);

let controlPlane: ControlPlaneRepository;
let facts: MarketFactCacheRepository;
let quota: UnlistedTokenLookupQuota;

async function cleanFixtures(): Promise<void> {
  await pool.query({
    text: `delete from public.issuance_rate_records where capability = $1`,
    values: [unlistedTokenLookupPolicy.capability],
  });
  await pool.query({
    text: `delete from public.market_fact_cache where subject_key = $1`,
    values: [`token:${weth}`],
  });
}

beforeAll(async () => {
  controlPlane = createPostgresControlPlaneRepository(pool);
  facts = createPostgresMarketFactCacheRepository(pool);
  quota = createUnlistedTokenLookupQuota({
    repository: controlPlane,
    hmacSecret: secret,
  });
  await cleanFixtures();
});

beforeEach(async () => {
  await cleanFixtures();
});

afterAll(async () => {
  await cleanFixtures();
  await pool.end();
});

describe("unlisted token lookup persistence (Decision 0058)", () => {
  it("counts lookups per user-minute, per ip-minute, and per user-day in issuance_rate_records", async () => {
    const userId = randomUUID();
    const signal = new AbortController().signal;
    await quota.consume({ userId, canonicalClientIp: "203.0.113.7", signal });
    await quota.consume({ userId, canonicalClientIp: "203.0.113.7", signal });

    const rows = await pool.query<{
      subject_kind: string;
      issued_count: number;
      capacity: number;
      window_duration_seconds: number;
      policy_version: string;
    }>({
      text: `
        select subject_kind, issued_count, capacity, window_duration_seconds, policy_version
        from public.issuance_rate_records
        where capability = $1
        order by subject_kind
      `,
      values: [unlistedTokenLookupPolicy.capability],
    });
    expect(rows.rows).toEqual([
      {
        subject_kind: "ip_minute",
        issued_count: 2,
        capacity: unlistedTokenLookupPolicy.ipMinuteCapacity,
        window_duration_seconds: 60,
        policy_version: unlistedTokenLookupPolicy.policyVersion,
      },
      {
        subject_kind: "user_day",
        issued_count: 2,
        capacity: unlistedTokenLookupPolicy.userDayCapacity,
        window_duration_seconds: 86_400,
        policy_version: unlistedTokenLookupPolicy.policyVersion,
      },
      {
        subject_kind: "user_minute",
        issued_count: 2,
        capacity: unlistedTokenLookupPolicy.userMinuteCapacity,
        window_duration_seconds: 60,
        policy_version: unlistedTokenLookupPolicy.policyVersion,
      },
    ]);
    // Neither the user ID nor the IP is stored: only HMAC subjects.
    const subjects = await pool.query<{ subject_hmac: string }>({
      text: `select subject_hmac from public.issuance_rate_records where capability = $1`,
      values: [unlistedTokenLookupPolicy.capability],
    });
    for (const row of subjects.rows) {
      expect(row.subject_hmac).toMatch(/^[0-9a-f]{64}$/);
      expect(row.subject_hmac).not.toContain(userId);
    }
  });

  it("rejects the request that exceeds the per-user-minute capacity", async () => {
    const userId = randomUUID();
    const signal = new AbortController().signal;
    for (
      let index = 0;
      index < unlistedTokenLookupPolicy.userMinuteCapacity;
      index += 1
    ) {
      await quota.consume({
        userId,
        canonicalClientIp: `203.0.113.${String(10 + (index % 5))}`,
        signal,
      });
    }
    await expect(
      quota.consume({ userId, canonicalClientIp: "203.0.113.99", signal }),
    ).rejects.toBeInstanceOf(UnlistedTokenLookupRateLimitedError);
    // Another user on the same IP is still admitted (IP window is wider).
    await expect(
      quota.consume({
        userId: randomUUID(),
        canonicalClientIp: "203.0.113.99",
        signal,
      }),
    ).resolves.toBeUndefined();
  });

  it("round-trips a pair's gated imageUrl through the jsonb cache row, and reads a pre-0072 row as carrying no image (Decision 0072)", async () => {
    const fetchedAt = new Date().toISOString();
    const image = `https://dd.dexscreener.com/ds-data/tokens/bsc/${weth}.png`;
    const pair = {
      pairAddress: "0x62fcb3c1794fb95bd8b1a97f6ad5d8a7e4943a1e",
      dexId: "pancakeswap",
      labels: ["v2"],
      baseTokenAddress: weth,
      baseTokenSymbol: "ETH",
      baseTokenName: "Ethereum Token",
      quoteTokenAddress: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
      quoteTokenSymbol: "WBNB",
      priceUsd: "2576.66",
      priceNative: null,
      liquidityUsd: "899550.52",
      volumeH24: "2926215.92",
      priceChangeH24: "-2.4",
      fdv: null,
      marketCap: null,
      buysH24: null,
      sellsH24: null,
      pairCreatedAt: null,
    };
    await facts.put({
      subjectKey: `token:${weth}`,
      factKind: marketFactKinds.tokenPairs,
      source: "dexscreener",
      value: {
        tokenAddress: weth,
        pairs: [{ ...pair, imageUrl: image }],
        unrepresentablePairCount: 0,
      },
      rawDigest: "a".repeat(64),
      fetchedAt,
      ttlSeconds: 30,
    });
    const stored = await facts.get(
      `token:${weth}`,
      marketFactKinds.tokenPairs,
      "dexscreener",
    );
    expect(stored?.value).toMatchObject({
      pairs: [{ pairAddress: pair.pairAddress, imageUrl: image }],
    });
    expect(
      providerImageUrlFromPairs(
        stored?.value as unknown as {
          tokenAddress: string;
          pairs: readonly TokenPairSnapshot[];
        },
      ),
    ).toBe(image);

    // A row written before the field existed: the projection treats the
    // absent key as "no image", never as an error.
    await facts.put({
      subjectKey: `token:${weth}`,
      factKind: marketFactKinds.tokenPairs,
      source: "dexscreener",
      value: { tokenAddress: weth, pairs: [pair] },
      rawDigest: "b".repeat(64),
      fetchedAt,
      ttlSeconds: 30,
    });
    const legacy = await facts.get(
      `token:${weth}`,
      marketFactKinds.tokenPairs,
      "dexscreener",
    );
    expect(
      (legacy?.value as { pairs: readonly Record<string, unknown>[] }).pairs[0],
    ).not.toHaveProperty("imageUrl");
    expect(
      providerImageUrlFromPairs(
        legacy?.value as unknown as {
          tokenAddress: string;
          pairs: readonly TokenPairSnapshot[];
        },
      ),
    ).toBeNull();
  });

  it("stores the identity and market snapshots under their own fact kinds and TTLs", async () => {
    const fetchedAt = new Date().toISOString();
    await facts.put({
      subjectKey: `token:${weth}`,
      factKind: marketFactKinds.tokenIdentity,
      source: "geckoterminal",
      value: { symbol: "ETH", name: "Ethereum Token", decimals: 18 },
      rawDigest: "e".repeat(64),
      fetchedAt,
      ttlSeconds: 3_600,
    });
    await facts.put({
      subjectKey: `token:${weth}`,
      factKind: marketFactKinds.tokenLookup,
      source: "geckoterminal",
      value: { tokenAddress: weth, priceUsd: "2575.14", topPools: [] },
      rawDigest: "f".repeat(64),
      fetchedAt,
      ttlSeconds: 60,
    });
    await expect(
      facts.get(
        `token:${weth}`,
        marketFactKinds.tokenIdentity,
        "geckoterminal",
      ),
    ).resolves.toMatchObject({
      value: { symbol: "ETH", decimals: 18 },
      ttlSeconds: 3_600,
    });
    await expect(
      facts.get(`token:${weth}`, marketFactKinds.tokenLookup, "geckoterminal"),
    ).resolves.toMatchObject({
      value: { priceUsd: "2575.14" },
      ttlSeconds: 60,
    });
    // The DexScreener identity is a separate row for the same subject.
    await facts.put({
      subjectKey: `token:${weth}`,
      factKind: marketFactKinds.tokenIdentity,
      source: "dexscreener",
      value: { symbol: "ETH", name: "Ethereum Token", decimals: null },
      rawDigest: "d".repeat(64),
      fetchedAt,
      ttlSeconds: 3_600,
    });
    const count = await pool.query<{ count: string }>({
      text: `select count(*)::text as count from public.market_fact_cache where subject_key = $1`,
      values: [`token:${weth}`],
    });
    expect(count.rows[0]?.count).toBe("3");
  });
});
