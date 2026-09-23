import { describe, expect, it, vi } from "vitest";

import {
  CommunityVerificationError,
  describeReviewResult,
  parseCommunityVerificationRequest,
  runCommunityVerification,
} from "../scripts/community-verify.js";
import type { CreateCommunityReviewRuntime } from "../scripts/community-review-runtime.js";
import type { CommunityRecord } from "../src/features/community/community-repository.js";
import type {
  CommunityReviewResult,
  CommunityReviewService,
} from "../src/features/community/community-review-service.js";

const communityId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const databaseUrl = "postgres://loop_api:local@127.0.0.1:5433/loop_api_s3";

const verified: CommunityRecord = Object.freeze({
  communityId,
  name: "Frog Holders",
  slug: "frog-holders",
  description: null,
  logoRef: null,
  verificationStatus: "verified",
  boundAssetKey: null,
  memberCount: 3,
  createdAt: "2026-09-07T01:00:00.000Z",
  configVersion: "communityV1",
  application: Object.freeze({
    submittedAt: "2026-09-07T01:00:00.000Z",
    reviewedAt: "2026-09-07T02:00:00.000Z",
    rejectedReason: null,
  }),
});

const result: CommunityReviewResult = Object.freeze({
  community: verified,
  changed: true,
  notification: "recorded",
  push: Object.freeze({ status: "delivered", reasonCode: null }),
});

function outputWriter(): {
  readonly contents: () => string;
  readonly write: (value: string) => boolean;
} {
  let output = "";
  return {
    contents: () => output,
    write(value): boolean {
      output += value;
      return true;
    },
  };
}

export function reviewRuntimeFake(
  overrides: {
    readonly verify?: CommunityReviewService["verify"];
    readonly reject?: CommunityReviewService["reject"];
    readonly pushReasonCode?: string | null;
  } = {},
): {
  readonly create: CreateCommunityReviewRuntime;
  readonly verify: ReturnType<typeof vi.fn>;
  readonly reject: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
  readonly created: { databaseUrl: string }[];
} {
  const verify = vi.fn(overrides.verify ?? (() => Promise.resolve(result)));
  const reject = vi.fn(
    overrides.reject ?? (() => Promise.reject(new Error("not used"))),
  );
  const close = vi.fn(() => Promise.resolve());
  const created: { databaseUrl: string }[] = [];
  return {
    verify,
    reject,
    close,
    created,
    create: (input) => {
      created.push({ databaseUrl: input.databaseUrl });
      return {
        service: { verify, reject },
        pushReasonCode: overrides.pushReasonCode ?? null,
        close,
      };
    },
  };
}

describe("pnpm community:verify operator script", () => {
  it("refuses to run in production before touching the database", () => {
    expect(() =>
      parseCommunityVerificationRequest(
        ["node", "community-verify.ts", communityId],
        { NODE_ENV: "production", DATABASE_URL: databaseUrl },
      ),
    ).toThrow(CommunityVerificationError);
    try {
      parseCommunityVerificationRequest(
        ["node", "community-verify.ts", communityId],
        { NODE_ENV: "production", DATABASE_URL: databaseUrl },
      );
    } catch (error) {
      expect((error as CommunityVerificationError).code).toBe(
        "community_verify_forbidden_in_production",
      );
    }
  });

  it("rejects a missing, malformed, or extra argument", () => {
    for (const argv of [
      ["node", "community-verify.ts"],
      ["node", "community-verify.ts", "not-a-uuid"],
      ["node", "community-verify.ts", communityId, "Bad Reason"],
      ["node", "community-verify.ts", communityId, "ok", "extra"],
    ]) {
      expect(() =>
        parseCommunityVerificationRequest(argv, {
          NODE_ENV: "development",
          DATABASE_URL: databaseUrl,
        }),
      ).toThrow(CommunityVerificationError);
    }
  });

  it("requires DATABASE_URL", () => {
    expect(() =>
      parseCommunityVerificationRequest(
        ["node", "community-verify.ts", communityId],
        { NODE_ENV: "development" },
      ),
    ).toThrow(CommunityVerificationError);
  });

  it("verifies one community, reports the feed row and the push, and always closes the pool", async () => {
    const fake = reviewRuntimeFake();
    const stdout = outputWriter();
    const stderr = outputWriter();
    const exitCode = await runCommunityVerification({
      argv: ["node", "community-verify.ts", communityId],
      environment: { NODE_ENV: "development", DATABASE_URL: databaseUrl },
      stdout,
      stderr,
      createRuntime: fake.create,
    });

    expect(exitCode).toBe(0);
    expect(fake.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        communityId,
        reasonCode: "operator_manual_review",
      }),
    );
    expect(fake.created).toEqual([{ databaseUrl }]);
    expect(fake.close).toHaveBeenCalledOnce();
    expect(stdout.contents()).toContain(`Community ${communityId} is verified`);
    expect(stdout.contents()).toContain("notification recorded");
    expect(stdout.contents()).toContain("push delivered");
    expect(stderr.contents()).toBe("");
  });

  it("says the push is unavailable when no Firebase credential is composed", async () => {
    const fake = reviewRuntimeFake({
      verify: () =>
        Promise.resolve({
          ...result,
          push: { status: "skipped", reasonCode: null },
        }),
      pushReasonCode: "PUSH_RUNTIME_DEFERRED",
    });
    const stdout = outputWriter();
    const exitCode = await runCommunityVerification({
      argv: ["node", "community-verify.ts", communityId],
      environment: { NODE_ENV: "development", DATABASE_URL: databaseUrl },
      stdout,
      stderr: outputWriter(),
      createRuntime: fake.create,
    });

    expect(exitCode).toBe(0);
    expect(stdout.contents()).toContain(
      "push unavailable (PUSH_RUNTIME_DEFERRED)",
    );
  });

  it("describes an unchanged repair without claiming a notification", () => {
    const line = describeReviewResult(
      {
        community: verified,
        changed: false,
        notification: "skipped",
        push: { status: "skipped", reasonCode: null },
      },
      null,
    );
    expect(line).toContain("changed false");
    expect(line).toContain("notification skipped");
    expect(line).toContain("push skipped");
  });

  it("reports a production refusal on stderr with exit code 1", async () => {
    const fake = reviewRuntimeFake();
    const stdout = outputWriter();
    const stderr = outputWriter();
    const exitCode = await runCommunityVerification({
      argv: ["node", "community-verify.ts", communityId],
      environment: { NODE_ENV: "production", DATABASE_URL: databaseUrl },
      stdout,
      stderr,
      createRuntime: fake.create,
    });

    expect(exitCode).toBe(1);
    expect(stderr.contents()).toContain(
      "community_verify_forbidden_in_production",
    );
    expect(fake.verify).not.toHaveBeenCalled();
    expect(fake.created).toEqual([]);
    expect(stdout.contents()).toBe("");
  });

  it("reports a repository failure with exit code 1 and still closes the pool", async () => {
    const fake = reviewRuntimeFake({
      verify: () => Promise.reject(new Error("boom")),
    });
    const stderr = outputWriter();
    const exitCode = await runCommunityVerification({
      argv: ["node", "community-verify.ts", communityId],
      environment: { NODE_ENV: "development", DATABASE_URL: databaseUrl },
      stdout: outputWriter(),
      stderr,
      createRuntime: fake.create,
    });

    expect(exitCode).toBe(1);
    expect(stderr.contents()).toContain("community_verify_failed");
    expect(fake.close).toHaveBeenCalledOnce();
  });
});
