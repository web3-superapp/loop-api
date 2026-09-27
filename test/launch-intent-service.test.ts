import { decodeFunctionData, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";

import { V2ApiError } from "../src/core/http/v2-error.js";
import { buildLaunchMerkleTree } from "../src/features/launch/launch-merkle.js";
import {
  createLaunchService,
  type LaunchService,
} from "../src/features/launch/launch-service.js";
import type { LaunchAllowlistRootRecord } from "../src/features/launch/launch-chain-repository.js";
import type { LaunchDetailRecord } from "../src/features/launch/launch-repository.js";
import { launchpadAbiV1 } from "../src/integrations/launch/launchpad-abi.v1.js";
import {
  createFakeLaunchAdapter,
  createFakeLaunchChainState,
  createFakeLaunchSlotClient,
  fakeLaunchContract,
  fakeNowSeconds,
  type FakeLaunchChainState,
  type FakeLaunchSlotFunds,
} from "./helpers/launch-fake-adapter.js";
import { fixtureBlockHash, oneUsd1 } from "./helpers/launch-lane-fixtures.js";
import {
  accountId,
  chainRepositoryFake,
  launchId,
  launchRepositoryFor,
  registeredDetail,
  roundOneId,
  roundTwoId,
  walletAddress,
  walletId,
  walletsFake,
  writesConfig,
} from "./helpers/launch-service-fakes.js";

/**
 * Decision 0077 Launch purchase Intent prepare: every 06 §4.1 check refuses
 * with its own reason code before anything is built, the canary of 0065
 * applies with USD1 at par, the Idempotency-Key replays, and a success binds
 * every 03 §8.2 field. All chain values are test fixtures.
 */

const principal = Object.freeze({
  userId: accountId,
  privyUserId: "did:privy:verified-user",
}) as never;
const other = "0x00000000000000000000000000000000000000bb";

function rootRecord(
  members: readonly string[],
  roundIndex = 1,
): LaunchAllowlistRootRecord {
  const tree = buildLaunchMerkleTree(members);
  return {
    allowlistRootId: "8b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
    launchId,
    roundIndex,
    snapshotBlock: "880",
    snapshotBlockHash: fixtureBlockHash(880n),
    root: tree.root,
    leafCount: tree.leafCount,
    mode: "whitelist",
    members: tree.members,
    computedAt: "2026-09-21T00:00:00.000Z",
  };
}

interface Scenario {
  readonly chainState?: Partial<FakeLaunchChainState>;
  readonly funds?: Partial<FakeLaunchSlotFunds>;
  readonly writes?: Parameters<typeof writesConfig>[0] | null;
  readonly roots?: readonly LaunchAllowlistRootRecord[];
  readonly detail?: LaunchDetailRecord;
  readonly exposureUsd?: string;
}

function setup(scenario: Scenario = {}) {
  const state = createFakeLaunchChainState(scenario.chainState);
  const chain = chainRepositoryFake({ roots: scenario.roots ?? [] });
  const service: LaunchService = createLaunchService({
    repository: launchRepositoryFor(scenario.detail ?? registeredDetail()),
    cursorCodec: null,
    contract: createFakeLaunchAdapter(state),
    chain,
    wallets: walletsFake(),
    now: () => new Date(Number(fakeNowSeconds) * 1000),
    intentRuntime: {
      writes:
        scenario.writes === null ? null : writesConfig(scenario.writes ?? {}),
      readClient: createFakeLaunchSlotClient({
        usd1Balance: 1_000n * oneUsd1,
        allowance: 1_000n * oneUsd1,
        nativeBalance: 10n ** 17n,
        simulation: "passed",
        ...scenario.funds,
      }),
      wallets: walletsFake(),
      walletIntentExposureUsd: () =>
        Promise.resolve(scenario.exposureUsd ?? "0"),
      now: () => new Date(Number(fakeNowSeconds) * 1000),
      createUuid: () => "7a2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
    },
  });
  return { service, chain, state };
}

function prepare(
  service: LaunchService,
  body: Record<string, unknown> = {},
  key = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbba",
) {
  return service.prepareIntent({
    principal,
    launchId,
    body: { walletId, roundId: roundOneId, payAmount: "10", ...body },
    idempotencyKey: key,
    requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  });
}

async function refusal(promise: Promise<unknown>): Promise<{
  code: string;
  reasonCode: unknown;
  details: unknown;
}> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof V2ApiError) {
      return {
        code: error.code,
        reasonCode: error.detailsSafe?.["reasonCode"] ?? null,
        details: error.detailsSafe,
      };
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("Launch Intent prepare (Decision 0077)", () => {
  it("binds every 03 §8.2 field and builds buy() in 06 §4.1 order", async () => {
    const { service, state } = setup();
    const { created, resource } = await prepare(service);
    expect(created).toBe(true);
    const intent = resource.launchIntent;
    expect(intent).toMatchObject({
      launchIntentId: "7a2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
      state: "awaiting_signature",
      launchId,
      walletId,
      roundId: roundOneId,
      roundIndex: 1,
      chainId: "eip155:97",
      contractAddress: fakeLaunchContract.address,
      quoteAssetId: `eip155:97:${fakeLaunchContract.usd1Address}`,
      usd1Amount: (10n * oneUsd1).toString(),
      expectedTokenAmount: (1_000n * oneUsd1).toString(),
      minTokenAmount: (1_000n * oneUsd1).toString(),
      walletCumulativeUsd1: (100n * oneUsd1).toString(),
      eligibilityProof: [],
      configVersion: state.tuple.configVersion,
      stateTupleDigest: state.tuple.stateTupleDigest,
      snapshotBlockNumber: "900",
      snapshotBlockHash: fixtureBlockHash(900n),
      policy: { valueUsd: "10", priceSource: "usd1_par", canaryMaxUsd: "50" },
      signing: {
        mode: "device_eth_send_transaction",
        allowed: true,
        reasonCode: null,
      },
      simulation: { status: "passed", reasonCode: null },
      saleId: "7",
      walletRoundCapUsd1: (500n * oneUsd1).toString(),
      walletProjectCapUsd1: (1_000n * oneUsd1).toString(),
      transactionHash: null,
    });
    expect(intent["payloadDigest"]).toMatch(/^[0-9a-f]{64}$/);
    expect(intent["deadline"]).toBe(
      new Date(Number(fakeNowSeconds + 120n) * 1000).toISOString(),
    );
    const tx = intent["unsignedTransaction"] as Record<string, unknown>;
    expect(tx).toMatchObject({
      chainId: 97,
      to: fakeLaunchContract.address,
      value: "0x0",
      from: walletAddress,
      nonce: "0x3",
      type: "legacy",
    });
    const decoded = decodeFunctionData({
      abi: launchpadAbiV1,
      data: tx["data"] as Hex,
    });
    expect(decoded.functionName).toBe("buy");
    expect(decoded.args).toEqual([
      7n,
      1,
      10n * oneUsd1,
      1_000n * oneUsd1,
      fakeNowSeconds + 120n,
      [],
    ]);
    // Every amount is a decimal string.
    expect(JSON.stringify(resource)).not.toMatch(
      /"(usd1Amount|expectedTokenAmount|minTokenAmount|walletCumulativeUsd1)":\d/,
    );
  });

  it("replays the same Idempotency-Key without a second build and refuses another body", async () => {
    const { service, chain } = setup();
    const first = await prepare(service);
    const replay = await prepare(service);
    expect(replay.created).toBe(false);
    expect(replay.resource.launchIntent["launchIntentId"]).toBe(
      first.resource.launchIntent["launchIntentId"],
    );
    expect(chain.builds).toBe(1);
    expect(await refusal(prepare(service, { payAmount: "11" }))).toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
  });

  it("stays the bare CAPABILITY_UNAVAILABLE without BSC_WRITES_ENABLED or contract keys", async () => {
    const { service } = setup({ writes: null });
    const error = await prepare(service).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(V2ApiError);
    expect(error).toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      detailsSafe: null,
    });
    const noContract = createLaunchService({
      repository: launchRepositoryFor(registeredDetail()),
      cursorCodec: null,
      contract: createFakeLaunchAdapter(createFakeLaunchChainState(), null),
      chain: chainRepositoryFake(),
      wallets: walletsFake(),
    });
    await expect(prepare(noContract)).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      detailsSafe: null,
    });
  });

  it("proves eligibility for an allowlisted round and refuses a non-member or a root mismatch", async () => {
    const root = rootRecord([walletAddress, other]);
    const rounds = createFakeLaunchChainState().rounds.map((round) =>
      round.roundId === 1 ? { ...round, allowlistRoot: root.root } : round,
    );
    const ok = setup({ chainState: { rounds }, roots: [root] });
    const { resource } = await prepare(ok.service);
    const proof = buildLaunchMerkleTree(root.members).proofFor(walletAddress);
    expect(resource.launchIntent["eligibilityProof"]).toEqual(proof);

    const outsider = setup({
      chainState: { rounds },
      roots: [rootRecord([other])],
    });
    expect(await refusal(prepare(outsider.service))).toMatchObject({
      code: "POLICY_BLOCKED",
      reasonCode: "LAUNCH_ALLOWLIST_ROOT_MISMATCH",
    });
    const notMember = rootRecord([
      other,
      "0x00000000000000000000000000000000000000cc",
    ]);
    const notMemberRounds = rounds.map((round) =>
      round.roundId === 1 ? { ...round, allowlistRoot: notMember.root } : round,
    );
    const refused = setup({
      chainState: { rounds: notMemberRounds },
      roots: [notMember],
    });
    expect(await refusal(prepare(refused.service))).toMatchObject({
      code: "POLICY_BLOCKED",
      reasonCode: "LAUNCH_WALLET_NOT_ELIGIBLE",
    });
    const none = setup({ chainState: { rounds } });
    expect(await refusal(prepare(none.service))).toMatchObject({
      reasonCode: "LAUNCH_ALLOWLIST_NOT_COMPUTED",
    });
  });

  it("prepares an open round (all-zero root) without a proof, a stored root, or a confirmed mode (Decision 0084)", async () => {
    const detail = registeredDetail("");
    const { service, chain } = setup({ detail });
    const listRoots = vi.spyOn(chain, "listAllowlistRoots");
    const { created, resource } = await prepare(service);
    expect(created).toBe(true);
    expect(resource.launchIntent["eligibilityProof"]).toEqual([]);
    expect(listRoots).not.toHaveBeenCalled();
  });

  it("refuses a non-zero-root round while tierModeV1 is unconfirmed with TIER_MODE_PENDING (S83b6)", async () => {
    const root = rootRecord([walletAddress, other]);
    const rounds = createFakeLaunchChainState().rounds.map((round) =>
      round.roundId === 1 ? { ...round, allowlistRoot: root.root } : round,
    );
    const pending = setup({
      chainState: { rounds },
      roots: [root],
      detail: registeredDetail(""),
    });
    const listRoots = vi.spyOn(pending.chain, "listAllowlistRoots");
    expect(await refusal(prepare(pending.service))).toMatchObject({
      code: "POLICY_BLOCKED",
      reasonCode: "TIER_MODE_PENDING",
    });
    expect(listRoots).not.toHaveBeenCalled();
  });

  it("prepares the same non-zero-root round once tierModeV1 is confirmed (S83b6)", async () => {
    const root = rootRecord([walletAddress, other]);
    const rounds = createFakeLaunchChainState().rounds.map((round) =>
      round.roundId === 1 ? { ...round, allowlistRoot: root.root } : round,
    );
    const confirmed = setup({
      chainState: { rounds },
      roots: [root],
      detail: registeredDetail("whitelist"),
    });
    const { created, resource } = await prepare(confirmed.service);
    expect(created).toBe(true);
    expect(resource.launchIntent["eligibilityProof"]).toEqual(
      buildLaunchMerkleTree(root.members).proofFor(walletAddress),
    );
  });

  const base = createFakeLaunchChainState();
  const round1 = base.rounds[0]!;
  const cases: readonly {
    readonly name: string;
    readonly scenario: Scenario;
    readonly body?: Record<string, unknown>;
    readonly code: string;
    readonly reasonCode: string;
    readonly details?: Record<string, unknown>;
  }[] = [
    {
      name: "sale not LIVE",
      scenario: {
        chainState: { tuple: { ...base.tuple, saleState: "ENDED" } },
      },
      code: "DATA_STALE",
      reasonCode: "LAUNCH_SALE_NOT_LIVE",
      details: { saleState: "ENDED" },
    },
    {
      name: "paused",
      scenario: {
        chainState: { tuple: { ...base.tuple, operationalState: "PAUSED" } },
      },
      code: "DATA_STALE",
      reasonCode: "LAUNCH_SALE_PAUSED",
    },
    {
      name: "round not open yet",
      body: { roundId: roundTwoId },
      scenario: {},
      code: "DATA_STALE",
      reasonCode: "LAUNCH_ROUND_NOT_OPEN",
    },
    {
      name: "round window over",
      scenario: {
        chainState: { rounds: [{ ...round1, endAt: fakeNowSeconds }] },
      },
      code: "DATA_STALE",
      reasonCode: "LAUNCH_ROUND_NOT_OPEN",
    },
    {
      name: "round not on chain",
      scenario: { chainState: { rounds: [base.rounds[1]!] } },
      code: "DATA_STALE",
      reasonCode: "LAUNCH_ROUND_NOT_ON_CHAIN",
    },
    {
      name: "deadline too close to the round end",
      scenario: {
        chainState: { rounds: [{ ...round1, endAt: fakeNowSeconds + 10n }] },
      },
      code: "DATA_STALE",
      reasonCode: "LAUNCH_DEADLINE_TOO_CLOSE",
    },
    {
      name: "config version drift",
      scenario: {
        chainState: {
          config: { ...base.config, configVersion: `0x${"ee".repeat(32)}` },
        },
      },
      code: "DATA_STALE",
      reasonCode: "LAUNCH_CONFIG_VERSION_MISMATCH",
    },
    {
      name: "below minPurchase",
      body: { payAmount: "9.99" },
      scenario: {},
      code: "VALIDATION_FAILED",
      reasonCode: "LAUNCH_BELOW_MIN_PURCHASE",
      details: { minPurchaseUsd1: (10n * oneUsd1).toString() },
    },
    {
      name: "wallet round cap",
      body: { payAmount: "401" },
      scenario: { writes: { canaryMaxUsd: "1000", canaryDailyMaxUsd: null } },
      code: "VALIDATION_FAILED",
      reasonCode: "LAUNCH_WALLET_ROUND_CAP_EXCEEDED",
      details: { remainingUsd1: (400n * oneUsd1).toString() },
    },
    {
      name: "wallet project cap",
      body: { payAmount: "300" },
      scenario: {
        writes: { canaryMaxUsd: "1000", canaryDailyMaxUsd: null },
        chainState: {
          position: { ...base.position, cumulativeUsd1: 800n * oneUsd1 },
        },
      },
      code: "VALIDATION_FAILED",
      reasonCode: "LAUNCH_WALLET_PROJECT_CAP_EXCEEDED",
      details: { remainingUsd1: (200n * oneUsd1).toString() },
    },
    {
      name: "round cap",
      scenario: {
        chainState: {
          rounds: [
            { ...round1, raisedUsd1: 39_995n * oneUsd1 },
            base.rounds[1]!,
          ],
        },
      },
      code: "VALIDATION_FAILED",
      reasonCode: "LAUNCH_ROUND_CAP_EXCEEDED",
      details: { remainingUsd1: (5n * oneUsd1).toString() },
    },
    {
      name: "hard cap",
      scenario: {
        chainState: {
          rounds: [
            round1,
            { ...base.rounds[1]!, raisedUsd1: 98_995n * oneUsd1 },
          ],
        },
      },
      code: "VALIDATION_FAILED",
      reasonCode: "LAUNCH_HARD_CAP_EXCEEDED",
      details: { remainingUsd1: (5n * oneUsd1).toString() },
    },
    {
      name: "zero quote",
      scenario: { chainState: { tokensPerUsd1: 0n } },
      code: "VALIDATION_FAILED",
      reasonCode: "LAUNCH_QUOTE_ZERO",
    },
    {
      name: "USD1 not in the canary",
      scenario: { writes: { canaryAssetIds: ["eip155:56:native"] } },
      code: "POLICY_BLOCKED",
      reasonCode: "ASSET_NOT_IN_CANARY_ALLOWLIST",
    },
    {
      name: "contract outside the counterparty allowlist",
      scenario: { writes: { canaryCounterpartyAddresses: [other] } },
      code: "POLICY_BLOCKED",
      reasonCode: "COUNTERPARTY_NOT_IN_CANARY_ALLOWLIST",
    },
    {
      name: "per-intent canary ceiling",
      body: { payAmount: "60" },
      scenario: {},
      code: "POLICY_BLOCKED",
      reasonCode: "CANARY_CEILING_EXCEEDED",
      details: { exposureUsd: "60", ceilingUsd: "50" },
    },
    {
      name: "daily canary ceiling",
      scenario: { exposureUsd: "95" },
      code: "POLICY_BLOCKED",
      reasonCode: "CANARY_DAILY_CEILING_EXCEEDED",
      details: { spentUsd: "95", remainingUsd: "5" },
    },
    {
      name: "USD1 balance",
      scenario: { funds: { usd1Balance: oneUsd1 } },
      code: "INSUFFICIENT_BALANCE",
      reasonCode: "LAUNCH_USD1_BALANCE_INSUFFICIENT",
    },
    {
      name: "USD1 allowance",
      scenario: { funds: { allowance: oneUsd1 } },
      code: "INSUFFICIENT_BALANCE",
      reasonCode: "LAUNCH_USD1_ALLOWANCE_INSUFFICIENT",
      details: { allowanceUsd1: oneUsd1.toString() },
    },
    {
      name: "native gas",
      scenario: { funds: { nativeBalance: 1n } },
      code: "INSUFFICIENT_BALANCE",
      reasonCode: "LAUNCH_GAS_INSUFFICIENT",
    },
    {
      name: "chain unreadable",
      scenario: { chainState: { unavailable: "LAUNCH_CONTRACT_READ_FAILED" } },
      code: "CAPABILITY_UNAVAILABLE",
      reasonCode: "LAUNCH_CONTRACT_READ_FAILED",
    },
  ];
  for (const scenario of cases) {
    it(`refuses: ${scenario.name}`, async () => {
      const { service, chain } = setup(scenario.scenario);
      const result = await refusal(prepare(service, scenario.body));
      expect(result.code).toBe(scenario.code);
      expect(result.reasonCode).toBe(scenario.reasonCode);
      if (scenario.details !== undefined) {
        expect(result.details).toMatchObject(scenario.details);
      }
      // Nothing is stored for a refused prepare.
      expect([...chain.intents.values()]).toEqual([]);
    });
  }

  it("keeps a reverted simulation unsignable instead of refusing", async () => {
    const { service } = setup({ funds: { simulation: "reverted" } });
    const { resource } = await prepare(service);
    expect(resource.launchIntent).toMatchObject({
      state: "prepared",
      simulation: {
        status: "reverted",
        reasonCode: "LAUNCH_SIMULATION_REVERTED",
      },
      signing: { allowed: false, reasonCode: "LAUNCH_SIMULATION_REVERTED" },
    });
  });

  it("refuses an unknown wallet, an unknown round, a non-embedded wallet, and a JSON-number amount", async () => {
    const { service } = setup();
    expect(
      await refusal(
        prepare(service, { walletId: "4b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e" }),
      ),
    ).toMatchObject({ code: "NOT_FOUND" });
    expect(
      await refusal(
        prepare(service, { roundId: "4b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e" }),
      ),
    ).toMatchObject({ code: "NOT_FOUND" });
    expect(await refusal(prepare(service, { payAmount: 10 }))).toMatchObject({
      code: "INVALID_REQUEST",
    });
    expect(await refusal(prepare(service, { payAmount: "0" }))).toMatchObject({
      code: "INVALID_REQUEST",
    });
    const external = createLaunchService({
      repository: launchRepositoryFor(registeredDetail()),
      cursorCodec: null,
      contract: createFakeLaunchAdapter(createFakeLaunchChainState()),
      chain: chainRepositoryFake(),
      wallets: walletsFake(),
      intentRuntime: {
        writes: writesConfig(),
        readClient: createFakeLaunchSlotClient({
          usd1Balance: 0n,
          allowance: 0n,
          nativeBalance: 0n,
          simulation: "passed",
        }),
        wallets: walletsFake({ kind: "external", providerWalletId: null }),
        walletIntentExposureUsd: () => Promise.resolve("0"),
        now: () => new Date(),
        createUuid: () => "7a2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
      },
    });
    expect(await refusal(prepare(external))).toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });

  describe("broadcast report", () => {
    const txHash = `0x${"77".repeat(32)}`;
    function report(
      service: LaunchService,
      launchIntentId: string,
      hash = txHash,
    ) {
      return service.reportIntent({
        principal,
        launchId,
        launchIntentId,
        body: { txHash: hash },
      });
    }

    it("moves awaiting_signature to submitted, is idempotent on the same hash, and refuses another", async () => {
      const { service } = setup();
      const { resource } = await prepare(service);
      const id = resource.launchIntent["launchIntentId"] as string;
      const reported = await report(service, id);
      expect(reported.launchIntent).toMatchObject({
        state: "submitted",
        transactionHash: txHash,
        signing: {
          allowed: false,
          reasonCode: "LAUNCH_INTENT_ALREADY_REPORTED",
        },
      });
      expect((await report(service, id)).launchIntent["transactionHash"]).toBe(
        txHash,
      );
      expect(
        await refusal(report(service, id, `0x${"78".repeat(32)}`)),
      ).toMatchObject({
        code: "DATA_STALE",
        reasonCode: "LAUNCH_INTENT_ALREADY_REPORTED",
      });
    });

    it("verifies an observed transaction against the sealed payload", async () => {
      const mismatch = setup({
        funds: {
          observed: {
            hash: txHash,
            from: walletAddress,
            to: fakeLaunchContract.address,
            input: "0xdeadbeef",
            value: 0n,
            nonce: 3,
            chainId: 97,
            blockNumber: null,
          },
        },
      });
      const { resource } = await prepare(mismatch.service);
      expect(
        await refusal(
          report(
            mismatch.service,
            resource.launchIntent["launchIntentId"] as string,
          ),
        ),
      ).toMatchObject({
        code: "VALIDATION_FAILED",
        reasonCode: "LAUNCH_TX_PAYLOAD_MISMATCH",
      });
    });

    it("refuses an unknown Intent, a malformed hash, an unsignable Intent, and answers 503 without writes", async () => {
      const { service } = setup({ funds: { simulation: "reverted" } });
      const { resource } = await prepare(service);
      const id = resource.launchIntent["launchIntentId"] as string;
      expect(await refusal(report(service, id))).toMatchObject({
        code: "DATA_STALE",
        reasonCode: "LAUNCH_INTENT_NOT_SIGNABLE",
      });
      expect(
        await refusal(report(service, "4b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e")),
      ).toMatchObject({ code: "NOT_FOUND" });
      expect(await refusal(report(service, id, "0x12"))).toMatchObject({
        code: "INVALID_REQUEST",
      });
      const off = setup({ writes: null });
      await expect(report(off.service, id)).rejects.toMatchObject({
        code: "CAPABILITY_UNAVAILABLE",
        detailsSafe: null,
      });
    });
  });
});
