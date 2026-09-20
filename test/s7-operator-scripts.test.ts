import { describe, expect, it, vi } from "vitest";

import {
  LaunchMilestoneError,
  parseLaunchMilestoneRequest,
  runLaunchMilestone,
} from "../scripts/launch-milestone.js";
import {
  LaunchReviewError,
  parseLaunchReviewRequest,
  runLaunchReview,
} from "../scripts/launch-review.js";
import {
  MiningApproveFormulaError,
  parseMiningApproveFormulaRequest,
  runMiningApproveFormula,
} from "../scripts/mining-approve-formula.js";
import {
  MiningCommunityWeightError,
  parseMiningCommunityWeightRequest,
  runMiningCommunityWeight,
} from "../scripts/mining-community-weight.js";
import {
  MiningDevBaselineError,
  parseMiningDevBaselineRequest,
  runMiningDevBaseline,
} from "../scripts/mining-dev-baseline.js";
import {
  parseMiningInvalidateSnapshotsRequest,
  runMiningInvalidateSnapshots,
} from "../scripts/mining-invalidate-snapshots.js";
import {
  MiningSnapshotScriptError,
  parseMiningSnapshotRequest,
  runMiningSnapshot,
} from "../scripts/mining-snapshot.js";
import { miningDevBaselineConfigVersion } from "../src/features/mining/mining-dev-baseline.js";
import {
  MiningCommunityAssetNotBoundError,
  MiningFormulaExistsError,
  MiningSnapshotNotFoundError,
  MiningWeightOutOfRangeError,
} from "../src/features/mining/mining-repository.js";
import { venueEvidenceDigest } from "../src/features/launch/launch-contract.js";

const projectId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const databaseUrl = "postgres://loop_api:local@127.0.0.1:5433/loop_api_s7";
const development = { NODE_ENV: "development", DATABASE_URL: databaseUrl };
const production = { NODE_ENV: "production", DATABASE_URL: databaseUrl };

function outputWriter() {
  let output = "";
  return {
    contents: () => output,
    write(value: string): boolean {
      output += value;
      return true;
    },
  };
}

describe("pnpm launch:review", () => {
  it("refuses production before opening a connection", () => {
    expect(() =>
      parseLaunchReviewRequest(["node", "s", projectId, "approve"], production),
    ).toThrow(LaunchReviewError);
  });

  it("rejects malformed arguments and requires DATABASE_URL", () => {
    for (const argv of [
      ["node", "s"],
      ["node", "s", projectId],
      ["node", "s", "not-a-uuid", "approve"],
      ["node", "s", projectId, "publish"],
      ["node", "s", projectId, "approve", "Bad Reason"],
    ]) {
      expect(() => parseLaunchReviewRequest(argv, development)).toThrow(
        LaunchReviewError,
      );
    }
    expect(() =>
      parseLaunchReviewRequest(["node", "s", projectId, "approve"], {
        NODE_ENV: "development",
      }),
    ).toThrow(LaunchReviewError);
  });

  it("hands the LAUNCH_CHAIN_ID slot to the repository and refuses an unsupported chain (Decision 0038)", async () => {
    expect(
      parseLaunchReviewRequest(["node", "s", projectId, "approve"], development)
        .launchChainId,
    ).toBe("eip155:56");
    expect(
      parseLaunchReviewRequest(["node", "s", projectId, "approve"], {
        ...development,
        LAUNCH_CHAIN_ID: "97",
      }).launchChainId,
    ).toBe("eip155:97");
    expect(() =>
      parseLaunchReviewRequest(["node", "s", projectId, "approve"], {
        ...development,
        LAUNCH_CHAIN_ID: "1",
      }),
    ).toThrow(
      expect.objectContaining({ code: "launch_review_launch_chain_invalid" }),
    );

    const createRepository = vi.fn(() => ({
      repository: {
        reviewProject: () =>
          Promise.resolve({
            project: { projectId, reviewStatus: "approved" as const },
            launch: {
              launchId: "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f",
              scheduleStatus: "unscheduled" as const,
              chainId: "eip155:97" as const,
            },
          }),
      } as never,
      close: () => Promise.resolve(),
    }));
    const stdout = outputWriter();
    const exitCode = await runLaunchReview({
      argv: ["node", "s", projectId, "approve"],
      environment: { ...development, LAUNCH_CHAIN_ID: "97" },
      stdout,
      stderr: outputWriter(),
      createRepository,
    });
    expect(exitCode).toBe(0);
    expect(createRepository).toHaveBeenCalledWith(databaseUrl, "eip155:97");
    expect(stdout.contents()).toContain("unscheduled, eip155:97)");
  });

  it("approves through the repository, prints the launch, and closes the pool", async () => {
    const reviewProject = vi.fn(() =>
      Promise.resolve({
        project: { projectId, reviewStatus: "approved" as const },
        launch: {
          launchId: "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f",
          scheduleStatus: "unscheduled" as const,
        },
      }),
    );
    const close = vi.fn(() => Promise.resolve());
    const stdout = outputWriter();
    const stderr = outputWriter();
    const exitCode = await runLaunchReview({
      argv: ["node", "s", projectId, "approve"],
      environment: development,
      stdout,
      stderr,
      createRepository: () => ({
        repository: { reviewProject: reviewProject as never },
        close,
      }),
    });
    expect(exitCode).toBe(0);
    expect(reviewProject).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId,
        decision: "approve",
        reasonCode: "operator_manual_review",
      }),
    );
    expect(close).toHaveBeenCalledOnce();
    expect(stdout.contents()).toContain("is approved (launch 9c1f0f2e");
    expect(stderr.contents()).toBe("");
  });

  it("reports a production refusal on stderr with exit code 1", async () => {
    const stderr = outputWriter();
    const exitCode = await runLaunchReview({
      argv: ["node", "s", projectId, "approve"],
      environment: production,
      stdout: outputWriter(),
      stderr,
      createRepository: () => {
        throw new Error("must not be called");
      },
    });
    expect(exitCode).toBe(1);
    expect(stderr.contents()).toContain(
      "launch_review_forbidden_in_production",
    );
  });
});

