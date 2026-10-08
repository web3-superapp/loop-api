import type { FastifyInstance } from "fastify";
import { decodeFunctionData } from "viem";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import {
  formatE18,
  freshMemeCurve,
  memeE18,
  memePriceE18,
  memeWalletCap,
  quoteMemeBuy,
  quoteMemeSell,
} from "../src/features/meme/meme-curve-math.js";
import { memeCurveAbiV1 } from "../src/integrations/meme/meme-abi.v1.js";
import {
  memeCandlesResourceSchema,
  memeHoldersResourceSchema,
  memeIntentResourceSchema,
  memeQuoteResourceSchema,
  memeTokenDetailResourceSchema,
  memeTokenListResourceSchema,
  memeTradesResourceSchema,
} from "../src/routes/v2/meme-schemas.js";
import { walletId, walletsFake } from "./helpers/launch-service-fakes.js";
import { memeCurveAddress } from "./helpers/meme-fixtures.js";
import {
  createFakeMemeAdapter,
  createFakeMemeSlotClient,
  createInMemoryMemeRepository,
  defaultMemeFunds,
  memeEnv,
  memeNowSeconds,
  memeTokenFixture,
  memeUsd1,
  memeWritesEnv,
  type FakeCurveChain,
  type FakeMemeFunds,
  type InMemoryMemeRepository,
} from "./helpers/meme-service-fakes.js";
import {
  s7AccountId,
  s7CommandHeaders,
  s7CommonHeaders,
  s7Database,
  s7IdempotencyKey,
  s7PrivyVerifier,
  s7TestConfig,
} from "./s7-route-fakes.js";

/**
 * Decision 0101 route contract: the nine `/v2/meme/*` routes, their 503
 * branch while the contract is not configured, the wire shapes the OpenAPI
 * schemas publish (every required key present), and the refusals.
 */

const errorKeys = [
  "category",
  "code",
  "correlationId",
  "detailsSafe",
  "providerReferenceSafe",
  "retryable",
  "userMessageKey",
];
const otherCreator = "0f1e2d3c-4b5a-4968-8776-655443322110";

function requiredOf(schema: unknown, path: readonly string[]): string[] {
  let node = schema as Record<string, unknown>;
  for (const key of path) {
    node = (node["properties"] as Record<string, Record<string, unknown>>)[
      key
    ] as Record<string, unknown>;
  }
  return [...(node["required"] as string[])];
}

function expectKeys(
  value: Record<string, unknown>,
  required: readonly string[],
): void {
  for (const key of required) {
    expect(Object.hasOwn(value, key), key).toBe(true);
  }
}

