import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

/**
 * Development-only user data reset (Decision 0113, docs/14 §8):
 *
 *   pnpm dev:reset-users [--dry-run] [--yes]
 *
 * LOOP is moving to a new Privy app, so every stored Privy user ID is void.
 * This script removes every user-rooted row and keeps platform data
 * (community directory, market cache, MEME tokens and curves, Launch
 * projects and sales, operator console accounts, audit logs, migrations,
 * formula versions, settings).
 *
 * Safety locks:
 * - `NODE_ENV=production` is refused.
 * - The database name (from `DATABASE_URL` and from `current_database()`)
 *   must start with `loop_api_dev` or `loop_api_test`.
 * - Without `--yes` (or with `--dry-run`) it only prints the plan: row counts
 *   computed in a READ ONLY transaction.
 * - Every public table must be classified below; an unclassified table (a
 *   new migration) stops the script before anything runs.
 * - Execution is one transaction. Foreign keys stay enforced; only the
 *   user-defined guard triggers of the touched tables are disabled for the
 *   transaction and re-enabled before commit. Before commit every foreign key
 *   to `loop_users` is checked to point only at the sentinel (or at a
 *   retired audit actor through `ops_audit`, which is never touched).
 */

export const sentinelPrivyUserId = "loop:system:retired-owner";
export const retiredPrivyUserIdPrefix = "loop:retired:";
export const disabledByDevReset = "dev-reset";
export const allowedDatabasePrefixes = Object.freeze([
  "loop_api_dev",
  "loop_api_test",
]);

export type TableClass = "user" | "platform" | "mixed";

/**
 * Every public table. `user`: rows exist only because of a LOOP user and are
 * deleted. `platform`: untouched. `mixed`: platform rows that carry a user
 * column; rows stay and the column is cleared or pointed at the sentinel.
 */
