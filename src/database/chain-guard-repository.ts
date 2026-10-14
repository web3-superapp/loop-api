import type { Pool } from "pg";

import {
  chainGuardEventKinds,
  chainGuardHoldKinds,
  chainGuardIncidentKinds,
  chainGuardStateKinds,
  type ChainGuardDetails,
  type ChainGuardIncidentKind,
  type ChainGuardIncidentRecord,
  type ChainGuardInstanceRecord,
  type ChainGuardRepository,
} from "../features/chain-guard/chain-guard-contract.js";
import { insertAdminAuditRow } from "./admin-repository.js";
import {
  toIsoString,
  toNullableIsoString,
  withV2Transaction,
} from "./v2-command-support.js";

/**
 * Decision 0134: PostgreSQL side of the chain guard (migration 000079).
 * One unresolved incident per (chain, kind, subject) is enforced by the
 * partial unique index; a repeat sighting is an upsert on it. The watch set
 * is a read of `launch2_instances`. Nothing here reads a chain.
 */

export class ChainGuardRepositoryUnavailableError extends Error {
  constructor() {
    super("Chain guard repository returned an unexpected row");
    this.name = "ChainGuardRepositoryUnavailableError";
  }
}

type Row = Record<string, unknown>;

const columns = `incident_id, chain_id, kind, subject, details, first_seen_at,
  last_seen_at, resolved_at, resolution, resolved_by::text as resolved_by,
  resolution_note`;

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string")
    throw new ChainGuardRepositoryUnavailableError();
  return value;
}

function timestamp(row: Row, key: string): string {
  const value = row[key];
  if (!(value instanceof Date) && typeof value !== "string") {
    throw new ChainGuardRepositoryUnavailableError();
  }
  return toIsoString(value);
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new ChainGuardRepositoryUnavailableError();
  }
  return value;
}

function mapIncident(row: Row): ChainGuardIncidentRecord {
  const kind = text(row, "kind");
  if (!(chainGuardIncidentKinds as readonly string[]).includes(kind)) {
    throw new ChainGuardRepositoryUnavailableError();
  }
  const details = row["details"];
  if (
    typeof details !== "object" ||
    details === null ||
    Array.isArray(details)
  ) {
    throw new ChainGuardRepositoryUnavailableError();
  }
  const resolved = row["resolved_at"];
  const resolution = nullableText(row, "resolution");
  if (resolution !== null && resolution !== "auto" && resolution !== "manual") {
    throw new ChainGuardRepositoryUnavailableError();
  }
  return Object.freeze({
    incidentId: text(row, "incident_id"),
    chainId: text(row, "chain_id"),
    kind: kind as ChainGuardIncidentKind,
    subject: text(row, "subject"),
    details: details as ChainGuardDetails,
    firstSeenAt: timestamp(row, "first_seen_at"),
    lastSeenAt: timestamp(row, "last_seen_at"),
    resolvedAt:
      resolved === null || resolved === undefined
        ? null
        : toNullableIsoString(resolved as Date | string),
    resolution,
    resolvedBy: nullableText(row, "resolved_by"),
    resolutionNote: nullableText(row, "resolution_note"),
  });
}

