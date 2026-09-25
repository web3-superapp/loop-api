import { HttpRequestError } from "viem";
import { describe, expect, it, vi } from "vitest";

import {
  createUnavailableLaunchChainRepository,
  type LaunchChainRepository,
  type LaunchIntentRecord,
} from "../src/features/launch/launch-chain-repository.js";
import {
  LAUNCH_INTENT_PENDING_GRACE_MS,
  LAUNCH_INTENT_RECEIPT_GRACE_MS,
  createLaunchIntentReconciler,
} from "../src/features/launch/launch-intent-reconciliation.js";
import { projectLaunchIntent } from "../src/features/launch/launch-intent-service.js";
import {
  createUnavailableBscReadClient,
  type BscChainCallClient,
  type BscTransactionObservation,
  type BscTransactionReceiptObservation,
} from "../src/integrations/bsc/rpc-client.js";

/**
 * Decision 0080: receipt reconciliation of reported Launch Intents. The
 * repository fake mirrors the Postgres conditional update (`state =
 * 'submitted'` and the same hash); the chain fake serves one transaction.
 */

const intentId = "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f";
const wallet = "0x000000000000000000000000000000000000000a";
const contract = "0x00000000000000000000000000000000000000c1";
const data = "0xabcdef01";
const hash = `0x${"ab".repeat(32)}`;
const deadline = "2026-09-25T08:00:00.000Z";
const deadlineMs = Date.parse(deadline);

function record(
  overrides: Partial<LaunchIntentRecord> = {},
): LaunchIntentRecord {
  return {
    intentId,
    ownerUserId: "1c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f",
    walletId: "2c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f",
    launchId: "3c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f",
    projectId: "4c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f",
    roundId: "5c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f",
    roundIndex: 0,
    saleId: "7",
    chainId: "eip155:97",
    quoteAssetId: `eip155:97:${"0x" + "11".repeat(20)}`,
    projectAssetId: `eip155:97:${"0x" + "22".repeat(20)}`,
    payAmountRaw: "10000000000000000000",
    expectedReceiveRaw: "1000",
    minTokenAmountRaw: "990",
    configVersion: `0x${"ab".repeat(32)}`,
    walletCumulativeRaw: "0",
    contractAddress: contract,
    stateTupleDigest: `0x${"cd".repeat(32)}`,
    snapshotBlockNumber: "900",
    snapshotBlockHash: `0x${"09".repeat(32)}`,
    payloadDigest: "e".repeat(64),
    state: "submitted",
    deadline,
    eligibilityProof: [],
    unsignedTransaction: {
      chainId: 97,
      from: wallet,
      to: contract,
      data,
      value: "0x0",
    },
    policy: {},
    expiresAt: deadline,
    createdAt: "2026-09-25T07:58:00.000Z",
    transactionHash: hash,
    payloadVerified: true,
    reportedAt: "2026-09-25T07:58:30.000Z",
    receipt: null,
    reasonCode: null,
    revertReason: null,
    ...overrides,
  };
}

function repositoryFake(initial: LaunchIntentRecord): {
  readonly repository: LaunchChainRepository;
  current: () => LaunchIntentRecord;
  /** What the `launch_event` lane does when it indexes the Purchased log. */
  laneIndexesPurchased: () => void;
  readonly leases: { chainId: string }[];
} {
  let row = initial;
  const leases: { chainId: string }[] = [];
  const repository: LaunchChainRepository = {
    ...createUnavailableLaunchChainRepository(),
    leaseReconcilableIntents: (input) => {
      leases.push({ chainId: input.chainId });
      return Promise.resolve(
        row.state === "submitted" && row.chainId === input.chainId ? [row] : [],
      );
    },
    markIntentPayloadVerified: () => {
      row = { ...row, payloadVerified: true };
      return Promise.resolve();
    },
    settleIntent: (input) => {
      if (
        row.state !== "submitted" ||
        row.transactionHash !== input.transactionHash
      ) {
        return Promise.resolve(null);
      }
      row = {
        ...row,
        state: input.toState,
        reasonCode: input.reasonCode,
        revertReason: input.revertReason,
        receipt: input.receipt ?? row.receipt,
      };
      return Promise.resolve(row);
    },
  };
  return {
    repository,
    current: () => row,
    laneIndexesPurchased: () => {
      // Mirrors reprojectLaunch: submitted/confirmed/expired → confirmed.
      if (["submitted", "confirmed", "expired"].includes(row.state)) {
        row = { ...row, state: "confirmed" };
      }
    },
    leases,
  };
}

