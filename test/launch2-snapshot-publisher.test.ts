import { keccak256, stringToHex } from "viem";
import { describe, expect, it } from "vitest";

import { parseLaunch2SnapshotPublisher } from "../src/config.js";
import { buildLaunchMerkleTree } from "../src/features/launch/launch-merkle.js";
import {
  Launch2PublisherRevertError,
  createLaunch2SnapshotPublisher,
  launch2SnapshotDataHash,
  launch2SnapshotMembers,
  type Launch2PublicationCandidate,
  type Launch2PublicationRecord,
  type Launch2PublicationRepository,
  type Launch2PublisherChain,
  type Launch2SendResult,
  type Launch2SnapshotSigner,
} from "../src/features/launch2/launch2-snapshot-publisher.js";
import { createLaunch2SnapshotPublisherLane } from "../src/launch2-snapshot-publisher-worker.js";

const zero = `0x${"00".repeat(32)}`;
const hash = (byte: string) => `0x${byte.repeat(32)}`;
const addr = (digit: string) => `0x${digit.repeat(40)}`;
const saleStart = 1_000_000n;
const saleEnd = saleStart + 3_600n;
const key = (digit: string) => `0x${digit.repeat(64)}`;

function candidate(
  overrides: Partial<Launch2PublicationCandidate> = {},
): Launch2PublicationCandidate {
  return {
    instanceId: "8f0a3f8e-1c1f-4b7a-9d55-3a1b2c3d4e5f",
    launchId: hash("11"),
    nft: addr("a"),
    snapshots: addr("b"),
    deployBlockNumber: "10",
    nftSaleStart: new Date(Number(saleStart) * 1000).toISOString(),
    holdReason: null,
    graduated: false,
    generation: "v3",
    openedWithoutHolders: false,
    snapshotRoot: null,
    snapshotVerification: null,
    active: null,
    lastAttempt: 0,
    retryableFailures: 0,
    blockingCode: null,
    lastFailedAt: null,
    ...overrides,
  };
}

/** A chain where block n has timestamp saleStart - 100 + 10·n. */
function fakeChain(options: {
  head: bigint;
  sends?: Launch2SendResult[];
  receipt?: { status: "success" | "reverted"; blockNumber: bigint } | null;
  revert?: string;
  minted?: bigint;
  root?: string;
  publishedAt?: bigint;
  openRevert?: string;
}) {
  const sent: string[] = [];
  const signed: bigint[] = [];
  const opened: bigint[] = [];
  const stamp = (n: bigint) => saleStart - 100n + 10n * n;
  const state = { ...options };
  const chain: Launch2PublisherChain = {
    submitterAddress: addr("c"),
    chainId: () => Promise.resolve(97),
    head: () =>
      Promise.resolve({
        number: state.head,
        hash: hash("ee"),
        timestamp: stamp(state.head),
      }),
    block: (n) =>
      Promise.resolve(
        n > state.head
          ? null
          : {
              hash: `0x${n.toString(16).padStart(64, "0")}`,
              timestamp: stamp(n),
            },
      ),
    registry: () =>
      Promise.resolve({
        nftSaleEnd: saleEnd,
        launchId: hash("11"),
        nft: addr("a"),
      }),
    registryRoot: () => Promise.resolve(state.root ?? zero),
    registryPublishedAt: () => Promise.resolve(state.publishedAt ?? 0n),
    estimateOpenWithoutHolders: () =>
      state.openRevert === undefined
        ? Promise.resolve(60_000n)
        : Promise.reject(new Launch2PublisherRevertError(state.openRevert)),
    signOpenWithoutHolders: (_, tx) => {
      opened.push(tx.nonce);
      return Promise.resolve({ txHash: hash("88"), rawTx: "0xf8bb" });
    },
    isSnapshotSigner: (_, address) => Promise.resolve(address !== addr("9")),
    totalMintedAt: () => Promise.resolve(state.minted ?? 2n),
    snapshotDigest: () => Promise.resolve(hash("dd")),
    estimatePublish: () =>
      state.revert === undefined
        ? Promise.resolve(100_000n)
        : Promise.reject(new Launch2PublisherRevertError(state.revert)),
    gasPrice: () => Promise.resolve(1_000_000_000n),
    pendingNonce: () => Promise.resolve(7n),
    signPublish: (_, tx) => {
      signed.push(tx.nonce);
      return Promise.resolve({ txHash: hash("77"), rawTx: "0xf8aa" });
    },
    sendRaw: (raw) => {
      sent.push(raw);
      return Promise.resolve(state.sends?.shift() ?? "accepted");
    },
    receipt: () =>
      Promise.resolve(
        state.receipt === undefined || state.receipt === null
          ? null
          : {
              status: state.receipt.status,
              blockNumber: state.receipt.blockNumber,
              blockHash: `0x${state.receipt.blockNumber.toString(16).padStart(64, "0")}`,
            },
      ),
  };
  return { chain, sent, signed, opened, state };
}

