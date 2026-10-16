import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  Launch2KeeperRevertError,
  classifyLaunch2BuybackRevert,
  createLaunch2BuybackKeeper,
  launch2KeeperBackoffSeconds,
  type Launch2BuybackAttemptRecord,
  type Launch2BuybackAttemptRepository,
  type Launch2BuybackAttemptStatus,
  type Launch2BuybackKeeperCandidate,
  type Launch2BuybackKeeperChain,
  type Launch2BuybackKeeperPolicy,
  type Launch2KeeperSendResult,
  type Launch2KeeperStep,
} from "../src/features/launch2/launch2-buyback-keeper.js";
import { createLaunch2BuybackKeeperLane } from "../src/features/launch2/launch2-buyback-keeper-worker.js";

/**
 * Decision 0121 unit suite: the keeper against an in-memory attempt store
 * and a scripted chain — refusal classification, backoff and same-reason
 * dedupe, fail-closed pre-checks, the attempt → broadcast → confirmed →
 * ledger-aligned path, failures, reorg re-send, and the lane's log
 * dedupe. The anvil suite covers the real contracts.
 */

const keeper = "0x5f1175ffb0174332d86ff55eb9b8e885ce90e260";
const fallbackKeeper = "0xcd1ed680556239d1d48822a5a8ea92c8ec1a5279";
const factory = "0x6a69ba7a5a71c114301e20ef95f62cd83d07d9c0";
const dynamicFactory = "0xaf077cab35385027592f959aca185f815c3c5a5a";
const otherKeeper = `0x${"1".repeat(40)}`;
const executor = `0x${"6".repeat(40)}`;
const escrow = `0x${"f".repeat(40)}`;
const wad = 10n ** 18n;

const policy: Launch2BuybackKeeperPolicy = {
  chainId: "eip155:97",
  factoryAddress: factory,
  confirmations: 3,
  intervalSeconds: 15,
  maxGasPriceWei: 20n * 10n ** 9n,
  gasLimitCap: 2_000_000n,
  retryDelaySeconds: 60,
  maxBackoffSeconds: 600,
};

class Clock {
  constructor(public ms = Date.parse("2026-10-10T12:00:00.000Z")) {}
  now = (): Date => new Date(this.ms);
  advance(seconds: number): void {
    this.ms += seconds * 1000;
  }
}

/** In-memory twin of the PostgreSQL repository (same rules, no SQL). */
class MemoryAttempts implements Launch2BuybackAttemptRepository {
  rows: Launch2BuybackAttemptRecord[] = [];
  ledger = new Map<string, string>();
  instance = {
    instanceId: randomUUID(),
    factoryAddress: factory,
    graduated: true,
    buybackPaused: false,
  };

  constructor(private readonly clock: Clock) {}

  private iso(offsetSeconds = 0): string {
    return new Date(this.clock.ms + offsetSeconds * 1000).toISOString();
  }

  private active(): Launch2BuybackAttemptRecord | null {
    return (
      this.rows.find(
        (row) =>
          row.status === "pending" ||
          row.status === "broadcast" ||
          (row.status === "confirmed" && row.buybackId === null),
      ) ?? null
    );
  }

  private replace(
    record: Launch2BuybackAttemptRecord,
    patch: Partial<Launch2BuybackAttemptRecord>,
  ): Launch2BuybackAttemptRecord {
    const next = Object.freeze({
      ...record,
      ...patch,
      updatedAt: this.iso(),
    });
    this.rows = this.rows.map((row) =>
      row.attemptId === record.attemptId ? next : row,
    );
    return next;
  }

  private base(
    status: Launch2BuybackAttemptStatus,
    attempt: number,
  ): Launch2BuybackAttemptRecord {
    return {
      attemptId: randomUUID(),
      instanceId: this.instance.instanceId,
      attempt,
      status,
      keeperAddress: keeper,
      executorAddress: executor,
      simulation: status === "rejected" ? "reverted" : "passed",
      orderUsd1: null,
      simulatedGas: null,
      reasonCode: null,
      reasonDetail: null,
      rejectionCount: null,
      lastRejectedAt: null,
      nextEligibleAt: null,
      txHash: null,
      txNonce: null,
      rawTx: null,
      blockNumber: null,
      blockHash: null,
      confirmations: null,
      buybackId: null,
      createdAt: this.iso(),
      updatedAt: this.iso(),
    };
  }

