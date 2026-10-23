import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0178 (S291): the project owner's launch review / deployment
 * progress notifications.
 *
 * - `notifications.event_type` admits four more fine events:
 *   `launch.review_approved`, `launch.review_rejected`, `launch.activated`,
 *   `launch.deploy_failed` (category `launch.round` in `type`).
 * - `launch2_instances.inbox_activation_settled_at`: the
 *   `notification_inbox` lane's per-instance marker for `launch.activated`
 *   (the instance ID only exists once the launch2 lane registers the
 *   activated task, after the executor's transaction). Existing instances
 *   are marked now: no historical backfill.
 * - `push_deliveries` accepts the four matching push events.
 *
 * `down` refuses while any of the new rows exist.
 */

const coreEventTypes = [
  "launch.graduated",
  "launch.badge_minted",
  "social.friend_request",
  "social.friend_accepted",
];

const launchReviewEventTypes = [
  "launch.review_approved",
  "launch.review_rejected",
  "launch.activated",
  "launch.deploy_failed",
];

const priorPushEventTypes = [
  "price_alert_triggered",
  "security_event",
  "community_voice_room_started",
  "community_application_verified",
  "community_application_rejected",
  "launch_graduated",
  "launch_badge_minted",
  "social_friend_request",
  "social_friend_accepted",
];

const launchReviewPushEventTypes = [
  "launch_review_approved",
  "launch_review_rejected",
  "launch_activated",
  "launch_deploy_failed",
];

function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.notifications
      drop constraint notifications_event_type_check;
    alter table public.notifications
      add constraint notifications_event_type_check
        check (event_type is null or event_type in (
          ${sqlList([...coreEventTypes, ...launchReviewEventTypes])}
        ));
    comment on column public.notifications.event_type is
      'Decisions 0177 / 0178: fine-grained inbox event (launch.graduated, launch.badge_minted, social.friend_request, social.friend_accepted; launch.review_approved, launch.review_rejected, launch.activated, launch.deploy_failed); null for older producers. type stays the preference category.';

    alter table public.launch2_instances
      add column inbox_activation_settled_at timestamptz;
    update public.launch2_instances
      set inbox_activation_settled_at = clock_timestamp();
    create index launch2_instances_inbox_activation_pending_idx
      on public.launch2_instances (registered_at)
      where inbox_activation_settled_at is null;
    comment on column public.launch2_instances.inbox_activation_settled_at is
      'Decision 0178: when the notification_inbox lane wrote (or deliberately skipped) the launch.activated notification of this instance. Instances registered before 000099 are pre-marked (no backfill).';

    alter table public.push_deliveries
      drop constraint push_deliveries_event_type_check;
    alter table public.push_deliveries
      add constraint push_deliveries_event_type_check
        check (event_type in (
          ${sqlList([...priorPushEventTypes, ...launchReviewPushEventTypes])}
        ));
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$
    begin
      if exists (
        select 1 from public.notifications
        where event_type in (${sqlList(launchReviewEventTypes)})
      ) then
        raise exception
          'refusing to roll back launch review inbox while its notifications exist';
      end if;
      if exists (
        select 1 from public.push_deliveries
        where event_type in (${sqlList(launchReviewPushEventTypes)})
      ) then
        raise exception
          'refusing to roll back launch review inbox while its push deliveries exist';
      end if;
    end
    $$;

    alter table public.push_deliveries
      drop constraint push_deliveries_event_type_check;
    alter table public.push_deliveries
      add constraint push_deliveries_event_type_check
        check (event_type in (${sqlList(priorPushEventTypes)}));

    drop index public.launch2_instances_inbox_activation_pending_idx;
    alter table public.launch2_instances
      drop column inbox_activation_settled_at;

    alter table public.notifications
      drop constraint notifications_event_type_check;
    alter table public.notifications
      add constraint notifications_event_type_check
        check (event_type is null or event_type in (${sqlList(coreEventTypes)}));
    comment on column public.notifications.event_type is
      'Decision 0177: fine-grained inbox event (launch.graduated, launch.badge_minted, social.friend_request, social.friend_accepted); null for older producers. type stays the preference category.';
  `);
}
