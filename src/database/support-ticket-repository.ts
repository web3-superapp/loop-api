import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import {
  maximumSupportTicketsPerOwnerPerDay,
  supportTicketActors,
  supportTicketCategories,
  supportTicketCreateDigestVersion,
  supportTicketEventTypes,
  supportTicketIdempotencyScope,
  supportTicketStatuses,
} from "../features/support/support-contract.js";
import {
  SupportTicketIdempotencyConflictError,
  SupportTicketNotFoundError,
  SupportTicketRateLimitedError,
  SupportTicketRepositoryUnavailableError,
  SupportTicketStateError,
  type SupportTicketEventRecord,
  type SupportTicketRecord,
  type SupportTicketRepository,
} from "../features/support/support-ticket-repository.js";

const uuidSchema = z.string().uuid();
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const dateSchema = z
  .instanceof(Date)
  .refine((value) => !Number.isNaN(value.getTime()));
const textSchema = z.string().min(1).max(4_000);

const ticketRowSchema = z
  .object({
    ticket_id: uuidSchema,
    owner_user_id: uuidSchema,
    category: z.enum(supportTicketCategories),
    body: textSchema,
    status: z.enum(supportTicketStatuses),
    created_at: dateSchema,
    updated_at: dateSchema,
    last_event_at: dateSchema,
    events: z.array(
      z
        .object({
          event_version: z.number().int().min(0),
          event_type: z.enum(supportTicketEventTypes),
          actor: z.enum(supportTicketActors),
          note: textSchema.nullable(),
          occurred_at: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

const createInputSchema = z
  .object({
    ownerUserId: uuidSchema,
    idempotencyKey: uuidSchema,
    requestSha256: sha256Schema,
    requestId: uuidSchema,
    category: z.enum(supportTicketCategories),
    body: textSchema,
  })
  .strict();
const listInputSchema = z
  .object({
    ownerUserId: uuidSchema,
    limit: z.number().int().min(1).max(50),
    before: z
      .object({ createdAt: z.string(), ticketId: uuidSchema })
      .strict()
      .optional(),
  })
  .strict();
const advanceInputSchema = z
  .object({
    ticketId: uuidSchema,
    eventType: z.enum(["answered", "closed"]),
    note: textSchema.nullable(),
    requestId: uuidSchema,
  })
  .strict();

/** Ticket columns plus its events as an ordered JSON array. */
const ticketSelect = `
  select
    t.ticket_id, t.owner_user_id, t.category, t.body, t.status,
    t.created_at, t.updated_at, t.last_event_at,
    coalesce(
      (
        select json_agg(
          json_build_object(
            'event_version', e.event_version,
            'event_type', e.event_type,
            'actor', e.actor,
            'note', e.note,
            'occurred_at', to_char(e.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
          )
          order by e.event_version
        )
        from public.support_ticket_events e
        where e.ticket_id = t.ticket_id
      ),
      '[]'::json
    ) as events
  from public.support_tickets t
`;

function mapEvent(raw: {
  readonly event_version: number;
  readonly event_type: SupportTicketEventRecord["eventType"];
  readonly actor: SupportTicketEventRecord["actor"];
  readonly note: string | null;
  readonly occurred_at: string;
}): SupportTicketEventRecord {
  const occurredAt = new Date(raw.occurred_at);
  if (Number.isNaN(occurredAt.getTime())) {
    throw new Error("Invalid support ticket event timestamp");
  }
  return Object.freeze({
    eventVersion: raw.event_version,
    eventType: raw.event_type,
    actor: raw.actor,
    note: raw.note,
    occurredAt: occurredAt.toISOString(),
  });
}

function mapTicket(raw: unknown): SupportTicketRecord {
  const row = ticketRowSchema.parse(raw);
  return Object.freeze({
    ticketId: row.ticket_id,
    ownerUserId: row.owner_user_id,
    category: row.category,
    body: row.body,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastEventAt: row.last_event_at.toISOString(),
    events: Object.freeze(row.events.map(mapEvent)),
  });
}

function translate(error: unknown): never {
  if (
    error instanceof SupportTicketIdempotencyConflictError ||
    error instanceof SupportTicketRateLimitedError ||
    error instanceof SupportTicketNotFoundError ||
    error instanceof SupportTicketStateError ||
    error instanceof SupportTicketRepositoryUnavailableError
  ) {
    throw error;
  }
  throw new SupportTicketRepositoryUnavailableError();
}

async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await operation(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function readTicket(
  client: Pick<PoolClient, "query">,
  ticketId: string,
): Promise<SupportTicketRecord | null> {
  const result = await client.query<Record<string, unknown>>({
    text: `${ticketSelect} where t.ticket_id = $1`,
    values: [ticketId],
  });
  const row = result.rows[0];
  return row === undefined ? null : mapTicket(row);
}

export function createPostgresSupportTicketRepository(
  pool: Pool,
): SupportTicketRepository {
  const repository: SupportTicketRepository = {
    async create(rawInput) {
      try {
        const input = createInputSchema.parse(rawInput);
        return await withTransaction(pool, async (client) => {
          const idempotency = await client.query<{ id: string }>({
            text: `
              insert into public.idempotency_records (
                owner_user_id, scope, idempotency_key, key_source,
                request_sha256, digest_version
              )
              values ($1, $2, $3, 'client', $4, $5)
              on conflict (scope, idempotency_key)
              do update set last_seen_at = clock_timestamp()
              where idempotency_records.owner_user_id = excluded.owner_user_id
                and idempotency_records.key_source = excluded.key_source
                and idempotency_records.request_sha256 = excluded.request_sha256
                and idempotency_records.digest_version = excluded.digest_version
              returning id
            `,
            values: [
              input.ownerUserId,
              supportTicketIdempotencyScope,
              input.idempotencyKey,
              input.requestSha256,
              supportTicketCreateDigestVersion,
            ],
          });
          const recordId = idempotency.rows[0]?.id;
          if (recordId === undefined) {
            throw new SupportTicketIdempotencyConflictError();
          }
          const existing = await client.query<Record<string, unknown>>({
            text: `${ticketSelect} where t.create_idempotency_record_id = $1`,
            values: [recordId],
          });
          if (existing.rows[0] !== undefined) {
            const ticket = mapTicket(existing.rows[0]);
            if (ticket.ownerUserId !== input.ownerUserId) {
              throw new SupportTicketIdempotencyConflictError();
            }
            return Object.freeze({ created: false, ticket });
          }

          await client.query({
            text: `
              select pg_advisory_xact_lock(
                hashtextextended('loop:v2:support-ticket:owner:' || $1, 0)
              )
            `,
            values: [input.ownerUserId],
          });
          const quota = await client.query<{ day_count: number }>({
            text: `
              select count(*)::int as day_count
              from public.support_tickets
              where owner_user_id = $1
                and created_at >= clock_timestamp() - interval '24 hours'
            `,
            values: [input.ownerUserId],
          });
          if (
            (quota.rows[0]?.day_count ?? Number.MAX_SAFE_INTEGER) >=
            maximumSupportTicketsPerOwnerPerDay
          ) {
            throw new SupportTicketRateLimitedError();
          }

          const inserted = await client.query<{ ticket_id: string }>({
            text: `
              insert into public.support_tickets (
                owner_user_id, category, body,
                create_idempotency_record_id, create_request_sha256
              )
              values ($1, $2, $3, $4, $5)
              returning ticket_id
            `,
            values: [
              input.ownerUserId,
              input.category,
              input.body,
              recordId,
              input.requestSha256,
            ],
          });
          const ticketId = inserted.rows[0]?.ticket_id;
          if (ticketId === undefined) {
            throw new Error("Support ticket insert returned no result");
          }
          await client.query({
            text: `
              insert into public.support_ticket_events (
                ticket_id, owner_user_id, event_version, event_type, actor,
                note, request_id
              )
              values ($1, $2, 0, 'created', 'user', null, $3)
            `,
            values: [ticketId, input.ownerUserId, input.requestId],
          });
          const ticket = await readTicket(client, ticketId);
          if (ticket === null) {
            throw new Error("Support ticket insert lost its row");
          }
          return Object.freeze({ created: true, ticket });
        });
      } catch (error) {
        return translate(error);
      }
    },

    async list(rawInput) {
      try {
        const input = listInputSchema.parse(rawInput);
        const result = await pool.query<Record<string, unknown>>({
          text: `
            ${ticketSelect}
            where t.owner_user_id = $1
              and (
                $2::timestamptz is null
                or t.created_at < $2::timestamptz
                or (t.created_at = $2::timestamptz and t.ticket_id < $3::uuid)
              )
            order by t.created_at desc, t.ticket_id desc
            limit $4
          `,
          values: [
            input.ownerUserId,
            input.before?.createdAt ?? null,
            input.before?.ticketId ?? null,
            input.limit + 1,
          ],
        });
        const rows = result.rows.map(mapTicket);
        return Object.freeze({
          items: Object.freeze(rows.slice(0, input.limit)),
          hasMore: rows.length > input.limit,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async advance(rawInput) {
      try {
        const input = advanceInputSchema.parse(rawInput);
        return await withTransaction(pool, async (client) => {
          const locked = await client.query<{
            owner_user_id: string;
            status: string;
          }>({
            text: `
              select owner_user_id, status
              from public.support_tickets
              where ticket_id = $1
              for update
            `,
            values: [input.ticketId],
          });
          const current = locked.rows[0];
          if (current === undefined) {
            throw new SupportTicketNotFoundError();
          }
          const allowed =
            (input.eventType === "answered" && current.status === "open") ||
            (input.eventType === "closed" && current.status !== "closed");
          if (!allowed) {
            throw new SupportTicketStateError();
          }
          const version = await client.query<{ next_version: number }>({
            text: `
              select coalesce(max(event_version), 0) + 1 as next_version
              from public.support_ticket_events
              where ticket_id = $1
            `,
            values: [input.ticketId],
          });
          const nextVersion = version.rows[0]?.next_version;
          if (nextVersion === undefined) {
            throw new Error("Support ticket event version lookup failed");
          }
          await client.query({
            text: `
              insert into public.support_ticket_events (
                ticket_id, owner_user_id, event_version, event_type, actor,
                note, request_id
              )
              values ($1, $2, $3, $4, 'operator', $5, $6)
            `,
            values: [
              input.ticketId,
              current.owner_user_id,
              nextVersion,
              input.eventType,
              input.note,
              input.requestId,
            ],
          });
          await client.query({
            text: `
              update public.support_tickets
              set
                status = $2,
                updated_at = clock_timestamp(),
                last_event_at = clock_timestamp()
              where ticket_id = $1
            `,
            values: [input.ticketId, input.eventType],
          });
          const ticket = await readTicket(client, input.ticketId);
          if (ticket === null) {
            throw new Error("Support ticket advance lost its row");
          }
          return ticket;
        });
      } catch (error) {
        return translate(error);
      }
    },
  };
  return Object.freeze(repository);
}
