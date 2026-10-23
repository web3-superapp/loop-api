import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import {
  notificationInboxCoreEventTypes,
  notificationInboxEventTypes,
  type NotificationInboxEventType,
} from "../features/alerts/notification-contract.js";
import {
  launchBadgeMintedNotification,
  launchGraduatedNotification,
} from "../features/notifications/notification-inbox-contract.js";
import {
  launchActivatedNotification,
  launchActivationBatch,
} from "../features/notifications/launch-review-inbox-contract.js";
import { insertNotificationRow } from "./notification-repository.js";
import { withV2Transaction } from "./v2-command-support.js";

/**
 * Decision 0177: storage side of the `notification_inbox` lane.
 *
 * - `produceLaunch2` turns MEME v2 read-model facts into feed rows: one
 *   `launch.graduated` row per recipient account of a newly graduated
 *   instance, one `launch.badge_minted` row per minted token. Every fact
 *   carries its own marker (`inbox_graduation_settled_at`,
 *   `inbox_settled_at`) and every row its dedupe key, so a fact is handled
 *   once and a row is written once, whatever the lane retries.
 * - `claimPushes` / `settleStalePushes` hand fine-event rows to the push
 *   dispatcher at most once.
 */

export class NotificationInboxRepositoryUnavailableError extends Error {
  constructor() {
    super("Notification inbox repository is unavailable");
    this.name = "NotificationInboxRepositoryUnavailableError";
  }
}

function unavailable(): Error {
  return new NotificationInboxRepositoryUnavailableError();
}

export interface NotificationInboxProduceResult {
  /** Graduations whose rows were written this pass. */
  readonly graduations: number;
  /** Mints whose rows were written this pass. */
  readonly mints: number;
  /**
   * Decision 0178: activated instances whose owner row was written this
   * pass (absent in fakes that predate it).
   */
  readonly activations?: number;
  /** Facts marked without rows (stale, hidden instance, no account). */
  readonly skipped: number;
  /** Feed rows inserted (duplicates excluded). */
  readonly notifications: number;
  /** Whether a batch was full (the lane runs again at once). */
  readonly saturated: boolean;
}

export interface NotificationInboxPushClaim {
  readonly notificationId: string;
  readonly ownerUserId: string;
  readonly eventType: NotificationInboxEventType;
  readonly entityRef: string;
  readonly contextRoute: string;
  readonly dedupeKey: string;
}

export interface NotificationInboxRepository {
  produceLaunch2(input: {
    readonly now: Date;
    readonly freshnessSeconds: number;
    readonly graduationLimit: number;
    readonly mintLimit: number;
  }): Promise<NotificationInboxProduceResult>;
  /**
   * Marks up to `limit` fresh unsettled fine-event rows as settled and
   * returns them: the push is at most once, a Provider failure is not
   * retried (the feed row stays the record).
   *
   * Decision 0178: only rows whose fine event is in `eventTypes` (the
   * events whose emit switch is on) are claimed; absent = the Decision
   * 0177 four.
   */
  claimPushes(input: {
    readonly now: Date;
    readonly freshnessSeconds: number;
    readonly limit: number;
    readonly eventTypes?: readonly NotificationInboxEventType[];
  }): Promise<readonly NotificationInboxPushClaim[]>;
  /** Settles unsettled rows older than the window without a push. */
  settleStalePushes(input: {
    readonly now: Date;
    readonly freshnessSeconds: number;
  }): Promise<number>;
}

type Row = Record<string, unknown>;

const graduationRowSchema = z.object({
  instance_id: z.string().uuid(),
  name: z.string().min(1),
  owner_user_id: z.string().uuid(),
  graduated_at: z.instanceof(Date),
  official_pool_id: z.string().nullable(),
  listing: z.string(),
});

