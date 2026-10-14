import { describe, expect, it, vi } from "vitest";

import type { HooksLaunchExecutorConfig } from "../src/config.js";
import { chainGuardDefaults } from "../src/features/chain-guard/chain-guard-contract.js";
import type { ChainGuardTargets } from "../src/features/chain-guard/chain-guard-collect.js";
import {
  createChainGuardHoldCheck,
  createChainGuardHoldGate,
  type ChainGuardHoldTransition,
} from "../src/features/chain-guard/chain-guard-hold.js";
import {
  createChainGuardLane,
  type ChainGuardIncidentEvent,
} from "../src/features/chain-guard/chain-guard-lane.js";
import { createLaunch2BuybackKeeperLane } from "../src/features/launch2/launch2-buyback-keeper-worker.js";
import { createLaunch2DynamicPokeLane } from "../src/features/launch2/launch2-dynamic-poke.js";
import { createHooksLaunchExecutorLane } from "../src/hooks-launch-executor-worker.js";
import {
  createFakeChainGuardChain,
  createInMemoryChainGuardRepository,
  factory,
  guardAddress,
  instanceRecord,
  proxyAdmin,
  usd1,
  usd1Log,
} from "./helpers/chain-guard-fakes.js";

/**
 * Decision 0134: the `chain_guard` lane against a fake chain reader and an
 * in-memory incident store — USD1 pause → incident → the signing lanes
 * hold; unpause → resolved → released; freezes, implementation change,
 * protocol fee, low balance, event incidents, the log cursor.
 */

const chainId = "eip155:97";
const executor = guardAddress(0xe1);

function targets(
  overrides: Partial<ChainGuardTargets> = {},
): ChainGuardTargets {
  return {
    chainId,
    chainReference: 97,
    usd1Address: usd1,
    factories: [factory],
    poolManagerAddress: null,
    poolRouterAddress: guardAddress(0x2007),
    watch: [],
    balanceAccounts: [{ address: executor, label: "hooksLaunchExecutor" }],
    ...overrides,
  };
}

function harness(
  options: {
    readonly chain?: Parameters<typeof createFakeChainGuardChain>[0];
    readonly targets?: Partial<ChainGuardTargets>;
    readonly expectedImplementation?: string | null;
  } = {},
) {
  const instance = instanceRecord(1);
  const repository = createInMemoryChainGuardRepository([instance]);
  const chain = createFakeChainGuardChain(options.chain);
  const events: ChainGuardIncidentEvent[] = [];
  const notices: string[] = [];
  let clock = new Date("2026-10-14T00:00:00.000Z");
  const lane = createChainGuardLane({
    repository,
    chain,
    targets: targets(options.targets),
    policy: {
      expectedImplementation:
        options.expectedImplementation === undefined
          ? guardAddress(0x1111)
          : options.expectedImplementation,
      expectedProtocolFeeController: null,
      protocolFeeAlertPips: 500,
      minBnbWei: 5n * 10n ** 16n,
    },
    confirmations: 5,
    intervalSeconds: 60,
    now: () => clock,
    onIncident: (event) => events.push(event),
    onNotice: (event) => notices.push(event.reasonCode),
  });
  return {
    lane,
    repository,
    chain,
    events,
    notices,
    instance,
    advance(seconds: number) {
      clock = new Date(clock.getTime() + seconds * 1000);
    },
    open: () => repository.rows.filter((row) => row.resolvedAt === null),
  };
}

function throwingProxy<T extends object>(
  values: Record<string, unknown> = {},
): T {
  return new Proxy({} as T, {
    get: (_target, property) => {
      if (property === "then") return undefined;
      if (typeof property === "string" && property in values) {
        return values[property];
      }
      return () => {
        throw new Error(`unexpected call ${String(property)}`);
      };
    },
  });
}

