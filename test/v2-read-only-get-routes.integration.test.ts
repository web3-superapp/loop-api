import { randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createPostgresChainRegistryRepository } from "../src/database/chain-registry-repository.js";
import { bscChainId } from "../src/features/chain/chain-contract.js";
import type { BscReadClient } from "../src/integrations/bsc/rpc-client.js";
import type {
  CandlesProvider,
  MarketPairsProvider,
  SecurityFactsProvider,
  TokenPairsSnapshot,
} from "../src/integrations/market/market-data-provider.js";
import type {
  PrivyWalletAccount,
  PrivyWalletReader,
} from "../src/integrations/privy/wallet-reader.js";
import { requireIntegrationDatabaseUrl } from "./helpers/integration-database.js";

/**
 * Decision 0127: the GET routes the S150 preflight saw writing must answer
 * on a connection with `default_transaction_read_only=on`. A cache or
 * inventory write that fails never fails the read; a security meter
 * (alias-search quota) and a first invite-code issuance stay fail-closed
 * as 503 CAPABILITY_UNAVAILABLE; nothing answers 500.
 */

const databaseUrl = requireIntegrationDatabaseUrl();
const readOnlyUrl = `${databaseUrl}${databaseUrl.includes("?") ? "&" : "?"}options=${encodeURIComponent(
  "-c default_transaction_read_only=on",
)}`;
const pool = new pg.Pool({ connectionString: databaseUrl });

const prefix = "0x5151";
const token = `${prefix}0000000000000000000000000000000000a1`;
const quote = `${prefix}0000000000000000000000000000000000a2`;
const tokenAssetId = `${bscChainId}:${token}`;
const quoteAssetId = `${bscChainId}:${quote}`;
const fetchedAt = new Date().toISOString();
const headHash = `0x${"1".repeat(64)}`;

const privyWithCode = `did:privy:s151-ro-code-${randomUUID()}`;
const privyWithoutCode = `did:privy:s151-ro-nocode-${randomUUID()}`;
const userWithCode = randomUUID();
const userWithoutCode = randomUUID();
const walletA = `0x${randomBytes(20).toString("hex")}`;
const walletB = `0x${randomBytes(20).toString("hex")}`;
const walletAProviderId = `s151-ro-${randomUUID()}`;

let privyWallets: readonly PrivyWalletAccount[] = [
  { address: walletA, kind: "embedded", providerWalletId: walletAProviderId },
];

function snapshot(tokenAddress: string): TokenPairsSnapshot {
  if (tokenAddress !== token) return { tokenAddress, pairs: [] };
  return {
    tokenAddress,
    pairs: [
      {
        pairAddress: `${prefix}0000000000000000000000000000000000b1`,
        dexId: "pancakeswap",
        labels: ["v2"],
        baseTokenAddress: token,
        baseTokenSymbol: "S151",
        quoteTokenAddress: quote,
        quoteTokenSymbol: "QUSD",
        priceUsd: "1.25",
        priceNative: null,
        priceChangeH24: "2.5",
        liquidityUsd: "100000",
        volumeH24: "5000",
        fdv: "1250000",
        marketCap: "1250000",
        buysH24: 3,
        sellsH24: 2,
        pairCreatedAt: "2026-09-01T00:00:00.000Z",
      },
    ],
  };
}

const pairsProvider: MarketPairsProvider = {
  source: "dexscreener",
  readTokenPairs: (tokenAddress) =>
    Promise.resolve({
      value: snapshot(tokenAddress),
      source: "dexscreener" as const,
      fetchedAt,
      rawDigest: "a".repeat(64),
    }),
  readTokenPairsBatch: (addresses) =>
    Promise.resolve({
      value: addresses.map(snapshot),
      source: "dexscreener" as const,
      fetchedAt,
      rawDigest: "b".repeat(64),
    }),
  readPair: (pairAddress) =>
    Promise.resolve({
      value: { pairAddress, pair: null },
      source: "dexscreener" as const,
      fetchedAt,
      rawDigest: "c".repeat(64),
    }),
};

const securityProvider: SecurityFactsProvider = {
  source: "goplus",
  readTokenSecurity: (tokenAddress) =>
    Promise.resolve({
      value: {
        tokenAddress,
        facts: [{ fact: "openSource", value: "true" }],
        holderCount: "1234",
      },
      source: "goplus" as const,
      fetchedAt,
      rawDigest: "d".repeat(64),
    }),
};

