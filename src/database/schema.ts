export const latestMigrationName = "000004_agent_authorizations";

export const requiredDatabaseRelations = Object.freeze([
  "public.loop_users",
  "public.provider_operations",
  "public.idempotency_records",
  "public.audit_events",
  "public.issuance_rate_records",
  "public.perp_intents",
  "public.perp_intent_items",
  "public.perp_intent_events",
  "public.perp_agent_identities",
  "public.perp_agent_authorizations",
  "public.perp_agent_authorization_events",
] as const);
