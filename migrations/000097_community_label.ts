import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0175 (S282): the operator-set custom community label.
 *
 * `communities.label` is a short free text (1–12 characters after trim, the
 * application validates and normalizes it) that an operator sets from the
 * console (`PUT /admin/api/communities/{communityId}/label`). The App shows
 * it where the "verified" mark used to be. Null = no label (every existing
 * row). It is independent of `verification_status`, which keeps gating
 * search and public visibility.
 *
 * The check only refuses an empty or padded string and anything longer
 * than 12 characters, a backstop for the application rule. `down` drops the
 * column (labels set meanwhile are lost; they are console data only).
 */

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.communities
      add column label text,
      add constraint communities_label_check
        check (label is null
          or (char_length(label) between 1 and 12 and label = btrim(label)));

    comment on column public.communities.label is
      'Decision 0175: operator-set custom label (1-12 characters, trimmed) shown where the verified mark used to be; null = none. Independent of verification_status.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.communities
      drop constraint communities_label_check,
      drop column label;
  `);
}