const candlesProvider: CandlesProvider = {
  source: "geckoterminal",
  readPoolOhlcv: (poolAddress) =>
    Promise.resolve({
      value: {
        poolAddress,
        candles: [
          {
            openTime: "2026-10-11T00:00:00.000Z",
            open: "1.2",
            high: "1.3",
            low: "1.1",
            close: "1.25",
            volume: "100",
          },
        ],
      },
      source: "geckoterminal" as const,
      fetchedAt,
      rawDigest: "e".repeat(64),
    }),
  readNewPools: () =>
    Promise.resolve({
      value: {
        pools: [
          {
            poolRef: {
              kind: "address" as const,
              address: `${prefix}0000000000000000000000000000000000b1`,
            },
            dexId: "pancakeswap_v2",
            name: "S151 / QUSD",
            baseTokenAddress: token,
            quoteTokenAddress: quote,
            createdAt: "2026-10-11T00:00:00.000Z",
            reserveUsd: "100000",
            volumeH24Usd: "5000",
          },
        ],
        omittedPoolCount: 0,
      },
      source: "geckoterminal" as const,
      fetchedAt,
      rawDigest: "f".repeat(64),
    }),
  readPoolTrades: () => Promise.reject(new Error("not used")),
};

const readClient: BscReadClient = {
  chainId: "eip155:56",
  chainReference: 56,
  confirmations: 15,
  reorgDepthBlocks: 64,
  endpointRefs: ["rpc-abcdefabcdef"],
  verifyChain: () => Promise.resolve("verified"),
  currentVerification: () => "verified",
  getHead: () =>
    Promise.resolve({
      blockNumber: 120_000_000n,
      blockHash: headHash,
      observedAt: fetchedAt,
    }),
  getBlockHash: () => Promise.resolve(headHash),
  readTokenIdentity: () => Promise.reject(new Error("not used")),
  readPoolIdentity: () => Promise.reject(new Error("not used")),
  readBalances: () => Promise.reject(new Error("not used")),
  readTransferLogs: () => Promise.resolve([]),
  readPoolEventLogs: () => Promise.resolve([]),
  readApprovalLogs: () => Promise.resolve([]),
  probeEndpoints: () => Promise.resolve([]),
};

const walletReader: PrivyWalletReader = {
  listEthereumWallets: () => Promise.resolve(privyWallets),
};

const cursorSecret = randomBytes(32).toString("base64url");
const quotaSecret = randomBytes(32).toString("base64url");

async function app(mode: "read-write" | "read-only") {
  // A fresh app per call: the wallet inventory is cached per process.
  return buildApp({
    config: loadConfig({
      NODE_ENV: "test",
      API_DOCS_ENABLED: "false",
      LOG_LEVEL: "silent",
      V2_MODULES_ENABLED:
        "community,search,market,chain,wallet,referral,profile,watchlist",
      V2_CURSOR_HMAC_SECRET: cursorSecret,
      STREAM_TOKEN_QUOTA_HMAC_SECRET: quotaSecret,
      PRIVY_APP_ID: "app_s151_read_only",
      PRIVY_APP_SECRET: "secret_s151_read_only",
      BSC_RPC_URLS: "https://rpc-a.example/",
      DATABASE_URL: mode === "read-only" ? readOnlyUrl : databaseUrl,
    }),
    contractSurface: "v2",
    privyAccessTokenVerifier: {
      verifyAccessToken: (bearer: string) =>
        Promise.resolve({
          privyUserId:
            bearer === "nocode.a.b" ? privyWithoutCode : privyWithCode,
        }),
    },
    privyWalletReader: walletReader,
    marketPairsProvider: pairsProvider,
    securityFactsProvider: securityProvider,
    candlesProvider,
    tokenLookupProvider: null,
    bscReadClient: readClient,
    logger: false,
  });
}

function headers(bearer = "code.a.b"): Record<string, string> {
  return {
    authorization: `Bearer ${bearer}`,
    "x-loop-client-version": "1.2.3",
    "x-loop-contract-version": "2.0",
  };
}

async function cleanup(): Promise<void> {
  await pool.query(
    `delete from public.market_fact_cache where subject_key like $1 or subject_key like $2`,
    [`%${prefix}%`, `%${prefix.slice(2)}%`],
  );
  await pool.query(
    `delete from public.assets where chain_id = $1 and address like $2`,
    [bscChainId, `${prefix}%`],
  );
}

async function cacheRows(): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `select count(*)::text as count from public.market_fact_cache where subject_key like $1`,
    [`%${prefix}%`],
  );
  return Number(result.rows[0]?.count ?? "0");
}

