import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000015_v2_loop_id_profile.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000015 V2 LOOP ID profile migration contract", () => {
  it("adds a backfilled, unique, immutable Crockford LOOP ID to loop_users", () => {
    const statement = captureSql(up);
    const backfillIndex = statement.indexOf("do $backfill$");
    const notNullIndex = statement.indexOf("alter column loop_id set not null");

    expect(statement).toContain(
      "create function public.loop_generate_loop_id()",
    );
    expect(statement).toContain("'0123456789ABCDEFGHJKMNPQRSTVWXYZ'");
    expect(statement).toContain("gen_random_uuid()");
    expect(statement).toContain("add column loop_id text;");
    expect(backfillIndex).toBeGreaterThan(0);
    expect(notNullIndex).toBeGreaterThan(backfillIndex);
    expect(statement).toContain(
      "add constraint loop_users_loop_id_unique unique (loop_id)",
    );
    expect(statement).toContain(
      "check (loop_id ~ '^LOOP-[0-9A-HJKMNP-TV-Z]{8}$')",
    );
    expect(statement).toContain("loop_id is immutable");
  });

  it("extends user_profiles with activation state, bio, and interests without touching alias/avatar", () => {
    const statement = captureSql(up);

    expect(statement).toContain(
      "add column profile_status text not null default 'pending'",
    );
    expect(statement).toContain("add column activated_at timestamptz");
    expect(statement).toContain("add column bio text");
    expect(statement).toContain(
      "add column interests text[] not null default '{}'::text[]",
    );
    expect(statement).toContain("profile_status in ('pending', 'active')");
    expect(statement).toContain("char_length(bio) between 1 and 160");
    expect(statement).toContain("public.loop_alias_text_is_safe(bio)");
    expect(statement).toContain("cardinality(interests) <= 6");
    expect(statement).toContain(
      "interests <@ array['MEME', 'DEFI', 'AI', 'GAMEFI', 'NFT', 'RWA']::text[]",
    );
    expect(statement).toContain("profile activation is irreversible");
    expect(statement).not.toMatch(/alter column alias/);
    expect(statement).not.toMatch(/alter column avatar_ref/);
    expect(statement).not.toMatch(/alter column record_version/);
  });

  it("creates the independent V2 privacy relation without a copy-trade field", () => {
    const statement = captureSql(up);

    expect(statement).toContain("create table public.privacy_preferences_v2");
    expect(statement).toContain(
      "anonymous_mode boolean not null default false",
    );
    for (const column of [
      "total_assets_visibility",
      "mining_power_visibility",
      "communities_visibility",
      "trade_history_visibility",
    ]) {
      expect(statement).toContain(`${column} text not null default 'self'`);
      expect(statement).toContain(`${column} in ('self', 'everyone')`);
    }
    expect(statement).not.toContain("copy_trade");
  });

  it("stores permanent owner/route/digest-bound activation commands", () => {
    const statement = captureSql(up);

    expect(statement).toContain(
      "create table public.profile_activation_commands",
    );
    expect(statement).toContain("unique (command_kind, idempotency_key)");
    expect(statement).toContain(
      "request_digest_version text not null default 'profile_activation_v1'",
    );
    expect(statement).toContain("check (contract_version = '2.0')");
    expect(statement).toContain(
      "result_status in ('activated', 'already_active')",
    );
    expect(statement).toContain("profile_activation_commands are permanent");
  });

  it("locks and refuses a destructive rollback once V2 profile data exists", () => {
    const statement = captureSql(down);
    const lockIndex = statement.indexOf("lock table");
    const guardIndex = statement.indexOf("do $guard$");
    const dropIndex = statement.indexOf(
      "drop table public.privacy_preferences_v2",
    );

    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(guardIndex).toBeGreaterThan(lockIndex);
    expect(dropIndex).toBeGreaterThan(guardIndex);
    expect(statement).toContain("refusing destructive rollback");
    expect(statement).toContain("if exists (select 1 from public.loop_users)");
    expect(statement).toContain("an assigned LOOP ID is immutable");
    expect(statement).toContain("using errcode = '55000'");
    expect(statement).toContain("drop column loop_id");
  });
});
