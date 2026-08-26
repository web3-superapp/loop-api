import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  latestMigrationName,
  requiredDatabaseRelations,
} from "../src/database/schema.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("database schema readiness contract", () => {
  it("tracks the newest append-only migration", async () => {
    const migrationNames = (
      await readdir(resolve(repositoryRoot, "migrations"))
    )
      .filter((name) => /^\d{6}_[a-z0-9_]+\.ts$/.test(name))
      .map((name) => name.replace(/\.ts$/, ""))
      .sort();

    expect(migrationNames.at(-1)).toBe(latestMigrationName);
  });

  it("requires every relation introduced through the current migration head", () => {
    expect(requiredDatabaseRelations).toEqual([
      "public.loop_users",
      "public.provider_operations",
      "public.idempotency_records",
      "public.audit_events",
      "public.issuance_rate_records",
      "public.perp_intents",
      "public.perp_intent_items",
      "public.perp_intent_events",
      "public.perp_wallet_bindings",
      "public.perp_wallet_binding_events",
      "public.spot_agent_identities",
      "public.spot_agent_identity_events",
      "public.spot_intents",
      "public.spot_intent_events",
      "public.spot_agent_authorizations",
      "public.spot_agent_authorization_events",
      "public.hyperliquid_signer_nonce_state",
      "public.hyperliquid_signer_nonce_allocations",
      "public.perp_agent_identities",
      "public.perp_agent_authorizations",
      "public.perp_agent_authorization_events",
      "public.user_profiles",
      "public.privacy_preferences",
      "public.watchlist_versions",
      "public.watchlist_groups",
      "public.watchlist_items",
      "public.price_alert_definitions",
      "public.notification_preference_versions",
      "public.notification_preferences",
      "public.price_alert_events",
    ]);
    expect(new Set(requiredDatabaseRelations).size).toBe(
      requiredDatabaseRelations.length,
    );
  });
});
