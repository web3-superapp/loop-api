import type { FastifyInstance } from "fastify";
import { decodeFunctionData } from "viem";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import {
  launch2Template,
  parseLaunch2Amount,
} from "../src/features/launch2/launch2-contract.js";
import {
  launch2GrossForNet,
  launch2ReserveAt,
} from "../src/features/launch2/launch2-curve-math.js";
import { curveEngineAbi } from "../src/integrations/launch/hooks-launch-protocol-abi.generated.js";
import {
  launch2BuybacksResourceSchema,
  launch2InstanceDetailResourceSchema,
  launch2InstanceListResourceSchema,
  launch2IntentResourceSchema,
  launch2PositionsResourceSchema,
  launch2QuoteResourceSchema,
} from "../src/routes/v2/launch2-schemas.js";
import {
  createFakeLaunch2Chain,
  createInMemoryLaunch2Repository,
  defaultChainState,
  instanceFixture,
  launch2Env,
  launch2NowSeconds,
  launch2WritesEnv,
  priorityInstance,
  wad,
  type FakeLaunch2ChainState,
  type InMemoryLaunch2Repository,
} from "./helpers/launch2-fakes.js";
import {
  walletAddress,
  walletId,
  walletsFake,
} from "./helpers/launch-service-fakes.js";
import {
  createFakeMemeSlotClient,
  defaultMemeFunds,
} from "./helpers/meme-service-fakes.js";
import {
  s7CommandHeaders,
  s7CommonHeaders,
  s7Database,
  s7IdempotencyKey,
  s7PrivyVerifier,
  s7TestConfig,
} from "./s7-route-fakes.js";

