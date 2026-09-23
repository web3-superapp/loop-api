import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0073: an applicant can see, and is told, what happened to their
 * community application.
 *
 * `communities` gains the three review facts the applicant is shown:
 * `application_submitted_at` (the last submission, backfilled from
 * `created_at`), `reviewed_at`, and `rejected_reason` (1-280 code points
 * under the alias text-safety rules). A check constraint pairs them with
 * `verification_status` so a pending row can never carry a review and a
 * reviewed row can never lack one.
 *
 * `community_role_events` gains the `community_resubmitted` event and a
 * nullable `note`, where the reject audit row keeps the operator's reason
 * text after a resubmission clears it from the community row.
 *
 * `push_deliveries` admits the two review events of Decision 0073.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.communities
      add column application_submitted_at timestamptz,
      add column reviewed_at timestamptz,
      add column rejected_reason text;

    update public.communities
    set application_submitted_at = created_at,
        reviewed_at = case
          when verification_status = 'verified' then verified_at
          when verification_status = 'rejected' then updated_at
          else null
        end;

    alter table public.communities
      alter column application_submitted_at set not null,
      alter column application_submitted_at set default clock_timestamp();

    alter table public.communities
      add constraint communities_rejected_reason_check
        check (
          rejected_reason is null
          or (
            char_length(rejected_reason) between 1 and 280
            and rejected_reason = btrim(rejected_reason)
            and public.loop_alias_text_is_safe(rejected_reason)
          )
        ),
      add constraint communities_review_pairing_check
        check (
          (
            verification_status = 'pending'
            and reviewed_at is null
            and rejected_reason is null
          )
          or (
            verification_status = 'verified'
            and reviewed_at is not null
            and rejected_reason is null
          )
          or (
            verification_status = 'rejected'
            and reviewed_at is not null
          )
        );

    comment on column public.communities.application_submitted_at is
      'When the current application was (re)submitted (Decision 0073). Equals created_at until the owner resubmits after a rejection.';
    comment on column public.communities.reviewed_at is
      'When the operator last verified or rejected the application (Decision 0073); null while pending.';
    comment on column public.communities.rejected_reason is
      'Operator-supplied reason shown only to the owner while the application is rejected (Decision 0073); cleared on resubmission.';

    alter table public.community_role_events
      add column note text,
      add constraint community_role_events_note_check
        check (
          note is null
          or (
            char_length(note) between 1 and 280
            and note = btrim(note)
            and public.loop_alias_text_is_safe(note)
          )
        );

    alter table public.community_role_events
      drop constraint community_role_events_type_check;

    alter table public.community_role_events
      add constraint community_role_events_type_check
        check (event_type in (
          'community_created',
          'community_profile_updated',
          'community_verified',
          'community_rejected',
          'community_resubmitted',
          'member_joined',
          'member_left',
          'role_changed',
          'member_muted',
          'member_unmuted',
          'member_banned',
          'member_unbanned'
        ));

    comment on column public.community_role_events.note is
      'Free-text operator note bounded like a community description (Decision 0073). The community_rejected row keeps the reason here after resubmission clears it from the community.';

    alter table public.push_deliveries
      drop constraint push_deliveries_event_type_check;

    alter table public.push_deliveries
      add constraint push_deliveries_event_type_check
        check (event_type in (
          'price_alert_triggered',
          'security_event',
          'community_voice_room_started',
          'community_application_verified',
          'community_application_rejected'
        ));
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$
    begin
      if exists (
        select 1
        from public.community_role_events
        where event_type = 'community_resubmitted' or note is not null
      ) then
        raise exception
          'refusing to roll back community application review while resubmission or note rows exist';
      end if;
      if exists (
        select 1
        from public.push_deliveries
        where event_type in (
          'community_application_verified',
          'community_application_rejected'
        )
      ) then
        raise exception
          'refusing to roll back community application review while its push deliveries exist';
      end if;
    end
    $$;

    alter table public.push_deliveries
      drop constraint push_deliveries_event_type_check;

    alter table public.push_deliveries
      add constraint push_deliveries_event_type_check
        check (event_type in (
          'price_alert_triggered',
          'security_event',
          'community_voice_room_started'
        ));

    alter table public.community_role_events
      drop constraint community_role_events_type_check;

    alter table public.community_role_events
      add constraint community_role_events_type_check
        check (event_type in (
          'community_created',
          'community_profile_updated',
          'community_verified',
          'community_rejected',
          'member_joined',
          'member_left',
          'role_changed',
          'member_muted',
          'member_unmuted',
          'member_banned',
          'member_unbanned'
        ));

    alter table public.community_role_events
      drop constraint community_role_events_note_check,
      drop column note;

    alter table public.communities
      drop constraint communities_review_pairing_check,
      drop constraint communities_rejected_reason_check,
      drop column rejected_reason,
      drop column reviewed_at,
      drop column application_submitted_at;
  `);
}