const activationRowSchema = z.object({
  instance_id: z.string().uuid(),
  job_id: z.string().uuid(),
  project_id: z.string().uuid(),
  owner_user_id: z.string().uuid(),
  name: z.string().min(1),
  ticker: z.string().nullable(),
  nft_sale_start: z.instanceof(Date),
  activated_at: z.instanceof(Date),
  listing: z.string(),
  task_status: z.string(),
});

const mintRowSchema = z.object({
  chain_id: z.string(),
  transaction_hash: z.string(),
  log_index: z.union([z.number(), z.string()]),
  instance_id: z.string().uuid(),
  token_id: z.string().regex(/^[1-9][0-9]*$/),
  minted_at: z.instanceof(Date),
  payer_address: z.string(),
  name: z.string().min(1),
  listing: z.string(),
});

async function recipientsOfGraduation(
  client: PoolClient,
  instanceId: string,
  projectOwnerUserId: string,
): Promise<readonly string[]> {
  const result = await client.query<{ owner_user_id: string }>({
    text: `
      select distinct w.owner_user_id::text as owner_user_id
      from public.launch2_positions p
      join public.account_wallets w
        on w.address = p.holder_address and w.status = 'active'
      where p.instance_id = $1
        and (p.curve_bought - p.curve_sold > 0 or p.nft_held > 0)
      union
      select $2::uuid::text
      order by 1
    `,
    values: [instanceId, projectOwnerUserId],
  });
  return result.rows.map((row) => row.owner_user_id);
}

async function accountsOfWallet(
  client: PoolClient,
  address: string,
): Promise<readonly string[]> {
  const result = await client.query<{ owner_user_id: string }>({
    text: `
      select distinct owner_user_id::text as owner_user_id
      from public.account_wallets
      where address = $1 and status = 'active'
      order by 1
    `,
    values: [address],
  });
  return result.rows.map((row) => row.owner_user_id);
}

