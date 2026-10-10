# Decision 0113: Development user data reset for the Privy app switch (S133)

- Status: Accepted (S133-api), Development / test databases only
- Date: 2026-10-10
- Baseline: `integration/v2` = `91b45a7`
- Inputs: main-agent S133 task; docs/14 §8 (new Privy app, every stored
  Privy user ID becomes void); Decisions 0102 / 0109 (append-only
  `admin_audit_log`, console accounts never deleted), 0108 (`ops_audit`
  append-only, operators are LOOP users).
- Scope: `scripts/dev-reset-users.ts` (`pnpm dev:reset-users`),
  `ops/dev-reset-users.sh` (outside this repository, in `LOOP/ops`). No
  migration, no route, no OpenAPI change, no environment key.

## What it does

LOOP moves to a new Privy app, so no stored `loop_users.privy_user_id` can
ever sign in again. Every row that exists only because of a LOOP user is
deleted; platform data stays. New sign-ins create new users.

```sh
pnpm dev:reset-users            # plan only (row counts, READ ONLY transaction)
pnpm dev:reset-users --dry-run  # same
pnpm dev:reset-users --yes      # execute (one transaction)
ops/dev-reset-users.sh          # dev stack: plan, type RESET, execute
```

## Safety locks

| Lock                  | Behaviour                                                                                                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV=production` | Refused before connecting (`dev_reset_forbidden_in_production`).                                                                                                                                                                        |
| Database name         | `DATABASE_URL` path **and** `current_database()` must start with `loop_api_dev` or `loop_api_test` (`dev_reset_database_name_refused`). Staging (`loop_api`) and production names fail.                                                 |
| No `--yes`            | Plan only; `--dry-run` wins over `--yes`. Counts come from the same predicates the execution uses, in a `READ ONLY` transaction.                                                                                                        |
| Unclassified table    | Every public table must be listed in `tableClassification`; a new migration that adds a table stops the script (`dev_reset_unclassified_tables`) until it is classified. A unit test also pins the list to `requiredDatabaseRelations`. |
| One transaction       | Any failure rolls everything back (`nothing was changed`).                                                                                                                                                                              |
| Foreign keys stay on  | Only the user-defined guard triggers of the touched tables are disabled (`ALTER TABLE … DISABLE TRIGGER <name>`, transactional) and re-enabled before commit. FK checks are never bypassed.                                             |
| Post-condition        | Before commit, every foreign-key column to `loop_users` (except `ops_audit.actor_id`) must hold only the sentinel or null (`dev_reset_dangling_user_reference`).                                                                        |
| `lock_timeout = 15s`  | The dev API keeps running; `ALTER TABLE` waits at most 15 s for in-flight queries, then fails and rolls back.                                                                                                                           |

## Table classification (140 tables)

**User-rooted (97) — every row deleted** (child before parent along every
foreign key):

- Identity / devices / settings: `loop_users` (except the sentinel and retired
  audit actors, below), `account_settings`, `user_profiles`,
  `profile_activation_commands`, `privacy_preferences`,
  `privacy_preferences_v2`, `social_privacy_preferences`, `device_sessions`,
  `device_session_commands`, `device_session_events`, `device_push_tokens`,
  `device_push_token_commands`, `push_deliveries`, `idempotency_records`.
- Social and chat: `follow_edges`, `user_blocks`, `social_graph_events`,
  `friend_requests`, `friendships`, `social_operations`,
  `social_operation_events`, `chat_operations`, `chat_operation_events`,
  `communication_groups`, `communication_group_members`,
  `communication_group_events`, `chat_group_membership_events`,
  `group_alias_reservations`, `direct_channels`. (Group chats have no
  platform owner, so the five group tables are emptied whole.)
- Community participation: `community_memberships`,
  `community_channel_members`, `community_channel_sync_jobs`,
  `community_channel_personas`, `community_member_buy_events`,
  `community_ai_usage`, `community_ai_answers`,
  `community_ai_answer_reports`, `voice_rooms` (user-started rooms),
  `voice_room_members`, `voice_room_hand_raises`, `voice_room_events`.
- Watchlists / alerts / notifications / support / referral:
  `watchlist_versions`, `watchlist_groups`, `watchlist_items`,
  `price_alert_definitions`, `price_alert_events`,
  `notification_preference_versions`, `notification_preferences`,
  `notification_preference_v2_versions`, `notification_preferences_v2`,
  `notifications`, `support_tickets`, `support_ticket_events`,
  `invite_codes`, `referral_edges`, `referral_events`.
- Wallets and provider operations: `account_wallets`,
  `wallet_balance_snapshots`, `approval_observations`, `wallet_intents`,
  `wallet_intent_events`, `swap_quotes`, `provider_operations`,
  `audit_events` (owner-scoped provider audit; its FK to
  `provider_operations` makes it user-rooted), frozen Hyperliquid tables
  `perp_*` (7), `spot_*` (6), `hyperliquid_signer_nonce_allocations`.
- Launch participation and project-side Hooks config: `launch_intents`,
  `purchase_records`, `entitlements`, `refund_liabilities`, `refund_claims`,
  `launch_settlement_records`, `hooks_launch_project_config_versions`,
  `hooks_launch_config_approvals`, `hooks_testnet_acceptances`,
  `hooks_launch_deployment_tasks`, `hooks_launch_deployment_authorizations`,
  `hooks_launch_submission_commands`.
- Mining user rows: `mining_snapshot_powers`, `mining_reward_ledger`.
- MEME: `meme_intents`.
- Operators (keyed by `loop_users`): `ops_operators`, `ops_grants`,
  `ops_operations`.

**Mixed (8) — platform rows stay, the user column is rewritten:**

| Table                   | Column(s)                                                                  | Handling                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `communities`           | `created_by_user_id` (NOT NULL)                                            | → sentinel. `member_count` recomputed (the membership counter trigger is off during the reset; all memberships are gone, so 0). Pending communities become invisible in the app (no member, owner cannot log in) but stay in the console.                                                                                                                |
| `community_channels`    | `created_by_user_id` (NOT NULL)                                            | → sentinel.                                                                                                                                                                                                                                                                                                                                              |
| `community_role_events` | `actor_user_id`, `target_user_id`, `idempotency_record_id`                 | Rows naming a user are deleted; operator rows (both null) stay.                                                                                                                                                                                                                                                                                          |
| `media_objects`         | `owner_user_id` (NOT NULL)                                                 | Objects still referenced by `meme_tokens.image_media_id` or `communities.logo_ref = logo:media/<id>` → sentinel; every other object (avatars) is deleted.                                                                                                                                                                                                |
| `meme_tokens`           | `creator_user_id` (NOT NULL), `creator_wallet_id`, `idempotency_record_id` | `creator_user_id` → sentinel; `creator_wallet_id` and `idempotency_record_id` → null. `creator_wallet` (on-chain address fact) stays.                                                                                                                                                                                                                    |
| `launch_projects`       | `owner_user_id` (NOT NULL)                                                 | → sentinel (`launches` reference the project and are platform).                                                                                                                                                                                                                                                                                          |
| `launch_review_events`  | `actor_user_id`, `idempotency_record_id`                                   | Applicant rows: `actor_user_id` → sentinel (the pairing check needs a value); `idempotency_record_id` → null. Operator rows untouched.                                                                                                                                                                                                                   |
| `admin_accounts`        | `operator_user_id`                                                         | Bound reviewer / testnet-acceptor accounts are disabled (`disabled_at = now`, `disabled_by = 'dev-reset'`, terminal per Decision 0109) and `operator_user_id` → sentinel (the binding check needs a value for those roles). Already disabled accounts keep their original `disabled_*`. Unbound accounts untouched. No `admin_audit_log` row is written. |

**Platform (35) — untouched:** `chains`, `assets`, `pools`,
`indexer_checkpoints`, `indexed_transfers`, `indexed_pool_events`,
`indexed_approvals`, `indexer_wallet_coverage` (per-address index
bookkeeping, no user ID), `market_fact_cache`, `token_logo_cache`,
`community_channel_activity`, `community_feed_cursors`,
`community_mining_weights`, `community_review_notes`, `launches`,
`launch_configs`, `launch_rounds`, `launch_allowlists`,
`launch_round_allowlist_roots`, `launch_indexed_events`,
`venue_milestones`, `mining_formula_versions`, `mining_snapshots` (totals
now describe deleted users; historic), `meme_indexed_events`,
`meme_trades`, `meme_holders`, `meme_salts` (chain facts keyed by address),
`issuance_rate_records` (HMAC subjects, self-expiring windows),
`hyperliquid_signer_nonce_state`, `admin_settings` (recommended
communities, promotions, listing policy), `admin_login_attempts`,
`admin_account_commands`, `admin_audit_log`, `ops_audit`, `pgmigrations`.
`profile_code_sequence` is a sequence and is not reset.

## Sentinel and retired users

- Sentinel: one `loop_users` row with `privy_user_id =
'loop:system:retired-owner'`, created on the first `--yes` and reused
  afterwards. A Privy subject is always `did:privy:…`, so no token can ever
  resolve to it. It has no profile, wallet, session, or membership. Its ID is
  printed.
- Audit tables are never touched. `admin_audit_log` has no FK (Decision
  0109). `ops_audit.actor_id` **does** reference `loop_users` (`on delete
