import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import {
  accountSettingsFixedValues,
  AccountSettingsRepositoryUnavailableError,
  AccountSettingsVersionConflictError,
  defaultAccountSettingsRecord,
  type AccountSettingsRecord,
  type AccountSettingsRepository,
} from "../features/settings/account-settings-repository.js";

const uuidSchema = z.string().uuid();
const maximumRecordVersion = 2_147_483_647;
const dateSchema = z
  .instanceof(Date)
  .refine((value) => !Number.isNaN(value.getTime()));
const rowSchema = z
  .object({
    display_currency: z.literal(accountSettingsFixedValues.displayCurrency),
    language: z.literal(accountSettingsFixedValues.language),
    record_version: z.number().int().min(1).max(maximumRecordVersion),
    updated_at: dateSchema,
  })
  .strict();
const replaceInputSchema = z
  .object({
    ownerUserId: uuidSchema,
    expectedVersion: z.number().int().min(0).max(maximumRecordVersion),
    settings: z
      .object({
        displayCurrency: z.literal(accountSettingsFixedValues.displayCurrency),
        language: z.literal(accountSettingsFixedValues.language),
      })
      .strict(),
  })
  .strict();

const columns = "display_currency, language, record_version, updated_at";

function mapRow(raw: unknown): AccountSettingsRecord {
  const row = rowSchema.parse(raw);
  return Object.freeze({
    version: row.record_version,
    updatedAt: row.updated_at.toISOString(),
    settings: Object.freeze({
      displayCurrency: row.display_currency,
      language: row.language,
    }),
  });
}

function translate(error: unknown): never {
  if (
    error instanceof AccountSettingsVersionConflictError ||
    error instanceof AccountSettingsRepositoryUnavailableError
  ) {
    throw error;
  }
  throw new AccountSettingsRepositoryUnavailableError();
}

async function readCurrent(
  client: Pick<PoolClient, "query">,
  ownerUserId: string,
  forUpdate: boolean,
): Promise<AccountSettingsRecord> {
  const result = await client.query<Record<string, unknown>>({
    text: `
      select ${columns}
      from public.account_settings
      where owner_user_id = $1
      ${forUpdate ? "for update" : ""}
    `,
    values: [ownerUserId],
  });
  const row = result.rows[0];
  return row === undefined ? defaultAccountSettingsRecord : mapRow(row);
}

export function createPostgresAccountSettingsRepository(
  pool: Pool,
): AccountSettingsRepository {
  const repository: AccountSettingsRepository = {
    async get(rawOwnerUserId) {
      try {
        return await readCurrent(pool, uuidSchema.parse(rawOwnerUserId), false);
      } catch (error) {
        return translate(error);
      }
    },

    async replace(rawInput) {
      const input = replaceInputSchema.parse(rawInput);
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query({
          text: `
            select pg_advisory_xact_lock(
              hashtextextended('loop:v2:account-settings:' || $1, 0)
            )
          `,
          values: [input.ownerUserId],
        });
        const current = await readCurrent(client, input.ownerUserId, true);
        let committed: AccountSettingsRecord;
        if (input.expectedVersion === current.version) {
          const result = await client.query<Record<string, unknown>>({
            text: `
              insert into public.account_settings (
                owner_user_id, display_currency, language
              )
              values ($1, $2, $3)
              on conflict (owner_user_id) do update
              set
                display_currency = excluded.display_currency,
                language = excluded.language,
                record_version = public.account_settings.record_version + 1,
                updated_at = clock_timestamp()
              where public.account_settings.record_version = $4
              returning ${columns}
            `,
            values: [
              input.ownerUserId,
              input.settings.displayCurrency,
              input.settings.language,
              input.expectedVersion,
            ],
          });
          const row = result.rows[0];
          if (row === undefined) {
            throw new AccountSettingsVersionConflictError();
          }
          committed = mapRow(row);
        } else if (
          current.version > 0 &&
          input.expectedVersion === current.version - 1
        ) {
          // Identical content is guaranteed by the fixed-value schema, so the
          // version immediately before the committed one is the lost-response
          // retry of the write that produced it.
          committed = current;
        } else {
          throw new AccountSettingsVersionConflictError();
        }
        await client.query("commit");
        return committed;
      } catch (error) {
        await client.query("rollback");
        return translate(error);
      } finally {
        client.release();
      }
    },
  };
  return Object.freeze(repository);
}