  listCandidates(): Promise<readonly Launch2BuybackKeeperCandidate[]> {
    const active = this.active();
    if (!this.instance.graduated && active === null) {
      return Promise.resolve([]);
    }
    const latest =
      [...this.rows].sort((a, b) => b.attempt - a.attempt)[0] ?? null;
    return Promise.resolve([
      {
        instanceId: this.instance.instanceId,
        factoryAddress: this.instance.factoryAddress,
        buybackExecutor: executor,
        escrow,
        graduated: this.instance.graduated,
        buybackPaused: this.instance.buybackPaused,
        active,
        latest,
        lastAttempt: latest?.attempt ?? 0,
      },
    ]);
  }

  recordRejection(
    input: Parameters<Launch2BuybackAttemptRepository["recordRejection"]>[0],
  ) {
    const latest =
      [...this.rows].sort((a, b) => b.attempt - a.attempt)[0] ?? null;
    if (
      latest?.status === "rejected" &&
      latest.reasonCode === input.reasonCode &&
      latest.reasonDetail === input.reasonDetail
    ) {
      const count = (latest.rejectionCount ?? 0) + 1;
      return Promise.resolve({
        record: this.replace(latest, {
          rejectionCount: count,
          lastRejectedAt: this.iso(),
          nextEligibleAt: this.iso(input.backoffSeconds(count)),
        }),
        repeated: true,
      });
    }
    const record = Object.freeze({
      ...this.base("rejected", (latest?.attempt ?? 0) + 1),
      orderUsd1: input.orderUsd1,
      reasonCode: input.reasonCode,
      reasonDetail: input.reasonDetail,
      rejectionCount: 1,
      lastRejectedAt: this.iso(),
      nextEligibleAt: this.iso(input.backoffSeconds(1)),
    });
    this.rows.push(record);
    return Promise.resolve({ record, repeated: false });
  }

  insertPending(
    input: Parameters<Launch2BuybackAttemptRepository["insertPending"]>[0],
  ) {
    if (
      this.active() !== null ||
      this.rows.some((row) => row.attempt === input.attempt)
    ) {
      return Promise.resolve(null);
    }
    const record = Object.freeze({
      ...this.base("pending", input.attempt),
      orderUsd1: input.orderUsd1,
      simulatedGas: input.simulatedGas,
    });
    this.rows.push(record);
    return Promise.resolve(record);
  }

  nonces: bigint[] = [];

  async reserveAndRecordTx(
    input: Parameters<Launch2BuybackAttemptRepository["reserveAndRecordTx"]>[0],
  ) {
    const row = this.rows.find((entry) => entry.attemptId === input.attemptId);
    if (row?.status !== "pending" || row.txHash !== null) return null;
    let nonce = input.chainPendingNonce;
    while (this.nonces.includes(nonce)) nonce += 1n;
    this.nonces.push(nonce);
    const signed = await input.sign(nonce);
    return this.replace(row, {
      txHash: signed.txHash,
      rawTx: signed.rawTx,
      txNonce: nonce.toString(),
    });
  }

  transition(
    input: Parameters<Launch2BuybackAttemptRepository["transition"]>[0],
  ) {
    const row = this.rows.find((entry) => entry.attemptId === input.attemptId);
    if (row?.status !== input.from) return Promise.resolve(null);
    const inclusion = input.inclusion;
    return Promise.resolve(
      this.replace(row, {
        status: input.to,
        ...(inclusion === undefined
          ? {}
          : {
              blockNumber: inclusion?.blockNumber ?? null,
              blockHash: inclusion?.blockHash ?? null,
              confirmations: inclusion?.confirmations ?? null,
            }),
        reasonCode: input.to === "failed" ? input.failure!.code : null,
        reasonDetail:
          input.to === "failed" ? (input.failure!.detail ?? null) : null,
        nextEligibleAt:
          input.to === "failed"
            ? this.iso(input.failure!.retryAfterSeconds)
            : null,
      }),
    );
  }