describe("pnpm launch:milestone", () => {
  it("digests the evidence and requires evidence and reviewer together", () => {
    const request = parseLaunchMilestoneRequest(
      [
        "node",
        "s",
        projectId,
        "lbank",
        "spot",
        "LISTED",
        "--evidence",
        "https://lbank.example/a",
        "--reviewer",
        "ops.alice",
      ],
      development,
    );
    expect(request).toMatchObject({
      venue: "lbank",
      marketType: "spot",
      state: "LISTED",
      evidenceDigest: venueEvidenceDigest("https://lbank.example/a"),
      evidenceObservedAt: null,
      reviewer: "ops.alice",
    });
    expect(
      parseLaunchMilestoneRequest(
        [
          "node",
          "s",
          projectId,
          "lbank",
          "spot",
          "LISTED",
          "--evidence",
          "https://lbank.example/a",
          "--reviewer",
          "ops.alice",
          "--observed-at",
          "2026-09-01T08:00:00+08:00",
        ],
        development,
      ).evidenceObservedAt,
    ).toBe("2026-09-01T00:00:00.000Z");
    for (const argv of [
      [
        "node",
        "s",
        projectId,
        "lbank",
        "spot",
        "APPLIED",
        "--observed-at",
        "2026-09-01T08:00:00Z",
      ],
      [
        "node",
        "s",
        projectId,
        "lbank",
        "spot",
        "LISTED",
        "--evidence",
        "x",
        "--reviewer",
        "ops",
        "--observed-at",
        "yesterday",
      ],
    ]) {
      expect(() => parseLaunchMilestoneRequest(argv, development)).toThrow(
        LaunchMilestoneError,
      );
    }
    expect(() =>
      parseLaunchMilestoneRequest(
        [
          "node",
          "s",
          projectId,
          "lbank",
          "spot",
          "LISTED",
          "--evidence",
          "https://lbank.example/a",
        ],
        development,
      ),
    ).toThrow(LaunchMilestoneError);
    expect(() =>
      parseLaunchMilestoneRequest(
        ["node", "s", projectId, "okx", "spot", "APPLIED"],
        development,
      ),
    ).toThrow(LaunchMilestoneError);
    expect(() =>
      parseLaunchMilestoneRequest(
        ["node", "s", projectId, "lbank", "spot", "APPLIED"],
        production,
      ),
    ).toThrow(LaunchMilestoneError);
  });

  it("records through the repository and closes the pool", async () => {
    const recordMilestone = vi.fn(() =>
      Promise.resolve({
        venueMilestoneId: "7d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5f6",
        venue: "binance" as const,
        marketType: "alpha" as const,
        state: "APPLIED" as const,
        evidenceDigest: null,
        evidenceObservedAt: null,
      }),
    );
    const close = vi.fn(() => Promise.resolve());
    const stdout = outputWriter();
    const exitCode = await runLaunchMilestone({
      argv: ["node", "s", projectId, "binance", "alpha", "APPLIED"],
      environment: development,
      stdout,
      stderr: outputWriter(),
      createRepository: () => ({
        repository: { recordMilestone: recordMilestone as never },
        close,
      }),
    });
    expect(exitCode).toBe(0);
    expect(close).toHaveBeenCalledOnce();
    expect(stdout.contents()).toContain("(binance/alpha) is APPLIED");
  });
});

