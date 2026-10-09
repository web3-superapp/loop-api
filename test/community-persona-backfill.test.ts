import { describe, expect, it, vi } from "vitest";

import {
  COMMUNITY_PERSONA_BACKFILL_BATCH_SIZE,
  CommunityPersonaBackfillError,
  parseCommunityPersonaBackfillRequest,
  runCommunityPersonaBackfill,
  type CreateCommunityPersonaBackfillDependencies,
} from "../scripts/community-persona-backfill.js";
import type {
  CommunityChannelMemberWithoutPersona,
  CommunityChannelPersonaProjectionTarget,
  CommunityChannelPersonaRecord,
} from "../src/features/communication/communication-repository.js";

const databaseUrl = "postgres://loop_api:local@127.0.0.1:5433/loop_api_s47";
const development = {
  NODE_ENV: "development",
  DATABASE_URL: databaseUrl,
  STREAM_API_KEY: "stream_test_api_key",
  STREAM_API_SECRET: "stream_test_api_secret",
};
const communityId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const streamChannelId = `loop_community_${communityId.replaceAll("-", "")}`;
const leaseToken = "0f1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f";

function member(index: number): CommunityChannelMemberWithoutPersona {
  const ownerUserId = `6d12a86e-4134-47e6-9312-c5ef75a3${String(index).padStart(4, "0")}`;
  return Object.freeze({
    communityId,
    ownerUserId,
    streamChannelId,
    memberStreamUserId: `loop_${ownerUserId.replaceAll("-", "")}`,
  });
}

function persona(ownerUserId: string): CommunityChannelPersonaRecord {
  return Object.freeze({
    personaId: "b5d6f0c2-2d1e-4c3a-9f6b-7a8c9d0e1f2a",
    communityId,
    ownerUserId,
    alias: "Harbor-4821",
    aliasVersion: 1 as const,
    projectionState: "pending" as const,
    projectionAttempts: 1,
  });
}