  findLedgerBuyback(input: { readonly txHash: string }) {
    return Promise.resolve(this.ledger.get(input.txHash) ?? null);
  }

  align(input: { readonly attemptId: string; readonly buybackId: string }) {
    const row = this.rows.find((entry) => entry.attemptId === input.attemptId);
    if (row?.status !== "confirmed" || row.buybackId !== null) {
      return Promise.resolve(null);
    }
    return Promise.resolve(this.replace(row, { buybackId: input.buybackId }));
  }
}

/** A scripted chain: one executor, mined receipts, a manual head. */
class ScriptedChain implements Launch2BuybackKeeperChain {
  keeperAddress = keeper;
  head = vi.fn(() =>
    Promise.resolve({
      number: this.headNumber,
      hash: `0x${this.headNumber.toString(16).padStart(64, "0")}`,
      timestamp: this.timestamp,
    }),
  );
  headNumber = 1_000n;
  timestamp = 1_800_000_000n;
  factoryPrimary = keeper;
  executorPrimary = keeper;
  executorBudget = escrow;
  paused = false;
  available = 300n * wad;
  lastSuccessfulAt = 0n;
  revert: string | null = null;
  gas = 400_000n;
  price = 1n * 10n ** 9n;
  sendResult: Launch2KeeperSendResult = "accepted";
  sent: string[] = [];
  /** txHash → receipt (block number, status, hash). */
  receipts = new Map<
    string,
    {
      status: "success" | "reverted";
      blockNumber: bigint;
      blockHash: string;
    }
  >();
  estimateExecute = vi.fn(() =>
    this.revert === null
      ? Promise.resolve(this.gas)
      : Promise.reject(new Launch2KeeperRevertError(this.revert)),
  );
  chainId = () => Promise.resolve(97);
  block = (blockNumber: bigint) =>
    Promise.resolve({
      hash: this.canonical.get(blockNumber) ?? `0x${"b".repeat(64)}`,
      timestamp: this.timestamp,
    });
  canonical = new Map<bigint, string>();
  /** Decision 0141: per-Factory primary keepers (else `factoryPrimary`). */
  factoryPrimaries = new Map<string, string>();
  factoryKeepers = vi.fn((address: string) =>
    Promise.resolve({
      primary: this.factoryPrimaries.get(address) ?? this.factoryPrimary,
      fallback: fallbackKeeper,
    }),
  );
  executorFacts = vi.fn(() =>
    Promise.resolve({
      primaryKeeper: this.executorPrimary,
      fallbackKeeper,
      budget: this.executorBudget,
      orderAmount: 100n * wad,
      minSuccessInterval: 10n,
    }),
  );
  executorState = vi.fn(() =>
    Promise.resolve({
      blockTimestamp: this.timestamp,
      paused: this.paused,
      lastSuccessfulAt: this.lastSuccessfulAt,
      availableBudget: this.available,
    }),
  );
  gasPrice = () => Promise.resolve(this.price);
  pendingNonce = () => Promise.resolve(7n);
  signExecute = vi.fn((_executor: string, tx: { readonly nonce: bigint }) =>
    Promise.resolve({
      txHash: `0x${tx.nonce.toString(16).padStart(64, "a")}`,
      rawTx: `0x02${tx.nonce.toString(16).padStart(4, "0")}`,
    }),
  );
  sendRaw = vi.fn((rawTx: string) => {
    this.sent.push(rawTx);
    return Promise.resolve(this.sendResult);
  });
  receipt = (txHash: string) =>
    Promise.resolve(this.receipts.get(txHash) ?? null);

  mine(txHash: string, status: "success" | "reverted" = "success"): void {
    const blockHash = `0x${(this.headNumber + 1n).toString(16).padStart(64, "c")}`;
    this.headNumber += 1n;
    this.canonical.set(this.headNumber, blockHash);
    this.receipts.set(txHash, {
      status,
      blockNumber: this.headNumber,
      blockHash,
    });
    if (status === "success") {
      this.lastSuccessfulAt = this.timestamp;
      this.available -= 100n * wad;
    }
  }
}

