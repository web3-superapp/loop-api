import { randomUUID } from "node:crypto";

import type { Pool } from "pg";
import { z } from "zod";

import {
  isVenueMilestoneTransitionAllowed,
  launchChainId,
  launchCommandDigestVersion,
  launchCommandIdempotencyScope,
  launchEligibilityTiers,
  launchKybStatuses,
  launchOfficialLinkKeys,
  launchReviewEventTypes,
  launchReviewStatuses,
  launchScheduleStatuses,
  launchSlotStatuses,
  reviewEventType,
  reviewTransition,
  submitTransition,
  venueMilestoneMarketTypes,
  venueMilestoneRequiresEvidence,
  venueMilestoneStates,
  venueMilestoneVenues,
  type LaunchOfficialLinks,
  type LaunchProjectValues,
  type LaunchReviewStatus,
  type LaunchScheduleStatus,
} from "../features/launch/launch-contract.js";
import {
  LaunchDataStaleError,
  LaunchIdempotencyConflictError,
  LaunchMilestoneTransitionError,
  LaunchNotFoundError,
  LaunchRepositoryUnavailableError,
  LaunchVersionConflictError,
  type CreateLaunchProjectInput,
  type LaunchCatalogRecord,
  type LaunchConfigRecord,
  type LaunchDetailRecord,
  type LaunchEconomyCountsRecord,
  type LaunchProjectPageInput,
  type LaunchProjectRecord,
  type LaunchRecord,
  type LaunchRepository,
  type LaunchRoundRecord,
  type RecordVenueMilestoneInput,
  type ReplaceLaunchProjectInput,
  type ReviewLaunchProjectInput,
  type SubmitLaunchProjectInput,
  type VenueMilestoneRecord,
} from "../features/launch/launch-repository.js";
import {
  claimV2Command,
  lockV2Owner,
  toIsoString,
  toNullableIsoString,
  withV2Transaction,
  type DatabaseClient,
} from "./v2-command-support.js";

/**
 * PostgreSQL implementation of the Launch catalog boundary (Decision 0036).
 * Every applicant command is one transaction that claims the durable
 * idempotency record, applies the change, and appends one
 * `launch_review_events` row; the operator review path appends the same
 * audit without a client key. Nothing here touches a chain.
 */

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const canonicalUuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const userIdSchema = z.string().regex(canonicalUuidPattern);
const opaqueIdSchema = z.string().regex(canonicalUuidPattern);
const uuidV4Schema = z.string().regex(canonicalUuidV4Pattern);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const reasonCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const dateSchema = z.date().refine((value) => !Number.isNaN(value.getTime()));
const decimalSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})(\.[0-9]{1,60})?$/);
const rawAmountSchema = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);

const linksSchema = z
  .object({
    website: z.string().nullable().optional(),
    x: z.string().nullable().optional(),
    telegram: z.string().nullable().optional(),
    discord: z.string().nullable().optional(),
  })
  .strict();

const projectRowSchema = z
  .object({
    project_id: opaqueIdSchema,
    owner_user_id: userIdSchema,
    name: z.string().min(1),
    ticker: z.string().min(2),
    narrative: z.string().min(1).nullable(),
    official_links: linksSchema,
    material_version: z.number().int().min(1),
    review_status: z.enum(launchReviewStatuses),
    kyb_status: z.enum(launchKybStatuses),
    review_reason_code: z.string().nullable(),
    submitted_at: dateSchema.nullable(),
    reviewed_at: dateSchema.nullable(),
    launch_id: opaqueIdSchema.nullable(),
    record_version: z.coerce.number().int().min(1),
    created_at: dateSchema,
    updated_at: dateSchema,
  })
  .strict();

const launchRowSchema = z
  .object({
    launch_id: opaqueIdSchema,
    project_id: opaqueIdSchema,
    chain_id: z.literal(launchChainId),
    contract_address: z.string().nullable(),
    config_digest: z.string().nullable(),
    schedule_status: z.enum(launchScheduleStatuses),
    created_at: dateSchema,
    updated_at: dateSchema,
  })
  .strict();

const catalogRowSchema = launchRowSchema.extend({
  project_name: z.string().min(1),
  project_ticker: z.string().min(2),
  confirmed_config_version: z.string().nullable(),
});

