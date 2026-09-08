import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000023_v2_launch_mining.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000023 V2 launch, mining, and referral migration contract", () => {
  it("creates the application catalog with the ruled review state machine", () => {
    const statement = captureSql(up);
    expect(statement).toContain("create table public.launch_projects");
    expect(statement).toContain(
      "'draft', 'submitted', 'in_review', 'returned', 'approved', 'rejected'",
    );
    expect(statement).toContain(
      "check (kyb_status in ('pending', 'unavailable'))",
    );
    expect(statement).toContain("check (ticker ~ '^[A-Z0-9]{2,12}$')");
    expect(statement).toContain("material_version integer not null default 1");
    expect(statement).toContain("record_version bigint not null default 1");
  });

  it("keeps the review audit append-only with applicant/operator pairing", () => {
    const statement = captureSql(up);
    expect(statement).toContain("create table public.launch_review_events");
    expect(statement).toContain(
      "check (actor_type in ('applicant', 'operator'))",
    );
    expect(statement).toContain("launch_review_events are append-only");
    expect(statement).toContain(
      "create trigger launch_review_events_append_only",
    );
    expect(statement).toContain(
      "constraint launch_review_events_idempotency_unique\n        unique (idempotency_record_id)",
    );
  });

  it("pins every on-chain axis to unavailable and the contract address to null", () => {
    const statement = captureSql(up);
    expect(statement).toContain("create table public.launches");
    expect(statement).toContain(
      "sale_state text not null default 'unavailable'",
    );
    expect(statement).toContain(
      "entitlement_state text not null default 'unavailable'",
    );
    expect(statement).toContain(
      "liquidity_state text not null default 'unavailable'",
    );
    expect(statement).toContain(
      "operational_state text not null default 'unavailable'",
    );
    expect(statement).toContain("constraint launches_axes_unavailable_check");
    expect(statement).toContain("state_tuple_digest text,");
    expect(statement).toContain("snapshot_block_number bigint,");
    expect(statement).toContain("snapshot_block_hash text,");
    expect(statement).toContain(
      "check (schedule_status in ('unscheduled', 'scheduled', 'live', 'ended'))",
    );
    expect(statement).toContain(
      "constraint launches_project_unique unique (project_id)",
    );
  });

  it("creates versioned configuration and round slots that default to pending confirmation", () => {
    const statement = captureSql(up);
    expect(statement).toContain("create table public.launch_configs");
    expect(statement).toContain(
      "check (status in ('pending_confirmation', 'confirmed'))",
    );
    expect(statement).toContain(
      "create unique index launch_configs_one_confirmed_idx",
    );
    expect(statement).toContain("create table public.launch_rounds");
    expect(statement).toContain(
      "constraint launch_rounds_index_unique unique (launch_id, round_index)",
    );
    expect(statement).toContain("price_usd1 text,");
    expect(statement).toContain("wallet_round_cap_raw numeric(78, 0),");
    expect(statement).toContain(
      "eligibility_tier in ('priority', 'community', 'public')",
    );
  });

  it("creates the Launch Intent namespace and settlement structures with the 03 §8.2/§8.3 bindings", () => {
    const statement = captureSql(up);
    expect(statement).toContain("create table public.launch_intents");
    for (const column of [
      "quote_asset_id",
      "project_asset_id",
      "pay_amount_raw numeric(78, 0)",
      "expected_receive_raw numeric(78, 0)",
      "wallet_cumulative_raw numeric(78, 0)",
      "state_tuple_digest text not null",
      "snapshot_block_number bigint not null",
      "snapshot_block_hash text not null",
      "payload_digest text not null",
      "contract_address text not null",
    ]) {
      expect(statement, column).toContain(column);
    }
    expect(statement).toContain(
      "constraint launch_intents_direction_check check (direction = 'buy')",
    );
    expect(statement).toContain("create table public.purchase_records");
    expect(statement).toContain("create table public.entitlements");
    expect(statement).toContain("create table public.refund_liabilities");
    expect(statement).toContain(
      "constraint refund_liabilities_wallet_unique unique (launch_id, wallet_id)",
    );
    expect(statement).toContain("create table public.refund_claims");
  });

  it("creates independent venue milestones that require evidence for LISTED and FEATURED", () => {
    const statement = captureSql(up);
    expect(statement).toContain("create table public.venue_milestones");
    expect(statement).toContain(
      "'PREPARING', 'APPLIED', 'EVIDENCE_PENDING', 'LISTED', 'FEATURED',\n          'REJECTED', 'DEFERRED', 'EVIDENCE_INVALID', 'DELISTED'",
    );
    expect(statement).toContain(
      "check (venue in ('lbank', 'binance', 'bithumb'))",
    );
    expect(statement).toContain(
      "check (market_type in ('spot', 'alpha', 'perpetual'))",
    );
    expect(statement).toContain(
      "check (state not in ('LISTED', 'FEATURED') or evidence_digest is not null)",
    );
  });

  it("seeds the draft formula as pending_approval with rule keys only", () => {
    const statement = captureSql(up);
    expect(statement).toContain("create table public.mining_formula_versions");
    expect(statement).toContain("'miningFormulaV1-draft'");
    expect(statement).toContain(
      "create unique index mining_formula_versions_one_approved_idx",
    );
    expect(statement).toContain("'assetWeights', jsonb_build_object()");
    expect(statement).toContain("'mining.rules.priceGuard.twap'");
    expect(statement).toContain("'mining.rules.priceGuard.liquidityCap'");
    // No weight number and no reward promise before approval (03 §19).
    expect(statement).not.toMatch(/'loop', jsonb_build_object\('weight'/);
    expect(statement).not.toMatch(/0\.1|1\.0x|reward_budget|annual/);
    expect(statement).toContain("create table public.community_mining_weights");
    expect(statement).toContain(
      "check (status in ('pending_review', 'approved'))",
    );
    expect(statement).toContain("create table public.mining_snapshots");
    expect(statement).toContain("create table public.mining_snapshot_powers");
    expect(statement).toContain("create table public.mining_reward_ledger");
  });

  it("creates one invite code per account and append-only referral edges bounded to depth 5", () => {
    const statement = captureSql(up);
    expect(statement).toContain("create table public.invite_codes");
    expect(statement).toContain(
      "check (code ~ '^LOOP-[0-9A-HJKMNP-TV-Z]{5}$')",
    );
    expect(statement).toContain("create table public.referral_edges");
    expect(statement).toContain(
      "constraint referral_edges_invitee_depth_unique unique (invitee_user_id, depth)",
    );
    expect(statement).toContain("check (inviter_user_id <> invitee_user_id)");
    expect(statement).toContain("check (depth between 1 and 5)");
    expect(statement).toContain(
      "'pending_activation', 'pending_wallet', 'pending_mining', 'valid', 'invalidated'",
    );
    expect(statement).toContain("create trigger referral_edges_append_only");
    expect(statement).toContain("create table public.referral_events");
    expect(statement).toContain("create trigger referral_events_append_only");
  });

  it("registers the two new command digest versions and refuses a destructive rollback", () => {
    const statement = captureSql(up);
    expect(statement).toContain("'launch_command_v1'");
    expect(statement).toContain("'referral_command_v1'");
    // Every earlier digest version must survive the constraint rewrite.
    for (const version of [
      "'community_command_v1'",
      "'social_graph_command_v1'",
      "'communication_command_v1'",
      "'price_alert_create_v2'",
    ]) {
      expect(statement, version).toContain(version);
    }
    const rollback = captureSql(down);
    expect(rollback).toContain(
      "refusing destructive rollback of v2 launch, mining, and referral data",
    );
    expect(rollback).toContain("drop table public.launch_projects");
    expect(rollback).toContain("drop table public.referral_edges");
    expect(rollback).not.toContain(
      "'launch_command_v1',\n        'referral_command_v1'\n      ));\n  `);\n}\n\nexport function down",
    );
  });
});