function setup(policyOverride: Partial<Launch2BuybackKeeperPolicy> = {}) {
  const clock = new Clock();
  const store = new MemoryAttempts(clock);
  const chain = new ScriptedChain();
  const steps: Launch2KeeperStep[] = [];
  const keeperInstance = createLaunch2BuybackKeeper({
    repository: store,
    chain,
    policy: { ...policy, ...policyOverride },
    now: clock.now,
    onStep: (step) => steps.push(step),
  });
  return { clock, store, chain, steps, keeper: keeperInstance };
}

describe("Decision 0121 refusal classification and backoff", () => {
  it("maps every contract refusal to its family and code", () => {
    const cases: readonly [string, string, string][] = [
      [
        "ReferenceUnavailable",
        "LAUNCH2_BUYBACK_REFERENCE_UNAVAILABLE",
        "legacy_price_protection",
      ],
      [
        "SpotOutsideProtection",
        "LAUNCH2_BUYBACK_SPOT_OUTSIDE_PROTECTION",
        "legacy_price_protection",
      ],
      [
        "OutputBelowProtection",
        "LAUNCH2_BUYBACK_OUTPUT_BELOW_PROTECTION",
        "legacy_price_protection",
      ],
      [
        "LockedPrincipalInsufficient",
        "LAUNCH2_BUYBACK_PRINCIPAL_INSUFFICIENT",
        "principal",
      ],
      ["NoOutput", "LAUNCH2_BUYBACK_NO_OUTPUT", "other"],
      [
        "RecipientBalanceMismatch",
        "LAUNCH2_BUYBACK_CONTRACT_REVERTED",
        "other",
      ],
      ["TooSoon", "LAUNCH2_BUYBACK_TOO_SOON", "interval"],
      ["NoBudget", "LAUNCH2_BUYBACK_NO_BUDGET", "budget"],
      ["BudgetExceeded", "LAUNCH2_BUYBACK_NO_BUDGET", "budget"],
      ["BuybackPaused", "LAUNCH2_BUYBACK_PAUSED", "paused"],
      ["Unauthorized", "LAUNCH2_BUYBACK_NOT_KEEPER", "not_keeper"],
      ["LaunchNotGraduated", "LAUNCH2_BUYBACK_NOT_GRADUATED", "not_graduated"],
      ["PartialFill", "LAUNCH2_BUYBACK_CONTRACT_REVERTED", "other"],
      ["EXECUTION_REVERTED", "LAUNCH2_BUYBACK_CONTRACT_REVERTED", "other"],
    ];
    for (const [name, code, category] of cases) {
      expect(classifyLaunch2BuybackRevert(name)).toEqual({
        code,
        category,
        detail: name,
      });
    }
    expect(classifyLaunch2BuybackRevert("bad name; drop").detail).toBeNull();
  });

  it("doubles from the lane interval up to the cap; TooSoon waits one contract interval", () => {
    const price = { category: "principal" as const };
    expect(
      [1, 2, 3, 4, 5, 6, 30].map((count) =>
        launch2KeeperBackoffSeconds(price, count, policy),
      ),
    ).toEqual([15, 30, 60, 120, 240, 480, 600]);
    expect(
      launch2KeeperBackoffSeconds({ category: "interval" }, 9, policy, 10),
    ).toBe(10);
  });
});

