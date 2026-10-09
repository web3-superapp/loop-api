import { describe, expect, it } from "vitest";

import {
  INTEGRATION_DATABASE_URL_VARIABLE,
  assertIntegrationDatabaseUrl,
  integrationDatabaseName,
  requireIntegrationDatabaseUrl,
} from "./helpers/integration-database.js";

describe("integration database guard", () => {
  it("only reads DATABASE_URL_TEST and never falls back to DATABASE_URL", () => {
    expect(INTEGRATION_DATABASE_URL_VARIABLE).toBe("DATABASE_URL_TEST");
    expect(() =>
      requireIntegrationDatabaseUrl({
        DATABASE_URL: "postgres://u:p@127.0.0.1:5433/loop_api_test",
      }),
    ).toThrow(/DATABASE_URL_TEST is required/u);
    expect(() =>
      requireIntegrationDatabaseUrl({ DATABASE_URL_TEST: "   " }),
    ).toThrow(/DATABASE_URL_TEST is required/u);
  });

  it("refuses databases whose name does not contain test", () => {
    expect(() =>
      assertIntegrationDatabaseUrl(
        "postgres://u:p@127.0.0.1:5433/loop_api_dev",
      ),
    ).toThrow(/"loop_api_dev".*does not contain "test"/u);
    expect(() =>
      assertIntegrationDatabaseUrl("postgres://u:p@127.0.0.1:5433/loop_api"),
    ).toThrow(/Refusing to run destructive integration fixtures/u);
  });

  it("rejects malformed and non-PostgreSQL URLs", () => {
    expect(() => assertIntegrationDatabaseUrl("not a url")).toThrow(
      /valid PostgreSQL URL/u,
    );
    expect(() =>
      assertIntegrationDatabaseUrl("mysql://u:p@127.0.0.1/loop_api_test"),
    ).toThrow(/protocol must be postgres or postgresql/u);
  });

  it("accepts a dedicated test database and returns the trimmed URL", () => {
    const url = "postgresql://u:p@127.0.0.1:5433/loop_api_test";
    expect(assertIntegrationDatabaseUrl(` ${url} `)).toBe(url);
    expect(integrationDatabaseName(url)).toBe("loop_api_test");
    expect(
      requireIntegrationDatabaseUrl({
        DATABASE_URL_TEST: "postgres://u:p@localhost/Loop_TEST_ci",
      }),
    ).toBe("postgres://u:p@localhost/Loop_TEST_ci");
  });
});