export function createPostgresNotificationInboxRepository(
  pool: Pool,
): NotificationInboxRepository {
  async function produceGraduations(
    now: Date,
    freshnessSeconds: number,
    limit: number,
  ): Promise<{
    readonly written: number;
    readonly skipped: number;
    readonly rows: number;
    readonly claimed: number;
  }> {
    return withV2Transaction(pool, unavailable, async (client) => {
      const pending = await client.query<Row>({
        text: `
          select instance_id::text, name, owner_user_id::text, graduated_at,
            official_pool_id, listing
          from public.launch2_instances
          where graduated_at is not null and inbox_graduation_settled_at is null
          order by graduated_at, instance_id
          limit $1
          for update skip locked
        `,
        values: [limit],
      });
      let written = 0;
      let skipped = 0;
      let rows = 0;
      for (const raw of pending.rows) {
        const instance = graduationRowSchema.parse(raw);
        const stale =
          instance.graduated_at.getTime() <
          now.getTime() - freshnessSeconds * 1000;
        if (stale || instance.listing !== "visible") {
          skipped += 1;
        } else {
          const recipients = await recipientsOfGraduation(
            client,
            instance.instance_id,
            instance.owner_user_id,
          );
          for (const ownerUserId of recipients) {
            const inserted = await insertNotificationRow(
              client,
              launchGraduatedNotification({
                ownerUserId,
                instanceId: instance.instance_id,
                projectName: instance.name,
                graduatedAt: instance.graduated_at.toISOString(),
                officialPoolId: instance.official_pool_id,
              }),
            );
            if (inserted !== null) rows += 1;
          }
          written += 1;
        }
        await client.query({
          text: `
            update public.launch2_instances
            set inbox_graduation_settled_at = clock_timestamp()
            where instance_id = $1
          `,
          values: [instance.instance_id],
        });
      }
      return { written, skipped, rows, claimed: pending.rows.length };
    });
  }

  async function produceMints(
    now: Date,
    freshnessSeconds: number,
    limit: number,
  ): Promise<{
    readonly written: number;
    readonly skipped: number;
    readonly rows: number;
    readonly claimed: number;
  }> {
    return withV2Transaction(pool, unavailable, async (client) => {
      const pending = await client.query<Row>({
        text: `
          select m.chain_id, m.transaction_hash, m.log_index,
            m.instance_id::text, m.token_id::text, m.minted_at,
            m.payer_address, i.name, i.listing
          from public.launch2_nft_mints m
          join public.launch2_instances i on i.instance_id = m.instance_id
          where m.inbox_settled_at is null and not m.removed
          order by m.minted_at, m.chain_id, m.transaction_hash, m.log_index
          limit $1
          for update of m skip locked
        `,
        values: [limit],
      });
      let written = 0;
      let skipped = 0;
      let rows = 0;
      for (const raw of pending.rows) {
        const mint = mintRowSchema.parse(raw);
        const stale =
          mint.minted_at.getTime() < now.getTime() - freshnessSeconds * 1000;
        const owners =
          stale || mint.listing !== "visible"
            ? []
            : await accountsOfWallet(client, mint.payer_address);
        if (owners.length === 0) {
          skipped += 1;
        } else {
          for (const ownerUserId of owners) {
            const inserted = await insertNotificationRow(
              client,
              launchBadgeMintedNotification({
                ownerUserId,
                instanceId: mint.instance_id,
                projectName: mint.name,
                tokenId: mint.token_id,
                mintedAt: mint.minted_at.toISOString(),
                transactionHash: mint.transaction_hash,
              }),
            );
            if (inserted !== null) rows += 1;
          }
          written += 1;
        }
        await client.query({
          text: `
            update public.launch2_nft_mints
            set inbox_settled_at = clock_timestamp()
            where chain_id = $1 and transaction_hash = $2 and log_index = $3
          `,
          values: [mint.chain_id, mint.transaction_hash, mint.log_index],
        });
      }
      return { written, skipped, rows, claimed: pending.rows.length };
    });
  }

  /**
   * Decision 0178: one `launch.activated` row to the project owner per
   * newly registered instance (the launch2 lane registers an instance only
   * once its deployment task is `activated`, which is when its ID exists).
   * Marker `launch2_instances.inbox_activation_settled_at` + dedupe key:
   * at most once. Stale (activated > 24 h before the lane sees it), hidden,
   * or not-activated (defensive: the lane registers only activated tasks)
   * instances are only marked.
   */
  async function produceActivations(
    now: Date,
    freshnessSeconds: number,
    limit: number,
  ): Promise<{
    readonly written: number;
    readonly skipped: number;
    readonly rows: number;
    readonly claimed: number;
  }> {
    return withV2Transaction(pool, unavailable, async (client) => {
      const pending = await client.query<Row>({
        text: `
          select i.instance_id::text, i.job_id::text, i.project_id::text,
            i.owner_user_id::text, i.name, i.ticker, i.nft_sale_start,
            coalesce(t.activated_at, i.registered_at) as activated_at,
            i.listing, t.status as task_status
          from public.launch2_instances i
          join public.hooks_launch_deployment_tasks t on t.job_id = i.job_id
          where i.inbox_activation_settled_at is null
          order by i.registered_at, i.instance_id
          limit $1
          for update of i skip locked
        `,
        values: [limit],
      });
      let written = 0;
      let skipped = 0;
      let rows = 0;
      for (const raw of pending.rows) {
        const instance = activationRowSchema.parse(raw);
        const stale =
          instance.activated_at.getTime() <
          now.getTime() - freshnessSeconds * 1000;
        if (
          stale ||
          instance.listing !== "visible" ||
          instance.task_status !== "activated"
        ) {
          skipped += 1;
        } else {
          const inserted = await insertNotificationRow(
            client,
            launchActivatedNotification({
              ownerUserId: instance.owner_user_id,
              projectId: instance.project_id,
              jobId: instance.job_id,
              instanceId: instance.instance_id,
              projectName: instance.name,
              symbol: instance.ticker,
              saleStartAt: instance.nft_sale_start.toISOString(),
              activatedAt: instance.activated_at.toISOString(),
              now,
            }),
          );
          if (inserted !== null) rows += 1;
          written += 1;
        }
        await client.query({
          text: `
            update public.launch2_instances
            set inbox_activation_settled_at = clock_timestamp()
            where instance_id = $1
          `,
          values: [instance.instance_id],
        });
      }
      return { written, skipped, rows, claimed: pending.rows.length };
    });
  }

  const repository: NotificationInboxRepository = {
    async produceLaunch2(input) {
      try {
        const graduations = await produceGraduations(
          input.now,
          input.freshnessSeconds,
          input.graduationLimit,
        );
        const mints = await produceMints(
          input.now,
          input.freshnessSeconds,
          input.mintLimit,
        );
        const activations = await produceActivations(
          input.now,
          input.freshnessSeconds,
          launchActivationBatch,
        );
        return Object.freeze({
          graduations: graduations.written,
          mints: mints.written,
          activations: activations.written,
          skipped: graduations.skipped + mints.skipped + activations.skipped,
          notifications: graduations.rows + mints.rows + activations.rows,
          saturated:
            graduations.claimed >= input.graduationLimit ||
            mints.claimed >= input.mintLimit ||
            activations.claimed >= launchActivationBatch,
        });
      } catch {
        throw new NotificationInboxRepositoryUnavailableError();
      }
    },

    async claimPushes(input) {
      try {
        const result = await pool.query<Row>({
          text: `
            with claimed as (
              select notification_id
              from public.notifications
              where event_type is not null and push_settled_at is null
                and created_at >= $1::timestamptz
                and event_type = any($3::text[])
              order by created_at, notification_id
              limit $2
              for update skip locked
            )
            update public.notifications n
            set push_settled_at = clock_timestamp()
            from claimed
            where n.notification_id = claimed.notification_id
            returning n.notification_id::text, n.owner_user_id::text,
              n.event_type, n.entity_ref, n.context_route, n.dedupe_key,
              n.created_at
          `,
          values: [
            new Date(
              input.now.getTime() - input.freshnessSeconds * 1000,
            ).toISOString(),
            input.limit,
            [...(input.eventTypes ?? notificationInboxCoreEventTypes)],
          ],
        });
        return Object.freeze(
          result.rows
            .map((row) =>
              z
                .object({
                  notification_id: z.string().uuid(),
                  owner_user_id: z.string().uuid(),
                  event_type: z.enum(notificationInboxEventTypes),
                  entity_ref: z.string(),
                  context_route: z.string(),
                  dedupe_key: z.string(),
                  created_at: z.instanceof(Date),
                })
                .parse(row),
            )
            .sort(
              (left, right) =>
                left.created_at.getTime() - right.created_at.getTime(),
            )
            .map((row) =>
              Object.freeze({
                notificationId: row.notification_id,
                ownerUserId: row.owner_user_id,
                eventType: row.event_type,
                entityRef: row.entity_ref,
                contextRoute: row.context_route,
                dedupeKey: row.dedupe_key,
              }),
            ),
        );
      } catch {
        throw new NotificationInboxRepositoryUnavailableError();
      }
    },

    async settleStalePushes(input) {
      try {
        const result = await pool.query<{ settled: number }>({
          text: `
            with settled as (
              update public.notifications
              set push_settled_at = clock_timestamp()
              where event_type is not null and push_settled_at is null
                and created_at < $1::timestamptz
              returning 1
            )
            select count(*)::int as settled from settled
          `,
          values: [
            new Date(
              input.now.getTime() - input.freshnessSeconds * 1000,
            ).toISOString(),
          ],
        });
        return z.number().int().min(0).parse(result.rows[0]?.settled);
      } catch {
        throw new NotificationInboxRepositoryUnavailableError();
      }
    },
  };
  return Object.freeze(repository);
}
