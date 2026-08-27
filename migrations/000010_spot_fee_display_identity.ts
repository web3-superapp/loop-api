import type { MigrationBuilder } from "node-pg-migrate";

const broadFeeIdentityConstraint = `
  check (
    (
      result_fee_amount is null
      and result_fee_token_index is null
      and result_fee_token_id is null
      and result_fee_asset_display_identity is null
    )
    or (
      result_fee_amount is not null
      and result_fee_token_index is not null
      and result_fee_token_id is not null
      and result_fee_asset_display_identity is not null
      and result_fee_asset_display_identity
        ~ '^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,63}$'
      and (
        (
          result_fee_token_index = base_token_index
          and result_fee_token_id = base_token_id
        )
        or (
          result_fee_token_index = quote_token_index
          and result_fee_token_id = quote_token_id
        )
      )
    )
  )
`;

const legacyFeeIdentityConstraint = `
  check (
    (
      result_fee_amount is null
      and result_fee_token_index is null
      and result_fee_token_id is null
      and result_fee_asset_display_identity is null
    )
    or (
      result_fee_amount is not null
      and result_fee_token_index is not null
      and result_fee_token_id is not null
      and result_fee_asset_display_identity is not null
      and result_fee_asset_display_identity ~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'
      and (
        (
          result_fee_token_index = base_token_index
          and result_fee_token_id = base_token_id
        )
        or (
          result_fee_token_index = quote_token_index
          and result_fee_token_id = quote_token_id
        )
      )
    )
  )
`;

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    lock table public.spot_intents in access exclusive mode;

    alter table public.spot_intents
      drop constraint spot_intents_result_fee_identity_check,
      add constraint spot_intents_result_fee_identity_check
        ${broadFeeIdentityConstraint};
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    lock table public.spot_intents in access exclusive mode;

    do $guard$
    begin
      if exists (
        select 1
        from public.spot_intents
        where result_fee_asset_display_identity is not null
          and result_fee_asset_display_identity
            !~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'
      ) then
        raise exception
          'cannot roll back 000010_spot_fee_display_identity after a broader fee identity is stored'
          using errcode = '55000';
      end if;
    end;
    $guard$;

    alter table public.spot_intents
      drop constraint spot_intents_result_fee_identity_check,
      add constraint spot_intents_result_fee_identity_check
        ${legacyFeeIdentityConstraint};
  `);
}