const configRowSchema = z
  .object({
    config_id: opaqueIdSchema,
    launch_id: opaqueIdSchema,
    config_version: z.string().min(1),
    parameters: z.record(z.string(), z.unknown()),
    status: z.enum(launchSlotStatuses),
    effective_at: dateSchema.nullable(),
  })
  .strict();

const roundRowSchema = z
  .object({
    round_id: opaqueIdSchema,
    launch_id: opaqueIdSchema,
    round_index: z.number().int().min(1),
    config_version: z.string().min(1),
    status: z.enum(launchSlotStatuses),
    starts_at: dateSchema.nullable(),
    ends_at: dateSchema.nullable(),
    price_usd1: decimalSchema.nullable(),
    eligibility_tier: z.enum(launchEligibilityTiers).nullable(),
    wallet_round_cap_raw: rawAmountSchema.nullable(),
  })
  .strict();

const milestoneRowSchema = z
  .object({
    venue_milestone_id: opaqueIdSchema,
    project_id: opaqueIdSchema,
    venue: z.enum(venueMilestoneVenues),
    market_type: z.enum(venueMilestoneMarketTypes),
    state: z.enum(venueMilestoneStates),
    evidence_digest: sha256Schema.nullable(),
    evidence_recorded_at: dateSchema.nullable(),
    reviewer: z.string().nullable(),
    record_version: z.coerce.number().int().min(1),
    updated_at: dateSchema,
  })
  .strict();

const countRowSchema = z
  .object({ key: z.string(), count: z.coerce.number().int().min(0) })
  .strict();

const projectColumns = `
  p.project_id,
  p.owner_user_id,
  p.name,
  p.ticker,
  p.narrative,
  p.official_links,
  p.material_version,
  p.review_status,
  p.kyb_status,
  p.review_reason_code,
  p.submitted_at,
  p.reviewed_at,
  l.launch_id,
  p.record_version,
  p.created_at,
  p.updated_at
`;

const projectFrom = `
  from public.launch_projects as p
  left join public.launches as l on l.project_id = p.project_id
`;

function mapLinks(value: z.infer<typeof linksSchema>): LaunchOfficialLinks {
  return Object.freeze({
    website: value.website ?? null,
    x: value.x ?? null,
    telegram: value.telegram ?? null,
    discord: value.discord ?? null,
  });
}

function mapProject(raw: unknown): LaunchProjectRecord {
  const row = projectRowSchema.parse(raw);
  return Object.freeze({
    projectId: row.project_id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    ticker: row.ticker,
    narrative: row.narrative,
    officialLinks: mapLinks(row.official_links),
    materialVersion: row.material_version,
    reviewStatus: row.review_status,
    kybStatus: row.kyb_status,
    reviewReasonCode: row.review_reason_code,
    submittedAt: toNullableIsoString(row.submitted_at),
    reviewedAt: toNullableIsoString(row.reviewed_at),
    launchId: row.launch_id,
    version: row.record_version,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  });
}

function mapLaunch(row: z.infer<typeof launchRowSchema>): LaunchRecord {
  return Object.freeze({
    launchId: row.launch_id,
    projectId: row.project_id,
    chainId: row.chain_id,
    contractAddress: row.contract_address,
    configDigest: row.config_digest,
    scheduleStatus: row.schedule_status,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  });
}

function mapConfig(raw: unknown): LaunchConfigRecord {
  const row = configRowSchema.parse(raw);
  return Object.freeze({
    configId: row.config_id,
    launchId: row.launch_id,
    configVersion: row.config_version,
    parameters: Object.freeze({ ...row.parameters }),
    status: row.status,
    effectiveAt: toNullableIsoString(row.effective_at),
  });
}

function mapRound(raw: unknown): LaunchRoundRecord {
  const row = roundRowSchema.parse(raw);
  return Object.freeze({
    roundId: row.round_id,
    launchId: row.launch_id,
    roundIndex: row.round_index,
    configVersion: row.config_version,
    status: row.status,
    startsAt: toNullableIsoString(row.starts_at),
    endsAt: toNullableIsoString(row.ends_at),
    priceUsd1: row.price_usd1,
    eligibilityTier: row.eligibility_tier,
    walletRoundCapRaw: row.wallet_round_cap_raw,
  });
}