export const tableClassification: Readonly<Record<string, TableClass>> =
  Object.freeze({
    // Identity, devices, settings
    loop_users: "user",
    account_settings: "user",
    user_profiles: "user",
    profile_activation_commands: "user",
    privacy_preferences: "user",
    privacy_preferences_v2: "user",
    social_privacy_preferences: "user",
    device_sessions: "user",
    device_session_commands: "user",
    device_session_events: "user",
    device_push_tokens: "user",
    device_push_token_commands: "user",
    push_deliveries: "user",
    idempotency_records: "user",
    media_objects: "mixed",
    // Social graph and chat
    follow_edges: "user",
    user_blocks: "user",
    social_graph_events: "user",
    friend_requests: "user",
    friendships: "user",
    social_operations: "user",
    social_operation_events: "user",
    chat_operations: "user",
    chat_operation_events: "user",
    communication_groups: "user",
    communication_group_members: "user",
    communication_group_events: "user",
    chat_group_membership_events: "user",
    group_alias_reservations: "user",
    direct_channels: "user",
    // Communities
    communities: "mixed",
    community_channels: "mixed",
    community_memberships: "user",
    community_role_events: "mixed",
    community_channel_members: "user",
    community_channel_sync_jobs: "user",
    community_channel_personas: "user",
    community_member_buy_events: "user",
    community_ai_usage: "user",
    community_ai_answers: "user",
    community_ai_answer_reports: "user",
    community_channel_activity: "platform",
    community_feed_cursors: "platform",
    community_mining_weights: "platform",
    community_review_notes: "platform",
    voice_rooms: "user",
    voice_room_members: "user",
    voice_room_hand_raises: "user",
    voice_room_events: "user",
    // Watchlists, alerts, notifications, support, referral
    watchlist_versions: "user",
    watchlist_groups: "user",
    watchlist_items: "user",
    price_alert_definitions: "user",
    price_alert_events: "user",
    notification_preference_versions: "user",
    notification_preferences: "user",
    notification_preference_v2_versions: "user",
    notification_preferences_v2: "user",
    notifications: "user",
    support_tickets: "user",
    support_ticket_events: "user",
    invite_codes: "user",
    referral_edges: "user",
    referral_events: "user",
    // Wallets and provider operations
    account_wallets: "user",
    wallet_balance_snapshots: "user",
    approval_observations: "user",
    wallet_intents: "user",
    wallet_intent_events: "user",
    swap_quotes: "user",
    provider_operations: "user",
    audit_events: "user",
    perp_intents: "user",
    perp_intent_items: "user",
    perp_intent_events: "user",
    perp_wallet_bindings: "user",
    perp_wallet_binding_events: "user",
    perp_agent_identities: "user",
    perp_agent_authorizations: "user",
    perp_agent_authorization_events: "user",
    spot_agent_identities: "user",
    spot_agent_identity_events: "user",
    spot_intents: "user",
    spot_intent_events: "user",
    spot_agent_authorizations: "user",
    spot_agent_authorization_events: "user",
    hyperliquid_signer_nonce_allocations: "user",
    hyperliquid_signer_nonce_state: "platform",
    issuance_rate_records: "platform",
    // Chain and market facts
    chains: "platform",
    assets: "platform",
    pools: "platform",
    indexer_checkpoints: "platform",
    indexed_transfers: "platform",
    indexed_pool_events: "platform",
    indexed_approvals: "platform",
    indexer_wallet_coverage: "platform",
    market_fact_cache: "platform",
    token_logo_cache: "platform",
    // Launch
    launch_projects: "mixed",
    launch_review_events: "mixed",
    launches: "platform",
    launch_configs: "platform",
    launch_rounds: "platform",
    launch_allowlists: "platform",
    launch_round_allowlist_roots: "platform",
    launch_indexed_events: "platform",
    venue_milestones: "platform",
    launch_intents: "user",
    purchase_records: "user",
    entitlements: "user",
    refund_liabilities: "user",
    refund_claims: "user",
    launch_settlement_records: "user",
    hooks_launch_project_config_versions: "user",
    hooks_launch_config_approvals: "user",
    // Decision 0122: reviewer rejections (catalog material / config version)
    hooks_launch_config_rejections: "user",
    launch_project_rejections: "user",
    // Decision 0125: console approvals of catalog material
    launch_project_approvals: "user",
    hooks_testnet_acceptances: "user",
    hooks_launch_deployment_tasks: "user",
    hooks_launch_deployment_events: "user",
    hooks_launch_executor_nonces: "user",
    hooks_launch_deployment_authorizations: "user",
    hooks_launch_submission_commands: "user",
    // MEME v2 read model (Decision 0114): rooted in a deployment task
    launch2_instances: "user",
    launch2_events: "user",
    launch2_nft_mints: "user",
    launch2_trades: "user",
    launch2_buybacks: "user",
    // Decision 0125: MEME ERC-20 transfers of a launch2 instance
    launch2_meme_transfers: "user",
    launch2_snapshot_members: "user",
    launch2_positions: "user",
    launch2_intents: "user",
    // Snapshot publications (Decision 0118): rooted in a launch2 instance
    launch2_snapshot_publications: "user",
    // Buyback keeper attempts (Decision 0121): rooted in a launch2 instance
    launch2_buyback_attempts: "user",
    // Official-pool swaps (Decision 0124): rooted in a launch2 instance
    launch2_pool_swaps: "user",
    // Decision 0120: no-holder closures and retry grants of those instances
    launch2_snapshot_closures: "user",
    launch2_snapshot_publication_releases: "user",
    // Mining
    mining_formula_versions: "platform",
    mining_snapshots: "platform",
    mining_snapshot_powers: "user",
    mining_reward_ledger: "user",
    mining_parameter_versions: "platform",
    mining_epochs: "platform",
    mining_epoch_rewards: "user",
    mining_claims: "user",
    mining_reward_ledger_events: "user",
    mining_reward_balances: "user",
    // MEME
    meme_tokens: "mixed",
    meme_intents: "user",
    meme_indexed_events: "platform",
    meme_trades: "platform",
    meme_holders: "platform",
    meme_salts: "platform",
    // Operators and console
    ops_operators: "user",
    ops_grants: "user",
    ops_operations: "user",
    ops_audit: "platform",
    admin_accounts: "mixed",
    admin_account_commands: "platform",
    admin_audit_log: "platform",
    admin_login_attempts: "platform",
    admin_settings: "platform",
    // Migration ledger
    pgmigrations: "platform",
  });

const sentinelId = `(select id from public.loop_users where privy_user_id = '${sentinelPrivyUserId}')`;
/**
 * A user reference is removed unless it is the sentinel. This also catches
 * rows whose user no longer exists (dev holds such orphans, e.g. 28
 * provider_operations rows from 2026-09-09 written while foreign keys were
 * bypassed).
 */
const ownedBy = (column = "owner_user_id") =>
  `(${column} is not null and ${column} not in ${sentinelId})`;
const ownedIdempotency = `(select id from public.idempotency_records where ${ownedBy()})`;
const ownedWallets = `(select wallet_id from public.account_wallets where ${ownedBy()})`;
/** `ops_audit` is append-only; its user actors survive as retired users. */
const auditActors = `(select actor_id from public.ops_audit where actor_id is not null)`;
const keptMedia = `(media_id in (select image_media_id from public.meme_tokens where image_media_id is not null)
  or 'logo:media/' || media_id::text in (select logo_ref from public.communities where logo_ref is not null))`;