describe("pnpm mining:approve-formula", () => {
  it("refuses production, requires --confirm, and validates the version", () => {
    expect(() =>
      parseMiningApproveFormulaRequest(
        ["node", "s", "miningFormulaV1-draft", "--confirm"],
        production,
      ),
    ).toThrow(MiningApproveFormulaError);
    try {
      parseMiningApproveFormulaRequest(
        ["node", "s", "miningFormulaV1-draft"],
        development,
      );
    } catch (error) {
      expect((error as MiningApproveFormulaError).code).toBe(
        "mining_approve_confirmation_required",
      );
    }
    expect(() =>
      parseMiningApproveFormulaRequest(
        ["node", "s", "bad version!", "--confirm"],
        development,
      ),
    ).toThrow(MiningApproveFormulaError);
    expect(
      parseMiningApproveFormulaRequest(
        ["node", "s", "miningFormulaV1-draft", "--confirm"],
        development,
      ),
    ).toEqual({ configVersion: "miningFormulaV1-draft", databaseUrl });
  });

  it("reports the production refusal without touching the repository", async () => {
    const stderr = outputWriter();
    const exitCode = await runMiningApproveFormula({
      argv: ["node", "s", "miningFormulaV1-draft", "--confirm"],
      environment: production,
      stdout: outputWriter(),
      stderr,
      createRepository: () => {
        throw new Error("must not be called");
      },
    });
    expect(exitCode).toBe(1);
    expect(stderr.contents()).toContain(
      "mining_approve_forbidden_in_production",
    );
  });

  it("approves through the repository outside production", async () => {
    const approveFormula = vi.fn(() =>
      Promise.resolve({
        configVersion: "miningFormulaV1-draft",
        status: "approved" as const,
        effectiveAt: "2026-09-08T00:00:00.000Z",
      }),
    );
    const close = vi.fn(() => Promise.resolve());
    const stdout = outputWriter();
    const exitCode = await runMiningApproveFormula({
      argv: ["node", "s", "miningFormulaV1-draft", "--confirm"],
      environment: development,
      stdout,
      stderr: outputWriter(),
      createRepository: () => ({
        repository: { approveFormula: approveFormula as never },
        close,
      }),
    });
    expect(exitCode).toBe(0);
    expect(close).toHaveBeenCalledOnce();
    expect(stdout.contents()).toContain("miningFormulaV1-draft is approved");
  });
});

