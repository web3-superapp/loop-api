import type { Pool, PoolClient, QueryResult } from "pg";
import { z } from "zod";

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const lowercaseAddressPattern = /^0x[0-9a-f]{40}$/;
const zeroAddress = `0x${"0".repeat(40)}`;
const bindingVersionPattern = /^(0|[1-9][0-9]{0,18})$/;
const maximumBindingVersion = 9_223_372_036_854_775_807n;

const uuidSchema = z.string().regex(canonicalUuidPattern);
const ownerUserIdSchema = uuidSchema;
const privyUserIdSchema = z.string().min(1).max(255);
const bindingVersionSchema = z
  .string()
  .regex(bindingVersionPattern)
  .refine((value) => {
    try {
      return BigInt(value) <= maximumBindingVersion;
    } catch {
      return false;
    }
  });
const walletIdSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value === value.trim())
  .refine((value) =>
    [...value].every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint > 31 && codePoint !== 127;
    }),
  )
  .nullable();
const accountAddressSchema = z
  .string()
  .regex(lowercaseAddressPattern)
  .refine((value) => value !== zeroAddress);
const validDateSchema = z
  .instanceof(Date)
  .refine((value) => !Number.isNaN(value.getTime()));

const ownerInputSchema = z
  .object({
    ownerUserId: ownerUserIdSchema,
    privyUserId: privyUserIdSchema,
  })
  .strict();

const putVerifiedBindingInputSchema = ownerInputSchema
  .extend({
    expectedBindingVersion: bindingVersionSchema,
    requestId: uuidSchema,
    walletId: walletIdSchema,
    accountAddress: accountAddressSchema,
    accountKind: z.literal("master"),
  })
  .strict();

const unbindInputSchema = ownerInputSchema
  .extend({
    expectedBindingVersion: bindingVersionSchema,
    requestId: uuidSchema,
  })
  .strict();

const ownerRowSchema = z
  .object({
    id: ownerUserIdSchema,
    privy_user_id: privyUserIdSchema,
  })
  .strict();

const rawBindingRowSchema = z
  .object({
    owner_user_id: ownerUserIdSchema,
    privy_user_id: privyUserIdSchema,
    binding_state: z.enum(["bound", "unbound"]),
    wallet_id: walletIdSchema,
    account_address: accountAddressSchema.nullable(),
    account_kind: z.literal("master").nullable(),
    binding_version: bindingVersionSchema,
    last_verified_at: validDateSchema.nullable(),
    created_at: validDateSchema,
    updated_at: validDateSchema,
  })
  .strict()
  .refine((row) => {
    const isBound = row.binding_state === "bound";
    return (
      isBound === (row.account_address !== null) &&
      isBound === (row.account_kind !== null) &&
      isBound === (row.last_verified_at !== null) &&
      (isBound || row.wallet_id === null) &&
      (!isBound || row.binding_version !== "0")
    );
  });

const eventReplayRowSchema = z
  .object({
    owner_user_id: ownerUserIdSchema,
    action: z.enum(["bind", "refresh", "rotate", "unbind"]),
    from_version: bindingVersionSchema,
    to_version: bindingVersionSchema,
  })
  .strict();

const bindingReturningColumns = `
  owner_user_id,
  privy_user_id,
  binding_state,
  wallet_id,
  account_address,
  account_kind,
  binding_version::text as binding_version,
  last_verified_at,
  created_at,
  updated_at
`;

interface DatabaseClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(config: {
    readonly text: string;
    readonly values?: readonly unknown[];
  }): Promise<QueryResult<Row>>;
}

export type PerpWalletBindingState = "bound" | "unbound";
export type PerpWalletBindingAccountKind = "master";

export interface PerpWalletBindingRecord {
  readonly ownerUserId: string;
  readonly privyUserId: string;
  readonly state: PerpWalletBindingState;
  readonly walletId: string | null;
  readonly accountAddress: string | null;
  readonly accountKind: PerpWalletBindingAccountKind | null;
  readonly bindingVersion: string;
  readonly lastVerifiedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PerpWalletBindingOwnerInput {
  readonly ownerUserId: string;
  readonly privyUserId: string;
}

export interface PutVerifiedPerpWalletBindingInput extends PerpWalletBindingOwnerInput {
  readonly expectedBindingVersion: string;
  readonly requestId: string;
  readonly walletId: string | null;
  readonly accountAddress: string;
  readonly accountKind: PerpWalletBindingAccountKind;
}

export interface UnbindPerpWalletBindingInput extends PerpWalletBindingOwnerInput {
  readonly expectedBindingVersion: string;
  readonly requestId: string;
}

export interface PerpWalletBindingRepository {
  get(
    input: PerpWalletBindingOwnerInput,
  ): Promise<PerpWalletBindingRecord | null>;
  putVerifiedBinding(
    input: PutVerifiedPerpWalletBindingInput,
  ): Promise<PerpWalletBindingRecord>;
  unbind(
    input: UnbindPerpWalletBindingInput,
  ): Promise<PerpWalletBindingRecord | null>;
}

export class PerpWalletBindingRepositoryVersionConflictError extends Error {
  readonly code = "perp_wallet_binding_repository_version_conflict";

