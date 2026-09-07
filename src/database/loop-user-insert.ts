import type { PoolClient } from "pg";
import { z } from "zod";

import { allocateLoopId } from "../features/identity/loop-id.js";

const privyUserIdSchema = z.string().min(1).max(255);
const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const loopUserRowSchema = z
  .object({ id: z.string().regex(canonicalUuidPattern) })
  .strict();
const loopIdUniqueConstraint = "loop_users_loop_id_unique";
const uniqueViolationCode = "23505";
const savepointName = "loop_user_insert";

export interface InsertedLoopUser {
  readonly id: string;
}

export interface GetOrCreateLoopUserOptions {
  readonly generateLoopId?: () => string;
}

function isLoopIdUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === uniqueViolationCode &&
    "constraint" in error &&
    error.constraint === loopIdUniqueConstraint
  );
}

async function findLoopUser(
  client: PoolClient,
  privyUserId: string,
): Promise<InsertedLoopUser | null> {
  const existing = await client.query<Record<string, unknown>>({
    text: `
      select id
      from public.loop_users
      where privy_user_id = $1
      limit 1
    `,
    values: [privyUserId],
  });
  const row = existing.rows[0];
  return row === undefined ? null : Object.freeze(loopUserRowSchema.parse(row));
}

/**
 * Get or create the LOOP account for a verified Privy subject inside an open
 * transaction. A new account receives a freshly generated LOOP ID; a unique
 * violation on the LOOP ID rolls back to a savepoint and retries with a new
 * candidate (bounded by `maximumLoopIdAllocationAttempts`). The Privy subject
 * conflict path never allocates a second account.
 */
export async function getOrCreateLoopUserInTransaction(
  client: PoolClient,
  rawPrivyUserId: string,
  options: GetOrCreateLoopUserOptions = {},
): Promise<InsertedLoopUser> {
  const privyUserId = privyUserIdSchema.parse(rawPrivyUserId);
  const existingBeforeInsert = await findLoopUser(client, privyUserId);
  if (existingBeforeInsert !== null) {
    return existingBeforeInsert;
  }

  return allocateLoopId<InsertedLoopUser>({
    ...(options.generateLoopId === undefined
      ? {}
      : { generate: options.generateLoopId }),
    async attempt(candidate) {
      await client.query(`savepoint ${savepointName}`);
      try {
        const inserted = await client.query<Record<string, unknown>>({
          text: `
            insert into public.loop_users (privy_user_id, loop_id)
            values ($1, $2)
            on conflict (privy_user_id) do nothing
            returning id
          `,
          values: [privyUserId, candidate],
        });
        await client.query(`release savepoint ${savepointName}`);
        const insertedRow = inserted.rows[0];
        if (insertedRow !== undefined) {
          return {
            status: "allocated",
            value: Object.freeze(loopUserRowSchema.parse(insertedRow)),
          };
        }
        const winner = await findLoopUser(client, privyUserId);
        if (winner === null) {
          throw new Error("Internal user conflict winner was not found");
        }
        return { status: "allocated", value: winner };
      } catch (error) {
        if (isLoopIdUniqueViolation(error)) {
          await client.query(`rollback to savepoint ${savepointName}`);
          return { status: "conflict" };
        }
        throw error;
      }
    },
  });
}
