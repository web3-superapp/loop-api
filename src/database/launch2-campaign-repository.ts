import type { Pool } from "pg";

import {
  isLaunch2CampaignStatus,
  type Launch2CampaignAction,
  type Launch2CampaignFields,
  type Launch2CampaignRecord,
  type Launch2CampaignRepository,
} from "../features/launch2/launch2-campaigns.js";
import { insertAdminAuditRow } from "./admin-repository.js";
import { toIsoString, withV2Transaction } from "./v2-command-support.js";

/**
 * Decision 0140: PostgreSQL side of the launch desk campaigns (migration
 * 000081). Each write locks the row, updates it, and writes its
 * `admin_audit_log` row (`launch2.campaign.<action>`, target
 * `launch2_campaign`) in one transaction. Covers are `media_objects` rows of
 * kind `campaign_cover` with no owner.
 */

export class Launch2CampaignRepositoryUnavailableError extends Error {
  constructor() {
    super("Launch2 campaign repository returned an unexpected row");
    this.name = "Launch2CampaignRepositoryUnavailableError";
  }
}

type Row = Record<string, unknown>;

const columns = `campaign_id::text as campaign_id, title, subtitle,
  cover_media_id::text as cover_media_id, starts_at, ends_at, cta_label,
  link_kind, link_value, pinned, sort_order, status,
  created_by::text as created_by, created_by_actor, created_at, updated_at`;

const publicOrder = `pinned desc, sort_order asc, starts_at asc, campaign_id asc`;

