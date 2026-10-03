import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { z } from "zod";
import { opsPermissions } from "../src/features/ops/ops-contract.js";

/** Deployment-admin bootstrap only. Never exposed through HTTP or the Web UI. */
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
    .array(z.enum(opsPermissions))
    .min(1)
    .parse(pairs["--permissions"]?.split(","));
  const scope = pairs["--scope"] ?? "*";
  if (scope !== "*") {
    z.uuid().parse(scope);
    if (permissions.some((p) => p !== "community.review"))
      throw new Error("scopes apply only to community.review");
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
    // Lock a stable parent row: this also serializes first-time grants when no
    // ops_operators row exists yet. NO KEY UPDATE also permits an already
    // authorized API transaction to finish its actor FK check while this CLI
    // waits for that transaction's operator lock, avoiding a lock cycle.
    // Capture both states inside the same lock.
    const target = await client.query(
      "select id from public.loop_users where id=$1 for no key update",
      [input.userId],
    );
    if (target.rowCount !== 1) throw new Error("unknown target user");
    const readState = async () => {
      const operator = await client.query<{ enabled: boolean }>(
        "select enabled from public.ops_operators where user_id=$1",
        [input.userId],
      );
      const grants = await client.query<{ permission: string; scope: string }>(
        "select permission,scope from public.ops_grants where user_id=$1 order by permission,scope",
        [input.userId],
      );
      return {
        enabled: operator.rows[0]?.enabled ?? null,
        grants: grants.rows,
      };
    };
    const before = await readState();
    if (input.revoke) {
      await client.query(
        "update public.ops_operators set enabled=false,updated_at=clock_timestamp() where user_id=$1",
        [input.userId],
      );
    } else {
      await client.query(
        "insert into public.ops_operators(user_id,label,enabled) values($1,$2,true) on conflict(user_id) do update set label=excluded.label,enabled=true,updated_at=clock_timestamp()",
        [input.userId, input.label],
      );
      await client.query("delete from public.ops_grants where user_id=$1", [
        input.userId,
      ]);
      for (const permission of input.permissions)
        await client.query(
          "insert into public.ops_grants(user_id,permission,scope) values($1,$2,$3)",
          [input.userId, permission, input.scope],
        );
    }
    await client.query(
      "insert into public.ops_audit(operation_id,actor_id,actor_kind,source,action,target,reason,outcome,before_state,after_state) values($1,null,'deployment_admin','deployment_cli','operator.bootstrap',$2::uuid::text,$3,'succeeded',$4::jsonb,$5::jsonb)",
      [
        randomUUID(),
        input.userId,
        input.revoke ? "部署管理员撤销运营授权" : "部署管理员配置运营授权",
        JSON.stringify(before),
        JSON.stringify(await readState()),
      ],
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
