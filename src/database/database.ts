import type { FastifyBaseLogger } from "fastify";
import pg from "pg";
import { z } from "zod";

import type { AppConfig } from "../config.js";
import type {
  InternalUser,
  InternalUserRepository,
} from "../features/identity/internal-user-repository.js";

const { Pool } = pg;
const requiredMigration = "000001_create_internal_users";
const privyUserIdSchema = z.string().min(1).max(255);
const internalUserRowSchema = z.object({ id: z.string().uuid() }).strict();

export interface Database {
  readonly internalUsers: InternalUserRepository;
  ping(): Promise<void>;
  close(): Promise<void>;
}

function safePostgresErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }

  return "unknown";
}

export function createPostgresDatabase(
  config: AppConfig,
  logger: FastifyBaseLogger,
): Database {
  const pool = new Pool({
    application_name: config.serviceName,
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
    max: config.databasePoolMax,
    statement_timeout: config.databaseStatementTimeoutMs,
  });

  pool.on("error", (error: unknown) => {
    logger.error(
      { postgresCode: safePostgresErrorCode(error) },
      "Unexpected idle PostgreSQL client error",
    );
  });

  const internalUsers: InternalUserRepository = {
    async getOrCreateByPrivyUserId(
      rawPrivyUserId: string,
    ): Promise<InternalUser> {
      const privyUserId = privyUserIdSchema.parse(rawPrivyUserId);
      const inserted = await pool.query<{ id: string }>({
        text: `
          insert into public.loop_users (privy_user_id)
          values ($1)
          on conflict (privy_user_id) do nothing
          returning id
        `,
        values: [privyUserId],
      });
      const insertedRow = inserted.rows[0];

      if (insertedRow !== undefined) {
        return internalUserRowSchema.parse(insertedRow);
      }

      const existing = await pool.query<{ id: string }>({
        text: `
          select id
          from public.loop_users
          where privy_user_id = $1
          limit 1
        `,
        values: [privyUserId],
      });
      const existingRow = existing.rows[0];

      if (existingRow === undefined) {
        throw new Error("Internal user conflict winner was not found");
      }

      return internalUserRowSchema.parse(existingRow);
    },
  };

  return {
    internalUsers,
    async ping(): Promise<void> {
      const result = await pool.query<{ schema_ready: boolean }>({
        text: `
          select
            exists (
              select 1
              from public.pgmigrations
              where name = $1
            )
            and to_regclass('public.loop_users') is not null
            as schema_ready
        `,
        values: [requiredMigration],
      });

      if (result.rows[0]?.schema_ready !== true) {
        throw new Error("Required database migration is not applied");
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
