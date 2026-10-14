import { describe, expect, it } from "vitest";

import { parseLaunch2SnapshotPublisher } from "../src/config.js";
import {
  createLaunch2SnapshotPublisher,
  type Launch2PublicationCandidate,
  type Launch2PublicationRecord,
  type Launch2PublicationRepository,
  type Launch2PublisherChain,
  type Launch2SendResult,
} from "../src/features/launch2/launch2-snapshot-publisher.js";

/**
 * Decision 0137: the `launch2_snapshot_publisher` lane's snapshot-timeout
 * fallback — `openPublicAfterTimeout()` for an S175 instance whose sale had
 * holders, past `snapshotTimeoutAt()`, while the normal 2-of-3 path is
 * stuck; behind `LAUNCH2_TIMEOUT_OPEN_ENABLED` (default off → logged as
 * skipped); nothing at all for a Factory without exit paths.
 */

const zero = `0x${"00".repeat(32)}`;
const hash = (byte: string) => `0x${byte.repeat(32)}`;
const addr = (digit: string) => `0x${digit.repeat(40)}`;
const saleStart = 1_000_000n;
const saleEnd = saleStart + 3_600n;
const timeoutAt = saleEnd + 3_600n;
const id = "8f0a3f8e-1c1f-4b7a-9d55-3a1b2c3d4e5f";

function candidate(
  overrides: Partial<Launch2PublicationCandidate> = {},
): Launch2PublicationCandidate {
  return {
    instanceId: id,
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
    lastAttempt: 1,
    retryableFailures: 0,
    // The normal path failed for good (e.g. InvalidSnapshotSignatures).
    blockingCode: "LAUNCH2_SNAPSHOT_CONTRACT_REVERTED",
    lastFailedAt: null,
    factoryAddress: addr("5"),
    openedAfterTimeout: false,
    timeoutOpen: { retryableFailures: 0, blocked: false, lastFailedAt: null },
    ...overrides,
  };
}

interface ChainState {
  timestamp: bigint;
  supported: boolean | "absent";
  minted: bigint;
  publishedAt: bigint;
  openRevert?: string;
  receipt: { status: "success" | "reverted"; blockNumber: bigint } | null;
  sends: Launch2SendResult[];
}

function fakeChain(overrides: Partial<ChainState> = {}) {
  const state: ChainState = {
    timestamp: timeoutAt,
    supported: true,
    minted: 2n,
    publishedAt: 0n,
    receipt: null,
    sends: [],
    ...overrides,
  };
  const sent: string[] = [];
  const opened: bigint[] = [];
  const probes: string[] = [];
  const chain: Launch2PublisherChain = {
    submitterAddress: addr("c"),
    chainId: () => Promise.resolve(97),
    head: () =>
      Promise.resolve({
        number: 400n,
        hash: hash("ee"),
        timestamp: state.timestamp,
      }),
    block: () => Promise.resolve({ hash: hash("ef"), timestamp: 0n }),
    registry: () =>
      Promise.resolve({
        nftSaleEnd: saleEnd,
        launchId: hash("11"),
        nft: addr("a"),
      }),
    registryRoot: () => Promise.resolve(zero),
    registryPublishedAt: () => Promise.resolve(state.publishedAt),
    estimateOpenWithoutHolders: () => Promise.reject(new Error("unused")),
    signOpenWithoutHolders: () => Promise.reject(new Error("unused")),
    isSnapshotSigner: () => Promise.resolve(true),
    totalMintedAt: () => Promise.resolve(state.minted),
    snapshotDigest: () => Promise.resolve(hash("dd")),
    estimatePublish: () => Promise.reject(new Error("unused")),
    gasPrice: () => Promise.resolve(1_000_000_000n),
    pendingNonce: () => Promise.resolve(7n),
    signPublish: () => Promise.reject(new Error("unused")),
    sendRaw: (raw) => {
      sent.push(raw);
      return Promise.resolve(state.sends.shift() ?? "accepted");
    },
    receipt: () =>
      Promise.resolve(
        state.receipt === null
          ? null
          : {
              status: state.receipt.status,
              blockNumber: state.receipt.blockNumber,
              blockHash: hash("ef"),
            },
      ),
    ...(state.supported === "absent"
      ? {}
      : {
          exitTiming: (factory: string) => {
            probes.push(factory);
            return Promise.resolve(
              state.supported === true
                ? { snapshotTimeout: 3_600n, refundDelay: 3_600n }
                : null,
            );
          },
          registrySnapshotTimeoutAt: () => Promise.resolve(timeoutAt),
          estimateOpenAfterTimeout: () =>
            state.openRevert === undefined
              ? Promise.resolve(50_000n)
              : Promise.reject(
                  Object.assign(new Error("revert"), {
                    name: "Launch2PublisherRevertError",
                  }),
                ),
          signOpenAfterTimeout: (_: string, tx: { nonce: bigint }) => {
            opened.push(tx.nonce);
            return Promise.resolve({ txHash: hash("99"), rawTx: "0xf8cc" });
          },
        }),
  };
  return { chain, state, sent, opened, probes };
}

