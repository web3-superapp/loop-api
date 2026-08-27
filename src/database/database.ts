import pg from "pg";
import { z } from "zod";

import type {
  InternalUser,
  InternalUserRepository,
} from "../features/identity/internal-user-repository.js";
import type { PerpReconciliationRepository } from "../features/perp/perp-reconciliation-contract.js";
import type { SpotReconciliationRepository } from "../features/spot/spot-reconciliation-contract.js";
import {
  createPostgresAlertRepository,
  type AlertRepository,
} from "./alert-repository.js";
import {
  createPostgresAgentAuthorizationRepository,
  type AgentAuthorizationRepository,
} from "./agent-authorization-repository.js";
import {
  createPostgresControlPlaneRepository,
  type ControlPlaneRepository,
} from "./control-plane-repository.js";
import {
  createPostgresPerpIntentRepository,
  type PerpIntentRepository,
} from "./perp-intent-repository.js";
import { createPostgresPerpReconciliationRepository } from "./perp-reconciliation-repository.js";
import {
  createPostgresPerpWalletBindingRepository,
  type PerpWalletBindingRepository,
} from "./perp-wallet-binding-repository.js";
import {
  createPostgresProfileRepository,
  type ProfileRepository,
} from "./profile-repository.js";
import { latestMigrationName, requiredDatabaseRelations } from "./schema.js";
import {
  createPostgresSpotAgentAuthorizationRepository,
  type SpotAgentAuthorizationRepository,
} from "./spot-agent-authorization-repository.js";
import {
  createPostgresSpotIntentRepository,
  type PostgresSpotIntentRepository,
} from "./spot-intent-repository.js";
import { createPostgresSpotReconciliationRepository } from "./spot-reconciliation-repository.js";
import {
  createPostgresWatchlistRepository,
  type WatchlistRepository,
} from "./watchlist-repository.js";

const { Pool } = pg;
const privyUserIdSchema = z.string().min(1).max(255);
const internalUserRowSchema = z.object({ id: z.string().uuid() }).strict();

export interface Database {
  readonly internalUsers: InternalUserRepository;
  readonly controlPlane: ControlPlaneRepository;
  readonly perpWalletBindings: PerpWalletBindingRepository;
  readonly perpIntents: PerpIntentRepository;
  readonly agentAuthorizations: AgentAuthorizationRepository;
  readonly profiles: ProfileRepository;
  readonly watchlists: WatchlistRepository;
  readonly alerts: AlertRepository;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface PostgresDatabase extends Database {
  readonly perpReconciliation: PerpReconciliationRepository;
  readonly spotAgentAuthorizations: SpotAgentAuthorizationRepository;
  readonly spotIntents: PostgresSpotIntentRepository;
  readonly spotReconciliation: SpotReconciliationRepository;
}

export interface PostgresDatabaseConfig {
  readonly serviceName: string;
  readonly databaseUrl: string;
  readonly databasePoolMax: number;
  readonly databaseConnectionTimeoutMs: number;
  readonly databaseStatementTimeoutMs: number;
}

export interface PostgresDatabaseLogger {
  readonly error: (
    fields: Readonly<{ postgresCode: string }>,
    message: "Unexpected idle PostgreSQL client error",
  ) => void;
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
  config: PostgresDatabaseConfig,
  logger: PostgresDatabaseLogger,
): PostgresDatabase {
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
    async findByPrivyUserId(
      rawPrivyUserId: string,
    ): Promise<InternalUser | null> {
      const privyUserId = privyUserIdSchema.parse(rawPrivyUserId);
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
      return existingRow === undefined
        ? null
        : internalUserRowSchema.parse(existingRow);
    },
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

      const existingUser = await internalUsers.findByPrivyUserId(privyUserId);

      if (existingUser === null) {
        throw new Error("Internal user conflict winner was not found");
      }

      return existingUser;
    },
  };
  const controlPlane = createPostgresControlPlaneRepository(pool);
  const perpWalletBindings = createPostgresPerpWalletBindingRepository(pool);
  const perpIntents = createPostgresPerpIntentRepository(pool);
  const perpReconciliation = createPostgresPerpReconciliationRepository(pool);
  const agentAuthorizations = createPostgresAgentAuthorizationRepository(pool);
  const spotAgentAuthorizations =
    createPostgresSpotAgentAuthorizationRepository(pool);
  const spotIntents = createPostgresSpotIntentRepository(pool);
  const spotReconciliation = createPostgresSpotReconciliationRepository(
    pool,
    spotIntents,
  );
  const profiles = createPostgresProfileRepository(pool);
  const watchlists = createPostgresWatchlistRepository(pool);
  const alerts = createPostgresAlertRepository(pool);

  return {
    internalUsers,
    controlPlane,
    perpWalletBindings,
    perpIntents,
    perpReconciliation,
    agentAuthorizations,
    spotAgentAuthorizations,
    spotIntents,
    spotReconciliation,
    profiles,
    watchlists,
    alerts,
    async ping(): Promise<void> {
      const result = await pool.query<{ schema_ready: boolean }>({
        text: `
          select
            exists (
              select 1
              from public.pgmigrations
              where name = $1
            )
            and not exists (
              select 1
              from unnest($2::text[]) as required(relation_name)
              where to_regclass(required.relation_name) is null
            )
            as schema_ready
        `,
        values: [latestMigrationName, requiredDatabaseRelations],
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
