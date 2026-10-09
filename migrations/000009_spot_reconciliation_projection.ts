import type { MigrationBuilder } from "node-pg-migrate";

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    lock table
      public.provider_operations,
      public.spot_intents,
      public.spot_agent_authorizations
    in share row exclusive mode;

    create function public.spot_reconciliation_projection_pair_is_valid(
      checked_kind text,
      operation_state text,
      operation_reconciliation_status text,
      projection_state text
    )
    returns boolean
    language sql
    immutable
    strict
    parallel safe
    as $function$
      select case checked_kind
        when 'spot_intent' then
          (
            projection_state in ('prepared', 'expired')
            and operation_state = 'prepared'
            and operation_reconciliation_status = 'not_required'
          )
          or (
            projection_state = 'submitting'
            and operation_state = 'submitting'
            and operation_reconciliation_status = 'not_required'
          )
          or (
            projection_state = 'accepted'
            and operation_state = 'accepted'
            and operation_reconciliation_status in ('not_required', 'complete')
          )
          or (
            projection_state in ('partially_filled', 'filled', 'not_filled')
            and operation_state = 'succeeded'
            and operation_reconciliation_status in ('not_required', 'complete')
          )
          or (
            projection_state = 'rejected'
            and operation_state = 'rejected'
            and operation_reconciliation_status in ('not_required', 'complete')
          )
          or (
            projection_state = 'unknown'
            and operation_state = 'unknown'
            and operation_reconciliation_status = 'pending'
          )
          or (
            projection_state = 'reconciling'
            and operation_state = 'unknown'
            and operation_reconciliation_status = 'leased'
          )
          or (
            projection_state = 'operator_required'
            and operation_state = 'unknown'
            and operation_reconciliation_status = 'operator_required'
          )
        when 'spot_agent_authorization' then
          (
            projection_state in ('prepared', 'expired')
            and operation_state = 'prepared'
            and operation_reconciliation_status = 'not_required'
          )
          or (
            projection_state = 'submitting'
            and operation_state = 'submitting'
            and operation_reconciliation_status = 'not_required'
          )
          or (
            projection_state = 'accepted'
            and operation_state = 'accepted'
            and operation_reconciliation_status in ('not_required', 'complete')
          )
          or (
            projection_state = 'active'
            and operation_state = 'succeeded'
            and operation_reconciliation_status in ('not_required', 'complete')
          )
          or (
            projection_state = 'rejected'
            and operation_state = 'rejected'
            and operation_reconciliation_status in ('not_required', 'complete')
          )
          or (
            projection_state = 'failed'
            and operation_state = 'failed'
            and operation_reconciliation_status in ('not_required', 'complete')
          )
          or (
            projection_state = 'unknown'
            and operation_state = 'unknown'
            and operation_reconciliation_status = 'pending'
          )
          or (
            projection_state = 'reconciling'
            and operation_state = 'unknown'
            and operation_reconciliation_status = 'leased'
          )
          or (
            projection_state = 'operator_required'
            and operation_state = 'unknown'
            and operation_reconciliation_status = 'operator_required'
          )
        else false
      end
    $function$;

    do $preflight$
    begin
      if exists (
        select 1
        from (
          select
            operation.operation_kind,
            operation.state as operation_state,
            operation.reconciliation_status,
            intent.state as projection_state
          from public.provider_operations as operation
          left join public.spot_intents as intent
            on intent.id = operation.id
          where operation.domain = 'hyperliquid'
            and operation.operation_kind = 'spot_intent'

          union all

          select
            operation.operation_kind,
            operation.state as operation_state,
            operation.reconciliation_status,
            agent_authorization.state as projection_state
          from public.provider_operations as operation
          left join public.spot_agent_authorizations as agent_authorization
            on agent_authorization.id = operation.id
          where operation.domain = 'hyperliquid'
            and operation.operation_kind = 'spot_agent_authorization'
        ) as projection
        where projection.projection_state is null
          or not public.spot_reconciliation_projection_pair_is_valid(
            projection.operation_kind,
            projection.operation_state,
            projection.reconciliation_status,
            projection.projection_state
          )
      ) then
        raise exception
          'cannot install Spot reconciliation projection constraints while persisted projections disagree'
          using errcode = '23514';
      end if;
    end;
    $preflight$;

    create function public.validate_spot_reconciliation_projection()
    returns trigger
    language plpgsql
    as $function$
    declare
      checked_operation_id uuid;
      checked_domain text;
      checked_kind text;
      operation_state text;
      operation_reconciliation_status text;
      projection_state text;
    begin
      if tg_table_name = 'provider_operations' then
        checked_operation_id := new.id;
        checked_domain := new.domain;
        checked_kind := new.operation_kind;
      else
        checked_operation_id := new.id;
        checked_domain := 'hyperliquid';
        if tg_table_name = 'spot_intents' then
          checked_kind := 'spot_intent';
        else
          checked_kind := 'spot_agent_authorization';
        end if;
      end if;

      if checked_domain <> 'hyperliquid'
        or checked_kind not in ('spot_intent', 'spot_agent_authorization')
      then
        return null;
      end if;

      select
        operation.state,
        operation.reconciliation_status
      into
        operation_state,
        operation_reconciliation_status
      from public.provider_operations as operation
      where operation.id = checked_operation_id
        and operation.domain = 'hyperliquid'
        and operation.operation_kind = checked_kind;

      if not found then
        raise exception 'Spot reconciliation projection has no matching provider operation'
          using errcode = '23514';
      end if;

      if checked_kind = 'spot_intent' then
        select intent.state
        into projection_state
        from public.spot_intents as intent
        where intent.id = checked_operation_id;
      else
        select agent_authorization.state
        into projection_state
        from public.spot_agent_authorizations as agent_authorization
        where agent_authorization.id = checked_operation_id;
      end if;

      if not found then
        raise exception 'Spot reconciliation provider operation has no domain projection'
          using errcode = '23514';
      end if;

      if not public.spot_reconciliation_projection_pair_is_valid(
        checked_kind,
        operation_state,
        operation_reconciliation_status,
        projection_state
      ) then
        raise exception 'Spot and provider operation reconciliation projections disagree'
          using errcode = '23514';
      end if;

      return null;
    end;
    $function$;

    create constraint trigger provider_operations_spot_reconciliation_projection_complete
      after insert or update on public.provider_operations
      deferrable initially deferred
      for each row execute function public.validate_spot_reconciliation_projection();
    create constraint trigger spot_intents_reconciliation_projection_complete
      after insert or update on public.spot_intents
      deferrable initially deferred
      for each row execute function public.validate_spot_reconciliation_projection();
    create constraint trigger spot_agent_authorizations_reconciliation_projection_complete
      after insert or update on public.spot_agent_authorizations
      deferrable initially deferred
      for each row execute function public.validate_spot_reconciliation_projection();
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    lock table
      public.provider_operations,
      public.spot_intents,
      public.spot_agent_authorizations
    in share row exclusive mode;

    drop trigger provider_operations_spot_reconciliation_projection_complete
      on public.provider_operations;
    drop trigger spot_intents_reconciliation_projection_complete
      on public.spot_intents;
    drop trigger spot_agent_authorizations_reconciliation_projection_complete
      on public.spot_agent_authorizations;
    drop function public.validate_spot_reconciliation_projection();
    drop function public.spot_reconciliation_projection_pair_is_valid(
      text,
      text,
      text,
      text
    );
  `);
}