function pendingTarget(index: number): CommunityChannelPersonaProjectionTarget {
  const m = member(index);
  return Object.freeze({
    persona: persona(m.ownerUserId),
    leaseToken,
    streamChannelId,
    memberStreamUserId: m.memberStreamUserId,
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
  withoutPersonaPages: readonly (readonly CommunityChannelMemberWithoutPersona[])[],
  claimBatches: readonly (readonly CommunityChannelPersonaProjectionTarget[])[],
  projectOutcomes: readonly ("confirmed" | "pending")[] = [],
) {
  const pages = [...withoutPersonaPages];
  const claims = [...claimBatches];
  const outcomes = [...projectOutcomes];
  const listMembersWithoutPersona = vi.fn(() =>
    Promise.resolve(pages.shift() ?? []),
  );
  const claimPendingProjections = vi.fn(() =>
    Promise.resolve(claims.shift() ?? []),
  );
  const ensurePersona = vi.fn(
    (input: { readonly communityId: string; readonly ownerUserId: string }) =>
      Promise.resolve({ persona: persona(input.ownerUserId), leaseToken }),
  );
  const projectPersona = vi.fn(() =>
    Promise.resolve(outcomes.shift() ?? ("confirmed" as const)),
  );
  const close = vi.fn(() => Promise.resolve());
  const pause = vi.fn(() => Promise.resolve());
  const create: CreateCommunityPersonaBackfillDependencies = () => ({
    personas: { listMembersWithoutPersona, claimPendingProjections },
    service: { ensurePersona, projectPersona },
    close,
    pause,
  });
  return {
    create,
    listMembersWithoutPersona,
    claimPendingProjections,
    ensurePersona,
    projectPersona,
    close,
    pause,
  };
}

describe("community persona backfill script (Decision 0055)", () => {
  it("refuses production, missing confirmation, unknown or malformed arguments, and missing configuration", () => {
    expect(() =>
      parseCommunityPersonaBackfillRequest(["node", "script", "--confirm"], {
        ...development,
        NODE_ENV: "production",
      }),
    ).toThrow(
      new CommunityPersonaBackfillError(
        "community_persona_backfill_forbidden_in_production",
      ),
    );
    expect(() =>
      parseCommunityPersonaBackfillRequest(["node", "script"], development),
    ).toThrow(
      new CommunityPersonaBackfillError(
        "community_persona_backfill_confirmation_required",
      ),
    );
    for (const args of [
      ["--confirm", "--all"],
      ["--confirm", "--max"],
      ["--confirm", "--max", "0"],
      ["--confirm", "--max", "12abc"],
      ["--confirm", "--max", "-5"],
    ]) {
      expect(() =>
        parseCommunityPersonaBackfillRequest(
          ["node", "script", ...args],
          development,
        ),
      ).toThrow(
        new CommunityPersonaBackfillError(
          "community_persona_backfill_arguments_invalid",
        ),
      );
    }
    expect(() =>
      parseCommunityPersonaBackfillRequest(["node", "script", "--confirm"], {
        ...development,
        DATABASE_URL: "",
      }),
    ).toThrow(
      new CommunityPersonaBackfillError(
        "community_persona_backfill_database_unconfigured",
      ),
    );
    expect(() =>
      parseCommunityPersonaBackfillRequest(["node", "script", "--confirm"], {
        ...development,
        STREAM_API_SECRET: undefined,
      }),
    ).toThrow(
      new CommunityPersonaBackfillError(
        "community_persona_backfill_stream_unconfigured",
      ),
    );
  });

  it("parses a confirmed development request with an optional --max", () => {
    expect(
      parseCommunityPersonaBackfillRequest(
        ["node", "script", "--confirm"],
        development,
      ),
    ).toEqual({
      databaseUrl,
      stream: {
        apiKey: "stream_test_api_key",
        apiSecret: "stream_test_api_secret",
      },
      maximum: 100_000,
    });
    expect(
      parseCommunityPersonaBackfillRequest(
        ["node", "script", "--max", "25", "--confirm"],
        development,
      ).maximum,
    ).toBe(25);
  });

  it("generates personas for members without one, then re-projects pending ones through the shared claim", async () => {
    const deps = dependenciesFake(
      [[member(1), member(2)]],
      [[pendingTarget(3)], []],
      ["confirmed", "pending", "confirmed"],
    );
    const stdout = outputWriter();
    const stderr = outputWriter();

    const code = await runCommunityPersonaBackfill({
      argv: ["node", "script", "--confirm"],
      environment: development,
      stdout,
      stderr,
      createDependencies: deps.create,
    });

    expect(code).toBe(1);
    expect(deps.ensurePersona).toHaveBeenCalledTimes(2);
    expect(deps.ensurePersona).toHaveBeenCalledWith({
      communityId,
      ownerUserId: member(1).ownerUserId,
    });
    expect(deps.claimPendingProjections).toHaveBeenCalledWith({
      limit: COMMUNITY_PERSONA_BACKFILL_BATCH_SIZE,
      leaseSeconds: 60,
    });
    expect(deps.projectPersona).toHaveBeenCalledTimes(3);
    expect(deps.projectPersona).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        leaseToken,
        streamChannelId,
        memberStreamUserId: member(1).memberStreamUserId,
      }),
    );
    expect(deps.projectPersona).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        persona: pendingTarget(3).persona,
        leaseToken,
        memberStreamUserId: member(3).memberStreamUserId,
      }),
    );
    expect(stdout.contents()).toContain(
      "Processed 3 synced official-channel members: 2 personas generated, 1 pending personas claimed, 2 projected and confirmed, 1 still pending",
    );
    expect(stderr.contents()).toContain(
      "1 persona projections were not confirmed by Stream",
    );
    expect(deps.close).toHaveBeenCalledTimes(1);
  });

  it("pages phase 1 with a keyset cursor, paces batches, and continues into phase 2", async () => {
    const full = Array.from(
      { length: COMMUNITY_PERSONA_BACKFILL_BATCH_SIZE },
      (_, i) => member(i),
    );
    const deps = dependenciesFake(
      [full, [member(500)]],
      [[pendingTarget(600)], []],
    );
    const stdout = outputWriter();

    const code = await runCommunityPersonaBackfill({
      argv: ["node", "script", "--confirm"],
      environment: development,
      stdout,
      stderr: outputWriter(),
      createDependencies: deps.create,
    });

    expect(code).toBe(0);
    expect(deps.listMembersWithoutPersona).toHaveBeenCalledTimes(2);
    expect(deps.listMembersWithoutPersona).toHaveBeenLastCalledWith({
      limit: COMMUNITY_PERSONA_BACKFILL_BATCH_SIZE,
      after: {
        communityId,
        ownerUserId: member(COMMUNITY_PERSONA_BACKFILL_BATCH_SIZE - 1)
          .ownerUserId,
      },
    });
    // One pause between the two phase-1 pages, one after the phase-2 batch.
    expect(deps.pause).toHaveBeenCalledTimes(2);
    expect(stdout.contents()).toContain("Processed 52 synced");
  });

  it("stops at --max, reports the run as truncated, and sizes the last batch to the remainder", async () => {
    const deps = dependenciesFake(
      [[member(1), member(2), member(3)]],
      [[pendingTarget(4)]],
    );
    const stdout = outputWriter();
    const stderr = outputWriter();

    const code = await runCommunityPersonaBackfill({
      argv: ["node", "script", "--confirm", "--max", "3"],
      environment: development,
      stdout,
      stderr,
      createDependencies: deps.create,
    });

    expect(code).toBe(1);
    expect(deps.listMembersWithoutPersona).toHaveBeenCalledWith({
      limit: 3,
      after: null,
    });
    expect(deps.claimPendingProjections).not.toHaveBeenCalled();
    expect(deps.projectPersona).toHaveBeenCalledTimes(3);
    expect(stdout.contents()).toContain("(stopped at --max 3)");
    expect(stderr.contents()).toContain(
      "More members remain; rerun to continue",
    );
  });

  it("reports nothing to do when no member lacks a persona and nothing is pending", async () => {
    const deps = dependenciesFake([[]], [[]]);
    const stdout = outputWriter();

    const code = await runCommunityPersonaBackfill({
      argv: ["node", "script", "--confirm"],
      environment: development,
      stdout,
      stderr: outputWriter(),
      createDependencies: deps.create,
    });

    expect(code).toBe(0);
    expect(stdout.contents()).toContain("Processed 0 synced");
    expect(deps.projectPersona).not.toHaveBeenCalled();
    expect(deps.pause).not.toHaveBeenCalled();
  });

  it("fails closed when a dependency throws and still closes the pool", async () => {
    const deps = dependenciesFake([[member(1)]], [[]]);
    deps.ensurePersona.mockRejectedValueOnce(new Error("db down"));
    const stderr = outputWriter();

    const code = await runCommunityPersonaBackfill({
      argv: ["node", "script", "--confirm"],
      environment: development,
      stdout: outputWriter(),
      stderr,
      createDependencies: deps.create,
    });

    expect(code).toBe(1);
    expect(stderr.contents()).toContain("community_persona_backfill_failed");
    expect(deps.close).toHaveBeenCalledTimes(1);
  });

  it("refuses without touching any dependency", async () => {
    const deps = dependenciesFake([[member(1)]], [[]]);
    const stderr = outputWriter();

    const code = await runCommunityPersonaBackfill({
      argv: ["node", "script"],
      environment: development,
      stdout: outputWriter(),
      stderr,
      createDependencies: deps.create,
    });

    expect(code).toBe(1);
    expect(stderr.contents()).toContain(
      "community_persona_backfill_confirmation_required",
    );
    expect(deps.listMembersWithoutPersona).not.toHaveBeenCalled();
    expect(deps.claimPendingProjections).not.toHaveBeenCalled();
  });
});