function chainFake(options: {
  readonly head?: bigint;
  readonly receipt?: Partial<BscTransactionReceiptObservation> | null;
  readonly transaction?: Partial<BscTransactionObservation> | null;
  readonly receiptError?: () => Error;
  readonly confirmations?: number;
}): BscChainCallClient & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    ...createUnavailableBscReadClient({
      chainId: "eip155:97",
      chainReference: 97,
      confirmations: options.confirmations ?? 5,
      reorgDepthBlocks: 15,
    }),
    calls,
    getHead: () =>
      Promise.resolve({
        blockNumber: options.head ?? 1_000n,
        blockHash: `0x${"0f".repeat(32)}`,
        observedAt: new Date().toISOString(),
      }),
    getTransaction: () => {
      calls.push("getTransaction");
      return Promise.resolve(
        options.transaction === null
          ? null
          : {
              hash,
              from: wallet,
              to: contract,
              input: data,
              value: 0n,
              nonce: 3,
              chainId: 97,
              blockNumber: 990n,
              ...options.transaction,
            },
      );
    },
    getTransactionReceipt: () => {
      calls.push("getTransactionReceipt");
      if (options.receiptError !== undefined) {
        return Promise.reject(options.receiptError());
      }
      return Promise.resolve(
        options.receipt === null || options.receipt === undefined
          ? null
          : {
              hash,
              status: "success",
              blockNumber: 990n,
              blockHash: `0x${"99".repeat(32)}`,
              gasUsed: 120_000n,
              effectiveGasPrice: 1_000_000_000n,
              ...options.receipt,
            },
      );
    },
  };
}

function reconcilerAt(
  repository: LaunchChainRepository,
  readClient: BscChainCallClient | null,
  nowMs: number,
) {
  return createLaunchIntentReconciler({
    repository,
    readClient,
    chainId: "eip155:97",
    now: () => new Date(nowMs),
  });
}

