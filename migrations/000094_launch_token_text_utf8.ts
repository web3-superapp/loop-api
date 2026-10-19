import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0164 (S243, loop-contracts Decision 0016): the token ticker
 * follows the four.meme rule (any script, 1–20 UTF-16 units, never
 * upper-cased). The character rule lives in the application
 * (`src/features/launch/launch-token-text.ts`); the database keeps only a
 * floor every valid value meets: non-empty, at most 80 UTF-8 bytes (the S242
 * factories' `MAX_TICKER_BYTES`), no leading / trailing whitespace (space,
 * tab, LF, CR, ideographic space U+3000). Column types are unchanged.
 *
 * - `launch_projects.ticker` (000023 `^[A-Z0-9]{2,12}$`)
 * - `launch2_instances.ticker` (000061, unnamed column check
 *   `launch2_instances_ticker_check`, `^[A-Z0-9]{2,12}$`) — written by the
 *   activation projection from the signed config, so it must hold a
 *   non-ASCII ticker before the first one is launched on a S242 factory
 * - `meme_tokens.symbol` (000049 `^[A-Z0-9]{2,10}$`)
 *
 * `down` restores the old patterns. It refuses (raises, nothing changed)
 * while any row breaks them — a non-ASCII / lower-case / 1-character /
 * long ticker written under this rule — rather than dropping or rewriting
 * data; such rows must be removed or renamed by an operator first.
 */

function floor(column: string): string {
  return `octet_length(${column}) between 1 and 80
    and ${column} = btrim(${column}, ' ' || chr(9) || chr(10) || chr(13) || chr(12288))`;
}

const tables = [
  {
    table: "public.launch_projects",
    constraint: "launch_projects_ticker_check",
    column: "ticker",
    legacy: "^[A-Z0-9]{2,12}$",
  },
  {
    table: "public.launch2_instances",
    constraint: "launch2_instances_ticker_check",
    column: "ticker",
    legacy: "^[A-Z0-9]{2,12}$",
  },
  {
    table: "public.meme_tokens",
    constraint: "meme_tokens_symbol_check",
    column: "symbol",
    legacy: "^[A-Z0-9]{2,10}$",
  },
] as const;

export function up(pgm: MigrationBuilder): void {
  for (const { table, constraint, column } of tables) {
    pgm.sql(`
      alter table ${table} drop constraint ${constraint};
      alter table ${table} add constraint ${constraint}
        check (${floor(column)});
    `);
  }
}

export function down(pgm: MigrationBuilder): void {
  for (const { table, constraint, column, legacy } of tables) {
    pgm.sql(`
      do $$
      begin
        if exists (select 1 from ${table} where ${column} !~ '${legacy}') then
          raise exception
            'Decision 0164 down: ${table}.${column} has rows outside ${legacy}; remove or rename them first';
        end if;
      end
      $$;
      alter table ${table} drop constraint ${constraint};
      alter table ${table} add constraint ${constraint}
        check (${column} ~ '${legacy}');
    `);
  }
}