function memory(initial: Launch2PublicationCandidate) {
  const rows: Launch2PublicationRecord[] = [];
  let base = initial;
  const repository: Launch2PublicationRepository = {
    recordNoHoldersClosure: () => Promise.resolve(false),
    listCandidates: () => {
      const timeoutRows = rows.filter(
        (row) => row.action === "open_after_timeout",
      );
      return Promise.resolve([
        {
          ...base,
          active:
            rows.find((row) =>
              ["pending", "broadcast", "confirmed"].includes(row.status),
            ) ?? null,
          lastAttempt: base.lastAttempt + rows.length,
          timeoutOpen: {
            retryableFailures: timeoutRows.filter(
              (row) => row.status === "failed" && row.failureRetryable === true,
            ).length,
            blocked: timeoutRows.some(
              (row) =>
                row.status === "failed" && row.failureRetryable === false,
            ),
            lastFailedAt: null,
          },
        },
      ]);
    },
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
        createdAt: "2026-10-14T00:00:00.000Z",
        updatedAt: "2026-10-14T00:00:00.000Z",
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
        ...(input.inclusion === undefined || input.inclusion === null
          ? {}
          : {
              blockNumber: input.inclusion.blockNumber,
              blockHash: input.inclusion.blockHash,
              confirmations: input.inclusion.confirmations,
            }),
        failureCode: failed ? (input.failure?.code ?? null) : null,
        failureRetryable:
          input.to === "failed" ? (input.failure?.retryable ?? null) : null,
      };
      return Promise.resolve(rows[index]);
    },
  };
  return {
    repository,
    rows,
    setBase: (next: Partial<Launch2PublicationCandidate>) => {
      base = { ...base, ...next };
    },
  };
}

function setup(
  chainOverrides: Partial<ChainState> = {},
  options: {
    readonly enabled?: boolean;
    readonly candidate?: Partial<Launch2PublicationCandidate>;
  } = {},
) {
  const fake = fakeChain(chainOverrides);
  const store = memory(candidate(options.candidate));
  const publisher = createLaunch2SnapshotPublisher({
    repository: store.repository,
    launch2: {
      getCheckpoint: () => Promise.resolve(null),
      nftHoldersAt: () => Promise.resolve([]),
    },
    chain: fake.chain,
    signers: [
      {
        address: addr("1"),
        digest: () => hash("dd"),
        sign: () => Promise.resolve("0x"),
      },
      {
        address: addr("2"),
        digest: () => hash("dd"),
        sign: () => Promise.resolve("0x"),
      },
    ],
    policy: {
      chainId: "eip155:97",
      confirmations: 3,
      maxGasPriceWei: 5_000_000_000n,
      gasLimitCap: 1_000_000n,
      maxAttempts: 2,
      retryDelaySeconds: 0,
      ...(options.enabled === true ? { timeoutOpenEnabled: true } : {}),
    },
  });
  return { ...fake, ...store, publisher };
}