const doomedConfigVersions = `(select project_id, config_version from public.hooks_launch_project_config_versions
  where ${ownedBy()} or ${ownedBy("edited_by_operator_id")})`;
const doomedApprovals = `(select project_id, config_version from public.hooks_launch_config_approvals
  where (project_id, config_version) in ${doomedConfigVersions} or ${ownedBy("approver_id")})`;
const doomedDeploymentTasks = `(select job_id from public.hooks_launch_deployment_tasks
  where ${ownedBy()} or (project_id, config_version) in ${doomedApprovals})`;
const doomedLaunch2Instances = `(select instance_id from public.launch2_instances
  where ${ownedBy()} or job_id in ${doomedDeploymentTasks})`;
const doomedVoiceRooms = `(select voice_room_id from public.voice_rooms where ${ownedBy("created_by_user_id")})`;
const doomedChatOperations = `(select operation_id from public.chat_operations where ${ownedBy()})`;

export interface ResetStep {
  readonly table: string;
  readonly action: "delete" | "update";
  /** Short human label printed beside the count. */
  readonly label: string;
  /** `set ...` clause for updates. */
  readonly set?: string;
  readonly where: string;
}

function del(table: string, where: string, label = "delete"): ResetStep {
  return { table, action: "delete", label, where };
}

function upd(
  table: string,
  set: string,
  where: string,
  label: string,
): ResetStep {
  return { table, action: "update", label, set, where };
}

/** Mixed rows first, so the deletes below never meet a live reference. */
export const mixedSteps: readonly ResetStep[] = Object.freeze([
  upd(
    "loop_users",
    `privy_user_id = '${retiredPrivyUserIdPrefix}' || id::text`,
    `id in ${auditActors} and privy_user_id <> '${sentinelPrivyUserId}'
      and privy_user_id not like '${retiredPrivyUserIdPrefix}%'`,
    "retire ops_audit actors (privy_user_id -> loop:retired:<id>)",
  ),
  upd(
    "communities",
    `created_by_user_id = ${sentinelId}`,
    ownedBy("created_by_user_id"),
    "created_by_user_id -> sentinel",
  ),
  upd(
    "community_channels",
    `created_by_user_id = ${sentinelId}`,
    ownedBy("created_by_user_id"),
    "created_by_user_id -> sentinel",
  ),
  upd(
    "media_objects",
    `owner_user_id = ${sentinelId}`,
    `${ownedBy()} and ${keptMedia}`,
    "owner_user_id -> sentinel (MEME images, community logos)",
  ),
  upd(
    "meme_tokens",
    `creator_user_id = ${sentinelId}`,
    ownedBy("creator_user_id"),
    "creator_user_id -> sentinel",
  ),
  upd(
    "meme_tokens",
    "creator_wallet_id = null",
    `creator_wallet_id in ${ownedWallets}`,
    "creator_wallet_id -> null",
  ),
  upd(
    "meme_tokens",
    "idempotency_record_id = null",
    `idempotency_record_id in ${ownedIdempotency}`,
    "idempotency_record_id -> null",
  ),
  upd(
    "launch_projects",
    `owner_user_id = ${sentinelId}`,
    ownedBy(),
    "owner_user_id -> sentinel",
  ),
  upd(
    "launch_review_events",
    `actor_user_id = ${sentinelId}`,
    ownedBy("actor_user_id"),
    "actor_user_id -> sentinel (applicant rows)",
  ),
  upd(
    "launch_review_events",
    "idempotency_record_id = null",
    `idempotency_record_id in ${ownedIdempotency}`,
    "idempotency_record_id -> null",
  ),
  upd(
    "admin_accounts",
    `operator_user_id = ${sentinelId},
      disabled_at = coalesce(disabled_at, greatest(clock_timestamp(), created_at)),
      disabled_by = coalesce(disabled_by, '${disabledByDevReset}')`,
    ownedBy("operator_user_id"),
    "disable bound accounts, operator_user_id -> sentinel",
  ),
]);

