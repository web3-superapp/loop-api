export const latestMigrationName = "000003_perp_intents";

export const requiredDatabaseRelations = Object.freeze([
  "public.loop_users",
  "public.provider_operations",
  "public.idempotency_records",
  "public.audit_events",
  "public.issuance_rate_records",
  "public.perp_intents",
  "public.perp_intent_items",
  "public.perp_intent_events",
] as const);
