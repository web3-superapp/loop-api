import { describe, expect, it, vi } from "vitest";

import {
  CommunityProvisionChannelsError,
  parseCommunityProvisionChannelsRequest,
  runCommunityProvisionChannels,
  type CreateCommunityProvisionChannelsDependencies,
} from "../scripts/community-provision-channels.js";
import type { CommunityMissingChannelRecord } from "../src/database/community-repository.js";
import {
  createUnavailableCommunityRepository,
  type CommunityRecord,
  type CommunityRepository,
} from "../src/features/community/community-repository.js";

const databaseUrl = "postgres://loop_api:local@127.0.0.1:5433/loop_api_s30";
type VerifyInput = Parameters<CommunityRepository["verifyCommunity"]>[0];
const development = { NODE_ENV: "development", DATABASE_URL: databaseUrl };

const first: CommunityMissingChannelRecord = Object.freeze({
  communityId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  slug: "mock-defi-morning",
  name: "DeFi 早读会",
  memberCount: 311,
});
const second: CommunityMissingChannelRecord = Object.freeze({
  communityId: "9b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
  slug: "mock-meme-room",
  name: "Meme 观察室",
  memberCount: 18,
});

function verifiedRecord(
  candidate: CommunityMissingChannelRecord,
): CommunityRecord {
  return Object.freeze({
    communityId: candidate.communityId,
    name: candidate.name,
    slug: candidate.slug,
    description: null,
    logoRef: null,
    verificationStatus: "verified",
    boundAssetKey: null,
    memberCount: candidate.memberCount,
    createdAt: "2026-09-15T01:00:00.000Z",
    configVersion: "communityV1",
  });
}

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

function dependenciesFake(
  candidates: readonly CommunityMissingChannelRecord[],
  verifyCommunity = vi.fn((input: VerifyInput): Promise<CommunityRecord> =>
    Promise.resolve(
      verifiedRecord(
        candidates.find((c) => c.communityId === input.communityId) ?? first,
      ),
    ),
  ),
) {
  const close = vi.fn(() => Promise.resolve());
  const listCandidates = vi.fn(() => Promise.resolve(candidates));
  const create: CreateCommunityProvisionChannelsDependencies = () => ({
    repository: {
      ...createUnavailableCommunityRepository(),
      verifyCommunity,
    },
    listCandidates,
    close,
  });
  return { create, verifyCommunity, listCandidates, close };
}

describe("pnpm community:provision-channels operator script", () => {
  it("refuses production before opening a connection", () => {
    expect(() =>
      parseCommunityProvisionChannelsRequest(["node", "s", "--confirm"], {
        NODE_ENV: "production",
        DATABASE_URL: databaseUrl,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "community_provision_channels_forbidden_in_production",
      }),
    );
  });

  it("requires --confirm and refuses any other argument", () => {
    expect(() =>
      parseCommunityProvisionChannelsRequest(["node", "s"], development),
    ).toThrow(
      expect.objectContaining({
        code: "community_provision_channels_confirmation_required",
      }),
    );
    expect(() =>
      parseCommunityProvisionChannelsRequest(
        ["node", "s", "--confirm", "extra"],
        development,
      ),
    ).toThrow(
      expect.objectContaining({
        code: "community_provision_channels_arguments_invalid",
      }),
    );
    expect(() =>
      parseCommunityProvisionChannelsRequest(["node", "s", "--confirm"], {
        NODE_ENV: "development",
      }),
    ).toThrow(CommunityProvisionChannelsError);
  });

  it("re-drives verifyCommunity for every verified community without a channel", async () => {
    const fake = dependenciesFake([first, second]);
    const stdout = outputWriter();
    const stderr = outputWriter();
    const code = await runCommunityProvisionChannels({
      argv: ["node", "s", "--confirm"],
      environment: development,
      stdout,
      stderr,
      createDependencies: fake.create,
    });
    expect(code).toBe(0);
    expect(fake.verifyCommunity).toHaveBeenCalledTimes(2);
    for (const candidate of [first, second]) {
      expect(fake.verifyCommunity).toHaveBeenCalledWith(
        expect.objectContaining({
          communityId: candidate.communityId,
          reasonCode: "operator_channel_provision",
        }),
      );
    }
    for (const call of fake.verifyCommunity.mock.calls) {
      expect(call[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(stdout.contents()).toContain(
      "Channel provisioning enqueued for 3fa85f64-5717-4562-b3fc-2c963f66afa6 (slug mock-defi-morning, members 311)",
    );
    expect(stdout.contents()).toContain(
      "Provisioned 2 of 2 candidate communities",
    );
    expect(stderr.contents()).toBe("");
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when every verified community already has a channel", async () => {
    const fake = dependenciesFake([]);
    const stdout = outputWriter();
    const code = await runCommunityProvisionChannels({
      argv: ["node", "s", "--confirm"],
      environment: development,
      stdout,
      stderr: outputWriter(),
      createDependencies: fake.create,
    });
    expect(code).toBe(0);
    expect(fake.verifyCommunity).not.toHaveBeenCalled();
    expect(stdout.contents()).toContain("nothing to provision");
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it("reports a refused community, continues with the rest, and exits 1", async () => {
    const verifyCommunity = vi.fn(
      (input: VerifyInput): Promise<CommunityRecord> =>
        input.communityId === first.communityId
          ? Promise.reject(new Error("refused"))
          : Promise.resolve(verifiedRecord(second)),
    );
    const fake = dependenciesFake([first, second], verifyCommunity);
    const stdout = outputWriter();
    const stderr = outputWriter();
    const code = await runCommunityProvisionChannels({
      argv: ["node", "s", "--confirm"],
      environment: development,
      stdout,
      stderr,
      createDependencies: fake.create,
    });
    expect(code).toBe(1);
    expect(verifyCommunity).toHaveBeenCalledTimes(2);
    expect(stderr.contents()).toContain(
      `Channel provisioning failed for ${first.communityId} (slug mock-defi-morning)`,
    );
    expect(stdout.contents()).toContain(
      "Provisioned 1 of 2 candidate communities",
    );
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it("closes the pool when the candidate read itself fails", async () => {
    const close = vi.fn(() => Promise.resolve());
    const stderr = outputWriter();
    const code = await runCommunityProvisionChannels({
      argv: ["node", "s", "--confirm"],
      environment: development,
      stdout: outputWriter(),
      stderr,
      createDependencies: () => ({
        repository: createUnavailableCommunityRepository(),
        listCandidates: () => Promise.reject(new Error("down")),
        close,
      }),
    });
    expect(code).toBe(1);
    expect(stderr.contents()).toContain("community_provision_channels_failed");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
