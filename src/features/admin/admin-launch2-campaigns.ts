import { randomUUID } from "node:crypto";

import {
  isLaunch2CampaignId,
  isLaunch2CampaignStatus,
  launch2CampaignCoverUrl,
  launch2CampaignDefaultCtaLabel,
  launch2CampaignLimits,
  launch2CampaignReasonCodes,
  type Launch2CampaignAction,
  type Launch2CampaignAuditInput,
  type Launch2CampaignAuditRef,
  type Launch2CampaignDecision,
  type Launch2CampaignFields,
  type Launch2CampaignLink,
  type Launch2CampaignRecord,
  type Launch2CampaignRepository,
} from "../launch2/launch2-campaigns.js";
import {
  MediaRejectedError,
  processCampaignCoverUpload,
  sha256Hex,
} from "../media/media-processor.js";
import { AdminApiError } from "./admin-contract.js";
import type { AdminWriteContext } from "./admin-service.js";

/**
 * Decision 0140: the console side of the launch desk campaigns — list
 * (console.read), create / update / publish / archive and the cover upload
 * (console.write). Every field rule lives here (the route schemas only
 * check JSON types), so a refusal is always 422 VALIDATION_FAILED with
 * `detailsSafe.reasonCode` + `field`, a refused transition 409
 * ADMIN_CONFLICT / CAMPAIGN_STATUS_CONFLICT, nothing written.
 */

export interface AdminLaunch2CampaignResource {
  readonly campaignId: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly coverMediaId: string | null;
  readonly coverUrl: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly ctaLabel: string;
  readonly link: Launch2CampaignLink;
  readonly pinned: boolean;
  readonly sortOrder: number;
  readonly status: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AdminLaunch2CampaignWriteResource {
  readonly campaign: AdminLaunch2CampaignResource;
  readonly audit: Launch2CampaignAuditRef;
}

export interface AdminLaunch2CampaignService {
  list(query: Record<string, unknown>): Promise<{
    readonly items: readonly AdminLaunch2CampaignResource[];
    readonly generatedAt: string;
  }>;
  get(campaignId: string): Promise<{
    readonly campaign: AdminLaunch2CampaignResource;
  }>;
  /** `replayed` marks an Idempotency-Key replay (route answers 200). */
  create(
    context: AdminWriteContext,
    body: unknown,
    idempotencyKey: string | null,
  ): Promise<
    AdminLaunch2CampaignWriteResource & { readonly replayed: boolean }
  >;
  update(
    context: AdminWriteContext,
    campaignId: string,
    body: unknown,
  ): Promise<AdminLaunch2CampaignWriteResource>;
  publish(
    context: AdminWriteContext,
    campaignId: string,
  ): Promise<AdminLaunch2CampaignWriteResource>;
  archive(
    context: AdminWriteContext,
    campaignId: string,
  ): Promise<AdminLaunch2CampaignWriteResource>;
  uploadCover(
    context: AdminWriteContext,
    bytes: Buffer,
    idempotencyKey: string | null,
  ): Promise<{ readonly mediaId: string; readonly coverUrl: string }>;
}

/** Control / format / separator / surrogate characters (none allowed). */
const forbiddenTextCharacters = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const forbiddenLinkCharacters = /[\s\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

type Body = Record<string, unknown>;

function invalid(reasonCode: string, field: string): AdminApiError {
  return new AdminApiError("VALIDATION_FAILED", { reasonCode, field });
}

function asBody(body: unknown): Body {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new AdminApiError("INVALID_REQUEST");
  }
  return body as Body;
}

function textOf(raw: unknown, field: string, max: number): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (
    value.length === 0 ||
    Array.from(value).length > max ||
    forbiddenTextCharacters.test(value)
  ) {
    throw invalid(launch2CampaignReasonCodes.titleInvalid, field);
  }
  return value;
}

/** Subtitle: null, "" (→ null) or 1..60 characters. */
function subtitleOf(raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw === "string" && raw.trim().length === 0) return null;
  return textOf(raw, "subtitle", launch2CampaignLimits.subtitleMax);
}

function instantOf(raw: unknown, field: string): string {
  const parsed = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw invalid(launch2CampaignReasonCodes.windowInvalid, field);
  }
  return new Date(parsed).toISOString();
}

