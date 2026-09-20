import { describe, expect, it, vi } from "vitest";

import {
  CommunityPersonaBackfillError,
  parseCommunityPersonaBackfillRequest,
  runCommunityPersonaBackfill,
  type CreateCommunityPersonaBackfillDependencies,
} from "../scripts/community-persona-backfill.js";
import type {
  CommunityChannelPersonaBackfillTarget,
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

function member(index: number): {
  readonly ownerUserId: string;
  readonly memberStreamUserId: string;
} {
  const ownerUserId = `6d12a86e-4134-47e6-9312-c5ef75a30f${String(index).padStart(2, "0")}`;
  return {
    ownerUserId,
    memberStreamUserId: `loop_${ownerUserId.replaceAll("-", "")}`,
  };
}

function persona(
  ownerUserId: string,
  projectionState: "pending" | "confirmed",
): CommunityChannelPersonaRecord {
  return Object.freeze({
    personaId: "b5d6f0c2-2d1e-4c3a-9f6b-7a8c9d0e1f2a",
    communityId,
    ownerUserId,
    alias: "Harbor-4821",
    aliasVersion: 1 as const,
    projectionState,
    projectionAttempts: 0,
  });
}

function target(
  index: number,
  existing: CommunityChannelPersonaRecord | null,
): CommunityChannelPersonaBackfillTarget {
  const m = member(index);
  return Object.freeze({
    communityId,
    ownerUserId: m.ownerUserId,
    streamChannelId,
    memberStreamUserId: m.memberStreamUserId,
    persona: existing,
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
  pages: readonly (readonly CommunityChannelPersonaBackfillTarget[])[],
  projectOutcomes: readonly ("confirmed" | "pending")[] = [],
) {
  const remainingPages = [...pages];
  const outcomes = [...projectOutcomes];
  const listBackfillTargets = vi.fn(() =>
    Promise.resolve(remainingPages.shift() ?? []),
  );
  const ensurePersona = vi.fn(
    (input: { readonly communityId: string; readonly ownerUserId: string }) =>
      Promise.resolve(persona(input.ownerUserId, "pending")),
  );
  const projectPersona = vi.fn(() =>
    Promise.resolve(outcomes.shift() ?? ("confirmed" as const)),
  );
  const close = vi.fn(() => Promise.resolve());
  const create: CreateCommunityPersonaBackfillDependencies = () => ({
    personas: { listBackfillTargets },
    service: { ensurePersona, projectPersona },
    close,
  });
  return { create, listBackfillTargets, ensurePersona, projectPersona, close };
}

describe("community persona backfill script (Decision 0055)", () => {
  it("refuses production, missing confirmation, unknown arguments, and missing configuration", () => {
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
    expect(() =>
      parseCommunityPersonaBackfillRequest(
        ["node", "script", "--confirm", "--all"],
        development,
      ),
    ).toThrow(
      new CommunityPersonaBackfillError(
        "community_persona_backfill_arguments_invalid",
      ),
    );
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

  it("parses a confirmed development request without leaking the secret", () => {
    const request = parseCommunityPersonaBackfillRequest(
      ["node", "script", "--confirm"],
      development,
    );
    expect(request).toEqual({
      databaseUrl,
      stream: {
        apiKey: "stream_test_api_key",
        apiSecret: "stream_test_api_secret",
      },
    });
  });

  it("generates missing personas, skips confirmed ones, re-projects pending ones, and is idempotent", async () => {
    const one = member(1);
    const deps = dependenciesFake(
      [
        [
          target(1, null),
          target(2, persona(member(2).ownerUserId, "confirmed")),
          target(3, persona(member(3).ownerUserId, "pending")),
        ],
      ],
      ["confirmed", "confirmed"],
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

    expect(code).toBe(0);
    expect(deps.ensurePersona).toHaveBeenCalledTimes(1);
    expect(deps.ensurePersona).toHaveBeenCalledWith({
      communityId,
      ownerUserId: one.ownerUserId,
    });
    expect(deps.projectPersona).toHaveBeenCalledTimes(2);
    expect(
      deps.projectPersona.mock.calls.map((call) => (call as unknown[])[0]),
    ).toEqual([
      expect.objectContaining({
        streamChannelId,
        memberStreamUserId: one.memberStreamUserId,
      }),
      expect.objectContaining({
        memberStreamUserId: member(3).memberStreamUserId,
      }),
    ]);
    expect(stdout.contents()).toContain(
      "Examined 3 synced official-channel members: 1 personas generated, 1 already confirmed, 2 projected and confirmed, 0 still pending",
    );
    expect(stderr.contents()).toBe("");
    expect(deps.close).toHaveBeenCalledTimes(1);
  });

  it("pages with a keyset cursor and reports pending projections as exit 1", async () => {
    const firstPage = Array.from({ length: 100 }, (_, i) => target(i, null));
    const deps = dependenciesFake(
      [firstPage, [target(100, null)]],
      Array.from({ length: 101 }, (_, i) =>
        i === 5 ? "pending" : "confirmed",
      ),
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
    expect(deps.listBackfillTargets).toHaveBeenCalledTimes(2);
    expect(deps.listBackfillTargets).toHaveBeenLastCalledWith({
      limit: 100,
      after: {
        communityId,
        ownerUserId: member(99).ownerUserId,
      },
    });
    expect(stdout.contents()).toContain("1 still pending");
    expect(stderr.contents()).toContain(
      "1 persona projections were not confirmed by Stream",
    );
  });

  it("reports nothing to do on an empty directory", async () => {
    const deps = dependenciesFake([[]]);
    const stdout = outputWriter();

    const code = await runCommunityPersonaBackfill({
      argv: ["node", "script", "--confirm"],
      environment: development,
      stdout,
      stderr: outputWriter(),
      createDependencies: deps.create,
    });

    expect(code).toBe(0);
    expect(stdout.contents()).toContain("Examined 0 synced");
    expect(deps.projectPersona).not.toHaveBeenCalled();
  });

  it("fails closed when a dependency throws and still closes the pool", async () => {
    const deps = dependenciesFake([[target(1, null)]]);
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
    const deps = dependenciesFake([[target(1, null)]]);
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
    expect(deps.listBackfillTargets).not.toHaveBeenCalled();
  });
});
