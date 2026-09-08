import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0033: BSC chain registry, narrow indexer lane, wallet inventory,
 * and the V2 Watchlist asset identity column.
 *
 * Every canonical asset ID is `eip155:<chainId>:<0x lowercase address>` or
 * `eip155:<chainId>:native`. Symbols, names, and tickers are display facts and
 * never join records. Wallet addresses are normalised lowercase public chain
 * facts and never become an account or authorization key: `account_wallets`
 * issues an opaque `wallet_id` for that.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table public.chains (
      chain_id text primary key,
      namespace text not null,
      reference integer not null,
      name text not null,
      native_asset_id text not null,
      confirmations integer not null,
      reorg_depth_blocks integer not null,
      status text not null default 'enabled',
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint chains_chain_id_check
        check (chain_id ~ '^eip155:[1-9][0-9]{0,9}$'),
      constraint chains_namespace_check check (namespace = 'eip155'),
      constraint chains_reference_check check (reference > 0),
      constraint chains_identity_check
        check (chain_id = namespace || ':' || reference::text),
      constraint chains_name_check
        check (char_length(name) between 1 and 64 and name = btrim(name)),
      constraint chains_native_asset_check
        check (native_asset_id = chain_id || ':native'),
      constraint chains_confirmations_check
        check (confirmations between 1 and 1000),
      constraint chains_reorg_depth_check
        check (reorg_depth_blocks between 1 and 1000),
      constraint chains_status_check check (status in ('enabled', 'disabled')),
      constraint chains_timestamp_check check (updated_at >= created_at)
    );

    comment on table public.chains is
      'Enabled chain families. A row is configuration, never proof that an RPC endpoint is reachable or that its chain ID was verified.';

    insert into public.chains (
      chain_id,
      namespace,
      reference,
      name,
      native_asset_id,
      confirmations,
      reorg_depth_blocks
    )
    values ('eip155:56', 'eip155', 56, 'BNB Smart Chain', 'eip155:56:native', 15, 64);

    create table public.assets (
      asset_id text primary key,
      chain_id text not null references public.chains(chain_id) on delete restrict,
      address text,
      symbol text not null,
      name text not null,
      decimals integer not null,
      status text not null default 'pending',
      source_kind text not null,
      source_block_number bigint,
      source_verified_at timestamptz,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint assets_asset_id_check
        check (asset_id ~ '^eip155:[1-9][0-9]{0,9}:(native|0x[0-9a-f]{40})$'),
      constraint assets_address_check
        check (address is null or address ~ '^0x[0-9a-f]{40}$'),
      constraint assets_identity_check
        check (asset_id = chain_id || ':' || coalesce(address, 'native')),
      constraint assets_symbol_check
        check (
          char_length(symbol) between 1 and 32
          and symbol = btrim(symbol)
          and symbol !~ '[[:cntrl:]]'
        ),
      constraint assets_name_check
        check (
          char_length(name) between 1 and 128
          and name = btrim(name)
          and name !~ '[[:cntrl:]]'
        ),
      constraint assets_decimals_check check (decimals between 0 and 36),
      constraint assets_status_check
        check (status in ('pending', 'verified', 'blocked')),
      constraint assets_source_kind_check
        check (source_kind in ('chain_call', 'chain_native', 'operator_block')),
      constraint assets_source_block_check
        check (source_block_number is null or source_block_number >= 0),
      constraint assets_chain_call_evidence_check
        check (
          source_kind <> 'chain_call'
          or (source_block_number is not null and source_verified_at is not null)
        ),
      constraint assets_timestamp_check check (updated_at >= created_at)
    );

    comment on table public.assets is
      'Asset Registry. symbol/name/decimals come only from on-chain symbol()/name()/decimals() reads recorded with the observing block; a row is never evidence that an asset is tradable.';
    comment on column public.assets.status is
      'pending: on-chain identity read; verified: additionally confirmed against an official source; blocked: operator denial.';

    insert into public.assets (
      asset_id,
      chain_id,
      address,
      symbol,
      name,
      decimals,
      status,
      source_kind
    )
    values (
      'eip155:56:native',
      'eip155:56',
      null,
      'BNB',
      'BNB',
      18,
      'verified',
      'chain_native'
    );

    create table public.pools (
      pool_id uuid primary key default gen_random_uuid(),
      chain_id text not null references public.chains(chain_id) on delete restrict,
      protocol text not null,
      address text not null,
      token0_asset_id text not null references public.assets(asset_id) on delete restrict,
      token1_asset_id text not null references public.assets(asset_id) on delete restrict,
      fee integer not null,
      tick_spacing integer not null,
      status text not null default 'registered',
      source_block_number bigint not null,
      source_verified_at timestamptz not null,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint pools_address_unique unique (chain_id, address),
      constraint pools_protocol_check check (protocol = 'pancakeswap_v3'),
      constraint pools_address_check check (address ~ '^0x[0-9a-f]{40}$'),
      constraint pools_token_order_check
        check (token0_asset_id <> token1_asset_id),
      constraint pools_fee_check check (fee between 0 and 1000000),
      constraint pools_tick_spacing_check check (tick_spacing between 1 and 32767),
      constraint pools_status_check check (status in ('registered', 'blocked')),
      constraint pools_source_block_check check (source_block_number >= 0),
      constraint pools_timestamp_check check (updated_at >= created_at)
    );

    comment on table public.pools is
      'Registered PancakeSwap V3 pools whose token pair is already in the Asset Registry. Only registered pools are indexed; an unregistered pool is unavailable, never inferred.';

    create table public.indexer_checkpoints (
      lane text not null,
      chain_id text not null references public.chains(chain_id) on delete restrict,
      last_block_number bigint not null,
      last_block_hash text not null,
      started_from_block_number bigint not null,
      reorg_count integer not null default 0,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      primary key (lane, chain_id),
      constraint indexer_checkpoints_lane_check
        check (lane in ('erc20_transfer', 'pool_event')),
      constraint indexer_checkpoints_block_check
        check (last_block_number >= 0 and started_from_block_number >= 0),
      constraint indexer_checkpoints_block_hash_check
        check (last_block_hash ~ '^0x[0-9a-f]{64}$'),
      constraint indexer_checkpoints_reorg_count_check check (reorg_count >= 0),
      constraint indexer_checkpoints_timestamp_check
        check (updated_at >= created_at)
    );

    comment on table public.indexer_checkpoints is
      'Per-lane indexer progress. last_block_hash is the reorg detector: a mismatch rewinds the lane by the chain reorg depth and replays.';

    create table public.indexed_transfers (
      chain_id text not null references public.chains(chain_id) on delete restrict,
      transaction_hash text not null,
      log_index integer not null,
      block_number bigint not null,
      block_hash text not null,
      asset_id text not null references public.assets(asset_id) on delete restrict,
      from_address text not null,
      to_address text not null,
      raw_value numeric(78, 0) not null,
      removed boolean not null default false,
      observed_at timestamptz not null default clock_timestamp(),
      primary key (chain_id, transaction_hash, log_index),
      constraint indexed_transfers_transaction_hash_check
        check (transaction_hash ~ '^0x[0-9a-f]{64}$'),
      constraint indexed_transfers_block_hash_check
        check (block_hash ~ '^0x[0-9a-f]{64}$'),
      constraint indexed_transfers_log_index_check check (log_index >= 0),
      constraint indexed_transfers_block_check check (block_number >= 0),
      constraint indexed_transfers_from_check
        check (from_address ~ '^0x[0-9a-f]{40}$'),
      constraint indexed_transfers_to_check
        check (to_address ~ '^0x[0-9a-f]{40}$'),
      constraint indexed_transfers_value_check check (raw_value >= 0)
    );

    create index indexed_transfers_from_idx
      on public.indexed_transfers (chain_id, from_address, block_number desc, log_index desc);
    create index indexed_transfers_to_idx
      on public.indexed_transfers (chain_id, to_address, block_number desc, log_index desc);
    create index indexed_transfers_block_idx
      on public.indexed_transfers (chain_id, block_number);

    comment on table public.indexed_transfers is
      'ERC-20 Transfer logs for Asset Registry assets only. A reorged-out log keeps its row with removed = true so a client can reconcile what it already displayed.';

    create table public.indexed_pool_events (
      chain_id text not null references public.chains(chain_id) on delete restrict,
      transaction_hash text not null,
      log_index integer not null,
      block_number bigint not null,
      block_hash text not null,
      pool_id uuid not null references public.pools(pool_id) on delete restrict,
      event_kind text not null,
      payload jsonb not null,
      removed boolean not null default false,
      observed_at timestamptz not null default clock_timestamp(),
      primary key (chain_id, transaction_hash, log_index),
      constraint indexed_pool_events_transaction_hash_check
        check (transaction_hash ~ '^0x[0-9a-f]{64}$'),
      constraint indexed_pool_events_block_hash_check
        check (block_hash ~ '^0x[0-9a-f]{64}$'),
      constraint indexed_pool_events_log_index_check check (log_index >= 0),
      constraint indexed_pool_events_block_check check (block_number >= 0),
      constraint indexed_pool_events_kind_check
        check (event_kind in ('swap', 'mint', 'burn')),
      constraint indexed_pool_events_payload_check
        check (jsonb_typeof(payload) = 'object')
    );

    create index indexed_pool_events_pool_idx
      on public.indexed_pool_events (pool_id, block_number desc, log_index desc);
    create index indexed_pool_events_block_idx
      on public.indexed_pool_events (chain_id, block_number);

    comment on table public.indexed_pool_events is
      'Swap/Mint/Burn logs for registered PancakeSwap V3 pools. Amounts are stored as canonical decimal strings inside payload; they are never JavaScript numbers.';

    create table public.account_wallets (
      wallet_id uuid primary key default gen_random_uuid(),
      owner_user_id uuid not null
        references public.loop_users(id) on delete restrict,
      provider text not null default 'privy',
      provider_wallet_id text,
      chain_type text not null default 'ethereum',
      address text not null,
      kind text not null,
      status text not null default 'active',
      is_active boolean not null default false,
      first_seen_at timestamptz not null default clock_timestamp(),
      last_seen_at timestamptz not null default clock_timestamp(),
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint account_wallets_owner_address_unique
        unique (owner_user_id, chain_type, address),
      constraint account_wallets_provider_check check (provider = 'privy'),
      constraint account_wallets_chain_type_check check (chain_type = 'ethereum'),
      constraint account_wallets_address_check check (address ~ '^0x[0-9a-f]{40}$'),
      constraint account_wallets_kind_check check (kind in ('embedded', 'external')),
      constraint account_wallets_status_check
        check (status in ('active', 'archived')),
      constraint account_wallets_provider_wallet_id_check
        check (
          provider_wallet_id is null
          or provider_wallet_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'
        ),
      constraint account_wallets_embedded_evidence_check
        check (kind <> 'embedded' or provider_wallet_id is not null),
      constraint account_wallets_active_status_check
        check (not is_active or status = 'active'),
      constraint account_wallets_seen_check check (last_seen_at >= first_seen_at),
      constraint account_wallets_timestamp_check check (updated_at >= created_at)
    );

    create unique index account_wallets_single_active_idx
      on public.account_wallets (owner_user_id)
      where is_active;

    create unique index account_wallets_provider_wallet_idx
      on public.account_wallets (provider, provider_wallet_id)
      where provider_wallet_id is not null;

    comment on table public.account_wallets is
      'LOOP projection of the wallets Privy reports for an account. wallet_id is the only identifier the API publishes; the address is a public chain fact returned only where the product needs it.';

    create table public.wallet_balance_snapshots (
      wallet_id uuid not null
        references public.account_wallets(wallet_id) on delete cascade,
      asset_id text not null references public.assets(asset_id) on delete restrict,
      block_number bigint not null,
      block_hash text not null,
      raw_value numeric(78, 0) not null,
      observed_at timestamptz not null default clock_timestamp(),
      primary key (wallet_id, asset_id, block_number),
      constraint wallet_balance_snapshots_block_check check (block_number >= 0),
      constraint wallet_balance_snapshots_block_hash_check
        check (block_hash ~ '^0x[0-9a-f]{64}$'),
      constraint wallet_balance_snapshots_value_check check (raw_value >= 0)
    );

    create index wallet_balance_snapshots_recent_idx
      on public.wallet_balance_snapshots (wallet_id, observed_at desc);

    comment on table public.wallet_balance_snapshots is
      'Audit trail of balances actually observed at a block. It is never replayed as a current balance when the RPC capability is unavailable.';

    alter table public.watchlist_items
      drop constraint watchlist_items_pkey;
    alter table public.watchlist_items
      add column item_id uuid not null default gen_random_uuid();
    alter table public.watchlist_items
      add constraint watchlist_items_pkey primary key (item_id);
    alter table public.watchlist_items
      alter column asset_key drop not null;
    alter table public.watchlist_items
      add column asset_id text;
    alter table public.watchlist_items
      add constraint watchlist_items_asset_identity_check
      check ((asset_key is not null) <> (asset_id is not null));
    alter table public.watchlist_items
      add constraint watchlist_items_asset_id_check
      check (
        asset_id is null
        or asset_id ~ '^eip155:[1-9][0-9]{0,9}:(native|0x[0-9a-f]{40})$'
      );

    create unique index watchlist_items_asset_key_unique
      on public.watchlist_items (owner_user_id, group_key, asset_key)
      where asset_key is not null;
    create unique index watchlist_items_asset_id_unique
      on public.watchlist_items (owner_user_id, group_key, asset_id)
      where asset_id is not null;

    comment on column public.watchlist_items.asset_id is
      'Canonical lowercase CAIP asset ID written only by the V2 Watchlist. Legacy V1 rows keep asset_key; exactly one of the two columns is set per row.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    drop index public.watchlist_items_asset_id_unique;
    drop index public.watchlist_items_asset_key_unique;
    delete from public.watchlist_items where asset_id is not null;
    alter table public.watchlist_items
      drop constraint watchlist_items_asset_id_check;
    alter table public.watchlist_items
      drop constraint watchlist_items_asset_identity_check;
    alter table public.watchlist_items drop column asset_id;
    alter table public.watchlist_items alter column asset_key set not null;
    alter table public.watchlist_items drop constraint watchlist_items_pkey;
    alter table public.watchlist_items drop column item_id;
    alter table public.watchlist_items
      add constraint watchlist_items_pkey
      primary key (owner_user_id, group_key, asset_key);

    drop table public.wallet_balance_snapshots;
    drop index public.account_wallets_provider_wallet_idx;
    drop index public.account_wallets_single_active_idx;
    drop table public.account_wallets;
    drop table public.indexed_pool_events;
    drop table public.indexed_transfers;
    drop table public.indexer_checkpoints;
    drop table public.pools;
    drop table public.assets;
    drop table public.chains;
  `);
}
