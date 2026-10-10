import { describe, expect, it } from "vitest";

import {
  DevResetError,
  allSteps,
  deleteSteps,
  mixedSteps,
  parseDevResetRequest,
  runDevResetUsers,
  tableClassification,
} from "../scripts/dev-reset-users.js";
import { requiredDatabaseRelations } from "../src/database/schema.js";

/** Decision 0113: classification coverage, step shape, safety locks. */

function writer() {
  let contents = "";
  return {
    write: (chunk: string) => {
      contents += chunk;
      return true;
    },
    contents: () => contents,
  };
}

const devUrl = "postgres://loop_api:x@127.0.0.1:5433/loop_api_dev";

function refusal(argv: readonly string[], environment: NodeJS.ProcessEnv) {
  try {
    parseDevResetRequest(["node", "dev-reset-users", ...argv], environment);
  } catch (error) {
    expect(error).toBeInstanceOf(DevResetError);
    return (error as DevResetError).code;
  }
  throw new Error("expected a refusal");
}

describe("dev:reset-users table classification", () => {
  it("classifies exactly the schema's tables (sequences excluded) plus pgmigrations", () => {
    const tables = requiredDatabaseRelations
      .map((relation) => relation.replace(/^public\./u, ""))
      .filter((name) => name !== "profile_code_sequence");
    expect(Object.keys(tableClassification).sort()).toEqual(
      [...tables, "pgmigrations"].sort(),
    );
  });

  it("deletes every user-rooted table and never touches a platform table", () => {
    const deleted = new Set(deleteSteps.map((step) => step.table));
    for (const [table, kind] of Object.entries(tableClassification)) {
      if (kind === "user") {
        expect({ table, deleted: deleted.has(table) }).toEqual({
          table,
          deleted: true,
        });
      }
    }
    for (const step of allSteps) {
      expect({
        table: step.table,
        kind: tableClassification[step.table],
      }).not.toEqual({ table: step.table, kind: "platform" });
      expect(tableClassification[step.table]).toBeDefined();
    }
    for (const step of mixedSteps) {
      expect(step.action).toBe("update");
    }
    // Rows are deleted at most once and loop_users goes last.
    expect(new Set(deleteSteps.map((step) => step.table)).size).toBe(
      deleteSteps.length,
    );
    expect(deleteSteps.at(-1)?.table).toBe("loop_users");
  });

  it("keeps the audit tables out of every step", () => {
    const touched = new Set(allSteps.map((step) => step.table));
    for (const table of [
      "admin_audit_log",
      "ops_audit",
      "admin_account_commands",
      "pgmigrations",
    ]) {
      expect(touched.has(table)).toBe(false);
    }
  });
});

describe("dev:reset-users safety locks", () => {
  it("defaults to a dry run and executes only with --yes", () => {
    const environment = { NODE_ENV: "development", DATABASE_URL: devUrl };
    const parse = (argv: string[]) =>
      parseDevResetRequest(["node", "dev-reset-users", ...argv], environment);
    expect(parse([])).toMatchObject({
      execute: false,
      databaseName: "loop_api_dev",
    });
    expect(parse(["--dry-run"]).execute).toBe(false);
    expect(parse(["--yes", "--dry-run"]).execute).toBe(false);
    expect(parse(["--yes"]).execute).toBe(true);
    expect(
      parseDevResetRequest(["node", "x", "--yes"], {
        DATABASE_URL: "postgresql://u:p@h/loop_api_test_s133",
      }).databaseName,
    ).toBe("loop_api_test_s133");
  });

  it("refuses production, foreign database names, bad URLs and unknown flags", () => {
    expect(
      refusal(["--yes"], { NODE_ENV: "production", DATABASE_URL: devUrl }),
    ).toBe("dev_reset_forbidden_in_production");
    for (const name of [
      "loop_api",
      "loop_api_staging",
      "loop_api_production",
      "postgres",
      "dev_loop_api_dev",
    ]) {
      expect(
        refusal(["--yes"], {
          DATABASE_URL: `postgres://u:p@127.0.0.1:5433/${name}`,
        }),
      ).toBe("dev_reset_database_name_refused");
    }
    expect(refusal([], {})).toBe("dev_reset_database_unconfigured");
    expect(refusal([], { DATABASE_URL: "not a url" })).toBe(
      "dev_reset_database_unconfigured",
    );
    expect(refusal([], { DATABASE_URL: "mysql://h/loop_api_dev" })).toBe(
      "dev_reset_database_unconfigured",
    );
    expect(refusal(["--force"], { DATABASE_URL: devUrl })).toBe(
      "dev_reset_arguments_invalid",
    );
    expect(refusal(["--yes", "--yes"], { DATABASE_URL: devUrl })).toBe(
      "dev_reset_arguments_invalid",
    );
  });

  it("stops before connecting when refused", async () => {
    const stdout = writer();
    const stderr = writer();
    const exitCode = await runDevResetUsers({
      argv: ["node", "dev-reset-users", "--yes"],
      environment: { NODE_ENV: "production", DATABASE_URL: devUrl },
      stdout,
      stderr,
    });
    expect(exitCode).toBe(1);
    expect(stdout.contents()).toBe("");
    expect(stderr.contents()).toBe(
      "dev:reset-users refused (dev_reset_forbidden_in_production)\n",
    );
  });
});