function memoryRepository(initial: Launch2PublicationCandidate) {
  const rows: Launch2PublicationRecord[] = [];
  const closures: Parameters<
    Launch2PublicationRepository["recordNoHoldersClosure"]
  >[0][] = [];
  let base = initial;
  const repository: Launch2PublicationRepository = {
    recordNoHoldersClosure: (input) => {
      if (closures.some((entry) => entry.instanceId === input.instanceId)) {
        return Promise.resolve(false);
      }
      closures.push(input);
      return Promise.resolve(true);
    },
    listCandidates: () =>
      Promise.resolve(
        closures.some((entry) => entry.instanceId === base.instanceId)
          ? []
          : [
              {
                ...base,
                active:
                  rows.find((row) =>
                    ["pending", "broadcast", "confirmed"].includes(row.status),
                  ) ?? null,
                lastAttempt: rows.length,
                blockingCode:
                  rows.find(
                    (row) =>
                      row.status === "mismatch" ||
                      (row.status === "failed" &&
                        row.failureRetryable === false),
                  )?.failureCode ?? null,
                retryableFailures: rows.filter(
                  (row) =>
                    row.status === "failed" && row.failureRetryable === true,
                ).length,
              },
            ],
      ),
    insertPending: (input) => {
      if (
        rows.some((row) =>
          ["pending", "broadcast", "confirmed"].includes(row.status),
        )
      ) {
        return Promise.resolve(null);
      }
      const row: Launch2PublicationRecord = {
        publicationId: `p${rows.length + 1}`,
        instanceId: input.instanceId,
        action: input.action ?? "publish_snapshot",
        attempt: input.attempt,
        status: "pending",
        snapshots: input.snapshots,
        cutoffBlock: input.cutoffBlock,
        cutoffBlockHash: input.cutoffBlockHash,
        saleEndAt: input.saleEndAt,
        memberCount: input.members.length,
        root: input.root,
        dataHash: input.dataHash,
        signerAddresses: input.signerAddresses,
        signatures: input.signatures,
        submitterAddress: input.submitterAddress,
        txHash: null,
        txNonce: null,
        rawTx: null,
        blockNumber: null,
        blockHash: null,
        confirmations: null,
        failureCode: null,
        failureDetail: null,
        failureRetryable: null,
        createdAt: "2026-10-10T00:00:00.000Z",
        updatedAt: "2026-10-10T00:00:00.000Z",
      };
      rows.push(row);
      return Promise.resolve(row);
    },
    reserveAndRecordTx: async (input) => {
      const index = rows.findIndex(
        (row) => row.publicationId === input.publicationId,
      );
      const signed = await input.sign(input.chainPendingNonce);
      rows[index] = {
        ...rows[index]!,
        txHash: signed.txHash,
        rawTx: signed.rawTx,
        txNonce: input.chainPendingNonce.toString(10),
      };
      return rows[index];
    },
    transition: (input) => {
      const index = rows.findIndex(
        (row) =>
          row.publicationId === input.publicationId &&
          row.status === input.from,
      );
      if (index === -1) return Promise.resolve(null);
      const failed = input.to === "failed" || input.to === "mismatch";
      rows[index] = {
        ...rows[index]!,
        status: input.to,
        ...(input.inclusion === undefined
          ? {}
          : {
              blockNumber: input.inclusion?.blockNumber ?? null,
              blockHash: input.inclusion?.blockHash ?? null,
              confirmations: input.inclusion?.confirmations ?? null,
            }),
        failureCode: failed ? (input.failure?.code ?? null) : null,
        failureDetail: failed ? (input.failure?.detail ?? null) : null,
        failureRetryable:
          input.to === "failed" ? (input.failure?.retryable ?? null) : null,
      };
      return Promise.resolve(rows[index]);
    },
  };
  return {
    repository,
    rows,
    closures,
    setBase: (next: Partial<Launch2PublicationCandidate>) => {
      base = { ...base, ...next };
    },
  };
}