describe("V2 GET routes on a read-only database (Decision 0127)", () => {
  beforeAll(async () => {
    await cleanup();
    await pool.query(
      `insert into public.loop_users (id, privy_user_id) values ($1, $2), ($3, $4)`,
      [userWithCode, privyWithCode, userWithoutCode, privyWithoutCode],
    );
    const registry = createPostgresChainRegistryRepository(pool);
    for (const [address, symbol] of [
      [token, "S151"],
      [quote, "QUSD"],
    ] as const) {
      await registry.upsertAsset({
        assetId: `${bscChainId}:${address}`,
        chainId: bscChainId,
        address,
        symbol,
        name: `${symbol} test`,
        decimals: 18,
        status: "verified",
        sourceBlockNumber: "1",
      });
    }
    // The read-write app issues the invite code and records the wallet.
    const writer = await app("read-write");
    try {
      expect(
        (
          await writer.inject({
            method: "GET",
            url: "/v2/referral",
            headers: headers(),
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await writer.inject({
            method: "GET",
            url: "/v2/wallets",
            headers: headers(),
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await writer.close();
    }
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("serves the market reads fresh from the Provider and stores nothing", async () => {
    const reader = await app("read-only");
    try {
      for (const url of [
        "/v2/market/overview",
        "/v2/market/new-pairs",
        `/v2/market/assets/${tokenAssetId}`,
        `/v2/market/assets/${tokenAssetId}/candles?interval=1h`,
        `/v2/market/assets/${tokenAssetId}/holders`,
        `/v2/market/assets/${quoteAssetId}`,
      ]) {
        const response = await reader.inject({
          method: "GET",
          url,
          headers: headers(),
        });
        expect({ url, status: response.statusCode }).toEqual({
          url,
          status: 200,
        });
      }
      const detail = await reader.inject({
        method: "GET",
        url: `/v2/market/assets/${tokenAssetId}`,
        headers: headers(),
      });
      expect(JSON.stringify(detail.json())).toContain("1.25");
      expect(await cacheRows()).toBe(0);
    } finally {
      await reader.close();
    }
  });

  it("serves the stored wallet inventory when it matches Privy and is unavailable when it does not", async () => {
    let reader = await app("read-only");
    try {
      const response = await reader.inject({
        method: "GET",
        url: "/v2/wallets",
        headers: headers(),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ wallets: { address: string }[] }>();
      expect(body.wallets.map((wallet) => wallet.address)).toEqual([walletA]);
    } finally {
      await reader.close();
    }
    privyWallets = [
      {
        address: walletA,
        kind: "embedded",
        providerWalletId: walletAProviderId,
      },
      { address: walletB, kind: "external", providerWalletId: null },
    ];
    reader = await app("read-only");
    try {
      const response = await reader.inject({
        method: "GET",
        url: "/v2/wallets",
        headers: headers(),
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    } finally {
      await reader.close();
      privyWallets = [
        {
          address: walletA,
          kind: "embedded",
          providerWalletId: walletAProviderId,
        },
      ];
    }
  });

  it("reads an issued invite code and keeps a first issuance fail-closed", async () => {
    const reader = await app("read-only");
    try {
      const issued = await reader.inject({
        method: "GET",
        url: "/v2/referral",
        headers: headers(),
      });
      expect(issued.statusCode).toBe(200);
      const first = await reader.inject({
        method: "GET",
        url: "/v2/referral",
        headers: headers("nocode.a.b"),
      });
      expect(first.statusCode).toBe(503);
      expect(first.json()).toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    } finally {
      await reader.close();
    }
  });

  it("answers the social reads without a 500", async () => {
    const reader = await app("read-only");
    try {
      const expectations: readonly [string, number][] = [
        ["/v2/blocks?kind=user", 200],
        // Not storage-backed at all: unavailable in every mode.
        ["/v2/blocks?kind=contract", 503],
        ["/v2/blocks?kind=domain", 503],
        // The alias-search quota is a security meter and stays fail-closed.
        ["/v2/search?domain=users&q=abc", 503],
        ["/v2/search?domain=communities&q=abc", 503],
        [`/v2/communities/${randomUUID()}/members?q=ab`, 503],
        [`/v2/communities/${randomUUID()}/members`, 404],
      ];
      for (const [url, status] of expectations) {
        const response = await reader.inject({
          method: "GET",
          url,
          headers: headers(),
        });
        expect({ url, status: response.statusCode }).toEqual({ url, status });
        if (status === 503) {
          expect(response.json()).toMatchObject({
            code: "CAPABILITY_UNAVAILABLE",
          });
        }
      }
    } finally {
      await reader.close();
    }
  });
});
