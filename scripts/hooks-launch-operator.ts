import { pathToFileURL } from "node:url";
import pg from "pg";
import { z } from "zod";
import { provisionHooksLaunchOperator } from "../src/database/hooks-launch-review-repository.js";
import {
  hooksLaunchOpsPermissions,
  hooksLaunchProjectScopedPermissions,
} from "../src/features/launch/hooks-launch-review.js";

/**
 * Decision 0108 (ported from requirer branch `scripts/ops-operator.ts`):
 * deployment-admin bootstrap of individual Hooks review operators. Never
 * exposed through HTTP or a console. Development / Testnet only.
 *
 *   pnpm hooks:operator --user <loop user id> --label <name> \
 *     --permissions launch.read,launch.approve [--scope <projectId>] --confirm
 *   pnpm hooks:operator --user <loop user id> --revoke --confirm
 */
export function parseOperatorArgs(args: readonly string[]) {
  const pairs: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === "--confirm" || key === "--revoke") {
      if (pairs[key]) throw new Error("duplicate option");
      pairs[key] = "true";
      continue;
    }
    if (
      !key ||
      !["--user", "--label", "--permissions", "--scope"].includes(key) ||
      !args[index + 1] ||
      pairs[key]
    )
      throw new Error("invalid arguments");
    pairs[key] = args[++index]!;
  }
  if (pairs["--confirm"] !== "true") throw new Error("--confirm is required");
  const userId = z.uuid().parse(pairs["--user"]);
  if (pairs["--revoke"] === "true") return { userId, revoke: true as const };
  const label = z.string().trim().min(1).max(80).parse(pairs["--label"]);
  const permissions = z
    .array(z.enum(hooksLaunchOpsPermissions))
    .min(1)
    .parse(pairs["--permissions"]?.split(","));
  const scope = pairs["--scope"] ?? "*";
  if (scope !== "*") {
    z.uuid().parse(scope);
    if (
      permissions.some(
        (permission) => !hooksLaunchProjectScopedPermissions.has(permission),
      )
    )
      throw new Error("scopes apply only to project permissions");
  }
  return {
    userId,
    revoke: false as const,
    label,
    permissions: [...new Set(permissions)],
    scope,
  };
}
export async function runOperator(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) {
  if (env["NODE_ENV"] === "production") throw new Error("Development only");
  const input = parseOperatorArgs(args);
  const url = z.string().min(1).parse(env["DATABASE_URL"]);
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    // Decision 0109: the shared bootstrap (also used by the console account
    // service) locks the LOOP user row, captures before/after grant state,
    // and appends the deployment_cli audit row in this transaction.
    await provisionHooksLaunchOperator(
      client,
      input.revoke
        ? { userId: input.userId, revoke: true }
        : {
            userId: input.userId,
            revoke: false,
            label: input.label,
            grants: input.permissions.map((permission) => ({
              permission,
              scope: input.scope,
            })),
          },
      { kind: "deployment_cli" },
      input.revoke ? "部署管理员撤销运营授权" : "部署管理员配置运营授权",
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runOperator(process.argv.slice(2), process.env).then(
    () => {
      process.stdout.write("Operator authorization updated.\n");
    },
    () => {
      process.stderr.write(
        "Operator update failed. Check arguments, user existence and database configuration.\n",
      );
      process.exitCode = 1;
    },
  );
}
