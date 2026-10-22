import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0177 (S286): notification inbox producers.
 *
 * - `notifications.event_type`: the fine-grained inbox event of a row
 *   (`launch.graduated`, `launch.badge_minted`, `social.friend_request`,
 *   `social.friend_accepted`); null for every row written before and for
 *   every older producer. `type` keeps the preference category (the ten
 *   categories are unchanged), so a fine event always names the category
 *   that gates its push.
 * - `notifications.push_settled_at`: the `notification_inbox` lane set it
 *   once the push of a fine event was attempted or deliberately skipped
 *   (stale, emit off past the freshness window). Only fine events use it.
 * - `launch2_instances.inbox_graduation_settled_at` and
 *   `launch2_nft_mints.inbox_settled_at`: the lane's per-fact marker
 *   (graduation of one instance, one minted token). Existing graduated
 *   instances and every existing mint are marked now: there is no
 *   historical backfill, the inbox starts with new events.
 *
 * Push deliveries accept the four new push event types. `down` refuses
 * while any fine-event row or push delivery exists.
 */

const priorPushEventTypes = [
  "price_alert_triggered",
  "security_event",
  "community_voice_room_started",
  "community_application_verified",
  "community_application_rejected",
];

const inboxPushEventTypes = [
  "launch_graduated",
  "launch_badge_minted",
  "social_friend_request",
  "social_friend_accepted",
];

function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.notifications
      add column event_type text,
      add column push_settled_at timestamptz,
      add constraint notifications_event_type_check
        check (event_type is null or event_type in (
          'launch.graduated',
          'launch.badge_minted',
          'social.friend_request',
          'social.friend_accepted'
        )),
      add constraint notifications_push_settled_check
        check (push_settled_at is null or event_type is not null);

    create index notifications_inbox_push_pending_idx
      on public.notifications (created_at, notification_id)
      where event_type is not null and push_settled_at is null;

    comment on column public.notifications.event_type is
      'Decision 0177: fine-grained inbox event (launch.graduated, launch.badge_minted, social.friend_request, social.friend_accepted); null for older producers. type stays the preference category.';
    comment on column public.notifications.push_settled_at is
      'Decision 0177: when the notification_inbox lane attempted or skipped the push of a fine event; null = not yet handled.';

    alter table public.launch2_instances
      add column inbox_graduation_settled_at timestamptz;
    update public.launch2_instances
      set inbox_graduation_settled_at = clock_timestamp()
      where graduated_at is not null;
    create index launch2_instances_inbox_graduation_pending_idx
      on public.launch2_instances (graduated_at)
      where graduated_at is not null and inbox_graduation_settled_at is null;
    comment on column public.launch2_instances.inbox_graduation_settled_at is
      'Decision 0177: when the notification_inbox lane wrote (or deliberately skipped) the graduation notifications of this instance. Instances graduated before 000098 are pre-marked (no backfill).';

    alter table public.launch2_nft_mints
      add column inbox_settled_at timestamptz;
    update public.launch2_nft_mints
      set inbox_settled_at = clock_timestamp();
    create index launch2_nft_mints_inbox_pending_idx
      on public.launch2_nft_mints (minted_at)
      where inbox_settled_at is null and not removed;
    comment on column public.launch2_nft_mints.inbox_settled_at is
      'Decision 0177: when the notification_inbox lane wrote (or deliberately skipped) the badge-minted notification of this token. Mints before 000098 are pre-marked (no backfill).';

    alter table public.push_deliveries
      drop constraint push_deliveries_event_type_check;
    alter table public.push_deliveries
      add constraint push_deliveries_event_type_check
        check (event_type in (
          ${sqlList([...priorPushEventTypes, ...inboxPushEventTypes])}
        ));
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$
    begin
      if exists (
        select 1 from public.notifications where event_type is not null
      ) then
        raise exception
          'refusing to roll back notification inbox producers while fine-event notifications exist';
      end if;
      if exists (
        select 1 from public.push_deliveries
        where event_type in (${sqlList(inboxPushEventTypes)})
      ) then
        raise exception
          'refusing to roll back notification inbox producers while their push deliveries exist';
      end if;
    end
    $$;

    alter table public.push_deliveries
      drop constraint push_deliveries_event_type_check;
    alter table public.push_deliveries
      add constraint push_deliveries_event_type_check
        check (event_type in (${sqlList(priorPushEventTypes)}));

    drop index public.launch2_nft_mints_inbox_pending_idx;
    alter table public.launch2_nft_mints drop column inbox_settled_at;

    drop index public.launch2_instances_inbox_graduation_pending_idx;
    alter table public.launch2_instances
      drop column inbox_graduation_settled_at;

    drop index public.notifications_inbox_push_pending_idx;
    alter table public.notifications
      drop constraint notifications_push_settled_check,
      drop constraint notifications_event_type_check,
      drop column push_settled_at,
      drop column event_type;
  `);
}
