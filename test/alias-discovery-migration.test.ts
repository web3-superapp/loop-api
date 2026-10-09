import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import {
  down,
  up,
} from "../migrations/000012_alias_discovery_and_group_personas.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000012 alias discovery and group personas migration contract", () => {
  it("rejects unsafe legacy profile aliases before tightening the shared database constraint", () => {
    const statement = captureSql(up);
    const functionIndex = statement.indexOf(
      "create function public.loop_alias_text_is_safe(value text)",
    );
    const guardIndex = statement.indexOf("do $profile_alias_guard$");
    const constraintIndex = statement.indexOf(
      "drop constraint user_profiles_alias_check",
    );

    expect(functionIndex).toBeGreaterThanOrEqual(0);
    expect(guardIndex).toBeGreaterThan(functionIndex);
    expect(constraintIndex).toBeGreaterThan(guardIndex);
    expect(statement).toContain("not public.loop_alias_text_is_safe(alias)");
    expect(statement).toContain("using errcode = '55000'");
    expect(statement).toContain("public.loop_alias_text_is_safe(alias)");
    expect(statement).toContain("code_point between 917536 and 917631");
  });

  it("adds stable public profile IDs and versioned generated prefix keys", () => {
    const statement = captureSql(up);

    expect(statement).toContain(
      "add column public_profile_id uuid not null default gen_random_uuid()",
    );
    expect(statement).toContain("unique (public_profile_id)");
    expect(statement).toContain(
      "create function public.loop_alias_search_key_unicode17_v1(value text)",
    );
    expect(statement).toMatch(/normalize\(\s*translate\(/);
    expect(statement).toContain("chr(42993)");
    expect(statement).toContain("chr(117974)");
    expect(statement).toContain("chr(118009)");
    expect(statement).toContain("'SABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'");
    expect(statement).toMatch(
      /alias_search_key text generated always as \(\s*case\s+when alias is null then null\s+else public\.loop_alias_search_key_unicode17_v1\(alias\)\s+end\s*\) stored/,
    );
    expect(statement).toContain(
      "check (alias_search_version = 'unicode17_nfkc_lower_ws_v1')",
    );
    expect(statement).toContain('alias_search_key collate "C"');
    expect(statement).not.toContain("text_pattern_ops");
    expect(statement).toContain("where alias_search_key is not null");
  });

  it("creates an opaque immutable mapping to strict messaging channel IDs", () => {
    const statement = captureSql(up);

    expect(statement).toContain("create table public.communication_groups");
    expect(statement).toContain(
      "group_id uuid primary key default gen_random_uuid()",
    );
    expect(statement).toContain(
      "unique (stream_channel_type, stream_channel_id)",
    );
    expect(statement).toContain("check (stream_channel_type = 'messaging')");
    expect(statement).toContain(
      "stream_channel_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'",
    );
    expect(statement).toContain(
      "before update or delete on public.communication_groups",
    );
    expect(statement).toContain("communication_groups mappings are immutable");
  });

  it("reserves one permanent normalized alias per owner and per group", () => {
    const statement = captureSql(up);

    expect(statement).toContain("create table public.group_alias_reservations");
    expect(statement).toContain(
      "group_alias_id uuid primary key default gen_random_uuid()",
    );
    expect(statement).toContain(
      "references public.communication_groups(group_id) on delete restrict",
    );
    expect(statement).toContain(
      "references public.loop_users(id) on delete restrict",
    );
    expect(statement).toContain("unique (group_id, owner_user_id)");
    expect(statement).toContain("unique (group_id, alias_search_key)");
    expect(statement).toMatch(
      /alias_search_key text generated always as \(\s*public\.loop_alias_search_key_unicode17_v1\(alias\)\s*\) stored/,
    );
    expect(statement).toContain(
      "projection_state text not null default 'pending'",
    );
    expect(statement).toContain("projection_state in ('pending', 'confirmed')");
    expect(statement).toContain("where projection_state = 'confirmed'");
    expect(statement).toContain("public.loop_alias_text_is_safe(alias)");
  });

  it("allows only monotonic projection confirmation and rejects identity mutation or deletion", () => {
    const statement = captureSql(up);

    for (const immutableField of [
      "new.group_alias_id is distinct from old.group_alias_id",
      "new.group_id is distinct from old.group_id",
      "new.owner_user_id is distinct from old.owner_user_id",
      "new.alias is distinct from old.alias",
      "new.alias_search_key is distinct from old.alias_search_key",
      "new.alias_search_version is distinct from old.alias_search_version",
      "new.created_at is distinct from old.created_at",
    ]) {
      expect(statement).toContain(immutableField);
    }
    expect(statement).toContain("group alias projection must start pending");
    expect(statement).toContain("group_alias_reservations cannot be deleted");
    expect(statement).toContain("new.updated_at < old.updated_at");
    expect(statement).toContain("old.projection_state = 'pending'");
    expect(statement).toContain("new.projection_state = 'confirmed'");
    expect(statement).toContain(
      "confirmed group alias projection is irreversible",
    );
    expect(statement).toContain(
      "after insert or update or delete on public.group_alias_reservations",
    );
  });

  it("locks and rejects destructive rollback before cleaning every added object", () => {
    const statement = captureSql(down);
    const lockIndex = statement.indexOf("lock table");
    const guardIndex = statement.indexOf("do $guard$");
    const firstDropIndex = statement.indexOf(
      "drop trigger group_alias_reservations_guard",
    );

    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(statement).toContain("in access exclusive mode");
    expect(
      statement.indexOf("public.group_alias_reservations", lockIndex),
    ).toBeLessThan(statement.indexOf("public.communication_groups", lockIndex));
    expect(guardIndex).toBeGreaterThan(lockIndex);
    expect(statement).toContain("exists (select 1 from public.user_profiles)");
    expect(statement).toContain(
      "exists (select 1 from public.communication_groups)",
    );
    expect(statement).toContain(
      "exists (select 1 from public.group_alias_reservations)",
    );
    expect(statement).toContain("using errcode = '55000'");
    expect(firstDropIndex).toBeGreaterThan(guardIndex);

    for (const object of [
      "drop function public.guard_group_alias_reservation_mutation()",
      "drop index public.group_alias_reservations_search_prefix_idx",
      "drop table public.group_alias_reservations",
      "drop function public.reject_communication_group_mutation()",
      "drop table public.communication_groups",
      "drop index public.user_profiles_alias_search_prefix_idx",
      "drop column alias_search_version",
      "drop column alias_search_key",
      "drop column public_profile_id",
      "drop function if exists public.loop_alias_search_key_unicode17_v1(text)",
      "drop function if exists public.loop_alias_text_is_safe(text)",
    ]) {
      expect(statement).toContain(object);
    }
  });
});
