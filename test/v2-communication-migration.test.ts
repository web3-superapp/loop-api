import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000017_v2_communication.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000017 V2 communication migration contract", () => {
  it("binds one deterministic Stream channel to one community", () => {
    const statement = captureSql(up);

    expect(statement).toContain("create table public.community_channels");
    expect(statement).toContain(
      "community_id uuid primary key\n        references public.communities(community_id) on delete restrict",
    );
    expect(statement).toContain(
      "check (stream_channel_id ~ '^loop_community_[0-9a-f]{32}$')",
    );
    expect(statement).toContain(
      "constraint community_channels_stream_channel_id_unique\n        unique (stream_channel_id)",
    );
    expect(statement).toContain(
      "check (state in ('created', 'capacityPending', 'failed'))",
    );
    expect(statement).toContain("check (channel_type = 'messaging')");
    expect(statement).toContain("member_cap between 1 and 200000");
  });

  it("keeps the four ruled channel member states", () => {
    const statement = captureSql(up);

    expect(statement).toContain(
      "create table public.community_channel_members",
    );
    expect(statement).toContain(
      "check (state in ('synced', 'pending', 'removed', 'capacityPending'))",
    );
    expect(statement).toContain(
      "check (stream_user_id ~ '^loop_[0-9a-f]{32}$')",
    );
    expect(statement).toContain("primary key (community_id, owner_user_id)");
  });

  it("stores one outbox row per (community, account) with a fenced lease", () => {
    const statement = captureSql(up);

    expect(statement).toContain(
      "create table public.community_channel_sync_jobs",
    );
    expect(statement).toContain("check (kind in ('add', 'remove'))");
    expect(statement).toContain(
      "check (state in ('pending', 'reconciling', 'succeeded', 'failed'))",
    );
    expect(statement).toContain("attempts integer not null default 0");
    expect(statement).toContain(
      "next_attempt_at timestamptz not null default clock_timestamp()",
    );
    expect(statement).toContain("last_error_code text");
    expect(statement).toContain(
      "constraint community_channel_sync_jobs_lease_pairing_check",
    );
    expect(statement).toContain(
      "create index community_channel_sync_jobs_due_idx",
    );
    expect(statement).toContain("where state in ('pending', 'reconciling')");
  });

  it("allows at most one live voice room per community", () => {
    const statement = captureSql(up);

    expect(statement).toContain("create table public.voice_rooms");
    expect(statement).toContain(
      "check (call_id ~ '^loop_voice_[0-9a-f]{32}$')",
    );
    expect(statement).toContain("check (call_type = 'audio_room')");
    expect(statement).toContain("check (state in ('live', 'ended'))");
    expect(statement).toContain(
      "check (provision_state in ('pending', 'provisioned', 'reconciling', 'failed'))",
    );
    expect(statement).toContain("backstage boolean not null default true");
    expect(statement).toContain(
      "check ((state = 'ended') = (ended_at is not null))",
    );
    expect(statement).toContain(
      "create unique index voice_rooms_one_live_per_community_idx\n      on public.voice_rooms (community_id)\n      where state = 'live'",
    );
  });

  it("keeps one host per room and the three-role ladder", () => {
    const statement = captureSql(up);

    expect(statement).toContain("create table public.voice_room_members");
    expect(statement).toContain(
      "check (role in ('host', 'speaker', 'listener'))",
    );
    expect(statement).toContain(
      "check (state in ('joined', 'left', 'removed'))",
    );
    expect(statement).toContain("check (role <> 'host' or state = 'joined')");
    expect(statement).toContain(
      "create unique index voice_room_members_one_host_idx",
    );
  });

  it("orders the hand-raise queue and allows one pending raise per account", () => {
    const statement = captureSql(up);

    expect(statement).toContain("create table public.voice_room_hand_raises");
    expect(statement).toContain("sequence bigint not null");
    expect(statement).toContain(
      "constraint voice_room_hand_raises_sequence_unique\n        unique (voice_room_id, sequence)",
    );
    expect(statement).toContain(
      "check (state in ('pending', 'invited', 'cancelled'))",
    );
    expect(statement).toContain(
      "create unique index voice_room_hand_raises_pending_idx\n      on public.voice_room_hand_raises (voice_room_id, owner_user_id)\n      where state = 'pending'",
    );
    expect(statement).toContain(
      "hand_raise_sequence bigint not null default 0",
    );
  });

  it("keeps both new audits append-only and idempotency-bound", () => {
    const statement = captureSql(up);

    for (const table of [
      "public.voice_room_events",
      "public.chat_group_membership_events",
    ]) {
      expect(statement).toContain(`create table ${table}`);
      expect(statement).toContain(
        `for each row execute function public.reject_community_audit_mutation()`,
      );
    }
    expect(statement).toContain(
      "constraint voice_room_events_idempotency_unique\n        unique (idempotency_record_id)",
    );
    expect(statement).toContain(
      "constraint chat_group_membership_events_idempotency_unique\n        unique (idempotency_record_id)",
    );
    expect(statement).toContain("'communication_command_v1'");
  });

  it("narrows the Decision 0025 group-member freeze to a member leaving", () => {
    const statement = captureSql(up);

    expect(statement).toContain(
      "drop trigger communication_group_members_immutable",
    );
    expect(statement).toContain(
      "create function public.guard_communication_group_member_mutation()",
    );
    expect(statement).toContain(
      "raise exception 'communication_group_members rows are immutable'",
    );
    expect(statement).toContain(
      "raise exception 'only a non-creator group member may leave'",
    );
    expect(statement).toContain(
      "create trigger communication_group_members_guard",
    );
  });

  it("refuses a destructive rollback and restores the previous freeze", () => {
    const statement = captureSql(down);

    expect(statement).toContain("in access exclusive mode");
    expect(statement).toContain(
      "refusing destructive rollback of v2 communication data",
    );
    for (const table of [
      "public.voice_room_events",
      "public.voice_room_hand_raises",
      "public.voice_room_members",
      "public.voice_rooms",
      "public.community_channel_sync_jobs",
      "public.community_channel_members",
      "public.community_channels",
      "public.chat_group_membership_events",
    ]) {
      expect(statement).toContain(`exists (select 1 from ${table})`);
      expect(statement).toContain(`drop table ${table};`);
    }
    expect(statement).toContain(
      "where digest_version = 'communication_command_v1'",
    );
    expect(statement).toContain(
      "create trigger communication_group_members_immutable",
    );
  });
});