export function createPostgresChainGuardRepository(
  pool: Pool,
): ChainGuardRepository {
  return Object.freeze<ChainGuardRepository>({
    async listWatchInstances(chainId) {
      const result = await pool.query<Row>(
        `select instance_id::text as instance_id, escrow_address, nft_address,
           curve_address, graduation_adapter_address, buyback_adapter_address,
           buyback_executor_address, meme_address,
           coalesce(official_pool_id, dynamic_pool_id) as pool_id,
           case
             when official_pool_id is not null then hook_address
             when dynamic_pool_id is not null then dynamic_hook_address
           end as pool_hook
         from public.launch2_instances
         where chain_id = $1
         order by registered_at, instance_id`,
        [chainId],
      );
      return result.rows.map((row): ChainGuardInstanceRecord =>
        Object.freeze({
          instanceId: text(row, "instance_id"),
          escrow: text(row, "escrow_address"),
          nft: text(row, "nft_address"),
          curve: text(row, "curve_address"),
          graduationAdapter: text(row, "graduation_adapter_address"),
          buybackAdapter: text(row, "buyback_adapter_address"),
          buybackExecutor: text(row, "buyback_executor_address"),
          poolId: row["pool_id"] === null ? null : text(row, "pool_id"),
          meme: text(row, "meme_address"),
          poolHook: nullableText(row, "pool_hook"),
        }),
      );
    },

    async openOrTouch(input) {
      const result = await pool.query<Row>(
        `insert into public.chain_guard_incidents
           (incident_id, chain_id, kind, subject, details, first_seen_at, last_seen_at)
         values ($1, $2, $3, $4, $5::jsonb, $6, $6)
         on conflict (chain_id, kind, subject) where resolved_at is null
         do update set
           last_seen_at = greatest(public.chain_guard_incidents.last_seen_at,
             excluded.last_seen_at),
           details = excluded.details
         returning ${columns}, (xmax = 0) as inserted`,
        [
          input.incidentId,
          input.chainId,
          input.kind,
          input.subject,
          JSON.stringify(input.details),
          input.now,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) throw new ChainGuardRepositoryUnavailableError();
      return { incident: mapIncident(row), opened: row["inserted"] === true };
    },

    async resolve(input) {
      const stateKinds = input.kinds.filter((kind) =>
        (chainGuardStateKinds as readonly string[]).includes(kind),
      );
      const eventKinds = input.kinds.filter((kind) =>
        (chainGuardEventKinds as readonly string[]).includes(kind),
      );
      const result = await pool.query<Row>(
        `update public.chain_guard_incidents
           set resolved_at = greatest($5::timestamptz, first_seen_at),
             resolution = 'auto'
         where chain_id = $1
           and resolved_at is null
           and (
             (kind = any($2::text[]) and not ((kind || '|' || subject) = any($3::text[])))
             or (kind = any($4::text[]) and last_seen_at < $6)
           )
         returning ${columns}`,
        [
          input.chainId,
          stateKinds,
          [...input.keep],
          eventKinds,
          input.now,
          input.eventsSeenBefore,
        ],
      );
      return result.rows.map(mapIncident);
    },

    async listUnresolved(input) {
      const result = await pool.query<Row>(
        `select ${columns}
         from public.chain_guard_incidents
         where resolved_at is null
           and ($1::text is null or chain_id = $1)
         order by last_seen_at desc, incident_id
         limit $2`,
        [input.chainId, input.limit],
      );
      return result.rows.map(mapIncident);
    },

    async listHolds(chainId) {
      const result = await pool.query<Row>(
        `select ${columns}
         from public.chain_guard_incidents
         where resolved_at is null and chain_id = $1 and kind = any($2::text[])
         order by first_seen_at, incident_id`,
        [chainId, [...chainGuardHoldKinds]],
      );
      return result.rows.map(mapIncident);
    },

    async resolveManually(input) {
      return withV2Transaction(
        pool,
        () => new ChainGuardRepositoryUnavailableError(),
        async (client) => {
          const current = await client.query<Row>(
            `select ${columns}
             from public.chain_guard_incidents
             where incident_id = $1 and chain_id = $2
             for update`,
            [input.incidentId, input.chainId],
          );
          const row = current.rows[0];
          if (row === undefined) return { status: "not_found" as const };
          const before = mapIncident(row);
          if (before.resolvedAt !== null) {
            return { status: "already_resolved" as const, incident: before };
          }
          const updated = await client.query<Row>(
            `update public.chain_guard_incidents
               set resolved_at = greatest($2::timestamptz, first_seen_at),
                 resolution = 'manual',
                 resolved_by = $3,
                 resolution_note = $4
             where incident_id = $1 and resolved_at is null
             returning ${columns}`,
            [
              input.incidentId,
              input.now,
              input.audit.actorAccountId,
              input.note,
            ],
          );
          const resolvedRow = updated.rows[0];
          if (resolvedRow === undefined) {
            throw new ChainGuardRepositoryUnavailableError();
          }
          const incident = mapIncident(resolvedRow);
          const audit = await insertAdminAuditRow(client, {
            actor: input.audit.actor,
            actorAccountId: input.audit.actorAccountId,
            action: "chain_guard.incident.resolve",
            targetType: "chain_guard_incident",
            targetId: incident.incidentId,
            before: {
              kind: before.kind,
              subject: before.subject,
              lastSeenAt: before.lastSeenAt,
              resolvedAt: null,
            },
            after: {
              resolvedAt: incident.resolvedAt,
              resolution: incident.resolution,
              note: incident.resolutionNote,
            },
            requestId: input.audit.requestId,
          });
          return {
            status: "resolved" as const,
            incident,
            audit: { auditId: audit.auditId, seq: audit.seq, at: audit.at },
          };
        },
      );
    },

    async getCursor(chainId) {
      const result = await pool.query<Row>(
        `select last_block_number::text as last_block_number
         from public.chain_guard_cursors where chain_id = $1`,
        [chainId],
      );
      const row = result.rows[0];
      return row === undefined ? null : BigInt(text(row, "last_block_number"));
    },

    async setCursor(input) {
      await pool.query(
        `insert into public.chain_guard_cursors (chain_id, last_block_number, updated_at)
         values ($1, $2, $3)
         on conflict (chain_id) do update set
           last_block_number = greatest(public.chain_guard_cursors.last_block_number,
             excluded.last_block_number),
           updated_at = excluded.updated_at`,
        [input.chainId, input.blockNumber.toString(), input.now],
      );
    },
  });
}
