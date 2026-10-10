import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0118 (S140): the MEME v2 snapshot publisher.
 *
 * `launch2_snapshot_publications`: one row per publication attempt of an
 * instance's NFT-holder snapshot. The row is written (cutoff block / hash,
 * full sorted holder list, Merkle root, dataHash, the two signer addresses
 * and their EIP-712 signatures) before anything is signed for the chain;
 * the submitter's signed transaction (hash, nonce, raw bytes) is written
 * before the bytes are sent. Status machine:
 *
 *   pending → broadcast → confirmed
 *   pending | broadcast → failed (retryable flag)
 *   pending | broadcast | confirmed → mismatch
 *   confirmed → broadcast (the receipt left the canonical chain: the same
 *   signed transaction is re-sent)
 *
 * At most one `pending | broadcast | confirmed` row per instance; the
 * attestation columns never change after insert; a transaction hash is set
 * once, while `pending`. Rows are never deleted.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create table public.launch2_snapshot_publications (
      publication_id uuid primary key,
      instance_id uuid not null references public.launch2_instances(instance_id) on delete restrict,
      chain_id text not null references public.chains(chain_id) on delete restrict,
      attempt integer not null check (attempt between 1 and 100),
      status text not null default 'pending' check (status in (
        'pending', 'broadcast', 'confirmed', 'failed', 'mismatch')),
      snapshots_address text not null check (snapshots_address ~ '^0x[0-9a-f]{40}$'),
      cutoff_block bigint not null check (cutoff_block >= 0),
      cutoff_block_hash text not null check (cutoff_block_hash ~ '^0x[0-9a-f]{64}$'),
      sale_end_at timestamptz not null,
      members jsonb not null check (jsonb_typeof(members) = 'array' and jsonb_array_length(members) > 0),
      member_count integer not null check (member_count > 0),
      root text not null check (root ~ '^0x[0-9a-f]{64}$'),
      data_hash text not null check (data_hash ~ '^0x[0-9a-f]{64}$'),
      signer_addresses jsonb not null check (
        jsonb_typeof(signer_addresses) = 'array' and jsonb_array_length(signer_addresses) = 2),
      signatures jsonb not null check (
        jsonb_typeof(signatures) = 'array' and jsonb_array_length(signatures) = 2),
      submitter_address text not null check (submitter_address ~ '^0x[0-9a-f]{40}$'),
      tx_hash text check (tx_hash ~ '^0x[0-9a-f]{64}$'),
      tx_nonce bigint check (tx_nonce >= 0),
      raw_tx text check (raw_tx ~ '^0x[0-9a-f]+$' and length(raw_tx) <= 131072),
      block_number bigint check (block_number >= 0),
      block_hash text check (block_hash ~ '^0x[0-9a-f]{64}$'),
      confirmations integer check (confirmations >= 0),
      failure_code text check (failure_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
      failure_detail text check (failure_detail ~ '^[A-Za-z0-9_]{1,64}$'),
      failure_retryable boolean,
      created_at timestamptz not null default clock_timestamp(),
      broadcast_at timestamptz,
      confirmed_at timestamptz,
      updated_at timestamptz not null default clock_timestamp(),
      constraint launch2_snapshot_publication_members check (member_count = jsonb_array_length(members)),
      constraint launch2_snapshot_publication_tx_shape check (
        (tx_hash is null) = (raw_tx is null) and (tx_hash is null) = (tx_nonce is null)
        and (status not in ('broadcast', 'confirmed') or tx_hash is not null)),
      constraint launch2_snapshot_publication_confirmed_shape check (
        status <> 'confirmed'
        or (block_number is not null and block_hash is not null and confirmations is not null
          and confirmed_at is not null)),
      constraint launch2_snapshot_publication_failure_shape check (
        (status in ('failed', 'mismatch')) = (failure_code is not null)
        and (status = 'failed') = (failure_retryable is not null)
        and (failure_detail is null or failure_code is not null))
    );
    create unique index launch2_snapshot_publication_active
      on public.launch2_snapshot_publications (instance_id)
      where status in ('pending', 'broadcast', 'confirmed');
    create unique index launch2_snapshot_publication_attempt
      on public.launch2_snapshot_publications (instance_id, attempt);
    create unique index launch2_snapshot_publication_tx
      on public.launch2_snapshot_publications (tx_hash) where tx_hash is not null;
    create index launch2_snapshot_publication_nonce
      on public.launch2_snapshot_publications (submitter_address, tx_nonce)
      where status in ('pending', 'broadcast') and tx_nonce is not null;

    create function public.guard_launch2_snapshot_publication()
    returns trigger language plpgsql as $$
    declare
      mutable text[] := array['status', 'tx_hash', 'tx_nonce', 'raw_tx',
        'block_number', 'block_hash', 'confirmations', 'failure_code',
        'failure_detail', 'failure_retryable', 'broadcast_at', 'confirmed_at',
        'updated_at'];
      transition text;
    begin
      if TG_OP = 'DELETE' then
        raise exception 'snapshot publications retain audit history';
      end if;
      if (to_jsonb(NEW) - mutable) is distinct from (to_jsonb(OLD) - mutable) then
        raise exception 'invalid snapshot publication mutation';
      end if;
      transition := OLD.status || '>' || NEW.status;
      if OLD.status = NEW.status then
        if OLD.status not in ('pending', 'broadcast', 'confirmed') then
          raise exception 'invalid snapshot publication mutation';
        end if;
      elsif transition not in (
        'pending>broadcast', 'pending>failed', 'pending>mismatch',
        'broadcast>confirmed', 'broadcast>failed', 'broadcast>mismatch',
        'confirmed>mismatch', 'confirmed>broadcast') then
        raise exception 'invalid snapshot publication mutation: transition % not allowed', transition;
      end if;
      if NEW.tx_hash is distinct from OLD.tx_hash
        and not (OLD.status = 'pending' and NEW.status = 'pending' and OLD.tx_hash is null) then
        raise exception 'snapshot publication transaction is set once, while pending';
      end if;
      NEW.updated_at := clock_timestamp();
      return NEW;
    end;
    $$;
    create trigger launch2_snapshot_publication_guard
      before update or delete on public.launch2_snapshot_publications
      for each row execute function public.guard_launch2_snapshot_publication();

    comment on table public.launch2_snapshot_publications is
      'Decision 0118: 2-of-3 signed NFT-holder snapshot publications (attestation written before signing for the chain, transaction before broadcast).';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$ begin
      if exists (select 1 from public.launch2_snapshot_publications)
      then raise exception 'refusing to remove snapshot publication evidence'; end if;
    end $$;
    drop table public.launch2_snapshot_publications;
    drop function public.guard_launch2_snapshot_publication();
  `);
}