const signers: Launch2SnapshotSigner[] = ["1", "2", "9"].map((digit) => ({
  address: addr(digit),
  digest: () => hash("dd"),
  sign: () => Promise.resolve(`0x${digit.repeat(130)}`),
}));

function setup(
  chainOptions: Parameters<typeof fakeChain>[0],
  checkpoint = "1000",
  holders = [
    { address: addr("4"), balance: 1 },
    { address: addr("3"), balance: 1 },
  ],
  candidateOverrides: Partial<Launch2PublicationCandidate> = {},
) {
  const fake = fakeChain(chainOptions);
  const memory = memoryRepository(candidate(candidateOverrides));
  const publisher = createLaunch2SnapshotPublisher({
    repository: memory.repository,
    launch2: {
      getCheckpoint: () =>
        Promise.resolve({
          lastBlockNumber: checkpoint,
          lastBlockHash: hash("ab"),
          startedFromBlockNumber: "0",
          updatedAt: "2026-10-10T00:00:00.000Z",
        }),
      nftHoldersAt: () => Promise.resolve(holders),
    },
    chain: fake.chain,
    signers: [signers[2]!, signers[0]!, signers[1]!],
    policy: {
      chainId: "eip155:97",
      confirmations: 3,
      maxGasPriceWei: 5_000_000_000n,
      gasLimitCap: 1_000_000n,
      maxAttempts: 2,
      retryDelaySeconds: 0,
    },
  });
  return { ...fake, ...memory, publisher };
}

const id = candidate().instanceId;
// Sale end = saleStart + 3600 → cutoff block 369 (ts saleStart + 3590).
const cutoffBlock = 369n;

describe("Decision 0118 dataHash", () => {
  it("is keccak256 of the JSON of the sorted, de-duplicated lower-case members", () => {
    const members = [addr("B"), addr("a"), addr("b")];
    expect(launch2SnapshotMembers(members)).toEqual([addr("a"), addr("b")]);
    expect(launch2SnapshotDataHash(members)).toBe(
      keccak256(stringToHex(`["${addr("a")}","${addr("b")}"]`)),
    );
  });
});