/**
 * Decision 0114 route contract: the seven `/v2/launch2/*` routes, their
 * 503 branch while the Factory / chain is not configured, the wire shapes
 * the OpenAPI schemas publish, the executable MAX, quote expiry, and the
 * refusals of the prepares.
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

const iso = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString();

describe("V2 launch2 routes (Decision 0114)", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function createApp(
    options: {
      readonly env?: Readonly<Record<string, string>>;
      readonly repository?: InMemoryLaunch2Repository;
      readonly chain?: FakeLaunch2ChainState;
      readonly unconfigured?: boolean;
      readonly writes?: boolean;
    } = {},
  ) {
    const repository = options.repository ?? createInMemoryLaunch2Repository();
    const chain = options.chain ?? defaultChainState();
    const app = await buildApp({
      config: s7TestConfig({
        ...(options.unconfigured === true
          ? { V2_MODULES_ENABLED: "launch2" }
          : launch2Env),
        ...(options.writes === false ? {} : launch2WritesEnv),
        ...options.env,
      }),
      contractSurface: "v2",
      database: {
        ...s7Database({}),
        launch2: repository,
        accountWallets: walletsFake(),
      },
      privyAccessTokenVerifier: s7PrivyVerifier(),
      ...(options.unconfigured === true
        ? {}
        : { launch2Chain: createFakeLaunch2Chain(chain) }),
      launchChainReadClient: createFakeMemeSlotClient(
        defaultMemeFunds({ usd1Allowance: 0n }),
      ),
      walletIntentNow: () => new Date(Number(launch2NowSeconds) * 1000),
      logger: false,
    });
    apps.push(app);
    return { app, repository, chain };
  }

  const get = (app: FastifyInstance, url: string) =>
    app.inject({ method: "GET", url, headers: s7CommonHeaders() });
  const post = (
    app: FastifyInstance,
    url: string,
    payload: unknown,
    key = s7IdempotencyKey(),
  ) =>
    app.inject({
      method: "POST",
      url,
      headers: s7CommandHeaders({ "idempotency-key": key }),
      payload: payload as Record<string, unknown>,
    });

  function seedMember(
    repository: InMemoryLaunch2Repository,
    instanceId: string,
  ) {
    repository.members.set(instanceId, [
      {
        memberAddress: walletAddress,
        leaf: `0x${"88".repeat(32)}`,
        proof: [`0x${"99".repeat(32)}`],
        nftBalance: 1,
      },
    ]);
  }

  it("answers 503 with the reason and reports the capability while the Factory is not configured", async () => {
    const { app } = await createApp({ unconfigured: true });
    const id = instanceFixture().instanceId;
    for (const [method, url] of [
      ["GET", "/v2/launch2/instances"],
      ["GET", `/v2/launch2/instances/${id}`],
      [
        "GET",
        `/v2/launch2/instances/${id}/quote?side=buy&amount=1&walletId=${walletId}`,
      ],
      ["GET", `/v2/launch2/instances/${id}/buybacks`],
      ["GET", "/v2/launch2/me/positions"],
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
        detailsSafe: { reasonCode: "LAUNCH2_FACTORY_NOT_CONFIGURED" },
      });
    }
    const prepared = await post(
      app,
      `/v2/launch2/instances/${id}/nft/prepare`,
      {
        walletId,
      },
    );
    expect(prepared.statusCode).toBe(503);
    const capability = (await get(app, "/v2/meta/capabilities"))
      .json<{ capabilities: { capabilityId: string }[] }>()
      .capabilities.find((item) => item.capabilityId === "launch2");
    expect(capability).toEqual({
      capabilityId: "launch2",
      availability: "unavailable",
      reasonCode: "LAUNCH2_FACTORY_NOT_CONFIGURED",
      evidence: {
        status: "pending",
        reasonCode: "LAUNCH2_FACTORY_NOT_CONFIGURED",
      },
    });
  });

  it("is not routed without the module and reports it deferred", async () => {
    const { app } = await createApp({ env: { V2_MODULES_ENABLED: "meme" } });
    expect((await get(app, "/v2/launch2/instances")).statusCode).toBe(404);
    const capability = (await get(app, "/v2/meta/capabilities"))
      .json<{ capabilities: { capabilityId: string }[] }>()
      .capabilities.find((item) => item.capabilityId === "launch2");
    expect(capability).toMatchObject({
      availability: "deferred",
      reasonCode: "LAUNCH2_MODULE_NOT_ENABLED",
    });
  });

  it("lists activated instances with the clock-derived stage and the schema's keys", async () => {
    const repository = createInMemoryLaunch2Repository();
    const selling = instanceFixture({ stage: "upcoming" });
    const hidden = instanceFixture({ activatedAt: null });
    repository.instances.set(selling.instanceId, selling);
    repository.instances.set(hidden.instanceId, hidden);
    const { app } = await createApp({ repository });
    const response = await get(app, "/v2/launch2/instances");
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      instances: Record<string, unknown>[];
      nextCursor: string | null;
    }>();
    expectKeys(body, requiredOf(launch2InstanceListResourceSchema, []));
    expect(body.instances).toHaveLength(1);
    const row = body.instances[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      instanceId: selling.instanceId,
      // The stored stage is stale; the answer re-derives it from the clock.
      stage: "nft_sale",
      nextChangeAt: iso(launch2NowSeconds - 3_600n + 604_800n),
      memeAddress: selling.addresses.meme,
      nftSale: { priceUsd1: "100", soldCount: "2" },
      curve: {
        saleSupply: "800000000",
        soldSupply: "0",
        graduationReserveUsd1: "133333.332",
        priceUsd1: "0.00004166666625",
      },
    });
    expect(body.nextCursor).toBeNull();
    expect(
      (await get(app, "/v2/launch2/instances?stage=bogus")).statusCode,
    ).toBe(400);
  });

  it("details an instance with template, contracts, snapshot, viewer, and 404s the rest", async () => {
    const repository = createInMemoryLaunch2Repository();
    const instance = priorityInstance();
    repository.instances.set(instance.instanceId, instance);
    seedMember(repository, instance.instanceId);
    repository.positions.push({
      instanceId: instance.instanceId,
      holderAddress: walletAddress,
      nftMintedTokenId: "1",
      nftHeld: 1,
      curveBought: (1_000n * wad).toString(),
      curveSold: "0",
      cumulativeBought: (1_000n * wad).toString(),
      usd1Spent: (1n * wad).toString(),
      usd1Received: "0",
      taxUsd1: ((1n * wad) / 10n).toString(),
      buyCount: 1,
      sellCount: 0,
      snapshotMember: true,
      lastActivityAt: iso(launch2NowSeconds),
    });
    const { app } = await createApp({ repository });
    const response = await get(
      app,
      `/v2/launch2/instances/${instance.instanceId}`,
    );
    expect(response.statusCode).toBe(200);
    const body = response.json<{ instance: Record<string, unknown> }>();
    expectKeys(
      body.instance,
      requiredOf(launch2InstanceDetailResourceSchema, ["instance"]),
    );
    expect(body.instance).toMatchObject({
      stage: "priority",
      nextChangeAt: iso(launch2NowSeconds - 600n + 3_600n),
      template: {
        curveSaleSupply: "800000000",
        perAddressCap: "5000000",
        curveBuyTaxBps: 1000,
        nftPriceUsd1: "100",
      },
      snapshot: {
        status: "published",
        verification: "verified",
        memberCount: 2,
      },
      viewer: {
        walletId,
        nft: { mintedTokenId: "1", held: 1 },
        snapshot: { member: true, eligibleNow: true },
        curve: { cumulativeBought: "1000", remainingQuota: "4999000" },
      },
      buyback: {
        recipient: instance.buybackRecipient,
        escrowRecordedUsd1: "200",
      },
      viewerIsProjectOwner: false,
    });
    const missing = await get(
      app,
      `/v2/launch2/instances/${instanceFixture().instanceId}`,
    );
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({
      code: "NOT_FOUND",
      detailsSafe: { reasonCode: "LAUNCH2_INSTANCE_NOT_FOUND" },
    });
  });

  it("shows the server-side publication next to the snapshot (Decision 0118)", async () => {
    const repository = createInMemoryLaunch2Repository();
    const pending = instanceFixture({
      nftSaleStart: iso(launch2NowSeconds - 604_800n - 60n),
      stage: "snapshot_pending",
      snapshotPublication: {
        status: "broadcast",
        txHash: `0x${"7a".repeat(32)}`,
        cutoffBlock: "123",
        memberCount: 2,
      },
    });
    repository.instances.set(pending.instanceId, pending);
    const { app } = await createApp({ repository });
    const response = await get(
      app,
      `/v2/launch2/instances/${pending.instanceId}`,
    );
    expect(response.statusCode).toBe(200);
    const snapshot = response.json<{
      instance: { snapshot: Record<string, unknown> };
    }>().instance.snapshot;
    expectKeys(
      snapshot,
      requiredOf(launch2InstanceDetailResourceSchema, ["instance", "snapshot"]),
    );
    expect(snapshot).toEqual(
      expect.objectContaining({
        status: "pending",
        verification: null,
        publication: {
          status: "broadcast",
          txHash: `0x${"7a".repeat(32)}`,
          cutoffBlock: "123",
          memberCount: 2,
        },
      }),
    );
    repository.instances.set(
      pending.instanceId,
      instanceFixture({ snapshotPublication: null }),
    );
    const none = await get(app, `/v2/launch2/instances/${pending.instanceId}`);
    expect(
      none.json<{ instance: { snapshot: Record<string, unknown> } }>().instance
        .snapshot["publication"],
    ).toBeNull();
  });

  it("quotes a priority buy with the executable MAX and flags an over-MAX amount", async () => {
    const repository = createInMemoryLaunch2Repository();
    const instance = priorityInstance();
    repository.instances.set(instance.instanceId, instance);
    seedMember(repository, instance.instanceId);
    const { app } = await createApp({ repository });
    const maxIn = launch2GrossForNet(
      launch2ReserveAt(launch2Template.perAddressCap),
    );
    const response = await get(
      app,
      `/v2/launch2/instances/${instance.instanceId}/quote?side=buy&amount=1000000&walletId=${walletId}`,
    );
    expect(response.statusCode).toBe(200);
    const quote = response.json<{ quote: Record<string, unknown> }>().quote;
    expectKeys(quote, requiredOf(launch2QuoteResourceSchema, ["quote"]));
    expect(quote).toMatchObject({
      side: "buy",
      stage: "priority",
      exceedsMax: true,
      expectedOut: "5000000",
      taxBps: 1000,
      max: { amountOut: "5000000", limitedBy: "quota" },
      quota: { capMeme: "5000000", usedMeme: "0", remainingMeme: "5000000" },
      eligibility: { required: true, eligible: true, reasonCode: null },
      deadline: iso(launch2NowSeconds + 60n),
      basis: { blockNumber: "5000" },
    });
    expect(
      BigInt(
        (quote["max"] as { amountIn: string }).amountIn.split(".")[0] as string,
      ),
    ).toBe(maxIn / wad);
    // Within the quota: minOut = expectedOut × (1 − 1%).
    const small = (
      await get(
        app,
        `/v2/launch2/instances/${instance.instanceId}/quote?side=buy&amount=10&walletId=${walletId}`,
      )
    ).json<{
      quote: { exceedsMax: boolean; expectedOut: string; minOut: string };
    }>().quote;
    expect(small.exceedsMax).toBe(false);
    expect(Number(small.minOut)).toBeLessThan(Number(small.expectedOut));
  });

  it("refuses a quote outside a trading stage and a sell inside the priority hour", async () => {
    const repository = createInMemoryLaunch2Repository();
    const selling = instanceFixture();
    const priority = priorityInstance();
    repository.instances.set(selling.instanceId, selling);
    repository.instances.set(priority.instanceId, priority);
    const chain = defaultChainState();
    const { app } = await createApp({ repository, chain });
    chain.viewer.curve = { earlyRoundEndsAt: 0n };
    const stage = await get(
      app,
      `/v2/launch2/instances/${selling.instanceId}/quote?side=buy&amount=1&walletId=${walletId}`,
    );
    expect(stage.statusCode).toBe(409);
    expect(stage.json()).toMatchObject({
      code: "DATA_STALE",
      detailsSafe: { reasonCode: "LAUNCH2_STAGE_MISMATCH", stage: "nft_sale" },
    });
    chain.viewer.curve = {};
    const sell = await get(
      app,
      `/v2/launch2/instances/${priority.instanceId}/quote?side=sell&amount=1&walletId=${walletId}`,
    );
    expect(sell.statusCode).toBe(409);
    expect(sell.json()).toMatchObject({
      detailsSafe: { reasonCode: "LAUNCH2_SELL_NOT_OPEN", stage: "priority" },
    });
  });

  it("refuses an expired quote before any chain read (QUOTE_EXPIRED)", async () => {
    const repository = createInMemoryLaunch2Repository();
    const instance = priorityInstance();
    repository.instances.set(instance.instanceId, instance);
    const chain = defaultChainState();
    const { app } = await createApp({ repository, chain });
    const response = await post(
      app,
      `/v2/launch2/instances/${instance.instanceId}/trade/prepare`,
      {
        walletId,
        side: "buy",
        amount: "10",
        minOut: "1",
        deadline: iso(launch2NowSeconds - 1n),
      },
    );
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "QUOTE_EXPIRED",
      detailsSafe: { reasonCode: "LAUNCH2_QUOTE_EXPIRED" },
    });
    expect(chain.viewerReads).toBe(0);
    const tooFar = await post(
      app,
      `/v2/launch2/instances/${instance.instanceId}/trade/prepare`,
      {
        walletId,
        side: "buy",
        amount: "10",
        minOut: "1",
        deadline: iso(launch2NowSeconds + 3_600n),
      },
      s7IdempotencyKey("b"),
    );
    expect(tooFar.statusCode).toBe(422);
    expect(tooFar.json()).toMatchObject({
      detailsSafe: { reasonCode: "LAUNCH2_DEADLINE_TOO_FAR" },
    });
  });

  it("prepares a priority buy with the Merkle proof and an exact approve, replays it, and refuses the rest", async () => {
    const repository = createInMemoryLaunch2Repository();
    const instance = priorityInstance();
    repository.instances.set(instance.instanceId, instance);
    seedMember(repository, instance.instanceId);
    const chain = defaultChainState();
    const { app } = await createApp({ repository, chain });
    const url = `/v2/launch2/instances/${instance.instanceId}/trade/prepare`;
    const deadline = iso(launch2NowSeconds + 60n);
    const quote = (
      await get(
        app,
        `/v2/launch2/instances/${instance.instanceId}/quote?side=buy&amount=10&walletId=${walletId}`,
      )
    ).json<{ quote: { minOut: string; expectedOut: string } }>().quote;
    const body = {
      walletId,
      side: "buy",
      amount: "10",
      minOut: quote.minOut,
      deadline,
    };
    const created = await post(app, url, body);
    expect(created.statusCode).toBe(201);
    const intent = created.json<{ launch2Intent: Record<string, unknown> }>()
      .launch2Intent;
    expectKeys(
      intent,
      requiredOf(launch2IntentResourceSchema, ["launch2Intent"]),
    );
    expect(intent).toMatchObject({
      kind: "buy",
      state: "prepared",
      contractAddress: instance.addresses.curve,
      amountIn: "10",
      expectedOut: quote.expectedOut,
      minOut: quote.minOut,
      deadline,
      simulation: {
        status: "unavailable",
        reasonCode: "LAUNCH2_APPROVAL_REQUIRED",
      },
      signing: { mode: "device_eth_send_transaction", allowed: true },
      approval: { spender: instance.addresses.curve, amount: "10" },
    });
    const decoded = decodeFunctionData({
      abi: curveEngineAbi,
      data: (intent["calldata"] as { data: `0x${string}` }).data,
    });
    expect(decoded.functionName).toBe("buy");
    expect(decoded.args).toEqual([
      10n * wad,
      parseLaunch2Amount(quote.minOut),
      launch2NowSeconds + 60n,
      [`0x${"99".repeat(32)}`],
    ]);
    expect(JSON.stringify(intent)).not.toMatch(/signature|privateKey/iu);
    // Idempotent replay: same Intent, no second build.
    const replay = await post(app, url, body);
    expect(replay.statusCode).toBe(201);
    expect(
      replay.json<{ launch2Intent: { intentId: string } }>().launch2Intent
        .intentId,
    ).toBe(intent["intentId"]);
    expect(repository.builds.count).toBe(1);
    // Another order filled first: the fresh quote is below the old minOut.
    const moved = await post(
      app,
      url,
      { ...body, minOut: "5000000" },
      s7IdempotencyKey("c"),
    );
    expect(moved.statusCode).toBe(409);
    expect(moved.json()).toMatchObject({
      code: "DATA_STALE",
      detailsSafe: { reasonCode: "LAUNCH2_PRICE_MOVED", minOut: "5000000" },
    });
    // Above the executable MAX (quota): 422 with the MAX to fill in.
    const above = await post(
      app,
      url,
      { ...body, amount: "900000", minOut: "1" },
      s7IdempotencyKey("d"),
    );
    expect(above.statusCode).toBe(422);
    expect(above.json()).toMatchObject({
      detailsSafe: {
        reasonCode: "LAUNCH2_AMOUNT_ABOVE_MAX",
        limitedBy: "quota",
      },
    });
    // Not in the snapshot during the priority hour.
    repository.members.set(instance.instanceId, []);
    const outsider = await post(
      app,
      url,
      { ...body, minOut: "1" },
      s7IdempotencyKey("e"),
    );
    expect(outsider.statusCode).toBe(403);
    expect(outsider.json()).toMatchObject({
      code: "POLICY_BLOCKED",
      detailsSafe: { reasonCode: "LAUNCH2_NOT_IN_SNAPSHOT" },
    });
  });

  it("fails closed on an unverified snapshot and on a chain read failure", async () => {
    const repository = createInMemoryLaunch2Repository();
    const base = priorityInstance();
    const instance = priorityInstance({
      snapshot: {
        ...(base.snapshot as NonNullable<typeof base.snapshot>),
        verification: "mismatch",
      },
    });
    repository.instances.set(instance.instanceId, instance);
    const chain = defaultChainState();
    const { app } = await createApp({ repository, chain });
    const url = `/v2/launch2/instances/${instance.instanceId}/trade/prepare`;
    const body = {
      walletId,
      side: "buy",
      amount: "10",
      minOut: "1",
      deadline: iso(launch2NowSeconds + 60n),
    };
    const unverified = await post(app, url, body);
    expect(unverified.statusCode).toBe(503);
    expect(unverified.json()).toMatchObject({
      detailsSafe: { reasonCode: "LAUNCH2_SNAPSHOT_UNVERIFIED" },
    });
    chain.failViewer = true;
    const down = await post(app, url, body, s7IdempotencyKey("f"));
    expect(down.statusCode).toBe(503);
    expect(down.json()).toMatchObject({
      detailsSafe: { reasonCode: "LAUNCH2_CHAIN_READ_FAILED" },
    });
  });

  it("prepares the NFT mint with a 100 USD1 approve and refuses a second mint", async () => {
    const repository = createInMemoryLaunch2Repository();
    const instance = instanceFixture();
    repository.instances.set(instance.instanceId, instance);
    const chain = defaultChainState();
    chain.viewer.curve = { earlyRoundEndsAt: 0n };
    const { app } = await createApp({ repository, chain });
    const url = `/v2/launch2/instances/${instance.instanceId}/nft/prepare`;
    const created = await post(app, url, { walletId });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      launch2Intent: {
        kind: "nft_mint",
        contractAddress: instance.addresses.nft,
        amountIn: "100",
        approval: { spender: instance.addresses.nft, amount: "100" },
        policy: { valueUsd: "100", priceSource: "usd1_par" },
      },
    });
    chain.viewer = { ...chain.viewer, nftMinted: true };
    const again = await post(app, url, { walletId }, s7IdempotencyKey("b"));
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({
      detailsSafe: { reasonCode: "LAUNCH2_NFT_ALREADY_MINTED" },
    });
    chain.viewer = {
      ...chain.viewer,
      nftMinted: false,
      usd1Balance: 99n * wad,
    };
    const poor = await post(app, url, { walletId }, s7IdempotencyKey("c"));
    expect(poor.statusCode).toBe(409);
    expect(poor.json()).toMatchObject({
      code: "INSUFFICIENT_BALANCE",
      detailsSafe: { reasonCode: "LAUNCH2_USD1_BALANCE_INSUFFICIENT" },
    });
  });

  it("trusts the activated instance's contracts over the static counterparty allowlist (Decision 0117)", async () => {
    const stranger = "0x9999999999999999999999999999999999999999";
    const repository = createInMemoryLaunch2Repository();
    const selling = instanceFixture();
    repository.instances.set(selling.instanceId, selling);
    const chain = defaultChainState();
    chain.viewer.curve = { earlyRoundEndsAt: 0n };
    const { app } = await createApp({
      repository,
      chain,
      // A non-empty allowlist that names none of the instance's contracts.
      env: { BSC_WRITE_CANARY_RECIPIENT_ALLOWLIST: stranger },
    });
    const minted = await post(
      app,
      `/v2/launch2/instances/${selling.instanceId}/nft/prepare`,
      { walletId },
    );
    expect(minted.statusCode).toBe(201);
    expect(minted.json()).toMatchObject({
      launch2Intent: {
        contractAddress: selling.addresses.nft,
        approval: { spender: selling.addresses.nft },
      },
    });

    // Curve buy: curve + USD1 approve, same allowlist.
    const tradeRepository = createInMemoryLaunch2Repository();
    const priority = priorityInstance();
    tradeRepository.instances.set(priority.instanceId, priority);
    seedMember(tradeRepository, priority.instanceId);
    const { app: trading } = await createApp({
      repository: tradeRepository,
      chain: defaultChainState(),
      env: { BSC_WRITE_CANARY_RECIPIENT_ALLOWLIST: stranger },
    });
    const quote = (
      await get(
        trading,
        `/v2/launch2/instances/${priority.instanceId}/quote?side=buy&amount=10&walletId=${walletId}`,
      )
    ).json<{ quote: { minOut: string } }>().quote;
    const bought = await post(
      trading,
      `/v2/launch2/instances/${priority.instanceId}/trade/prepare`,
      {
        walletId,
        side: "buy",
        amount: "10",
        minOut: quote.minOut,
        deadline: iso(launch2NowSeconds + 60n),
      },
    );
    expect(bought.statusCode).toBe(201);
    expect(bought.json()).toMatchObject({
      launch2Intent: {
        kind: "buy",
        contractAddress: priority.addresses.curve,
        approval: { spender: priority.addresses.curve },
      },
    });

    // The USD1 must still be a canary asset.
    const { app: strict } = await createApp({
      repository,
      chain,
      env: { BSC_WRITE_CANARY_ASSETS: `eip155:97:${stranger}` },
    });
    const blocked = await post(
      strict,
      `/v2/launch2/instances/${selling.instanceId}/nft/prepare`,
      { walletId },
      s7IdempotencyKey("d"),
    );
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({
      code: "POLICY_BLOCKED",
      detailsSafe: { reasonCode: "ASSET_NOT_IN_CANARY_ALLOWLIST" },
    });
  });

  it("keeps prepares 503 while BSC writes are disabled", async () => {
    const repository = createInMemoryLaunch2Repository();
    const instance = instanceFixture();
    repository.instances.set(instance.instanceId, instance);
    const { app } = await createApp({ repository, writes: false });
    const response = await post(
      app,
      `/v2/launch2/instances/${instance.instanceId}/nft/prepare`,
      { walletId },
    );
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      detailsSafe: { reasonCode: "LAUNCH2_WRITES_DISABLED" },
    });
  });

  it("lists buybacks with the summary and the live protection state, and the caller's positions", async () => {
    const repository = createInMemoryLaunch2Repository();
    const instance = instanceFixture({
      graduation: {
        graduatedAt: iso(launch2NowSeconds - 100n),
        blockNumber: "900",
        transactionHash: `0x${"ab".repeat(32)}`,
        poolId: `0x${"cd".repeat(32)}`,
      },
      buyback: {
        paused: false,
        count: "1",
        usd1: (100n * wad).toString(),
        meme: (5n * wad).toString(),
        lastAt: iso(launch2NowSeconds - 50n),
      },
    });
    repository.instances.set(instance.instanceId, instance);
    repository.buybacks.set(instance.instanceId, [
      {
        buybackId: "5f0a4c1e-4b3a-4c2d-9e1f-0a1b2c3d4e5f",
        outcome: "executed",
        reasonCode: null,
        usd1Spent: (100n * wad).toString(),
        memeDelivered: (5n * wad).toString(),
        minMemeOut: (4n * wad).toString(),
        referencePriceE18: (20n * wad).toString(),
        spotPriceE18: (20n * wad).toString(),
        executedAt: iso(launch2NowSeconds - 50n),
        transactionHash: `0x${"ef".repeat(32)}`,
        blockNumber: "950",
      },
    ]);
    repository.positions.push({
      instanceId: instance.instanceId,
      holderAddress: walletAddress,
      nftMintedTokenId: "2",
      nftHeld: 1,
      curveBought: (10n * wad).toString(),
      curveSold: (4n * wad).toString(),
      cumulativeBought: (10n * wad).toString(),
      usd1Spent: wad.toString(),
      usd1Received: "0",
      taxUsd1: "0",
      buyCount: 1,
      sellCount: 1,
      snapshotMember: false,
      lastActivityAt: null,
    });
    const { app } = await createApp({ repository });
    const buybacks = await get(
      app,
      `/v2/launch2/instances/${instance.instanceId}/buybacks`,
    );
    expect(buybacks.statusCode).toBe(200);
    const body = buybacks.json<Record<string, unknown>>();
    expectKeys(body, requiredOf(launch2BuybacksResourceSchema, []));
    expect(body).toMatchObject({
      summary: {
        executedCount: "1",
        totalUsd1: "100",
        escrowAvailableUsd1: "100",
      },
      live: {
        escrowAvailableUsd1: "200",
        nextOrderUsd1: "100",
        nextOrderBlockedReason: "BUYBACK_PROTECTION_BLOCKED",
      },
      liveUnavailable: null,
      buybacks: [{ outcome: "executed", usd1Spent: "100", memeDelivered: "5" }],
      nextCursor: null,
    });
    const positions = await get(app, "/v2/launch2/me/positions");
    expect(positions.statusCode).toBe(200);
    const mine = positions.json<{ positions: Record<string, unknown>[] }>();
    expectKeys(mine, requiredOf(launch2PositionsResourceSchema, []));
    expect(mine.positions).toEqual([
      expect.objectContaining({
        instanceId: instance.instanceId,
        stage: "graduated",
        walletId,
        nft: { mintedTokenId: "2", held: 1 },
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        curve: expect.objectContaining({
          net: "6",
          cumulativeBought: "10",
          remainingQuota: "4999990",
        }),
      }),
    ]);
  });
});