/** Child before parent along every foreign key. */
export const deleteSteps: readonly ResetStep[] = Object.freeze([
  // MEME v2 read model of the doomed deployment tasks (Decision 0114)
  del(
    "launch2_intents",
    `${ownedBy()} or instance_id in ${doomedLaunch2Instances}
      or idempotency_record_id in ${ownedIdempotency}`,
  ),
  del(
    "launch2_snapshot_publication_releases",
    `instance_id in ${doomedLaunch2Instances}`,
  ),
  del("launch2_snapshot_closures", `instance_id in ${doomedLaunch2Instances}`),
  del(
    "launch2_snapshot_publications",
    `instance_id in ${doomedLaunch2Instances}`,
  ),
  del("launch2_buyback_attempts", `instance_id in ${doomedLaunch2Instances}`),
  del("launch2_pool_swaps", `instance_id in ${doomedLaunch2Instances}`),
  del("launch2_positions", `instance_id in ${doomedLaunch2Instances}`),
  del("launch2_snapshot_members", `instance_id in ${doomedLaunch2Instances}`),
  del("launch2_buybacks", `instance_id in ${doomedLaunch2Instances}`),
  del("launch2_trades", `instance_id in ${doomedLaunch2Instances}`),
  del("launch2_nft_mints", `instance_id in ${doomedLaunch2Instances}`),
  del("launch2_events", `instance_id in ${doomedLaunch2Instances}`),
  del("launch2_meme_transfers", `instance_id in ${doomedLaunch2Instances}`),
  del("launch2_instances", `instance_id in ${doomedLaunch2Instances}`),
  // Hooks Launch project-side configuration and signing tasks
  del("hooks_launch_deployment_events", `job_id in ${doomedDeploymentTasks}`),
  del("hooks_launch_executor_nonces", `job_id in ${doomedDeploymentTasks}`),
  del(
    "hooks_launch_submission_commands",
    `${ownedBy()} or job_id in ${doomedDeploymentTasks}`,
  ),
  del(
    "hooks_launch_deployment_authorizations",
    `job_id in ${doomedDeploymentTasks}`,
  ),
  del("hooks_launch_deployment_tasks", `job_id in ${doomedDeploymentTasks}`),
  del(
    "hooks_testnet_acceptances",
    `(project_id, config_version) in ${doomedApprovals}
      or (project_id, config_version) in ${doomedConfigVersions}
      or ${ownedBy("actor_id")}`,
  ),
  del(
    "hooks_launch_config_approvals",
    `(project_id, config_version) in ${doomedApprovals}`,
  ),
  // Decision 0122: rejections of doomed versions or by doomed reviewers
  del(
    "hooks_launch_config_rejections",
    `(project_id, config_version) in ${doomedConfigVersions}
      or ${ownedBy("reviewer_id")}`,
  ),
  del("launch_project_rejections", ownedBy("reviewer_user_id")),
  del("launch_project_approvals", ownedBy("reviewer_user_id")),
  del(
    "hooks_launch_project_config_versions",
    `(project_id, config_version) in ${doomedConfigVersions}`,
  ),
  // Operators (their audit trail in ops_audit stays)
  del("ops_operations", ownedBy("actor_id")),
  del("ops_grants", ownedBy("user_id")),
  del("ops_operators", ownedBy("user_id")),
  // Mining user rows (Decision 0116 ledger first: events reference claims)
  del("mining_reward_ledger_events", ownedBy()),
  del("mining_reward_balances", ownedBy()),
  del(
    "mining_claims",
    `${ownedBy()} or idempotency_record_id in ${ownedIdempotency}`,
  ),
  del("mining_epoch_rewards", ownedBy()),
  del("mining_reward_ledger", ownedBy()),
  del("mining_snapshot_powers", ownedBy()),
  // MEME user intents
  del(
    "meme_intents",
    `${ownedBy()} or idempotency_record_id in ${ownedIdempotency}`,
  ),
  // Launch participation
  del(
    "refund_claims",
    `wallet_id in ${ownedWallets} or refund_liability_id in
      (select refund_liability_id from public.refund_liabilities where ${ownedBy()})`,
  ),
  del("refund_liabilities", `${ownedBy()} or wallet_id in ${ownedWallets}`),
  del("entitlements", `${ownedBy()} or wallet_id in ${ownedWallets}`),
  del(
    "launch_settlement_records",
    `${ownedBy()} or wallet_id in ${ownedWallets}`,
  ),
  del(
    "purchase_records",
    `${ownedBy()} or wallet_id in ${ownedWallets} or intent_id in
      (select intent_id from public.launch_intents where ${ownedBy()})`,
  ),
  del(
    "launch_intents",
    `${ownedBy()} or wallet_id in ${ownedWallets}
      or idempotency_record_id in ${ownedIdempotency}`,
  ),
  // Community participation
  del("community_member_buy_events", ownedBy("buyer_user_id")),
  del(
    "community_ai_answer_reports",
    `${ownedBy("reporter_user_id")}
      or create_idempotency_record_id in ${ownedIdempotency}`,
  ),
  del(
    "community_ai_answers",
    `${ownedBy()} or create_idempotency_record_id in ${ownedIdempotency}`,
  ),
  del("community_ai_usage", ownedBy()),
  del(
    "voice_room_events",
    `voice_room_id in ${doomedVoiceRooms} or ${ownedBy("actor_user_id")}
      or ${ownedBy("target_user_id")} or idempotency_record_id in ${ownedIdempotency}`,
  ),
  del(
    "voice_room_hand_raises",
    `${ownedBy()} or voice_room_id in ${doomedVoiceRooms}`,
  ),
  del(
    "voice_room_members",
    `${ownedBy()} or voice_room_id in ${doomedVoiceRooms}`,
  ),
  del("voice_rooms", ownedBy("created_by_user_id")),
  del("community_channel_sync_jobs", ownedBy()),
  del("community_channel_members", ownedBy()),
  del("community_channel_personas", ownedBy()),
  del(
    "community_role_events",
    `${ownedBy("actor_user_id")} or ${ownedBy("target_user_id")}
      or idempotency_record_id in ${ownedIdempotency}`,
  ),
  del("community_memberships", ownedBy()),
  // Group chats and direct channels (only users create them: whole tables)
  del("chat_group_membership_events", "true"),
  del("communication_group_events", "true"),
  del("group_alias_reservations", "true"),
  del("communication_group_members", "true"),
  del("communication_groups", "true"),
  del(
    "direct_channels",
    `${ownedBy("user_id_low")} or ${ownedBy("user_id_high")}
      or create_operation_id in ${doomedChatOperations}`,
  ),
  del("chat_operation_events", ownedBy()),
  del("chat_operations", ownedBy()),
  // Social graph
  del("social_operation_events", ownedBy()),
  del("social_operations", ownedBy()),
  del(
    "social_graph_events",
    `${ownedBy("actor_user_id")} or ${ownedBy("target_user_id")}
      or idempotency_record_id in ${ownedIdempotency}`,
  ),
  del("friendships", `${ownedBy("user_id_low")} or ${ownedBy("user_id_high")}`),
  del(
    "friend_requests",
    `${ownedBy("requester_user_id")} or ${ownedBy("recipient_user_id")}`,
  ),
  del(
    "follow_edges",
    `${ownedBy("follower_user_id")} or ${ownedBy("followee_user_id")}`,
  ),
  del("user_blocks", `${ownedBy()} or ${ownedBy("target_user_id")}`),
  // Referral
  del(
    "referral_events",
    `${ownedBy("invitee_user_id")} or ${ownedBy("inviter_user_id")}
      or idempotency_record_id in ${ownedIdempotency}`,
  ),
  del(
    "referral_edges",
    `${ownedBy("invitee_user_id")} or ${ownedBy("inviter_user_id")}`,
  ),
  del("invite_codes", ownedBy()),
  // Notifications, alerts, watchlists, support
  del("notifications", ownedBy()),
  del("notification_preferences", ownedBy()),
  del("notification_preference_versions", ownedBy()),
  del("notification_preferences_v2", ownedBy()),
  del("notification_preference_v2_versions", ownedBy()),
  del("price_alert_events", ownedBy()),
  del("price_alert_definitions", ownedBy()),
  del("watchlist_items", ownedBy()),
  del("watchlist_groups", ownedBy()),
  del("watchlist_versions", ownedBy()),
  del("support_ticket_events", ownedBy()),
  del("support_tickets", ownedBy()),
  // Devices and push
  del(
    "push_deliveries",
    `${ownedBy()} or push_token_id in
      (select push_token_id from public.device_push_tokens where ${ownedBy()})`,
  ),
  del("device_push_token_commands", ownedBy()),
  del("device_push_tokens", ownedBy()),
  del("device_session_events", ownedBy()),
  del("device_session_commands", ownedBy()),
  del("device_sessions", ownedBy()),
  // Wallets
  del(
    "wallet_intent_events",
    `${ownedBy()} or intent_id in
      (select intent_id from public.wallet_intents where ${ownedBy()})`,
  ),
  del("wallet_intents", `${ownedBy()} or wallet_id in ${ownedWallets}`),
  del("swap_quotes", `${ownedBy()} or wallet_id in ${ownedWallets}`),
  del("approval_observations", `wallet_id in ${ownedWallets}`),
  del("wallet_balance_snapshots", `wallet_id in ${ownedWallets}`),
  del("account_wallets", ownedBy()),
  // Frozen Hyperliquid / perp / spot provider rows
  del("spot_intent_events", ownedBy()),
  del("spot_intents", ownedBy()),
  del("spot_agent_authorization_events", ownedBy()),
  del("spot_agent_authorizations", ownedBy()),
  del("spot_agent_identity_events", ownedBy()),
  del("spot_agent_identities", ownedBy()),
  del("perp_intent_events", ownedBy()),
  del("perp_intent_items", ownedBy()),
  del("perp_intents", ownedBy()),
  del("perp_agent_authorization_events", ownedBy()),
  del("perp_agent_authorizations", ownedBy()),
  del("perp_agent_identities", ownedBy()),
  del("perp_wallet_binding_events", ownedBy()),
  del("perp_wallet_bindings", ownedBy()),
  del("hyperliquid_signer_nonce_allocations", ownedBy()),
  del("audit_events", ownedBy()),
  del("provider_operations", ownedBy()),
  // Profile and settings
  del("profile_activation_commands", ownedBy()),
  del("user_profiles", ownedBy()),
  del("privacy_preferences", ownedBy()),
  del("privacy_preferences_v2", ownedBy()),
  del("social_privacy_preferences", ownedBy()),
  del("account_settings", ownedBy()),
  del("media_objects", `${ownedBy()} and not ${keptMedia}`),
  del("idempotency_records", ownedBy()),
  del(
    "loop_users",
    `privy_user_id <> '${sentinelPrivyUserId}' and id not in ${auditActors}`,
  ),
]);