describe("Decision 0118 snapshot publisher", () => {
  it("waits while the sale is open, the cutoff is shallow, or the indexer lags", async () => {
    expect((await setup({ head: 300n }).publisher.runOnce()).waiting[id]).toBe(
      "LAUNCH2_SNAPSHOT_SALE_OPEN",
    );
    expect(
      (await setup({ head: cutoffBlock + 2n }).publisher.runOnce()).waiting[id],
    ).toBe("LAUNCH2_SNAPSHOT_CUTOFF_UNCONFIRMED");
    const behind = setup({ head: cutoffBlock + 5n }, "371");
    expect((await behind.publisher.runOnce()).waiting[id]).toBe(
      "LAUNCH2_SNAPSHOT_INDEXER_BEHIND",
    );
    expect(behind.rows).toEqual([]);
  });

  it("refuses an indexed holder set that does not add up to totalMinted", async () => {
    const incomplete = setup({ head: 400n, minted: 3n });
    expect((await incomplete.publisher.runOnce()).waiting[id]).toBe(
      "LAUNCH2_SNAPSHOT_INDEXER_INCOMPLETE",
    );
    // No indexed holder while the chain says something was minted: the
    // indexer is incomplete, never a closure.
    const lagging = setup({ head: 400n, minted: 1n }, "1000", []);
    expect((await lagging.publisher.runOnce()).waiting[id]).toBe(
      "LAUNCH2_SNAPSHOT_INDEXER_INCOMPLETE",
    );
    expect([...incomplete.rows, ...lagging.rows]).toEqual([]);
    expect([...incomplete.closures, ...lagging.closures]).toEqual([]);
  });

  it("closes a v2-generation sale with no holder once (Decision 0120) and stops waiting", async () => {
    const empty = setup({ head: 400n, minted: 0n }, "1000", [], {
      generation: "v2",
    });
    const first = await empty.publisher.runOnce();
    expect(first.waiting[id]).toBe("LAUNCH2_SNAPSHOT_CLOSED_NO_HOLDERS");
    expect(empty.closures).toEqual([
      {
        instanceId: id,
        chainId: "eip155:97",
        snapshots: addr("b"),
        saleEndAt: new Date(Number(saleEnd) * 1000).toISOString(),
        cutoffBlock: cutoffBlock.toString(10),
        cutoffBlockHash: `0x${cutoffBlock.toString(16).padStart(64, "0")}`,
      },
    ]);
    expect(empty.rows).toEqual([]);
    expect(empty.sent).toEqual([]);
    // The closed instance is no longer a candidate.
    const second = await empty.publisher.runOnce();
    expect(second.candidates).toBe(0);
    expect(second.waiting).toEqual({});
  });

  it("does not close before the cutoff is confirmed or the indexer caught up", async () => {
    const shallow = setup({ head: cutoffBlock + 2n, minted: 0n }, "1000", []);
    expect((await shallow.publisher.runOnce()).waiting[id]).toBe(
      "LAUNCH2_SNAPSHOT_CUTOFF_UNCONFIRMED",
    );
    const behind = setup({ head: 400n, minted: 0n }, "371", []);
    expect((await behind.publisher.runOnce()).waiting[id]).toBe(
      "LAUNCH2_SNAPSHOT_INDEXER_BEHIND",
    );
    expect([...shallow.closures, ...behind.closures]).toEqual([]);
  });

  it("opens a v3 zero-holder sale publicly: row first, simulate, sign, send, confirm (Decision 0122)", async () => {
    const empty = setup(
      {
        head: 400n,
        minted: 0n,
        receipt: { status: "success", blockNumber: 398n },
      },
      "1000",
      [],
    );
    const first = await empty.publisher.runOnce();
    expect(first.waiting[id]).toBe("LAUNCH2_SNAPSHOT_OPENING_WITHOUT_HOLDERS");
    expect(empty.closures).toEqual([]);
    expect(empty.rows).toHaveLength(1);
    expect(empty.rows[0]).toMatchObject({
      action: "open_without_holders",
      status: "broadcast",
      memberCount: 0,
      root: zero,
      dataHash: zero,
      signerAddresses: [],
      signatures: [],
      cutoffBlock: cutoffBlock.toString(10),
      txHash: hash("88"),
      txNonce: "7",
    });
    // The open call shape was signed, never a publishSnapshot.
    expect(empty.opened).toEqual([7n]);
    expect(empty.signed).toEqual([]);
    expect(empty.sent).toEqual(["0xf8bb"]);
    await empty.publisher.runOnce();
    expect(empty.rows[0]?.status).toBe("confirmed");
    // Indexed by the lane: nothing more to do, not re-sent.
    empty.setBase({ openedWithoutHolders: true });
    const after = await empty.publisher.runOnce();
    expect(after.waiting).toEqual({});
    expect(empty.sent).toEqual(["0xf8bb"]);
  });

  it("a v3 opening another account already made is not repeated (Decision 0122)", async () => {
    const opened = setup(
      { head: 400n, minted: 0n, publishedAt: saleEnd + 5n },
      "1000",
      [],
    );
    expect((await opened.publisher.runOnce()).waiting[id]).toBe(
      "LAUNCH2_SNAPSHOT_ALREADY_ON_CHAIN",
    );
    expect(opened.rows).toEqual([]);
    const raced = setup(
      {
        head: 400n,
        minted: 0n,
        receipt: { status: "reverted", blockNumber: 398n },
      },
      "1000",
      [],
    );
    await raced.publisher.runOnce();
    raced.state.publishedAt = saleEnd + 1n;
    await raced.publisher.runOnce();
    expect(raced.rows[0]).toMatchObject({
      status: "failed",
      failureCode: "LAUNCH2_SNAPSHOT_OPENED_BY_OTHER",
      failureRetryable: false,
    });
    const refused = setup(
      { head: 400n, minted: 0n, openRevert: "HoldersExist" },
      "1000",
      [],
    );
    await refused.publisher.runOnce();
    expect(refused.rows[0]).toMatchObject({
      action: "open_without_holders",
      status: "failed",
      failureCode: "LAUNCH2_SNAPSHOT_CONTRACT_REVERTED",
      failureDetail: "HoldersExist",
      failureRetryable: false,
    });
    expect(refused.sent).toEqual([]);
  });

  it("refuses when an on-chain root already exists", async () => {
    const run = setup({ head: 400n, root: hash("12") });
    expect((await run.publisher.runOnce()).waiting[id]).toBe(
      "LAUNCH2_SNAPSHOT_ALREADY_ON_CHAIN",
    );
  });

  it("records, signs with registered signers first, sends once, then confirms", async () => {
    const run = setup({ head: 400n });
    await run.publisher.runOnce();
    expect(run.rows).toHaveLength(1);
    const members = [addr("3"), addr("4")];
    expect(run.rows[0]).toMatchObject({
      status: "broadcast",
      cutoffBlock: cutoffBlock.toString(10),
      root: buildLaunchMerkleTree(members).root,
      dataHash: launch2SnapshotDataHash(members),
      // anvil 9 is "unregistered" in this fake: it goes last.
      signerAddresses: [addr("1"), addr("2")],
      txNonce: "7",
    });
    expect(run.sent).toHaveLength(1);
    run.state.receipt = { status: "success", blockNumber: 401n };
    run.state.head = 402n;
    await run.publisher.runOnce();
    expect(run.rows[0]).toMatchObject({
      status: "broadcast",
      confirmations: 2,
    });
    run.state.head = 403n;
    await run.publisher.runOnce();
    await run.publisher.runOnce();
    expect(run.rows).toHaveLength(1);
    expect(run.rows[0]).toMatchObject({
      status: "confirmed",
      confirmations: 3,
    });
    expect(run.signed).toEqual([7n]);
  });

  it("re-sends the same bytes when a confirmed inclusion leaves the chain", async () => {
    const run = setup({ head: 400n });
    await run.publisher.runOnce();
    run.state.receipt = { status: "success", blockNumber: 401n };
    run.state.head = 410n;
    await run.publisher.runOnce();
    expect(run.rows[0]?.status).toBe("confirmed");
    run.state.receipt = null;
    await run.publisher.runOnce();
    expect(run.rows[0]).toMatchObject({ status: "broadcast", blockHash: null });
    expect(run.sent).toEqual(["0xf8aa", "0xf8aa"]);
    expect(run.signed).toEqual([7n]);
  });

  it("marks a confirmed publication mismatch when the lane does not reproduce it", async () => {
    const run = setup({ head: 400n });
    await run.publisher.runOnce();
    run.state.receipt = { status: "success", blockNumber: 401n };
    run.state.head = 410n;
    await run.publisher.runOnce();
    run.setBase({
      snapshotRoot: run.rows[0]!.root,
      snapshotVerification: "mismatch",
    });
    await run.publisher.runOnce();
    expect(run.rows[0]).toMatchObject({
      status: "mismatch",
      failureCode: "LAUNCH2_SNAPSHOT_NOT_REPRODUCED",
    });
  });

  it("a simulated revert is failed and blocks further attempts", async () => {
    const run = setup({ head: 400n, revert: "InvalidSnapshotSignatures" });
    await run.publisher.runOnce();
    expect(run.rows[0]).toMatchObject({
      status: "failed",
      failureCode: "LAUNCH2_SNAPSHOT_CONTRACT_REVERTED",
      failureDetail: "InvalidSnapshotSignatures",
      failureRetryable: false,
      txHash: null,
    });
    expect(run.sent).toEqual([]);
    expect((await run.publisher.runOnce()).waiting[id]).toBe(
      "LAUNCH2_SNAPSHOT_PUBLICATION_BLOCKED",
    );
    expect(run.rows).toHaveLength(1);
  });

  it("retries retryable send failures up to maxAttempts", async () => {
    const run = setup({
      head: 400n,
      sends: ["insufficient_funds", "rejected"],
    });
    await run.publisher.runOnce();
    await run.publisher.runOnce();
    expect(run.rows.map((row) => [row.status, row.failureCode])).toEqual([
      ["failed", "LAUNCH2_SNAPSHOT_SUBMITTER_INSUFFICIENT_FUNDS"],
      ["failed", "LAUNCH2_SNAPSHOT_TX_REJECTED"],
    ]);
    expect((await run.publisher.runOnce()).waiting[id]).toBe(
      "LAUNCH2_SNAPSHOT_ATTEMPTS_EXHAUSTED",
    );
  });

  it("a reverted receipt is failed; a dropped transaction is retryable", async () => {
    const reverted = setup({ head: 400n });
    await reverted.publisher.runOnce();
    reverted.state.receipt = { status: "reverted", blockNumber: 401n };
    await reverted.publisher.runOnce();
    expect(reverted.rows[0]).toMatchObject({
      status: "failed",
      failureCode: "LAUNCH2_SNAPSHOT_TX_REVERTED",
      failureRetryable: false,
    });
    const dropped = setup({ head: 400n, sends: ["accepted", "nonce_too_low"] });
    await dropped.publisher.runOnce();
    await dropped.publisher.runOnce();
    expect(dropped.rows[0]).toMatchObject({
      status: "failed",
      failureCode: "LAUNCH2_SNAPSHOT_TX_DROPPED",
      failureRetryable: true,
    });
  });

  it("the lane reports each waiting reason once until it changes", async () => {
    const fake = fakeChain({ head: 300n });
    const memory = memoryRepository(candidate());
    const seen: string[] = [];
    const lane = createLaunch2SnapshotPublisherLane({
      repository: memory.repository,
      launch2: {
        getCheckpoint: () => Promise.resolve(null),
        nftHoldersAt: () => Promise.resolve([]),
      },
      chain: fake.chain,
      signers: signers.slice(0, 2),
      policy: {
        chainId: "eip155:97",
        confirmations: 3,
        maxGasPriceWei: 1n,
        gasLimitCap: 1n,
        maxAttempts: 1,
        retryDelaySeconds: 0,
      },
      pollIntervalMs: 1_000,
      onWaiting: (event) => seen.push(event.reasonCode),
    });
    await lane.runOnce();
    await lane.runOnce();
    fake.state.head = 400n;
    await lane.runOnce();
    expect(seen).toEqual([
      "LAUNCH2_SNAPSHOT_SALE_OPEN",
      "LAUNCH2_SNAPSHOT_INDEXER_BEHIND",
    ]);
  });
});