describe("pnpm mining:dev-baseline (Decision 0043)", () => {
  it("refuses production, requires --confirm, and rejects extra arguments", () => {
    expect(() =>
      parseMiningDevBaselineRequest(["node", "s", "--confirm"], production),
    ).toThrow(
      expect.objectContaining({
        code: "mining_dev_baseline_forbidden_in_production",
      }),
    );
    expect(() =>
      parseMiningDevBaselineRequest(["node", "s"], development),
    ).toThrow(
      expect.objectContaining({
        code: "mining_dev_baseline_confirmation_required",
      }),
    );
    expect(() =>
      parseMiningDevBaselineRequest(
        ["node", "s", "--confirm", "extra"],
        development,
      ),
    ).toThrow(MiningDevBaselineError);
    expect(() =>
      parseMiningDevBaselineRequest(["node", "s", "--confirm"], {
        NODE_ENV: "development",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "mining_dev_baseline_database_unconfigured",
      }),
    );
  });

  it("creates the baseline from the registry with every asset at weight 1 and never approves it", async () => {
    const createFormulaVersion = vi.fn(
      (input: {
        configVersion: string;
        formula: {
          assetWeights: Record<string, string>;
          dailyOutput?: { budget: string; status: string };
        };
        weightRange: { community: { range?: { min: string; max: string } } };
      }) =>
        Promise.resolve({
          ...input,
          priceGuardRules: [],
          status: "pending_approval" as const,
          effectiveAt: null,
          approvedAt: null,
          createdAt: "2026-09-15T00:00:00.000Z",
        }),
    );
    const close = vi.fn(() => Promise.resolve());
    const stdout = outputWriter();
    const exitCode = await runMiningDevBaseline({
      argv: ["node", "s", "--confirm"],
      environment: development,
      stdout,
      stderr: outputWriter(),
      createRepositories: () => ({
        mining: { createFormulaVersion: createFormulaVersion as never },
        registry: {
          listReadableAssets: () =>
            Promise.resolve([
              { assetId: "eip155:56:native" },
              {
                assetId: "eip155:56:0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82",
              },
            ] as never),
        },
        close,
      }),
    });
    expect(exitCode).toBe(0);
    expect(createFormulaVersion).toHaveBeenCalledOnce();
    expect(createFormulaVersion.mock.calls[0]?.[0]).toMatchObject({
      configVersion: miningDevBaselineConfigVersion,
      formula: {
        scope: "development_baseline",
        assetWeights: {
          "eip155:56:0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82": "1",
          "eip155:56:native": "1",
        },
        dailyOutput: { status: "development_placeholder", budget: "1000000" },
      },
    });
    expect(close).toHaveBeenCalledOnce();
    expect(stdout.contents()).toContain("pending_approval");
    expect(stdout.contents()).toContain("pnpm mining:approve-formula");
  });

  it("refuses an empty registry and an existing version", async () => {
    const stderr = outputWriter();
    expect(
      await runMiningDevBaseline({
        argv: ["node", "s", "--confirm"],
        environment: development,
        stdout: outputWriter(),
        stderr,
        createRepositories: () => ({
          mining: { createFormulaVersion: vi.fn() as never },
          registry: { listReadableAssets: () => Promise.resolve([]) },
          close: () => Promise.resolve(),
        }),
      }),
    ).toBe(1);
    expect(stderr.contents()).toContain(
      "mining_dev_baseline_no_registered_assets",
    );
    const existing = outputWriter();
    expect(
      await runMiningDevBaseline({
        argv: ["node", "s", "--confirm"],
        environment: development,
        stdout: outputWriter(),
        stderr: existing,
        createRepositories: () => ({
          mining: {
            createFormulaVersion: () =>
              Promise.reject(new MiningFormulaExistsError()),
          },
          registry: {
            listReadableAssets: () =>
              Promise.resolve([{ assetId: "eip155:56:native" }] as never),
          },
          close: () => Promise.resolve(),
        }),
      }),
    ).toBe(1);
    expect(existing.contents()).toContain("mining_dev_baseline_exists");
  });
});

