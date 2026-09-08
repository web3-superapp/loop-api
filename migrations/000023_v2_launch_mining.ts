import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0036: Launch off-chain catalog, Mining skeleton, and referral graph
 * (S7 / D17 + D18 slots + D19).
 *
 * The 02 contract document has not been provided, so every on-chain Launch
 * fact is a slot: `launches` stores the four-axis projection columns but a
 * check constraint pins each axis to `unavailable`, `contract_address` stays
 * null, and the Intent, purchase, entitlement, and refund relations exist as
 * structure only (no route writes them). Every mutable rule row carries a
 * `config_version` and an `effective_at`; every amount is `numeric(78, 0)` or
 * a canonical decimal string; nothing is a JavaScript number.
 *
 * Mining: `mining_formula_versions` is seeded with `miningFormulaV1-draft`
 * as `pending_approval`. Its formula document carries rule *text* only (no
 * weight numbers, no reward promise); the snapshot lane is idle until an
 * `approved` row exists, which only `pnpm mining:approve-formula --confirm`
 * (refused in production) can create.
 *
 * Referral: one invite code per account (`LOOP-` + 4 Crockford Base32 +
 * 1 check symbol), append-only edges with depth 1..5, and an append-only
 * audit relation.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.idempotency_records
      drop constraint idempotency_records_digest_version_check;
    alter table public.idempotency_records
      add constraint idempotency_records_digest_version_check
      check (digest_version in (
        'sha256_v1',
        'perp_intent_request_v1',
        'perp_agent_authorization_issue_v1',
        'price_alert_create_v1',
        'spot_intent_request_v1',
        'spot_agent_authorization_issue_v1',
        'social_command_v1',
        'chat_channel_command_v1',
        'community_command_v1',
        'social_graph_command_v1',
        'communication_command_v1',
        'price_alert_create_v2',
        'launch_command_v1',
        'referral_command_v1'
      ));

    -- ------------------------------------------------------------------
    -- Launch: off-chain project catalog and review
    -- ------------------------------------------------------------------

    create table public.launch_projects (
      project_id uuid primary key,
      owner_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      name text not null,
      ticker text not null,
      narrative text,
      official_links jsonb not null default '{}'::jsonb,
      material_version integer not null default 1,
      review_status text not null default 'draft',
      kyb_status text not null default 'unavailable',
      review_reason_code text,
      submitted_at timestamptz,
      reviewed_at timestamptz,
      record_version bigint not null default 1,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint launch_projects_name_check
        check (char_length(name) between 1 and 80 and name = btrim(name)),
      constraint launch_projects_ticker_check
        check (ticker ~ '^[A-Z0-9]{2,12}$'),
      constraint launch_projects_narrative_check
        check (narrative is null or char_length(narrative) between 1 and 2000),
      constraint launch_projects_links_check
        check (jsonb_typeof(official_links) = 'object'),
      constraint launch_projects_material_version_check
        check (material_version >= 1),
      constraint launch_projects_review_status_check
        check (review_status in (
          'draft', 'submitted', 'in_review', 'returned', 'approved', 'rejected'
        )),
      constraint launch_projects_kyb_status_check
        check (kyb_status in ('pending', 'unavailable')),
      constraint launch_projects_review_reason_check
        check (
          review_reason_code is null
          or review_reason_code ~ '^[a-z][a-z0-9_]{0,63}$'
        ),
      constraint launch_projects_submitted_check
        check (review_status = 'draft' or submitted_at is not null),
      constraint launch_projects_record_version_check
        check (record_version >= 1),
      constraint launch_projects_timestamp_check
        check (updated_at >= created_at)
    );

    create index launch_projects_owner_idx
      on public.launch_projects (owner_user_id, created_at desc, project_id desc);
    create index launch_projects_status_idx
      on public.launch_projects (review_status, created_at desc);

    comment on table public.launch_projects is
      'Launch application catalog (Decision 0036). A project is off-chain material with a review state; it is never the on-chain launch. KYB and attachments have no Provider and stay unavailable.';

    create table public.launch_review_events (
      event_id uuid primary key default gen_random_uuid(),
      project_id uuid not null
        references public.launch_projects(project_id) on delete restrict,
      actor_type text not null,
      actor_user_id uuid
        references public.loop_users(id) on delete restrict,
      event_type text not null,
      from_status text,
      to_status text not null,
      reason_code text,
      idempotency_record_id uuid
        references public.idempotency_records(id) on delete restrict,
      request_id uuid,
      occurred_at timestamptz not null default clock_timestamp(),
      constraint launch_review_events_idempotency_unique
        unique (idempotency_record_id),
      constraint launch_review_events_actor_type_check
        check (actor_type in ('applicant', 'operator')),
      constraint launch_review_events_actor_pairing_check
        check (
          (actor_type = 'applicant' and actor_user_id is not null)
          or (actor_type = 'operator' and actor_user_id is null)
        ),
      constraint launch_review_events_type_check
        check (event_type in (
          'project_created',
          'project_updated',
          'project_submitted',
          'review_started',
          'project_approved',
          'project_returned',
          'project_rejected'
        )),
      constraint launch_review_events_status_check
        check (
          (from_status is null or from_status in (
            'draft', 'submitted', 'in_review', 'returned', 'approved', 'rejected'
          ))
          and to_status in (
            'draft', 'submitted', 'in_review', 'returned', 'approved', 'rejected'
          )
        ),
      constraint launch_review_events_reason_check
        check (reason_code is null or reason_code ~ '^[a-z][a-z0-9_]{0,63}$')
    );

    create index launch_review_events_project_idx
      on public.launch_review_events (project_id, occurred_at desc, event_id);

    comment on table public.launch_review_events is
      'Append-only Launch review audit. Operator rows come only from pnpm launch:review (refused in production); the Admin console with two-person review is a later module.';

    create function public.reject_launch_review_event_mutation()
    returns trigger
    language plpgsql
    as $function$
    begin
      raise exception 'launch_review_events are append-only'
        using errcode = '55000';
    end;
    $function$;

    create trigger launch_review_events_append_only
      before update or delete on public.launch_review_events
      for each row execute function public.reject_launch_review_event_mutation();

    -- ------------------------------------------------------------------
    -- Launch: on-chain projection slots
    -- ------------------------------------------------------------------

    create table public.launches (
      launch_id uuid primary key,
      project_id uuid not null
        references public.launch_projects(project_id) on delete restrict,
      chain_id text not null default 'eip155:56'
        references public.chains(chain_id) on delete restrict,
      contract_address text,
      config_digest text,
      schedule_status text not null default 'unscheduled',
      sale_state text not null default 'unavailable',
      entitlement_state text not null default 'unavailable',
      liquidity_state text not null default 'unavailable',
      operational_state text not null default 'unavailable',
      state_tuple_digest text,
      snapshot_block_number bigint,
      snapshot_block_hash text,
      record_version bigint not null default 1,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint launches_project_unique unique (project_id),
      constraint launches_contract_address_check
        check (contract_address is null or contract_address ~ '^0x[0-9a-f]{40}$'),
      constraint launches_config_digest_check
        check (config_digest is null or config_digest ~ '^[0-9a-f]{64}$'),
      constraint launches_schedule_status_check
        check (schedule_status in ('unscheduled', 'scheduled', 'live', 'ended')),
      -- The 02 contract document has not been provided: every axis is pinned
      -- to unavailable until a later migration widens the enum from 02.
      constraint launches_axes_unavailable_check
        check (
          sale_state = 'unavailable'
          and entitlement_state = 'unavailable'
          and liquidity_state = 'unavailable'
          and operational_state = 'unavailable'
        ),
      constraint launches_state_tuple_digest_check
        check (state_tuple_digest is null or state_tuple_digest ~ '^[0-9a-f]{64}$'),
      constraint launches_snapshot_block_check
        check (snapshot_block_number is null or snapshot_block_number >= 0),
      constraint launches_snapshot_hash_check
        check (snapshot_block_hash is null or snapshot_block_hash ~ '^0x[0-9a-f]{64}$'),
      constraint launches_snapshot_pairing_check
        check (
          (snapshot_block_number is null) = (snapshot_block_hash is null)
          and (state_tuple_digest is null or snapshot_block_number is not null)
        ),
      constraint launches_record_version_check check (record_version >= 1),
      constraint launches_timestamp_check check (updated_at >= created_at)
    );

    create index launches_schedule_idx
      on public.launches (schedule_status, created_at desc, launch_id desc);

    comment on table public.launches is
      'One catalog launch per approved project. The four on-chain axes (saleState, entitlementState, liquidityState, operationalState) and their stateTupleDigest / snapshot block are projection slots pinned to unavailable until the 02 contract baseline exists.';

    create table public.launch_configs (
      config_id uuid primary key default gen_random_uuid(),
      launch_id uuid not null
        references public.launches(launch_id) on delete restrict,
      config_version text not null,
      parameters jsonb not null default '{}'::jsonb,
      status text not null default 'pending_confirmation',
      effective_at timestamptz,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint launch_configs_version_unique unique (launch_id, config_version),
      constraint launch_configs_version_check
        check (config_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
      constraint launch_configs_parameters_check
        check (jsonb_typeof(parameters) = 'object'),
      constraint launch_configs_status_check
        check (status in ('pending_confirmation', 'confirmed')),
      constraint launch_configs_effective_check
        check (status <> 'confirmed' or effective_at is not null),
      constraint launch_configs_timestamp_check check (updated_at >= created_at)
    );

    create unique index launch_configs_one_confirmed_idx
      on public.launch_configs (launch_id)
      where status = 'confirmed';

    comment on table public.launch_configs is
      'Versioned Launch parameter slots (walletRoundCap, walletProjectCap, fee, soft/hard cap, TGE, vesting, tierModeV1). Nothing is confirmed in this step; the client renders pending_confirmation as 待确认.';

    create table public.launch_rounds (
      round_id uuid primary key default gen_random_uuid(),
      launch_id uuid not null
        references public.launches(launch_id) on delete restrict,
      round_index integer not null,
      config_version text not null,
      status text not null default 'pending_confirmation',
      starts_at timestamptz,
      ends_at timestamptz,
      price_usd1 text,
      eligibility_tier text,
      wallet_round_cap_raw numeric(78, 0),
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint launch_rounds_index_unique unique (launch_id, round_index),
      constraint launch_rounds_config_fk
        foreign key (launch_id, config_version)
        references public.launch_configs (launch_id, config_version)
        on delete restrict,
      constraint launch_rounds_index_check check (round_index >= 1),
      constraint launch_rounds_version_check
        check (config_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
      constraint launch_rounds_status_check
        check (status in ('pending_confirmation', 'confirmed')),
      constraint launch_rounds_window_check
        check (starts_at is null or ends_at is null or ends_at > starts_at),
      constraint launch_rounds_price_check
        check (price_usd1 is null or price_usd1 ~ '^(0|[1-9][0-9]{0,77})(\\.[0-9]{1,60})?$'),
      constraint launch_rounds_tier_check
        check (
          eligibility_tier is null
          or eligibility_tier in ('priority', 'community', 'public')
        ),
      constraint launch_rounds_cap_check
        check (wallet_round_cap_raw is null or wallet_round_cap_raw >= 0),
      constraint launch_rounds_timestamp_check check (updated_at >= created_at)
    );

    comment on table public.launch_rounds is
      'Round slots 1..N. Time, price, eligibility, and cap are nullable and carry status pending_confirmation until the project confirms them in writing.';

    -- ------------------------------------------------------------------
    -- Launch: Intent namespace and settlement records (structure only)
    -- ------------------------------------------------------------------

    create table public.launch_intents (
      intent_id uuid primary key,
      owner_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      wallet_id uuid not null
        references public.account_wallets(wallet_id) on delete restrict,
      launch_id uuid not null
        references public.launches(launch_id) on delete restrict,
      project_id uuid not null
        references public.launch_projects(project_id) on delete restrict,
      round_id uuid not null
        references public.launch_rounds(round_id) on delete restrict,
      chain_id text not null references public.chains(chain_id) on delete restrict,
      quote_asset_id text not null references public.assets(asset_id) on delete restrict,
      project_asset_id text not null references public.assets(asset_id) on delete restrict,
      direction text not null default 'buy',
      pay_amount_raw numeric(78, 0) not null,
      expected_receive_raw numeric(78, 0) not null,
      config_version text not null,
      wallet_cumulative_raw numeric(78, 0) not null,
      contract_address text not null,
      state_tuple_digest text not null,
      snapshot_block_number bigint not null,
      snapshot_block_hash text not null,
      payload_digest text not null,
      state text not null default 'prepared',
      expires_at timestamptz not null,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint launch_intents_direction_check check (direction = 'buy'),
      constraint launch_intents_amounts_check
        check (pay_amount_raw > 0 and expected_receive_raw >= 0 and wallet_cumulative_raw >= 0),
      constraint launch_intents_version_check
        check (config_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
      constraint launch_intents_contract_check
        check (contract_address ~ '^0x[0-9a-f]{40}$'),
      constraint launch_intents_tuple_check
        check (state_tuple_digest ~ '^[0-9a-f]{64}$'),
      constraint launch_intents_block_check check (snapshot_block_number >= 0),
      constraint launch_intents_hash_check
        check (snapshot_block_hash ~ '^0x[0-9a-f]{64}$'),
      constraint launch_intents_payload_digest_check
        check (payload_digest ~ '^[0-9a-f]{64}$'),
      constraint launch_intents_state_check
        check (state in (
          'prepared', 'awaiting_signature', 'submitted', 'confirmed',
          'reverted', 'failed', 'unknown', 'cancelled', 'expired'
        )),
      constraint launch_intents_expiry_check check (expires_at > created_at),
      constraint launch_intents_timestamp_check check (updated_at >= created_at)
    );

    create index launch_intents_owner_idx
      on public.launch_intents (owner_user_id, created_at desc, intent_id desc);

    comment on table public.launch_intents is
      'Launch purchase Intent namespace (03 §8.2), fully separate from wallet_intents. Structure only in Decision 0036: no route writes it while the contract baseline is pending. Pre-graduation sell/redeem has no approved definition and no column.';

    create table public.purchase_records (
      purchase_record_id uuid primary key default gen_random_uuid(),
      launch_id uuid not null
        references public.launches(launch_id) on delete restrict,
      round_id uuid
        references public.launch_rounds(round_id) on delete restrict,
      owner_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      wallet_id uuid not null
        references public.account_wallets(wallet_id) on delete restrict,
      intent_id uuid
        references public.launch_intents(intent_id) on delete restrict,
      quote_asset_id text not null references public.assets(asset_id) on delete restrict,
      paid_raw numeric(78, 0) not null,
      expected_tokens_raw numeric(78, 0) not null,
      transaction_hash text not null,
      log_index integer not null,
      block_number bigint not null,
      block_hash text not null,
      confirmation_state text not null default 'pending',
      removed boolean not null default false,
      observed_at timestamptz not null default clock_timestamp(),
      constraint purchase_records_tx_unique unique (transaction_hash, log_index),
      constraint purchase_records_amount_check
        check (paid_raw >= 0 and expected_tokens_raw >= 0),
      constraint purchase_records_hash_check
        check (transaction_hash ~ '^0x[0-9a-f]{64}$'),
      constraint purchase_records_log_check check (log_index >= 0),
      constraint purchase_records_block_check check (block_number >= 0),
      constraint purchase_records_block_hash_check
        check (block_hash ~ '^0x[0-9a-f]{64}$'),
      constraint purchase_records_confirmation_check
        check (confirmation_state in ('pending', 'confirmed', 'reorged'))
    );

    create index purchase_records_wallet_idx
      on public.purchase_records (launch_id, wallet_id, block_number desc, log_index desc);

    comment on table public.purchase_records is
      'Observed purchase facts (03 §8.3): USD1 actually received and expected project tokens per tx/log. A record is never an entitlement.';

    create table public.entitlements (
      entitlement_id uuid primary key default gen_random_uuid(),
      launch_id uuid not null
        references public.launches(launch_id) on delete restrict,
      owner_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      wallet_id uuid not null
        references public.account_wallets(wallet_id) on delete restrict,
      project_asset_id text not null references public.assets(asset_id) on delete restrict,
      total_raw numeric(78, 0) not null,
      claimed_raw numeric(78, 0) not null default 0,
      vesting_schedule jsonb,
      state text not null default 'frozen',
      frozen_at_block bigint,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint entitlements_wallet_unique unique (launch_id, wallet_id),
      constraint entitlements_amount_check
        check (total_raw >= 0 and claimed_raw >= 0 and claimed_raw <= total_raw),
      constraint entitlements_vesting_check
        check (vesting_schedule is null or jsonb_typeof(vesting_schedule) = 'object'),
      constraint entitlements_state_check
        check (state in ('frozen', 'partially_claimed', 'claimed')),
      constraint entitlements_block_check
        check (frozen_at_block is null or frozen_at_block >= 0),
      constraint entitlements_timestamp_check check (updated_at >= created_at)
    );

    comment on table public.entitlements is
      'Frozen project-token claim right, created only after saleState=SUCCEEDED with its vesting schedule. total_raw is not claimable; only matured, unclaimed amounts are.';

    create table public.refund_liabilities (
      refund_liability_id uuid primary key default gen_random_uuid(),
      launch_id uuid not null
        references public.launches(launch_id) on delete restrict,
      owner_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      wallet_id uuid not null
        references public.account_wallets(wallet_id) on delete restrict,
      quote_asset_id text not null references public.assets(asset_id) on delete restrict,
      amount_raw numeric(78, 0) not null,
      refunded_raw numeric(78, 0) not null default 0,
      state text not null default 'frozen',
      frozen_at_block bigint,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint refund_liabilities_wallet_unique unique (launch_id, wallet_id),
      constraint refund_liabilities_amount_check
        check (amount_raw >= 0 and refunded_raw >= 0 and refunded_raw <= amount_raw),
      constraint refund_liabilities_state_check
        check (state in ('frozen', 'partially_refunded', 'refunded')),
      constraint refund_liabilities_block_check
        check (frozen_at_block is null or frozen_at_block >= 0),
      constraint refund_liabilities_timestamp_check check (updated_at >= created_at)
    );

    comment on table public.refund_liabilities is
      'One wallet-level refund liability per launch + wallet, created only after saleState=FAILED/CANCELLED as 100% of the aggregated USD1 actually received. Never one per purchase.';

    create table public.refund_claims (
      refund_claim_id uuid primary key default gen_random_uuid(),
      refund_liability_id uuid not null
        references public.refund_liabilities(refund_liability_id) on delete restrict,
      wallet_id uuid not null
        references public.account_wallets(wallet_id) on delete restrict,
      amount_raw numeric(78, 0) not null,
      state text not null default 'requested',
      transaction_hash text,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint refund_claims_amount_check check (amount_raw >= 0),
      constraint refund_claims_state_check
        check (state in ('requested', 'submitted', 'confirmed', 'failed', 'unknown')),
      constraint refund_claims_hash_check
        check (transaction_hash is null or transaction_hash ~ '^0x[0-9a-f]{64}$'),
      constraint refund_claims_timestamp_check check (updated_at >= created_at)
    );

    create index refund_claims_liability_idx
      on public.refund_claims (refund_liability_id, created_at desc);

    -- ------------------------------------------------------------------
    -- Launch: external venue milestones
    -- ------------------------------------------------------------------

    create table public.venue_milestones (
      venue_milestone_id uuid primary key default gen_random_uuid(),
      project_id uuid not null
        references public.launch_projects(project_id) on delete restrict,
      venue text not null,
      market_type text not null,
      state text not null default 'PREPARING',
      evidence_digest text,
      evidence_recorded_at timestamptz,
      evidence_observed_at timestamptz,
      reviewer text,
      record_version bigint not null default 1,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint venue_milestones_unique unique (project_id, venue, market_type),
      constraint venue_milestones_venue_check
        check (venue in ('lbank', 'binance', 'bithumb')),
      constraint venue_milestones_market_check
        check (market_type in ('spot', 'alpha', 'perpetual')),
      constraint venue_milestones_state_check
        check (state in (
          'PREPARING', 'APPLIED', 'EVIDENCE_PENDING', 'LISTED', 'FEATURED',
          'REJECTED', 'DEFERRED', 'EVIDENCE_INVALID', 'DELISTED'
        )),
      constraint venue_milestones_evidence_digest_check
        check (evidence_digest is null or evidence_digest ~ '^[0-9a-f]{64}$'),
      constraint venue_milestones_evidence_pairing_check
        check (
          (evidence_digest is null) = (evidence_recorded_at is null)
          and (evidence_digest is null) = (reviewer is null)
        ),
      constraint venue_milestones_observed_check
        check (evidence_observed_at is null or evidence_digest is not null),
      constraint venue_milestones_listed_evidence_check
        check (state not in ('LISTED', 'FEATURED') or evidence_digest is not null),
      constraint venue_milestones_reviewer_check
        check (reviewer is null or reviewer ~ '^[a-z][a-z0-9_.-]{0,63}$'),
      constraint venue_milestones_record_version_check check (record_version >= 1),
      constraint venue_milestones_timestamp_check check (updated_at >= created_at)
    );

    comment on table public.venue_milestones is
      'Independent listing milestone per project + venue + market type (03 §8.4). LISTED and FEATURED require a verifiable evidence digest, time, and reviewer; Alpha never implies spot or perpetual. evidence_recorded_at is the server clock when the reviewer recorded it; evidence_observed_at is the operator-supplied platform time the evidence became verifiable (nullable).';

    -- ------------------------------------------------------------------
    -- Mining skeleton
    -- ------------------------------------------------------------------

    create table public.mining_formula_versions (
      config_version text primary key,
      formula jsonb not null,
      weight_range jsonb not null,
      price_guard_rules jsonb not null,
      status text not null default 'pending_approval',
      effective_at timestamptz,
      approved_at timestamptz,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint mining_formula_versions_version_check
        check (config_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
      constraint mining_formula_versions_formula_check
        check (jsonb_typeof(formula) = 'object'),
      constraint mining_formula_versions_weight_range_check
        check (jsonb_typeof(weight_range) = 'object'),
      constraint mining_formula_versions_guard_check
        check (jsonb_typeof(price_guard_rules) = 'array'),
      constraint mining_formula_versions_status_check
        check (status in ('pending_approval', 'approved', 'retired')),
      constraint mining_formula_versions_approval_check
        check (
          status <> 'approved'
          or (effective_at is not null and approved_at is not null)
        ),
      constraint mining_formula_versions_timestamp_check
        check (updated_at >= created_at)
    );

    create unique index mining_formula_versions_one_approved_idx
      on public.mining_formula_versions (status)
      where status = 'approved';

    comment on table public.mining_formula_versions is
      'Versioned Mining formula documents. Only one row may be approved at a time; the draft row carries rule text without weight numbers or reward promises (03 §19).';

    insert into public.mining_formula_versions (
      config_version, formula, weight_range, price_guard_rules, status
    ) values (
      'miningFormulaV1-draft',
      jsonb_build_object(
        'kind', 'holding_times_reference_price_times_weight',
        'expressionKey', 'mining.rules.formula.holdingTimesReferencePriceTimesWeight',
        'dailyOutputKey', 'mining.rules.dailyOutput.shareOfNetworkPower',
        'assetWeights', jsonb_build_object(),
        'referralBoost', jsonb_build_object('status', 'pending_approval')
      ),
      jsonb_build_object(
        'loop', jsonb_build_object('status', 'pending_approval', 'descriptionKey', 'mining.rules.weight.loopFixedMaximum'),
        'community', jsonb_build_object('status', 'pending_approval', 'descriptionKey', 'mining.rules.weight.communityReviewed'),
        'reviewFactorKeys', jsonb_build_array(
          'mining.rules.reviewFactor.communityQuality',
          'mining.rules.reviewFactor.communitySize',
          'mining.rules.reviewFactor.tokenLiquidity',
          'mining.rules.reviewFactor.projectQuality',
          'mining.rules.reviewFactor.marketStability',
          'mining.rules.reviewFactor.userQuality',
          'mining.rules.reviewFactor.loopPartnership'
        )
      ),
      jsonb_build_array(
        jsonb_build_object('ruleKey', 'mining.rules.priceGuard.twap', 'status', 'pending_approval'),
        jsonb_build_object('ruleKey', 'mining.rules.priceGuard.multiPeriodMultiSource', 'status', 'pending_approval'),
        jsonb_build_object('ruleKey', 'mining.rules.priceGuard.liquidityCap', 'status', 'pending_approval')
      ),
      'pending_approval'
    );

    create table public.community_mining_weights (
      community_id uuid primary key
        references public.communities(community_id) on delete restrict,
      status text not null default 'pending_review',
      weight text,
      config_version text
        references public.mining_formula_versions(config_version) on delete restrict,
      reviewed_at timestamptz,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint community_mining_weights_status_check
        check (status in ('pending_review', 'approved')),
      constraint community_mining_weights_weight_check
        check (weight is null or weight ~ '^(0|[1-9][0-9]{0,77})(\\.[0-9]{1,60})?$'),
      constraint community_mining_weights_approved_check
        check (
          status <> 'approved'
          or (weight is not null and config_version is not null and reviewed_at is not null)
        ),
      constraint community_mining_weights_timestamp_check
        check (updated_at >= created_at)
    );

    comment on table public.community_mining_weights is
      'Community Mining weight review state. The value is null while pending_review and only carries a decimal string once approved under a formula version.';

    create table public.mining_snapshots (
      snapshot_id uuid primary key,
      block_number bigint not null,
      block_hash text not null,
      formula_version text not null
        references public.mining_formula_versions(config_version) on delete restrict,
      price_version text not null,
      total_power text not null,
      account_count integer not null,
      computed_at timestamptz not null default clock_timestamp(),
      constraint mining_snapshots_block_check check (block_number >= 0),
      constraint mining_snapshots_hash_check
        check (block_hash ~ '^0x[0-9a-f]{64}$'),
      constraint mining_snapshots_price_version_check
        check (price_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$'),
      constraint mining_snapshots_total_power_check
        check (total_power ~ '^(0|[1-9][0-9]{0,77})(\\.[0-9]{1,60})?$'),
      constraint mining_snapshots_account_count_check check (account_count >= 0)
    );

    create index mining_snapshots_recent_idx
      on public.mining_snapshots (computed_at desc, snapshot_id desc);

    create table public.mining_snapshot_powers (
      snapshot_id uuid not null
        references public.mining_snapshots(snapshot_id) on delete cascade,
      owner_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      asset_id text not null references public.assets(asset_id) on delete restrict,
      holding text not null,
      reference_price_usd text not null,
      weight text not null,
      power text not null,
      block_number bigint not null,
      primary key (snapshot_id, owner_user_id, asset_id),
      constraint mining_snapshot_powers_decimal_check
        check (
          holding ~ '^(0|[1-9][0-9]{0,77})(\\.[0-9]{1,60})?$'
          and reference_price_usd ~ '^(0|[1-9][0-9]{0,77})(\\.[0-9]{1,60})?$'
          and weight ~ '^(0|[1-9][0-9]{0,77})(\\.[0-9]{1,60})?$'
          and power ~ '^(0|[1-9][0-9]{0,77})(\\.[0-9]{1,60})?$'
        ),
      constraint mining_snapshot_powers_block_check check (block_number >= 0)
    );

    create index mining_snapshot_powers_owner_idx
      on public.mining_snapshot_powers (owner_user_id, snapshot_id);

    comment on table public.mining_snapshots is
      'Server-computed Mining Power snapshots (snapshotId, block/hash, formula version, price version). Written only by the mining-snapshot lane and only under an approved formula.';

    create table public.mining_reward_ledger (
      entry_id uuid primary key default gen_random_uuid(),
      owner_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      snapshot_id uuid
        references public.mining_snapshots(snapshot_id) on delete restrict,
      amount_raw numeric(78, 0) not null,
      state text not null default 'estimated',
      settled_at timestamptz,
      claimed_at timestamptz,
      transaction_hash text,
      created_at timestamptz not null default clock_timestamp(),
      constraint mining_reward_ledger_amount_check check (amount_raw >= 0),
      constraint mining_reward_ledger_state_check
        check (state in ('estimated', 'settled', 'claimable', 'claimed', 'void')),
      constraint mining_reward_ledger_hash_check
        check (transaction_hash is null or transaction_hash ~ '^0x[0-9a-f]{64}$')
    );

    create index mining_reward_ledger_owner_idx
      on public.mining_reward_ledger (owner_user_id, created_at desc);

    comment on table public.mining_reward_ledger is
      'Reward ledger structure. claimable stays unavailable (REWARD_AUTHORITY_PENDING) until a reward authority and budget are approved; no route writes it.';

    -- ------------------------------------------------------------------
    -- Referral graph
    -- ------------------------------------------------------------------

    create table public.invite_codes (
      owner_user_id uuid primary key
        references public.loop_users(id) on delete restrict,
      code text not null,
      created_at timestamptz not null default clock_timestamp(),
      constraint invite_codes_code_unique unique (code),
      constraint invite_codes_code_check
        check (code ~ '^LOOP-[0-9A-HJKMNP-TV-Z]{5}$')
    );

    comment on table public.invite_codes is
      'One invite code per account: LOOP- plus four random Crockford Base32 symbols and one weighted check symbol. Random and unique; never sequential.';

    create table public.referral_edges (
      referral_edge_id uuid primary key default gen_random_uuid(),
      inviter_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      invitee_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      depth integer not null,
      validation_status text not null default 'pending_activation',
      locked_at timestamptz not null default clock_timestamp(),
      effective_from timestamptz not null default clock_timestamp(),
      effective_to timestamptz,
      config_version text not null default 'referralRulesV1',
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint referral_edges_invitee_depth_unique unique (invitee_user_id, depth),
      constraint referral_edges_self_check
        check (inviter_user_id <> invitee_user_id),
      constraint referral_edges_depth_check check (depth between 1 and 5),
      constraint referral_edges_status_check
        check (validation_status in (
          'pending_activation', 'pending_wallet', 'pending_mining', 'valid', 'invalidated'
        )),
      constraint referral_edges_interval_check
        check (effective_to is null or effective_to >= effective_from),
      constraint referral_edges_invalidated_check
        check (validation_status <> 'invalidated' or effective_to is not null),
      constraint referral_edges_version_check
        check (config_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
      constraint referral_edges_timestamp_check check (updated_at >= created_at)
    );

    create index referral_edges_inviter_idx
      on public.referral_edges (inviter_user_id, depth, validation_status);

    comment on table public.referral_edges is
      'Referral relationships. depth 1 is the direct binding (exactly one per invitee, locked at claim); depths 2..5 are materialised from the inviter chain. valid requires an approved Mining formula (D19).';

    create table public.referral_events (
      event_id uuid primary key default gen_random_uuid(),
      invitee_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      inviter_user_id uuid
        references public.loop_users(id) on delete restrict,
      event_type text not null,
      reason_code text,
      idempotency_record_id uuid
        references public.idempotency_records(id) on delete restrict,
      request_id uuid,
      occurred_at timestamptz not null default clock_timestamp(),
      constraint referral_events_idempotency_unique unique (idempotency_record_id),
      constraint referral_events_type_check
        check (event_type in (
          'invite_code_issued',
          'referral_claimed',
          'referral_claim_rejected',
          'edge_status_changed'
        )),
      constraint referral_events_reason_check
        check (reason_code is null or reason_code ~ '^[a-z][a-z0-9_]{0,63}$')
    );

    create index referral_events_invitee_idx
      on public.referral_events (invitee_user_id, occurred_at desc, event_id);

    create function public.reject_referral_event_mutation()
    returns trigger
    language plpgsql
    as $function$
    begin
      raise exception 'referral_events are append-only'
        using errcode = '55000';
    end;
    $function$;

    create trigger referral_events_append_only
      before update or delete on public.referral_events
      for each row execute function public.reject_referral_event_mutation();

    create function public.reject_referral_edge_delete()
    returns trigger
    language plpgsql
    as $function$
    begin
      raise exception 'referral_edges are append-only; invalidate instead of deleting'
        using errcode = '55000';
    end;
    $function$;

    create trigger referral_edges_append_only
      before delete on public.referral_edges
      for each row execute function public.reject_referral_edge_delete();
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $guard$
    begin
      if exists (select 1 from public.launch_projects)
        or exists (select 1 from public.referral_edges)
        or exists (select 1 from public.invite_codes)
        or exists (select 1 from public.mining_snapshots)
        or exists (
          select 1 from public.mining_formula_versions where status = 'approved'
        )
        or exists (
          select 1 from public.idempotency_records
          where digest_version in ('launch_command_v1', 'referral_command_v1')
        )
      then
        raise exception
          'refusing destructive rollback of v2 launch, mining, and referral data'
          using errcode = '55000';
      end if;
    end;
    $guard$;

    drop trigger referral_edges_append_only on public.referral_edges;
    drop function public.reject_referral_edge_delete();
    drop trigger referral_events_append_only on public.referral_events;
    drop function public.reject_referral_event_mutation();
    drop table public.referral_events;
    drop table public.referral_edges;
    drop table public.invite_codes;
    drop table public.mining_reward_ledger;
    drop table public.mining_snapshot_powers;
    drop table public.mining_snapshots;
    drop table public.community_mining_weights;
    drop table public.mining_formula_versions;
    drop table public.venue_milestones;
    drop table public.refund_claims;
    drop table public.refund_liabilities;
    drop table public.entitlements;
    drop table public.purchase_records;
    drop table public.launch_intents;
    drop table public.launch_rounds;
    drop table public.launch_configs;
    drop table public.launches;
    drop trigger launch_review_events_append_only on public.launch_review_events;
    drop function public.reject_launch_review_event_mutation();
    drop table public.launch_review_events;
    drop table public.launch_projects;

    alter table public.idempotency_records
      drop constraint idempotency_records_digest_version_check;
    alter table public.idempotency_records
      add constraint idempotency_records_digest_version_check
      check (digest_version in (
        'sha256_v1',
        'perp_intent_request_v1',
        'perp_agent_authorization_issue_v1',
        'price_alert_create_v1',
        'spot_intent_request_v1',
        'spot_agent_authorization_issue_v1',
        'social_command_v1',
        'chat_channel_command_v1',
        'community_command_v1',
        'social_graph_command_v1',
        'communication_command_v1',
        'price_alert_create_v2'
      ));
  `);
}
