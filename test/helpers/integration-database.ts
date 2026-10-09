/**
 * Shared database-target resolution for `test/**\/*.integration.test.ts`.
 *
 * Integration suites truncate and delete rows. They must therefore never run
 * against the developer database behind `DATABASE_URL`. Every suite obtains its
 * connection string through this module, which only reads
 * `DATABASE_URL_TEST` and refuses any database whose name does not contain
 * `test`.
 */
export const INTEGRATION_DATABASE_URL_VARIABLE = "DATABASE_URL_TEST";

const postgresProtocols = new Set(["postgres:", "postgresql:"]);

export function integrationDatabaseName(databaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl.trim());
  } catch {
    throw new Error(
      `${INTEGRATION_DATABASE_URL_VARIABLE} must be a valid PostgreSQL URL`,
    );
  }
  if (!postgresProtocols.has(parsed.protocol)) {
    throw new Error(
      `${INTEGRATION_DATABASE_URL_VARIABLE}: protocol must be postgres or postgresql`,
    );
  }
  return decodeURIComponent(parsed.pathname.replace(/^\/+/u, ""));
}

/**
 * Validates a candidate integration database URL and returns it unchanged.
 * Throws when the value is missing, malformed, or names a database without
 * `test` in its name so destructive fixtures can never reach a dev database.
 */
export function assertIntegrationDatabaseUrl(
  value: string | undefined,
): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `${INTEGRATION_DATABASE_URL_VARIABLE} is required for the integration test suite. ` +
        `Point it at a dedicated database whose name contains "test" ` +
        `(for example .../loop_api_test); DATABASE_URL is never used as a fallback.`,
    );
  }
  const databaseName = integrationDatabaseName(value);
  if (!/test/iu.test(databaseName)) {
    throw new Error(
      `${INTEGRATION_DATABASE_URL_VARIABLE} points at database "${databaseName}", ` +
        `whose name does not contain "test". Refusing to run destructive integration ` +
        `fixtures (truncate/delete) against it.`,
    );
  }
  return value.trim();
}

/** Reads and validates `DATABASE_URL_TEST` from the process environment. */
export function requireIntegrationDatabaseUrl(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return assertIntegrationDatabaseUrl(
    environment[INTEGRATION_DATABASE_URL_VARIABLE],
  );
}