describe("Decision 0118 publisher configuration", () => {
  const base = {
    LAUNCH_CHAIN_ID: "97" as const,
    LAUNCH2_SNAPSHOT_PUBLISHER_ENABLED: true,
    LAUNCH2_SNAPSHOT_PUBLISHER_POLL_INTERVAL_MS: 5_000,
    LAUNCH2_SNAPSHOT_PUBLISHER_CONFIRMATIONS: 12,
    LAUNCH2_SNAPSHOT_PUBLISHER_MAX_GAS_PRICE_GWEI: 20,
  };

  it("is null when disabled", () => {
    expect(
      parseLaunch2SnapshotPublisher({
        ...base,
        LAUNCH2_SNAPSHOT_PUBLISHER_ENABLED: false,
      }),
    ).toBeNull();
  });

  it("refuses fewer than two distinct keys, malformed keys, no submitter, or mainnet", () => {
    const run = (extra: Record<string, string | undefined>) => () =>
      parseLaunch2SnapshotPublisher({ ...base, ...extra });
    expect(run({ LAUNCH2_SNAPSHOT_SIGNER_PRIVATE_KEYS: undefined })).toThrow(
      /2 or 3 distinct/u,
    );
    expect(
      run({
        LAUNCH2_SNAPSHOT_SIGNER_PRIVATE_KEYS: `${key("1")},${key("1")}`,
        HOOKS_LAUNCH_EXECUTOR_PRIVATE_KEY: key("5"),
      }),
    ).toThrow(/2 or 3 distinct/u);
    expect(
      run({
        LAUNCH2_SNAPSHOT_SIGNER_PRIVATE_KEYS: `${key("1")},nope`,
        HOOKS_LAUNCH_EXECUTOR_PRIVATE_KEY: key("5"),
      }),
    ).toThrow(/32-byte hex key/u);
    expect(
      run({ LAUNCH2_SNAPSHOT_SIGNER_PRIVATE_KEYS: `${key("1")},${key("2")}` }),
    ).toThrow(/SUBMITTER_PRIVATE_KEY/u);
    expect(() =>
      parseLaunch2SnapshotPublisher({
        ...base,
        LAUNCH_CHAIN_ID: "56",
        LAUNCH2_SNAPSHOT_SIGNER_PRIVATE_KEYS: `${key("1")},${key("2")}`,
        HOOKS_LAUNCH_EXECUTOR_PRIVATE_KEY: key("5"),
      }),
    ).toThrow(/BSC Mainnet signing stays closed/u);
  });

  it("reuses the Hooks executor key unless an own submitter key is set; never echoes keys", () => {
    const reused = parseLaunch2SnapshotPublisher({
      ...base,
      LAUNCH2_SNAPSHOT_SIGNER_PRIVATE_KEYS: ` ${key("1")} , ${key("2")}`,
      HOOKS_LAUNCH_EXECUTOR_PRIVATE_KEY: key("5"),
    });
    expect(reused).toMatchObject({
      signerPrivateKeys: [key("1"), key("2")],
      submitterPrivateKey: key("5"),
      submitterSource: "executor",
      confirmations: 12,
    });
    const own = parseLaunch2SnapshotPublisher({
      ...base,
      LAUNCH2_SNAPSHOT_SIGNER_PRIVATE_KEYS: `${key("1")},${key("2")},${key("3")}`,
      LAUNCH2_SNAPSHOT_SUBMITTER_PRIVATE_KEY: key("6"),
      HOOKS_LAUNCH_EXECUTOR_PRIVATE_KEY: key("5"),
    });
    expect(own).toMatchObject({
      submitterPrivateKey: key("6"),
      submitterSource: "own",
    });
    try {
      parseLaunch2SnapshotPublisher({
        ...base,
        LAUNCH2_SNAPSHOT_SIGNER_PRIVATE_KEYS: key("1"),
      });
    } catch (error) {
      expect(String(error)).not.toContain("1".repeat(64));
    }
  });
});