function linkOf(raw: unknown): Launch2CampaignLink {
  const fail = (): AdminApiError =>
    invalid(launch2CampaignReasonCodes.linkInvalid, "link");
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw fail();
  }
  const kind = (raw as Body)["kind"];
  const value = (raw as Body)["value"];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > launch2CampaignLimits.linkMax ||
    forbiddenLinkCharacters.test(value)
  ) {
    throw fail();
  }
  if (kind === "route") {
    // An App route: one leading slash (never `//host`), no scheme.
    if (!value.startsWith("/") || value.startsWith("//")) throw fail();
    return Object.freeze({ kind, value });
  }
  if (kind === "url") {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw fail();
    }
    if (
      url.protocol !== "https:" ||
      url.hostname.length === 0 ||
      url.username !== "" ||
      url.password !== "" ||
      !value.toLowerCase().startsWith("https://")
    ) {
      throw fail();
    }
    return Object.freeze({ kind, value });
  }
  throw fail();
}

function sortOrderOf(raw: unknown): number {
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < launch2CampaignLimits.sortOrderMin ||
    raw > launch2CampaignLimits.sortOrderMax
  ) {
    throw new AdminApiError("INVALID_REQUEST");
  }
  return raw;
}

function pinnedOf(raw: unknown): boolean {
  if (typeof raw !== "boolean") throw new AdminApiError("INVALID_REQUEST");
  return raw;
}

function coverIdOf(raw: unknown): string | null {
  if (raw === null) return null;
  if (!isLaunch2CampaignId(raw)) {
    throw invalid(launch2CampaignReasonCodes.coverInvalid, "coverMediaId");
  }
  return raw;
}

const editableKeys = Object.freeze([
  "title",
  "subtitle",
  "coverMediaId",
  "startsAt",
  "endsAt",
  "ctaLabel",
  "link",
  "pinned",
  "sortOrder",
] as const);

type Patch = {
  -readonly [K in keyof Launch2CampaignFields]?: Launch2CampaignFields[K];
};

/**
 * Validates every present key of a body on its own (no key depends on the
 * stored row except the window, checked by `windowValid`). `create` also
 * requires title, startsAt, endsAt and link.
 */
function parsePatch(body: Body, mode: "create" | "update"): Patch {
  for (const key of Object.keys(body)) {
    if (!(editableKeys as readonly string[]).includes(key)) {
      throw new AdminApiError("INVALID_REQUEST");
    }
  }
  const has = (key: string): boolean =>
    Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined;
  const patch: Patch = {};
  if (has("title") || mode === "create") {
    patch.title = textOf(
      body["title"],
      "title",
      launch2CampaignLimits.titleMax,
    );
  }
  if (has("subtitle")) patch.subtitle = subtitleOf(body["subtitle"]);
  if (has("ctaLabel")) {
    patch.ctaLabel = textOf(
      body["ctaLabel"],
      "ctaLabel",
      launch2CampaignLimits.ctaLabelMax,
    );
  }
  if (has("startsAt") || mode === "create") {
    patch.startsAt = instantOf(body["startsAt"], "startsAt");
  }
  if (has("endsAt") || mode === "create") {
    patch.endsAt = instantOf(body["endsAt"], "endsAt");
  }
  if (has("link") || mode === "create") patch.link = linkOf(body["link"]);
  if (has("coverMediaId")) patch.coverMediaId = coverIdOf(body["coverMediaId"]);
  if (has("pinned")) patch.pinned = pinnedOf(body["pinned"]);
  if (has("sortOrder")) patch.sortOrder = sortOrderOf(body["sortOrder"]);
  return patch;
}

const createDefaults = Object.freeze({
  subtitle: null,
  coverMediaId: null,
  ctaLabel: launch2CampaignDefaultCtaLabel,
  pinned: false,
  sortOrder: 0,
});

function applyPatch(
  base: Launch2CampaignFields,
  patch: Patch,
): Launch2CampaignFields {
  return Object.freeze({ ...base, ...patch });
}

function windowValid(fields: Launch2CampaignFields): boolean {
  return Date.parse(fields.endsAt) > Date.parse(fields.startsAt);
}

function fieldsOf(record: Launch2CampaignRecord): Launch2CampaignFields {
  return Object.freeze({
    title: record.title,
    subtitle: record.subtitle,
    coverMediaId: record.coverMediaId,
    startsAt: record.startsAt,
    endsAt: record.endsAt,
    ctaLabel: record.ctaLabel,
    link: record.link,
    pinned: record.pinned,
    sortOrder: record.sortOrder,
  });
}

