import { describe, expect, it, vi } from "vitest";

import {
  CommunityRejectionError,
  parseCommunityRejectionRequest,
  runCommunityRejection,
} from "../scripts/community-reject.js";
import type { CreateCommunityReviewRuntime } from "../scripts/community-review-runtime.js";
import {
  CommunityDataStaleError,
  type CommunityRecord,
} from "../src/features/community/community-repository.js";
import type {
  CommunityReviewResult,
  CommunityReviewService,
} from "../src/features/community/community-review-service.js";

const communityId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const databaseUrl = "postgres://loop_api:local@127.0.0.1:5433/loop_api_s3";
const development = { NODE_ENV: "development", DATABASE_URL: databaseUrl };
const reason = "Name collides with a listed token; pick another";

const rejected: CommunityRecord = Object.freeze({
  communityId,
  name: "Frog Holders",
  slug: "frog-holders",
  description: null,
  logoRef: null,
  verificationStatus: "rejected",
  boundAssetKey: null,
  memberCount: 1,
  createdAt: "2026-09-07T01:00:00.000Z",
  configVersion: "communityV1",
  application: Object.freeze({
    submittedAt: "2026-09-07T01:00:00.000Z",
    reviewedAt: "2026-09-07T02:00:00.000Z",
    rejectedReason: reason,
  }),
});

const result: CommunityReviewResult = Object.freeze({
  community: rejected,
  changed: true,
  notification: "recorded",
  push: Object.freeze({
    status: "suppressed",
    reasonCode: "PUSH_NO_REGISTERED_DEVICE",
  }),
});

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

function runtimeFake(reject: CommunityReviewService["reject"]) {
  const rejectMock = vi.fn(reject);
  const close = vi.fn(() => Promise.resolve());
  const create: CreateCommunityReviewRuntime = () => ({
    service: {
      verify: () => Promise.reject(new Error("not used")),
      reject: rejectMock,
    },
    pushReasonCode: null,
    close,
  });
  return { create, reject: rejectMock, close };
}

describe("pnpm community:reject operator script (Decision 0072)", () => {
  it("refuses production before examining anything else", () => {
    expect(() =>
      parseCommunityRejectionRequest(
        ["node", "s", communityId, "--reason", reason],
        { NODE_ENV: "production", DATABASE_URL: databaseUrl },
      ),
    ).toThrow(
      expect.objectContaining({
        code: "community_reject_forbidden_in_production",
      }),
    );
  });

  it("parses the id, the reason flag in either spelling, and an optional reason code", () => {
    expect(
      parseCommunityRejectionRequest(
        ["node", "s", communityId, "--reason", `  ${reason}  `],
        development,
      ),
    ).toEqual({
      communityId,
      reason,
      reasonCode: "operator_manual_review",
      databaseUrl,
    });
    expect(
      parseCommunityRejectionRequest(
        ["node", "s", `--reason=${reason}`, communityId, "policy_name_clash"],
        development,
      ),
    ).toMatchObject({ reasonCode: "policy_name_clash", reason });
  });

  it("rejects a missing reason, an empty or overlong reason, control characters, and unknown flags", () => {
    for (const argv of [
      ["node", "s", communityId],
      ["node", "s", communityId, "--reason"],
      ["node", "s", communityId, "--reason", "   "],
      ["node", "s", communityId, "--reason", "x".repeat(281)],
      ["node", "s", communityId, "--reason", "bad\u0000reason"],
      ["node", "s", communityId, "--reason", reason, "--reason", reason],
      ["node", "s", communityId, "--reason", reason, "--force"],
      ["node", "s", "not-a-uuid", "--reason", reason],
      ["node", "s", communityId, "--reason", reason, "Bad Code"],
      ["node", "s", communityId, "--reason", reason, "ok", "extra"],
    ]) {
      expect(() => parseCommunityRejectionRequest(argv, development)).toThrow(
        expect.objectContaining({ code: "community_reject_arguments_invalid" }),
      );
    }
    expect(
      parseCommunityRejectionRequest(
        ["node", "s", communityId, "--reason", "x".repeat(280)],
        development,
      ).reason,
    ).toHaveLength(280);
  });

  it("requires DATABASE_URL", () => {
    expect(() =>
      parseCommunityRejectionRequest(
        ["node", "s", communityId, "--reason", reason],
        { NODE_ENV: "development" },
      ),
    ).toThrow(
      expect.objectContaining({
        code: "community_reject_database_unconfigured",
      }),
    );
  });

  it("rejects one community with the trimmed reason and reports feed and push", async () => {
    const fake = runtimeFake(() => Promise.resolve(result));
    const stdout = outputWriter();
    const stderr = outputWriter();
    const exitCode = await runCommunityRejection({
      argv: ["node", "s", communityId, "--reason", reason],
      environment: development,
      stdout,
      stderr,
      createRuntime: fake.create,
    });

    expect(exitCode).toBe(0);
    expect(fake.reject).toHaveBeenCalledWith(
      expect.objectContaining({
        communityId,
        reason,
        reasonCode: "operator_manual_review",
      }),
    );
    expect(fake.close).toHaveBeenCalledOnce();
    expect(stdout.contents()).toContain(`Community ${communityId} is rejected`);
    expect(stdout.contents()).toContain("notification recorded");
    expect(stdout.contents()).toContain(
      "push suppressed (PUSH_NO_REGISTERED_DEVICE)",
    );
    expect(stderr.contents()).toBe("");
  });

  it("reports a verified community as an invalid state and exits 1", async () => {
    const fake = runtimeFake(() =>
      Promise.reject(new CommunityDataStaleError()),
    );
    const stderr = outputWriter();
    const exitCode = await runCommunityRejection({
      argv: ["node", "s", communityId, "--reason", reason],
      environment: development,
      stdout: outputWriter(),
      stderr,
      createRuntime: fake.create,
    });

    expect(exitCode).toBe(1);
    expect(stderr.contents()).toContain("community_reject_state_invalid");
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("reports an argument refusal on stderr without opening a runtime", async () => {
    const fake = runtimeFake(() => Promise.resolve(result));
    const stderr = outputWriter();
    const exitCode = await runCommunityRejection({
      argv: ["node", "s", communityId],
      environment: development,
      stdout: outputWriter(),
      stderr,
      createRuntime: fake.create,
    });

    expect(exitCode).toBe(1);
    expect(stderr.contents()).toContain("community_reject_arguments_invalid");
    expect(fake.reject).not.toHaveBeenCalled();
    expect(fake.close).not.toHaveBeenCalled();
    expect(new CommunityRejectionError("community_reject_failed").code).toBe(
      "community_reject_failed",
    );
  });
});
