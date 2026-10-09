import type { Pool, PoolClient, QueryConfig } from "pg";

/** Share one outer transaction with existing repositories. Their nested begin /
 * commit / rollback become savepoints; release never releases the outer client.
 * Only used during a single sequential ops command, never across requests. */
export function opsTransactionPool(pool: Pool, client: PoolClient): Pool {
  let depth = 0;
  const query = async (statement: string | QueryConfig, values?: unknown[]) => {
    if (typeof statement === "string") {
      const sql = statement.trim().toLowerCase();
      if (sql === "begin")
        return client.query(`savepoint ops_nested_${++depth}`);
      if (sql === "commit") {
        const level = depth--;
        return client.query(`release savepoint ops_nested_${level}`);
      }
      if (sql === "rollback") {
        const level = depth--;
        return client.query(`rollback to savepoint ops_nested_${level}`);
      }
    }
    return typeof statement === "string"
      ? client.query(statement, values)
      : client.query(statement);
  };
  const scopedClient = Object.create(client) as PoolClient;
  scopedClient.query = query as PoolClient["query"];
  scopedClient.release = () => {};
  const scopedPool = Object.create(pool) as Pool;
  scopedPool.query = query as Pool["query"];
  scopedPool.connect = (() => Promise.resolve(scopedClient)) as Pool["connect"];
  return scopedPool;
}
