import { randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import { getAddress } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createV2CursorCodec } from "../src/core/http/v2-cursor.js";
import { createUnavailableCommunityRepository } from "../src/features/community/community-repository.js";
import { createPostgresChainRegistryRepository } from "../src/database/chain-registry-repository.js";
import { bscChainId } from "../src/features/chain/chain-contract.js";
import { createCommunityService } from "../src/features/community/community-service.js";
import { deriveStreamUserId } from "../src/features/identity/loop-identifiers.js";
import { createAliasPolicy } from "../src/features/profile/alias-policy.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * `GET /v2/search?domain=assets` over the real Asset Registry table
 * (Decision 0071): the rows `pnpm asset:register` writes are the rows the
 * search domain serves, a `blocked` row is never listed, and the page cursor
 * round-trips through the real codec.
 */

const { Pool } = pg;
const databaseUrl = requireIntegrationDatabaseUrl();
const pool = new Pool({ connectionString: databaseUrl });

const prefix = "0x5770";
const usdt = `${prefix}0000000000000000000000000000000000d1`;
const usdc = `${prefix}0000000000000000000000000000000000d2`;
const blocked = `${prefix}0000000000000000000000000000000000d3`;
const owner = randomUUID();

const principal = Object.freeze({
  userId: owner,
  privyUserId: "did:privy:search-assets",
  streamUserId: deriveStreamUserId(owner),
});

async function cleanFixtures(): Promise<void> {
  await pool.query({
    text: `delete from public.assets where chain_id = $1 and address like $2`,
    values: [bscChainId, `${prefix}%`],
  });
}

function buildService() {
  const registry = createPostgresChainRegistryRepository(pool);
  const searchQuota = {
    consume: () => Promise.reject(new Error("the asset domain has no quota")),
  };
  return createCommunityService({
    repository: createUnavailableCommunityRepository(),
    assetRegistry: {
      listReadableAssets: () => registry.listReadableAssets(bscChainId),
    },
    cursorCodec: createV2CursorCodec({ secret: randomBytes(32) }),
    searchQuota,
    aliasPolicy: createAliasPolicy({ blockedTerms: [] }),
  });
}

describe("V2 asset search over the Asset Registry (integration)", () => {
  beforeAll(async () => {
    await cleanFixtures();
    const registry = createPostgresChainRegistryRepository(pool);
    await registry.upsertAsset({
      assetId: `${bscChainId}:${usdt}`,
      chainId: bscChainId,
      address: usdt,
      symbol: "USDT",
      name: "Tether USD",
      decimals: 18,
      status: "pending",
      sourceBlockNumber: "1",
    });
    await registry.upsertAsset({
      assetId: `${bscChainId}:${usdc}`,
      chainId: bscChainId,
      address: usdc,
      symbol: "USDC",
      name: "USD Coin",
      decimals: 18,
      status: "verified",
      sourceBlockNumber: "1",
    });
    await registry.upsertAsset({
      assetId: `${bscChainId}:${blocked}`,
      chainId: bscChainId,
      address: blocked,
      symbol: "USDX",
      name: "Blocked USD",
      decimals: 18,
      status: "blocked",
      sourceBlockNumber: "1",
    });
  });

  afterAll(async () => {
    await cleanFixtures();
    await pool.end();
  });

  it("serves the registered rows by prefix, hides blocked rows, and pages through the real cursor", async () => {
    const service = buildService();
    const signal = new AbortController().signal;
    const base = {
      principal,
      domain: "assets",
      verification: undefined,
      canonicalClientIp: "203.0.113.7",
      signal,
    } as const;

    const byAddress = await service.search({
      ...base,
      q: prefix,
      cursor: undefined,
      limit: undefined,
    });
    expect(byAddress.status).toBe("available");
    expect(byAddress.results.map((row) => row.stableId)).toEqual([
      `${bscChainId}:${usdc}`,
      `${bscChainId}:${usdt}`,
    ]);
    expect(byAddress.results[0]).toEqual({
      resultType: "asset",
      stableId: `${bscChainId}:${usdc}`,
      displaySnapshot: {
        title: "USDC",
        subtitle: "USD Coin",
        avatarRef: null,
        logo: {
          status: "available",
          url: `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/smartchain/assets/${getAddress(usdc)}/logo.png`,
          source: "trustwallet",
          observedAt: null,
        },
        memberCount: null,
        verificationStatus: "verified",
      },
      destination: { kind: "assetDetail", assetId: `${bscChainId}:${usdc}` },
    });

    const first = await service.search({
      ...base,
      q: "usd",
      cursor: undefined,
      limit: 1,
    });
    expect(first.results.map((row) => row.stableId)).toEqual([
      `${bscChainId}:${usdc}`,
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await service.search({
      ...base,
      q: "usd",
      cursor: first.nextCursor ?? undefined,
      limit: undefined,
    });
    expect(second.results.map((row) => row.stableId)).toEqual([
      `${bscChainId}:${usdt}`,
    ]);
    expect(second.nextCursor).toBeNull();

    const blockedLookup = await service.search({
      ...base,
      q: "usdx",
      cursor: undefined,
      limit: undefined,
    });
    expect(blockedLookup.results).toEqual([]);
  });
});