describe("pnpm mining:community-weight (Decision 0043)", () => {
  const communityId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

  it("refuses production before opening a connection and validates its arguments", () => {
    expect(() =>
      parseMiningCommunityWeightRequest(
        ["node", "s", communityId, "1", "--confirm"],
        production,
      ),
    ).toThrow(
      expect.objectContaining({
        code: "mining_weight_forbidden_in_production",
      }),
    );
    for (const argv of [
      ["node", "s", communityId, "--confirm"],
      ["node", "s", "not-a-uuid", "1", "--confirm"],
      ["node", "s", communityId, "1.0e2", "--confirm"],
      ["node", "s", communityId, "-1", "--confirm"],
      ["node", "s", communityId, "1", "--confirm", "--config-version"],
      ["node", "s", communityId, "1", "--confirm", "--unknown"],
    ]) {
      expect(() =>
        parseMiningCommunityWeightRequest(argv, development),
      ).toThrow(MiningCommunityWeightError);
    }
    expect(() =>
      parseMiningCommunityWeightRequest(
        ["node", "s", communityId, "1"],
        development,
      ),
    ).toThrow(
      expect.objectContaining({ code: "mining_weight_confirmation_required" }),
    );
    expect(
      parseMiningCommunityWeightRequest(
        [
          "node",
          "s",
          communityId,
          "0.5",
          "--confirm",
          "--config-version",
          "v-x",
        ],
        development,
      ),
    ).toEqual({
      communityId,
      weight: "0.5",
      configVersion: "v-x",
      databaseUrl,
    });
  });

  it("writes the weight under the approved version by default and maps repository refusals", async () => {
    const setCommunityWeight = vi.fn(() =>
      Promise.resolve({
        communityId,
        communityName: "Frog Holders",
        boundAssetId: "eip155:56:0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82",
        status: "approved" as const,
        weight: "1.5",
        configVersion: miningDevBaselineConfigVersion,
        reviewedAt: "2026-09-15T00:00:00.000Z",
      }),
    );
    const stdout = outputWriter();
    expect(
      await runMiningCommunityWeight({
        argv: ["node", "s", communityId, "1.5", "--confirm"],
        environment: development,
        stdout,
        stderr: outputWriter(),
        createRepository: () => ({
          repository: {
            setCommunityWeight,
            getApprovedFormula: () =>
              Promise.resolve({
                configVersion: miningDevBaselineConfigVersion,
              } as never),
          },
          close: () => Promise.resolve(),
        }),
      }),
    ).toBe(0);
    expect(setCommunityWeight).toHaveBeenCalledWith(
      expect.objectContaining({
        communityId,
        weight: "1.5",
        configVersion: miningDevBaselineConfigVersion,
      }),
    );
    expect(stdout.contents()).toContain("approved under");
    for (const [error, code] of [
      [new MiningWeightOutOfRangeError(), "mining_weight_out_of_range"],
      [
        new MiningCommunityAssetNotBoundError(),
        "mining_weight_asset_not_bound",
      ],
    ] as const) {
      const stderr = outputWriter();
      expect(
        await runMiningCommunityWeight({
          argv: ["node", "s", communityId, "9", "--confirm"],
          environment: development,
          stdout: outputWriter(),
          stderr,
          createRepository: () => ({
            repository: {
              setCommunityWeight: () => Promise.reject(error),
              getApprovedFormula: () =>
                Promise.resolve({ configVersion: "v" } as never),
            },
            close: () => Promise.resolve(),
          }),
        }),
      ).toBe(1);
      expect(stderr.contents()).toContain(code);
    }
    const noVersion = outputWriter();
    expect(
      await runMiningCommunityWeight({
        argv: ["node", "s", communityId, "1", "--confirm"],
        environment: development,
        stdout: outputWriter(),
        stderr: noVersion,
        createRepository: () => ({
          repository: {
            setCommunityWeight,
            getApprovedFormula: () => Promise.resolve(null),
          },
          close: () => Promise.resolve(),
        }),
      }),
    ).toBe(1);
    expect(noVersion.contents()).toContain("mining_weight_no_approved_version");
  });
});

