import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0128 (S156): testnet faucet grants.
 *
 * - `testnet_faucet_grants`: one row per accepted `POST /v2/testnet/faucet`
 *   (tBNB transfer + MockUSD1 mint from the operator key to the caller's
 *   embedded wallet). The cooldown key is the lower-case `address`; it is
 *   never a primary or foreign key. `pending` is written before anything is
 *   signed; `granted` / `partial` / `unknown` / `failed` are final.
 * - `idempotency_records.digest_version` admits `testnet_faucet_grant_v1`.
 */

const digestVersionsBefore = [
  "sha256_v1",
  "perp_intent_request_v1",
  "perp_agent_authorization_issue_v1",
  "price_alert_create_v1",
  "spot_intent_request_v1",
  "spot_agent_authorization_issue_v1",
  "social_command_v1",
  "chat_channel_command_v1",
  "community_command_v1",
  "social_graph_command_v1",
  "communication_command_v1",
  "price_alert_create_v2",
  "launch_command_v1",
  "referral_command_v1",
  "support_ticket_create_v1",
  "community_ai_ask_v1",
  "community_ai_report_v1",
  "launch_intent_v1",
  "meme_token_create_v1",
  "meme_intent_v1",
  "launch2_intent_v1",
  "mining_claim_prepare_v1",
  "mining_claim_report_v1",
] as const;

function list(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

const hash = (column: string): string =>
  `${column} text check (${column} ~ '^0x[0-9a-f]{64}$')`;

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.idempotency_records
      drop constraint idempotency_records_digest_version_check;
    alter table public.idempotency_records
      add constraint idempotency_records_digest_version_check
      check (digest_version in (${list([
        ...digestVersionsBefore,
        "testnet_faucet_grant_v1",
      ])}));

    create table public.testnet_faucet_grants (
      grant_id uuid primary key,
      owner_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      idempotency_record_id uuid not null unique
        references public.idempotency_records(id) on delete restrict,
      wallet_id uuid not null
        references public.account_wallets(wallet_id) on delete restrict,
      address text not null check (address ~ '^0x[0-9a-f]{40}$'),
      chain_id text not null check (chain_id = 'eip155:97'),
      bnb_amount text not null check (bnb_amount ~ '^(0|[1-9][0-9]{0,17})(\\.[0-9]{1,18})?$'),
      bnb_amount_raw numeric(78, 0) not null check (bnb_amount_raw > 0),
      usd1_amount text not null check (usd1_amount ~ '^(0|[1-9][0-9]{0,17})(\\.[0-9]{1,18})?$'),
      usd1_amount_raw numeric(78, 0) not null check (usd1_amount_raw > 0),
      usd1_token_address text not null
        check (usd1_token_address ~ '^0x[0-9a-f]{40}$'),
      operator_address text not null
        check (operator_address ~ '^0x[0-9a-f]{40}$'),
      status text not null default 'pending' check (status in (
        'pending', 'granted', 'partial', 'unknown', 'failed')),
      ${hash("bnb_tx")},
      ${hash("usd1_tx")},
      failure_reason_code text
        check (failure_reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
      granted_at timestamptz not null default clock_timestamp(),
      completed_at timestamptz,
      updated_at timestamptz not null default clock_timestamp(),
      constraint testnet_faucet_grants_final_shape check (
        (status = 'pending') = (completed_at is null)),
      constraint testnet_faucet_grants_granted_shape check (
        status <> 'granted' or (bnb_tx is not null and usd1_tx is not null)),
      constraint testnet_faucet_grants_sent_shape check (
        status not in ('partial', 'unknown') or bnb_tx is not null),
      constraint testnet_faucet_grants_failure_shape check (
        (status in ('partial', 'unknown', 'failed'))
          = (failure_reason_code is not null)),
      constraint testnet_faucet_grants_timestamp_check check (
        updated_at >= granted_at
        and (completed_at is null or completed_at >= granted_at))
    );
    create index testnet_faucet_grants_address_idx
      on public.testnet_faucet_grants (address, granted_at desc, grant_id desc);
    create index testnet_faucet_grants_owner_idx
      on public.testnet_faucet_grants (owner_user_id, granted_at desc);

    comment on table public.testnet_faucet_grants is
      'Decision 0128: testnet faucet grants (tBNB + MockUSD1) to embedded wallets; the cooldown is per lower-case address.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    drop table public.testnet_faucet_grants;
    delete from public.idempotency_records
      where digest_version = 'testnet_faucet_grant_v1';
    alter table public.idempotency_records
      drop constraint idempotency_records_digest_version_check;
    alter table public.idempotency_records
      add constraint idempotency_records_digest_version_check
      check (digest_version in (${list(digestVersionsBefore)}));
  `);
}