  constructor() {
    super("The stored Perp wallet-binding version conflicts");
    this.name = "PerpWalletBindingRepositoryVersionConflictError";
  }
}

export class PerpWalletBindingRepositoryUnavailableError extends Error {
  readonly code = "perp_wallet_binding_repository_unavailable";

  constructor() {
    super("The Perp wallet-binding repository is unavailable");
    this.name = "PerpWalletBindingRepositoryUnavailableError";
  }
}

function failUnavailable(): never {
  throw new PerpWalletBindingRepositoryUnavailableError();
}

function parseOwnerInput(
  value: PerpWalletBindingOwnerInput,
): PerpWalletBindingOwnerInput {
  try {
    return Object.freeze(ownerInputSchema.parse(value));
  } catch {
    return failUnavailable();
  }
}

function parsePutInput(
  value: PutVerifiedPerpWalletBindingInput,
): PutVerifiedPerpWalletBindingInput {
  try {
    return Object.freeze(putVerifiedBindingInputSchema.parse(value));
  } catch {
    return failUnavailable();
  }
}

function parseUnbindInput(
  value: UnbindPerpWalletBindingInput,
): UnbindPerpWalletBindingInput {
  try {
    return Object.freeze(unbindInputSchema.parse(value));
  } catch {
    return failUnavailable();
  }
}

function toBindingRecord(value: unknown): PerpWalletBindingRecord {
  try {
    const row = rawBindingRowSchema.parse(value);
    return Object.freeze({
      ownerUserId: row.owner_user_id,
      privyUserId: row.privy_user_id,
      state: row.binding_state,
      walletId: row.wallet_id,
      accountAddress: row.account_address,
      accountKind: row.account_kind,
      bindingVersion: row.binding_version,
      lastVerifiedAt: row.last_verified_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    });
  } catch {
    return failUnavailable();
  }
}

async function assertOwnerIdentity(
  client: DatabaseClient,
  input: PerpWalletBindingOwnerInput,
  forUpdate: boolean,
): Promise<void> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select id, privy_user_id
      from public.loop_users
      where id = $1
      limit 1
      ${forUpdate ? "for update" : ""}
    `,
    values: [input.ownerUserId],
  });
  const parsed = ownerRowSchema.safeParse(result.rows[0]);
  if (
    !parsed.success ||
    parsed.data.id !== input.ownerUserId ||
    parsed.data.privy_user_id !== input.privyUserId
  ) {
    return failUnavailable();
  }
}

async function loadBinding(
  client: DatabaseClient,
  ownerUserId: string,
  forUpdate: boolean,
): Promise<PerpWalletBindingRecord | null> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select ${bindingReturningColumns}
      from public.perp_wallet_bindings
      where owner_user_id = $1
      limit 1
      ${forUpdate ? "for update" : ""}
    `,
    values: [ownerUserId],
  });
  if (result.rows.length === 0) {
    return null;
  }
  if (result.rows.length !== 1) {
    return failUnavailable();
  }
  return toBindingRecord(result.rows[0]);
}

