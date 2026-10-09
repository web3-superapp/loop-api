import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import * as configs from "../migrations/000051_hooks_launch_project_configs.js";
import * as operators from "../migrations/000052_ops_hooks_operators.js";
import * as review from "../migrations/000053_hooks_review_and_testnet_acceptance.js";
import * as tasks from "../migrations/000054_hooks_signed_deployment_tasks.js";
import {
  latestMigrationName,
  requiredDatabaseRelations,
} from "../src/database/schema.js";

/**
 * Decision 0108: migration contracts for the Hooks launch port (requirer
 * originals 000050 / 000047+000049+000051 / 000052 / 000053).
 */
function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  return sql.mock.calls.map(([statement]) => statement).join("\n");
}

describe("000051 Hooks project config drafts", () => {
  it("stores append-only owner-scoped drafts and rejects template/economic overrides", () => {
    const sql = captureSql(configs.up);
    expect(sql).toContain("references public.launch_projects(project_id)");
    expect(sql).toContain("primary key (project_id, config_version)");
    expect(sql).toContain("template_version = 'hooks_launch_v1'");
    expect(sql).toContain("config->>'configHash' = config_hash");
    expect(sql).toContain("config - array[");
    expect(sql).toContain("before update or delete");
    expect(sql).toContain("Hooks launch config versions are append-only");
  });

  it("drops only the new relation on downgrade", () => {
    expect(captureSql(configs.down)).toContain(
      "drop table public.hooks_launch_project_config_versions",
    );
  });
});

describe("000052 ops operators (Hooks review subset)", () => {
  it("adds individual operators with separate read, edit, approve and acceptance grants", () => {
    const sql = captureSql(operators.up);
    expect(sql).toContain("create table public.ops_operators");
    expect(sql).toContain("references public.loop_users(id)");
    for (const permission of [
      "audit.read",
      "launch.read",
      "launch.edit",
      "launch.approve",
      "testnet.read",
      "testnet.accept",
    ]) {
      expect(sql).toContain(`'${permission}'`);
    }
    expect(sql).not.toContain("'mining.edit'");
    expect(sql).not.toContain("ops_mining_drafts");
    expect(sql).not.toContain("ops_jobs");
    expect(sql).toContain("ops_audit_actor_shape");
    expect(sql).toContain("ops_audit is append-only");
  });

  it("refuses downgrade while operator facts exist", () => {
    const sql = captureSql(operators.down);
    expect(sql).toContain("refusing to roll back 000052");
    expect(sql).toContain("using errcode = '55000'");
    expect(sql).not.toContain("delete from");
  });
});

describe("000053 Hooks review and Testnet evidence", () => {
  it("persists immutable independent approvals and BSC Testnet-only acceptance evidence", () => {
    const sql = captureSql(review.up);
    expect(sql).toContain("edited_by_operator_id");
    expect(sql).toContain("references public.ops_operators(user_id)");
    expect(sql).toContain("hooks_launch_config_approvals");
    expect(sql).toContain("hooks_testnet_acceptances");
    expect(sql).toContain("check (chain_id = 97)");
    expect(sql).toContain("before update or delete");
  });

  it("protects recorded evidence from downgrade deletion", () => {
    const sql = captureSql(review.down);
    expect(sql).toContain(
      "refusing to remove Hooks review or acceptance evidence",
    );
    expect(sql).toContain("using errcode = '55000'");
  });
});

describe("000054 signed deployment tasks", () => {
  it("binds tasks to an approval and allows only awaiting_executor -> cancelled", () => {
    const sql = captureSql(tasks.up);
    expect(sql).toContain(
      "references public.hooks_launch_config_approvals(project_id,config_version)",
    );
    expect(sql).toContain("check (chain_id = 97)");
    expect(sql).toContain("6666$");
    expect(sql).toContain("status in ('awaiting_executor','cancelled')");
    expect(sql).toContain("hooks_deployment_active_nonce");
    expect(sql).toContain("invalid deployment task mutation");
  });

  it("refuses to drop signed deployment evidence", () => {
    expect(captureSql(tasks.down)).toContain(
      "refusing to remove signed deployment evidence",
    );
  });

  it("is the latest migration and every new table is a required relation", () => {
    expect(latestMigrationName).toBe("000054_hooks_signed_deployment_tasks");
    for (const relation of [
      "public.hooks_launch_project_config_versions",
      "public.ops_operators",
      "public.ops_grants",
      "public.ops_operations",
      "public.ops_audit",
      "public.hooks_launch_config_approvals",
      "public.hooks_testnet_acceptances",
      "public.hooks_launch_deployment_tasks",
      "public.hooks_launch_deployment_authorizations",
      "public.hooks_launch_submission_commands",
    ]) {
      expect(requiredDatabaseRelations).toContain(relation);
    }
  });
});
