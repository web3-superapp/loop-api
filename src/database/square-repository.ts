import type { Pool } from "pg";

import { formatLaunch2Amount } from "../features/launch2/launch2-contract.js";
import {
  isSquarePostKind,
  isSquarePostStatus,
  type SquareAdminAction,
  type SquareAuthor,
  type SquareEventCandidate,
  type SquareEventFacts,
  type SquareFeedRecord,
  type SquarePostRecord,
  type SquareRepository,
  type SquareSystemFields,
  type SquareTokenFacts,
  type SquareTokenRef,
} from "../features/square/square-contract.js";
import { insertAdminAuditRow } from "./admin-repository.js";
import {
  lockV2Owner,
  toIsoString,
  withV2Transaction,
} from "./v2-command-support.js";

/**
 * Decision 0143: PostgreSQL side of the square timeline (migration
 * 000084). Feed reads decorate each post with its author (active profile
 * only), like count, the viewer's like, and the referenced token's raw
 * quote facts in one statement. Console writes lock the row, update it and
 * write their `admin_audit_log` row (`square.post.<action>`, target
 * `square_post`) in one transaction. The ingest lane's reads anti-join
 * `square_posts.source_event_id`, so a pass only sees events not yet
 * written.
 */

export class SquareRepositoryUnavailableError extends Error {
  constructor() {
    super("Square repository returned an unexpected row");
    this.name = "SquareRepositoryUnavailableError";
  }
}

type Row = Record<string, unknown>;

function fail(): never {
  throw new SquareRepositoryUnavailableError();
}

function text(row: Row, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : fail();
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : fail();
}

function timestamp(row: Row, key: string): string {
  const value = row[key];
  return value instanceof Date || typeof value === "string"
    ? toIsoString(value)
    : fail();
}

function nullableTimestamp(row: Row, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : timestamp(row, key);
}

function integer(row: Row, key: string): number {
  const value = Number(row[key]);
  return Number.isSafeInteger(value) && value >= 0 ? value : fail();
}

const postColumns = `
  p.post_id::text as post_id, p.kind, p.status, p.text, p.token_kind,
  p.token_id::text as token_id, p.event_payload, p.source_event_id, p.pinned,
  p.published_at, p.created_at, p.updated_at,
  author_profile.public_profile_id::text as author_public_profile_id,
  author_user.loop_id as author_loop_id,
  author_profile.alias as author_alias,
  author_profile.avatar_ref as author_avatar_ref,
  (select count(*) from public.square_post_likes as l
    where l.post_id = p.post_id)::integer as like_count`;

const authorJoins = `
  left join public.loop_users as author_user
    on author_user.id = p.author_user_id
  left join public.user_profiles as author_profile
    on author_profile.owner_user_id = p.author_user_id`;

/** Decoration of a feed page `p` for viewer `$1` at instant `$2`. */
const feedDecoration = `
  ${postColumns},
  exists (select 1 from public.square_post_likes as l
    where l.post_id = p.post_id and l.user_id = $1) as liked_by_viewer,
  meme.symbol as meme_symbol,
  meme.image_media_id::text as meme_image_media_id,
  meme.status as meme_status,
  meme.v_usd1::text as meme_v_usd1,
  meme.v_token::text as meme_v_token,
  meme_ago.price as meme_price_1h_ago,
  instance.ticker as launch2_ticker,
  instance.logo_url as launch2_logo_url,
  (instance.graduated_at is not null) as launch2_graduated,
  instance.price_e18::text as launch2_price_e18,
  instance.pool_last_price_e18::text as launch2_pool_last_price_e18,
  pool_ago.price as launch2_pool_price_1h_ago`;

