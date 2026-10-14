import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { decodeFunctionData } from "viem";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type {
  ChainGuardIncidentRecord,
  ChainGuardRepository,
} from "../src/features/chain-guard/chain-guard-contract.js";
import type {
  Launch2Chain,
  Launch2InstanceRecord,
  Launch2NftRefundQuote,
  Launch2NftRefundRecord,
  Launch2NftRefundReportRecord,
  Launch2Repository,
} from "../src/features/launch2/launch2-ports.js";
import { launch2ExitNftEscrowAbi } from "../src/integrations/launch/hooks-launch-protocol-abi-escrow-exit.js";
import { launch2InstanceDetailResourceSchema } from "../src/routes/v2/launch2-schemas.js";
import {
  createFakeLaunch2Chain,
  createInMemoryLaunch2Repository,
  defaultChainState,
  instanceFixture,
  launch2Env,
  launch2NowSeconds,
  launch2WritesEnv,
  wad,
} from "./helpers/launch2-fakes.js";
import {
  walletAddress,
  walletId,
  walletsFake,
} from "./helpers/launch-service-fakes.js";
import {
  createFakeMemeSlotClient,
  defaultMemeFunds,
  memeUsd1,
} from "./helpers/meme-service-fakes.js";
import {
  s7CommandHeaders,
  s7CommonHeaders,
  s7Database,
  s7PrivyVerifier,
  s7TestConfig,
} from "./s7-route-fakes.js";

/**
 * Decision 0137: the S175 escrow exit paths on `/v2/launch2/*` — the
 * instance detail's `exitPaths` / `viewerNftRefunds` (null for a Factory
 * without them), and `nft/refund/prepare` / `nft/refund/report` (the five
 * refusals, the chain guard hold, the intent shape, the report).
 */

const now = launch2NowSeconds;
const iso = (seconds: bigint) => new Date(Number(seconds) * 1000).toISOString();
const timing = { snapshotTimeout: 3_600n, refundDelay: 3_600n };
const stranger = `0x${"9".repeat(40)}`;

/** Sale ended 2 h ago (1-hour sale): the timeout is 1 h past. */
function endedInstance(
  overrides: Partial<Launch2InstanceRecord> = {},
): Launch2InstanceRecord {
  return instanceFixture(
    {
      nftSaleStart: iso(now - 10_800n),
      stage: "snapshot_pending",
      nftMintedCount: "3",
      nftRefundedCount: "1",
      ...overrides,
    },
    3_600n,
  );
}

interface ExitWorld {
  supported: boolean | "missing" | "fail";
  held: string[];
  refundOpensAt: bigint;
  graduated: boolean;
  tokens: Map<string, Partial<Launch2NftRefundQuote>>;
  failQuotes: boolean;
  indexed: Launch2NftRefundRecord[];
  quoteReads: number;
}

function world(overrides: Partial<ExitWorld> = {}): ExitWorld {
  return {
    supported: true,
    held: ["1", "2"],
    refundOpensAt: now - 60n,
    graduated: false,
    tokens: new Map(),
    failQuotes: false,
    indexed: [],
    quoteReads: 0,
    ...overrides,
  };
}

function exitChain(state: ExitWorld): Launch2Chain {
  const base = createFakeLaunch2Chain(defaultChainState());
  if (state.supported === "missing") return base;
  return {
    ...base,
    readExitTiming: () =>
      state.supported === "fail"
        ? Promise.reject(new Error("socket hang up"))
        : Promise.resolve(state.supported ? timing : null),
    readNftRefunds: (input) => {
      state.quoteReads += 1;
      if (state.failQuotes) return Promise.reject(new Error("rpc down"));
      return Promise.resolve({
        blockNumber: 7_000n,
        blockHash: `0x${"78".repeat(32)}`,
        blockTimestamp: now,
        graduated: state.graduated,
        usd1: memeUsd1,
        refundOpensAt: state.refundOpensAt,
        tokens: input.tokenIds.map((tokenId) => ({
          tokenId: tokenId.toString(10),
          owner: walletAddress,
          refunded: false,
          claimable: !state.graduated && now >= state.refundOpensAt,
          amount: 100n * wad,
          opensAt: state.refundOpensAt,
          ...state.tokens.get(tokenId.toString(10)),
        })),
      });
    },
  };
}