describe("pnpm mining:snapshot (Decision 0043)", () => {
  it("refuses production and requires --confirm", () => {
    expect(() =>
      parseMiningSnapshotRequest(["node", "s", "--confirm"], production),
    ).toThrow(
      expect.objectContaining({
        code: "mining_snapshot_forbidden_in_production",
      }),
    );
    expect(() =>
      parseMiningSnapshotRequest(["node", "s"], development),
    ).toThrow(MiningSnapshotScriptError);
  });

  it("runs the lane once and reports idle or snapshotted with skipped assets", async () => {
    const idle = outputWriter();
    expect(
      await runMiningSnapshot({
        argv: ["node", "s", "--confirm"],
        environment: development,
        stdout: idle,
        stderr: outputWriter(),
        createDependencies: () => ({
          dependencies: {
            repository: {
              getApprovedFormula: () => Promise.resolve(null),
            } as never,
            registry: { listAssets: () => Promise.resolve([]) },
            prices: {
              readAssetPrice: vi.fn() as never,
              readPair: vi.fn() as never,
            },
          },
          close: () => Promise.resolve(),
        }),
      }),
    ).toBe(1);
    expect(idle.contents()).toContain("idle (MINING_FORMULA_BASELINE_PENDING)");
  });

  it("reports an incomplete attempt with its unread holdings and exits 1 (Decision 0057)", async () => {
    const usdt = "eip155:56:0x55d398326f99059ff775485246999027b3197955";
    const output = outputWriter();
    const repository = {
      getApprovedFormula: () =>
        Promise.resolve({
          configVersion: "miningFormulaTestOnly",
          formula: {
            kind: "holding_times_reference_price_times_weight",
            expressionKey: "k",
            dailyOutputKey: "k",
            assetWeights: { [usdt]: "1" },
            referralBoost: { status: "pending_approval" },
          },
          weightRange: {
            loop: { status: "approved", descriptionKey: "k" },
            community: { status: "pending_approval", descriptionKey: "k" },
            reviewFactorKeys: [],
          },
          priceGuardRules: [],
          status: "approved",
          effectiveAt: "2026-09-08T00:00:00.000Z",
          approvedAt: "2026-09-08T00:00:00.000Z",
          createdAt: "2026-09-08T00:00:00.000Z",
        }),
      listBalanceInputs: () =>
        Promise.resolve([
          {
            ownerUserId: "3bb58597-2e31-45e7-b5f0-957803a824ed",
            walletId: "d60627ca-fe23-4608-93ee-5ae0e77716ef",
            assetId: usdt,
            decimals: 18,
            rawValue: "2990000000000000000",
            blockNumber: "123000110",
            blockHash: `0x${"a".repeat(64)}`,
          },
        ]),
      listCommunityWeightInputs: () => Promise.resolve([]),
      writeIncompleteSnapshot: vi.fn((input: { snapshotId: string }) =>
        Promise.resolve({
          snapshotId: input.snapshotId,
          status: "incomplete",
          formulaVersion: "miningFormulaTestOnly",
          blockNumber: "123000110",
          computedAt: "2026-09-20T13:51:26.116Z",
          unreadInputs: [
            { assetId: usdt, reasonCode: "MINING_PRICE_PAIR_NOT_FOUND" },
          ],
          invalidatedAt: null,
          invalidationReason: null,
        }),
      ),
      writeSnapshot: vi.fn(),
    };
    expect(
      await runMiningSnapshot({
        argv: ["node", "s", "--confirm"],
        environment: development,
        stdout: output,
        stderr: outputWriter(),
        createDependencies: () => ({
          dependencies: {
            repository: repository as never,
            registry: {
              listAssets: () =>
                Promise.resolve([
                  {
                    assetId: usdt,
                    chainId: "eip155:56",
                    address: "0x55d398326f99059ff775485246999027b3197955",
                    symbol: "USDT",
                    name: "Tether USD",
                    decimals: 18,
                    status: "pending",
                    sourceKind: "chain_call",
                    sourceBlockNumber: "1",
                    sourceVerifiedAt: null,
                    updatedAt: "2026-09-08T00:00:00.000Z",
                  },
                ]),
            },
            prices: {
              readAssetPrice: () =>
                Promise.resolve({
                  fact: {
                    value: {
                      tokenAddress:
                        "0x55d398326f99059ff775485246999027b3197955",
                      pairs: [],
                    },
                    source: "dexscreener",
                    fetchedAt: "2026-09-20T13:51:04.473Z",
                    ttlSeconds: 30,
                    quality: "fresh",
                    reasonCode: null,
                    rawDigest: null,
                  },
                  pair: null,
                  proxyAsset: null,
                }) as never,
              readPair: vi.fn() as never,
            },
          },
          close: () => Promise.resolve(),
        }),
      }),
    ).toBe(1);
    expect(output.contents()).toContain(
      "incomplete (MINING_SNAPSHOT_INCOMPLETE)",
    );
    expect(output.contents()).toContain("nothing published");
    expect(output.contents()).toContain(
      `${usdt} (MINING_PRICE_PAIR_NOT_FOUND)`,
    );
    expect(repository.writeIncompleteSnapshot).toHaveBeenCalledTimes(1);
    expect(repository.writeSnapshot).not.toHaveBeenCalled();
  });
});

