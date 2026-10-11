import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000069_mining_and_launch2_followups.js";
import { launch2CommunityBindingOutcomes } from "../src/features/launch2/launch2-meme-assets.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000069 mining and launch2 follow-ups migration contract (Decision 0125)", () => {
  it("adds the community, material approvals, MEME transfers, and coverage columns without rewriting rows", () => {
    const statement = captureSql(up);
    expect(statement).toContain(
      "add column community_id uuid\n        references public.communities(community_id) on delete restrict",
    );
    expect(statement).toContain("create table public.launch_project_approvals");
    expect(statement).toContain("unique (project_id, material_version)");
    expect(statement).toContain("create trigger launch_project_approvals_once");
    expect(statement).toContain(
      "create trigger launch_project_rejections_once",
    );
    expect(statement).toContain("create table public.launch2_meme_transfers");
    expect(statement).toContain(
      "primary key (chain_id, transaction_hash, log_index)",
    );
    expect(statement).toContain("add column meme_transfers_target_block");
    expect(statement).toContain("add column meme_transfers_complete_at");
    for (const outcome of launch2CommunityBindingOutcomes) {
      expect(statement).toContain(`'${outcome}'`);
    }
    expect(statement).not.toMatch(/\bupdate public\./u);
    expect(statement).not.toContain("delete from");
  });

  it("rolls back exactly what it added", () => {
    const statement = captureSql(down);
    expect(statement).toContain("drop table public.launch2_meme_transfers");
    expect(statement).toContain("drop table public.launch_project_approvals");
    expect(statement).toContain(
      "drop function public.reject_launch_project_decision_twice()",
    );
    expect(statement).toContain(
      "alter table public.launch_projects drop column community_id",
    );
    expect(statement).not.toContain(
      "drop table public.launch_project_rejections",
    );
  });
});