restrict`) and the table is append-only, so a user named there cannot be
  deleted: the reset keeps that `loop_users` row, rewrites its
  `privy_user_id` to `loop:retired:<id>` (cannot sign in) and deletes
  everything it owned. On the dev data set of 2026-10-10 no `ops_audit` row
  has an `actor_id` (all six are `admin_console` rows), so only the sentinel
  remains.

## Orphans found in dev

Dev holds 28 `provider_operations` rows (2026-09-09, `bsc/wallet_intent_*`)
whose `owner_user_id` and idempotency record no longer exist — written or
cleaned while foreign keys were bypassed. A plain `pg_dump | psql` of dev
therefore fails. The reset treats any user reference other than the
sentinel as user data, so these rows are removed too.

## Stream

Not touched. Stream user IDs derive from LOOP user IDs; new users get new
Stream users on first login, the old ones are inert.

Open risk (main-agent decision): the community channel sync worker
(`src/community-channel-sync-worker.ts`, `upsertCommunityChannel` /
`addMembers` / `removeMembers`) acts as `deriveStreamUserId(
community_channels.created_by_user_id)`. After the reset that is the
sentinel, which has no Stream user (the Stream users backfill only covers
activated profiles). If Stream refuses an acting user that does not exist,
every new member sync in the 36 existing community channels fails until a
Stream user `deriveStreamUserId(<sentinel id>)` exists. Remedy options: a
one-off Stream upsert of the sentinel (one API call, not done here per the
task), or let the worker act as the server without `user_id`.

## Error codes (script)

`dev_reset_arguments_invalid`, `dev_reset_database_unconfigured`,
`dev_reset_forbidden_in_production`, `dev_reset_database_name_refused`,
`dev_reset_unclassified_tables`, `dev_reset_dangling_user_reference`,
`dev_reset_failed`. Exit code 1 on any of them, 0 on plan or success.

## Verification

- Unit `test/dev-reset-users-script.test.ts`: classification equals the
  schema tables (+ `pgmigrations`, − the sequence); every user table is
  deleted, no step touches a platform or audit table, `loop_users` last;
  argument and safety-lock refusals; refusal before connecting.
- Integration `test/dev-reset-users.integration.test.ts` (throwaway
  `loop_api_test_s133_<hex>` from `DATABASE_URL_TEST`): fixture with every
  mixed table, Hooks config version + approval, operator with an `ops_api`
  audit row (retired path), console reviewer + auditor, mining snapshot
  powers, MEME trades / holders, launch sale. Refusals change nothing; an
  unclassified table blocks; plan changes nothing; execution empties every
  user table (loop_users = sentinel + retired actor), keeps every platform
  and mixed row count, rewrites the mixed columns, restores the trigger
  states (and they still guard); a second run is a no-op.
- Manual: a schema + data copy of `loop_api_dev` (`pg_dump --disable-triggers`
  into `loop_api_test_s133_devclone`, dropped afterwards) — 389,921 rows
  deleted in ~1.5 s, second run 0; a read-only plan against `loop_api_dev`
  itself matches. Nothing was executed on `loop_api_dev`.
