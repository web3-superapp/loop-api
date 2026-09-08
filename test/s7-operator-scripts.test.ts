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
      reviewer: "ops.alice",
    });
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
