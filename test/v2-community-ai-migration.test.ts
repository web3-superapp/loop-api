import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000036_v2_community_ai.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000036 community AI migration contract (Decision 0066)", () => {
  it("stores no message text next to an answer", () => {
    const statement = captureSql(up);
    expect(statement).toContain("create table public.community_ai_answers");
    expect(statement).toContain("question text not null");
    expect(statement).toContain("answer text not null");
    expect(statement).toContain("citations jsonb not null");
    // The transcript the answer was derived from has no column at all.
    expect(statement).not.toContain("message_text");
    expect(statement).not.toContain("messages text");
    expect(statement).not.toContain("messages jsonb");
    expect(statement).not.toContain("transcript");
  });

  it("makes the quota ledger a one-way reservation", () => {
    const statement = captureSql(up);
    expect(statement).toContain("create table public.community_ai_usage");
    expect(statement).toContain("status text not null default 'reserved'");
    expect(statement).toContain(
      "check (status in ('reserved', 'completed', 'failed'))",
    );
    expect(statement).toContain("check (kind in ('ask', 'brief'))");
    expect(statement).toContain(
      "a community_ai_usage row only advances once out of reserved",
    );
    expect(statement).toContain(
      "create index community_ai_usage_owner_recent_idx",
    );
    expect(statement).toContain(
      "create index community_ai_usage_community_recent_idx",
    );
  });

  it("lets an account report only an answer it received, once", () => {
    const statement = captureSql(up);
    expect(statement).toContain(
      "create table public.community_ai_answer_reports",
    );
    expect(statement).toContain(
      "references public.community_ai_answers(answer_id, owner_user_id)",
    );
    expect(statement).toContain("unique (answer_id, reporter_user_id)");
    expect(statement).toContain(
      "check (reason in ('inaccurate', 'harmful', 'offTopic', 'privacy', 'other'))",
    );
  });

  it("keeps answers and reports immutable", () => {
    const statement = captureSql(up);
    expect(statement).toContain("community_ai_answers are immutable");
    expect(statement).toContain("community_ai_answer_reports are append-only");
  });

  it("registers both new idempotency digest versions", () => {
    const statement = captureSql(up);
    expect(statement).toContain("'community_ai_ask_v1'");
    expect(statement).toContain("'community_ai_report_v1'");
  });

  it("refuses a destructive rollback once an answer, report, or usage row exists", () => {
    const statement = captureSql(down);
    expect(statement).toContain("raise exception");
    expect(statement).toContain(
      "refusing destructive rollback of community AI answers, reports, or quota ledger",
    );
    expect(statement).toContain("drop table public.community_ai_answers");
    expect(statement).toContain("drop table public.community_ai_usage");
    expect(statement).toContain(
      "drop table public.community_ai_answer_reports",
    );
  });
});
