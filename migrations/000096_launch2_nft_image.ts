import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Decision 0173 (S274): the project NFT picture.
 *
 * 1. `media_objects`: a new kind `project_nft_image` (uploaded through
 *    `POST /v2/media/project-nft-images`, owner-bound like
 *    `community_logo`) and `ipfs_cid`, the IPFS CID the picture was pinned
 *    under (Filebase), set at insert — rows stay immutable (000046 trigger).
 *    Only a `project_nft_image` may carry a CID; null = stored locally only
 *    (`NFT_IMAGE_STORAGE=local`). A partial index serves the draft lookup
 *    by (owner, CID).
 * 2. `launch2_instances.nft_image_url` / `nft_image_cid`: copied at
 *    activation from the signed Hooks launch config's optional
 *    `nftImageAssetUrl` / `nftImageCid`, like `logo_url` from
 *    `logoAssetUrl` (000061). Null when the config has none — every
 *    existing row — and the App / NFT metadata then fall back to the logo.
 *    Rows activated before this migration are back-filled from their
 *    config version (none carries the keys yet; a no-op today).
 *
 * 3. `hooks_launch_project_config_versions.hooks_launch_config_object`
 *    (000078) admits two optional keys: `nftImageAssetUrl` (an https
 *    string of at most 2048 characters) and `nftImageCid` (a CID, only
 *    next to `nftImageAssetUrl`). Every other rule is unchanged; versions
 *    stay append-only.
 *
 * Number 000095 is taken by S272 on another branch
 * (`000095_friend_direct_channel_jobs`); this migration does not depend on
 * it, but 000095 must be applied first (node-pg-migrate checks order).
 * `down` refuses while a `project_nft_image` object or a config carrying
 * either key exists, then drops the columns (copies of config data) and
 * restores the 000078 config check.
 */

const cidPattern = "^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,100})$";

const requiredConfigKeys = `array[
          'templateVersion','templateHash','name','ticker','logoAssetUrl',
          'description','links','nftSaleStartAt','buybackRecipient',
          'fixedEconomics','configHash'
        ]`;

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    alter table public.media_objects
      drop constraint media_objects_kind_check,
      add constraint media_objects_kind_check
        check (kind in ('avatar', 'community_logo', 'campaign_cover',
          'project_nft_image')),
      add column ipfs_cid text,
      add constraint media_objects_ipfs_cid_check
        check (ipfs_cid is null
          or (kind = 'project_nft_image' and ipfs_cid ~ '${cidPattern}'));

    create index media_objects_project_nft_cid_idx
      on public.media_objects (owner_user_id, ipfs_cid)
      where kind = 'project_nft_image' and ipfs_cid is not null;

    comment on column public.media_objects.ipfs_cid is
      'Decision 0173: the IPFS CID a project_nft_image was pinned under (Filebase); null = local only.';

    alter table public.launch2_instances
      add column nft_image_url text,
      add column nft_image_cid text,
      add constraint launch2_instances_nft_image_url_check
        check (nft_image_url is null or char_length(nft_image_url) <= 2048),
      add constraint launch2_instances_nft_image_cid_check
        check (nft_image_cid is null or nft_image_cid ~ '${cidPattern}');

    update public.launch2_instances i
      set nft_image_url = nullif(v.config ->> 'nftImageAssetUrl', ''),
        nft_image_cid = case
          when v.config ->> 'nftImageCid' ~ '${cidPattern}'
            then v.config ->> 'nftImageCid' end
      from public.hooks_launch_project_config_versions v
      where v.project_id = i.project_id
        and v.config_version = i.config_version
        and nullif(v.config ->> 'nftImageAssetUrl', '') is not null
        and char_length(v.config ->> 'nftImageAssetUrl') <= 2048;

    comment on column public.launch2_instances.nft_image_url is
      'Decision 0173: the project NFT picture (https, the IPFS gateway URL when pinned) copied from the signed config nftImageAssetUrl at activation; null = none (fall back to logo_url).';
    comment on column public.launch2_instances.nft_image_cid is
      'Decision 0173: the IPFS CID of nft_image_url (config nftImageCid); null = not pinned.';

    alter table public.hooks_launch_project_config_versions
      drop constraint hooks_launch_config_object;
    alter table public.hooks_launch_project_config_versions
      add constraint hooks_launch_config_object check (
        jsonb_typeof(config) = 'object'
        and config ?& ${requiredConfigKeys}
        and config - (${requiredConfigKeys}
          || array['poolHookKind', 'nftImageAssetUrl', 'nftImageCid'])::text[]
          = '{}'::jsonb
        and (not config ? 'poolHookKind'
          or config->>'poolHookKind' = 'loopDynamic')
        and (not config ? 'nftImageAssetUrl'
          or (jsonb_typeof(config->'nftImageAssetUrl') = 'string'
            and config->>'nftImageAssetUrl' like 'https://%'
            and char_length(config->>'nftImageAssetUrl') <= 2048))
        and (not config ? 'nftImageCid'
          or (config ? 'nftImageAssetUrl'
            and jsonb_typeof(config->'nftImageCid') = 'string'
            and config->>'nftImageCid' ~ '${cidPattern}'))
        and config->>'templateVersion' = template_version
        and config->>'configHash' = config_hash
      );
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
    do $$
    begin
      if exists (select 1 from public.media_objects
                 where kind = 'project_nft_image')
      then
        raise exception 'project_nft_image media exist; refusing to roll back 000096';
      end if;
      if exists (select 1 from public.hooks_launch_project_config_versions
                 where config ? 'nftImageAssetUrl' or config ? 'nftImageCid')
      then
        raise exception 'configs with an NFT picture exist; refusing to roll back 000096';
      end if;
    end
    $$;

    alter table public.hooks_launch_project_config_versions
      drop constraint hooks_launch_config_object;
    alter table public.hooks_launch_project_config_versions
      add constraint hooks_launch_config_object check (
        jsonb_typeof(config) = 'object'
        and config ?& ${requiredConfigKeys}
        and config - (${requiredConfigKeys} || array['poolHookKind'])::text[] = '{}'::jsonb
        and (not config ? 'poolHookKind'
          or config->>'poolHookKind' = 'loopDynamic')
        and config->>'templateVersion' = template_version
        and config->>'configHash' = config_hash
      );

    alter table public.launch2_instances
      drop constraint launch2_instances_nft_image_cid_check,
      drop constraint launch2_instances_nft_image_url_check,
      drop column nft_image_cid,
      drop column nft_image_url;

    drop index public.media_objects_project_nft_cid_idx;

    alter table public.media_objects
      drop constraint media_objects_ipfs_cid_check,
      drop column ipfs_cid,
      drop constraint media_objects_kind_check,
      add constraint media_objects_kind_check
        check (kind in ('avatar', 'community_logo', 'campaign_cover'));
  `);
}
