export const latestMigrationName = "000002_api_control_plane";

export const requiredDatabaseRelations = Object.freeze([
  "public.loop_users",
  "public.provider_operations",
  "public.idempotency_records",
  "public.audit_events",
  "public.issuance_rate_records",
] as const);
