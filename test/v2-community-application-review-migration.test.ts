import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import {
  down,
  up,
} from "../migrations/000039_v2_community_application_review.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000039 community application review migration contract (Decision 0073)", () => {
  it("adds the three review facts, backfills the submission time, and pairs them with the status", () => {
    const statement = captureSql(up);

    expect(statement).toContain(
      "add column application_submitted_at timestamptz",
    );
    expect(statement).toContain("add column reviewed_at timestamptz");
    expect(statement).toContain("add column rejected_reason text");
    expect(statement).toContain("set application_submitted_at = created_at");
    expect(statement).toContain(
      "when verification_status = 'verified' then verified_at",
    );
    expect(statement).toContain(
      "alter column application_submitted_at set not null",
    );
    expect(statement).toContain(
      "char_length(rejected_reason) between 1 and 280",
    );
    expect(statement).toContain(
      "public.loop_alias_text_is_safe(rejected_reason)",
    );
    expect(statement).toContain("communities_review_pairing_check");
    expect(statement).toContain(
      "verification_status = 'pending'\n            and reviewed_at is null\n            and rejected_reason is null",
    );
    expect(statement).toContain(
      "verification_status = 'verified'\n            and reviewed_at is not null\n            and rejected_reason is null",
    );
    expect(statement).toContain(
      "verification_status = 'rejected'\n            and reviewed_at is not null",
    );
  });

  it("keeps the reason on the audit row and admits the resubmission event", () => {
    const statement = captureSql(up);

    expect(statement).toContain("add column note text");
    expect(statement).toContain("char_length(note) between 1 and 280");
    expect(statement).toContain("'community_resubmitted'");
    expect(statement).toContain("'community_rejected'");
    // The append-only trigger of 000016 is untouched.
    expect(statement).not.toContain("community_role_events_append_only");
  });

  it("admits the two review push events", () => {
    const statement = captureSql(up);
    expect(statement).toContain("'community_application_verified'");
    expect(statement).toContain("'community_application_rejected'");
    expect(statement).toContain("push_deliveries_event_type_check");
  });

  it("refuses to roll back while resubmissions, notes, or review deliveries exist", () => {
    const statement = captureSql(down);
    expect(statement).toContain(
      "where event_type = 'community_resubmitted' or note is not null",
    );
    expect(statement).toContain("'community_application_verified'");
    expect(statement).toContain("drop column rejected_reason");
    expect(statement).toContain("drop column reviewed_at");
    expect(statement).toContain("drop column application_submitted_at");
    expect(statement).toContain("drop column note");
  });
});
