import type { Pool } from "pg";

import {
  TestnetFaucetIdempotencyConflictError,
  TestnetFaucetRepositoryUnavailableError,
  testnetFaucetGrantStatuses,
  type TestnetFaucetGrantRecord,
  type TestnetFaucetGrantStatus,
  type TestnetFaucetRepository,
} from "../features/testnet-faucet/testnet-faucet-contract.js";
import {
  claimV2Command,
  lockV2Owner,
  toIsoString,
  toNullableIsoString,
  withV2Transaction,
} from "./v2-command-support.js";

/**
 * Decision 0128: PostgreSQL side of the testnet faucet. The reservation
 * (owner lock, idempotency claim, address advisory lock, cooldown re-check,
 * `pending` insert) is one transaction; the two hashes and the final status
 * are written as the operator account signs. Nothing here signs or reads a
 * chain.
 */

type Row = Record<string, unknown>;

const scope = "testnet_faucet_grant";
const digestVersion = "testnet_faucet_grant_v1";

const columns = `grant_id, owner_user_id, wallet_id, address, bnb_amount,
  bnb_amount_raw::text as bnb_amount_raw, usd1_amount,
  usd1_amount_raw::text as usd1_amount_raw, status, bnb_tx, usd1_tx,
  failure_reason_code, granted_at, completed_at`;

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new TestnetFaucetRepositoryUnavailableError();
  }
  return value;
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : text(row, key);
}

function timestamp(row: Row, key: string): string {
  const value = row[key];
  if (!(value instanceof Date) && typeof value !== "string") {
    throw new TestnetFaucetRepositoryUnavailableError();
  }
  return toIsoString(value);
}

function status(row: Row): TestnetFaucetGrantStatus {
  const value = text(row, "status");
  if (!(testnetFaucetGrantStatuses as readonly string[]).includes(value)) {
    throw new TestnetFaucetRepositoryUnavailableError();
  }
  return value as TestnetFaucetGrantStatus;
}

function mapGrant(row: Row): TestnetFaucetGrantRecord {
  const completed = row["completed_at"];
  return Object.freeze({
    grantId: text(row, "grant_id"),
    ownerUserId: text(row, "owner_user_id"),
    walletId: text(row, "wallet_id"),
    address: text(row, "address"),
    bnbAmount: text(row, "bnb_amount"),
    bnbAmountRaw: text(row, "bnb_amount_raw"),
    usd1Amount: text(row, "usd1_amount"),
    usd1AmountRaw: text(row, "usd1_amount_raw"),
    status: status(row),
    bnbTransactionHash: nullableText(row, "bnb_tx"),
    usd1TransactionHash: nullableText(row, "usd1_tx"),
    failureReasonCode: nullableText(row, "failure_reason_code"),
    grantedAt: timestamp(row, "granted_at"),
    completedAt:
      completed instanceof Date || typeof completed === "string"
        ? toNullableIsoString(completed)
        : null,
  });
}

const unavailable = (): Error => new TestnetFaucetRepositoryUnavailableError();

class CooldownSignal extends Error {
  constructor(readonly blocking: TestnetFaucetGrantRecord) {
    super("cooldown");
  }
}

