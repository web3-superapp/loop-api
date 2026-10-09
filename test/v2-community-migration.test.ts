import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000016_v2_community_social.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000016 V2 community and social graph migration contract", () => {
  it("creates communities with the ruled field, slug, and verification constraints", () => {
    const statement = captureSql(up);

    expect(statement).toContain("create table public.communities");
    expect(statement).toContain(
      "community_id uuid primary key default gen_random_uuid()",
    );
    expect(statement).toContain("char_length(name) between 1 and 40");
    expect(statement).toContain("public.loop_alias_text_is_safe(name)");
    expect(statement).toContain("check (slug ~ '^[a-z0-9-]{3,32}$')");
    expect(statement).toContain("char_length(description) between 1 and 280");
    expect(statement).toContain(
      "logo_ref ~ '^avatar:preset/community-(0[1-9]|1[0-2])$'",
    );
    expect(statement).toContain(
      "check (verification_status in ('pending', 'verified', 'rejected'))",
    );
    expect(statement).toContain(
      "bound_asset_key ~ '^eip155:[1-9][0-9]{0,9}:0x[0-9a-f]{40}$'",
    );
    expect(statement).toContain("check (config_version = 'communityV1')");
    expect(statement).toContain(
      "constraint communities_slug_unique unique (slug)",
    );
  });

  it("keeps member_count server-maintained inside the same transaction", () => {
    const statement = captureSql(up);

    expect(statement).toContain("member_count integer not null default 0");
    expect(statement).toContain(
      "create function public.loop_community_membership_counts()",
    );
    expect(statement).toContain("member_count = member_count + 1");
    expect(statement).toContain("member_count = member_count - 1");
    expect(statement).toContain(
      "create trigger community_memberships_member_count",
    );
    expect(statement).toContain(
      "after insert or update of status or delete on public.community_memberships",
    );
    expect(statement).toContain(
      "constraint communities_member_count_check check (member_count >= 0)",
    );
  });

  it("enforces one membership per account, one owner, and the three-tier role ladder", () => {
    const statement = captureSql(up);

    expect(statement).toContain("create table public.community_memberships");
    expect(statement).toContain(
      "constraint community_memberships_community_owner_unique\n        unique (community_id, owner_user_id)",
    );
    expect(statement).toContain("check (role in ('owner', 'admin', 'member'))");
    expect(statement).toContain(
      "check (status in ('active', 'muted', 'banned'))",
    );
    expect(statement).toContain("check (role <> 'owner' or status = 'active')");
    expect(statement).toContain(
      "create unique index community_memberships_one_owner_idx",
    );
    expect(statement).toContain("where role = 'owner'");
  });

  it("appends every governance change to an append-only audit relation", () => {
    const statement = captureSql(up);

    expect(statement).toContain("create table public.community_role_events");
    expect(statement).toContain("'community_profile_updated'");
    expect(statement).toContain("'role_changed'");
    expect(statement).toContain("'member_muted'");
    expect(statement).toContain("'member_banned'");
    expect(statement).toContain("'community_verified'");
    expect(statement).toContain(
      "constraint community_role_events_idempotency_unique\n        unique (idempotency_record_id)",
    );
    expect(statement).toContain("community_role_events are append-only");
    expect(statement).toContain(
      "create trigger community_role_events_append_only",
    );
    expect(statement).toContain("check (actor_type in ('member', 'operator'))");
  });

  it("creates a directed follow graph that forbids self-follow and duplicates", () => {
    const statement = captureSql(up);

    expect(statement).toContain("create table public.follow_edges");
    expect(statement).toContain(
      "primary key (follower_user_id, followee_user_id)",
    );
    expect(statement).toContain("check (follower_user_id <> followee_user_id)");
  });

  it("creates an owner-scoped block list with the three ruled kinds", () => {
    const statement = captureSql(up);

    expect(statement).toContain("create table public.user_blocks");
    expect(statement).toContain(
      "check (kind in ('user', 'contract', 'domain'))",
    );
    expect(statement).toContain(
      "constraint user_blocks_owner_kind_stable_unique\n        unique (owner_user_id, kind, stable_id)",
    );
    expect(statement).toContain(
      "target_user_id is null or target_user_id <> owner_user_id",
    );
  });

  it("registers the two new command digest versions on idempotency_records", () => {
    const statement = captureSql(up);

    expect(statement).toContain("'community_command_v1'");
    expect(statement).toContain("'social_graph_command_v1'");
    expect(statement).toContain(
      "alter table public.idempotency_records\n      drop constraint idempotency_records_digest_version_check",
    );
  });

  it("does not touch the frozen V1 friend graph or profile relations", () => {
    const statement = captureSql(up);

    expect(statement).not.toMatch(/alter table public\.friend_requests/);
    expect(statement).not.toMatch(/alter table public\.friendships/);
    expect(statement).not.toMatch(/alter table public\.user_profiles/);
  });

  it("refuses a destructive rollback while community or social data exists", () => {
    const statement = captureSql(down);

    expect(statement).toContain(
      "refusing destructive rollback of v2 community and social graph data",
    );
    expect(statement).toContain("from public.communities");
    expect(statement).toContain("from public.community_memberships");
    expect(statement).toContain("from public.follow_edges");
    expect(statement).toContain("from public.user_blocks");
    expect(statement).toContain("drop table public.communities");
    expect(statement).toContain("'community_command_v1'");
  });
});