function exitRepository(state: ExitWorld) {
  const repository = createInMemoryLaunch2Repository();
  const reports = new Map<string, Launch2NftRefundReportRecord>();
  const exit: Launch2Repository = {
    ...repository,
    listHeldNftTokens: () => Promise.resolve(state.held),
    listNftRefunds: (input) =>
      Promise.resolve(
        state.indexed.filter(
          (row) =>
            input.tokenIds.length === 0 || input.tokenIds.includes(row.tokenId),
        ),
      ),
    getNftRefundIntent: (input) => {
      const intent = repository.intents.get(input.intentId);
      return Promise.resolve(
        intent !== undefined &&
          intent.kind === "nft_refund" &&
          intent.ownerUserId === input.ownerUserId
          ? intent
          : null,
      );
    },
    recordNftRefundReport: (input) => {
      const existing = reports.get(input.intentId);
      if (existing !== undefined) {
        return Promise.resolve({
          outcome:
            existing.transactionHash === input.transactionHash
              ? ("same" as const)
              : ("conflict" as const),
          report: existing,
        });
      }
      const report: Launch2NftRefundReportRecord = {
        intentId: input.intentId,
        instanceId: input.instanceId,
        walletId: input.walletId,
        walletAddress: input.walletAddress,
        tokenId: input.tokenId,
        transactionHash: input.transactionHash,
        reportedAt: iso(now),
      };
      reports.set(input.intentId, report);
      return Promise.resolve({ outcome: "created" as const, report });
    },
  };
  return { repository, exit };
}

function holdRepository(): ChainGuardRepository {
  const hold: ChainGuardIncidentRecord = {
    incidentId: randomUUID(),
    chainId: "eip155:97",
    kind: "usd1_paused",
    subject: memeUsd1,
    details: {},
    firstSeenAt: "2026-10-14T01:00:00.000Z",
    lastSeenAt: "2026-10-14T01:00:00.000Z",
    resolvedAt: null,
    resolution: null,
    resolvedBy: null,
    resolutionNote: null,
  };
  return {
    listHolds: () => Promise.resolve([hold]),
  } as unknown as ChainGuardRepository;
}

