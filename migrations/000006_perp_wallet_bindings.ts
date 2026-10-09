import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.loop_users
      add constraint loop_users_id_privy_user_id_unique
      unique (id, privy_user_id);

    create table public.perp_wallet_bindings (
      owner_user_id uuid primary key,
      privy_user_id text not null,
      binding_state text not null,
      wallet_id text,
      account_address text,
      account_kind text,
      binding_version bigint not null,
      last_verified_at timestamptz,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      constraint perp_wallet_bindings_owner_identity_fk
        foreign key (owner_user_id, privy_user_id)
        references public.loop_users (id, privy_user_id)
        on delete restrict,
      constraint perp_wallet_bindings_privy_user_id_check
        check (char_length(privy_user_id) between 1 and 255),
      constraint perp_wallet_bindings_state_check
        check (binding_state in ('bound', 'unbound')),
      constraint perp_wallet_bindings_wallet_id_check
        check (
          wallet_id is null
          or (
            char_length(wallet_id) between 1 and 255
            and wallet_id = btrim(wallet_id)
            and wallet_id !~ '[[:cntrl:]]'
          )
        ),
      constraint perp_wallet_bindings_account_address_check
        check (
          account_address is null
          or (
            account_address ~ '^0x[0-9a-f]{40}$'
            and account_address <> '0x0000000000000000000000000000000000000000'
          )
        ),
      constraint perp_wallet_bindings_account_kind_check
        check (account_kind is null or account_kind = 'master'),
      constraint perp_wallet_bindings_version_check
        check (binding_version >= 0),
      constraint perp_wallet_bindings_authority_state_check
        check (
          (
            binding_state = 'bound'
            and account_address is not null
            and account_kind = 'master'
            and binding_version > 0
            and last_verified_at is not null
          )
          or
          (
            binding_state = 'unbound'
            and wallet_id is null
            and account_address is null
            and account_kind is null
            and last_verified_at is null
          )
        ),
      constraint perp_wallet_bindings_timestamp_check
        check (
          updated_at >= created_at
          and (
            last_verified_at is null
            or last_verified_at <= updated_at
          )
        )
    );

    comment on table public.perp_wallet_bindings is
      'Permanent owner-bound Hyperliquid master-account selection and monotonic authority epoch. It stores no token, wallet key, signature, nonce, or raw Privy response.';

    create unique index perp_wallet_bindings_active_wallet_id_unique
      on public.perp_wallet_bindings (wallet_id)
      where binding_state = 'bound' and wallet_id is not null;

    create unique index perp_wallet_bindings_active_address_unique
      on public.perp_wallet_bindings (account_address)
      where binding_state = 'bound';

    create table public.perp_wallet_binding_events (
      id uuid primary key default gen_random_uuid(),
      owner_user_id uuid not null
        references public.perp_wallet_bindings(owner_user_id) on delete restrict,
      request_id uuid not null unique,
      action text not null,
      from_version bigint not null,
      to_version bigint not null,
      occurred_at timestamptz not null default clock_timestamp(),
      constraint perp_wallet_binding_events_action_check
        check (action in ('bind', 'refresh', 'rotate', 'unbind')),
      constraint perp_wallet_binding_events_version_check
        check (
          from_version >= 0
          and to_version >= 0
          and (
            (
              action = 'refresh'
              and from_version = to_version
              and to_version > 0
            )
            or
            (
              action in ('bind', 'rotate', 'unbind')
              and to_version = from_version + 1
            )
          )
        ),
      constraint perp_wallet_binding_events_action_version_check
        check (
          (action = 'bind')
          or (action in ('rotate', 'unbind') and from_version > 0)
          or (action = 'refresh' and from_version > 0)
        )
    );

    comment on table public.perp_wallet_binding_events is
      'Append-only sanitized wallet-binding lifecycle events. Events contain only action, request UUID, monotonic versions, and occurrence time.';

    create index perp_wallet_binding_events_owner_occurred_idx
      on public.perp_wallet_binding_events (
        owner_user_id,
        occurred_at,
        id
      );

    create function public.enforce_perp_wallet_binding_transition()
    returns trigger
    language plpgsql
    as $function$
    declare
      same_authority boolean;
    begin
      if tg_op = 'DELETE' then
        raise exception 'perp_wallet_bindings cannot be deleted'
          using errcode = '55000';
      end if;

      if tg_op = 'INSERT' then
        if new.binding_state <> 'bound' or new.binding_version <> 1 then
          raise exception 'perp_wallet_bindings must start with bound version 1'
            using errcode = '55000';
        end if;
        return new;
      end if;

      if new.owner_user_id is distinct from old.owner_user_id
        or new.privy_user_id is distinct from old.privy_user_id
        or new.created_at is distinct from old.created_at
      then
        raise exception 'perp_wallet_bindings immutable identity cannot change'
          using errcode = '55000';
      end if;

      same_authority :=
        new.binding_state = 'bound'
        and old.binding_state = 'bound'
        and new.wallet_id is not distinct from old.wallet_id
        and new.account_address is not distinct from old.account_address
        and new.account_kind is not distinct from old.account_kind;

      if same_authority then
        if new.binding_version <> old.binding_version
          or new.last_verified_at < old.last_verified_at
        then
          raise exception 'perp_wallet_bindings refresh must retain its epoch'
            using errcode = '55000';
        end if;
      elsif new.binding_state = 'unbound'
        and old.binding_state = 'unbound'
      then
        raise exception 'perp_wallet_bindings unbound state is immutable'
          using errcode = '55000';
      elsif new.binding_version <> old.binding_version + 1 then
        raise exception 'perp_wallet_bindings authority change must advance one epoch'
          using errcode = '55000';
      end if;

      if new.updated_at < old.updated_at then
        raise exception 'perp_wallet_bindings updated_at cannot move backward'
          using errcode = '55000';
      end if;

      return new;
    end;
    $function$;

    create trigger perp_wallet_bindings_transition_guard
      before insert or update or delete on public.perp_wallet_bindings
      for each row execute function public.enforce_perp_wallet_binding_transition();

    create function public.reject_perp_wallet_binding_event_mutation()
    returns trigger
    language plpgsql
    as $function$
    begin
      raise exception 'perp_wallet_binding_events is append-only'
        using errcode = '55000';
    end;
    $function$;

    create trigger perp_wallet_binding_events_append_only
      before update or delete on public.perp_wallet_binding_events
      for each row execute function public.reject_perp_wallet_binding_event_mutation();
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    lock table
      public.perp_wallet_bindings,
      public.perp_wallet_binding_events
    in access exclusive mode;

    do $guard$
    begin
      if exists (select 1 from public.perp_wallet_bindings)
        or exists (select 1 from public.perp_wallet_binding_events)
      then
        raise exception
          'cannot roll back 000006_perp_wallet_bindings while wallet-binding records exist'
          using errcode = '55000';
      end if;
    end;
    $guard$;

    drop table public.perp_wallet_binding_events;
    drop function public.reject_perp_wallet_binding_event_mutation();
    drop table public.perp_wallet_bindings;
    drop function public.enforce_perp_wallet_binding_transition();

    alter table public.loop_users
      drop constraint loop_users_id_privy_user_id_unique;
  `);
}
