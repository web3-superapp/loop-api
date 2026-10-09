import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000007_hyperliquid_spot_closed_loop.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  const statement = sql.mock.calls[0]?.[0];
  expect(typeof statement).toBe("string");
  return String(statement);
}

describe("000007 Hyperliquid Spot closed-loop migration contract", () => {
  it("adds the two Spot digest domains without relabeling legacy reservations", () => {
    const statement = captureSql(up);

    expect(statement).toContain("'spot_intent_request_v1'");
    expect(statement).toContain("'spot_agent_authorization_issue_v1'");
    expect(statement).not.toContain(
      "set digest_version = 'spot_intent_request_v1'",
    );
    expect(statement).not.toContain(
      "set digest_version = 'spot_agent_authorization_issue_v1'",
    );
  });

  it("creates independent Spot projections while retaining one wallet authority", () => {
    const statement = captureSql(up);
    const requiredTables = [
      "spot_agent_identities",
      "spot_agent_identity_events",
      "spot_intents",
      "spot_intent_events",
      "spot_agent_authorizations",
      "spot_agent_authorization_events",
      "hyperliquid_signer_nonce_state",
      "hyperliquid_signer_nonce_allocations",
    ];

    for (const table of requiredTables) {
      expect(statement).toContain(`create table public.${table}`);
    }
    expect(statement).toContain("references public.loop_users(id)");
    expect(statement).not.toContain("create table public.spot_wallet_bindings");
    expect(statement).not.toContain(
      "references public.perp_wallet_bindings(owner_user_id)",
    );
  });

  it("persists all four provider identifiers and enforces natural amount pairings", () => {
    const statement = captureSql(up);

    expect(statement).toContain("base_token_index integer not null");
    expect(statement).toContain("base_token_id text not null");
    expect(statement).toContain("quote_token_index integer not null");
    expect(statement).toContain("quote_token_id text not null");
    expect(statement).toContain("spot_pair_index integer not null");
    expect(statement).toContain("exchange_order_asset integer not null");
    expect(statement).toContain("market_id uuid not null");
    expect(statement).toContain(
      "check (exchange_order_asset = 10000 + spot_pair_index)",
    );
    expect(statement).toContain("(side = 'buy' and amount_mode = 'quote')");
    expect(statement).toContain("(side = 'sell' and amount_mode = 'base')");
    expect(statement).toContain("check (client_order_id ~ '^0x[0-9a-f]{32}$')");
    expect(statement).toContain("result_fee_amount text");
    expect(statement).toContain("result_fee_token_id text");
    expect(statement).toContain("|@(0|[1-9][0-9]{0,9}))$");
    expect(statement).toContain("state in ('partially_filled', 'filled')");
  });

  it("binds every committed provider attempt to one durable nonce allocation", () => {
    const statement = captureSql(up);

    expect(statement).toContain("unique (network, signer_address, nonce)");
    expect(statement).toContain(
      "Spot provider attempt has no exact nonce allocation",
    );
    expect(statement).toContain(
      "Spot Agent authorization has no exact nonce reservation",
    );
    expect(statement).toContain(
      "Spot order nonce cannot be allocated before its attempt journal",
    );
    expect(statement).toContain(
      "new.last_allocated_nonce <= old.last_allocated_nonce",
    );
    expect(statement).toContain(
      "authorization_nonce = trunc(authorization_nonce)",
    );
    expect(statement).toContain("nonce = trunc(nonce)");
    expect(statement).toContain(
      "current_high_water is distinct from new.nonce",
    );
  });

  it("guards immutable authority and append-only lifecycle history", () => {
    const statement = captureSql(up);

    expect(statement).toContain("spot_agent_identities cannot be deleted");
    expect(statement).toContain("spot_intents cannot be deleted");
    expect(statement).toContain("spot_agent_authorizations cannot be deleted");
    expect(statement).toContain("Spot lifecycle events are append-only");
    expect(statement).toContain(
      "hyperliquid_signer_nonce_allocations is append-only",
    );
    expect(statement).toContain("deferrable initially deferred");
    expect(statement).toContain("Spot and provider operation states disagree");
    expect(statement).toContain(
      "create unique index spot_agent_authorizations_live_identity_unique",
    );
    expect(statement).toContain(
      "typed_data_primary_type = 'HyperliquidTransaction:ApproveAgent'",
    );
    expect(statement).toContain("'reserved', 'active', 'revoked'");
  });

  it("locks all writers and refuses destructive rollback before any drop", () => {
    const statement = captureSql(down);
    const lockIndex = statement.indexOf("lock table");
    const guardIndex = statement.indexOf("do $guard$");
    const providerGuardIndex = statement.indexOf(
      "operation_kind in (\n              'spot_intent',",
    );
    const firstDropIndex = statement.indexOf(
      "drop trigger provider_operations_spot_projection_complete",
    );

    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(statement).toContain("in access exclusive mode");
    expect(guardIndex).toBeGreaterThan(lockIndex);
    expect(providerGuardIndex).toBeGreaterThan(guardIndex);
    expect(firstDropIndex).toBeGreaterThan(providerGuardIndex);
    expect(statement).toContain("using errcode = '55000'");
    expect(statement).toContain("'spot_intent_prepare'");
    expect(statement).toContain("'spot_agent_authorization_issue'");
    expect(statement).toContain("'price_alert_create_v1'");
    expect(statement).not.toContain("drop table public.perp_wallet_bindings");
  });
});