const feedJoins = `
  ${authorJoins}
  left join public.meme_tokens as meme
    on p.token_kind = 'meme' and meme.meme_token_id = p.token_id
  left join lateral (
    select tr.price_after_e18::text as price
    from public.meme_trades as tr
    where tr.meme_token_id = meme.meme_token_id and not tr.removed
      and tr.traded_at <= $2::timestamptz - interval '1 hour'
    order by tr.traded_at desc, tr.block_number desc, tr.log_index desc
    limit 1
  ) as meme_ago on true
  left join public.launch2_instances as instance
    on p.token_kind = 'launch2' and instance.instance_id = p.token_id
  left join lateral (
    select swap.price_e18::text as price
    from public.launch2_pool_swaps as swap
    where swap.instance_id = instance.instance_id and not swap.removed
      and swap.swapped_at <= $2::timestamptz - interval '1 hour'
    order by swap.swapped_at desc, swap.block_number desc, swap.log_index desc
    limit 1
  ) as pool_ago on true`;

/**
 * Visibility of a published post `p` to viewer `$1`: system posts always;
 * a user post only while its author has an active profile, and never
 * across a block in either direction.
 */
const visibleTo = `
  (p.author_user_id is null or (
    exists (
      select 1 from public.user_profiles as visible_profile
      join public.loop_users as visible_user
        on visible_user.id = visible_profile.owner_user_id
      where visible_profile.owner_user_id = p.author_user_id
        and visible_profile.profile_status = 'active'
        and visible_user.loop_id is not null
    )
    and not exists (
      select 1 from public.user_blocks as block
      where block.kind = 'user'
        and ((block.owner_user_id = $1 and block.target_user_id = p.author_user_id)
          or (block.owner_user_id = p.author_user_id and block.target_user_id = $1))
    )
  ))`;

function mapTokenRef(row: Row): SquareTokenRef | null {
  const kind = row["token_kind"];
  const id = nullableText(row, "token_id");
  if (kind === null || kind === undefined || id === null) return null;
  if (kind !== "meme" && kind !== "launch2") fail();
  return Object.freeze({ kind, id });
}

function mapAuthor(row: Row): SquareAuthor | null {
  const publicProfileId = nullableText(row, "author_public_profile_id");
  const loopId = nullableText(row, "author_loop_id");
  if (publicProfileId === null || loopId === null) return null;
  return Object.freeze({
    publicProfileId,
    loopId,
    alias: nullableText(row, "author_alias"),
    avatarRef: nullableText(row, "author_avatar_ref"),
  });
}

function mapEvent(row: Row): SquareEventFacts | null {
  const value = row["event_payload"];
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) fail();
  const out: Record<string, string | null> = {};
  for (const [key, entry] of Object.entries(value as Row)) {
    out[key] = typeof entry === "string" ? entry : null;
  }
  return Object.freeze(out);
}

function mapPost(row: Row): SquarePostRecord {
  const kind = row["kind"];
  const status = row["status"];
  const pinned = row["pinned"];
  if (
    !isSquarePostKind(kind) ||
    !isSquarePostStatus(status) ||
    typeof pinned !== "boolean"
  ) {
    fail();
  }
  return Object.freeze({
    postId: text(row, "post_id"),
    kind,
    status,
    text: nullableText(row, "text"),
    tokenRef: mapTokenRef(row),
    event: mapEvent(row),
    sourceEventId: nullableText(row, "source_event_id"),
    pinned,
    author: mapAuthor(row),
    publishedAt: nullableTimestamp(row, "published_at"),
    createdAt: timestamp(row, "created_at"),
    updatedAt: timestamp(row, "updated_at"),
  });
}

