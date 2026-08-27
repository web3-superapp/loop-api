import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import {
  down,
  up,
} from "../migrations/000009_spot_reconciliation_projection.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000009 Spot reconciliation projection migration contract", () => {
  it("locks writers, preflights existing rows, and adds deferred insurance triggers", () => {
    const statement = captureSql(up);
    const lockIndex = statement.indexOf("lock table");
    const helperIndex = statement.indexOf(
      "create function public.spot_reconciliation_projection_pair_is_valid",
    );
    const preflightIndex = statement.indexOf("do $preflight$");
    const validatorIndex = statement.indexOf(
      "create function public.validate_spot_reconciliation_projection",
    );
    const firstTriggerIndex = statement.indexOf("create constraint trigger");

    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(statement).toContain("in share row exclusive mode");
    expect(helperIndex).toBeGreaterThan(lockIndex);
    expect(preflightIndex).toBeGreaterThan(helperIndex);
    expect(validatorIndex).toBeGreaterThan(preflightIndex);
    expect(firstTriggerIndex).toBeGreaterThan(validatorIndex);
    expect(statement.match(/create constraint trigger/g)).toHaveLength(3);
    expect(statement.match(/deferrable initially deferred/g)).toHaveLength(3);
    expect(statement).toContain("left join public.spot_intents");
    expect(statement).toContain("left join public.spot_agent_authorizations");
    expect(statement).toContain("using errcode = '23514'");
    expect(statement).not.toContain(
      "create or replace function public.validate_spot_operation_projection",
    );
    expect(statement).not.toMatch(
      /\b(?:update|delete from|insert into) public\.(?:provider_operations|spot_intents|spot_agent_authorizations)\b/,
    );
  });

  it("encodes both direct-result and fenced-reconciliation projection matrices", () => {
    const statement = captureSql(up);

    expect(statement).toContain("when 'spot_intent' then");
    expect(statement).toContain("when 'spot_agent_authorization' then");
    expect(statement).toContain("projection_state in ('prepared', 'expired')");
    expect(statement).toContain(
      "projection_state in ('partially_filled', 'filled', 'not_filled')",
    );
    expect(statement).toContain("projection_state = 'active'");
    expect(statement).toContain("projection_state = 'failed'");
    expect(statement).toContain(
      "operation_reconciliation_status in ('not_required', 'complete')",
    );
    expect(statement).toContain("projection_state = 'unknown'");
    expect(statement).toContain("operation_reconciliation_status = 'pending'");
    expect(statement).toContain("projection_state = 'reconciling'");
    expect(statement).toContain("operation_reconciliation_status = 'leased'");
    expect(statement).toContain("projection_state = 'operator_required'");
    expect(statement).toContain(
      "operation_reconciliation_status = 'operator_required'",
    );
    expect(
      statement.match(/spot_reconciliation_projection_pair_is_valid\(/g),
    ).toHaveLength(3);
  });

  it("removes only its triggers and functions after taking the same writer locks", () => {
    const statement = captureSql(down);
    const lockIndex = statement.indexOf("lock table");
    const firstTriggerDropIndex = statement.indexOf(
      "drop trigger provider_operations_spot_reconciliation_projection_complete",
    );
    const validatorDropIndex = statement.indexOf(
      "drop function public.validate_spot_reconciliation_projection",
    );
    const helperDropIndex = statement.indexOf(
      "drop function public.spot_reconciliation_projection_pair_is_valid",
    );

    expect(statement).toContain("in share row exclusive mode");
    expect(firstTriggerDropIndex).toBeGreaterThan(lockIndex);
    expect(statement.match(/drop trigger/g)).toHaveLength(3);
    expect(validatorDropIndex).toBeGreaterThan(firstTriggerDropIndex);
    expect(helperDropIndex).toBeGreaterThan(validatorDropIndex);
    expect(statement).not.toContain(
      "drop function public.validate_spot_operation_projection",
    );
    expect(statement).not.toContain(
      "drop trigger provider_operations_spot_projection_complete",
    );
    expect(statement).not.toContain("drop table");
    expect(statement).not.toContain("agent_generation");
  });
});