function fail(): never {
  throw new Launch2CampaignRepositoryUnavailableError();
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

function mapCampaign(row: Row): Launch2CampaignRecord {
  const status = row["status"];
  const linkKind = row["link_kind"];
  const pinned = row["pinned"];
  const sortOrder = row["sort_order"];
  if (
    !isLaunch2CampaignStatus(status) ||
    (linkKind !== "route" && linkKind !== "url") ||
    typeof pinned !== "boolean" ||
    typeof sortOrder !== "number"
  ) {
    fail();
  }
  return Object.freeze({
    campaignId: text(row, "campaign_id"),
    title: text(row, "title"),
    subtitle: nullableText(row, "subtitle"),
    coverMediaId: nullableText(row, "cover_media_id"),
    startsAt: timestamp(row, "starts_at"),
    endsAt: timestamp(row, "ends_at"),
    ctaLabel: text(row, "cta_label"),
    link: Object.freeze({ kind: linkKind, value: text(row, "link_value") }),
    pinned,
    sortOrder,
    status,
    createdBy: nullableText(row, "created_by"),
    createdByActor: text(row, "created_by_actor"),
    createdAt: timestamp(row, "created_at"),
    updatedAt: timestamp(row, "updated_at"),
  });
}

/** The audit snapshot of a campaign (every editable field + status). */
function snapshot(record: Launch2CampaignRecord): Record<string, unknown> {
  return {
    title: record.title,
    subtitle: record.subtitle,
    coverMediaId: record.coverMediaId,
    startsAt: record.startsAt,
    endsAt: record.endsAt,
    ctaLabel: record.ctaLabel,
    link: record.link,
    pinned: record.pinned,
    sortOrder: record.sortOrder,
    status: record.status,
  };
}

function fieldValues(fields: Launch2CampaignFields): unknown[] {
  return [
    fields.title,
    fields.subtitle,
    fields.coverMediaId,
    fields.startsAt,
    fields.endsAt,
    fields.ctaLabel,
    fields.link.kind,
    fields.link.value,
    fields.pinned,
    fields.sortOrder,
  ];
}

const actions: Readonly<Record<Launch2CampaignAction | "create", string>> =
  Object.freeze({
    create: "launch2.campaign.create",
    update: "launch2.campaign.update",
    publish: "launch2.campaign.publish",
    archive: "launch2.campaign.archive",
  });

export function createPostgresLaunch2CampaignRepository(
  pool: Pool,
): Launch2CampaignRepository {
  const unavailable = (): Error =>
    new Launch2CampaignRepositoryUnavailableError();
  const repository: Launch2CampaignRepository = {
    async listPublic(input) {
      const result = await pool.query<Row>(
        `select ${columns} from public.launch2_campaigns
         where status = 'published' and ends_at > $1 and starts_at <= $2
         order by ${publicOrder}
         limit $3`,
        [input.now, input.horizon, input.limit],
      );
      return result.rows.map(mapCampaign);
    },

    async listAll(input) {
      const result = await pool.query<Row>(
        `select ${columns} from public.launch2_campaigns
         where ($1::text is null or status = $1)
         order by created_at desc, campaign_id asc
         limit $2`,
        [input.status, input.limit],
      );
      return result.rows.map(mapCampaign);
    },

    async get(campaignId) {
      const result = await pool.query<Row>(
        `select ${columns} from public.launch2_campaigns where campaign_id = $1`,
        [campaignId],
      );
      const row = result.rows[0];
      return row === undefined ? null : mapCampaign(row);
    },

    async create(input) {
      return withV2Transaction(pool, unavailable, async (client) => {
        const key = input.idempotency;
        if (key !== null) {
          // Serializes creates under one key (the unique index would make
          // the loser fail; the lock makes it replay instead).
          await client.query(
            `select pg_advisory_xact_lock(hashtextextended($1, 140))`,
            [key.key],
          );
          const earlier = await client.query<Row>(
            `select ${columns}, create_request_sha256
             from public.launch2_campaigns
             where create_idempotency_key = $1`,
            [key.key],
          );
          const earlierRow = earlier.rows[0];
          if (earlierRow !== undefined) {
            if (earlierRow["create_request_sha256"] !== key.requestSha256) {
              return { status: "conflict" as const };
            }
            const campaign = mapCampaign(earlierRow);
            const audit = await client.query<Row>(
              `select audit_id::text as audit_id, seq, at
               from public.admin_audit_log
               where target_type = 'launch2_campaign' and target_id = $1
                 and action = $2
               order by seq asc limit 1`,
              [campaign.campaignId, actions.create],
            );
            const auditRow = audit.rows[0];
            if (auditRow === undefined) fail();
            return {
              status: "replayed" as const,
              campaign,
              audit: {
                auditId: text(auditRow, "audit_id"),
                seq: Number(auditRow["seq"]),
                at: timestamp(auditRow, "at"),
              },
            };
          }
        }
        const inserted = await client.query<Row>(
          `insert into public.launch2_campaigns (
             campaign_id, title, subtitle, cover_media_id, starts_at, ends_at,
             cta_label, link_kind, link_value, pinned, sort_order, status,
             created_by, created_by_actor, created_at, updated_at,
             create_idempotency_key, create_request_sha256
           )
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'draft',
             $12, $13, $14, $14, $15, $16)
           returning ${columns}`,
          [
            input.campaignId,
            ...fieldValues(input.fields),
            input.audit.actorAccountId,
            input.audit.actor,
            input.now,
            key?.key ?? null,
            key?.requestSha256 ?? null,
          ],
        );
        const row = inserted.rows[0];
        if (row === undefined) fail();
        const campaign = mapCampaign(row);
        const audit = await insertAdminAuditRow(client, {
          actor: input.audit.actor,
          actorAccountId: input.audit.actorAccountId,
          action: actions.create,
          targetType: "launch2_campaign",
          targetId: campaign.campaignId,
          before: null,
          after: snapshot(campaign),
          requestId: input.audit.requestId,
        });
        return {
          status: "created" as const,
          campaign,
          audit: { auditId: audit.auditId, seq: audit.seq, at: audit.at },
        };
      });
    },

    async transition(input) {
      return withV2Transaction(pool, unavailable, async (client) => {
        const current = await client.query<Row>(
          `select ${columns} from public.launch2_campaigns
           where campaign_id = $1 for update`,
          [input.campaignId],
        );
        const row = current.rows[0];
        if (row === undefined) return { status: "not_found" as const };
        const before = mapCampaign(row);
        const decision = input.decide(before);
        if (decision.kind === "refuse") {
          return {
            status: "refused" as const,
            reasonCode: decision.reasonCode,
            campaign: before,
          };
        }
        const updated = await client.query<Row>(
          `update public.launch2_campaigns set
             title = $2, subtitle = $3, cover_media_id = $4, starts_at = $5,
             ends_at = $6, cta_label = $7, link_kind = $8, link_value = $9,
             pinned = $10, sort_order = $11, status = $12,
             updated_at = greatest($13::timestamptz, created_at)
           where campaign_id = $1
           returning ${columns}`,
          [
            input.campaignId,
            ...fieldValues(decision.fields),
            decision.status,
            input.now,
          ],
        );
        const updatedRow = updated.rows[0];
        if (updatedRow === undefined) fail();
        const campaign = mapCampaign(updatedRow);
        const audit = await insertAdminAuditRow(client, {
          actor: input.audit.actor,
          actorAccountId: input.audit.actorAccountId,
          action: actions[input.action],
          targetType: "launch2_campaign",
          targetId: campaign.campaignId,
          before: snapshot(before),
          after: snapshot(campaign),
          requestId: input.audit.requestId,
        });
        return {
          status: "written" as const,
          campaign,
          audit: { auditId: audit.auditId, seq: audit.seq, at: audit.at },
        };
      });
    },

    async coverExists(mediaId) {
      const result = await pool.query<{ found: boolean }>(
        `select exists (
           select 1 from public.media_objects
           where media_id = $1 and kind = 'campaign_cover'
         ) as found`,
        [mediaId],
      );
      return result.rows[0]?.found === true;
    },

    async insertCover(input) {
      const inserted = await pool.query<Row>(
        `insert into public.media_objects (
           media_id, owner_user_id, kind, content_type, bytes, width, height,
           sha256, idempotency_key, request_sha256
         )
         values ($1, null, 'campaign_cover', 'image/webp', $2, $3, $4, $5,
           $6, $7)
         on conflict (idempotency_key) where kind = 'campaign_cover'
           do nothing
         returning media_id::text as media_id`,
        [
          input.mediaId,
          input.bytes,
          input.width,
          input.height,
          input.sha256,
          input.idempotencyKey,
          input.requestSha256,
        ],
      );
      if (inserted.rows[0] !== undefined) {
        return { status: "stored" as const, mediaId: input.mediaId };
      }
      const earlier = await pool.query<Row>(
        `select media_id::text as media_id, request_sha256
         from public.media_objects
         where kind = 'campaign_cover' and idempotency_key = $1`,
        [input.idempotencyKey],
      );
      const row = earlier.rows[0];
      if (row === undefined) fail();
      return row["request_sha256"] === input.requestSha256
        ? { status: "replayed" as const, mediaId: text(row, "media_id") }
        : { status: "conflict" as const };
    },
  };
  return Object.freeze(repository);
}