/** Membership counters (their trigger is disabled during the reset). */
export const finalSteps: readonly ResetStep[] = Object.freeze([
  upd(
    "communities",
    `member_count = (select count(*) from public.community_memberships as m
      where m.community_id = communities.community_id and m.status <> 'banned'
        and not ${ownedBy("m.owner_user_id")})`,
    `member_count <> (select count(*) from public.community_memberships as m
      where m.community_id = communities.community_id and m.status <> 'banned'
        and not ${ownedBy("m.owner_user_id")})`,
    "member_count recomputed",
  ),
]);

export const allSteps: readonly ResetStep[] = Object.freeze([
  ...mixedSteps,
  ...deleteSteps,
  ...finalSteps,
]);

export type DevResetErrorCode =
  | "dev_reset_arguments_invalid"
  | "dev_reset_database_unconfigured"
  | "dev_reset_forbidden_in_production"
  | "dev_reset_database_name_refused"
  | "dev_reset_unclassified_tables"
  | "dev_reset_dangling_user_reference"
  | "dev_reset_failed";

export class DevResetError extends Error {
  constructor(
    readonly code: DevResetErrorCode,
    readonly detail?: string,
  ) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = "DevResetError";
  }
}

export interface DevResetRequest {
  readonly databaseUrl: string;
  readonly databaseName: string;
  readonly execute: boolean;
}

