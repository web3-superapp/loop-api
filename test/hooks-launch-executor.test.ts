import { describe, expect, it } from "vitest";

import {
  HooksLaunchChainRevertError,
  createHooksLaunchExecutor,
  type HooksLaunchExecutorPolicy,
} from "../src/features/launch/hooks-launch-executor.js";
import {
  configHash,
  factoryCodeHash,
  fakeChain,
  fakeRepository,
  nowSeconds,
  passingFacts,
  signedPayload,
} from "./helpers/hooks-launch-executor-fixtures.js";

/**
 * Decision 0112: executor state machine against an in-memory repository
 * (migration 000059 rules) and a scriptable chain. The anvil suite runs the
 * same code against real contracts.
 */

const policy: HooksLaunchExecutorPolicy = {
  factoryCodeHash,
  confirmations: 3,
  maxAttempts: 3,
  retryDelaySeconds: 60,
  gasLimitCap: 16_000_000n,
  maxGasPriceWei: 20_000_000_000n,
  deadlineMarginSeconds: 60,
  activationMarginSeconds: 120,
  tasksPerTick: 8,
};

async function setup(
  options: {
    readonly deadline?: number;
    readonly latestConfig?: Parameters<
      typeof fakeRepository
    >[0]["latestConfig"];
    /** Decision 0150: the chain the owner signed for (default 97). */
    readonly signedChainId?: number;
    readonly launchSlot?: HooksLaunchExecutorPolicy["launchSlot"];
  } = {},
) {
  const payload = await signedPayload(
    options.deadline ?? nowSeconds + 900,
    options.signedChainId ?? 97,
  );
  const store = fakeRepository({
    payload,
    ...(options.latestConfig === undefined
      ? {}
      : { latestConfig: options.latestConfig }),
  });
  const fake = fakeChain();
  const executor = createHooksLaunchExecutor({
    repository: store.repository,
    chain: fake.chain,
    policy:
      options.launchSlot === undefined
        ? policy
        : { ...policy, launchSlot: options.launchSlot },
    executorId: "hooks-executor:test:1",
    now: () => nowSeconds,
  });
  return { store, fake, executor };
}

const kinds = (events: readonly { readonly kind: string }[]) =>
  events.map((event) => event.kind);

