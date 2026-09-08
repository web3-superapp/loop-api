import { describe, expect, it, vi } from "vitest";

import {
  CommunityVerificationError,
  parseCommunityVerificationRequest,
  runCommunityVerification,
  type CreateCommunityVerifyRepository,
} from "../scripts/community-verify.js";
import {
  createUnavailableCommunityRepository,
  type CommunityRecord,
} from "../src/features/community/community-repository.js";

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

function repositoryFake(): {
  readonly create: CreateCommunityVerifyRepository;
  readonly verifyCommunity: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
} {
  const verifyCommunity = vi.fn(() => Promise.resolve(verified));
  const close = vi.fn(() => Promise.resolve());
  return {
    verifyCommunity,
    close,
    create: () => ({
      repository: {
        ...createUnavailableCommunityRepository(),
        verifyCommunity,
      },
      close,
    }),
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

  it("verifies one community and always closes the pool", async () => {
    const fake = repositoryFake();
    const stdout = outputWriter();
    const stderr = outputWriter();
    const exitCode = await runCommunityVerification({
      argv: ["node", "community-verify.ts", communityId],
      environment: { NODE_ENV: "development", DATABASE_URL: databaseUrl },
      stdout,
      stderr,
      createRepository: fake.create,
    });

    expect(exitCode).toBe(0);
    expect(fake.verifyCommunity).toHaveBeenCalledWith(
      expect.objectContaining({
        communityId,
        reasonCode: "operator_manual_review",
      }),
    );
    expect(fake.close).toHaveBeenCalledOnce();
    expect(stdout.contents()).toContain(`Community ${communityId} is verified`);
    expect(stderr.contents()).toBe("");
  });

  it("reports a production refusal on stderr with exit code 1", async () => {
    const fake = repositoryFake();
    const stdout = outputWriter();
    const stderr = outputWriter();
    const exitCode = await runCommunityVerification({
      argv: ["node", "community-verify.ts", communityId],
      environment: { NODE_ENV: "production", DATABASE_URL: databaseUrl },
      stdout,
      stderr,
      createRepository: fake.create,
    });

    expect(exitCode).toBe(1);
    expect(stderr.contents()).toContain(
      "community_verify_forbidden_in_production",
    );
    expect(fake.verifyCommunity).not.toHaveBeenCalled();
    expect(stdout.contents()).toBe("");
  });
});