describe("V2 MEME launchpad routes (Decision 0101)", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function createApp(
    options: {
      readonly env?: Readonly<Record<string, string>>;
      readonly repository?: InMemoryMemeRepository;
      readonly chain?: FakeCurveChain;
      readonly funds?: FakeMemeFunds;
      readonly unconfigured?: boolean;
    } = {},
  ) {
    const repository = options.repository ?? createInMemoryMemeRepository();
    const chain: FakeCurveChain = options.chain ?? {
      curves: new Map(),
      unavailable: false,
    };
    const app = await buildApp({
      config: s7TestConfig(
        options.unconfigured === true
          ? { V2_MODULES_ENABLED: "meme", ...options.env }
          : { ...memeEnv, ...options.env },
      ),
      contractSurface: "v2",
      database: {
        ...s7Database({}),
        meme: repository,
        accountWallets: walletsFake(),
      },
      privyAccessTokenVerifier: s7PrivyVerifier(),
      ...(options.unconfigured === true
        ? {}
        : { memeContractAdapter: createFakeMemeAdapter(chain) }),
      launchChainReadClient: createFakeMemeSlotClient(
        options.funds ?? defaultMemeFunds(),
      ),
      walletIntentNow: () => new Date(Number(memeNowSeconds) * 1000),
      logger: false,
    });
    apps.push(app);
    return { app, repository, chain };
  }

  const get = (app: FastifyInstance, url: string) =>
    app.inject({ method: "GET", url, headers: s7CommonHeaders() });

  function seedTrading(
    repository: InMemoryMemeRepository,
    chain: FakeCurveChain,
    overrides: Parameters<typeof memeTokenFixture>[0] = {},
  ) {
    const token = memeTokenFixture(overrides);
    repository.tokens.set(token.memeTokenId, token);
    chain.curves.set(token.tokenAddress as string, {
      curve: { vUsd1: BigInt(token.vUsd1), vToken: BigInt(token.vToken) },
      status: "TRADING",
    });
    return token;
  }

  it("answers 503 with the reason and reports the capability while the contract is not configured", async () => {
    const { app } = await createApp({ unconfigured: true });
    for (const [method, url] of [
      ["GET", "/v2/meme/tokens"],
      ["GET", `/v2/meme/tokens/${walletId}`],
      ["GET", `/v2/meme/quote?tokenId=${walletId}&side=buy&amount=1`],
      ["GET", `/v2/meme/intents/${walletId}`],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: s7CommonHeaders(),
      });
      expect(response.statusCode, url).toBe(503);
      const body = response.json<Record<string, unknown>>();
      expect(Object.keys(body).sort()).toEqual(errorKeys);
      expect(body).toMatchObject({
        code: "CAPABILITY_UNAVAILABLE",
        detailsSafe: { reasonCode: "MEME_CONTRACT_NOT_CONFIGURED" },
      });
    }
    const created = await app.inject({
      method: "POST",
      url: "/v2/meme/tokens",
      headers: s7CommandHeaders(),
      payload: { name: "Frog", symbol: "FROG" },
    });
    expect(created.statusCode).toBe(503);
    const capabilities = await get(app, "/v2/meta/capabilities");
    const meme = capabilities
      .json<{ capabilities: { capabilityId: string }[] }>()
      .capabilities.find((item) => item.capabilityId === "meme");
    expect(meme).toEqual({
      capabilityId: "meme",
      availability: "unavailable",
      reasonCode: "MEME_CONTRACT_NOT_CONFIGURED",
      evidence: {
        status: "pending",
        reasonCode: "MEME_CONTRACT_NOT_CONFIGURED",
      },
    });
  });

  it("reports the capability available and confirmed once the contract is observed", async () => {
    const { app } = await createApp();
    const capabilities = await get(app, "/v2/meta/capabilities");
    expect(
      capabilities
        .json<{ capabilities: { capabilityId: string }[] }>()
        .capabilities.find((item) => item.capabilityId === "meme"),
    ).toEqual({
      capabilityId: "meme",
      availability: "available",
      reasonCode: null,
      evidence: { status: "confirmed", reasonCode: "MEME_CONTRACT_OBSERVED" },
    });
  });

  it("creates a draft (201 detail), replays the key, and is invisible to others", async () => {
    const { app, repository } = await createApp();
    const response = await app.inject({
      method: "POST",
      url: "/v2/meme/tokens",
      headers: s7CommandHeaders(),
      payload: {
        name: "Frog",
        symbol: "FROG",
        description: "ribbit",
        links: { website: "https://frog.example" },
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json<{ memeToken: Record<string, unknown> }>();
    expectKeys(
      body.memeToken,
      requiredOf(memeTokenDetailResourceSchema, ["memeToken"]),
    );
    expect(body.memeToken).toMatchObject({
      status: "draft",
      tokenAddress: null,
      priceUsd1: null,
      quoteUnavailable: { reasonCode: "MEME_TOKEN_NOT_ON_CHAIN" },
      vanity: false,
      viewer: null,
      graduation: null,
      links: {
        website: "https://frog.example/",
        twitter: null,
        telegram: null,
      },
      contract: {
        address: memeCurveAddress,
        chainId: "eip155:97",
        chainReference: 97,
        explorerUrl: null,
      },
    });
    expect(body.memeToken["salt"]).toMatch(/^0x[0-9a-f]{64}$/);
    expect(body.memeToken["predictedAddress"]).toMatch(/^0x[0-9a-f]{40}$/);
    const replay = await app.inject({
      method: "POST",
      url: "/v2/meme/tokens",
      headers: s7CommandHeaders(),
      payload: {
        name: "Frog",
        symbol: "FROG",
        description: "ribbit",
        links: { website: "https://frog.example" },
      },
    });
    expect(
      replay.json<{ memeToken: { memeTokenId: string } }>().memeToken
        .memeTokenId,
    ).toBe(body.memeToken["memeTokenId"]);
    const conflict = await app.inject({
      method: "POST",
      url: "/v2/meme/tokens",
      headers: s7CommandHeaders(),
      payload: { name: "Toad", symbol: "TOAD" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const foreign = memeTokenFixture({
      creatorUserId: otherCreator,
      status: "draft",
      tokenAddress: null,
    });
    repository.tokens.set(foreign.memeTokenId, foreign);
    const hidden = await get(app, `/v2/meme/tokens/${foreign.memeTokenId}`);
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toMatchObject({
      code: "NOT_FOUND",
      detailsSafe: { reasonCode: "MEME_TOKEN_NOT_FOUND" },
    });
  });

  it("refuses invalid metadata, enforces the daily limit, and needs an Idempotency-Key", async () => {
    const { app, repository } = await createApp();
    const invalid = await app.inject({
      method: "POST",
      url: "/v2/meme/tokens",
      headers: s7CommandHeaders(),
      payload: {
        name: "Frog",
        symbol: "FROG",
        links: { website: "http://x.example" },
      },
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toMatchObject({
      code: "VALIDATION_FAILED",
      detailsSafe: {
        reasonCode: "MEME_METADATA_INVALID",
        field: "links.website",
      },
    });
    const lowercase = await app.inject({
      method: "POST",
      url: "/v2/meme/tokens",
      headers: s7CommandHeaders(),
      payload: { name: "Frog", symbol: "frog" },
    });
    expect(lowercase.statusCode).toBe(400);
    repository.rateLimited = true;
    const limited = await app.inject({
      method: "POST",
      url: "/v2/meme/tokens",
      headers: s7CommandHeaders({ "idempotency-key": s7IdempotencyKey("c") }),
      payload: { name: "Frog", symbol: "FROG" },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({
      code: "RATE_LIMITED",
      category: "rateLimit",
      detailsSafe: { reasonCode: "MEME_CREATE_RATE_LIMITED", dailyLimit: 3 },
    });
    const keyless = await app.inject({
      method: "POST",
      url: "/v2/meme/tokens",
      headers: s7CommonHeaders(),
      payload: { name: "Frog", symbol: "FROG" },
    });
    expect(keyless.statusCode).toBe(400);
  });

  it("lists tokens with curve prices and pages with a signed cursor", async () => {
    const { app, repository, chain } = await createApp();
    const first = seedTrading(repository, chain, {
      memeTokenId: "aaaaaaaa-1111-4111-8111-111111111111",
    });
    seedTrading(repository, chain, {
      memeTokenId: "bbbbbbbb-1111-4111-8111-111111111111",
      tokenAddress: "0x3333333333333333333333333333333333333333",
    });
    const page = await get(app, "/v2/meme/tokens?limit=1");
    expect(page.statusCode).toBe(200);
    const body = page.json<
      {
        items: Record<string, unknown>[];
        nextCursor: string | null;
      } & Record<string, unknown>
    >();
    expectKeys(body, requiredOf(memeTokenListResourceSchema, []));
    expect(body["tab"]).toBe("new");
    expect(body.items).toHaveLength(1);
    expectKeys(
      body.items[0]!,
      memeTokenListResourceSchema.properties.items.items.required,
    );
    expect(body.items[0]).toMatchObject({
      memeTokenId: "bbbbbbbb-1111-4111-8111-111111111111",
      priceUsd1: formatE18(memePriceE18(freshMemeCurve)),
      change1hPct: "0.00",
      progressBps: 0,
      priceSource: { source: "loop_curve" },
      creator: { displayName: "frogmaker" },
    });
    expect(body.nextCursor).not.toBeNull();
    const next = await get(
      app,
      `/v2/meme/tokens?cursor=${encodeURIComponent(body.nextCursor ?? "")}`,
    );
    expect(
      next
        .json<{ items: { memeTokenId: string }[] }>()
        .items.map((item) => item.memeTokenId),
    ).toEqual([first.memeTokenId]);
    expect((await get(app, "/v2/meme/tokens?tab=trending")).statusCode).toBe(
      400,
    );
    expect(
      (await get(app, "/v2/meme/tokens?limit=1&cursor=a.b")).statusCode,
    ).toBe(400);
    const hot = await get(app, "/v2/meme/tokens?tab=hot");
    expect(hot.json<{ items: unknown[] }>().items).toHaveLength(2);
  });

  it("drops operator-hidden tokens from every list but keeps the detail (Decision 0102)", async () => {
    const { app, repository, chain } = await createApp();
    const listed = seedTrading(repository, chain, {
      memeTokenId: "aaaaaaaa-2222-4222-8222-222222222222",
    });
    const hidden = seedTrading(repository, chain, {
      memeTokenId: "bbbbbbbb-2222-4222-8222-222222222222",
      tokenAddress: "0x4444444444444444444444444444444444444444",
    });
    const ids = async (url: string) =>
      (await get(app, url))
        .json<{ items: { memeTokenId: string }[] }>()
        .items.map((item) => item.memeTokenId);
    // The hot ranking is cached for 60 s; hiding must still apply at once.
    expect(await ids("/v2/meme/tokens?tab=hot")).toHaveLength(2);
    repository.tokens.set(hidden.memeTokenId, {
      ...hidden,
      listing: "hidden",
      listingReasonCode: "user_reports",
      listingReasonText: "该代币已被平台隐藏。",
    });
    expect(await ids("/v2/meme/tokens")).toEqual([listed.memeTokenId]);
    expect(await ids("/v2/meme/tokens?tab=hot")).toEqual([listed.memeTokenId]);
    const detail = await get(app, `/v2/meme/tokens/${hidden.memeTokenId}`);
    expect(detail.statusCode).toBe(200);
    expect(
      detail.json<{ memeToken: Record<string, unknown> }>().memeToken,
    ).toMatchObject({
      listing: "hidden",
      listingReason: {
        reasonCode: "user_reports",
        reasonText: "该代币已被平台隐藏。",
      },
    });
    const visible = await get(app, `/v2/meme/tokens/${listed.memeTokenId}`);
    expect(
      visible.json<{ memeToken: Record<string, unknown> }>().memeToken,
    ).toMatchObject({ listing: "listed", listingReason: null });
  });

  it("serves the detail with the viewer block, trades, candles, and holders", async () => {
    const { app, repository, chain } = await createApp({
      funds: defaultMemeFunds({
        tokenBalance: 10n * memeE18,
        usd1Allowance: 7n,
      }),
    });
    const token = seedTrading(repository, chain, {
      creatorUserId: s7AccountId,
    });
    const detail = await get(app, `/v2/meme/tokens/${token.memeTokenId}`);
    expect(detail.statusCode).toBe(200);
    const memeToken = detail.json<{ memeToken: Record<string, unknown> }>()
      .memeToken;
    expect(memeToken["viewer"]).toEqual({
      walletId,
      balance: (10n * memeE18).toString(),
      usd1Balance: (1_000n * memeE18).toString(),
      walletCapRemaining: (memeWalletCap - 10n * memeE18).toString(),
      allowanceUsd1: "7",
      allowanceToken: "0",
    });
    expect(memeToken["volume24hUsd1"]).toBe("5");
    expect(memeToken["curve"]).toMatchObject({
      saleSupply: (800_000_000n * memeE18).toString(),
      tradeFeeBps: 100,
      walletCapTokens: memeWalletCap.toString(),
    });
    expect(memeToken["contract"]).toMatchObject({
      explorerUrl: `https://testnet.bscscan.com/token/${token.tokenAddress ?? ""}`,
    });

    const trades = await get(
      app,
      `/v2/meme/tokens/${token.memeTokenId}/trades`,
    );
    expect(trades.statusCode).toBe(200);
    const tradeBody = trades.json<
      { items: Record<string, unknown>[] } & Record<string, unknown>
    >();
    expectKeys(tradeBody, requiredOf(memeTradesResourceSchema, []));
    expect(tradeBody.items[0]).toMatchObject({
      isBuy: true,
      usd1Amount: "5000000000000000000",
      priceAfter: "0.0000056",
    });
    const candles = await get(
      app,
      `/v2/meme/tokens/${token.memeTokenId}/candles?interval=1m&limit=300`,
    );
    expect(candles.statusCode).toBe(200);
    const candleBody = candles.json<
      { items: Record<string, unknown>[] } & Record<string, unknown>
    >();
    expectKeys(candleBody, requiredOf(memeCandlesResourceSchema, []));
    expect(candleBody.items[0]).toMatchObject({
      open: "0.0000056",
      high: "0.0000057",
      volumeUsd1: "5",
      tradeCount: 2,
    });
    expect(
      (
        await get(
          app,
          `/v2/meme/tokens/${token.memeTokenId}/candles?interval=2m`,
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (await get(app, `/v2/meme/tokens/${token.memeTokenId}/candles?limit=301`))
        .statusCode,
    ).toBe(400);
    const holders = await get(
      app,
      `/v2/meme/tokens/${token.memeTokenId}/holders`,
    );
    const holderBody = holders.json<
      { items: Record<string, unknown>[] } & Record<string, unknown>
    >();
    expectKeys(holderBody, requiredOf(memeHoldersResourceSchema, []));
    expect(holderBody.items[0]).toEqual({
      wallet: "0x000000000000000000000000000000000000000a",
      account: null,
      balance: "100000000000000000000000000",
      shareBps: 1_000,
      isCreator: true,
      isViewer: true,
    });
  });

  it("quotes buys and sells with the recomputation and the wallet cap", async () => {
    const { app, repository, chain } = await createApp({
      funds: defaultMemeFunds({ tokenBalance: memeWalletCap - 1n }),
    });
    const token = seedTrading(repository, chain);
    const buy = await get(
      app,
      `/v2/meme/quote?tokenId=${token.memeTokenId}&side=buy&amount=100&walletId=${walletId}`,
    );
    expect(buy.statusCode).toBe(200);
    const expected = quoteMemeBuy(freshMemeCurve, 100n * memeE18);
    const buyBody = buy.json<
      { quote: Record<string, unknown> } & Record<string, unknown>
    >();
    expectKeys(buyBody.quote, requiredOf(memeQuoteResourceSchema, ["quote"]));
    expect(buyBody).toMatchObject({
      quote: {
        side: "buy",
        amountIn: (100n * memeE18).toString(),
        out: expected.tokensOut.toString(),
        fee: expected.fee.toString(),
        refund: "0",
        walletCapHit: true,
        walletCapRemaining: "1",
        belowMinBuy: false,
      },
      basis: { source: "chain", blockNumber: "5000" },
    });
    chain.curves.set(token.tokenAddress as string, {
      curve: { vUsd1: expected.newVUsd1, vToken: expected.newVToken },
      status: "TRADING",
    });
    // The 1.5-second chain cache still serves the previous curve.
    const sell = await get(
      app,
      `/v2/meme/quote?tokenId=${token.memeTokenId}&side=sell&amount=1000`,
    );
    expect(sell.statusCode).toBe(422);
    expect(sell.json()).toMatchObject({
      detailsSafe: { reasonCode: "MEME_SELL_EXCEEDS_BALANCE" },
    });
    const full = seedTrading(repository, chain, {
      tokenAddress: "0x4444444444444444444444444444444444444444",
    });
    chain.curves.set("0x4444444444444444444444444444444444444444", {
      curve: freshMemeCurve,
      status: "FULL",
    });
    const refused = await get(
      app,
      `/v2/meme/quote?tokenId=${full.memeTokenId}&side=buy&amount=1`,
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      code: "DATA_STALE",
      detailsSafe: { reasonCode: "MEME_CURVE_FULL" },
    });
    expect(
      (
        await get(
          app,
          `/v2/meme/quote?tokenId=${token.memeTokenId}&side=buy&amount=1e3`,
        )
      ).statusCode,
    ).toBe(400);
  });

  it("prepares a buy with an exact approve first, reports it, and reads it back", async () => {
    const { app, repository, chain } = await createApp({ env: memeWritesEnv });
    const token = seedTrading(repository, chain);
    const prepared = await app.inject({
      method: "POST",
      url: `/v2/meme/tokens/${token.memeTokenId}/intents`,
      headers: s7CommandHeaders(),
      payload: { kind: "buy", walletId, usd1Amount: "10" },
    });
    expect(prepared.statusCode).toBe(201);
    const intent = prepared.json<{ memeIntent: Record<string, unknown> }>()
      .memeIntent;
    expectKeys(intent, requiredOf(memeIntentResourceSchema, ["memeIntent"]));
    const expected = quoteMemeBuy(freshMemeCurve, 10n * memeE18);
    expect(intent).toMatchObject({
      kind: "buy",
      state: "prepared",
      tokenAddress: token.tokenAddress,
      usd1Amount: (10n * memeE18).toString(),
      expectedOut: expected.tokensOut.toString(),
      minOut: ((expected.tokensOut * 9_900n) / 10_000n).toString(),
      chainReference: 97,
      simulation: {
        status: "unavailable",
        reasonCode: "MEME_APPROVAL_REQUIRED",
      },
      signing: { allowed: true, reasonCode: null },
      approval: {
        token: memeUsd1,
        spender: memeCurveAddress,
        amount: (10n * memeE18).toString(),
        unsignedTransaction: { nonce: "0x7", chainId: 97 },
      },
      unsignedTransaction: { nonce: "0x8", to: memeCurveAddress },
      calldata: { to: memeCurveAddress, value: "0" },
    });
    const decoded = decodeFunctionData({
      abi: memeCurveAbiV1,
      data: (intent["calldata"] as { data: `0x${string}` }).data,
    });
    expect(decoded.functionName).toBe("buy");
    expect(
      decoded.args
        .slice(0, 3)
        .map((arg) => (typeof arg === "string" ? arg.toLowerCase() : arg)),
    ).toEqual([
      token.tokenAddress,
      10n * memeE18,
      (expected.tokensOut * 9_900n) / 10_000n,
    ]);
    const intentId = intent["memeIntentId"] as string;
    const replay = await app.inject({
      method: "POST",
      url: `/v2/meme/tokens/${token.memeTokenId}/intents`,
      headers: s7CommandHeaders(),
      payload: { kind: "buy", walletId, usd1Amount: "10" },
    });
    expect(
      replay.json<{ memeIntent: { memeIntentId: string } }>().memeIntent
        .memeIntentId,
    ).toBe(intentId);
    const txHash = `0x${"9a".repeat(32)}`;
    const reported = await app.inject({
      method: "POST",
      url: `/v2/meme/tokens/${token.memeTokenId}/intents/${intentId}/broadcast-report`,
      headers: s7CommandHeaders({ "idempotency-key": s7IdempotencyKey("d") }),
      payload: { txHash },
    });
    expect(reported.statusCode).toBe(200);
    expect(reported.json()).toMatchObject({
      memeIntent: {
        state: "broadcast_reported",
        transactionHash: txHash,
        signing: { allowed: false, reasonCode: "MEME_INTENT_ALREADY_REPORTED" },
      },
    });
    const again = await app.inject({
      method: "POST",
      url: `/v2/meme/tokens/${token.memeTokenId}/intents/${intentId}/broadcast-report`,
      headers: s7CommandHeaders({ "idempotency-key": s7IdempotencyKey("e") }),
      payload: { txHash: `0x${"9b".repeat(32)}` },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({
      detailsSafe: { reasonCode: "MEME_INTENT_ALREADY_REPORTED" },
    });
    const read = await get(app, `/v2/meme/intents/${intentId}`);
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({
      memeIntent: { memeIntentId: intentId, state: "broadcast_reported" },
    });
    expect(
      (await get(app, `/v2/meme/intents/${otherCreator}`)).statusCode,
    ).toBe(404);
  });

  it("refuses buys below the minimum, above the wallet cap, or without writes", async () => {
    const { app, repository, chain } = await createApp({
      env: memeWritesEnv,
      funds: defaultMemeFunds({
        tokenBalance: memeWalletCap,
        usd1Allowance: 10n ** 30n,
      }),
    });
    const token = seedTrading(repository, chain);
    const small = await app.inject({
      method: "POST",
      url: `/v2/meme/tokens/${token.memeTokenId}/intents`,
      headers: s7CommandHeaders(),
      payload: { kind: "buy", walletId, usd1Amount: "0.5" },
    });
    expect(small.statusCode).toBe(422);
    expect(small.json()).toMatchObject({
      detailsSafe: { reasonCode: "MEME_BELOW_MIN_BUY" },
    });
    const capped = await app.inject({
      method: "POST",
      url: `/v2/meme/tokens/${token.memeTokenId}/intents`,
      headers: s7CommandHeaders({ "idempotency-key": s7IdempotencyKey("f") }),
      payload: { kind: "buy", walletId, usd1Amount: "5" },
    });
    expect(capped.statusCode).toBe(422);
    expect(capped.json()).toMatchObject({
      detailsSafe: {
        reasonCode: "MEME_WALLET_CAP_EXCEEDED",
        remainingTokens: "0",
      },
    });
    const numeric = await app.inject({
      method: "POST",
      url: `/v2/meme/tokens/${token.memeTokenId}/intents`,
      headers: s7CommandHeaders({ "idempotency-key": s7IdempotencyKey("1") }),
      payload: { kind: "buy", walletId, usd1Amount: 5 },
    });
    expect(numeric.statusCode).toBe(400);
    const {
      app: closed,
      repository: closedRepository,
      chain: closedChain,
    } = await createApp();
    const closedToken = seedTrading(closedRepository, closedChain);
    const off = await closed.inject({
      method: "POST",
      url: `/v2/meme/tokens/${closedToken.memeTokenId}/intents`,
      headers: s7CommandHeaders(),
      payload: { kind: "buy", walletId, usd1Amount: "5" },
    });
    expect(off.statusCode).toBe(503);
    expect(off.json()).toMatchObject({
      detailsSafe: { reasonCode: "MEME_WRITES_DISABLED" },
    });
  });

  it("prepares a sell with a token approval and a create with a fresh salt when the old one is taken", async () => {
    const taken = new Set<string>();
    const funds = defaultMemeFunds({
      tokenBalance: 1_000_000n * memeE18,
      codeAt: taken,
    });
    const { app, repository, chain } = await createApp({
      env: memeWritesEnv,
      funds,
    });
    const traded = quoteMemeBuy(freshMemeCurve, 1_000n * memeE18);
    const token = seedTrading(repository, chain, {
      vUsd1: traded.newVUsd1.toString(),
      vToken: traded.newVToken.toString(),
    });
    const sell = await app.inject({
      method: "POST",
      url: `/v2/meme/tokens/${token.memeTokenId}/intents`,
      headers: s7CommandHeaders(),
      payload: {
        kind: "sell",
        walletId,
        tokenAmount: "1000",
        slippageBps: 300,
      },
    });
    expect(sell.statusCode).toBe(201);
    const expected = quoteMemeSell(
      { vUsd1: traded.newVUsd1, vToken: traded.newVToken },
      1_000n * memeE18,
    );
    expect(sell.json()).toMatchObject({
      memeIntent: {
        kind: "sell",
        tokenAmount: (1_000n * memeE18).toString(),
        expectedOut: expected.usd1Out.toString(),
        minOut: ((expected.usd1Out * 9_700n) / 10_000n).toString(),
        approval: {
          token: token.tokenAddress,
          amount: (1_000n * memeE18).toString(),
        },
      },
    });

    const draft = memeTokenFixture({
      creatorUserId: s7AccountId,
      status: "draft",
      tokenAddress: null,
      assetId: null,
    });
    repository.tokens.set(draft.memeTokenId, draft);
    taken.add(draft.predictedAddress as string);
    const create = await app.inject({
      method: "POST",
      url: `/v2/meme/tokens/${draft.memeTokenId}/intents`,
      headers: s7CommandHeaders({ "idempotency-key": s7IdempotencyKey("2") }),
      payload: { kind: "create", walletId },
    });
    expect(create.statusCode).toBe(201);
    const createIntent = create.json<{ memeIntent: Record<string, unknown> }>()
      .memeIntent;
    const replaced = repository.tokens.get(draft.memeTokenId);
    expect(replaced?.salt).not.toBe(draft.salt);
    expect(createIntent).toMatchObject({
      kind: "create",
      tokenAddress: null,
      predictedAddress: replaced?.predictedAddress,
      approval: null,
      simulation: { status: "passed" },
    });
    const call = decodeFunctionData({
      abi: memeCurveAbiV1,
      data: (createIntent["calldata"] as { data: `0x${string}` }).data,
    });
    expect(call).toEqual({
      functionName: "createToken",
      args: [replaced?.salt, "Frog", "FROG", draft.metadataHash, 0n, 0n],
    });
    // Only the creator deploys a draft.
    const foreign = memeTokenFixture({
      creatorUserId: otherCreator,
      status: "draft",
      tokenAddress: null,
    });
    repository.tokens.set(foreign.memeTokenId, foreign);
    const refused = await app.inject({
      method: "POST",
      url: `/v2/meme/tokens/${foreign.memeTokenId}/intents`,
      headers: s7CommandHeaders({ "idempotency-key": s7IdempotencyKey("3") }),
      payload: { kind: "create", walletId },
    });
    expect(refused.statusCode).toBe(404);
  });
});
