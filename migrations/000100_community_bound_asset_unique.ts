import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0182 (S299): one token, one community.
 *
 * 1. Clean the existing duplicates. For every `bound_asset_key` held by more
 *    than one community whose `verification_status` is not `rejected`, the
 *    keeper is the `verified` one created first (falling back to the first
 *    created, then the lowest `community_id`); every other holder gets
 *    `bound_asset_key = null` (plus `record_version + 1`, `updated_at`) and
 *    one `community_role_events` operator row
 *    (`community_profile_updated` / `bound_asset_dedup_0182`). Each release
 *    raises a NOTICE naming the released community, the asset, and the
 *    keeper, then one NOTICE with the total. `communities` has no other
 *    column derived from `bound_asset_key`; history tables that recorded a
 *    community + asset pair (buy feed, mining snapshots / settlements) are
 *    facts of their time and are left alone.
 * 2. Enforce it: a partial unique index on `bound_asset_key` over the rows
 *    that are bound and not rejected. A rejected community does not occupy
 *    its token, so it can be bound by another community meanwhile.
 *
 * `down` only drops the index; released bindings are not restored.
 */

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$
    declare
      released record;
      released_count integer := 0;
    begin
      for released in
        with ranked as (
          select
            community_id,
            bound_asset_key,
            first_value(community_id) over holders as kept_community_id,
            row_number() over holders as holder_rank
          from public.communities
          where bound_asset_key is not null
            and verification_status <> 'rejected'
          window holders as (
            partition by bound_asset_key
            order by (verification_status = 'verified') desc,
              created_at asc,
              community_id asc
          )
        )
        select community_id, bound_asset_key, kept_community_id
        from ranked
        where holder_rank > 1
        order by bound_asset_key, holder_rank
      loop
        update public.communities
        set bound_asset_key = null,
          record_version = record_version + 1,
          updated_at = clock_timestamp()
        where community_id = released.community_id;

        insert into public.community_role_events (
          community_id, actor_user_id, actor_type, target_user_id,
          event_type, reason_code, idempotency_record_id, request_id
        )
        values (released.community_id, null, 'operator', null,
          'community_profile_updated', 'bound_asset_dedup_0182', null, null);

        raise notice 'Decision 0182: community % released bound asset % (kept by community %)',
          released.community_id, released.bound_asset_key,
          released.kept_community_id;
        released_count := released_count + 1;
      end loop;

      raise notice 'Decision 0182: % duplicate community binding(s) released',
        released_count;
    end
    $$;

    create unique index communities_bound_asset_key_unique
      on public.communities (bound_asset_key)
      where bound_asset_key is not null
        and verification_status <> 'rejected';

    comment on index public.communities_bound_asset_key_unique is
      'Decision 0182: one token, one community. At most one community that is not rejected binds a bound_asset_key; a rejected community does not occupy its token.';
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    drop index public.communities_bound_asset_key_unique;
  `);
}