function mapTokenFacts(
  row: Row,
  ref: SquareTokenRef | null,
): SquareTokenFacts | null {
  if (ref === null) return null;
  if (ref.kind === "meme") {
    const symbol = nullableText(row, "meme_symbol");
    if (symbol === null) return null;
    return Object.freeze({
      kind: "meme",
      id: ref.id,
      symbol,
      imageMediaId: nullableText(row, "meme_image_media_id"),
      status: text(row, "meme_status"),
      vUsd1: text(row, "meme_v_usd1"),
      vToken: text(row, "meme_v_token"),
      price1hAgoE18: nullableText(row, "meme_price_1h_ago"),
    });
  }
  const symbol = nullableText(row, "launch2_ticker");
  if (symbol === null) return null;
  return Object.freeze({
    kind: "launch2",
    id: ref.id,
    symbol,
    logoUrl: nullableText(row, "launch2_logo_url"),
    graduated: row["launch2_graduated"] === true,
    curvePriceE18: text(row, "launch2_price_e18"),
    poolLastPriceE18: nullableText(row, "launch2_pool_last_price_e18"),
    poolPrice1hAgoE18: nullableText(row, "launch2_pool_price_1h_ago"),
  });
}

function mapFeed(row: Row): SquareFeedRecord {
  const post = mapPost(row);
  return Object.freeze({
    ...post,
    likeCount: integer(row, "like_count"),
    likedByViewer: row["liked_by_viewer"] === true,
    token: mapTokenFacts(row, post.tokenRef),
  });
}

function mapAdmin(row: Row): SquarePostRecord & { readonly likeCount: number } {
  return Object.freeze({
    ...mapPost(row),
    likeCount: integer(row, "like_count"),
  });
}

function snapshot(record: {
  readonly kind: string;
  readonly text: string | null;
  readonly tokenRef: SquareTokenRef | null;
  readonly pinned: boolean;
  readonly status: string;
}): Record<string, unknown> {
  return {
    kind: record.kind,
    text: record.text,
    tokenRef: record.tokenRef,
    pinned: record.pinned,
    status: record.status,
  };
}

const actions: Readonly<Record<SquareAdminAction | "create", string>> =
  Object.freeze({
    create: "square.post.create",
    update: "square.post.update",
    publish: "square.post.publish",
    archive: "square.post.archive",
  });

function percentBps(part: bigint, total: bigint): string | null {
  if (total <= 0n) return null;
  const hundredths = (part * 10_000n) / total;
  return `${(hundredths / 100n).toString(10)}.${(hundredths % 100n)
    .toString(10)
    .padStart(2, "0")}`;
}

function tokenRefOf(
  memeTokenId: string | null,
  instanceId: string | null,
): SquareTokenRef | null {
  if (instanceId !== null) return { kind: "launch2", id: instanceId };
  if (memeTokenId !== null) return { kind: "meme", id: memeTokenId };
  return null;
}