export function databaseNameFromUrl(databaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl.trim());
  } catch {
    throw new DevResetError("dev_reset_database_unconfigured");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new DevResetError("dev_reset_database_unconfigured");
  }
  return decodeURIComponent(parsed.pathname.replace(/^\/+/u, ""));
}

export function isAllowedDatabaseName(name: string): boolean {
  return allowedDatabasePrefixes.some((prefix) => name.startsWith(prefix));
}

export function parseDevResetRequest(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
): DevResetRequest {
  const args = argv.slice(2);
  const known = new Set(["--dry-run", "--yes"]);
  if (
    args.some((arg) => !known.has(arg)) ||
    new Set(args).size !== args.length
  ) {
    throw new DevResetError("dev_reset_arguments_invalid");
  }
  if (environment["NODE_ENV"]?.trim() === "production") {
    throw new DevResetError("dev_reset_forbidden_in_production");
  }
  const databaseUrl = environment["DATABASE_URL"]?.trim() ?? "";
  if (databaseUrl === "") {
    throw new DevResetError("dev_reset_database_unconfigured");
  }
  const databaseName = databaseNameFromUrl(databaseUrl);
  if (!isAllowedDatabaseName(databaseName)) {
    throw new DevResetError("dev_reset_database_name_refused", databaseName);
  }
  return {
    databaseUrl,
    databaseName,
    execute: args.includes("--yes") && !args.includes("--dry-run"),
  };
}

export interface StepResult {
  readonly step: ResetStep;
  readonly rows: number;
}

export interface DevResetReport {
  readonly databaseName: string;
  readonly executed: boolean;
  readonly sentinelUserId: string | null;
  readonly results: readonly StepResult[];
  readonly retainedLoopUsers: number;
}

interface Queryable {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

async function assertClassified(client: Queryable): Promise<void> {
  const result = await client.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = 'public' order by 1",
  );
  const missing = result.rows
    .map((row) => row.tablename)
    .filter((name) => tableClassification[name] === undefined);
  if (missing.length > 0) {
    throw new DevResetError("dev_reset_unclassified_tables", missing.join(","));
  }
}

async function assertDatabaseName(client: Queryable): Promise<void> {
  const result = await client.query<{ name: string }>(
    "select current_database() as name",
  );
  const name = result.rows[0]?.name ?? "";
  if (!isAllowedDatabaseName(name)) {
    throw new DevResetError("dev_reset_database_name_refused", name);
  }
}

function countSql(step: ResetStep): string {
  return `select count(*)::text as n from public.${quote(step.table)} where ${step.where}`;
}

