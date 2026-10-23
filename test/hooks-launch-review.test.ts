import type { Pool, PoolClient, QueryResult } from "pg";
import { describe, expect, it, vi } from "vitest";

import { adminLaunchReviewErrorProjection } from "../src/features/admin/admin-launch-review.js";
import { createPostgresHooksLaunchReviewRepository } from "../src/database/hooks-launch-review-repository.js";
import {
  HooksLaunchReviewError,
  createHooksLaunchReviewService,
  hooksLaunchCommandHash,
  hooksLaunchCommandPermission,
  hooksLaunchReviewCommandSchema,
  type HooksLaunchReviewRepository,
} from "../src/features/launch/hooks-launch-review.js";
import { parseOperatorArgs } from "../scripts/hooks-launch-operator.js";

/**
 * Decision 0108: separation-of-duties guards of the ported Hooks review
 * (requirer original `ops-launch-governance` / `ops-operator` tests).
 */

const actor = "75c20914-52af-457a-a406-2326faeb2a6c";
const owner = "3f5493ce-6226-4ac0-b73e-102443a16a79";
const project = "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f";
const configHash = `0x${"a".repeat(64)}`;

function approvalRepo(input: {
  readonly editorId: string | null;
  readonly configOwner?: string;
}) {
  const statements: string[] = [];
  const client = {
    query<T extends Record<string, unknown>>(
      statement: string | { readonly text: string },
    ): Promise<QueryResult<T>> {
      // Decision 0178: the notification insert passes a query config.
      const sql = typeof statement === "string" ? statement : statement.text;
      statements.push(sql);
      let rows: Record<string, unknown>[] = [];
      if (sql.includes("from public.ops_operators"))
        rows = [{ user_id: actor }];
      else if (sql.includes("from public.ops_grants")) rows = [{ one: 1 }];
      else if (sql.includes("from public.launch_projects"))
        rows = [
          {
            owner_user_id: input.configOwner ?? owner,
            review_status: "approved",
            // Decision 0178: the owner notification reads the project.
            name: "Project",
            ticker: "MEME",
            at: new Date("2026-10-23T00:00:00.000Z"),
          },
        ];
      else if (
        sql.includes("from public.hooks_launch_project_config_versions c")
      )
        rows = [
          {
            config_hash: configHash,
            owner_user_id: input.configOwner ?? owner,
            edited_by_operator_id: input.editorId,
            latest_version: 1,
          },
        ];
      else if (sql.includes("insert into public.hooks_launch_config_approvals"))
        rows = [{ project_id: project }];
      return Promise.resolve({
        rows: rows as T[],
        rowCount: rows.length,
        command: "SELECT",
        oid: 0,
        fields: [],
      });
    },
    release() {},
  } as unknown as PoolClient;
  const pool = { connect: () => Promise.resolve(client) } as unknown as Pool;
  return { repo: createPostgresHooksLaunchReviewRepository(pool), statements };
}

const approval = hooksLaunchReviewCommandSchema.parse({
  operationId: "b51b0ade-16dc-4c1e-9dd3-2f387a076591",
  action: "launch.config.approve",
  target: project,
  reason: "哈希独立复核",
  payload: { configVersion: 1, configHash },
});

function approvalInserted(statements: readonly string[]): boolean {
  return statements.some((sql) =>
    sql.includes("insert into public.hooks_launch_config_approvals"),
  );
}

describe("Hooks launch approval separation of duties", () => {
  it("rejects an operator approving the version they edited", async () => {
    const { repo, statements } = approvalRepo({ editorId: actor });
    await expect(repo.execute(actor, approval)).rejects.toMatchObject({
      code: "OPS_SELF_APPROVAL",
    });
    expect(approvalInserted(statements)).toBe(false);
  });

  it("rejects the project owner approving their own owner-saved draft", async () => {
    const { repo, statements } = approvalRepo({
      editorId: null,
      configOwner: actor,
    });
    await expect(repo.execute(actor, approval)).rejects.toMatchObject({
      code: "OPS_SELF_APPROVAL",
    });
    expect(approvalInserted(statements)).toBe(false);
  });

  it("lets an independent operator approve an owner-saved draft", async () => {
    const { repo, statements } = approvalRepo({ editorId: null });
    await expect(repo.execute(actor, approval)).resolves.toMatchObject({
      replayed: false,
    });
    expect(approvalInserted(statements)).toBe(true);
    // Decision 0178: the owner's launch.review_approved row, same transaction.
    expect(
      statements.some((sql) =>
        sql.includes("insert into public.notifications"),
      ),
    ).toBe(true);
    expect(
      statements.some((sql) =>
        sql.includes(
          "insert into public.ops_audit (operation_id, actor_id, action, target, reason, outcome) values",
        ),
      ),
    ).toBe(true);
  });

  it("maps each command to a separate permission", () => {
    expect(hooksLaunchCommandPermission("launch.config.save")).toBe(
      "launch.edit",
    );
    expect(hooksLaunchCommandPermission("launch.config.approve")).toBe(
      "launch.approve",
    );
    expect(hooksLaunchCommandPermission("testnet.acceptance.record")).toBe(
      "testnet.accept",
    );
  });

  it("hashes commands canonically regardless of key order", () => {
    expect(hooksLaunchCommandHash({ a: 1, b: [2, { c: 3, d: 4 }] })).toBe(
      hooksLaunchCommandHash({ b: [2, { d: 4, c: 3 }], a: 1 }),
    );
  });
});

