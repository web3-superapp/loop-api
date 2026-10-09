import type { Pool, PoolClient, QueryResult } from "pg";
import { describe, expect, it } from "vitest";
import { createPostgresOpsRepository } from "../src/database/ops-repository.js";
import { opsCommandSchema } from "../src/features/ops/ops-contract.js";

const actor = "75c20914-52af-457a-a406-2326faeb2a6c";
const project = "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f";

function approvalRepo(editorId: string | null) {
  const statements: string[] = [];
  const client = {
    query<T extends Record<string, unknown>>(
      sql: string,
    ): Promise<QueryResult<T>> {
      statements.push(sql);
      let rows: Record<string, unknown>[] = [];
      if (sql.includes("from public.ops_operators"))
        rows = [{ user_id: actor }];
      else if (sql.includes("from public.ops_grants"))
        rows = [{ scope: project }];
      else if (sql.includes("from public.launch_projects"))
        rows = [{ review_status: "approved" }];
      else if (
        sql.includes("from public.hooks_launch_project_config_versions c")
      )
        rows = [
          {
            config_hash: `0x${"a".repeat(64)}`,
            edited_by_operator_id: editorId,
            latest_version: 1,
          },
        ];
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
  return { repo: createPostgresOpsRepository(pool), statements };
}

const approval = opsCommandSchema.parse({
  operationId: "b51b0ade-16dc-4c1e-9dd3-2f387a076591",
  action: "launch.config.approve",
  target: project,
  reason: "哈希独立复核",
  payload: { configVersion: 1, configHash: `0x${"a".repeat(64)}` },
});

describe("Hooks launch approval safeguards", () => {
  it("rejects an editor approving their own project config", async () => {
    const { repo, statements } = approvalRepo(actor);
    await expect(repo.execute(actor, approval)).rejects.toMatchObject({
      code: "OPS_SELF_APPROVAL",
      statusCode: 403,
    });
    expect(
      statements.some((sql) =>
        sql.includes("insert into public.hooks_launch_config_approvals"),
      ),
    ).toBe(false);
  });

  it("fails closed for legacy configs whose editor identity was not captured", async () => {
    const { repo } = approvalRepo(null);
    await expect(repo.execute(actor, approval)).rejects.toMatchObject({
      code: "OPS_EDITOR_ID_UNKNOWN",
    });
  });
});