function executeSql(step: ResetStep): string {
  return step.action === "delete"
    ? `delete from public.${quote(step.table)} where ${step.where}`
    : `update public.${quote(step.table)} set ${step.set ?? ""} where ${step.where}`;
}

/**
 * Every foreign key to `loop_users` (except the append-only `ops_audit`)
 * must point at the sentinel once the reset ran. Catches a new user column a
 * future migration adds to a kept table.
 */
async function assertNoDanglingUserReferences(
  client: Queryable,
): Promise<void> {
  const keys = await client.query<{ table_name: string; column_name: string }>(
    `select distinct con.conrelid::regclass::text as table_name, a.attname as column_name
     from pg_constraint as con
     cross join lateral unnest(con.conkey, con.confkey) as k(child, parent)
     join pg_attribute as parent
       on parent.attrelid = con.confrelid and parent.attnum = k.parent and parent.attname = 'id'
     join pg_attribute as a on a.attrelid = con.conrelid and a.attnum = k.child
     where con.contype = 'f' and con.confrelid = 'public.loop_users'::regclass
     order by 1, 2`,
  );
  const offenders: string[] = [];
  for (const key of keys.rows) {
    const table = key.table_name.replace(/^public\./u, "");
    if (table === "ops_audit") {
      continue;
    }
    const result = await client.query<{ n: string }>(
      `select count(*)::text as n from public.${quote(table)}
       where ${ownedBy(quote(key.column_name))}`,
    );
    if (result.rows[0]?.n !== "0") {
      offenders.push(`${table}.${key.column_name}=${result.rows[0]?.n}`);
    }
  }
  if (offenders.length > 0) {
    throw new DevResetError(
      "dev_reset_dangling_user_reference",
      offenders.join(","),
    );
  }
}

async function touchedTriggers(
  client: Queryable,
): Promise<readonly { table: string; trigger: string }[]> {
  const tables = [...new Set(allSteps.map((step) => step.table))];
  const result = await client.query<{ table_name: string; tgname: string }>(
    `select c.relname as table_name, t.tgname
     from pg_trigger as t
     join pg_class as c on c.oid = t.tgrelid
     join pg_namespace as n on n.oid = c.relnamespace
     where n.nspname = 'public' and not t.tgisinternal and t.tgenabled <> 'D'
       and c.relname = any($1::text[])
     order by 1, 2`,
    [tables],
  );
  return result.rows.map((row) => ({
    table: row.table_name,
    trigger: row.tgname,
  }));
}