describe("Hooks launch review service", () => {
  it("reads the Factory sale period for config saves only and fails closed without it (Decision 0119)", async () => {
    const save = {
      operationId: "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4",
      action: "launch.config.save",
      target: project,
      reason: "Operator correction",
      payload: {
        expectedVersion: 1,
        config: {
          name: "Project",
          ticker: "MEME",
          logoAssetUrl: "https://example.com/logo.png",
          description: "Test",
          links: [],
          nftSaleStartAt: "1900000000",
          buybackRecipient: "0x3333333333333333333333333333333333333333",
        },
      },
    };
    const execute = vi.fn(() => Promise.resolve({}));
    const repository = { execute } as unknown as HooksLaunchReviewRepository;
    const hourly = createHooksLaunchReviewService({
      fixedBuybackRecipient: "0x3333333333333333333333333333333333333333",
      repository,
      factory: {
        nftSaleDuration: () =>
          Promise.resolve({ seconds: 3_600, legacy: false }),
      },
    });
    await hourly.execute(actor, save);
    expect(execute).toHaveBeenLastCalledWith(
      actor,
      expect.objectContaining({ action: "launch.config.save" }),
      { nftSaleDurationSeconds: 3_600 },
    );
    for (const factory of [
      null,
      { nftSaleDuration: () => Promise.reject(new Error("rpc down")) },
    ]) {
      execute.mockClear();
      await expect(
        createHooksLaunchReviewService({
          fixedBuybackRecipient: "0x3333333333333333333333333333333333333333",
          repository,
          factory,
        }).execute(actor, save),
      ).rejects.toMatchObject({ code: "OPS_UNAVAILABLE" });
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it("fails closed without a repository", async () => {
    const service = createHooksLaunchReviewService({
      fixedBuybackRecipient: "0x3333333333333333333333333333333333333333",
      repository: null,
    });
    await expect(service.execute(actor, approval)).rejects.toMatchObject({
      code: "OPS_UNAVAILABLE",
    });
  });

  it("rejects malformed commands and non-UUID actors before the repository", async () => {
    const execute = vi.fn();
    const service = createHooksLaunchReviewService({
      fixedBuybackRecipient: "0x3333333333333333333333333333333333333333",
      repository: { execute } as unknown as HooksLaunchReviewRepository,
    });
    await expect(
      service.execute(actor, { ...approval, action: "mining.publish" }),
    ).rejects.toBeInstanceOf(HooksLaunchReviewError);
    await expect(
      service.execute(actor, {
        ...approval,
        payload: { ...approval.payload, extra: true },
      }),
    ).rejects.toMatchObject({ code: "OPS_INVALID_COMMAND" });
    await expect(service.execute("not-a-user", approval)).rejects.toMatchObject(
      { code: "OPS_FORBIDDEN" },
    );
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("Decision 0122 review rejections and the fixed recipient", () => {
  const reject = {
    operationId: "1c6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4",
    action: "launch.config.reject",
    target: project,
    reason: "incomplete_materials",
    payload: {
      configVersion: 1,
      configHash: `0x${"ab".repeat(32)}`,
      reasonCode: "incomplete_materials",
      note: null,
    },
  };

  it("maps both rejects to launch.approve and requires a note for other", async () => {
    expect(hooksLaunchCommandPermission("launch.config.reject")).toBe(
      "launch.approve",
    );
    expect(hooksLaunchCommandPermission("launch.project.reject")).toBe(
      "launch.approve",
    );
    const execute = vi.fn(() => Promise.resolve({}));
    const service = createHooksLaunchReviewService({
      fixedBuybackRecipient: "0x3333333333333333333333333333333333333333",
      repository: { execute } as unknown as HooksLaunchReviewRepository,
    });
    await service.execute(actor, reject);
    await service.execute(actor, {
      ...reject,
      action: "launch.project.reject",
      payload: { materialVersion: 2, reasonCode: "other", note: "Logo" },
    });
    expect(execute).toHaveBeenCalledTimes(2);
    for (const payload of [
      { ...reject.payload, reasonCode: "other", note: null },
      { ...reject.payload, reasonCode: "not_a_reason" },
      { ...reject.payload, note: "x".repeat(501) },
    ]) {
      await expect(
        service.execute(actor, { ...reject, payload }),
      ).rejects.toMatchObject({ code: "OPS_INVALID_COMMAND" });
    }
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("gates an operator save's ticker by the Factory rule (Decision 0164)", async () => {
    const recipient = "0x3333333333333333333333333333333333333333";
    const save = (ticker: string) => ({
      operationId: "2c6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c5",
      action: "launch.config.save",
      target: project,
      reason: "Operator correction",
      payload: {
        expectedVersion: 1,
        config: {
          name: "Project",
          ticker,
          logoAssetUrl: "https://example.com/logo.png",
          description: "Test",
          links: [],
          nftSaleStartAt: "1900000000",
          buybackRecipient: recipient,
        },
      },
    });
    const execute = vi.fn(() => Promise.resolve({}));
    const repository = { execute } as unknown as HooksLaunchReviewRepository;
    const factoryWith = (rule: () => Promise<"utf8" | "ascii">) => ({
      nftSaleDuration: () => Promise.resolve({ seconds: 3_600, legacy: false }),
      tickerTextRule: rule,
    });
    const service = (rule: () => Promise<"utf8" | "ascii">) =>
      createHooksLaunchReviewService({
        fixedBuybackRecipient: recipient,
        repository,
        factory: factoryWith(rule),
      });
    await expect(
      service(() => Promise.resolve("ascii")).execute(actor, save("狗狗币")),
    ).rejects.toMatchObject({ code: "OPS_TICKER_UNSUPPORTED_BY_FACTORY" });
    await expect(
      service(() => Promise.reject(new Error("rpc"))).execute(
        actor,
        save("狗狗币"),
      ),
    ).rejects.toMatchObject({ code: "OPS_UNAVAILABLE" });
    expect(execute).not.toHaveBeenCalled();
    await service(() => Promise.resolve("ascii")).execute(actor, save("MEME"));
    await service(() => Promise.resolve("utf8")).execute(actor, save("狗狗币"));
    expect(execute).toHaveBeenCalledTimes(2);
    expect(
      adminLaunchReviewErrorProjection("OPS_TICKER_UNSUPPORTED_BY_FACTORY"),
    ).toMatchObject({
      code: "VALIDATION_FAILED",
      detailsSafe: { reasonCode: "HOOKS_LAUNCH_TICKER_UNSUPPORTED_BY_FACTORY" },
    });
  });

  it("refuses an operator save naming another recipient, and fails closed without one", async () => {
    const save = {
      operationId: "2c6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4",
      action: "launch.config.save",
      target: project,
      reason: "Operator correction",
      payload: {
        expectedVersion: 1,
        config: {
          name: "Project",
          ticker: "MEME",
          logoAssetUrl: "https://example.com/logo.png",
          description: "Test",
          links: [],
          nftSaleStartAt: "1900000000",
          buybackRecipient: "0x4444444444444444444444444444444444444444",
        },
      },
    };
    const execute = vi.fn(() => Promise.resolve({}));
    const repository = { execute } as unknown as HooksLaunchReviewRepository;
    const factory = {
      nftSaleDuration: () => Promise.resolve({ seconds: 3_600, legacy: false }),
    };
    await expect(
      createHooksLaunchReviewService({
        fixedBuybackRecipient: "0x3333333333333333333333333333333333333333",
        repository,
        factory,
      }).execute(actor, save),
    ).rejects.toMatchObject({ code: "OPS_BUYBACK_RECIPIENT_FIXED" });
    await expect(
      createHooksLaunchReviewService({ repository, factory }).execute(
        actor,
        save,
      ),
    ).rejects.toMatchObject({ code: "OPS_UNAVAILABLE" });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("Hooks operator bootstrap arguments", () => {
  it("requires deliberate confirmation", () => {
    expect(() =>
      parseOperatorArgs([
        "--user",
        owner,
        "--label",
        "Ops",
        "--permissions",
        "launch.edit",
      ]),
    ).toThrow();
  });

  it("rejects unported or invented roles, duplicate flags, and scoped global grants", () => {
    for (const args of [
      ["--permissions", "root"],
      ["--permissions", "mining.edit"],
      ["--permissions", "audit.read", "--scope", project],
      ["--permissions", "launch.read", "--user", owner],
    ])
      expect(() =>
        parseOperatorArgs([
          "--user",
          owner,
          "--label",
          "Ops",
          "--confirm",
          ...args,
        ]),
      ).toThrow();
  });

  it("supports project-scoped grants and revoke without granting anything", () => {
    expect(
      parseOperatorArgs(["--user", owner, "--confirm", "--revoke"]),
    ).toEqual({ userId: owner, revoke: true });
    expect(
      parseOperatorArgs([
        "--confirm",
        "--user",
        owner,
        "--label",
        "Project reviewer",
        "--permissions",
        "launch.read,launch.approve",
        "--scope",
        project,
      ]),
    ).toMatchObject({
      scope: project,
      permissions: ["launch.read", "launch.approve"],
    });
  });
});