function mapMilestone(raw: unknown): VenueMilestoneRecord {
  const row = milestoneRowSchema.parse(raw);
  return Object.freeze({
    venueMilestoneId: row.venue_milestone_id,
    projectId: row.project_id,
    venue: row.venue,
    marketType: row.market_type,
    state: row.state,
    evidenceDigest: row.evidence_digest,
    evidenceRecordedAt: toNullableIsoString(row.evidence_recorded_at),
    reviewer: row.reviewer,
    version: row.record_version,
    updatedAt: toIsoString(row.updated_at),
  });
}

function unavailable(): LaunchRepositoryUnavailableError {
  return new LaunchRepositoryUnavailableError();
}

function translate(error: unknown): never {
  if (
    error instanceof LaunchDataStaleError ||
    error instanceof LaunchIdempotencyConflictError ||
    error instanceof LaunchMilestoneTransitionError ||
    error instanceof LaunchNotFoundError ||
    error instanceof LaunchRepositoryUnavailableError ||
    error instanceof LaunchVersionConflictError
  ) {
    throw error;
  }
  throw unavailable();
}

async function readProject(
  client: DatabaseClient,
  projectId: string,
  forUpdate = false,
): Promise<LaunchProjectRecord | null> {
  const result = await client.query({
    text: `
      select ${projectColumns}
      ${projectFrom}
      where p.project_id = $1
      ${forUpdate ? "for update of p" : ""}
    `,
    values: [projectId],
  });
  const row: unknown = result.rows[0];
  return row === undefined ? null : mapProject(row);
}

async function findAuditProject(
  client: DatabaseClient,
  idempotencyRecordId: string,
): Promise<LaunchProjectRecord | null> {
  const audit = await client.query<{ project_id: string }>({
    text: `
      select project_id
      from public.launch_review_events
      where idempotency_record_id = $1
    `,
    values: [idempotencyRecordId],
  });
  const projectId = audit.rows[0]?.project_id;
  return projectId === undefined ? null : readProject(client, projectId);
}

async function appendReviewAudit(
  client: DatabaseClient,
  input: {
    readonly projectId: string;
    readonly actorUserId: string | null;
    readonly eventType: string;
    readonly fromStatus: LaunchReviewStatus | null;
    readonly toStatus: LaunchReviewStatus;
    readonly reasonCode: string | null;
    readonly idempotencyRecordId: string | null;
    readonly requestId: string;
  },
): Promise<void> {
  await client.query({
    text: `
      insert into public.launch_review_events (
        project_id,
        actor_type,
        actor_user_id,
        event_type,
        from_status,
        to_status,
        reason_code,
        idempotency_record_id,
        request_id
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `,
    values: [
      input.projectId,
      input.actorUserId === null ? "operator" : "applicant",
      input.actorUserId,
      input.eventType,
      input.fromStatus,
      input.toStatus,
      input.reasonCode,
      input.idempotencyRecordId,
      input.requestId,
    ],
  });
}

function linksJson(values: LaunchProjectValues): string {
  const links: Record<string, string | null> = {};
  for (const key of launchOfficialLinkKeys) {
    links[key] = values.officialLinks[key];
  }
  return JSON.stringify(links);
}

function countsByKey<T extends string>(
  rows: readonly unknown[],
  keys: readonly T[],
): Readonly<Record<T, number>> {
  const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<
    T,
    number
  >;
  for (const raw of rows) {
    const row = countRowSchema.parse(raw);
    if (keys.includes(row.key as T)) {
      counts[row.key as T] = row.count;
    }
  }
  return Object.freeze(counts);
}