describe("Decision 0137 snapshot-timeout opening", () => {
  it("does nothing for a Factory without exit paths (or an older chain)", async () => {
    for (const supported of [false, "absent"] as const) {
      const run = setup({ supported }, { enabled: true });
      const result = await run.publisher.runOnce();
      expect(result.waiting[id]).toBe("LAUNCH2_SNAPSHOT_PUBLICATION_BLOCKED");
      expect(run.rows).toEqual([]);
      expect(run.sent).toEqual([]);
    }
  });

  it("keeps the normal reason before snapshotTimeoutAt and for a zero-mint sale", async () => {
    const early = setup({ timestamp: timeoutAt - 1n }, { enabled: true });
    expect((await early.publisher.runOnce()).waiting[id]).toBe(
      "LAUNCH2_SNAPSHOT_PUBLICATION_BLOCKED",
    );
    const empty = setup({ minted: 0n }, { enabled: true });
    expect((await empty.publisher.runOnce()).waiting[id]).toBe(
      "LAUNCH2_SNAPSHOT_PUBLICATION_BLOCKED",
    );
    expect([...early.rows, ...empty.rows]).toEqual([]);
  });

  it("logs LAUNCH2_TIMEOUT_OPEN_SKIPPED while LAUNCH2_TIMEOUT_OPEN_ENABLED is off", async () => {
    const run = setup();
    expect((await run.publisher.runOnce()).waiting[id]).toBe(
      "LAUNCH2_TIMEOUT_OPEN_SKIPPED",
    );
    expect(run.rows).toEqual([]);
    expect(run.sent).toEqual([]);
    // The probe is cached per Factory.
    await run.publisher.runOnce();
    expect(run.probes).toEqual([addr("5")]);
  });

  it("records, signs and sends openPublicAfterTimeout() from the submitter, then confirms", async () => {
    const run = setup(
      { receipt: { status: "success", blockNumber: 396n } },
      { enabled: true },
    );
    const first = await run.publisher.runOnce();
    expect(first.waiting[id]).toBe("LAUNCH2_TIMEOUT_OPEN_SENT");
    expect(run.rows).toHaveLength(1);
    expect(run.rows[0]).toMatchObject({
      action: "open_after_timeout",
      status: "broadcast",
      memberCount: 0,
      root: zero,
      dataHash: zero,
      signerAddresses: [],
      signatures: [],
      cutoffBlock: "400",
      cutoffBlockHash: hash("ee"),
      submitterAddress: addr("c"),
      txHash: hash("99"),
      txNonce: "7",
    });
    expect(run.opened).toEqual([7n]);
    expect(run.sent).toEqual(["0xf8cc"]);
    await run.publisher.runOnce();
    expect(run.rows[0]?.status).toBe("confirmed");
    // The lane indexed PublicRoundOpenedAfterTimeout: done, not re-sent.
    run.setBase({ openedAfterTimeout: true });
    expect((await run.publisher.runOnce()).waiting).toEqual({});
    expect(run.sent).toEqual(["0xf8cc"]);
  });

  it("another opener first: ALREADY_ON_CHAIN, or failed OPENED_BY_OTHER and then skipped", async () => {
    const before = setup({ publishedAt: timeoutAt + 1n }, { enabled: true });
    expect((await before.publisher.runOnce()).waiting[id]).toBe(
      "LAUNCH2_SNAPSHOT_ALREADY_ON_CHAIN",
    );
    expect(before.rows).toEqual([]);
    const raced = setup(
      { receipt: { status: "reverted", blockNumber: 396n } },
      { enabled: true },
    );
    await raced.publisher.runOnce();
    raced.state.publishedAt = timeoutAt + 2n;
    await raced.publisher.runOnce();
    expect(raced.rows[0]).toMatchObject({
      action: "open_after_timeout",
      status: "failed",
      failureCode: "LAUNCH2_SNAPSHOT_OPENED_BY_OTHER",
      failureRetryable: false,
    });
    raced.state.publishedAt = 0n;
    expect((await raced.publisher.runOnce()).waiting[id]).toBe(
      "LAUNCH2_TIMEOUT_OPEN_SKIPPED",
    );
    expect(raced.rows).toHaveLength(1);
  });

  it("parses LAUNCH2_TIMEOUT_OPEN_ENABLED (absent / false: no key)", () => {
    const base = {
      LAUNCH_CHAIN_ID: "97" as const,
      LAUNCH2_SNAPSHOT_PUBLISHER_ENABLED: true,
      LAUNCH2_SNAPSHOT_SIGNER_PRIVATE_KEYS: `0x${"1".repeat(64)},0x${"2".repeat(64)}`,
      HOOKS_LAUNCH_EXECUTOR_PRIVATE_KEY: `0x${"3".repeat(64)}`,
      LAUNCH2_SNAPSHOT_PUBLISHER_POLL_INTERVAL_MS: 5_000,
      LAUNCH2_SNAPSHOT_PUBLISHER_CONFIRMATIONS: 12,
      LAUNCH2_SNAPSHOT_PUBLISHER_MAX_GAS_PRICE_GWEI: 20,
    };
    expect(parseLaunch2SnapshotPublisher(base)).not.toHaveProperty(
      "timeoutOpenEnabled",
    );
    expect(
      parseLaunch2SnapshotPublisher({
        ...base,
        LAUNCH2_TIMEOUT_OPEN_ENABLED: false,
      }),
    ).not.toHaveProperty("timeoutOpenEnabled");
    expect(
      parseLaunch2SnapshotPublisher({
        ...base,
        LAUNCH2_TIMEOUT_OPEN_ENABLED: true,
      }),
    ).toMatchObject({ timeoutOpenEnabled: true });
  });
});
