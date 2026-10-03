import { isCommunityWeightWithinRange } from "../features/mining/mining-contract.js";
import { randomUUID } from "node:crypto";
import { runOpsMiningJob } from "../features/ops/ops-mining-job.js";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  OpsError,
  commandPermission,
  miningPackageSchema,
  opsHash,
  type OpsCommand,
  type OpsPermission,
  type OpsRepository,
  type MiningPackage,
} from "../features/ops/ops-contract.js";
import { createPostgresMiningRepository } from "./mining-repository.js";
import { createPostgresCommunityRepository } from "./community-repository.js";
import { createPostgresSupportTicketRepository } from "./support-ticket-repository.js";
import { createPostgresNotificationRepository } from "./notification-repository.js";
import { communityApplicationNotification } from "../features/community/community-review-service.js";
import { opsTransactionPool } from "./ops-transaction.js";

type DraftRow = {
  id: string;
  package: unknown;
  revision: number;
  content_hash: string;
  state: string;
  editor_id: string;
  contributors: string[];
};
async function authorize(
  client: Pick<PoolClient, "query">,
  actor: string,
  permission: OpsPermission,
  scope = "*",
): Promise<void> {
  const operator = await client.query(
    "select user_id from public.ops_operators where user_id=$1 and enabled for share",
    [actor],
  );
  if (!operator.rowCount) throw new OpsError("OPS_FORBIDDEN", 403);
  const grant = await client.query(
    "select 1 from public.ops_grants where user_id=$1 and permission=$2 and scope in ('*',$3) for share",
    [actor, permission, scope],
  );
  if (!grant.rowCount) throw new OpsError("OPS_FORBIDDEN", 403);
}
function permissionForResource(resource: string): OpsPermission {
  if (["mining", "drafts", "weights", "snapshots"].includes(resource))
    return "mining.read";
  if (resource === "communities") return "community.review";
  if (resource === "support") return "support.manage";
  if (resource === "audit") return "audit.read";
  throw new OpsError("OPS_RESOURCE_NOT_FOUND", 404);
}
async function loadDraft(client: PoolClient, id: string): Promise<DraftRow> {
  const result = await client.query<DraftRow>(
    "select * from public.ops_mining_drafts where id=$1 for update",
    [z.uuid().parse(id)],
  );
  if (!result.rows[0]) throw new OpsError("OPS_NOT_FOUND", 404);
  return result.rows[0];
}
async function validatePackage(client: PoolClient, pkg: MiningPackage) {
  const range = pkg.weightRange.community.range;
  const assets = new Set<string>();
  for (const weight of [...pkg.communityWeights].sort((a, b) =>
    a.communityId.localeCompare(b.communityId),
  )) {
    const row = (
      await client.query<{ bound_asset_key: string | null }>(
        "select bound_asset_key from public.communities where community_id=$1 for share",
        [weight.communityId],
      )
    ).rows[0];
    if (!row || row.bound_asset_key !== weight.boundAssetId)
      throw new OpsError("OPS_COMMUNITY_BINDING_CHANGED");
    if (!range || !isCommunityWeightWithinRange(weight.weight, range))
      throw new OpsError("OPS_WEIGHT_OUT_OF_RANGE", 400);
    if (!(weight.boundAssetId in pkg.formula.assetWeights))
      throw new OpsError("OPS_ASSET_WEIGHT_MISSING", 400);
    if (assets.has(weight.boundAssetId))
      throw new OpsError("OPS_ASSET_WEIGHT_CONFLICT", 400);
    assets.add(weight.boundAssetId);
  }
}
export function createPostgresOpsRepository(
  pool: Pool,
  options: { communityMemberCap?: number } = {},
): OpsRepository {
  return {
    async session(actor) {
      const result = await pool.query<{ label: string }>(
        "select label from public.ops_operators where user_id=$1 and enabled",
        [actor],
      );
      if (!result.rows[0]) throw new OpsError("OPS_FORBIDDEN", 403);
      const grants = await pool.query<{ permission: string; scope: string }>(
        "select permission,scope from public.ops_grants where user_id=$1 order by permission,scope",
        [actor],
      );
      return {
        label: result.rows[0]["label"],
        grants: grants.rows,
        environment: "development",
        actorId: actor,
      };
    },
    async list(actor, resource, before, filters = {}) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const permission = permissionForResource(resource);
        // Scoped community operators may list only their authorized communities.
        if (resource === "communities") {
          const operator = await client.query(
            "select 1 from public.ops_operators where user_id=$1 and enabled for share",
            [actor],
          );
          if (!operator.rowCount) throw new OpsError("OPS_FORBIDDEN", 403);
          const grant = await client.query<{ scope: string }>(
            "select scope from public.ops_grants where user_id=$1 and permission=$2 for share",
            [actor, permission],
          );
          if (!grant.rowCount) throw new OpsError("OPS_FORBIDDEN", 403);
          const scopes = grant.rows.map((row) => row.scope);
          const result = await client.query<Record<string, unknown>>(
            `select community_id,name,verification_status,record_version,bound_asset_key,rejected_reason,created_at from public.communities where ($1 or community_id::text=any($2::text[])) and ($3::text is null or community_id::text < $3) order by community_id desc limit 51`,
            [scopes.includes("*"), scopes, before ?? null],
          );
          await client.query("commit");
          return page(result.rows, "community_id");
        }
        await authorize(client, actor, permission);
        if (
          resource !== "audit" &&
          Object.keys(filters).some(
            (key) => key !== "configVersion" || resource !== "weights",
          )
        )
          throw new OpsError("OPS_INVALID_INPUT", 400);
        let resultVersion: string | undefined;
        let rows: Record<string, unknown>[];
        let key: string;
        if (resource === "mining") {
          rows = (
            await client.query<Record<string, unknown>>(
              "select * from public.mining_formula_versions order by created_at desc limit 50",
            )
          ).rows;
          key = "config_version";
        } else if (resource === "drafts") {
          rows = (
            await client.query<Record<string, unknown>>(
              "select * from public.ops_mining_drafts where ($1::text is null or id::text < $1) order by id desc limit 51",
              [before ?? null],
            )
          ).rows;
          key = "id";
        } else if (resource === "weights") {
          if (!filters.configVersion)
            throw new OpsError("OPS_CONFIG_VERSION_REQUIRED", 400);
          resultVersion = filters.configVersion;
          const version = await client.query(
            "select 1 from public.mining_formula_versions where config_version=$1",
            [resultVersion],
          );
          if (!version.rowCount) throw new OpsError("OPS_NOT_FOUND", 404);
          rows = (
            await client.query<Record<string, unknown>>(
              "select w.community_id,c.name,c.bound_asset_key,w.config_version,w.bound_asset_id,w.bound_asset_id as approved_asset_id,w.weight,w.status from public.community_mining_weights w join public.communities c on c.community_id=w.community_id where w.config_version=$2 and ($1::text is null or w.community_id::text < $1) order by w.community_id desc limit 51",
              [before ?? null, resultVersion],
            )
          ).rows;
          key = "community_id";
        } else if (resource === "snapshots") {
          rows = (
            await client.query<Record<string, unknown>>(
              "select snapshot_id,formula_version,price_version,status,block_number::text,total_power,computed_at,invalidated_at,invalidation_reason from public.mining_snapshots where ($1::text is null or snapshot_id::text < $1) order by snapshot_id desc limit 51",
              [before ?? null],
            )
          ).rows;
          key = "snapshot_id";
        } else if (resource === "support") {
          rows = (
            await client.query<Record<string, unknown>>(
              "select ticket_id,category,body,status,created_at,updated_at from public.support_tickets where ($1::text is null or ticket_id::text < $1) order by ticket_id desc limit 51",
              [before ?? null],
            )
          ).rows;
          key = "ticket_id";
        } else {
          if (before !== undefined && !/^[0-9]{1,18}$/.test(before))
            throw new OpsError("OPS_INVALID_INPUT", 400);
          rows = (
            await client.query<Record<string, unknown>>(
              `select a.id::text,a.operation_id,a.actor_id,a.actor_kind,a.source,a.before_state,a.after_state,a.action,a.target,a.reason,a.outcome,a.code,a.created_at,
              coalesce(o.result #>> '{package,configVersion}', j.evidence #>> '{formula,configVersion}') as config_version
             from public.ops_audit a left join public.ops_operations o on o.operation_id=a.operation_id
             left join public.ops_jobs j on j.id::text=coalesce(o.result->>'jobId',a.operation_id::text)
             where ($1::bigint is null or a.id<$1) and ($2::uuid is null or a.actor_id=$2)
             and ($3::text is null or a.target=$3) and ($4::text is null or a.action=$4)
             and ($5::text is null or a.outcome=$5) and ($6::timestamptz is null or a.created_at>=$6)
             and ($7::timestamptz is null or a.created_at<=$7)
             and ($8::text is null or coalesce(o.result #>> '{package,configVersion}',j.evidence #>> '{formula,configVersion}')=$8)
             order by a.id desc limit 51`,
              [
                before ?? null,
                filters.actorId ?? null,
                filters.target ?? null,
                filters.action ?? null,
                filters.outcome ?? null,
                filters.from ?? null,
                filters.to ?? null,
                filters.configVersion ?? null,
              ],
            )
          ).rows;
          key = "id";
        }
        await client.query("commit");
        return {
          ...page(rows, key),
          ...(resultVersion ? { configVersion: resultVersion } : {}),
        };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async operation(actor, id) {
      z.uuid().parse(id);
      const client = await pool.connect();
      try {
        await client.query("begin");
        const row = (
          await client.query<{
            actor_id: string;
            action: OpsCommand["action"];
            target: string;
            result: unknown;
          }>(
            "select actor_id,action,target,result from public.ops_operations where operation_id=$1",
            [id],
          )
        ).rows[0];
        if (!row || row.actor_id !== actor)
          throw new OpsError("OPS_NOT_FOUND", 404);
        await authorize(
          client,
          actor,
          commandPermission(row.action),
          row.action === "community.review" ? row.target : "*",
        );
        await client.query("commit");
        return { operationId: id, result: row.result };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async job(actor, id) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const row = (
          await client.query<{ id: string; action: OpsCommand["action"] }>(
            "select id,action,target,state,attempts,result,input_hash,evidence,created_at,completed_at from public.ops_jobs where id=$1 and actor_id=$2",
            [z.uuid().parse(id), actor],
          )
        ).rows[0];
        if (!row) throw new OpsError("OPS_NOT_FOUND", 404);
        await authorize(client, actor, commandPermission(row.action));
        await client.query("commit");
        return row;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
    async runJob(actor, id, runtime) {
      const client = await pool.connect();
      let executionStarted = false;
      try {
        await client.query("begin");
        const row = (
          await client.query<{
            id: string;
            actor_id: string;
            action: OpsCommand["action"];
            target: string;
            payload: Record<string, unknown>;
            state: string;
            attempts: number;
            result: unknown;
          }>(
            "select * from public.ops_jobs where id=$1 and actor_id=$2 for update nowait",
            [z.uuid().parse(id), actor],
          )
        ).rows[0];
        if (!row) throw new OpsError("OPS_NOT_FOUND", 404);
        try {
          await authorize(client, actor, commandPermission(row.action));
        } catch (error) {
          await client.query(
            "update public.ops_jobs set state='held',result=jsonb_build_object('code','OPS_FORBIDDEN') where id=$1 and state='queued'",
            [id],
          );
          await client.query(
            "insert into public.ops_audit(operation_id,actor_id,action,target,reason,outcome,code) values($1::uuid,$2,'mining.job.run',$1::uuid::text,'任务授权已撤回','rejected','OPS_FORBIDDEN')",
            [id, actor],
          );
          await client.query("commit");
          throw error;
        }
        if (row.state === "complete") {
          await client.query("commit");
          return { id, state: row.state, result: row.result };
        }
        if (row.state !== "queued" || row.attempts >= 3)
          throw new OpsError("OPS_JOB_HELD");
        if (row.action === "mining.snapshot")
          await client.query(
            "select pg_advisory_xact_lock(hashtextextended('loop:mining:formula-publication',0))",
          );
        executionStarted = true;
        const output = await runOpsMiningJob(
          opsTransactionPool(pool, client),
          row,
          runtime,
        );
        await client.query(
          "update public.ops_jobs set state='complete',attempts=attempts+1,result=$2,evidence=$3,input_hash=$4,completed_at=clock_timestamp() where id=$1",
          [
            id,
            JSON.stringify(output.result),
            JSON.stringify(output.evidence),
            output.inputHash,
          ],
        );
        await client.query(
          "insert into public.ops_audit(operation_id,actor_id,action,target,reason,outcome) values($1::uuid,$2,'mining.job.run',$1::uuid::text,'执行挖矿任务','succeeded')",
          [id, actor],
        );
        await client.query("commit");
        return {
          id,
          state: "complete",
          result: output.result,
          inputHash: output.inputHash,
        };
      } catch (error) {
        await client.query("rollback").catch(() => {});
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "55P03"
        )
          throw new OpsError("OPS_JOB_BUSY");
        if (executionStarted)
          await client
            .query(
              "update public.ops_jobs set attempts=attempts+1,state=case when attempts>=2 then 'held' else state end,result=jsonb_build_object('code',$3::text) where id=$1 and actor_id=$2 and state='queued'",
              [
                id,
                actor,
                error instanceof OpsError ? error.code : "OPS_JOB_FAILED",
              ],
            )
            .catch(() => {});
        await client
          .query(
            "insert into public.ops_audit(operation_id,actor_id,action,target,reason,outcome,code) select $1::uuid,$2,'mining.job.run',$1::uuid::text,'任务未完成','rejected',$3 where exists(select 1 from public.ops_jobs where id=$1 and actor_id=$2)",
            [
              id,
              actor,
              error instanceof OpsError ? error.code : "OPS_JOB_FAILED",
            ],
          )
          .catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async execute(actor, command) {
      const client = await pool.connect();
      const hash = opsHash(command);
      try {
        await client.query("begin");
        await client.query("set local lock_timeout='3s'");
        await authorize(
          client,
          actor,
          commandPermission(command.action),
          command.action === "community.review" ? command.target : "*",
        );
        await client.query(
          "select pg_advisory_xact_lock(hashtextextended($1,0))",
          [`ops:${command.operationId}`],
        );
        const existing = (
          await client.query<{
            actor_id: string;
            request_hash: string;
            result: unknown;
          }>(
            "select actor_id,request_hash,result from public.ops_operations where operation_id=$1",
            [command.operationId],
          )
        ).rows[0];
        if (existing) {
          if (existing.actor_id !== actor || existing.request_hash !== hash)
            throw new OpsError("OPS_IDEMPOTENCY_CONFLICT");
          await client.query("commit");
          return {
            operationId: command.operationId,
            result: existing.result,
            replayed: true,
          };
        }
        const txPool = opsTransactionPool(pool, client);
        let result: unknown;
        if (
          command.action === "mining.snapshot" ||
          command.action === "mining.trial"
        ) {
          const jobId = randomUUID();
          await client.query(
            "insert into public.ops_jobs(id,actor_id,action,target,payload) values($1,$2,$3,$4,$5)",
            [
              jobId,
              actor,
              command.action,
              command.target,
              JSON.stringify(command.payload),
            ],
          );
          result = { jobId, state: "queued" };
        } else if (command.action === "mining.create") {
          z.uuid().parse(command.target);
          const pkg = command.payload;
          await validatePackage(client, pkg);
          result = (
            await client.query(
              "insert into public.ops_mining_drafts(id,package,content_hash,editor_id,contributors,reason) values($1,$2,$3,$4,$5,$6) returning *",
              [
                command.target,
                JSON.stringify(pkg),
                opsHash(pkg),
                actor,
                [actor],
                command.reason,
              ],
            )
          ).rows[0];
        } else if (
          command.action === "mining.revise" ||
          command.action === "mining.submit" ||
          command.action === "mining.publish"
        ) {
          const draft = await loadDraft(client, command.target);
          if (
            draft.state === "published" ||
            draft.revision !== command.payload.expectedRevision
          )
            throw new OpsError("OPS_VERSION_CONFLICT");
          if (command.action === "mining.revise") {
            const pkg = command.payload.package;
            await validatePackage(client, pkg);
            result = (
              await client.query(
                "update public.ops_mining_drafts set package=$2,content_hash=$3,editor_id=$4,contributors=array(select distinct unnest(contributors || $4::uuid)),state='draft',revision=revision+1,reason=$5,updated_at=clock_timestamp() where id=$1 returning *",
                [
                  draft.id,
                  JSON.stringify(pkg),
                  opsHash(pkg),
                  actor,
                  command.reason,
                ],
              )
            ).rows[0];
          } else if (command.action === "mining.submit") {
            if (draft.state !== "draft")
              throw new OpsError("OPS_STATE_CONFLICT");
            await validatePackage(
              client,
              miningPackageSchema.parse(draft.package),
            );
            result = (
              await client.query(
                "update public.ops_mining_drafts set state='review',revision=revision+1,updated_at=clock_timestamp() where id=$1 returning *",
                [draft.id],
              )
            ).rows[0];
          } else {
            if (
              draft.state !== "review" ||
              draft.content_hash !== command.payload.contentHash
            )
              throw new OpsError("OPS_VERSION_CONFLICT");
            if (draft.contributors.includes(actor))
              throw new OpsError("OPS_SELF_APPROVAL", 403);
            const pkg = miningPackageSchema.parse(draft.package);
            await client.query<Record<string, unknown>>(
              "select pg_advisory_xact_lock(hashtextextended('loop:mining:formula-publication',0))",
            );
            await validatePackage(client, pkg);
            const mining = createPostgresMiningRepository(txPool);
            const active = await mining.getApprovedFormula();
            if (
              (active?.configVersion ?? null) !==
              command.payload.expectedActiveVersion
            )
              throw new OpsError("OPS_ACTIVE_VERSION_CONFLICT");
            await mining.createFormulaVersion({
              ...pkg,
              requestId: command.operationId,
            });
            for (const weight of pkg.communityWeights)
              await mining.setCommunityWeight({
                ...weight,
                configVersion: pkg.configVersion,
                requestId: command.operationId,
              });
            await mining.approveFormula({
              configVersion: pkg.configVersion,
              requestId: command.operationId,
            });
            result = (
              await client.query(
                "update public.ops_mining_drafts set state='published',approver_id=$2,revision=revision+1,updated_at=clock_timestamp() where id=$1 returning *",
                [draft.id, actor],
              )
            ).rows[0];
          }
        } else if (command.action === "community.review") {
          z.uuid().parse(command.target);
          const current = (
            await client.query<{ record_version: number }>(
              "select record_version from public.communities where community_id=$1 for update",
              [command.target],
            )
          ).rows[0];
          if (!current) throw new OpsError("OPS_NOT_FOUND", 404);
          if (current.record_version !== command.payload.expectedVersion)
            throw new OpsError("OPS_VERSION_CONFLICT");
          const repository = createPostgresCommunityRepository(
            txPool,
            options.communityMemberCap === undefined
              ? {}
              : { communityChannelMemberCap: options.communityMemberCap },
          );
          const input = {
            communityId: command.target,
            requestId: command.operationId,
            reasonCode: "OPS_REVIEW",
          };
          const review =
            command.payload.outcome === "verified"
              ? await repository.verifyCommunity(input)
              : await repository.rejectCommunity({
                  ...input,
                  reason: command.reason,
                });
          // In-app notification joins the same transaction; no best-effort loss.
          if (review.changed && review.eventId && review.ownerUserId)
            await createPostgresNotificationRepository(txPool).record(
              communityApplicationNotification({
                ownerUserId: review.ownerUserId,
                community: review.community,
                outcome: command.payload.outcome,
                eventId: review.eventId,
              }),
            );
          result = {
            community: review.community,
            changed: review.changed,
            notification: review.changed ? "recorded" : "unchanged",
            push: "not_requested",
          };
        } else if (command.action === "support.answer") {
          result = await createPostgresSupportTicketRepository(txPool).advance({
            ticketId: z.uuid().parse(command.target),
            eventType: command.payload.status,
            note: command.payload.note,
            requestId: command.operationId,
          });
        } else {
          result = await createPostgresMiningRepository(
            txPool,
          ).invalidateSnapshots({
            selector: { kind: "ids", snapshotIds: command.payload.snapshotIds },
            reason: "OPS_INVALIDATED",
            requestId: command.operationId,
          });
        }
        await client.query(
          "insert into public.ops_operations(operation_id,actor_id,action,target,request_hash,result) values($1,$2,$3,$4,$5,$6)",
          [
            command.operationId,
            actor,
            command.action,
            command.target,
            hash,
            JSON.stringify(result),
          ],
        );
        await client.query(
          "insert into public.ops_audit(operation_id,actor_id,action,target,reason,outcome) values($1,$2,$3,$4,$5,'succeeded')",
          [
            command.operationId,
            actor,
            command.action,
            command.target,
            command.reason,
          ],
        );
        await client.query("commit");
        return { operationId: command.operationId, result, replayed: false };
      } catch (error) {
        await client.query("rollback").catch(() => {});
        const code =
          error instanceof OpsError ? error.code : "OPS_COMMAND_FAILED";
        // No request payload, token, or provider response enters failure audit.
        await client
          .query(
            "insert into public.ops_audit(operation_id,actor_id,action,target,reason,outcome,code) values($1,$2,$3,$4,$5,$6,$7)",
            [
              command.operationId,
              actor,
              command.action,
              command.target,
              command.reason,
              error instanceof OpsError ? "rejected" : "unknown",
              code,
            ],
          )
          .catch(() => {});
        throw error instanceof OpsError ? error : new OpsError(code, 503);
      } finally {
        client.release();
      }
    },
  };
}
function page(rows: Record<string, unknown>[], key: string) {
  return {
    items: rows.slice(0, 50),
    nextCursor: rows.length > 50 ? String(rows[49]?.[key]) : null,
  };
}