describe("Launch Intent receipt reconciliation (Decision 0080)", () => {
  it("submitted → confirmed on a status 0x1 receipt at the confirmation depth, not before", async () => {
    const store = repositoryFake(record());
    // Receipt at 990, head 993: depth 4 < 5 → wait.
    const shallow = await reconcilerAt(
      store.repository,
      chainFake({ head: 993n, receipt: {} }),
      deadlineMs - 60_000,
    ).reconcileOnce();
    expect(shallow).toMatchObject({
      status: "available",
      leasedCount: 1,
      transitions: [],
    });
    expect(store.current().state).toBe("submitted");

    const deep = await reconcilerAt(
      store.repository,
      chainFake({ head: 994n, receipt: {} }),
      deadlineMs - 60_000,
    ).reconcileOnce();
    expect(deep.transitions).toEqual([
      { intentId, toState: "confirmed", reasonCode: null },
    ]);
    expect(store.current()).toMatchObject({
      state: "confirmed",
      reasonCode: null,
      receipt: {
        status: "success",
        blockNumber: "990",
        gasUsed: "120000",
        effectiveGasPrice: "1000000000",
        confirmations: 5,
      },
    });
  });

  it("submitted → reverted on a status 0x0 receipt, with LAUNCH_TX_REVERTED and a null revertReason", async () => {
    const store = repositoryFake(record());
    const result = await reconcilerAt(
      store.repository,
      chainFake({ head: 1_000n, receipt: { status: "reverted" } }),
      deadlineMs - 60_000,
    ).reconcileOnce();
    expect(result.transitions).toEqual([
      { intentId, toState: "reverted", reasonCode: "LAUNCH_TX_REVERTED" },
    ]);
    expect(store.current()).toMatchObject({
      state: "reverted",
      reasonCode: "LAUNCH_TX_REVERTED",
      revertReason: null,
      receipt: { status: "reverted", confirmations: 11 },
    });
    // The wire projection: reverted, revertReason present and null, and the
    // signing reason names the outcome.
    const projected = projectLaunchIntent(
      store.current(),
      new Date(deadlineMs),
    ).launchIntent;
    expect(projected["state"]).toBe("reverted");
    expect(projected).toHaveProperty("revertReason", null);
    expect(projected["signing"]).toMatchObject({
      allowed: false,
      reasonCode: "LAUNCH_TX_REVERTED",
    });
  });

  it("submitted → expired with no receipt once deadline + grace has passed; waits before it", async () => {
    const store = repositoryFake(record());
    const early = await reconcilerAt(
      store.repository,
      chainFake({ receipt: null, transaction: null }),
      deadlineMs + LAUNCH_INTENT_RECEIPT_GRACE_MS,
    ).reconcileOnce();
    expect(early.transitions).toEqual([]);
    expect(store.current().state).toBe("submitted");

    const late = await reconcilerAt(
      store.repository,
      chainFake({ receipt: null, transaction: null }),
      deadlineMs + LAUNCH_INTENT_RECEIPT_GRACE_MS + 1,
    ).reconcileOnce();
    expect(late.transitions).toEqual([
      { intentId, toState: "expired", reasonCode: "LAUNCH_TX_NOT_OBSERVED" },
    ]);
    const projected = projectLaunchIntent(
      store.current(),
      new Date(),
    ).launchIntent;
    expect(projected["state"]).toBe("expired");
    expect(projected).not.toHaveProperty("revertReason");
  });

  it("keeps waiting on a transaction still pending in the mempool until the pending grace", async () => {
    const store = repositoryFake(record());
    const pending = chainFake({
      receipt: null,
      transaction: { blockNumber: null },
    });
    await reconcilerAt(
      store.repository,
      pending,
      deadlineMs + LAUNCH_INTENT_RECEIPT_GRACE_MS + 1,
    ).reconcileOnce();
    expect(store.current().state).toBe("submitted");
    await reconcilerAt(
      store.repository,
      pending,
      deadlineMs + LAUNCH_INTENT_PENDING_GRACE_MS + 1,
    ).reconcileOnce();
    expect(store.current().state).toBe("expired");
  });

  it("lane first: a Purchased log already confirmed it, the receipt write is a no-op", async () => {
    const store = repositoryFake(record());
    const reconciler = reconcilerAt(
      store.repository,
      chainFake({ receipt: {} }),
      deadlineMs,
    );
    store.laneIndexesPurchased();
    const result = await reconciler.reconcileOnce();
    expect(result).toMatchObject({ leasedCount: 0, transitions: [] });
    expect(store.current()).toMatchObject({
      state: "confirmed",
      receipt: null,
    });
  });

  it("report/receipt first: the lane re-projecting the Purchased log leaves it confirmed, and a stale settle cannot move it", async () => {
    const store = repositoryFake(record());
    await reconcilerAt(
      store.repository,
      chainFake({ receipt: {} }),
      deadlineMs,
    ).reconcileOnce();
    expect(store.current().state).toBe("confirmed");
    store.laneIndexesPurchased();
    expect(store.current().state).toBe("confirmed");
    // A settle computed from an older read (e.g. a second worker) is refused.
    await expect(
      store.repository.settleIntent({
        intentId,
        transactionHash: hash,
        toState: "expired",
        reasonCode: "LAUNCH_TX_NOT_OBSERVED",
        revertReason: null,
        receipt: null,
      }),
    ).resolves.toBeNull();
    expect(store.current().state).toBe("confirmed");
  });

  it("verifies an unverified report first: another transaction under the hash → failed / LAUNCH_TX_PAYLOAD_MISMATCH", async () => {
    const store = repositoryFake(record({ payloadVerified: false }));
    const chain = chainFake({
      receipt: {},
      transaction: { input: "0xdeadbeef" },
    });
    const result = await reconcilerAt(
      store.repository,
      chain,
      deadlineMs,
    ).reconcileOnce();
    expect(result.transitions).toEqual([
      { intentId, toState: "failed", reasonCode: "LAUNCH_TX_PAYLOAD_MISMATCH" },
    ]);
    expect(chain.calls).toEqual(["getTransaction"]);
  });

  it("marks a matching unverified report verified, then settles from the receipt", async () => {
    const store = repositoryFake(record({ payloadVerified: false }));
    await reconcilerAt(
      store.repository,
      chainFake({ receipt: {} }),
      deadlineMs,
    ).reconcileOnce();
    expect(store.current()).toMatchObject({
      payloadVerified: true,
      state: "confirmed",
    });
  });

  it("fails closed without the launch slot client: nothing leased, nothing moved", async () => {
    const store = repositoryFake(record());
    const result = await reconcilerAt(
      store.repository,
      null,
      deadlineMs,
    ).reconcileOnce();
    expect(result).toEqual({
      status: "unavailable",
      reasonCode: "LAUNCH_CHAIN_RPC_NOT_CONFIGURED",
      leasedCount: 0,
      transitions: [],
      readFailures: [],
    });
    expect(store.leases).toEqual([]);
    expect(store.current().state).toBe("submitted");
  });

  it("records a 403 receipt refusal as a read failure and leaves the Intent submitted", async () => {
    const store = repositoryFake(record());
    const result = await reconcilerAt(
      store.repository,
      chainFake({
        receiptError: () =>
          new HttpRequestError({ status: 403, url: "https://rpc.test/" }),
      }),
      deadlineMs + LAUNCH_INTENT_PENDING_GRACE_MS * 2,
    ).reconcileOnce();
    expect(result).toMatchObject({
      transitions: [],
      readFailures: [
        { intentId, reasonCode: "LAUNCH_RPC_RECEIPT_UNAVAILABLE" },
      ],
    });
    expect(store.current().state).toBe("submitted");
  });

  it("never reads a receipt when the lane has nothing leased", async () => {
    const store = repositoryFake(record({ state: "confirmed" }));
    const chain = chainFake({ receipt: {} });
    const receiptSpy = vi.spyOn(chain, "getTransactionReceipt");
    await reconcilerAt(store.repository, chain, deadlineMs).reconcileOnce();
    expect(receiptSpy).not.toHaveBeenCalled();
  });
});