describe("Decision 0121 keeper tick", () => {
  it("refuses to act when the key is not a Factory keeper", async () => {
    const { chain, keeper: subject, store } = setup();
    chain.factoryPrimary = `0x${"1".repeat(40)}`;
    expect(await subject.verifyKeeper()).toBe("not_keeper");
    const result = await subject.runOnce();
    expect(result).toMatchObject({
      kind: "unavailable",
      reasonCode: "LAUNCH2_BUYBACK_KEEPER_NOT_AUTHORIZED",
    });
    expect(chain.estimateExecute).not.toHaveBeenCalled();
    expect(store.rows).toEqual([]);
  });

  it("verifies on the first tick when boot could not read the Factory; a wrong node chain is unavailable", async () => {
    const { chain, keeper: subject } = setup();
    chain.chainId = () => Promise.resolve(56);
    expect((await subject.runOnce()).reasonCode).toBe(
      "LAUNCH2_BUYBACK_KEEPER_CHAIN_MISMATCH",
    );
    expect(chain.factoryKeepers).not.toHaveBeenCalled();
    chain.chainId = () => Promise.resolve(97);
    expect((await subject.runOnce()).kind).toBe("ran");
    expect(chain.factoryKeepers).toHaveBeenCalledTimes(1);
  });

  it("Decision 0150: on chain 56 runs only with LAUNCH_MAINNET_ACK", async () => {
    const closed = setup({ chainId: "eip155:56" });
    closed.chain.chainId = () => Promise.resolve(56);
    expect(await closed.keeper.runOnce()).toMatchObject({
      kind: "unavailable",
      reasonCode: "LAUNCH_MAINNET_NOT_ACKNOWLEDGED",
    });
    expect(closed.chain.factoryKeepers).not.toHaveBeenCalled();
    expect(closed.store.rows).toEqual([]);
    const open = setup({ chainId: "eip155:56", mainnetAcknowledged: true });
    open.chain.chainId = () => Promise.resolve(56);
    expect((await open.keeper.runOnce()).kind).toBe("ran");
    // The ack never admits another chain.
    open.chain.chainId = () => Promise.resolve(97);
    expect((await open.keeper.runOnce()).reasonCode).toBe(
      "LAUNCH2_BUYBACK_KEEPER_CHAIN_MISMATCH",
    );
  });

  it("executes, follows the receipt to confirmed, waits for the ledger row, then the next order after the interval", async () => {
    const { chain, keeper: subject, store, steps } = setup();
    // Order 1: simulate → pending (written first) → signed → broadcast.
    let result = await subject.runOnce();
    expect(result.waiting).toEqual({});
    expect(store.rows).toHaveLength(1);
    const first = store.rows[0]!;
    expect(first).toMatchObject({
      attempt: 1,
      status: "broadcast",
      simulation: "passed",
      orderUsd1: (100n * wad).toString(),
      simulatedGas: "400000",
      txNonce: "7",
    });
    expect(chain.signExecute).toHaveBeenCalledWith(executor, {
      nonce: 7n,
      gas: 480_000n,
      gasPrice: 10n ** 9n,
    });
    expect(steps.map((step) => [step.from, step.to])).toEqual([
      [null, "pending"],
      ["pending", "broadcast"],
    ]);
    // In flight: no second order is simulated.
    await subject.runOnce();
    expect(chain.estimateExecute).toHaveBeenCalledTimes(1);
    expect(chain.sent).toHaveLength(2); // re-sent while no receipt

    chain.mine(first.txHash!);
    await subject.runOnce();
    expect(store.rows[0]).toMatchObject({
      status: "broadcast",
      confirmations: 1,
    });
    chain.headNumber += 2n;
    await subject.runOnce();
    expect(store.rows[0]).toMatchObject({
      status: "confirmed",
      confirmations: 3,
    });
    // Confirmed but the lane has not written the ledger row yet.
    result = await subject.runOnce();
    expect(result.waiting[store.instance.instanceId]).toBe(
      "LAUNCH2_BUYBACK_LEDGER_PENDING",
    );
    expect(chain.estimateExecute).toHaveBeenCalledTimes(1);
    const buybackId = randomUUID();
    store.ledger.set(first.txHash!, buybackId);
    await subject.runOnce();
    expect(store.rows[0]?.buybackId).toBe(buybackId);

    // Same block time: the interval has not elapsed (pre-check, no row).
    result = await subject.runOnce();
    expect(result.waiting[store.instance.instanceId]).toBe(
      "LAUNCH2_BUYBACK_TOO_SOON",
    );
    expect(store.rows).toHaveLength(1);
    chain.timestamp += 10n;
    await subject.runOnce();
    expect(store.rows).toHaveLength(2);
    expect(store.rows[1]).toMatchObject({
      attempt: 2,
      status: "broadcast",
      txNonce: "8",
    });
  });

  it("records a refusal once, refreshes it while it persists, backs off, and starts a new row for a new reason", async () => {
    const { clock, chain, keeper: subject, store, steps } = setup();
    chain.revert = "ReferenceUnavailable";
    let result = await subject.runOnce();
    expect(result.waiting[store.instance.instanceId]).toBe(
      "LAUNCH2_BUYBACK_REFERENCE_UNAVAILABLE",
    );
    expect(store.rows).toEqual([
      expect.objectContaining({
        attempt: 1,
        status: "rejected",
        simulation: "reverted",
        reasonCode: "LAUNCH2_BUYBACK_REFERENCE_UNAVAILABLE",
        reasonDetail: "ReferenceUnavailable",
        rejectionCount: 1,
        txHash: null,
        orderUsd1: (100n * wad).toString(),
      }),
    ]);
    expect(store.rows[0]?.nextEligibleAt).toBe(
      new Date(clock.ms + 15_000).toISOString(),
    );
    expect(chain.signExecute).not.toHaveBeenCalled();
    expect(chain.sent).toEqual([]);

    // Inside the backoff: no simulation at all.
    clock.advance(10);
    result = await subject.runOnce();
    expect(chain.estimateExecute).toHaveBeenCalledTimes(1);
    expect(result.waiting[store.instance.instanceId]).toBe(
      "LAUNCH2_BUYBACK_REFERENCE_UNAVAILABLE",
    );
    // After it: same reason → the same row, count 2, backoff doubled.
    clock.advance(10);
    await subject.runOnce();
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ rejectionCount: 2 });
    expect(store.rows[0]?.nextEligibleAt).toBe(
      new Date(clock.ms + 30_000).toISOString(),
    );
    expect(steps.filter((step) => !step.repeated)).toHaveLength(1);
    expect(steps.filter((step) => step.repeated)).toHaveLength(1);

    // A different refusal opens a new row.
    clock.advance(31);
    chain.revert = "SpotOutsideProtection";
    await subject.runOnce();
    expect(store.rows.map((row) => [row.attempt, row.reasonCode])).toEqual([
      [1, "LAUNCH2_BUYBACK_REFERENCE_UNAVAILABLE"],
      [2, "LAUNCH2_BUYBACK_SPOT_OUTSIDE_PROTECTION"],
    ]);
    // Protection lifted: the next tick after the backoff executes.
    clock.advance(16);
    chain.revert = null;
    await subject.runOnce();
    expect(store.rows[2]).toMatchObject({ attempt: 3, status: "broadcast" });
  });

  it("never simulates while paused (read model or chain), out of budget, or for a foreign executor", async () => {
    const { chain, keeper: subject, store } = setup();
    const waitingFor = async (): Promise<string | undefined> =>
      (await subject.runOnce()).waiting[store.instance.instanceId];

    store.instance.buybackPaused = true;
    expect(await waitingFor()).toBe("LAUNCH2_BUYBACK_PAUSED");
    expect(chain.executorState).not.toHaveBeenCalled();
    store.instance.buybackPaused = false;

    chain.paused = true;
    expect(await waitingFor()).toBe("LAUNCH2_BUYBACK_PAUSED");
    chain.paused = false;

    chain.available = 0n;
    expect(await waitingFor()).toBe("LAUNCH2_BUYBACK_NO_BUDGET");
    chain.available = 300n * wad;

    chain.executorBudget = `0x${"9".repeat(40)}`;
    chain.executorFacts.mockClear();
    const other = createLaunch2BuybackKeeper({
      repository: store,
      chain,
      policy,
    });
    expect((await other.runOnce()).waiting[store.instance.instanceId]).toBe(
      "LAUNCH2_BUYBACK_ESCROW_MISMATCH",
    );
    chain.executorBudget = escrow;
    chain.executorPrimary = `0x${"3".repeat(40)}`;
    const third = createLaunch2BuybackKeeper({
      repository: store,
      chain,
      policy,
    });
    expect((await third.runOnce()).waiting[store.instance.instanceId]).toBe(
      "LAUNCH2_BUYBACK_NOT_KEEPER",
    );
    expect(chain.estimateExecute).not.toHaveBeenCalled();
    expect(store.rows).toEqual([]);
  });

  it("orders the last, partial budget (min(available, ORDER_AMOUNT))", async () => {
    const { chain, keeper: subject, store } = setup();
    chain.available = 40n * wad;
    await subject.runOnce();
    expect(store.rows[0]?.orderUsd1).toBe((40n * wad).toString());
  });

  it("fails a send refused for funds and waits the retry delay; a gas price over the cap writes nothing", async () => {
    const { clock, chain, keeper: subject, store } = setup();
    chain.price = 21n * 10n ** 9n;
    expect((await subject.runOnce()).waiting[store.instance.instanceId]).toBe(
      "LAUNCH2_BUYBACK_GAS_PRICE_ABOVE_CAP",
    );
    expect(store.rows).toEqual([]);
    chain.price = 10n ** 9n;
    chain.sendResult = "insufficient_funds";
    await subject.runOnce();
    expect(store.rows[0]).toMatchObject({
      status: "failed",
      reasonCode: "LAUNCH2_BUYBACK_KEEPER_INSUFFICIENT_FUNDS",
    });
    chain.sendResult = "accepted";
    expect((await subject.runOnce()).waiting[store.instance.instanceId]).toBe(
      "LAUNCH2_BUYBACK_RETRY_WAIT",
    );
    clock.advance(61);
    await subject.runOnce();
    expect(store.rows[1]).toMatchObject({ attempt: 2, status: "broadcast" });
  });

  it("fails a reverted receipt, and re-sends the same bytes when the inclusion block leaves the chain", async () => {
    const { chain, keeper: subject, store } = setup();
    await subject.runOnce();
    const first = store.rows[0]!;
    chain.mine(first.txHash!, "reverted");
    await subject.runOnce();
    expect(store.rows[0]).toMatchObject({
      status: "failed",
      reasonCode: "LAUNCH2_BUYBACK_TX_REVERTED",
    });

    const { chain: chain2, keeper: subject2, store: store2 } = setup();
    await subject2.runOnce();
    const sent = store2.rows[0]!;
    chain2.mine(sent.txHash!);
    chain2.headNumber += 5n;
    await subject2.runOnce();
    expect(store2.rows[0]?.status).toBe("confirmed");
    // Reorg: the receipt now sits in another block.
    chain2.receipts.set(sent.txHash!, {
      status: "success",
      blockNumber: 2_000n,
      blockHash: `0x${"d".repeat(64)}`,
    });
    const before = chain2.sent.length;
    await subject2.runOnce();
    expect(store2.rows[0]).toMatchObject({
      status: "broadcast",
      blockHash: null,
    });
    expect(chain2.sent.length).toBe(before + 1);
    expect(chain2.sent.at(-1)).toBe(sent.rawTx);
  });

  it("fails a pending attempt without a transaction once the read model pauses", async () => {
    const { chain, keeper: subject, store } = setup();
    chain.price = 21n * 10n ** 9n;
    // Force a pending row without a transaction (a crash after insert).
    await store.insertPending({
      instanceId: store.instance.instanceId,
      chainId: "eip155:97",
      attempt: 1,
      keeperAddress: keeper,
      executorAddress: executor,
      orderUsd1: (100n * wad).toString(),
      simulatedGas: "400000",
    });
    store.instance.buybackPaused = true;
    await subject.runOnce();
    expect(store.rows[0]).toMatchObject({
      status: "failed",
      reasonCode: "LAUNCH2_BUYBACK_PAUSED",
      txHash: null,
    });
    expect(chain.sent).toEqual([]);
  });
});

