import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.spot_agent_identities
      add column agent_generation bigint not null default 1;
    alter table public.spot_agent_identities
      alter column agent_generation drop default;
    alter table public.spot_agent_identities
      add constraint spot_agent_identities_generation_check
        check (agent_generation > 0),
      add constraint spot_agent_identities_owner_epoch_generation_unique
        unique (
          owner_user_id,
          network,
          binding_version,
          agent_generation
        );

    create unique index spot_agent_identities_current_epoch_unique
      on public.spot_agent_identities (
        owner_user_id,
        network,
        binding_version
      )
      where lifecycle_state in (
        'reserved',
        'authorization_pending',
        'active',
        'operator_hold'
      );

    alter table public.spot_agent_identities
      drop constraint spot_agent_identities_owner_epoch_unique;

    comment on column public.spot_agent_identities.agent_generation is
      'Monotonic Agent generation inside one owner, Testnet network, and wallet-binding epoch. Historical generations remain immutable; at most one generation may be current.';

    create index spot_agent_authorizations_identity_valid_until_idx
      on public.spot_agent_authorizations (
        agent_identity_id,
        agent_valid_until desc,
        id
      );

    create or replace function public.enforce_spot_agent_identity_transition()
    returns trigger
    language plpgsql
    as $function$
    begin
      if tg_op = 'DELETE' then
        raise exception 'spot_agent_identities cannot be deleted'
          using errcode = '55000';
      end if;

      if tg_op = 'INSERT' then
        if new.lifecycle_state <> 'reserved' or new.record_version <> 0 then
          raise exception 'spot_agent_identities must start reserved at version zero'
            using errcode = '55000';
        end if;
        return new;
      end if;

      if new.id is distinct from old.id
        or new.owner_user_id is distinct from old.owner_user_id
        or new.network is distinct from old.network
        or new.binding_version is distinct from old.binding_version
        or new.agent_generation is distinct from old.agent_generation
        or new.agent_address is distinct from old.agent_address
        or new.agent_name is distinct from old.agent_name
        or new.signer_ref is distinct from old.signer_ref
        or new.created_at is distinct from old.created_at
      then
        raise exception 'spot_agent_identities immutable authority cannot change'
          using errcode = '55000';
      end if;

      if new.record_version <> old.record_version + 1
        or new.updated_at < old.updated_at
        or not (
          (old.lifecycle_state = 'reserved' and new.lifecycle_state in (
            'authorization_pending', 'retired', 'operator_hold'
          ))
          or (
            old.lifecycle_state = 'authorization_pending'
            and new.lifecycle_state in (
              'reserved', 'active', 'revoked', 'retired', 'operator_hold'
            )
          )
          or (
            old.lifecycle_state = 'active'
            and new.lifecycle_state in ('revoked', 'retired', 'operator_hold')
          )
          or (
            old.lifecycle_state = 'operator_hold'
            and new.lifecycle_state = 'retired'
          )
        )
      then
        raise exception 'invalid Spot Agent identity transition'
          using errcode = '55000';
      end if;
      return new;
    end;
    $function$;
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    lock table
      public.spot_agent_identities,
      public.spot_agent_authorizations
    in access exclusive mode;

    do $guard$
    begin
      if exists (
        select 1
        from public.spot_agent_identities
        where agent_generation <> 1
      ) then
        raise exception
          'cannot roll back 000008_spot_agent_generations after a later Agent generation exists'
          using errcode = '55000';
      end if;
    end;
    $guard$;

    create or replace function public.enforce_spot_agent_identity_transition()
    returns trigger
    language plpgsql
    as $function$
    begin
      if tg_op = 'DELETE' then
        raise exception 'spot_agent_identities cannot be deleted'
          using errcode = '55000';
      end if;

      if tg_op = 'INSERT' then
        if new.lifecycle_state <> 'reserved' or new.record_version <> 0 then
          raise exception 'spot_agent_identities must start reserved at version zero'
            using errcode = '55000';
        end if;
        return new;
      end if;

      if new.id is distinct from old.id
        or new.owner_user_id is distinct from old.owner_user_id
        or new.network is distinct from old.network
        or new.binding_version is distinct from old.binding_version
        or new.agent_address is distinct from old.agent_address
        or new.agent_name is distinct from old.agent_name
        or new.signer_ref is distinct from old.signer_ref
        or new.created_at is distinct from old.created_at
      then
        raise exception 'spot_agent_identities immutable authority cannot change'
          using errcode = '55000';
      end if;

      if new.record_version <> old.record_version + 1
        or new.updated_at < old.updated_at
        or not (
          (old.lifecycle_state = 'reserved' and new.lifecycle_state in (
            'authorization_pending', 'retired', 'operator_hold'
          ))
          or (
            old.lifecycle_state = 'authorization_pending'
            and new.lifecycle_state in (
              'reserved', 'active', 'revoked', 'retired', 'operator_hold'
            )
          )
          or (
            old.lifecycle_state = 'active'
            and new.lifecycle_state in ('revoked', 'retired', 'operator_hold')
          )
        )
      then
        raise exception 'invalid Spot Agent identity transition'
          using errcode = '55000';
      end if;
      return new;
    end;
    $function$;

    drop index public.spot_agent_authorizations_identity_valid_until_idx;
    drop index public.spot_agent_identities_current_epoch_unique;
    alter table public.spot_agent_identities
      drop constraint spot_agent_identities_owner_epoch_generation_unique,
      drop constraint spot_agent_identities_generation_check,
      drop column agent_generation,
      add constraint spot_agent_identities_owner_epoch_unique
        unique (owner_user_id, network, binding_version);
  `);
}
