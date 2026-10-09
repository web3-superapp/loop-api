import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000008_spot_agent_generations.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000008 Spot Agent generation migration contract", () => {
  it("backfills generation without firing the lifecycle update trigger", () => {
    const statement = captureSql(up);

    expect(statement).toContain(
      "add column agent_generation bigint not null default 1",
    );
    expect(statement).toContain("alter column agent_generation drop default");
    expect(statement).not.toContain("update public.spot_agent_identities");
    expect(statement).not.toContain("set agent_generation");
  });

  it("allows history but admits at most one current generation per epoch", () => {
    const statement = captureSql(up);

    expect(statement).toContain(
      "spot_agent_identities_owner_epoch_generation_unique",
    );
    expect(statement).toContain(
      "create unique index spot_agent_identities_current_epoch_unique",
    );
    for (const state of [
      "'reserved'",
      "'authorization_pending'",
      "'active'",
      "'operator_hold'",
    ]) {
      expect(statement).toContain(state);
    }
    expect(statement).toContain(
      "drop constraint spot_agent_identities_owner_epoch_unique",
    );
    expect(statement).toContain(
      "new.agent_generation is distinct from old.agent_generation",
    );
    expect(statement).toContain("old.lifecycle_state = 'operator_hold'");
  });

  it("indexes the persisted authorization expiry source without rewriting it", () => {
    const statement = captureSql(up);

    expect(statement).toContain(
      "spot_agent_authorizations_identity_valid_until_idx",
    );
    expect(statement).toContain("agent_valid_until desc");
    expect(statement).not.toContain("request_sha256 =");
    expect(statement).not.toContain("authorization_nonce =");
  });

  it("locks writers and refuses lossy rollback before dropping generation", () => {
    const statement = captureSql(down);
    const guard = statement.indexOf("where agent_generation <> 1");
    const firstDrop = statement.indexOf("drop index");

    expect(statement).toContain("in access exclusive mode");
    expect(guard).toBeGreaterThan(-1);
    expect(firstDrop).toBeGreaterThan(guard);
    expect(statement).toContain(
      "add constraint spot_agent_identities_owner_epoch_unique",
    );
  });
});