export async function runDevReset(
  client: Queryable,
  request: Pick<DevResetRequest, "databaseName" | "execute">,
): Promise<DevResetReport> {
  await assertDatabaseName(client);
  await assertClassified(client);
  const results: StepResult[] = [];
  if (!request.execute) {
    await client.query(
      "begin transaction isolation level repeatable read read only",
    );
    try {
      for (const step of allSteps) {
        const result = await client.query<{ n: string }>(countSql(step));
        results.push({ step, rows: Number(result.rows[0]?.n ?? "0") });
      }
      const sentinel = await client.query<{ id: string }>(
        `select id::text from public.loop_users where privy_user_id = $1`,
        [sentinelPrivyUserId],
      );
      const retained = await client.query<{ n: string }>(
        `select count(*)::text as n from public.loop_users
         where privy_user_id = $1 or id in ${auditActors}`,
        [sentinelPrivyUserId],
      );
      await client.query("commit");
      return {
        databaseName: request.databaseName,
        executed: false,
        sentinelUserId: sentinel.rows[0]?.id ?? null,
        results,
        retainedLoopUsers: Number(retained.rows[0]?.n ?? "0"),
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }

  await client.query("begin");
  try {
    await client.query("set local lock_timeout = '15s'");
    await client.query("set local statement_timeout = 0");
    const inserted = await client.query<{ id: string }>(
      `insert into public.loop_users (privy_user_id) values ($1)
       on conflict (privy_user_id) do nothing returning id::text`,
      [sentinelPrivyUserId],
    );
    const sentinel = await client.query<{ id: string }>(
      `select id::text from public.loop_users where privy_user_id = $1`,
      [sentinelPrivyUserId],
    );
    const sentinelUserId = sentinel.rows[0]?.id ?? inserted.rows[0]?.id;
    if (sentinelUserId === undefined) {
      throw new DevResetError("dev_reset_failed", "sentinel user missing");
    }
    const triggers = await touchedTriggers(client);
    for (const { table, trigger } of triggers) {
      await client.query(
        `alter table public.${quote(table)} disable trigger ${quote(trigger)}`,
      );
    }
    for (const step of allSteps) {
      const result = await client.query(executeSql(step));
      results.push({ step, rows: result.rowCount ?? 0 });
    }
    await client.query("set constraints all immediate");
    for (const { table, trigger } of triggers) {
      await client.query(
        `alter table public.${quote(table)} enable trigger ${quote(trigger)}`,
      );
    }
    await assertNoDanglingUserReferences(client);
    const retained = await client.query<{ n: string }>(
      "select count(*)::text as n from public.loop_users",
    );
    await client.query("commit");
    return {
      databaseName: request.databaseName,
      executed: true,
      sentinelUserId,
      results,
      retainedLoopUsers: Number(retained.rows[0]?.n ?? "0"),
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

export function formatDevResetReport(report: DevResetReport): string {
  const lines: string[] = [];
  lines.push(
    report.executed
      ? `dev:reset-users EXECUTED on ${report.databaseName}`
      : `dev:reset-users PLAN (dry run, nothing changed) for ${report.databaseName}`,
  );
  const verb = report.executed ? "" : "would ";
  lines.push("");
  lines.push("Mixed rows kept, user columns rewritten:");
  for (const { step, rows } of report.results.filter((r) =>
    mixedSteps.includes(r.step),
  )) {
    lines.push(
      `  ${step.table.padEnd(40)} ${verb}update ${String(rows).padStart(8)}  ${step.label}`,
    );
  }
  lines.push("");
  lines.push("User-rooted rows:");
  for (const { step, rows } of report.results.filter((r) =>
    deleteSteps.includes(r.step),
  )) {
    lines.push(
      `  ${step.table.padEnd(40)} ${verb}delete ${String(rows).padStart(8)}`,
    );
  }
  lines.push("");
  lines.push("Counters:");
  for (const { step, rows } of report.results.filter((r) =>
    finalSteps.includes(r.step),
  )) {
    lines.push(
      `  ${step.table.padEnd(40)} ${verb}update ${String(rows).padStart(8)}  ${step.label}`,
    );
  }
  const total = report.results
    .filter((r) => r.step.action === "delete")
    .reduce((sum, r) => sum + r.rows, 0);
  lines.push("");
  lines.push(
    `Total rows ${report.executed ? "deleted" : "to delete"}: ${total}`,
  );
  lines.push(
    `Platform tables untouched: ${Object.entries(tableClassification)
      .filter(([, kind]) => kind === "platform")
      .map(([name]) => name)
      .join(", ")}`,
  );
  lines.push(
    `Sentinel user (privy_user_id ${sentinelPrivyUserId}, cannot log in): ${
      report.sentinelUserId ?? (report.executed ? "?" : "created on --yes")
    }`,
  );
  lines.push(
    `loop_users ${report.executed ? "left" : "kept"}: ${report.retainedLoopUsers} ` +
      `(sentinel + ops_audit actors retired as ${retiredPrivyUserIdPrefix}<id>; ops_audit is append-only and references them)`,
  );
  lines.push(
    "Stream: not touched. Stream user IDs derive from LOOP user IDs; new users get new Stream users on first login, old ones are inert.",
  );
  lines.push(
    "Stream caveat: community channel sync acts as the channel creator, now the sentinel, which has no Stream user (Decision 0113, Stream).",
  );
  if (!report.executed) {
    lines.push("");
    lines.push("Run again with --yes to execute.");
  }
  return `${lines.join("\n")}\n`;
}

interface OutputWriter {
  readonly write: (contents: string) => unknown;
}

export interface RunDevResetUsersOptions {
  readonly argv: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly stdout: OutputWriter;
  readonly stderr: OutputWriter;
}

export async function runDevResetUsers(
  options: RunDevResetUsersOptions,
): Promise<number> {
  let request: DevResetRequest;
  try {
    request = parseDevResetRequest(options.argv, options.environment);
  } catch (error) {
    const message =
      error instanceof DevResetError ? error.message : "dev_reset_failed";
    options.stderr.write(`dev:reset-users refused (${message})\n`);
    return 1;
  }
  const client = new pg.Client({
    application_name: "loop-api-dev-reset-users",
    connectionString: request.databaseUrl,
  });
  try {
    await client.connect();
    const report = await runDevReset(client, request);
    options.stdout.write(formatDevResetReport(report));
    return 0;
  } catch (error) {
    const message =
      error instanceof DevResetError
        ? error.message
        : `dev_reset_failed: ${error instanceof Error ? error.message : String(error)}`;
    options.stderr.write(
      `dev:reset-users failed (${message}); nothing was changed\n`,
    );
    return 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

const directEntryPoint = process.argv[1];

if (
  directEntryPoint !== undefined &&
  resolve(directEntryPoint) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runDevResetUsers({
    argv: process.argv,
    environment: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
