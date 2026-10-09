import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000050_hooks_launch_project_configs.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  return sql.mock.calls.map(([statement]) => statement).join("\n");
}

describe("Hooks project config migration", () => {
  it("stores append-only owner-scoped drafts and rejects template/economic overrides", () => {
    const sql = captureSql(up);
    expect(sql).toContain("references public.launch_projects(project_id)");
    expect(sql).toContain("primary key (project_id, config_version)");
    expect(sql).toContain("template_version = 'hooks_launch_v1'");
    expect(sql).toContain("config->>'configHash' = config_hash");
    expect(sql).toContain("config - array[");
    expect(sql).toContain("before update or delete");
    expect(sql).toContain("Hooks launch config versions are append-only");
  });

  it("drops only the new relation on downgrade", () => {
    expect(captureSql(down)).toContain(
      "drop table public.hooks_launch_project_config_versions",
    );
  });
});