describe("chain_guard lane (Decision 0134)", () => {
  it("idles quietly on a clean testnet chain", async () => {
    const h = harness();
    const result = await h.lane.runOnce();
    expect(result).toMatchObject({ kind: "checked", openedCount: 0 });
    expect(h.repository.rows).toEqual([]);
    // 6 instance roles + router + 6 Factory reads (poolManager, tax
    // receiver, fee vault, 3 keepers) + the executor account.
    expect(result["watchedCount"]).toBe(14);
    expect(h.repository.cursors.get(chainId)).toBe(10_000n - 5n);
    expect(h.notices).toEqual(["CHAIN_GUARD_CHECK_NOT_CONFIGURED"]);
  });

  it("idles with the reason when the testnet token lacks paused / frozen", async () => {
    const h = harness({
      chain: { paused: null, frozenSupported: false, implementation: null },
      expectedImplementation: null,
    });
    const result = await h.lane.runOnce();
    expect(result).toMatchObject({
      kind: "checked",
      openedCount: 0,
      unsupported: ["usd1.paused", "usd1.frozen"],
    });
    expect(h.repository.rows).toEqual([]);
  });

  it("on mainnet an unsupported USD1 read is an incident", async () => {
    const h = harness({
      chain: { chainId: 56, paused: null },
      targets: { chainId: "eip155:56", chainReference: 56 },
    });
    await h.lane.runOnce();
    expect(h.open().map((row) => row.kind)).toEqual(["usd1_read_unsupported"]);
  });

  it("is unavailable on the wrong chain and without a USD1 address", async () => {
    const wrong = harness({ chain: { chainId: 56 } });
    expect(await wrong.lane.runOnce()).toEqual({
      kind: "unavailable",
      reasonCode: "CHAIN_GUARD_CHAIN_MISMATCH",
    });
    const missing = harness({
      chain: { factory: null },
      targets: { usd1Address: null, factories: [] },
    });
    expect(await missing.lane.runOnce()).toEqual({
      kind: "unavailable",
      reasonCode: "CHAIN_GUARD_USD1_NOT_CONFIGURED",
    });
    expect(missing.notices).toEqual(["CHAIN_GUARD_USD1_NOT_CONFIGURED"]);
    // Reported once while it persists.
    await missing.lane.runOnce();
    expect(missing.notices).toHaveLength(1);
  });

  it("pause → incident → the signing lanes hold; unpause → resolved → released", async () => {
    const h = harness();
    const transitions: ChainGuardHoldTransition[] = [];
    const gate = createChainGuardHoldGate(h.repository, chainId);
    const hold = (lane: string) =>
      createChainGuardHoldCheck(lane, gate, (event) => transitions.push(event));

    const pokeChain = {
      chainId: vi.fn(() => Promise.resolve(97)),
      readPokeState: vi.fn(),
      simulatePoke: vi.fn(),
      sendPoke: vi.fn(),
      pokerAddress: guardAddress(0x90e),
    };
    const poke = createLaunch2DynamicPokeLane({
      repository: { listLaneInstances: () => Promise.resolve([]) },
      chain: pokeChain,
      chainId,
      intervalSeconds: 60,
      chainGuardHold: hold("launch2_dynamic_poke"),
    });
    const keeper = createLaunch2BuybackKeeperLane({
      repository: throwingProxy(),
      chain: throwingProxy({ keeperAddress: guardAddress(0xbee1) }),
      policy: {
        chainId,
        factoryAddress: factory,
        confirmations: 12,
        intervalSeconds: 15,
        maxGasPriceWei: 1n,
        gasLimitCap: 1n,
        retryDelaySeconds: 60,
        maxBackoffSeconds: 600,
      },
      chainGuardHold: hold("launch2_buyback_keeper"),
    });
    const hooks = createHooksLaunchExecutorLane({
      repository: throwingProxy(),
      chain: throwingProxy({ executorAddress: executor }),
      config: {
        factoryCodeHash: `0x${"ab".repeat(32)}`,
        confirmations: 3,
        maxAttempts: 3,
        retryDelaySeconds: 60,
        gasLimitCap: 16_000_000,
        maxGasPriceGwei: 20,
        pollIntervalMs: 5_000,
      } as unknown as HooksLaunchExecutorConfig,
      executorId: "hooks-executor:test",
      chainGuardHold: hold("hooks_launch_executor"),
    });

    // Clean: the poke lane runs its tick.
    expect(await poke.runOnce()).toMatchObject({ kind: "advanced" });
    expect(pokeChain.chainId).toHaveBeenCalledTimes(1);

    // USD1 paused (Paused log + paused() = true).
    h.chain.state.logs.push(
      usd1Log("Paused", 9_990n, { account: guardAddress(0x2ce4) }),
    );
    h.chain.state.paused = true;
    await h.lane.runOnce();
    expect(h.open().map((row) => [row.kind, row.subject])).toEqual([
      ["usd1_paused", usd1],
    ]);
    expect(
      h.events.map((event) => [event.change, event.incident.kind]),
    ).toEqual([["opened", "usd1_paused"]]);

    for (const lane of [poke, keeper, hooks]) {
      expect(await lane.runOnce()).toEqual({
        kind: "held",
        reasonCode: "CHAIN_GUARD_HOLD",
        holdCount: 1,
      });
    }
    expect(pokeChain.chainId).toHaveBeenCalledTimes(1);
    expect(transitions.map((event) => [event.lane, event.held])).toEqual([
      ["launch2_dynamic_poke", true],
      ["launch2_buyback_keeper", true],
      ["hooks_launch_executor", true],
    ]);
    // A second held tick reports nothing new.
    await poke.runOnce();
    expect(transitions).toHaveLength(3);

    // Still paused next tick: same incident, last_seen moves.
    h.advance(60);
    await h.lane.runOnce();
    expect(h.open()).toHaveLength(1);
    expect(h.open()[0]?.lastSeenAt).toBe("2026-10-14T00:01:00.000Z");
    expect(h.events).toHaveLength(1);

    // Unpaused.
    h.chain.state.paused = false;
    h.chain.state.head = 10_010n;
    h.chain.state.logs.push(usd1Log("Unpaused", 10_001n));
    h.advance(60);
    await h.lane.runOnce();
    expect(h.open()).toEqual([]);
    expect(
      h.events.map((event) => [event.change, event.incident.kind]),
    ).toEqual([
      ["opened", "usd1_paused"],
      ["resolved", "usd1_paused"],
    ]);
    expect(h.repository.rows[0]?.resolvedAt).toBe("2026-10-14T00:02:00.000Z");

    expect(await poke.runOnce()).toMatchObject({ kind: "advanced" });
    expect(transitions.at(-1)).toMatchObject({
      lane: "launch2_dynamic_poke",
      held: false,
      reasonCode: "CHAIN_GUARD_HOLD_RELEASED",
    });
  });

  it("a freeze of one of our addresses holds; a freeze of a stranger does not", async () => {
    const h = harness();
    const stranger = guardAddress(0xdead);
    h.chain.state.logs.push(
      usd1Log("Freeze", 9_000n, {
        caller: guardAddress(0x82ac),
        account: stranger,
      }),
    );
    await h.lane.runOnce();
    expect(h.open()).toEqual([]);

    h.chain.state.frozen.set(h.instance.escrow, true);
    h.advance(60);
    await h.lane.runOnce();
    expect(h.open().map((row) => [row.kind, row.subject])).toEqual([
      ["usd1_address_frozen", h.instance.escrow],
    ]);
    expect(h.open()[0]?.details["labels"]).toEqual([
      `instance:${h.instance.instanceId}:escrow`,
    ]);
    expect(
      await createChainGuardHoldGate(h.repository, chainId).holds(),
    ).toHaveLength(1);

    h.chain.state.frozen.set(h.instance.escrow, false);
    h.advance(60);
    await h.lane.runOnce();
    expect(h.open()).toEqual([]);
  });

  it("records implementation changes, protocol fees, and low balances without holding", async () => {
    const h = harness();
    h.chain.state.implementation = guardAddress(0x2222);
    h.chain.state.protocolFee.set(h.instance.poolId as string, 600);
    h.chain.state.balances.set(executor, 4n * 10n ** 16n);
    await h.lane.runOnce();
    const open = h
      .open()
      .map((row) => row.kind)
      .sort();
    expect(open).toEqual([
      "account_balance_low",
      "pool_protocol_fee_high",
      "pool_protocol_fee_nonzero",
      "usd1_implementation_changed",
    ]);
    const balance = h.open().find((row) => row.kind === "account_balance_low");
    expect(balance?.subject).toBe(executor);
    expect(balance?.details).toMatchObject({
      balanceBnb: "0.04",
      minimumBnb: "0.05",
      labels: ["hooksLaunchExecutor"],
    });
    expect(
      await createChainGuardHoldGate(h.repository, chainId).holds(),
    ).toEqual([]);

    // Fee falls under the threshold: `high` resolves, `nonzero` stays.
    h.chain.state.protocolFee.set(h.instance.poolId as string, 25);
    h.chain.state.balances.set(executor, 10n ** 17n);
    h.advance(60);
    await h.lane.runOnce();
    expect(
      h
        .open()
        .map((row) => row.kind)
        .sort(),
    ).toEqual(["pool_protocol_fee_nonzero", "usd1_implementation_changed"]);
  });

  it("keeps an event incident open for 24 hours, then resolves it", async () => {
    const h = harness();
    h.chain.state.logs.push(
      usd1Log("Upgraded", 9_500n, { implementation: guardAddress(0x3333) }),
      usd1Log(
        "OwnershipTransferred",
        9_600n,
        { previousOwner: guardAddress(0x6a8d), newOwner: guardAddress(0x6a8e) },
        proxyAdmin,
      ),
      usd1Log("FrozenAccountDrained", 9_700n, {
        caller: guardAddress(1),
        account: guardAddress(0xdead),
        amount: "5",
      }),
    );
    await h.lane.runOnce();
    expect(h.open().map((row) => row.kind)).toEqual([
      "usd1_upgraded",
      "usd1_proxy_admin_ownership_transferred",
    ]);
    h.advance(23 * 3600);
    await h.lane.runOnce();
    expect(h.open()).toHaveLength(2);
    h.advance(3600 + 1);
    await h.lane.runOnce();
    expect(h.open()).toEqual([]);
  });

  it("reads logs from the cursor in bounded ranges", async () => {
    const h = harness({ chain: { head: 30_005n } });
    h.repository.cursors.set(chainId, 9_999n);
    await h.lane.runOnce();
    const range = chainGuardDefaults.maxLogRange;
    expect(h.chain.state.logQueries).toEqual([
      { fromBlock: 10_000n, toBlock: 10_000n + range - 1n },
      { fromBlock: 12_000n, toBlock: 13_999n },
      { fromBlock: 14_000n, toBlock: 15_999n },
      { fromBlock: 16_000n, toBlock: 17_999n },
      { fromBlock: 18_000n, toBlock: 19_999n },
    ]);
    expect(h.repository.cursors.get(chainId)).toBe(19_999n);
    await h.lane.runOnce();
    expect(h.repository.cursors.get(chainId)).toBe(29_999n);
    await h.lane.runOnce();
    expect(h.repository.cursors.get(chainId)).toBe(30_000n);
  });

  it("a failing hold query throws, so the guarded lane backs off instead of acting", async () => {
    const check = createChainGuardHoldCheck("launch2_dynamic_poke", {
      holds: () => Promise.reject(new Error("database down")),
    });
    await expect(check()).rejects.toThrow("database down");
    expect(await createChainGuardHoldCheck("x", undefined)()).toBeNull();
  });
});