describe("Decision 0141 mixed deployment: each instance against its own Factory", () => {
  const mixed = { factoryAddresses: [factory, dynamicFactory] } as const;

  for (const [authorizedOn, refusedOn] of [
    [dynamicFactory, factory],
    [factory, dynamicFactory],
  ] as const) {
    it(`boots when the key is a keeper of ${authorizedOn === factory ? "OfficialTax" : "LoopDynamic"} only; that Factory's instance executes, the other one waits`, async () => {
      const { chain, keeper: subject, store } = setup(mixed);
      chain.factoryPrimaries.set(refusedOn, otherKeeper);
      expect(await subject.verifyKeeper()).toBe("ok");
      expect(
        chain.factoryKeepers.mock.calls.map(([address]) => address),
      ).toEqual([factory, dynamicFactory]);

      store.instance.factoryAddress = refusedOn;
      let result = await subject.runOnce();
      expect(result.kind).toBe("ran");
      expect(result.waiting).toEqual({
        [store.instance.instanceId]: "LAUNCH2_BUYBACK_NOT_KEEPER",
      });
      expect(chain.executorFacts).not.toHaveBeenCalled();
      expect(chain.estimateExecute).not.toHaveBeenCalled();
      expect(store.rows).toEqual([]);

      store.instance.factoryAddress = authorizedOn;
      result = await subject.runOnce();
      expect(result.waiting).toEqual({});
      expect(store.rows).toHaveLength(1);
      expect(store.rows[0]).toMatchObject({
        status: "broadcast",
        keeperAddress: keeper,
      });
      // Factory keepers are read once (boot), not per tick.
      expect(chain.factoryKeepers).toHaveBeenCalledTimes(2);
    });
  }

  it("same keeper on both Factories: both instances execute (unchanged)", async () => {
    for (const instanceFactory of [factory, dynamicFactory]) {
      const { keeper: subject, store } = setup(mixed);
      expect(await subject.verifyKeeper()).toBe("ok");
      store.instance.factoryAddress = instanceFactory;
      const result = await subject.runOnce();
      expect(result.waiting).toEqual({});
      expect(store.rows[0]?.status).toBe("broadcast");
    }
  });

  it("refuses boot when the key is a keeper of neither Factory", async () => {
    const { chain, keeper: subject, store } = setup(mixed);
    chain.factoryPrimary = otherKeeper;
    expect(await subject.verifyKeeper()).toBe("not_keeper");
    expect((await subject.runOnce()).reasonCode).toBe(
      "LAUNCH2_BUYBACK_KEEPER_NOT_AUTHORIZED",
    );
    expect(store.rows).toEqual([]);
  });

  it("an instance of an unconfigured (legacy) Factory is checked against that Factory's keepers", async () => {
    const legacyFactory = `0x${"9".repeat(40)}`;
    const { chain, keeper: subject, store } = setup();
    chain.factoryPrimaries.set(legacyFactory, otherKeeper);
    expect(await subject.verifyKeeper()).toBe("ok");
    store.instance.factoryAddress = legacyFactory;
    const result = await subject.runOnce();
    expect(result.waiting).toEqual({
      [store.instance.instanceId]: "LAUNCH2_BUYBACK_NOT_KEEPER",
    });
    expect(chain.factoryKeepers).toHaveBeenLastCalledWith(legacyFactory);
    expect(store.rows).toEqual([]);
  });
});

describe("Decision 0121 lane wrapper", () => {
  it("reports a waiting reason once until it changes and hides refreshed refusals", async () => {
    const clock = new Clock();
    const store = new MemoryAttempts(clock);
    const chain = new ScriptedChain();
    chain.revert = "SpotOutsideProtection";
    const onStep = vi.fn();
    const onWaiting = vi.fn();
    const lane = createLaunch2BuybackKeeperLane({
      repository: store,
      chain,
      policy,
      now: clock.now,
      onStep,
      onWaiting,
    });
    for (let tick = 0; tick < 12; tick += 1) {
      await lane.runOnce();
      clock.advance(15);
    }
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.rejectionCount).toBeGreaterThan(1);
    expect(onStep).toHaveBeenCalledTimes(1);
    expect(onWaiting).toHaveBeenCalledTimes(1);
    expect(onWaiting).toHaveBeenCalledWith({
      instanceId: store.instance.instanceId,
      reasonCode: "LAUNCH2_BUYBACK_SPOT_OUTSIDE_PROTECTION",
    });
    expect(lane.lane).toBe("launch2_buyback_keeper");
  });
});
