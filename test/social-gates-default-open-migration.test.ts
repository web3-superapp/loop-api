import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000038_social_gates_default_open.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000038 social gates default-open migration contract (Decision 0070)", () => {
  it("moves every column default to the open value without rewriting rows", () => {
    const statement = captureSql(up);
    expect(statement).toContain(
      "alter table public.social_privacy_preferences",
    );
    expect(statement).toContain(
      "alter column friend_requests set default 'enabled'",
    );
    expect(statement).toContain(
      "alter column group_invites set default 'friends'",
    );
    expect(statement).toContain(
      "alter column direct_messages set default 'friends'",
    );
    expect(statement).not.toMatch(/\bupdate\b/i);
    expect(statement).not.toMatch(/\binsert\b/i);
    expect(statement).not.toMatch(/\bdelete\b/i);
  });

  it("documents that a missing row is the open default and an explicit disabled is kept", () => {
    const statement = captureSql(up);
    expect(statement).toContain(
      "comment on table public.social_privacy_preferences is",
    );
    expect(statement).toContain("A missing row means the open defaults");
    expect(statement).toContain(
      "an explicit disabled value is respected as written",
    );
    expect(statement).not.toContain("every social capability is disabled");
  });

  it("rolls the defaults and the comment back to the 000013 wording", () => {
    const statement = captureSql(down);
    expect(statement).toContain(
      "alter column friend_requests set default 'disabled'",
    );
    expect(statement).toContain(
      "alter column group_invites set default 'disabled'",
    );
    expect(statement).toContain(
      "alter column direct_messages set default 'disabled'",
    );
    expect(statement).toContain(
      "Missing rows mean every social capability is disabled.",
    );
    expect(statement).not.toMatch(/\bupdate\b/i);
  });
});
