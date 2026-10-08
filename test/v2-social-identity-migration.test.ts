import type { MigrationBuilder } from "node-pg-migrate";
import { describe, expect, it, vi } from "vitest";

import { down, up } from "../migrations/000046_v2_social_identity.js";
import {
  latestMigrationName,
  requiredDatabaseRelations,
} from "../src/database/schema.js";

function captureSql(operation: (pgm: MigrationBuilder) => void): string {
  const sql = vi.fn<(statement: string) => void>();
  operation({ sql } as unknown as MigrationBuilder);
  expect(sql).toHaveBeenCalledOnce();
  return String(sql.mock.calls[0]?.[0]);
}

describe("000046 social identity migration contract (Decision 0095)", () => {
  it("adds immutable WebP media objects, uploaded logos, public defaults, deletable friendships, and swap indexes", () => {
    const statement = captureSql(up);
    expect(statement).toContain("create table public.media_objects");
    expect(statement).toContain("check (kind in ('avatar', 'community_logo'))");
    expect(statement).toContain("check (content_type = 'image/webp')");
    expect(statement).toContain("unique (owner_user_id, idempotency_key)");
    expect(statement).toContain("before update on public.media_objects");
    expect(statement).toContain("logo_ref ~ '^logo:media/");
    expect(statement).toContain(
      "alter column total_assets_visibility set default 'everyone'",
    );
    expect(statement).toContain(
      "alter column trade_history_visibility set default 'everyone'",
    );
    expect(statement).toContain("total_assets_visibility = 'everyone'");
    expect(statement).toContain("record_version = record_version + 1");
    expect(statement).toContain("drop trigger friendships_immutable");
    expect(statement).toContain("before update on public.friendships");
    expect(statement).toContain("'friendship_removed'");
    expect(statement).toContain("indexed_pool_events_swap_recipient_idx");
    expect(statement).toContain("indexed_pool_events_swap_sender_idx");
    // Mining power and communities keep their fail-closed default.
    expect(statement).not.toContain("mining_power_visibility");
    expect(statement).not.toContain("communities_visibility");
  });

  it("refuses to roll back over recorded removals or uploaded logos", () => {
    const statement = captureSql(down);
    expect(statement).toContain(
      "refusing rollback while friendship removals are recorded",
    );
    expect(statement).toContain(
      "refusing rollback while communities use uploaded logos",
    );
    expect(statement).toContain("drop table public.media_objects");
    expect(statement).toContain(
      "before update or delete on public.friendships",
    );
  });

  it("is followed by 000048 (Decision 0098) and its table is a required relation", () => {
    expect(latestMigrationName).toBe("000048_v2_group_rename_voice_title");
    expect(requiredDatabaseRelations).toContain("public.media_objects");
  });
});