describe("Hooks deployment executor (Decision 0112)", () => {
  it("walks claimed → broadcast → confirmed → verified → activated", async () => {
    const { store, fake, executor } = await setup();
    await executor.runOnce();
    expect(store.task.status).toBe("broadcast");
    expect(store.task.txHash).not.toBeNull();
    expect(store.reservations).toHaveLength(1);
    const txHash = store.task.txHash;

    fake.mine(1);
    await executor.runOnce();
    expect(store.task.confirmations).toBe(1);
    fake.mine(2);
    await executor.runOnce();
    expect(store.task.status).toBe("verified");
    expect(store.task.activationTxHash).not.toBeNull();
    fake.mine(3);
    await executor.runOnce();
    expect(store.task.status).toBe("activated");
    expect(store.task.txHash).toBe(txHash);
    expect(kinds(store.events)).toEqual([
      "claimed",
      "broadcast",
      "included",
      "confirmed",
      "verified",
      "activation_broadcast",
      "activated",
    ]);
    // Exactly one deploy and one activation reservation, consecutive nonces.
    expect(store.reservations.map((r) => [r.purpose, r.nonce])).toEqual([
      ["deploy", 0n],
      ["activate", 1n],
    ]);
  });

  it.each([
    ["wrong chain", { chainId: 56 }, "HOOKS_EXECUTOR_WRONG_CHAIN"],
    [
      "other Factory code",
      { factoryHash: `0x${"00".repeat(32)}` },
      "HOOKS_FACTORY_CODE_MISMATCH",
    ],
    [
      "missing Factory code",
      { factoryHash: null },
      "HOOKS_FACTORY_CODE_MISMATCH",
    ],
    [
      "unauthorized executor",
      { authorized: "0x9999999999999999999999999999999999999999" },
      "HOOKS_EXECUTOR_NOT_AUTHORIZED",
    ],
  ] as const)(
    "stays idle on %s and claims nothing",
    async (_name, patch, reason) => {
      const { store, fake, executor } = await setup();
      Object.assign(fake.state, patch);
      const result = await executor.runOnce();
      expect(result.idleReason).toBe(reason);
      expect(store.task.status).toBe("awaiting_executor");
      expect(store.events).toHaveLength(0);
    },
  );

  describe("Decision 0150 launch slot", () => {
    const mainnet = { chainReference: 56, mainnetAcknowledged: true } as const;

    it("stays idle on chain 56 without LAUNCH_MAINNET_ACK and claims nothing", async () => {
      const { store, fake, executor } = await setup({
        signedChainId: 56,
        launchSlot: { chainReference: 56, mainnetAcknowledged: false },
      });
      fake.state.chainId = 56;
      const result = await executor.runOnce();
      expect(result.idleReason).toBe("LAUNCH_MAINNET_NOT_ACKNOWLEDGED");
      expect(store.task.status).toBe("awaiting_executor");
      expect(store.events).toHaveLength(0);
    });

    it("stays idle when a mainnet slot meets a testnet node", async () => {
      const { store, executor } = await setup({
        signedChainId: 56,
        launchSlot: mainnet,
      });
      const result = await executor.runOnce();
      expect(result.idleReason).toBe("HOOKS_EXECUTOR_WRONG_CHAIN");
      expect(store.task.status).toBe("awaiting_executor");
    });

    it("signs and broadcasts a chain-56 task on chain 56 with the ack", async () => {
      const { store, fake, executor } = await setup({
        signedChainId: 56,
        launchSlot: mainnet,
      });
      fake.state.chainId = 56;
      const result = await executor.runOnce();
      expect(result.idleReason).toBeNull();
      expect(store.task.status).toBe("broadcast");
      expect(store.reservations).toHaveLength(1);
    });

    it("never executes an authorization signed for another chain", async () => {
      const { store, fake, executor } = await setup({
        signedChainId: 97,
        launchSlot: mainnet,
      });
      fake.state.chainId = 56;
      await executor.runOnce();
      expect(store.task.status).not.toBe("broadcast");
      expect(store.task.txHash).toBeNull();
      expect(store.reservations).toHaveLength(0);
    });
  });

  it("fails an expired signature without signing or sending", async () => {
    const { store, fake, executor } = await setup({
      deadline: nowSeconds + 30,
    });
    await executor.runOnce();
    expect(store.task).toMatchObject({
      status: "failed",
      failureCode: "HOOKS_SIGNATURE_EXPIRED",
      failureRetryable: false,
      txHash: null,
    });
    expect(fake.state.sent).toHaveLength(0);
    expect(store.reservations).toHaveLength(0);
  });

  it.each([
    [
      "a newer config version",
      { version: 2, configHash: `0x${"c1".repeat(32)}`, approvedHash: null },
      "HOOKS_CONFIG_SUPERSEDED",
    ],
    [
      "a withdrawn approval",
      { version: 1, configHash, approvedHash: null },
      "HOOKS_CONFIG_NOT_APPROVED",
    ],
  ] as const)(
    "fails on %s before broadcasting",
    async (_name, latestConfig, code) => {
      const { store, fake, executor } = await setup({ latestConfig });
      await executor.runOnce();
      expect(store.task.failureCode).toBe(code);
      expect(fake.state.sent).toHaveLength(0);
    },
  );

  it.each([
    ["owner nonce consumed", { ownerNonce: 1n }, "HOOKS_OWNER_NONCE_CONSUMED"],
    [
      "version already deployed",
      { existingLaunch: `0x${"12".repeat(32)}` },
      "HOOKS_LAUNCH_ALREADY_DEPLOYED",
    ],
    [
      "simulation revert",
      { estimate: new HooksLaunchChainRevertError("InvalidProjectSignature") },
      "HOOKS_DEPLOY_SIMULATION_REVERTED",
    ],
    [
      "gas above the cap",
      { estimate: 15_000_000n },
      "HOOKS_DEPLOY_GAS_ABOVE_CAP",
    ],
  ] as const)("fails (not retryable) on %s", async (_name, patch, code) => {
    const { store, fake, executor } = await setup();
    Object.assign(fake.state, patch);
    await executor.runOnce();
    expect(store.task).toMatchObject({
      status: "failed",
      failureCode: code,
      failureRetryable: false,
    });
    expect(fake.state.sent).toHaveLength(0);
  });

  it("refuses to deploy what could no longer be activated in time", async () => {
    const { store, fake, executor } = await setup({
      deadline: nowSeconds + 3 * 86_400,
    });
    fake.state.timestamp = BigInt(nowSeconds + 2 * 86_400 - 3_600);
    await executor.runOnce();
    expect(store.task).toMatchObject({
      status: "failed",
      failureCode: "HOOKS_ACTIVATION_WINDOW_CLOSED",
      failureRetryable: false,
    });
    expect(fake.state.sent).toHaveLength(0);
  });

  it("defers (no state change) while gas price is above the cap", async () => {
    const { store, fake, executor } = await setup();
    fake.state.gasPrice = 50_000_000_000n;
    const result = await executor.runOnce();
    expect(result.idleReason).toBe("HOOKS_GAS_PRICE_ABOVE_CAP");
    expect(store.task.status).toBe("claimed");
    expect(store.reservations).toHaveLength(0);
  });

  it("releases the nonce and retries after the node refuses for funds", async () => {
    const { store, fake, executor } = await setup();
    fake.state.sendResult = "insufficient_funds";
    await executor.runOnce();
    expect(store.task).toMatchObject({
      status: "failed",
      failureCode: "HOOKS_EXECUTOR_FUNDS_INSUFFICIENT",
      failureRetryable: true,
    });
    expect(store.reservations[0]?.state).toBe("released");
    fake.state.sendResult = "accepted";
    await executor.runOnce();
    expect(store.task.status).toBe("broadcast");
    expect(store.task.attemptCount).toBe(2);
    // The released nonce is reused; no gap.
    expect(store.reservations.at(-1)?.nonce).toBe(0n);
  });

  it("retries a reverted deployment and stops after the attempt budget", async () => {
    const { store, fake, executor } = await setup();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      fake.state.revertNext = true;
      await executor.runOnce();
      fake.mine(1);
      await executor.runOnce();
      expect(store.task.failureCode).toBe("HOOKS_DEPLOY_REVERTED");
      expect(store.task.failureRetryable).toBe(attempt < 3);
    }
    await executor.runOnce();
    expect(store.task.status).toBe("failed");
    expect(store.task.attemptCount).toBe(3);
  });

  it("detects a reorg by block hash and re-sends the same transaction", async () => {
    const { store, fake, executor } = await setup();
    await executor.runOnce();
    fake.mine(1);
    await executor.runOnce();
    const txHash = store.task.txHash;
    const sentBefore = fake.state.sent.length;
    fake.reorg(1);
    await executor.runOnce();
    expect(kinds(store.events)).toContain("reorg_detected");
    await executor.runOnce();
    expect(store.task.status).toBe("broadcast");
    expect(store.task.txHash).toBe(txHash);
    expect(fake.state.sent.length).toBeGreaterThan(sentBefore);
    expect(fake.state.sent.at(-1)).toBe(fake.state.sent[0]);
    expect(store.reservations).toHaveLength(1);
    fake.mine(3);
    await executor.runOnce();
    fake.mine(3);
    await executor.runOnce();
    expect(store.task.status).toBe("activated");
    expect(kinds(store.events)).toEqual(
      expect.arrayContaining(["reclaimed_after_reorg", "rebroadcast"]),
    );
  });

  it("treats a changed receipt block hash as a reorg", async () => {
    const { store, fake, executor } = await setup();
    await executor.runOnce();
    fake.mine(1);
    await executor.runOnce();
    const receipt = fake.state.receipts.get(store.task.txHash!)!;
    fake.state.receipts.set(store.task.txHash!, {
      ...receipt,
      blockHash: `0x${"ee".repeat(32)}`,
    });
    await executor.runOnce();
    expect(store.events.at(-1)?.kind).toBe("reorg_detected");
  });

  it("fails verification on any mismatch and never activates", async () => {
    const { store, fake, executor } = await setup();
    const facts = passingFacts();
    fake.state.facts = {
      ...facts,
      buyback: {
        ...facts.buyback!,
        recipient: "0x4444444444444444444444444444444444444444",
      },
    };
    await executor.runOnce();
    fake.mine(3);
    await executor.runOnce();
    expect(store.task).toMatchObject({
      status: "failed",
      failureCode: "HOOKS_VERIFICATION_MISMATCH",
      failureRetryable: false,
      activationTxHash: null,
    });
    expect(store.events.at(-1)?.details).toMatchObject({
      failedChecks: ["buyback_params"],
    });
    expect(store.reservations.map((r) => r.purpose)).toEqual(["deploy"]);
    await executor.runOnce();
    expect(store.task.status).toBe("failed");
  });

  it("re-signs an activation that reverted, then gives up after the budget", async () => {
    const { store, fake, executor } = await setup();
    await executor.runOnce();
    fake.mine(3);
    await executor.runOnce(); // verified + activation sent
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      fake.state.revertNext = true;
      fake.mine(1);
      await executor.runOnce();
      if (attempt < 3) {
        expect(store.events.map((e) => e.kind)).toContain(
          "activation_reverted",
        );
        await executor.runOnce(); // re-sign
        expect(store.task.activationAttemptCount).toBe(attempt + 1);
      }
    }
    expect(store.task).toMatchObject({
      status: "failed",
      failureCode: "HOOKS_ACTIVATION_REVERTED",
      failureRetryable: false,
    });
  });
});
