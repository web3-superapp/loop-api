import { createPostgresHooksLaunchExecutorRepository } from "./hooks-launch-executor-repository.js";
import type { HooksLaunchExecutorRepository } from "../features/launch/hooks-launch-executor.js";
import pg from "pg";
import { z } from "zod";

import type { LaunchChainId } from "../features/chain/chain-contract.js";

import type {
  InternalUser,
  InternalUserRepository,
} from "../features/identity/internal-user-repository.js";
import type { DeviceSessionRepository } from "../features/session/device-session-repository.js";
import type { ChatChannelRepository } from "../features/communication/chat-channel-repository.js";
import type { PerpReconciliationRepository } from "../features/perp/perp-reconciliation-contract.js";
import type { SpotReconciliationRepository } from "../features/spot/spot-reconciliation-contract.js";
import type { CommunityAiRepository } from "../features/community-ai/community-ai-repository.js";
import type { CommunityRepository } from "../features/community/community-repository.js";
import {
  createPostgresAccountWalletRepository,
  type AccountWalletRepository,
} from "./account-wallet-repository.js";
import {
  createPostgresBscIndexerRepository,
  createPostgresBscIndexerWalletSetRepository,
  type BscIndexerRepository,
  type BscIndexerWalletSetRepository,
} from "./bsc-indexer-repository.js";
import {
  createPostgresChainRegistryRepository,
  type ChainRegistryRepository,
} from "./chain-registry-repository.js";
import {
  createPostgresWatchlistV2Repository,
  type WatchlistV2Repository,
} from "./watchlist-v2-repository.js";
import {
  createPostgresMarketFactCacheRepository,
  type MarketFactCacheRepository,
} from "./market-fact-cache-repository.js";
import {
  createPostgresMarketCategoryRepository,
  type MarketCategoryRepository,
} from "./market-category-repository.js";
import {
  createPostgresTokenLogoCacheRepository,
  type TokenLogoCacheRepository,
} from "./token-logo-cache-repository.js";
import {
  createPostgresAlertV2Repository,
  type AlertV2Repository,
} from "./alert-v2-repository.js";
import {
  createPostgresNotificationRepository,
  type NotificationRepository,
} from "./notification-repository.js";
import { createPostgresPushRepository } from "./push-repository.js";
import { createPostgresMediaRepository } from "./media-repository.js";
import { createPostgresMemeRepository } from "./meme-repository.js";
import { createPostgresLaunch2Repository } from "./launch2-repository.js";
import { createPostgresLaunch2PublicationRepository } from "./launch2-snapshot-publication-repository.js";
import { createPostgresAdminRepository } from "./admin-repository.js";
import { createPostgresAdminAccountRepository } from "./admin-account-repository.js";
import { createPostgresAdminLoginAttemptStore } from "./admin-login-attempt-repository.js";
import { createPostgresAdminLaunchReviewRepository } from "./admin-launch-repository.js";
import type { AdminAccountRepository } from "../features/admin/admin-accounts.js";
import type { AdminLaunchReviewRepository } from "../features/admin/admin-launch-review.js";
import type { AdminRepository } from "../features/admin/admin-repository.js";
import type { MemeRepository } from "../features/meme/meme-repository.js";
import type { Launch2Repository } from "../features/launch2/launch2-ports.js";
import type { Launch2PublicationRepository } from "../features/launch2/launch2-snapshot-publisher.js";
import { createPostgresPublicProfileRepository } from "./public-profile-repository.js";
import { createPostgresStreamUserIdentityRepository } from "./stream-user-identity-repository.js";
import type { MediaStorage } from "../features/media/media-storage.js";
import type { PublicProfileRepository } from "../features/profile/public-profile-repository.js";
import type { StreamUserIdentityRepository } from "../features/communication/stream-user-identity.js";
import type { PushRepository } from "../features/push/push-repository.js";
import {
  createPostgresWalletIntentRepository,
  type WalletIntentRepository,
} from "./wallet-intent-repository.js";
import { createPostgresAccountSettingsRepository } from "./account-settings-repository.js";
import { createPostgresSupportTicketRepository } from "./support-ticket-repository.js";
import type { AccountSettingsRepository } from "../features/settings/account-settings-repository.js";
import type { SupportTicketRepository } from "../features/support/support-ticket-repository.js";
import { createPostgresLaunchRepository } from "./launch-repository.js";
import { createPostgresHooksLaunchProjectConfigRepository } from "./hooks-launch-project-config-repository.js";
import { createPostgresHooksLaunchReviewRepository } from "./hooks-launch-review-repository.js";
import { createPostgresHooksLaunchSubmissionRepository } from "./hooks-launch-submission-repository.js";
import type { HooksLaunchProjectConfigRepository } from "../features/launch/hooks-launch-project-config.js";
import type { HooksLaunchReviewRepository } from "../features/launch/hooks-launch-review.js";
import type { HooksLaunchSubmissionRepository } from "../features/launch/hooks-launch-submission.js";
import { createPostgresMiningRepository } from "./mining-repository.js";
import { createPostgresReferralRepository } from "./referral-repository.js";
import type { LaunchRepository } from "../features/launch/launch-repository.js";
import type { LaunchChainRepository } from "../features/launch/launch-chain-repository.js";
import { createPostgresLaunchChainRepository } from "./launch-chain-repository.js";
import type { MiningRepository } from "../features/mining/mining-repository.js";
import type { ReferralRepository } from "../features/referral/referral-repository.js";
import type {
  CommunicationRepository,
  CommunityChannelPersonaRepository,
  CommunityChannelSyncRepository,
  VoiceRoomReaperRepository,
} from "../features/communication/communication-repository.js";
import { createPostgresChatChannelRepository } from "./chat-channel-repository.js";
import { createPostgresCommunityAiRepository } from "./community-ai-repository.js";
import { createPostgresCommunityRepository } from "./community-repository.js";
import {
  createPostgresCommunicationRepository,
  createPostgresCommunityChannelPersonaRepository,
  createPostgresCommunityChannelSyncRepository,
  createPostgresVoiceRoomReaperRepository,
} from "./communication-repository.js";
import { createPostgresDeviceSessionRepository } from "./device-session-repository.js";
import { createPostgresMemberBuyFeedRepository } from "./member-buy-feed-repository.js";
import type { MemberBuyFeedRepository } from "../features/community/member-buy-feed-repository.js";
import {
  createPostgresAlertRepository,
  type AlertRepository,
} from "./alert-repository.js";
import {
  createPostgresAliasDirectoryRepository,
  type AliasDirectoryRepository,
} from "./alias-directory-repository.js";
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
import { getOrCreateLoopUserInTransaction } from "./loop-user-insert.js";
import {
  createPostgresProfileRepository,
  type ProfileRepository,
} from "./profile-repository.js";
import { createPostgresProfileV2Repository } from "./profile-v2-repository.js";
import type { ProfileV2Repository } from "../features/profile/profile-v2-repository.js";
import {
  createPostgresSocialRepository,
  type SocialRepository,
} from "./social-repository.js";
import { latestMigrationName, requiredDatabaseRelations } from "./schema.js";
import {
  createPostgresSpotAgentAuthorizationRepository,
  type PostgresSpotAgentAuthorizationRepository,
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
import type { AdminLoginAttemptStore } from "../features/admin/admin-login-attempts.js";

const { Pool } = pg;
const privyUserIdSchema = z.string().min(1).max(255);
const internalUserRowSchema = z.object({ id: z.string().uuid() }).strict();

export interface Database {
  readonly internalUsers: InternalUserRepository;
  readonly deviceSessions: DeviceSessionRepository;
  readonly aliasDirectory?: AliasDirectoryRepository;
  readonly social?: SocialRepository;
  readonly chatChannels?: ChatChannelRepository;
  readonly controlPlane: ControlPlaneRepository;
  readonly perpWalletBindings: PerpWalletBindingRepository;
  readonly perpIntents: PerpIntentRepository;
  readonly agentAuthorizations: AgentAuthorizationRepository;
  readonly profiles: ProfileRepository;
  /** V2 LOOP ID profile and privacy (Decision 0030); absent means unavailable. */
  readonly profilesV2?: ProfileV2Repository;
  /** V2 community, follow graph, blocks, and search (Decision 0031). */
  readonly community?: CommunityRepository;
  /** Community AI answers, reports, and the quota ledger (Decision 0066). */
  readonly communityAi?: CommunityAiRepository;
  /** V2 official community channels and voice rooms (Decision 0032). */
  readonly communication?: CommunicationRepository;
  readonly watchlists: WatchlistRepository;
  /** V2 Watchlist rows keyed by canonical assetId (Decision 0033). */
  readonly watchlistsV2?: WatchlistV2Repository;
  /** BSC chain and Asset Registry (Decision 0033). */
  readonly chainRegistry?: ChainRegistryRepository;
  /** LOOP wallet inventory projected from Privy (Decision 0033). */
  readonly accountWallets?: AccountWalletRepository;
  /** Narrow BSC indexer lanes and their projections (Decision 0033). */
  readonly bscIndexer?: BscIndexerRepository;
  /** Active wallet addresses the transfer lane filters on (Decision 0075). */
  readonly bscIndexerWallets?: BscIndexerWalletSetRepository;
  readonly alerts: AlertRepository;
  /** Market Provider fact cache (Decision 0034). */
  readonly marketFacts?: MarketFactCacheRepository;
  /** Candidate sets of the categorised market list (Decision 0100). */
  readonly marketCategories?: MarketCategoryRepository;
  /** Token logo proxy cache (Decision 0089). */
  readonly tokenLogoCache?: TokenLogoCacheRepository;
  /** Uploaded avatars and community logos (Decision 0095). */
  readonly media?: MediaStorage;
  /** Public profile reads, friend removal, recommended communities (Decision 0095). */
  readonly publicProfiles?: PublicProfileRepository;
  /** Identity facts projected onto Stream users (Decision 0095). */
  readonly streamUserIdentities?: StreamUserIdentityRepository;
  /** V2 price alerts keyed by asset ID (Decision 0034). */
  readonly alertsV2?: AlertV2Repository;
  /** Context notification feed and V2 preferences (Decision 0034). */
  readonly notifications?: NotificationRepository;
  /** Device push tokens and push delivery attempts (Decision 0067). */
  readonly push?: PushRepository;
  /** Unified send/approve/revoke/swap intents (Decision 0035). */
  readonly walletIntents?: WalletIntentRepository;
  /** Decision 0037 account settings CAS slot. */
  readonly accountSettings?: AccountSettingsRepository;
  /** Decision 0037 support tickets. */
  readonly supportTickets?: SupportTicketRepository;
  /** Launch off-chain catalog and review (Decision 0036). */
  readonly launch?: LaunchRepository;
  /** Decision 0108: append-only owner Hooks launch config drafts. */
  readonly hooksLaunchProjectConfigs?: HooksLaunchProjectConfigRepository;
  /** Decision 0108: operator review (edit / approve / testnet acceptance). */
  readonly hooksLaunchReview?: HooksLaunchReviewRepository;
  /** Decision 0108: project-signed deployment tasks (awaiting executor). */
  readonly hooksLaunchSubmissions?: HooksLaunchSubmissionRepository;
  /** Decision 0112: the deployment executor's lease-scoped repository. */
  readonly hooksLaunchExecutor?: (
    leaseSeconds: number,
  ) => HooksLaunchExecutorRepository;
  /** Launch chain facts: lane, projections, allowlist roots, Intents (Decision 0077). */
  readonly launchChain?: LaunchChainRepository;
  /** Mining formula versions, weights, and snapshots (Decision 0036). */
  readonly mining?: MiningRepository;
  /** Invite codes and referral edges (Decision 0036). */
  readonly referral?: ReferralRepository;
  /** MEME curve launchpad: tokens, lane, salts, Intents (Decision 0101). */
  readonly meme?: MemeRepository;
  /** MEME v2 read model: instances, lane facts, Intents (Decision 0114). */
  readonly launch2?: Launch2Repository;
  /** Decision 0118: snapshot publications (2-of-3 signed, worker only). */
  readonly launch2Publications?: Launch2PublicationRepository;
  /** Operator console settings, audit, review notes (Decision 0102). */
  readonly admin?: AdminRepository;
  /** Decision 0109: console accounts (roles, idempotent account writes). */
  readonly adminAccounts?: AdminAccountRepository;
  /** Decision 0109: console read projection of the Hooks launch review. */
  readonly adminLaunchReview?: AdminLaunchReviewRepository;
  /** Decision 0110: login failure buckets shared by every instance. */
  readonly adminLoginAttempts?: AdminLoginAttemptStore;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface PostgresDatabase extends Database {
  readonly perpReconciliation: PerpReconciliationRepository;
  readonly spotAgentAuthorizations: PostgresSpotAgentAuthorizationRepository;
  readonly spotIntents: PostgresSpotIntentRepository;
  readonly spotReconciliation: SpotReconciliationRepository;
  readonly communityChannelSync: CommunityChannelSyncRepository;
  /** `voice_room_reaper` lane (Decision 0094). */
  readonly voiceRoomReaper: VoiceRoomReaperRepository;
  /** `community_member_buy_feed` lane (Decision 0097). */
  readonly memberBuyFeed: MemberBuyFeedRepository;
  /** Decision 0055 community chat personas. */
  readonly communityChannelPersonas: CommunityChannelPersonaRepository;
  readonly streamUserIdentities: StreamUserIdentityRepository;
}

export interface PostgresDatabaseConfig {
  readonly serviceName: string;
  readonly databaseUrl: string;
  readonly databasePoolMax: number;
  readonly databaseConnectionTimeoutMs: number;
  readonly databaseStatementTimeoutMs: number;
  /** Optional; the reconciliation worker process does not configure it. */
  readonly v2CommunityChannelMemberCap?: number;
  /**
   * The `launch` chain slot (Decision 0038); only its `chainId` is needed
   * here, to stamp newly approved launches. Absent means `eip155:56`.
   */
  readonly launchChain?: { readonly chainId: LaunchChainId };
  /**
   * Decision 0117: the operator config-save path keeps the same sale-start
   * lead as the owner path. Absent (worker processes) means 86,400 s.
   */
  readonly hooksLaunch?: { readonly minimumSaleLeadSeconds: number };
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
      const client = await pool.connect();
      try {
        await client.query("begin");
        const user = await getOrCreateLoopUserInTransaction(
          client,
          privyUserId,
        );
        await client.query("commit");
        return user;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
  };
  const controlPlane = createPostgresControlPlaneRepository(pool);
  const deviceSessions = createPostgresDeviceSessionRepository(pool);
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
  const profilesV2 = createPostgresProfileV2Repository(pool);
  const watchlists = createPostgresWatchlistRepository(pool);
  const watchlistsV2 = createPostgresWatchlistV2Repository(pool);
  const chainRegistry = createPostgresChainRegistryRepository(pool);
  const accountWallets = createPostgresAccountWalletRepository(pool);
  const bscIndexer = createPostgresBscIndexerRepository(pool);
  const bscIndexerWallets = createPostgresBscIndexerWalletSetRepository(pool);
  const alerts = createPostgresAlertRepository(pool);
  const marketFacts = createPostgresMarketFactCacheRepository(pool);
  const marketCategories = createPostgresMarketCategoryRepository(pool);
  const tokenLogoCache = createPostgresTokenLogoCacheRepository(pool);
  const media = createPostgresMediaRepository(pool);
  const publicProfiles = createPostgresPublicProfileRepository(pool);
  const streamUserIdentities = createPostgresStreamUserIdentityRepository(pool);
  const alertsV2 = createPostgresAlertV2Repository(pool);
  const notifications = createPostgresNotificationRepository(pool);
  const push = createPostgresPushRepository(pool);
  const walletIntents = createPostgresWalletIntentRepository(pool);
  const accountSettings = createPostgresAccountSettingsRepository(pool);
  const supportTickets = createPostgresSupportTicketRepository(pool);
  const communityAi = createPostgresCommunityAiRepository(pool);
  const launch = createPostgresLaunchRepository(
    pool,
    config.launchChain === undefined
      ? {}
      : { launchChainId: config.launchChain.chainId },
  );
  const mining = createPostgresMiningRepository(pool);
  const referral = createPostgresReferralRepository(pool);
  const aliasDirectory = createPostgresAliasDirectoryRepository(pool);
  const social = createPostgresSocialRepository(pool);
  const chatChannels = createPostgresChatChannelRepository(pool);
  const community = createPostgresCommunityRepository(
    pool,
    config.v2CommunityChannelMemberCap === undefined
      ? {}
      : { communityChannelMemberCap: config.v2CommunityChannelMemberCap },
  );
  const communication = createPostgresCommunicationRepository(pool);
  const communityChannelSync =
    createPostgresCommunityChannelSyncRepository(pool);
  const voiceRoomReaper = createPostgresVoiceRoomReaperRepository(pool);
  const memberBuyFeed = createPostgresMemberBuyFeedRepository(pool);
  const communityChannelPersonas =
    createPostgresCommunityChannelPersonaRepository(pool);

  return {
    internalUsers,
    deviceSessions,
    aliasDirectory,
    social,
    chatChannels,
    controlPlane,
    perpWalletBindings,
    perpIntents,
    perpReconciliation,
    agentAuthorizations,
    spotAgentAuthorizations,
    spotIntents,
    spotReconciliation,
    profiles,
    profilesV2,
    community,
    communication,
    communityChannelSync,
    voiceRoomReaper,
    memberBuyFeed,
    communityChannelPersonas,
    watchlists,
    watchlistsV2,
    chainRegistry,
    accountWallets,
    bscIndexer,
    bscIndexerWallets,
    alerts,
    marketFacts,
    marketCategories,
    tokenLogoCache,
    media,
    publicProfiles,
    streamUserIdentities,
    alertsV2,
    notifications,
    push,
    walletIntents,
    accountSettings,
    supportTickets,
    communityAi,
    launch,
    hooksLaunchProjectConfigs:
      createPostgresHooksLaunchProjectConfigRepository(pool),
    hooksLaunchReview: createPostgresHooksLaunchReviewRepository(pool, {
      ...(config.hooksLaunch === undefined
        ? {}
        : { minimumLeadSeconds: config.hooksLaunch.minimumSaleLeadSeconds }),
    }),
    hooksLaunchSubmissions: createPostgresHooksLaunchSubmissionRepository(pool),
    hooksLaunchExecutor: (leaseSeconds: number) =>
      createPostgresHooksLaunchExecutorRepository(pool, { leaseSeconds }),
    launchChain: createPostgresLaunchChainRepository(pool),
    meme: createPostgresMemeRepository(pool),
    launch2: createPostgresLaunch2Repository(pool),
    launch2Publications: createPostgresLaunch2PublicationRepository(pool),
    admin: createPostgresAdminRepository(pool),
    adminAccounts: createPostgresAdminAccountRepository(pool),
    adminLaunchReview: createPostgresAdminLaunchReviewRepository(pool),
    adminLoginAttempts: createPostgresAdminLoginAttemptStore(pool),
    mining,
    referral,
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