async function loadRequestEvent(
  client: DatabaseClient,
  requestId: string,
): Promise<z.output<typeof eventReplayRowSchema> | null> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select
        owner_user_id,
        action,
        from_version::text as from_version,
        to_version::text as to_version
      from public.perp_wallet_binding_events
      where request_id = $1
      limit 1
    `,
    values: [requestId],
  });
  if (result.rows.length === 0) {
    return null;
  }
  if (result.rows.length !== 1) {
    return failUnavailable();
  }
  try {
    return eventReplayRowSchema.parse(result.rows[0]);
  } catch {
    return failUnavailable();
  }
}

function sameAuthority(
  current: PerpWalletBindingRecord,
  target: PutVerifiedPerpWalletBindingInput,
): boolean {
  return (
    current.state === "bound" &&
    current.walletId === target.walletId &&
    current.accountAddress === target.accountAddress &&
    current.accountKind === target.accountKind
  );
}

function nextBindingVersion(current: string): string {
  try {
    const next = BigInt(current) + 1n;
    if (next > maximumBindingVersion) {
      return failUnavailable();
    }
    return next.toString();
  } catch {
    return failUnavailable();
  }
}

function isExactPriorVersion(expected: string, current: string): boolean {
  try {
    return BigInt(expected) + 1n === BigInt(current);
  } catch {
    return false;
  }
}

async function insertEvent(
  client: DatabaseClient,
  input: {
    readonly ownerUserId: string;
    readonly requestId: string;
    readonly action: "bind" | "refresh" | "rotate" | "unbind";
    readonly fromVersion: string;
    readonly toVersion: string;
  },
): Promise<void> {
  const result = await client.query({
    text: `
      insert into public.perp_wallet_binding_events (
        owner_user_id,
        request_id,
        action,
        from_version,
        to_version
      )
      values ($1, $2, $3, $4::bigint, $5::bigint)
      returning id
    `,
    values: [
      input.ownerUserId,
      input.requestId,
      input.action,
      input.fromVersion,
      input.toVersion,
    ],
  });
  if (result.rows.length !== 1) {
    return failUnavailable();
  }
}

async function withTransaction<Result>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<Result>,
): Promise<Result> {
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query("begin");
    inTransaction = true;
    const result = await operation(client);
    await client.query("commit");
    inTransaction = false;
    return result;
  } catch (error) {
    if (inTransaction) {
      try {
        await client.query("rollback");
      } catch {
        // The original sanitized failure remains authoritative.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

function translateRepositoryError(error: unknown): never {
  if (
    error instanceof PerpWalletBindingRepositoryVersionConflictError ||
    error instanceof PerpWalletBindingRepositoryUnavailableError
  ) {
    throw error;
  }
  throw new PerpWalletBindingRepositoryUnavailableError();
}

function unavailable(): Promise<never> {
  return Promise.reject(new PerpWalletBindingRepositoryUnavailableError());
}

export function createUnavailablePerpWalletBindingRepository(): PerpWalletBindingRepository {
  return Object.freeze({
    get: unavailable,
    putVerifiedBinding: unavailable,
    unbind: unavailable,
  });
}

export function createPostgresPerpWalletBindingRepository(
  pool: Pool,
): PerpWalletBindingRepository {
  return Object.freeze({
    async get(
      rawInput: PerpWalletBindingOwnerInput,
    ): Promise<PerpWalletBindingRecord | null> {
      try {
        const input = parseOwnerInput(rawInput);
        await assertOwnerIdentity(pool, input, false);
        return await loadBinding(pool, input.ownerUserId, false);
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async putVerifiedBinding(
      rawInput: PutVerifiedPerpWalletBindingInput,
    ): Promise<PerpWalletBindingRecord> {
      try {
        const input = parsePutInput(rawInput);
        return await withTransaction(pool, async (client) => {
          await assertOwnerIdentity(client, input, true);
          const current = await loadBinding(client, input.ownerUserId, true);
          const replayEvent = await loadRequestEvent(client, input.requestId);

          if (replayEvent !== null) {
            if (replayEvent.owner_user_id !== input.ownerUserId) {
              return failUnavailable();
            }
            if (
              current !== null &&
              sameAuthority(current, input) &&
              replayEvent.action !== "unbind" &&
              replayEvent.to_version === current.bindingVersion
            ) {
              return current;
            }
            throw new PerpWalletBindingRepositoryVersionConflictError();
          }

          if (current === null) {
            if (input.expectedBindingVersion !== "0") {
              throw new PerpWalletBindingRepositoryVersionConflictError();
            }
            const inserted = await client.query<Record<string, unknown>>({
              text: `
                with observed as (
                  select clock_timestamp() as observed_at
                )
                insert into public.perp_wallet_bindings (
                  owner_user_id,
                  privy_user_id,
                  binding_state,
                  wallet_id,
                  account_address,
                  account_kind,
                  binding_version,
                  last_verified_at,
                  created_at,
                  updated_at
                )
                select
                  $1,
                  $2,
                  'bound',
                  $3,
                  $4,
                  $5,
                  1,
                  observed_at,
                  observed_at,
                  observed_at
                from observed
                returning ${bindingReturningColumns}
              `,
              values: [
                input.ownerUserId,
                input.privyUserId,
                input.walletId,
                input.accountAddress,
                input.accountKind,
              ],
            });
            const row = inserted.rows[0];
            if (row === undefined || inserted.rows.length !== 1) {
              return failUnavailable();
            }
            const created = toBindingRecord(row);
            await insertEvent(client, {
              ownerUserId: input.ownerUserId,
              requestId: input.requestId,
              action: "bind",
              fromVersion: "0",
              toVersion: created.bindingVersion,
            });
            return created;
          }

          const isRefresh = sameAuthority(current, input);
          if (
            isRefresh &&
            input.expectedBindingVersion !== current.bindingVersion
          ) {
            if (
              isExactPriorVersion(
                input.expectedBindingVersion,
                current.bindingVersion,
              )
            ) {
              return current;
            }
            throw new PerpWalletBindingRepositoryVersionConflictError();
          }
          if (
            !isRefresh &&
            input.expectedBindingVersion !== current.bindingVersion
          ) {
            throw new PerpWalletBindingRepositoryVersionConflictError();
          }
          const toVersion = isRefresh
            ? current.bindingVersion
            : nextBindingVersion(current.bindingVersion);
          const action = isRefresh
            ? "refresh"
            : current.state === "bound"
              ? "rotate"
              : "bind";
          const updated = await client.query<Record<string, unknown>>({
            text: `
              with observed as (
                select clock_timestamp() as observed_at
              )
              update public.perp_wallet_bindings
              set
                binding_state = 'bound',
                wallet_id = $2,
                account_address = $3,
                account_kind = $4,
                binding_version = $5::bigint,
                last_verified_at = observed.observed_at,
                updated_at = observed.observed_at
              from observed
              where owner_user_id = $1
                and binding_version = $6::bigint
              returning ${bindingReturningColumns}
            `,
            values: [
              input.ownerUserId,
              input.walletId,
              input.accountAddress,
              input.accountKind,
              toVersion,
              current.bindingVersion,
            ],
          });
          const row = updated.rows[0];
          if (row === undefined || updated.rows.length !== 1) {
            return failUnavailable();
          }
          const result = toBindingRecord(row);
          await insertEvent(client, {
            ownerUserId: input.ownerUserId,
            requestId: input.requestId,
            action,
            fromVersion: current.bindingVersion,
            toVersion: result.bindingVersion,
          });
          return result;
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },

    async unbind(
      rawInput: UnbindPerpWalletBindingInput,
    ): Promise<PerpWalletBindingRecord | null> {
      try {
        const input = parseUnbindInput(rawInput);
        return await withTransaction(pool, async (client) => {
          await assertOwnerIdentity(client, input, true);
          const current = await loadBinding(client, input.ownerUserId, true);
          const replayEvent = await loadRequestEvent(client, input.requestId);

          if (replayEvent !== null) {
            if (replayEvent.owner_user_id !== input.ownerUserId) {
              return failUnavailable();
            }
            if (
              current !== null &&
              current.state === "unbound" &&
              replayEvent.action === "unbind" &&
              replayEvent.to_version === current.bindingVersion
            ) {
              return current;
            }
            throw new PerpWalletBindingRepositoryVersionConflictError();
          }

          if (current === null) {
            if (input.expectedBindingVersion !== "0") {
              throw new PerpWalletBindingRepositoryVersionConflictError();
            }
            return null;
          }
          if (current.state === "unbound") {
            if (
              input.expectedBindingVersion === current.bindingVersion ||
              isExactPriorVersion(
                input.expectedBindingVersion,
                current.bindingVersion,
              )
            ) {
              return current;
            }
            throw new PerpWalletBindingRepositoryVersionConflictError();
          }
          if (input.expectedBindingVersion !== current.bindingVersion) {
            throw new PerpWalletBindingRepositoryVersionConflictError();
          }

          const toVersion = nextBindingVersion(current.bindingVersion);
          const updated = await client.query<Record<string, unknown>>({
            text: `
              with observed as (
                select clock_timestamp() as observed_at
              )
              update public.perp_wallet_bindings
              set
                binding_state = 'unbound',
                wallet_id = null,
                account_address = null,
                account_kind = null,
                binding_version = $2::bigint,
                last_verified_at = null,
                updated_at = observed.observed_at
              from observed
              where owner_user_id = $1
                and binding_version = $3::bigint
              returning ${bindingReturningColumns}
            `,
            values: [input.ownerUserId, toVersion, current.bindingVersion],
          });
          const row = updated.rows[0];
          if (row === undefined || updated.rows.length !== 1) {
            return failUnavailable();
          }
          const result = toBindingRecord(row);
          await insertEvent(client, {
            ownerUserId: input.ownerUserId,
            requestId: input.requestId,
            action: "unbind",
            fromVersion: current.bindingVersion,
            toVersion: result.bindingVersion,
          });
          return result;
        });
      } catch (error) {
        return translateRepositoryError(error);
      }
    },
  });
}