export function createAdminLaunch2CampaignService(input: {
  readonly repository: Launch2CampaignRepository | null;
  readonly publicBaseUrl: string;
  readonly now?: () => Date;
  readonly createUuid?: () => string;
}): AdminLaunch2CampaignService {
  const now = input.now ?? ((): Date => new Date());
  const createUuid = input.createUuid ?? randomUUID;
  const unavailable = (): AdminApiError =>
    new AdminApiError("CAPABILITY_UNAVAILABLE", {
      reasonCode: launch2CampaignReasonCodes.repositoryUnavailable,
    });
  const notFound = (): AdminApiError =>
    new AdminApiError("NOT_FOUND", {
      reasonCode: launch2CampaignReasonCodes.notFound,
    });

  const idempotencyConflict = (): AdminApiError =>
    new AdminApiError("ADMIN_CONFLICT", {
      reasonCode: launch2CampaignReasonCodes.idempotencyConflict,
    });

  function repository(): Launch2CampaignRepository {
    if (input.repository === null) throw unavailable();
    return input.repository;
  }

  async function guarded<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AdminApiError) throw error;
      throw unavailable();
    }
  }

  function resource(
    record: Launch2CampaignRecord,
  ): AdminLaunch2CampaignResource {
    return Object.freeze({
      campaignId: record.campaignId,
      title: record.title,
      subtitle: record.subtitle,
      coverMediaId: record.coverMediaId,
      coverUrl: launch2CampaignCoverUrl(
        input.publicBaseUrl,
        record.coverMediaId,
      ),
      startsAt: record.startsAt,
      endsAt: record.endsAt,
      ctaLabel: record.ctaLabel,
      link: Object.freeze({ ...record.link }),
      pinned: record.pinned,
      sortOrder: record.sortOrder,
      status: record.status,
      createdBy: record.createdBy,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  function auditOf(context: AdminWriteContext): Launch2CampaignAuditInput {
    return {
      actor: context.session.actor,
      actorAccountId: context.session.accountId,
      requestId: context.requestId,
    };
  }

  async function assertCover(
    store: Launch2CampaignRepository,
    fields: Launch2CampaignFields,
    previous: string | null,
  ): Promise<void> {
    if (fields.coverMediaId === null || fields.coverMediaId === previous) {
      return;
    }
    const exists = await guarded(() =>
      store.coverExists(fields.coverMediaId as string),
    );
    if (!exists) {
      throw invalid(launch2CampaignReasonCodes.coverInvalid, "coverMediaId");
    }
  }

  async function transition(
    context: AdminWriteContext,
    campaignId: string,
    action: Launch2CampaignAction,
    decide: (current: Launch2CampaignRecord) => Launch2CampaignDecision,
  ): Promise<AdminLaunch2CampaignWriteResource> {
    const store = repository();
    if (!isLaunch2CampaignId(campaignId)) throw notFound();
    const result = await guarded(() =>
      store.transition({
        campaignId,
        action,
        now: now(),
        audit: auditOf(context),
        decide,
      }),
    );
    if (result.status === "not_found") throw notFound();
    if (result.status === "refused") {
      if (result.reasonCode === launch2CampaignReasonCodes.statusConflict) {
        throw new AdminApiError("ADMIN_CONFLICT", {
          reasonCode: result.reasonCode,
          status: result.campaign.status,
        });
      }
      throw invalid(result.reasonCode, "endsAt");
    }
    return Object.freeze({
      campaign: resource(result.campaign),
      audit: Object.freeze({ ...result.audit }),
    });
  }

  const conflict: Launch2CampaignDecision = Object.freeze({
    kind: "refuse",
    reasonCode: launch2CampaignReasonCodes.statusConflict,
  });

  return Object.freeze({
    async list(query: Record<string, unknown>) {
      const store = repository();
      const raw = query["status"];
      if (raw !== undefined && !isLaunch2CampaignStatus(raw)) {
        throw new AdminApiError("INVALID_REQUEST");
      }
      const records = await guarded(() =>
        store.listAll({
          status: raw ?? null,
          limit: launch2CampaignLimits.adminListMax,
        }),
      );
      return Object.freeze({
        items: records.map(resource),
        generatedAt: now().toISOString(),
      });
    },

    async get(campaignId: string) {
      const store = repository();
      if (!isLaunch2CampaignId(campaignId)) throw notFound();
      const record = await guarded(() => store.get(campaignId));
      if (record === null) throw notFound();
      return Object.freeze({ campaign: resource(record) });
    },

    async create(
      context: AdminWriteContext,
      body: unknown,
      idempotencyKey: string | null,
    ) {
      const store = repository();
      const fields = applyPatch(
        createDefaults as unknown as Launch2CampaignFields,
        parsePatch(asBody(body), "create"),
      );
      if (!windowValid(fields)) {
        throw invalid(launch2CampaignReasonCodes.windowInvalid, "endsAt");
      }
      await assertCover(store, fields, null);
      const created = await guarded(() =>
        store.create({
          campaignId: createUuid(),
          fields,
          now: now(),
          audit: auditOf(context),
          idempotency:
            idempotencyKey === null
              ? null
              : {
                  key: idempotencyKey,
                  requestSha256: sha256Hex(
                    Buffer.from(
                      JSON.stringify({ actor: context.session.actor, fields }),
                    ),
                  ),
                },
        }),
      );
      if (created.status === "conflict") throw idempotencyConflict();
      return Object.freeze({
        campaign: resource(created.campaign),
        audit: Object.freeze({ ...created.audit }),
        replayed: created.status === "replayed",
      });
    },

    async update(
      context: AdminWriteContext,
      campaignId: string,
      body: unknown,
    ) {
      const store = repository();
      const patch = asBody(body);
      if (Object.keys(patch).length === 0) {
        throw new AdminApiError("INVALID_REQUEST");
      }
      if (!isLaunch2CampaignId(campaignId)) throw notFound();
      const parsed = parsePatch(patch, "update");
      if (parsed.coverMediaId !== undefined && parsed.coverMediaId !== null) {
        const cover = parsed.coverMediaId;
        const exists = await guarded(() => store.coverExists(cover));
        if (!exists) {
          throw invalid(
            launch2CampaignReasonCodes.coverInvalid,
            "coverMediaId",
          );
        }
      }
      return transition(context, campaignId, "update", (current) => {
        if (current.status === "archived") return conflict;
        const fields = applyPatch(fieldsOf(current), parsed);
        if (!windowValid(fields)) {
          return {
            kind: "refuse",
            reasonCode: launch2CampaignReasonCodes.windowInvalid,
          };
        }
        return { kind: "write", fields, status: current.status };
      });
    },

    publish(context: AdminWriteContext, campaignId: string) {
      return transition(context, campaignId, "publish", (current) => {
        if (current.status !== "draft") return conflict;
        if (Date.parse(current.endsAt) <= now().getTime()) {
          return {
            kind: "refuse",
            reasonCode: launch2CampaignReasonCodes.windowInvalid,
          };
        }
        return {
          kind: "write",
          fields: fieldsOf(current),
          status: "published",
        };
      });
    },

    archive(context: AdminWriteContext, campaignId: string) {
      return transition(context, campaignId, "archive", (current) => {
        if (current.status === "archived") return conflict;
        return {
          kind: "write",
          fields: fieldsOf(current),
          status: "archived",
        };
      });
    },

    async uploadCover(
      _context: AdminWriteContext,
      bytes: Buffer,
      idempotencyKey: string | null,
    ) {
      const store = repository();
      let processed;
      try {
        processed = await processCampaignCoverUpload(bytes);
      } catch (error) {
        if (error instanceof MediaRejectedError) {
          throw new AdminApiError("VALIDATION_FAILED", {
            reasonCode: launch2CampaignReasonCodes.coverInvalid,
            field: "file",
            mediaReasonCode: error.reasonCode,
          });
        }
        throw error;
      }
      const stored = await guarded(() =>
        store.insertCover({
          mediaId: createUuid(),
          idempotencyKey: idempotencyKey ?? createUuid(),
          bytes: processed.bytes,
          width: processed.width,
          height: processed.height,
          sha256: processed.sha256,
          requestSha256: sha256Hex(bytes),
        }),
      );
      if (stored.status === "conflict") throw idempotencyConflict();
      return Object.freeze({
        mediaId: stored.mediaId,
        coverUrl: launch2CampaignCoverUrl(
          input.publicBaseUrl,
          stored.mediaId,
        ) as string,
      });
    },
  });
}
