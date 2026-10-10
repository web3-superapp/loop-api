import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0123 (S147): the asset track of the hourly Mining settlement is
 * weighted by token quantity (balance TWAB × Mining Weight), not by value
 * (requirer ruling 2026-10-10, docs/17 item 17).
 *
 * The rule lives in the parameter document (`document.assetPowerBasis`).
 * Documents stored before this migration have no key and keep meaning the
 * Decision 0116 valuation rule, so every hour already settled replays to
 * the same digest and rewards; approved rows stay immutable (000062).
 *
 * This migration adds the database guard: a `mining_parameter_versions`
 * row can only be **inserted** or **approved** with
 * `document.assetPowerBasis = 'quantity'`. A draft written before 0123 can
 * still be withdrawn, never approved. Nothing is rewritten.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    create function public.require_mining_quantity_basis()
    returns trigger language plpgsql as $$
    begin
      if (tg_op = 'INSERT' or (new.status = 'approved' and old.status <> 'approved'))
        and coalesce(new.document->>'assetPowerBasis', '') <> 'quantity'
      then
        raise exception 'mining parameter versions must use assetPowerBasis quantity (Decision 0123)'
          using errcode = '23514';
      end if;
      return new;
    end;
    $$;
    create trigger mining_parameter_versions_quantity_basis
      before insert or update on public.mining_parameter_versions
      for each row execute function public.require_mining_quantity_basis();
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    drop trigger mining_parameter_versions_quantity_basis
      on public.mining_parameter_versions;
    drop function public.require_mining_quantity_basis();
  `);
}