export function createPostgresTestnetFaucetRepository(
  pool: Pool,
): TestnetFaucetRepository {
  async function query(text: string, values: readonly unknown[]) {
    try {
      return (await pool.query<Row>({ text, values: [...values] })).rows;
    } catch {
      throw unavailable();
    }
  }

  const repository: TestnetFaucetRepository = {
    async latestBlockingGrant(address, since) {
      const rows = await query(
        `select ${columns} from public.testnet_faucet_grants
         where address = $1 and status <> 'failed' and granted_at > $2::timestamptz
         order by granted_at desc, grant_id desc limit 1`,
        [address, since.toISOString()],
      );
      return rows[0] === undefined ? null : mapGrant(rows[0]);
    },

    async latestSentGrant(address) {
      const rows = await query(
        `select ${columns} from public.testnet_faucet_grants
         where address = $1 and status in ('granted', 'partial', 'unknown')
         order by granted_at desc, grant_id desc limit 1`,
        [address],
      );
      return rows[0] === undefined ? null : mapGrant(rows[0]);
    },

    async findReplay(input) {
      const records = await query(
        `select id, owner_user_id, request_sha256, digest_version, key_source
         from public.idempotency_records
         where scope = $1 and idempotency_key = $2`,
        [scope, input.idempotencyKey],
      );
      const record = records[0];
      if (record === undefined) {
        return { kind: "none" as const };
      }
      if (
        record["owner_user_id"] !== input.ownerUserId ||
        record["request_sha256"] !== input.requestSha256 ||
        record["digest_version"] !== digestVersion ||
        record["key_source"] !== "client"
      ) {
        return { kind: "conflict" as const };
      }
      const grants = await query(
        `select ${columns} from public.testnet_faucet_grants
         where idempotency_record_id = $1`,
        [record["id"]],
      );
      return grants[0] === undefined
        ? { kind: "none" as const }
        : { kind: "grant" as const, grant: mapGrant(grants[0]) };
    },

    async reserve(input) {
      try {
        return await withV2Transaction(pool, unavailable, async (client) => {
          await lockV2Owner(client, input.ownerUserId, unavailable);
          const recordId = await claimV2Command(
            client,
            {
              ownerUserId: input.ownerUserId,
              scope,
              digestVersion,
              idempotencyKey: input.idempotencyKey,
              requestSha256: input.requestSha256,
            },
            () => new TestnetFaucetIdempotencyConflictError(),
          );
          const existing = await client.query<Row>({
            text: `select ${columns} from public.testnet_faucet_grants
                   where idempotency_record_id = $1`,
            values: [recordId],
          });
          if (existing.rows[0] !== undefined) {
            return {
              kind: "replay" as const,
              grant: mapGrant(existing.rows[0]),
            };
          }
          await client.query({
            text: `select pg_advisory_xact_lock(hashtextextended($1, 0))`,
            values: [`testnet_faucet:${input.address}`],
          });
          const since = new Date(
            input.now.getTime() - input.cooldownSeconds * 1_000,
          );
          const blocking = await client.query<Row>({
            text: `select ${columns} from public.testnet_faucet_grants
                   where address = $1 and status <> 'failed'
                     and granted_at > $2::timestamptz
                   order by granted_at desc, grant_id desc limit 1`,
            values: [input.address, since.toISOString()],
          });
          if (blocking.rows[0] !== undefined) {
            // Thrown so the idempotency claim rolls back: nothing is kept.
            throw new CooldownSignal(mapGrant(blocking.rows[0]));
          }
          const inserted = await client.query<Row>({
            text: `
              insert into public.testnet_faucet_grants (
                grant_id, owner_user_id, idempotency_record_id, wallet_id,
                address, chain_id, bnb_amount, bnb_amount_raw, usd1_amount,
                usd1_amount_raw, usd1_token_address, operator_address,
                granted_at, updated_at
              ) values ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9,
                $10::numeric, $11, $12, $13::timestamptz, $13::timestamptz)
              returning ${columns}
            `,
            values: [
              input.grantId,
              input.ownerUserId,
              recordId,
              input.walletId,
              input.address,
              input.chainId,
              input.bnbAmount,
              input.bnbAmountRaw,
              input.usd1Amount,
              input.usd1AmountRaw,
              input.usd1TokenAddress,
              input.operatorAddress,
              input.now.toISOString(),
            ],
          });
          return {
            kind: "reserved" as const,
            grant: mapGrant(inserted.rows[0] as Row),
          };
        });
      } catch (error) {
        if (error instanceof CooldownSignal) {
          return { kind: "cooldown" as const, blocking: error.blocking };
        }
        if (error instanceof TestnetFaucetIdempotencyConflictError) {
          throw error;
        }
        throw unavailable();
      }
    },

    async recordTransactionHash(input) {
      const column = input.leg === "bnb" ? "bnb_tx" : "usd1_tx";
      await query(
        `update public.testnet_faucet_grants
         set ${column} = $2, updated_at = greatest(clock_timestamp(), granted_at)
         where grant_id = $1 and status = 'pending'`,
        [input.grantId, input.transactionHash],
      );
    },

    async finalize(input) {
      const rows = await query(
        `update public.testnet_faucet_grants
         set status = $2, bnb_tx = $3, usd1_tx = $4, failure_reason_code = $5,
           completed_at = greatest($6::timestamptz, granted_at),
           updated_at = greatest($6::timestamptz, granted_at)
         where grant_id = $1 and status = 'pending'
         returning ${columns}`,
        [
          input.grantId,
          input.status,
          input.bnbTransactionHash,
          input.usd1TransactionHash,
          input.failureReasonCode,
          input.now.toISOString(),
        ],
      );
      if (rows[0] === undefined) {
        throw unavailable();
      }
      return mapGrant(rows[0]);
    },
  };
  return Object.freeze(repository);
}

export function createUnavailableTestnetFaucetRepository(): TestnetFaucetRepository {
  const reject = (): Promise<never> =>
    Promise.reject(new TestnetFaucetRepositoryUnavailableError());
  return Object.freeze({
    latestBlockingGrant: reject,
    latestSentGrant: reject,
    findReplay: reject,
    reserve: reject,
    recordTransactionHash: reject,
    finalize: reject,
  });
}