describe("pnpm mining:invalidate-snapshots (Decision 0057)", () => {
  const anchor = "43880746-17f3-43c3-8213-9e8033319093";
  const other = "537e93ea-1c9f-43f8-b29a-c6eb4a8e7dee";

  it("refuses production, requires --confirm, and validates the selector and reason", () => {
    expect(() =>
      parseMiningInvalidateSnapshotsRequest(
        ["node", "s", "--after", anchor, "--confirm"],
        production,
      ),
    ).toThrow(
      expect.objectContaining({
        code: "mining_invalidate_forbidden_in_production",
      }),
    );
    expect(() =>
      parseMiningInvalidateSnapshotsRequest(
        ["node", "s", "--after", anchor],
        development,
      ),
    ).toThrow(
      expect.objectContaining({
        code: "mining_invalidate_confirmation_required",
      }),
    );
    for (const argv of [
      ["node", "s", "--confirm"],
      ["node", "s", "--after", "not-a-uuid", "--confirm"],
      ["node", "s", "--after", anchor, other, "--confirm"],
      ["node", "s", "--after", anchor, "--after", other, "--confirm"],
      ["node", "s", other, "--reason", "lower_case", "--confirm"],
      ["node", "s", other, "--bogus", "--confirm"],
    ]) {
      expect(() =>
        parseMiningInvalidateSnapshotsRequest(argv, development),
      ).toThrow(
        expect.objectContaining({
          code: "mining_invalidate_arguments_invalid",
        }),
      );
    }
    expect(() =>
      parseMiningInvalidateSnapshotsRequest(["node", "s", other, "--confirm"], {
        NODE_ENV: "development",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "mining_invalidate_database_unconfigured",
      }),
    );
    expect(
      parseMiningInvalidateSnapshotsRequest(
        ["node", "s", "--after", anchor, "--confirm"],
        development,
      ),
    ).toEqual({
      selector: { kind: "after", snapshotId: anchor },
      reason: "MINING_SNAPSHOT_PUBLISHED_INCOMPLETE",
      databaseUrl,
    });
    expect(
      parseMiningInvalidateSnapshotsRequest(
        [
          "node",
          "s",
          other,
          anchor,
          "--reason",
          "OPERATOR_REVIEW",
          "--confirm",
        ],
        development,
      ),
    ).toEqual({
      selector: { kind: "ids", snapshotIds: [other, anchor] },
      reason: "OPERATOR_REVIEW",
      databaseUrl,
    });
  });

  it("invalidates through the repository, prints the withdrawn IDs, maps a missing anchor, and closes the pool", async () => {
    const invalidateSnapshots = vi.fn(() =>
      Promise.resolve({ snapshotIds: [other] }),
    );
    const close = vi.fn(() => Promise.resolve());
    const stdout = outputWriter();
    expect(
      await runMiningInvalidateSnapshots({
        argv: ["node", "s", "--after", anchor, "--confirm"],
        environment: development,
        stdout,
        stderr: outputWriter(),
        createRepository: () => ({
          repository: { invalidateSnapshots },
          close,
        }),
      }),
    ).toBe(0);
    expect(invalidateSnapshots).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: { kind: "after", snapshotId: anchor },
        reason: "MINING_SNAPSHOT_PUBLISHED_INCOMPLETE",
      }),
    );
    expect(stdout.contents()).toContain(
      `Invalidated 1 mining snapshot(s) (MINING_SNAPSHOT_PUBLISHED_INCOMPLETE): ${other}`,
    );
    expect(close).toHaveBeenCalledTimes(1);

    const stderr = outputWriter();
    expect(
      await runMiningInvalidateSnapshots({
        argv: ["node", "s", other, "--confirm"],
        environment: development,
        stdout: outputWriter(),
        stderr,
        createRepository: () => ({
          repository: {
            invalidateSnapshots: () =>
              Promise.reject(new MiningSnapshotNotFoundError()),
          },
          close,
        }),
      }),
    ).toBe(1);
    expect(stderr.contents()).toContain("mining_invalidate_snapshot_not_found");
    expect(close).toHaveBeenCalledTimes(2);

    const refused = outputWriter();
    expect(
      await runMiningInvalidateSnapshots({
        argv: ["node", "s", "--after", anchor, "--confirm"],
        environment: production,
        stdout: outputWriter(),
        stderr: refused,
        createRepository: () => {
          throw new Error("must not open a connection");
        },
      }),
    ).toBe(1);
    expect(refused.contents()).toContain(
      "mining_invalidate_forbidden_in_production",
    );
  });
});