export function createPostgresSquareRepository(pool: Pool): SquareRepository {
  const unavailable = (): Error => new SquareRepositoryUnavailableError();

  async function feedRows(
    where: string,
    values: unknown[],
    order: string,
    limit: number,
  ): Promise<readonly SquareFeedRecord[]> {
    const result = await pool.query<Row>(
      `with page as (
         select p.* from public.square_posts as p
         where ${where} and ${visibleTo}
         order by ${order}
         limit ${String(limit)}
       )
       select ${feedDecoration}
       from page as p
       ${feedJoins}
       order by ${order}`,
      values,
    );
    return result.rows.map(mapFeed);
  }

  async function adminRead(
    where: string,
    values: unknown[],
    limit: number,
  ): Promise<readonly (SquarePostRecord & { readonly likeCount: number })[]> {
    const result = await pool.query<Row>(
      `select ${postColumns}
       from public.square_posts as p
       ${authorJoins}
       where ${where}
       order by p.created_at desc, p.post_id asc
       limit ${String(limit)}`,
      values,
    );
    return result.rows.map(mapAdmin);
  }

  const repository: SquareRepository = {
    listPinned(input) {
      return feedRows(
        `p.status = 'published' and p.pinned`,
        [input.viewerUserId, input.now],
        `p.published_at desc, p.post_id desc`,
        input.limit,
      );
    },

    listTimeline(input) {
      return feedRows(
        `p.status = 'published' and not p.pinned
         and ($3::text <> 'following' or p.author_user_id in (
           select edge.followee_user_id from public.follow_edges as edge
           where edge.follower_user_id = $1))
         and ($4::timestamptz is null
           or (p.published_at, p.post_id) < ($4::timestamptz, $5::uuid))`,
        [
          input.viewerUserId,
          input.now,
          input.scope,
          input.before?.publishedAt ?? null,
          input.before?.postId ?? null,
        ],
        `p.published_at desc, p.post_id desc`,
        input.limit,
      );
    },

    async getFeedPost(input) {
      const rows = await feedRows(
        `p.post_id = $3::uuid and p.status = 'published'`,
        [input.viewerUserId, input.now, input.postId],
        `p.published_at desc, p.post_id desc`,
        1,
      );
      return rows[0] ?? null;
    },

    async tokenRefExists(ref) {
      const result = await pool.query<{ found: boolean }>(
        ref.kind === "meme"
          ? `select exists (select 1 from public.meme_tokens
               where meme_token_id = $1 and token_address is not null) as found`
          : `select exists (select 1 from public.launch2_instances
               where instance_id = $1) as found`,
        [ref.id],
      );
      return result.rows[0]?.found === true;
    },

    async createOpinion(input) {
      return withV2Transaction(pool, unavailable, async (client) => {
        await lockV2Owner(client, input.authorUserId, unavailable);
        const profile = await client.query<{ active: boolean }>(
          `select exists (
             select 1 from public.user_profiles as profile
             join public.loop_users as account on account.id = profile.owner_user_id
             where profile.owner_user_id = $1 and profile.profile_status = 'active'
               and account.loop_id is not null
           ) as active`,
          [input.authorUserId],
        );
        if (profile.rows[0]?.active !== true) {
          return { status: "profile_required" as const };
        }
        const earlier = await client.query<Row>(
          `select post_id::text as post_id, create_request_sha256
           from public.square_posts
           where kind = 'opinion' and author_user_id = $1
             and create_idempotency_key = $2`,
          [input.authorUserId, input.idempotency.key],
        );
        const earlierRow = earlier.rows[0];
        if (earlierRow !== undefined) {
          return earlierRow["create_request_sha256"] ===
            input.idempotency.requestSha256
            ? {
                status: "replayed" as const,
                postId: text(earlierRow, "post_id"),
              }
            : { status: "conflict" as const };
        }
        const recent = await client.query<{ count: number }>(
          `select count(*)::integer as count from public.square_posts
           where kind = 'opinion' and author_user_id = $1
             and created_at > $2::timestamptz - ($3::integer * interval '1 millisecond')`,
          [input.authorUserId, input.now, input.windowMs],
        );
        if ((recent.rows[0]?.count ?? 0) >= input.postsPerMinute) {
          return { status: "rate_limited" as const };
        }
        await client.query(
          `insert into public.square_posts (
             post_id, kind, author_user_id, text, token_kind, token_id,
             status, published_at, create_idempotency_key,
             create_request_sha256, created_at, updated_at
           )
           values ($1, 'opinion', $2, $3, $4, $5, 'published', $6, $7, $8,
             $6, $6)`,
          [
            input.postId,
            input.authorUserId,
            input.text,
            input.tokenRef?.kind ?? null,
            input.tokenRef?.id ?? null,
            input.now,
            input.idempotency.key,
            input.idempotency.requestSha256,
          ],
        );
        return { status: "created" as const, postId: input.postId };
      });
    },

    async archiveOwnPost(input) {
      const result = await pool.query<{ status: string }>(
        `with target as (
           select post_id, status from public.square_posts
           where post_id = $1 and author_user_id = $2 and kind = 'opinion'
           for update
         ),
         updated as (
           update public.square_posts as p set
             status = 'archived', archived_by = 'author',
             updated_at = greatest($3::timestamptz, p.created_at)
           from target
           where p.post_id = target.post_id and target.status <> 'archived'
           returning p.post_id
         )
         select status from target`,
        [input.postId, input.authorUserId, input.now],
      );
      return result.rows[0] !== undefined;
    },

    async setLike(input) {
      return withV2Transaction(pool, unavailable, async (client) => {
        const post = await client.query<Row>(
          `select post_id from public.square_posts
           where post_id = $1 and status = 'published' for share`,
          [input.postId],
        );
        if (post.rows[0] === undefined) return null;
        await client.query(
          input.liked
            ? `insert into public.square_post_likes (post_id, user_id)
               values ($1, $2) on conflict do nothing`
            : `delete from public.square_post_likes
               where post_id = $1 and user_id = $2`,
          [input.postId, input.userId],
        );
        const count = await client.query<{ count: number }>(
          `select count(*)::integer as count from public.square_post_likes
           where post_id = $1`,
          [input.postId],
        );
        return { likeCount: count.rows[0]?.count ?? 0 };
      });
    },

    adminList(input) {
      return adminRead(
        `($1::text is null or p.status = $1) and ($2::text is null or p.kind = $2)`,
        [input.status, input.kind],
        input.limit,
      );
    },

    async adminGet(postId) {
      const rows = await adminRead(`p.post_id = $1::uuid`, [postId], 1);
      return rows[0] ?? null;
    },

    async adminCreate(input) {
      return withV2Transaction(pool, unavailable, async (client) => {
        const key = input.idempotency;
        if (key !== null) {
          await client.query(
            `select pg_advisory_xact_lock(hashtextextended($1, 143))`,
            [key.key],
          );
          const earlier = await client.query<Row>(
            `select post_id::text as post_id, create_request_sha256
             from public.square_posts
             where kind = 'system' and create_idempotency_key = $1`,
            [key.key],
          );
          const earlierRow = earlier.rows[0];
          if (earlierRow !== undefined) {
            if (earlierRow["create_request_sha256"] !== key.requestSha256) {
              return { status: "conflict" as const };
            }
            const postId = text(earlierRow, "post_id");
            const audit = await client.query<Row>(
              `select audit_id::text as audit_id, seq, at
               from public.admin_audit_log
               where target_type = 'square_post' and target_id = $1
                 and action = $2
               order by seq asc limit 1`,
              [postId, actions.create],
            );
            const auditRow = audit.rows[0];
            if (auditRow === undefined) fail();
            return {
              status: "replayed" as const,
              postId,
              audit: {
                auditId: text(auditRow, "audit_id"),
                seq: Number(auditRow["seq"]),
                at: timestamp(auditRow, "at"),
              },
            };
          }
        }
        await client.query(
          `insert into public.square_posts (
             post_id, kind, author_user_id, text, token_kind, token_id,
             pinned, status, created_by, created_by_actor,
             create_idempotency_key, create_request_sha256, created_at,
             updated_at
           )
           values ($1, 'system', null, $2, $3, $4, $5, 'draft', $6, $7, $8,
             $9, $10, $10)`,
          [
            input.postId,
            input.fields.text,
            input.fields.tokenRef?.kind ?? null,
            input.fields.tokenRef?.id ?? null,
            input.fields.pinned,
            input.audit.actorAccountId,
            input.audit.actor,
            key?.key ?? null,
            key?.requestSha256 ?? null,
            input.now,
          ],
        );
        const audit = await insertAdminAuditRow(client, {
          actor: input.audit.actor,
          actorAccountId: input.audit.actorAccountId,
          action: actions.create,
          targetType: "square_post",
          targetId: input.postId,
          before: null,
          after: snapshot({ kind: "system", ...input.fields, status: "draft" }),
          requestId: input.audit.requestId,
        });
        return {
          status: "created" as const,
          postId: input.postId,
          audit: { auditId: audit.auditId, seq: audit.seq, at: audit.at },
        };
      });
    },

    async adminTransition(input) {
      return withV2Transaction(pool, unavailable, async (client) => {
        const current = await client.query<Row>(
          `select ${postColumns}
           from public.square_posts as p
           ${authorJoins}
           where p.post_id = $1
           for update of p`,
          [input.postId],
        );
        const row = current.rows[0];
        if (row === undefined) return { status: "not_found" as const };
        const before = mapPost(row);
        const decision = input.decide(before);
        if (decision.kind === "refuse") {
          return {
            status: "refused" as const,
            reasonCode: decision.reasonCode,
            current: before,
          };
        }
        const fields: SquareSystemFields | null = decision.fields;
        await client.query(
          `update public.square_posts set
             text = coalesce($2, text),
             token_kind = case when $5::boolean then $3 else token_kind end,
             token_id = case when $5::boolean then $4::uuid else token_id end,
             pinned = coalesce($6, pinned),
             status = $7,
             published_at = case
               when $7 = 'published' and published_at is null then $8::timestamptz
               else published_at end,
             archived_by = case when $7 = 'archived' then 'console' else null end,
             updated_at = greatest($8::timestamptz, created_at)
           where post_id = $1`,
          [
            input.postId,
            fields?.text ?? null,
            fields?.tokenRef?.kind ?? null,
            fields?.tokenRef?.id ?? null,
            fields !== null,
            fields?.pinned ?? null,
            decision.status,
            input.now,
          ],
        );
        const after = {
          kind: before.kind,
          text: fields?.text ?? before.text,
          tokenRef: fields === null ? before.tokenRef : fields.tokenRef,
          pinned: fields?.pinned ?? before.pinned,
          status: decision.status,
        };
        const audit = await insertAdminAuditRow(client, {
          actor: input.audit.actor,
          actorAccountId: input.audit.actorAccountId,
          action: actions[input.action],
          targetType: "square_post",
          targetId: input.postId,
          before: snapshot(before),
          after: snapshot(after),
          requestId: input.audit.requestId,
        });
        return {
          status: "written" as const,
          audit: { auditId: audit.auditId, seq: audit.seq, at: audit.at },
        };
      });
    },

    async listBuyCandidates(input) {
      const result = await pool.query<Row>(
        `with buys as (
           select distinct on (e.chain_id, e.transaction_hash, e.log_index)
             'buy:' || e.chain_id || ':' || e.transaction_hash || ':'
               || e.log_index::text as source_event_id,
             e.buyer_user_id::text as author_user_id,
             coalesce(ev.block_timestamp, e.created_at) as occurred_at,
             case when pool_row.token0_asset_id = community.bound_asset_key
               then ev.amount1 else ev.amount0 end::text as quote_amount,
             case when pool_row.token0_asset_id = community.bound_asset_key
               then ev.amount0 else ev.amount1 end::text as base_amount,
             quote_asset.decimals as quote_decimals,
             base_asset.decimals as base_decimals,
             e.transaction_hash,
             meme.meme_token_id::text as meme_token_id,
             instance.instance_id::text as instance_id
           from public.community_member_buy_events as e
           join public.communities as community
             on community.community_id = e.community_id
           join public.indexed_pool_events as ev
             on ev.chain_id = e.chain_id
             and ev.transaction_hash = e.transaction_hash
             and ev.log_index = e.log_index
             and ev.event_kind = 'swap' and not ev.removed
           join public.pools as pool_row on pool_row.pool_id = ev.pool_id
           join public.assets as base_asset
             on base_asset.asset_id = community.bound_asset_key
           join public.assets as quote_asset
             on quote_asset.asset_id = case
               when pool_row.token0_asset_id = community.bound_asset_key
               then pool_row.token1_asset_id else pool_row.token0_asset_id end
           join public.user_profiles as profile
             on profile.owner_user_id = e.buyer_user_id
             and profile.profile_status = 'active'
           left join public.meme_tokens as meme
             on meme.chain_id = e.chain_id and meme.token_address is not null
             and community.bound_asset_key = meme.chain_id || ':' || meme.token_address
           left join public.launch2_instances as instance
             on instance.chain_id = e.chain_id
             and community.bound_asset_key = instance.chain_id || ':' || instance.meme_address
           where e.outcome in ('sent', 'truncated', 'rejected', 'skipped_no_channel')
             and e.created_at >= $1
             and community.bound_asset_key in
               (pool_row.token0_asset_id, pool_row.token1_asset_id)
             and lower(quote_asset.address) = any($2::text[])
             and not exists (
               select 1 from public.square_posts as existing
               where existing.source_event_id = 'buy:' || e.chain_id || ':'
                 || e.transaction_hash || ':' || e.log_index::text)
           order by e.chain_id, e.transaction_hash, e.log_index, e.created_at
         )
         select * from buys
         order by occurred_at asc, source_event_id asc
         limit $3`,
        [input.since, input.stableAddresses, input.limit],
      );
      return result.rows.map((row) =>
        Object.freeze({
          sourceEventId: text(row, "source_event_id"),
          authorUserId: text(row, "author_user_id"),
          occurredAt: timestamp(row, "occurred_at"),
          tokenRef: tokenRefOf(
            nullableText(row, "meme_token_id"),
            nullableText(row, "instance_id"),
          ),
          quoteAmountRaw: text(row, "quote_amount"),
          quoteDecimals: integer(row, "quote_decimals"),
          baseAmountRaw: text(row, "base_amount"),
          baseDecimals: integer(row, "base_decimals"),
          transactionHash: text(row, "transaction_hash"),
        }),
      );
    },

    async listClaimCandidates(input) {
      const result = await pool.query<Row>(
        `select
           'claim:' || c.chain_id || ':' || c.transaction_hash || ':'
             || c.log_index::text as source_event_id,
           wallet.owner_user_id::text as author_user_id,
           c.claimed_at as occurred_at,
           c.instance_id::text as instance_id,
           c.amount_usd1::text as amount_usd1,
           c.round_id::text as round_id,
           c.transaction_hash,
           weight.weight_usd1::text as weight_usd1,
           round_row.total_buy_weight_usd1::text as total_weight_usd1
         from public.launch2_dynamic_claims as c
         cross join lateral (
           select w.owner_user_id from public.account_wallets as w
           where w.status = 'active' and w.address = c.buyer_address
           order by w.owner_user_id limit 1
         ) as wallet
         join public.user_profiles as profile
           on profile.owner_user_id = wallet.owner_user_id
           and profile.profile_status = 'active'
         left join public.privacy_preferences_v2 as privacy
           on privacy.owner_user_id = wallet.owner_user_id
         left join public.launch2_dynamic_buy_weights as weight
           on weight.instance_id = c.instance_id and weight.round_id = c.round_id
           and weight.buyer_address = c.buyer_address
         left join public.launch2_dynamic_rounds as round_row
           on round_row.instance_id = c.instance_id and round_row.round_id = c.round_id
         where not c.removed and c.observed_at >= $1
           and coalesce(privacy.trade_history_visibility, 'everyone') = 'everyone'
           and not coalesce(privacy.anonymous_mode, false)
           and not exists (
             select 1 from public.square_posts as existing
             where existing.source_event_id = 'claim:' || c.chain_id || ':'
               || c.transaction_hash || ':' || c.log_index::text)
         order by c.claimed_at asc, c.transaction_hash asc, c.log_index asc
         limit $2`,
        [input.since, input.limit],
      );
      return result.rows.map((row): SquareEventCandidate =>
        Object.freeze({
          kind: "claim",
          sourceEventId: text(row, "source_event_id"),
          authorUserId: text(row, "author_user_id"),
          occurredAt: timestamp(row, "occurred_at"),
          tokenRef: { kind: "launch2" as const, id: text(row, "instance_id") },
          event: Object.freeze({
            amountUsd1: formatLaunch2Amount(BigInt(text(row, "amount_usd1"))),
            roundId: text(row, "round_id"),
            weightPct:
              nullableText(row, "weight_usd1") === null ||
              nullableText(row, "total_weight_usd1") === null
                ? null
                : percentBps(
                    BigInt(text(row, "weight_usd1")),
                    BigInt(text(row, "total_weight_usd1")),
                  ),
            transactionHash: text(row, "transaction_hash"),
          }),
        }),
      );
    },

    async listGraduationCandidates(input) {
      const result = await pool.query<Row>(
        `select * from (
           select 'graduation:launch2:' || instance.instance_id::text as source_event_id,
             instance.owner_user_id::text as author_user_id,
             instance.graduated_at as occurred_at,
             'launch2' as token_kind,
             instance.instance_id::text as token_id,
             instance.graduation_transaction_hash as transaction_hash
           from public.launch2_instances as instance
           join public.user_profiles as profile
             on profile.owner_user_id = instance.owner_user_id
             and profile.profile_status = 'active'
           where instance.graduated_at >= $1
             and not exists (
               select 1 from public.square_posts as existing
               where existing.source_event_id =
                 'graduation:launch2:' || instance.instance_id::text)
           union all
           select 'graduation:meme:' || meme.meme_token_id::text,
             meme.creator_user_id::text,
             meme.graduated_at,
             'meme',
             meme.meme_token_id::text,
             meme.graduation_tx_hash
           from public.meme_tokens as meme
           join public.user_profiles as profile
             on profile.owner_user_id = meme.creator_user_id
             and profile.profile_status = 'active'
           where meme.status = 'graduated' and meme.graduated_at >= $1
             and not exists (
               select 1 from public.square_posts as existing
               where existing.source_event_id =
                 'graduation:meme:' || meme.meme_token_id::text)
         ) as graduations
         order by occurred_at asc, source_event_id asc
         limit $2`,
        [input.since, input.limit],
      );
      return result.rows.map((row): SquareEventCandidate => {
        const raw = row["token_kind"];
        const kind: SquareTokenRef["kind"] =
          raw === "meme" || raw === "launch2" ? raw : fail();
        return Object.freeze({
          kind: "graduation",
          sourceEventId: text(row, "source_event_id"),
          authorUserId: text(row, "author_user_id"),
          occurredAt: timestamp(row, "occurred_at"),
          tokenRef: { kind, id: text(row, "token_id") },
          event: Object.freeze({
            transactionHash: nullableText(row, "transaction_hash"),
          }),
        });
      });
    },

    async insertEventPosts(input) {
      if (input.posts.length === 0) return 0;
      const result = await pool.query(
        `insert into public.square_posts (
           post_id, kind, author_user_id, token_kind, token_id, event_payload,
           source_event_id, status, published_at, created_at, updated_at
         )
         select candidate.post_id, candidate.kind, candidate.author_user_id,
           candidate.token_kind, candidate.token_id, candidate.event_payload,
           candidate.source_event_id, 'published', candidate.published_at,
           clock_timestamp(), clock_timestamp()
         from unnest($1::uuid[], $2::text[], $3::uuid[], $4::text[],
           $5::uuid[], $6::jsonb[], $7::text[], $8::timestamptz[])
           as candidate(post_id, kind, author_user_id, token_kind, token_id,
             event_payload, source_event_id, published_at)
         on conflict (source_event_id) where source_event_id is not null
           do nothing`,
        [
          input.posts.map((post) => post.postId),
          input.posts.map((post) => post.kind),
          input.posts.map((post) => post.authorUserId),
          input.posts.map((post) => post.tokenRef?.kind ?? null),
          input.posts.map((post) => post.tokenRef?.id ?? null),
          input.posts.map((post) => JSON.stringify(post.event)),
          input.posts.map((post) => post.sourceEventId),
          input.posts.map((post) => post.occurredAt),
        ],
      );
      return result.rowCount ?? 0;
    },
  };
  return Object.freeze(repository);
}