export function createPostgresLaunchRepository(pool: Pool): LaunchRepository {
  return Object.freeze({
    async createProject(rawInput: CreateLaunchProjectInput) {
      try {
        const ownerUserId = userIdSchema.parse(rawInput.ownerUserId);
        const idempotencyKey = uuidV4Schema.parse(rawInput.idempotencyKey);
        const requestSha256 = sha256Schema.parse(rawInput.requestSha256);
        const requestId = uuidV4Schema.parse(rawInput.requestId);
        const projectId = opaqueIdSchema.parse(randomUUID());
        return await withV2Transaction(pool, unavailable, async (client) => {
          await lockV2Owner(client, ownerUserId, unavailable);
          const recordId = await claimV2Command(
            client,
            {
              ownerUserId,
              scope: launchCommandIdempotencyScope,
              digestVersion: launchCommandDigestVersion,
              idempotencyKey,
              requestSha256,
            },
            () => new LaunchIdempotencyConflictError(),
          );
          const replay = await findAuditProject(client, recordId);
          if (replay !== null) {
            return replay;
          }
          await client.query({
            text: `
              insert into public.launch_projects (
                project_id, owner_user_id, name, ticker, narrative, official_links
              )
              values ($1, $2, $3, $4, $5, $6::jsonb)
            `,
            values: [
              projectId,
              ownerUserId,
              rawInput.values.name,
              rawInput.values.ticker,
              rawInput.values.narrative,
              linksJson(rawInput.values),
            ],
          });
          await appendReviewAudit(client, {
            projectId,
            actorUserId: ownerUserId,
            eventType: launchReviewEventTypes.created,
            fromStatus: null,
            toStatus: "draft",
            reasonCode: null,
            idempotencyRecordId: recordId,
            requestId,
          });
          const created = await readProject(client, projectId);
          if (created === null) {
            throw unavailable();
          }
          return created;
        });
      } catch (error) {
        return translate(error);
      }
    },

    async getProject(rawProjectId: string) {
      try {
        const projectId = opaqueIdSchema.parse(rawProjectId);
        return await readProject(pool, projectId);
      } catch (error) {
        return translate(error);
      }
    },

    async listProjects(rawInput: LaunchProjectPageInput) {
      try {
        const ownerUserId = userIdSchema.parse(rawInput.ownerUserId);
        const limit = z.number().int().min(1).max(101).parse(rawInput.limit);
        const values: unknown[] = [ownerUserId, limit];
        const clauses = ["p.owner_user_id = $1"];
        if (rawInput.status !== null) {
          values.push(rawInput.status);
          clauses.push(`p.review_status = $${String(values.length)}`);
        }
        if (rawInput.after !== null) {
          values.push(rawInput.after.createdAt, rawInput.after.projectId);
          clauses.push(
            `(p.created_at, p.project_id) < ($${String(values.length - 1)}::timestamptz, $${String(values.length)}::uuid)`,
          );
        }
        const result = await pool.query({
          text: `
            select ${projectColumns}
            ${projectFrom}
            where ${clauses.join(" and ")}
            order by p.created_at desc, p.project_id desc
            limit $2
          `,
          values,
        });
        return Object.freeze(result.rows.map(mapProject));
      } catch (error) {
        return translate(error);
      }
    },

    async replaceProject(rawInput: ReplaceLaunchProjectInput) {
      try {
        const ownerUserId = userIdSchema.parse(rawInput.ownerUserId);
        const projectId = opaqueIdSchema.parse(rawInput.projectId);
        const expectedVersion = z
          .number()
          .int()
          .min(1)
          .parse(rawInput.expectedVersion);
        return await withV2Transaction(pool, unavailable, async (client) => {
          const current = await readProject(client, projectId, true);
          if (current === null || current.ownerUserId !== ownerUserId) {
            throw new LaunchNotFoundError();
          }
          if (!["draft", "returned"].includes(current.reviewStatus)) {
            throw new LaunchDataStaleError();
          }
          if (current.version !== expectedVersion) {
            throw new LaunchVersionConflictError();
          }
          const updated = await client.query({
            text: `
              update public.launch_projects
              set
                name = $3,
                ticker = $4,
                narrative = $5,
                official_links = $6::jsonb,
                material_version = material_version + 1,
                record_version = record_version + 1,
                updated_at = clock_timestamp()
              where project_id = $1 and record_version = $2
              returning project_id
            `,
            values: [
              projectId,
              expectedVersion,
              rawInput.values.name,
              rawInput.values.ticker,
              rawInput.values.narrative,
              linksJson(rawInput.values),
            ],
          });
          if (updated.rowCount !== 1) {
            throw new LaunchVersionConflictError();
          }
          await appendReviewAudit(client, {
            projectId,
            actorUserId: ownerUserId,
            eventType: launchReviewEventTypes.updated,
            fromStatus: current.reviewStatus,
            toStatus: current.reviewStatus,
            reasonCode: null,
            idempotencyRecordId: null,
            requestId: randomUUID(),
          });
          const next = await readProject(client, projectId);
          if (next === null) {
            throw unavailable();
          }
          return next;
        });
      } catch (error) {
        return translate(error);
      }
    },

    async submitProject(rawInput: SubmitLaunchProjectInput) {
      try {
        const ownerUserId = userIdSchema.parse(rawInput.ownerUserId);
        const projectId = opaqueIdSchema.parse(rawInput.projectId);
        const idempotencyKey = uuidV4Schema.parse(rawInput.idempotencyKey);
        const requestSha256 = sha256Schema.parse(rawInput.requestSha256);
        const requestId = uuidV4Schema.parse(rawInput.requestId);
        return await withV2Transaction(pool, unavailable, async (client) => {
          await lockV2Owner(client, ownerUserId, unavailable);
          const recordId = await claimV2Command(
            client,
            {
              ownerUserId,
              scope: launchCommandIdempotencyScope,
              digestVersion: launchCommandDigestVersion,
              idempotencyKey,
              requestSha256,
            },
            () => new LaunchIdempotencyConflictError(),
          );
          const replay = await findAuditProject(client, recordId);
          if (replay !== null) {
            return replay;
          }
          const current = await readProject(client, projectId, true);
          if (current === null || current.ownerUserId !== ownerUserId) {
            throw new LaunchNotFoundError();
          }
          const next = submitTransition(current.reviewStatus);
          if (next === null) {
            throw new LaunchDataStaleError();
          }
          await client.query({
            text: `
              update public.launch_projects
              set
                review_status = $2,
                review_reason_code = null,
                submitted_at = clock_timestamp(),
                record_version = record_version + 1,
                updated_at = clock_timestamp()
              where project_id = $1
            `,
            values: [projectId, next],
          });
          await appendReviewAudit(client, {
            projectId,
            actorUserId: ownerUserId,
            eventType: reviewEventType(next),
            fromStatus: current.reviewStatus,
            toStatus: next,
            reasonCode: null,
            idempotencyRecordId: recordId,
            requestId,
          });
          const submitted = await readProject(client, projectId);
          if (submitted === null) {
            throw unavailable();
          }
          return submitted;
        });
      } catch (error) {
        return translate(error);
      }
    },

    async reviewProject(rawInput: ReviewLaunchProjectInput) {
      try {
        const projectId = opaqueIdSchema.parse(rawInput.projectId);
        const requestId = uuidV4Schema.parse(rawInput.requestId);
        const reasonCode = reasonCodeSchema.parse(rawInput.reasonCode);
        return await withV2Transaction(pool, unavailable, async (client) => {
          const current = await readProject(client, projectId, true);
          if (current === null) {
            throw new LaunchNotFoundError();
          }
          const next = reviewTransition(
            current.reviewStatus,
            rawInput.decision,
          );
          if (next === null) {
            throw new LaunchDataStaleError();
          }
          await client.query({
            text: `
              update public.launch_projects
              set
                review_status = $2,
                review_reason_code = $3,
                reviewed_at = case
                  when $2 in ('approved', 'returned', 'rejected') then clock_timestamp()
                  else reviewed_at
                end,
                record_version = record_version + 1,
                updated_at = clock_timestamp()
              where project_id = $1
            `,
            values: [projectId, next, reasonCode],
          });
          let launch: LaunchRecord | null = null;
          if (next === "approved") {
            const launchId = randomUUID();
            const inserted = await client.query({
              text: `
                insert into public.launches (launch_id, project_id, chain_id)
                values ($1, $2, $3)
                on conflict (project_id) do nothing
                returning
                  launch_id, project_id, chain_id, contract_address, config_digest,
                  schedule_status, created_at, updated_at
              `,
              values: [launchId, projectId, launchChainId],
            });
            const row: unknown = inserted.rows[0];
            if (row !== undefined) {
              launch = mapLaunch(launchRowSchema.parse(row));
            }
          }
          await appendReviewAudit(client, {
            projectId,
            actorUserId: null,
            eventType: reviewEventType(next),
            fromStatus: current.reviewStatus,
            toStatus: next,
            reasonCode,
            idempotencyRecordId: null,
            requestId,
          });
          const project = await readProject(client, projectId);
          if (project === null) {
            throw unavailable();
          }
          return Object.freeze({ project, launch });
        });
      } catch (error) {
        return translate(error);
      }
    },

    async listLaunches() {
      try {
        const result = await pool.query({
          text: `
            select
              l.launch_id, l.project_id, l.chain_id, l.contract_address,
              l.config_digest, l.schedule_status, l.created_at, l.updated_at,
              p.name as project_name,
              p.ticker as project_ticker,
              c.config_version as confirmed_config_version
            from public.launches as l
            join public.launch_projects as p on p.project_id = l.project_id
            left join public.launch_configs as c
              on c.launch_id = l.launch_id and c.status = 'confirmed'
            where p.review_status = 'approved'
            order by l.created_at desc, l.launch_id desc
            limit 200
          `,
        });
        return Object.freeze(
          result.rows.map((raw): LaunchCatalogRecord => {
            const row = catalogRowSchema.parse(raw);
            return Object.freeze({
              launch: mapLaunch(row),
              projectName: row.project_name,
              projectTicker: row.project_ticker,
              confirmedConfigVersion: row.confirmed_config_version,
            });
          }),
        );
      } catch (error) {
        return translate(error);
      }
    },

    async getLaunch(rawLaunchId: string) {
      try {
        const launchId = opaqueIdSchema.parse(rawLaunchId);
        const launchResult = await pool.query({
          text: `
            select
              launch_id, project_id, chain_id, contract_address, config_digest,
              schedule_status, created_at, updated_at
            from public.launches
            where launch_id = $1
          `,
          values: [launchId],
        });
        const launchRaw: unknown = launchResult.rows[0];
        if (launchRaw === undefined) {
          return null;
        }
        const launch = mapLaunch(launchRowSchema.parse(launchRaw));
        const project = await readProject(pool, launch.projectId);
        if (project === null || project.reviewStatus !== "approved") {
          return null;
        }
        const [configs, rounds] = await Promise.all([
          pool.query({
            text: `
              select config_id, launch_id, config_version, parameters, status, effective_at
              from public.launch_configs
              where launch_id = $1
              order by created_at desc, config_id desc
            `,
            values: [launchId],
          }),
          pool.query({
            text: `
              select
                round_id, launch_id, round_index, config_version, status,
                starts_at, ends_at, price_usd1, eligibility_tier,
                wallet_round_cap_raw::text as wallet_round_cap_raw
              from public.launch_rounds
              where launch_id = $1
              order by round_index asc
            `,
            values: [launchId],
          }),
        ]);
        const detail: LaunchDetailRecord = Object.freeze({
          launch,
          project,
          configs: Object.freeze(configs.rows.map(mapConfig)),
          rounds: Object.freeze(rounds.rows.map(mapRound)),
        });
        return detail;
      } catch (error) {
        return translate(error);
      }
    },

    async listMilestones(rawProjectId: string) {
      try {
        const projectId = opaqueIdSchema.parse(rawProjectId);
        const result = await pool.query({
          text: `
            select
              venue_milestone_id, project_id, venue, market_type, state,
              evidence_digest, evidence_recorded_at, reviewer, record_version, updated_at
            from public.venue_milestones
            where project_id = $1
            order by venue asc, market_type asc
          `,
          values: [projectId],
        });
        return Object.freeze(result.rows.map(mapMilestone));
      } catch (error) {
        return translate(error);
      }
    },

    async recordMilestone(rawInput: RecordVenueMilestoneInput) {
      try {
        const projectId = opaqueIdSchema.parse(rawInput.projectId);
        const evidenceDigest =
          rawInput.evidenceDigest === null
            ? null
            : sha256Schema.parse(rawInput.evidenceDigest);
        const reviewer =
          rawInput.reviewer === null
            ? null
            : z
                .string()
                .regex(/^[a-z][a-z0-9_.-]{0,63}$/)
                .parse(rawInput.reviewer);
        if (
          venueMilestoneRequiresEvidence(rawInput.state) &&
          (evidenceDigest === null || reviewer === null)
        ) {
          throw new LaunchMilestoneTransitionError();
        }
        return await withV2Transaction(pool, unavailable, async (client) => {
          const project = await readProject(client, projectId, true);
          if (project === null) {
            throw new LaunchNotFoundError();
          }
          const existing = await client.query({
            text: `
              select
                venue_milestone_id, project_id, venue, market_type, state,
                evidence_digest, evidence_recorded_at, reviewer, record_version, updated_at
              from public.venue_milestones
              where project_id = $1 and venue = $2 and market_type = $3
              for update
            `,
            values: [projectId, rawInput.venue, rawInput.marketType],
          });
          const currentRaw: unknown = existing.rows[0];
          if (currentRaw === undefined) {
            if (
              rawInput.state !== "PREPARING" &&
              !isVenueMilestoneTransitionAllowed("PREPARING", rawInput.state)
            ) {
              throw new LaunchMilestoneTransitionError();
            }
            const inserted = await client.query({
              text: `
                insert into public.venue_milestones (
                  project_id, venue, market_type, state,
                  evidence_digest, evidence_recorded_at, reviewer
                )
                values (
                  $1, $2, $3, $4, $5,
                  case when $5::text is null then null else clock_timestamp() end,
                  $6
                )
                returning
                  venue_milestone_id, project_id, venue, market_type, state,
                  evidence_digest, evidence_recorded_at, reviewer, record_version, updated_at
              `,
              values: [
                projectId,
                rawInput.venue,
                rawInput.marketType,
                rawInput.state,
                evidenceDigest,
                reviewer,
              ],
            });
            return mapMilestone(inserted.rows[0]);
          }
          const current = mapMilestone(currentRaw);
          if (
            !isVenueMilestoneTransitionAllowed(current.state, rawInput.state)
          ) {
            throw new LaunchMilestoneTransitionError();
          }
          const updated = await client.query({
            text: `
              update public.venue_milestones
              set
                state = $2,
                evidence_digest = coalesce($3, evidence_digest),
                evidence_recorded_at = case
                  when $3::text is null then evidence_recorded_at
                  else clock_timestamp()
                end,
                reviewer = coalesce($4, reviewer),
                record_version = record_version + 1,
                updated_at = clock_timestamp()
              where venue_milestone_id = $1
              returning
                venue_milestone_id, project_id, venue, market_type, state,
                evidence_digest, evidence_recorded_at, reviewer, record_version, updated_at
            `,
            values: [
              current.venueMilestoneId,
              rawInput.state,
              evidenceDigest,
              reviewer,
            ],
          });
          return mapMilestone(updated.rows[0]);
        });
      } catch (error) {
        return translate(error);
      }
    },

    async getEconomyCounts() {
      try {
        const [projects, launches, rounds] = await Promise.all([
          pool.query({
            text: `
              select review_status as key, count(*)::int as count
              from public.launch_projects
              group by review_status
            `,
          }),
          pool.query({
            text: `
              select l.schedule_status as key, count(*)::int as count
              from public.launches as l
              join public.launch_projects as p on p.project_id = l.project_id
              where p.review_status = 'approved'
              group by l.schedule_status
            `,
          }),
          pool.query<{ count: number }>({
            text: `
              select count(*)::int as count
              from public.launch_rounds
              where status = 'confirmed'
            `,
          }),
        ]);
        const counts: LaunchEconomyCountsRecord = Object.freeze({
          projectsByStatus: countsByKey<LaunchReviewStatus>(
            projects.rows,
            launchReviewStatuses,
          ),
          launchesByScheduleStatus: countsByKey<LaunchScheduleStatus>(
            launches.rows,
            launchScheduleStatuses,
          ),
          confirmedRoundCount: z.coerce
            .number()
            .int()
            .min(0)
            .parse(rounds.rows[0]?.count ?? 0),
          observedAt: new Date().toISOString(),
        });
        return counts;
      } catch (error) {
        return translate(error);
      }
    },
  });
}
