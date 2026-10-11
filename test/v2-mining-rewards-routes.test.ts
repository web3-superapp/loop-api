import type { FastifyInstance } from "fastify";
import {
  decodeFunctionData,
  keccak256,
  recoverTypedDataAddress,
  stringToBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { createUnavailableMiningRepository } from "../src/features/mining/mining-repository.js";
import {
  miningClaimDomain,
  miningClaimTypes,
  createMiningClaimSigner,
} from "../src/features/mining/claim-voucher.js";
import {
  createMiningRewardsService,
  type MiningRewardsServiceDependencies,
} from "../src/features/mining/hourly-rewards-service.js";
import type { MiningClaimReceipt } from "../src/features/mining/hourly-settlement-ports.js";
import { loopRewardClaimAbi } from "../src/integrations/mining/loop-reward-claim-abi.js";
import {
  miningClaimPrepareResourceSchema,
  miningClaimReportResourceSchema,
  miningClaimsResourceSchema,
  miningHourlyBlockSchema,
  miningRewardEpochsResourceSchema,
} from "../src/routes/v2/mining-rewards-schemas.js";
import {
  walletAddress,
  walletId,
  walletsFake,
} from "./helpers/launch-service-fakes.js";
import {
  createFakeMemeSlotClient,
  defaultMemeFunds,
  memeUsd1,
  type FakeMemeFunds,
} from "./helpers/meme-service-fakes.js";
import {
  claimContract,
  createFakeClaimChain,
  createInMemoryMiningSettlement,
  defaultClaimChainState,
  epochRecord,
  landClaim,
  loop,
  parameterVersion,
  rewardRecord,
  signerKey,
  type FakeClaimChainState,
  type InMemoryMiningSettlement,
} from "./helpers/mining-settlement-fakes.js";
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
 * Decision 0116 route contract: the `hourly` block of GET /v2/mining/rewards,
 * the epoch / claim lists, claim prepare (voucher, nonce, gas branches,
 * in-flight, fail-closed reasons) and report (idempotent, ledger once).
 * The `§9-n` tests are the requirer's acceptance rows that need the routes.
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
const NOW = new Date("2026-10-10T11:20:00.000Z");

function requiredOf(schema: unknown): string[] {
  return [...(schema as { required: string[] }).required];
}

function miningRepositoryFake() {
  return {
    ...createUnavailableMiningRepository(),
    getApprovedFormula: vi.fn(() => Promise.resolve(null)),
    listFormulaVersions: vi.fn(() => Promise.resolve([])),
    getLatestSnapshot: vi.fn(() => Promise.resolve(null)),
    getLatestSnapshotAttempt: vi.fn(() => Promise.resolve(null)),
    hasActiveWallet: vi.fn(() => Promise.resolve(false)),
  };
}

function seededRepository(settled = 60n * loop): InMemoryMiningSettlement {
  const repo = createInMemoryMiningSettlement();
  repo.versions.push(parameterVersion());
  repo.epochs.push(epochRecord());
  repo.rewards.push(rewardRecord(s7AccountId, settled));
  repo.balances.set(s7AccountId, { settled, claimed: 0n });
  return repo;
}

describe("V2 mining hourly rewards and claims (Decision 0116)", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function createApp(
    options: {
      readonly repository?: InMemoryMiningSettlement | null;
      readonly chain?: FakeClaimChainState;
      readonly funds?: Partial<FakeMemeFunds>;
      readonly deps?: Partial<MiningRewardsServiceDependencies>;
      readonly wallet?: Parameters<typeof walletsFake>[0];
      readonly now?: Date;
      readonly composeFromConfig?: Readonly<Record<string, string>>;
    } = {},
  ) {
    const repository =
      options.repository === undefined
        ? seededRepository()
        : options.repository;
    const chain = options.chain ?? defaultClaimChainState();
    let clock = options.now ?? NOW;
    const service =
      options.composeFromConfig !== undefined
        ? undefined
        : createMiningRewardsService({
            repository,
            chain: createFakeClaimChain(chain),
            callClient: createFakeMemeSlotClient(
              defaultMemeFunds(options.funds ?? {}),
            ),
            wallets: walletsFake(options.wallet ?? {}),
            signer: createMiningClaimSigner(signerKey),
            contractAddress: claimContract,
            chainId: "eip155:97",
            writesEnabled: true,
            usdtAddress: memeUsd1,
            confirmations: 3,
            cursorCodec: null,
            now: () => clock,
            ...options.deps,
          });
    const app = await buildApp({
      config: s7TestConfig(options.composeFromConfig ?? {}),
      contractSurface: "v2",
      database: s7Database({ mining: miningRepositoryFake() }),
      privyAccessTokenVerifier: s7PrivyVerifier(),
      ...(service === undefined ? {} : { miningRewardsService: service }),
      logger: false,
    });
    apps.push(app);
    return {
      app,
      repository,
      chain,
      setNow: (next: Date) => {
        clock = next;
      },
    };
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
  const prepare = (app: FastifyInstance, key = s7IdempotencyKey()) =>
    post(app, "/v2/mining/claim/prepare", { walletId }, key);

  function expectError(
    response: { statusCode: number; json: () => unknown },
    status: number,
    code: string,
    reasonCode: string,
  ) {
    expect(response.statusCode).toBe(status);
    const body = response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(errorKeys);
    expect(body).toMatchObject({ code, detailsSafe: { reasonCode } });
    return body;
  }

  it("keeps every legacy rewards key and adds the hourly block", async () => {
    const { app } = await createApp();
    const response = await get(app, "/v2/mining/rewards");
    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      claimable: {
        status: "unavailable",
        reasonCode: "REWARD_AUTHORITY_PENDING",
      },
      claimExecutable: false,
      ledger: [],
    });
    const hourly = body["hourly"] as Record<string, unknown>;
    for (const key of requiredOf(miningHourlyBlockSchema)) {
      expect(Object.hasOwn(hourly, key), key).toBe(true);
    }
  });

  it("§9-7/§9-8 10:00–11:00 结算 60 LOOP、11:20 查看：展示 20 LOOP，可领取为完整 60 LOOP（不含当前小时）", async () => {
    const { app } = await createApp();
    const hourly = (await get(app, "/v2/mining/rewards")).json<{
      hourly: Record<string, Record<string, unknown> | string>;
    }>().hourly;
    expect(hourly["displayState"]).toBe("displaying");
    expect(hourly["serverTime"]).toBe(NOW.toISOString());
    expect(hourly["display"]).toMatchObject({
      windowStart: "2026-10-10T11:00:00.000Z",
      windowEnd: "2026-10-10T12:00:00.000Z",
      completedMinutes: 20,
      displayedRaw: (20n * loop).toString(),
      perMinuteRaw: (1n * loop).toString(),
      totalRaw: (60n * loop).toString(),
    });
    expect(hourly["totals"]).toEqual({
      settledRaw: (60n * loop).toString(),
      claimedRaw: "0",
      claimableRaw: (60n * loop).toString(),
    });
    expect(hourly["tracks"]).toMatchObject({
      nft: { realNftCount: "5", selfPower: "10", networkPower: "10" },
      asset: { selfPower: "0", excludedAssets: [] },
    });
    expect(
      (hourly["referral"] as { levels: { ratioBps: number }[] }).levels.map(
        (level) => level.ratioBps,
      ),
    ).toEqual([1000, 500, 300, 200, 100]);
    expect(hourly["claim"]).toMatchObject({ executable: true, latest: null });
  });

  it("shows awaiting_first_settlement with the parameters in force and no growth", async () => {
    const repository = createInMemoryMiningSettlement();
    repository.versions.push(parameterVersion());
    const { app } = await createApp({ repository });
    const hourly = (await get(app, "/v2/mining/rewards")).json<{
      hourly: Record<string, unknown>;
    }>().hourly;
    expect(hourly).toMatchObject({
      displayState: "awaiting_first_settlement",
      reasonCode: null,
      lastHour: null,
      display: null,
      tracks: null,
      totals: { settledRaw: "0", claimableRaw: "0" },
      parameters: { referralRatiosBps: [1000, 500, 300, 200, 100] },
    });
  });

  it("Decision 0125: awaits the caller's own first settled hour, not the network's (S138 observation 2)", async () => {
    // The network settled 10:00–11:00, the caller has no row in it.
    const repository = createInMemoryMiningSettlement();
    repository.versions.push(parameterVersion());
    repository.epochs.push(epochRecord());
    repository.rewards.push(
      rewardRecord("66666666-6666-4666-8666-666666666666", 60n * loop),
    );
    const { app } = await createApp({ repository });
    const hourly = (await get(app, "/v2/mining/rewards")).json<{
      hourly: Record<string, unknown>;
    }>().hourly;
    expect(hourly).toMatchObject({
      displayState: "awaiting_first_settlement",
      reasonCode: null,
      lastHour: null,
      display: null,
      tracks: null,
      totals: { settledRaw: "0", claimableRaw: "0" },
      claim: { executable: false, reasonCode: "MINING_NOTHING_SETTLED" },
    });
    // A zero-power row is not a first settled hour either.
    repository.rewards.push(
      rewardRecord(s7AccountId, 0n, {
        nftSelfPower: "0",
        nftTotalPower: "0",
        nftHoldings: [],
      }),
    );
    expect(
      (await get(app, "/v2/mining/rewards")).json<{
        hourly: Record<string, unknown>;
      }>().hourly["displayState"],
    ).toBe("awaiting_first_settlement");
  });

  it("is unavailable (never zero) while the settlement store is down", async () => {
    const repository = seededRepository();
    repository.unavailable = true;
    const { app } = await createApp({ repository });
    const response = await get(app, "/v2/mining/rewards");
    expect(response.statusCode).toBe(200);
    expect(response.json<{ hourly: unknown }>().hourly).toMatchObject({
      displayState: "unavailable",
      reasonCode: "MINING_SETTLEMENT_UNAVAILABLE",
      totals: null,
    });
  });

  it("composes fail-closed from configuration: no store → 503, no claim address → 503", async () => {
    const { app } = await createApp({ composeFromConfig: {} });
    expect((await get(app, "/v2/mining/rewards")).json()).toMatchObject({
      hourly: { displayState: "unavailable", claim: { executable: false } },
    });
    expectError(
      await prepare(app),
      503,
      "CAPABILITY_UNAVAILABLE",
      "MINING_SETTLEMENT_UNAVAILABLE",
    );
    expectError(
      await get(app, "/v2/mining/rewards/epochs"),
      503,
      "CAPABILITY_UNAVAILABLE",
      "MINING_SETTLEMENT_UNAVAILABLE",
    );
  });

  it.each([
    [{ signer: null }, "MINING_CLAIM_SIGNER_NOT_CONFIGURED"],
    [{ contractAddress: null }, "MINING_CLAIM_CONTRACT_NOT_CONFIGURED"],
    [{ chain: null }, "MINING_CLAIM_CHAIN_NOT_CONFIGURED"],
    [{ chainId: "eip155:56" }, "MINING_CLAIM_MAINNET_CLOSED"],
    [{ writesEnabled: false }, "MINING_CLAIM_WRITES_DISABLED"],
  ] as const)(
    "prepare is 503 with the missing dependency %#",
    async (deps, reasonCode) => {
      const { app } = await createApp({ deps });
      expectError(
        await prepare(app),
        503,
        "CAPABILITY_UNAVAILABLE",
        reasonCode,
      );
    },
  );

  describe("Decision 0123 claim.executable", () => {
    const claimOf = async (app: FastifyInstance) =>
      (await get(app, "/v2/mining/rewards")).json<{
        hourly: { claim: Record<string, unknown> };
      }>().hourly.claim;

    it("is false with MINING_PARAMETERS_PENDING when no approved version is in force", async () => {
      const repository = createInMemoryMiningSettlement();
      repository.versions.push(
        parameterVersion({ effectiveFrom: "2026-10-11T00:00:00.000Z" }),
      );
      const { app } = await createApp({ repository });
      expect(await claimOf(app)).toEqual({
        executable: false,
        reasonCode: "MINING_PARAMETERS_PENDING",
        latest: null,
      });
    });

    it("is false with MINING_NOTHING_SETTLED before the first hour settles", async () => {
      const repository = createInMemoryMiningSettlement();
      repository.versions.push(parameterVersion());
      const { app } = await createApp({ repository });
      expect(await claimOf(app)).toMatchObject({
        executable: false,
        reasonCode: "MINING_NOTHING_SETTLED",
      });
    });

    it("is never true while claimable is 0 or under the minimum", async () => {
      const none = await createApp({ repository: seededRepository(0n) });
      expect(await claimOf(none.app)).toMatchObject({
        executable: false,
        reasonCode: "MINING_CLAIM_NOTHING_TO_CLAIM",
      });
      const small = await createApp({
        repository: seededRepository(loop / 2n),
      });
      expect(await claimOf(small.app)).toMatchObject({
        executable: false,
        reasonCode: "MINING_CLAIM_BELOW_MINIMUM",
      });
    });

    it("is false with MINING_CLAIM_IN_FLIGHT while the latest claim is submitting", async () => {
      const { app } = await createApp();
      const prepared = await prepare(app);
      const claimId = prepared.json<{ claim: { claimId: string } }>().claim
        .claimId;
      const reported = await post(app, "/v2/mining/claim/report", {
        claimId,
        transactionHash: `0x${"ab".repeat(32)}`,
      });
      expect(reported.json<{ claim: { status: string } }>().claim.status).toBe(
        "submitting",
      );
      expect(await claimOf(app)).toMatchObject({
        executable: false,
        reasonCode: "MINING_CLAIM_IN_FLIGHT",
        latest: { claimId, status: "submitting" },
      });
    });

    it("Decision 0125 (S138 D3): is false with MINING_CLAIM_CONTRACT_PAUSED while the contract is paused, MINING_CLAIM_CHAIN_READ_FAILED when unreadable", async () => {
      const paused = defaultClaimChainState();
      paused.paused = true;
      expect(await claimOf((await createApp({ chain: paused })).app)).toEqual({
        executable: false,
        reasonCode: "MINING_CLAIM_CONTRACT_PAUSED",
        latest: null,
      });
      const down = defaultClaimChainState();
      down.unavailable = true;
      expect(
        await claimOf((await createApp({ chain: down })).app),
      ).toMatchObject({
        executable: false,
        reasonCode: "MINING_CLAIM_CHAIN_READ_FAILED",
      });
      // The ledger reasons come first: nothing to claim is not a chain read.
      const empty = await createApp({
        repository: seededRepository(0n),
        chain: paused,
      });
      expect(await claimOf(empty.app)).toMatchObject({
        reasonCode: "MINING_CLAIM_NOTHING_TO_CLAIM",
      });
    });

    it("reports the configuration reason only after the ledger allows a claim", async () => {
      const { app } = await createApp({ deps: { signer: null } });
      expect(await claimOf(app)).toMatchObject({
        executable: false,
        reasonCode: "MINING_CLAIM_SIGNER_NOT_CONFIGURED",
      });
      const empty = await createApp({
        repository: seededRepository(0n),
        deps: { signer: null },
      });
      expect(await claimOf(empty.app)).toMatchObject({
        reasonCode: "MINING_CLAIM_NOTHING_TO_CLAIM",
      });
    });
  });

  it("lists the caller's settled hours and claims", async () => {
    const { app } = await createApp();
    const epochs = await get(app, "/v2/mining/rewards/epochs");
    expect(epochs.statusCode).toBe(200);
    const body = epochs.json<{ items: Record<string, unknown>[] }>();
    for (const key of requiredOf(miningRewardEpochsResourceSchema)) {
      expect(Object.hasOwn(body, key), key).toBe(true);
    }
    expect(body.items[0]).toMatchObject({
      hourStart: "2026-10-10T10:00:00.000Z",
      totalRewardRaw: (60n * loop).toString(),
    });
    const claims = await get(app, "/v2/mining/claims");
    expect(claims.statusCode).toBe(200);
    for (const key of requiredOf(miningClaimsResourceSchema)) {
      expect(Object.hasOwn(claims.json<object>(), key), key).toBe(true);
    }
  });

  it("Decision 0125 (S138 D2): the epoch list leaves out zero-power hours", async () => {
    const repository = seededRepository();
    repository.epochs.push(
      epochRecord({
        epochId: "55555555-5555-4555-8555-555555555555",
        hourStart: "2026-10-10T09:00:00.000Z",
        hourEnd: "2026-10-10T10:00:00.000Z",
      }),
    );
    repository.rewards.push(
      rewardRecord(s7AccountId, 0n, {
        epochId: "55555555-5555-4555-8555-555555555555",
        hourStart: "2026-10-10T09:00:00.000Z",
        hourEnd: "2026-10-10T10:00:00.000Z",
        nftSelfPower: "0",
        nftTotalPower: "0",
        nftHoldings: [],
      }),
    );
    const { app } = await createApp({ repository });
    const items = (await get(app, "/v2/mining/rewards/epochs")).json<{
      items: { hourStart: string }[];
    }>().items;
    expect(items.map((item) => item.hourStart)).toEqual([
      "2026-10-10T10:00:00.000Z",
    ]);
  });

  it("§9-8 prepares a voucher for the full settled balance with the chain nonce", async () => {
    const chain = defaultClaimChainState();
    chain.nonces.set(walletAddress, 4n);
    const { app } = await createApp({ chain });
    const response = await prepare(app);
    expect(response.statusCode).toBe(201);
    const body = response.json<{
      claim: Record<string, unknown>;
      intent: {
        unsignedTransaction: Record<string, unknown>;
        signing: Record<string, unknown>;
        calldata: Record<string, unknown>;
      };
    }>();
    for (const key of requiredOf(miningClaimPrepareResourceSchema)) {
      expect(Object.hasOwn(body, key), key).toBe(true);
    }
    expect(body.claim).toMatchObject({
      status: "claimable",
      cumulativeAmountRaw: (60n * loop).toString(),
      amountRaw: (60n * loop).toString(),
      nonce: "4",
      deadline: "2026-10-10T11:30:00.000Z",
      contractAddress: claimContract,
      chainReference: 97,
    });
    expect(body.intent.signing).toEqual({
      mode: "device_eth_send_transaction",
      allowed: true,
      reasonCode: null,
    });
    expect(body.intent.unsignedTransaction).toMatchObject({
      to: claimContract,
      from: walletAddress,
      chainId: 97,
      value: "0x0",
    });
    // Decision 0123: the intent carries exactly calldata, the eleven-key
    // transaction, its payloadDigest, and signing.
    expect(Object.keys(body.intent).sort()).toEqual([
      "calldata",
      "payloadDigest",
      "signing",
      "unsignedTransaction",
    ]);
    const transaction = body.intent.unsignedTransaction;
    expect(Object.keys(transaction).sort()).toEqual([
      "chainId",
      "data",
      "from",
      "gas",
      "gasPrice",
      "maxFeePerGas",
      "maxPriorityFeePerGas",
      "nonce",
      "to",
      "type",
      "value",
    ]);
    const unsignedSchema = (
      miningClaimPrepareResourceSchema as unknown as {
        properties: {
          intent: {
            properties: {
              unsignedTransaction: {
                additionalProperties: boolean;
                required: string[];
              };
            };
          };
        };
      }
    ).properties.intent.properties.unsignedTransaction;
    expect(unsignedSchema.additionalProperties).toBe(false);
    expect([...unsignedSchema.required].sort()).toEqual(
      Object.keys(transaction).sort(),
    );
    // keccak-256 of the canonical JSON (keys sorted, no whitespace).
    const canonical = `{${Object.keys(transaction)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${JSON.stringify(transaction[key])}`,
      )
      .join(",")}}`;
    expect(canonical).not.toMatch(/\s/u);
    expect(
      (body.intent as unknown as { payloadDigest: string }).payloadDigest,
    ).toBe(keccak256(stringToBytes(canonical)));
    const decoded = decodeFunctionData({
      abi: loopRewardClaimAbi,
      data: body.intent.calldata["data"] as `0x${string}`,
    });
    expect(decoded.functionName).toBe("claim");
    const [wallet, cumulative, nonce, deadline, signature] = decoded.args as [
      `0x${string}`,
      bigint,
      bigint,
      bigint,
      `0x${string}`,
    ];
    expect([wallet.toLowerCase(), cumulative, nonce]).toEqual([
      walletAddress,
      60n * loop,
      4n,
    ]);
    const signer = await recoverTypedDataAddress({
      domain: miningClaimDomain(97, claimContract),
      types: miningClaimTypes,
      primaryType: "Claim",
      message: { wallet, cumulativeAmount: cumulative, nonce, deadline },
      signature,
    });
    expect(signer).toBe(privateKeyToAccount(signerKey).address);
  });

  it("§9-11 重复点击：同一 Idempotency-Key 回放同一凭证；不同请求体复用 key 是 409", async () => {
    const wallets = walletsFake();
    const base = wallets.get.bind(wallets);
    wallets.get = vi.fn(async (owner: string, id: string) => {
      const record = await base(owner, walletId);
      return record === null ? null : { ...record, walletId: id };
    });
    const { app, repository } = await createApp({ deps: { wallets } });
    const first = await prepare(app, s7IdempotencyKey("1"));
    const again = await prepare(app, s7IdempotencyKey("1"));
    expect(again.statusCode).toBe(201);
    expect(again.json<{ claim: { claimId: string } }>().claim.claimId).toBe(
      first.json<{ claim: { claimId: string } }>().claim.claimId,
    );
    expect(repository?.claims.size).toBe(1);
    const conflict = await post(
      app,
      "/v2/mining/claim/prepare",
      { walletId: "e64786bb-408d-415d-8a69-6277d56c921b" },
      s7IdempotencyKey("1"),
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("refuses when nothing or less than the minimum is claimable", async () => {
    const none = await createApp({ repository: seededRepository(0n) });
    expectError(
      await prepare(none.app),
      409,
      "INSUFFICIENT_BALANCE",
      "MINING_CLAIM_NOTHING_TO_CLAIM",
    );
    const small = await createApp({ repository: seededRepository(loop / 2n) });
    const body = expectError(
      await prepare(small.app),
      409,
      "INSUFFICIENT_BALANCE",
      "MINING_CLAIM_BELOW_MINIMUM",
    );
    expect(body["detailsSafe"]).toMatchObject({
      minimumRaw: loop.toString(),
      claimableRaw: (loop / 2n).toString(),
    });
  });

  it("CLAIM_GAS_INSUFFICIENT suggests a USDT → BNB swap when the wallet holds USDT", async () => {
    const { app, repository } = await createApp({
      funds: { nativeBalance: 0n, usd1Balance: 5n * loop },
    });
    const body = expectError(
      await prepare(app),
      409,
      "INSUFFICIENT_BALANCE",
      "CLAIM_GAS_INSUFFICIENT",
    );
    expect(body["detailsSafe"]).toEqual({
      reasonCode: "CLAIM_GAS_INSUFFICIENT",
      requiredNativeAmount: "0.00024",
      suggestedSwapFromSymbol: "USDT",
      suggestedSwapFromAssetId: `eip155:97:${memeUsd1}`,
      suggestedSwapToSymbol: "BNB",
      suggestedSwapToAssetId: "eip155:97:native",
      suggestedSwapToAmount: "0.00036",
    });
    expect(repository?.claims.size).toBe(0);
  });

  it("CLAIM_NO_GAS_SOURCE when the wallet holds neither BNB nor USDT", async () => {
    const { app } = await createApp({
      funds: { nativeBalance: 0n, usd1Balance: 0n },
    });
    expectError(
      await prepare(app),
      409,
      "INSUFFICIENT_BALANCE",
      "CLAIM_NO_GAS_SOURCE",
    );
  });

  it("refuses a paused or underfunded contract, a reverting simulation, and a non-embedded wallet", async () => {
    const paused = defaultClaimChainState();
    paused.paused = true;
    expectError(
      await prepare((await createApp({ chain: paused })).app),
      503,
      "CAPABILITY_UNAVAILABLE",
      "MINING_CLAIM_CONTRACT_PAUSED",
    );
    const poor = defaultClaimChainState();
    poor.balance = loop;
    expectError(
      await prepare((await createApp({ chain: poor })).app),
      503,
      "CAPABILITY_UNAVAILABLE",
      "MINING_CLAIM_FUNDING_INSUFFICIENT",
    );
    expectError(
      await prepare(
        (await createApp({ funds: { simulation: "reverted" } })).app,
      ),
      409,
      "SIMULATION_FAILED",
      "MINING_CLAIM_SIMULATION_REVERTED",
    );
    expectError(
      await prepare((await createApp({ wallet: { kind: "external" } })).app),
      422,
      "VALIDATION_FAILED",
      "MINING_CLAIM_WALLET_NOT_EMBEDDED",
    );
    const down = defaultClaimChainState();
    down.unavailable = true;
    expectError(
      await prepare((await createApp({ chain: down })).app),
      503,
      "CAPABILITY_UNAVAILABLE",
      "MINING_CLAIM_CHAIN_READ_FAILED",
    );
  });

  it("§9-11/§9-12 report: submitting → confirming → succeeded once; claimable drops while the display keeps its own progress", async () => {
    const { app, repository, chain } = await createApp();
    const claim = (await prepare(app)).json<{ claim: { claimId: string } }>()
      .claim;
    const hash = `0x${"ab".repeat(32)}`;
    const report = (key: string, transactionHash = hash) =>
      post(
        app,
        "/v2/mining/claim/report",
        { claimId: claim.claimId, transactionHash },
        key,
      );
    const submitted = await report(s7IdempotencyKey("2"));
    expect(submitted.statusCode).toBe(200);
    for (const key of requiredOf(miningClaimReportResourceSchema)) {
      expect(Object.hasOwn(submitted.json<object>(), key), key).toBe(true);
    }
    expect(submitted.json()).toMatchObject({
      claim: { status: "submitting", transactionHash: hash },
    });
    // While a claim is in flight another prepare is refused.
    expectError(
      await prepare(app, s7IdempotencyKey("9")),
      409,
      "RESOURCE_CONFLICT",
      "MINING_CLAIM_IN_FLIGHT",
    );
    landClaim(chain, {
      wallet: walletAddress,
      cumulativeAmountRaw: 60n * loop,
      confirmations: 1n,
      transactionHash: hash,
    });
    expect((await report(s7IdempotencyKey("3"))).json()).toMatchObject({
      claim: { status: "confirming" },
    });
    chain.receipts.set(hash, {
      ...(chain.receipts.get(hash) as Extract<
        MiningClaimReceipt,
        { kind: "mined" }
      >),
      confirmations: 5n,
    });
    expect((await report(s7IdempotencyKey("4"))).json()).toMatchObject({
      claim: { status: "succeeded", amountRaw: (60n * loop).toString() },
    });
    // Same hash again (new key and replayed key): no second ledger move.
    expect((await report(s7IdempotencyKey("5"))).statusCode).toBe(200);
    expect((await report(s7IdempotencyKey("4"))).statusCode).toBe(200);
    expect(repository?.balances.get(s7AccountId)).toEqual({
      settled: 60n * loop,
      claimed: 60n * loop,
    });
    // §9-12: claimable is 0 although the minute display is still running.
    const hourly = (await get(app, "/v2/mining/rewards")).json<{
      hourly: Record<string, Record<string, unknown>>;
    }>().hourly;
    expect(hourly["totals"]?.["claimableRaw"]).toBe("0");
    expect(hourly["display"]?.["displayedRaw"]).toBe((20n * loop).toString());
    expect(hourly["claim"]?.["latest"]).toMatchObject({ status: "succeeded" });
    // Another hash on the same claim is a conflict.
    expectError(
      await report(s7IdempotencyKey("6"), `0x${"cd".repeat(32)}`),
      409,
      "RESOURCE_CONFLICT",
      "MINING_CLAIM_TRANSACTION_CONFLICT",
    );
  });

  it("§9-11 链上失败：reverted 交易标记失败，可领取不变；不属于本凭证的交易不记录", async () => {
    const { app, repository, chain } = await createApp();
    const claim = (await prepare(app)).json<{ claim: { claimId: string } }>()
      .claim;
    const other = `0x${"ef".repeat(32)}`;
    chain.receipts.set(other, {
      kind: "mined",
      blockNumber: 900n,
      confirmations: 10n,
      logs: [],
    });
    expectError(
      await post(
        app,
        "/v2/mining/claim/report",
        { claimId: claim.claimId, transactionHash: other },
        s7IdempotencyKey("7"),
      ),
      409,
      "DATA_STALE",
      "MINING_CLAIM_TRANSACTION_MISMATCH",
    );
    expect(repository?.claims.get(claim.claimId)?.status).toBe("claimable");
    const reverted = `0x${"12".repeat(32)}`;
    chain.receipts.set(reverted, { kind: "reverted", blockNumber: 901n });
    const failed = await post(
      app,
      "/v2/mining/claim/report",
      { claimId: claim.claimId, transactionHash: reverted },
      s7IdempotencyKey("8"),
    );
    expect(failed.json()).toMatchObject({
      claim: { status: "failed", failureReasonCode: "MINING_CLAIM_REVERTED" },
    });
    expect(repository?.balances.get(s7AccountId)?.claimed).toBe(0n);
    // A failed claim does not block a new prepare.
    expect((await prepare(app, s7IdempotencyKey("c"))).statusCode).toBe(201);
  });

  it("a newer voucher dies by nonce: the landed one succeeds via its log, the other expires", async () => {
    const { app, repository, chain, setNow } = await createApp();
    const service = createMiningRewardsService({
      repository,
      chain: createFakeClaimChain(chain),
      callClient: null,
      wallets: null,
      signer: null,
      contractAddress: claimContract,
      chainId: "eip155:97",
      writesEnabled: false,
      usdtAddress: null,
      confirmations: 3,
      cursorCodec: null,
      now: () => new Date("2026-10-10T11:40:00.000Z"),
    });
    const first = (await prepare(app, s7IdempotencyKey("d"))).json<{
      claim: { claimId: string };
    }>().claim;
    const second = (await prepare(app, s7IdempotencyKey("e"))).json<{
      claim: { claimId: string };
    }>().claim;
    expect(first.claimId).not.toBe(second.claimId);
    // The device sent the first voucher but never reported it.
    landClaim(chain, {
      wallet: walletAddress,
      cumulativeAmountRaw: 60n * loop,
    });
    for (const claim of await repository!.listUnresolvedClaims(10)) {
      await service.reconcileClaim(claim);
    }
    const statuses = [first, second].map(
      (claim) => repository?.claims.get(claim.claimId)?.status,
    );
    expect(statuses.sort()).toEqual(["expired", "succeeded"]);
    expect(repository?.balances.get(s7AccountId)?.claimed).toBe(60n * loop);
    // A later settlement: the next voucher carries the new nonce and the
    // cumulative grows from the wallet's on-chain claimed amount.
    repository!.balances.set(s7AccountId, {
      settled: 90n * loop,
      claimed: 60n * loop,
    });
    setNow(new Date("2026-10-10T12:05:00.000Z"));
    const next = await prepare(app, s7IdempotencyKey("f"));
    expect(next.json()).toMatchObject({
      claim: {
        nonce: "1",
        cumulativeAmountRaw: (90n * loop).toString(),
        amountRaw: (30n * loop).toString(),
      },
    });
  });

  it("expires an unused voucher after its deadline", async () => {
    const { app, repository, chain } = await createApp();
    const claim = (await prepare(app)).json<{ claim: { claimId: string } }>()
      .claim;
    const service = createMiningRewardsService({
      repository,
      chain: createFakeClaimChain(chain),
      callClient: null,
      wallets: null,
      signer: null,
      contractAddress: claimContract,
      chainId: "eip155:97",
      writesEnabled: false,
      usdtAddress: null,
      confirmations: 3,
      cursorCodec: null,
      now: () => new Date("2026-10-10T11:40:00.000Z"),
    });
    await service.reconcileClaim(repository!.claims.get(claim.claimId)!);
    expect(repository?.claims.get(claim.claimId)?.status).toBe("expired");
    expect(repository?.balances.get(s7AccountId)?.claimed).toBe(0n);
  });

  it("refuses a malformed report body and an unknown claim", async () => {
    const { app } = await createApp();
    const malformed = await post(app, "/v2/mining/claim/report", {
      claimId: "nope",
      transactionHash: "0x1",
    });
    expect(malformed.statusCode).toBe(400);
    expectError(
      await post(app, "/v2/mining/claim/report", {
        claimId: "f64786bb-408d-415d-8a69-6277d56c921b",
        transactionHash: `0x${"aa".repeat(32)}`,
      }),
      404,
      "NOT_FOUND",
      "MINING_CLAIM_NOT_FOUND",
    );
  });
});