describe("launch2 escrow exit paths (Decision 0137)", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function createApp(
    state: ExitWorld,
    record: Launch2InstanceRecord = endedInstance(),
    options: { readonly hold?: boolean } = {},
  ) {
    const { repository, exit } = exitRepository(state);
    repository.instances.set(record.instanceId, record);
    const app = await buildApp({
      config: s7TestConfig({
        ...launch2Env,
        ...launch2WritesEnv,
        ...(options.hold === true ? { CHAIN_GUARD_ENABLED: "true" } : {}),
      }),
      contractSurface: "v2",
      database: {
        ...s7Database({}),
        launch2: exit,
        accountWallets: walletsFake(),
        ...(options.hold === true ? { chainGuard: holdRepository() } : {}),
      },
      privyAccessTokenVerifier: s7PrivyVerifier(),
      launch2Chain: exitChain(state),
      launchChainReadClient: createFakeMemeSlotClient(
        defaultMemeFunds({ usd1Allowance: 0n, tokenAllowance: 0n }),
      ),
      walletIntentNow: () => new Date(Number(now) * 1000),
      logger: false,
    });
    apps.push(app);
    return { app, id: record.instanceId, record, repository };
  }

  const detail = async (app: FastifyInstance, id: string) => {
    const response = await app.inject({
      method: "GET",
      url: `/v2/launch2/instances/${id}`,
      headers: s7CommonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ instance: Record<string, unknown> }>().instance;
  };

  const prepare = (app: FastifyInstance, id: string, tokenId = "1") =>
    app.inject({
      method: "POST",
      url: `/v2/launch2/instances/${id}/nft/refund/prepare`,
      headers: s7CommandHeaders({ "idempotency-key": randomUUID() }),
      payload: { walletId, tokenId },
    });

  const report = (
    app: FastifyInstance,
    id: string,
    payload: Record<string, unknown>,
  ) =>
    app.inject({
      method: "POST",
      url: `/v2/launch2/instances/${id}/nft/refund/report`,
      headers: s7CommandHeaders({ "idempotency-key": randomUUID() }),
      payload,
    });

  it("is null / 503 LAUNCH2_EXIT_PATHS_UNSUPPORTED for a Factory without exit paths", async () => {
    for (const supported of [false, "missing", "fail"] as const) {
      const state = world({ supported });
      const { app, id } = await createApp(state);
      const instance = await detail(app, id);
      expect(instance["exitPaths"], String(supported)).toBeNull();
      expect(instance["viewerNftRefunds"], String(supported)).toBeNull();
      const response = await prepare(app, id);
      expect(response.statusCode, String(supported)).toBe(503);
      expect(response.json()).toMatchObject({
        code: "CAPABILITY_UNAVAILABLE",
        detailsSafe: {
          reasonCode:
            supported === "fail"
              ? "LAUNCH2_CHAIN_READ_FAILED"
              : "LAUNCH2_EXIT_PATHS_UNSUPPORTED",
        },
      });
      expect(state.quoteReads).toBe(0);
    }
    expect(
      launch2InstanceDetailResourceSchema.properties.instance.required,
    ).toEqual(expect.arrayContaining(["exitPaths", "viewerNftRefunds"]));
  });

  it("derives timeoutOpenState waiting / available / opened_by_timeout and refundState", async () => {
    // Sale ended 100 s ago: the timeout is 3,500 s away.
    const waiting = await createApp(
      world(),
      endedInstance({ nftSaleStart: iso(now - 3_700n) }),
    );
    expect(await detail(waiting.app, waiting.id)).toMatchObject({
      stage: "snapshot_pending",
      exitPaths: {
        snapshotTimeoutAt: iso(now - 100n + 3_600n),
        timeoutOpenState: "waiting",
        refundOpensAt: iso(now - 100n + 7_200n),
        refundState: "waiting",
        refundedCount: 1,
        totalMinted: 3,
      },
    });
    const available = await createApp(world());
    expect(
      (await detail(available.app, available.id))["exitPaths"],
    ).toMatchObject({
      timeoutOpenState: "available",
      refundOpensAt: iso(now),
      refundState: "open",
    });
    const opened = await createApp(
      world(),
      endedInstance({
        openedAfterTimeout: {
          openedAt: iso(now - 3_500n),
          blockNumber: "900",
          transactionHash: `0x${"91".repeat(32)}`,
          totalMinted: "3",
        },
      }),
    );
    const openedDetail = await detail(opened.app, opened.id);
    expect(openedDetail).toMatchObject({
      stage: "public",
      exitPaths: { timeoutOpenState: "opened_by_timeout", refundState: "open" },
    });
    expect(
      (openedDetail["snapshot"] as Record<string, unknown>)["earlyRoundEndsAt"],
    ).toBe(iso(now - 3_500n));
    const graduated = await createApp(
      world({ graduated: true }),
      endedInstance({
        snapshot: {
          root: `0x${"33".repeat(32)}`,
          dataHash: null,
          cutoffBlock: "500",
          cutoffBlockHash: null,
          publishedAt: iso(now - 7_100n),
          publishedBlock: "510",
          transactionHash: null,
          verification: "verified",
          memberCount: 3,
          signers: null,
        },
        graduation: {
          graduatedAt: iso(now - 60n),
          blockNumber: "990",
          transactionHash: `0x${"92".repeat(32)}`,
          poolId: `0x${"93".repeat(32)}`,
        },
      }),
    );
    expect(
      (await detail(graduated.app, graduated.id))["exitPaths"],
    ).toMatchObject({
      timeoutOpenState: "not_applicable",
      refundState: "closed_graduated",
    });
    const empty = await createApp(
      world({ held: [] }),
      endedInstance({ nftMintedCount: "0", nftRefundedCount: "0" }),
    );
    const emptyDetail = await detail(empty.app, empty.id);
    expect(emptyDetail["exitPaths"]).toMatchObject({
      refundState: "not_applicable",
    });
    expect(emptyDetail["viewerNftRefunds"]).toEqual([]);
  });

  it("lists the viewer's held NFTs with the on-chain quote (owner confirmed on chain)", async () => {
    const state = world({ held: ["1", "2", "3"] });
    state.tokens.set("2", {
      refunded: true,
      claimable: false,
      amount: 0n,
    });
    // The index still says held, the chain already moved it.
    state.tokens.set("3", { owner: stranger });
    const { app, id } = await createApp(state);
    expect((await detail(app, id))["viewerNftRefunds"]).toEqual([
      {
        tokenId: "1",
        refunded: false,
        claimable: true,
        amount: "100",
        opensAt: iso(now - 60n),
      },
      {
        tokenId: "2",
        refunded: true,
        claimable: false,
        amount: "0",
        opensAt: iso(now - 60n),
      },
    ]);
    state.failQuotes = true;
    const failed = await detail(app, id);
    expect(failed["viewerNftRefunds"]).toBeNull();
    expect(failed["exitPaths"]).not.toBeNull();
  });

  it("prepares claimRefund(tokenId) on the escrow without an approve", async () => {
    const { app, id, record } = await createApp(world());
    const response = await prepare(app, id, "1");
    expect(response.statusCode).toBe(201);
    const body = response.json<{
      launch2Intent: Record<string, unknown> & {
        calldata: { to: string; data: string };
      };
      refund: Record<string, unknown>;
    }>();
    expect(body.launch2Intent).toMatchObject({
      kind: "nft_refund",
      contractAddress: record.addresses.escrow,
      approval: null,
      expectedOut: "100",
    });
    expect(body.launch2Intent.calldata.to).toBe(record.addresses.escrow);
    expect(
      decodeFunctionData({
        abi: launch2ExitNftEscrowAbi,
        data: body.launch2Intent.calldata.data as `0x${string}`,
      }),
    ).toMatchObject({ functionName: "claimRefund", args: [1n] });
    expect(body.refund).toEqual({
      tokenId: "1",
      escrow: record.addresses.escrow,
      amountUsd1: "100",
      opensAt: iso(now - 60n),
    });
  });

  it("refuses not owner, not open, graduated, already claimed, nothing to refund", async () => {
    const cases: [
      Partial<ExitWorld>,
      number,
      string,
      string,
      Record<string, unknown>?,
    ][] = [
      [
        { tokens: new Map([["1", { owner: stranger }]]) },
        403,
        "POLICY_BLOCKED",
        "LAUNCH2_REFUND_NOT_OWNER",
      ],
      [
        { tokens: new Map([["1", { owner: null }]]) },
        403,
        "POLICY_BLOCKED",
        "LAUNCH2_REFUND_NOT_OWNER",
      ],
      [
        { refundOpensAt: now + 600n },
        409,
        "DATA_STALE",
        "LAUNCH2_REFUND_NOT_OPEN",
        { opensAt: iso(now + 600n) },
      ],
      [{ graduated: true }, 409, "DATA_STALE", "LAUNCH2_REFUND_GRADUATED"],
      [
        {
          tokens: new Map([
            ["1", { refunded: true, claimable: false, amount: 0n }],
          ]),
        },
        409,
        "DATA_STALE",
        "LAUNCH2_REFUND_ALREADY_CLAIMED",
      ],
      [
        { tokens: new Map([["1", { claimable: false, amount: 0n }]]) },
        409,
        "INSUFFICIENT_BALANCE",
        "LAUNCH2_REFUND_NOTHING_TO_REFUND",
      ],
    ];
    for (const [overrides, status, code, reasonCode, extra] of cases) {
      const { app, id, repository } = await createApp(world(overrides));
      const response = await prepare(app, id);
      expect(response.statusCode, reasonCode).toBe(status);
      expect(response.json(), reasonCode).toMatchObject({
        code,
        detailsSafe: { reasonCode, ...extra },
      });
      expect(repository.intents.size).toBe(0);
    }
    const malformed = await createApp(world());
    for (const tokenId of ["01", "x", "-1"]) {
      const response = await prepare(malformed.app, malformed.id, tokenId);
      expect(response.statusCode, tokenId).toBe(400);
    }
  });

  it("refuses under the chain guard hold with the Decision 0136 code", async () => {
    const state = world();
    const { app, id } = await createApp(state, endedInstance(), { hold: true });
    const response = await prepare(app, id);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      detailsSafe: { reasonCode: "LAUNCH2_USD1_PAUSED" },
    });
    expect(state.quoteReads).toBe(0);
  });

  it("records the reported hash once and confirms it from the indexed RefundClaimed", async () => {
    const state = world();
    const { app, id } = await createApp(state);
    const prepared = await prepare(app, id, "1");
    const intentId = prepared.json<{ launch2Intent: { intentId: string } }>()
      .launch2Intent.intentId;
    const transactionHash = `0x${"ab".repeat(32)}`;
    const first = await report(app, id, {
      intentId,
      transactionHash,
      walletId,
      tokenId: "1",
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      nftRefundReport: {
        intentId,
        tokenId: "1",
        transactionHash,
        status: "submitted",
        amountUsd1: null,
      },
    });
    state.indexed.push({
      tokenId: "1",
      ownerAddress: walletAddress,
      amountUsd1: (100n * wad).toString(10),
      remainingRecordedUsd1: (200n * wad).toString(10),
      transactionHash,
      blockNumber: "1001",
      refundedAt: iso(now + 5n),
    });
    const again = await report(app, id, { intentId, transactionHash });
    expect(again.json()).toMatchObject({
      nftRefundReport: {
        status: "confirmed",
        amountUsd1: "100",
        blockNumber: "1001",
        refundedAt: iso(now + 5n),
      },
    });
    expect(
      typeof again.json<{ contractVersion: unknown }>().contractVersion,
    ).toBe("string");
    const conflict = await report(app, id, {
      intentId,
      transactionHash: `0x${"cd".repeat(32)}`,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      code: "RESOURCE_CONFLICT",
      detailsSafe: { reasonCode: "LAUNCH2_REFUND_TRANSACTION_CONFLICT" },
    });
    for (const payload of [
      { intentId: randomUUID(), transactionHash },
      { intentId, transactionHash, tokenId: "2" },
    ]) {
      const missing = await report(app, id, payload);
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({
        detailsSafe: { reasonCode: "LAUNCH2_REFUND_INTENT_NOT_FOUND" },
      });
    }
  });
});
