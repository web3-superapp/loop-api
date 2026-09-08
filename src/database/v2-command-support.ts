import type { Pool, PoolClient, QueryResult } from "pg";

/**
 * Shared PostgreSQL command support for the S7 repositories (launch, mining,
 * referral). It mirrors the community repository's transaction, owner lock,
 * and durable idempotency claim so the new modules cannot drift from the
 * established idempotency semantics (Decision 0031).
 */

export interface DatabaseClient {
  query<Row extends Record<string, unknown>>(input: {
    readonly text: string;
    readonly values?: readonly unknown[];
  }): Promise<QueryResult<Row>>;
}

const uniqueViolation = "23505";

export function isUniqueViolation(
  error: unknown,
  constraint?: string,
): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const record = error as { code?: unknown; constraint?: unknown };
  return (
    record.code === uniqueViolation &&
    (constraint === undefined || record.constraint === constraint)
  );
}

export async function withV2Transaction<T>(
  pool: Pool,
  unavailableError: () => Error,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const value = await operation(client);
    await client.query("commit");
    return value;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      throw unavailableError();
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function lockV2Owner(
  client: DatabaseClient,
  ownerUserId: string,
  unavailableError: () => Error,
): Promise<void> {
  const result = await client.query<{ id: string }>({
    text: `select id from public.loop_users where id = $1 for update`,
    values: [ownerUserId],
  });
  if (result.rows[0]?.id !== ownerUserId) {
    throw unavailableError();
  }
}

/**
 * Claim the durable idempotency record. The same key with a different owner
 * or canonical digest returns no row (an idempotency conflict); an identical
 * replay returns the same record ID so the caller can find the original
 * audit row and answer with the current resource.
 */
export async function claimV2Command(
  client: DatabaseClient,
  input: {
    readonly ownerUserId: string;
    readonly scope: string;
    readonly digestVersion: string;
    readonly idempotencyKey: string;
    readonly requestSha256: string;
  },
  conflictError: () => Error,
): Promise<string> {
  const claimed = await client.query<{ id: string }>({
    text: `
      insert into public.idempotency_records (
        owner_user_id,
        scope,
        idempotency_key,
        key_source,
        request_sha256,
        digest_version
      )
      values ($1, $2, $3, 'client', $4, $5)
      on conflict (scope, idempotency_key)
      do update set last_seen_at = clock_timestamp()
      where idempotency_records.owner_user_id = excluded.owner_user_id
        and idempotency_records.key_source = excluded.key_source
        and idempotency_records.request_sha256 = excluded.request_sha256
        and idempotency_records.digest_version = excluded.digest_version
      returning id
    `,
    values: [
      input.ownerUserId,
      input.scope,
      input.idempotencyKey,
      input.requestSha256,
      input.digestVersion,
    ],
  });
  const id = claimed.rows[0]?.id;
  if (id === undefined) {
    throw conflictError();
  }
  return id;
}

export function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export function toNullableIsoString(
  value: Date | string | null,
): string | null {
  return value === null ? null : toIsoString(value);
}
