import type { Pool } from "pg";
import { z } from "zod";

import type {
  HooksLaunchProjectConfigRecord,
  HooksLaunchProjectConfigRepository,
  SaveHooksLaunchProjectConfigInput,
} from "../features/launch/hooks-launch-project-config.js";
import {
  HooksLaunchProjectNotFoundError,
  HooksLaunchProjectVersionConflictError,
  hooksLaunchRejectionReasons,
  type HooksLaunchRejectionReason,
} from "../features/launch/hooks-launch-project-config.js";

const rowSchema = z
  .object({
    project_id: z.string().uuid(),
    owner_user_id: z.string().uuid(),
    config_version: z.number().int().positive(),
    template_version: z.literal("hooks_launch_v1"),
    config: z.record(z.string(), z.unknown()),
    updated_at: z.date(),
  })
  .strict();

function parseRow(row: unknown): HooksLaunchProjectConfigRecord {
  const value = rowSchema.parse(row);
  return Object.freeze({
    projectId: value.project_id,
    ownerUserId: value.owner_user_id,
    version: value.config_version,
    templateVersion: value.template_version,
    config: value.config as unknown as HooksLaunchProjectConfigRecord["config"],
    updatedAt: value.updated_at.toISOString(),
  });
}

export function createPostgresHooksLaunchProjectConfigRepository(
  pool: Pool,
): HooksLaunchProjectConfigRepository {
  return Object.freeze({
    async getOwnedDraft(input: {
      readonly projectId: string;
      readonly ownerUserId: string;
    }) {
      const result = await pool.query({
        text: `
          select c.project_id, c.owner_user_id, c.config_version,
                 c.template_version, c.config, c.created_at as updated_at
          from public.hooks_launch_project_config_versions c
          inner join public.launch_projects p
            on p.project_id = c.project_id and p.owner_user_id = c.owner_user_id
          where c.project_id = $1 and c.owner_user_id = $2
          order by c.config_version desc
          limit 1
        `,
        values: [input.projectId, input.ownerUserId],
      });
      const row: unknown = result.rows[0];
      return row === undefined ? null : parseRow(row);
    },
    async getOwnedProgress(input: {
      readonly projectId: string;
      readonly ownerUserId: string;
      readonly configVersion: number;
    }) {
      // Decision 0120: the approval counts only for the same version and
      // configHash (the submission gate's rule); the newest task is
      // owner-scoped like `GET hooks-deployments/{jobId}`.
      const result = await pool.query<{
        approved_at: Date | null;
        rejection: {
          reasonCode: string;
          note: string | null;
          at: string;
        } | null;
        latest_job_id: string | null;
      }>({
        text: `
          select
            (select a.approved_at
               from public.hooks_launch_project_config_versions c
               inner join public.hooks_launch_config_approvals a
                 on a.project_id = c.project_id
                and a.config_version = c.config_version
                and a.config_hash = c.config_hash
               where c.project_id = $1 and c.owner_user_id = $2
                 and c.config_version = $3) as approved_at,
            -- Decision 0122: a reviewer rejection of the same version / hash.
            (select jsonb_build_object('reasonCode', r.reason_code,
                 'note', r.note, 'at', r.rejected_at)
               from public.hooks_launch_project_config_versions c
               inner join public.hooks_launch_config_rejections r
                 on r.project_id = c.project_id
                and r.config_version = c.config_version
                and r.config_hash = c.config_hash
               where c.project_id = $1 and c.owner_user_id = $2
                 and c.config_version = $3) as rejection,
            (select t.job_id::text
               from public.hooks_launch_deployment_tasks t
               where t.project_id = $1 and t.owner_user_id = $2
               order by t.created_at desc, t.job_id desc
               limit 1) as latest_job_id
        `,
        values: [input.projectId, input.ownerUserId, input.configVersion],
      });
      const row = result.rows[0];
      const rejection = row?.rejection ?? null;
      return Object.freeze({
        approvedAt:
          row?.approved_at === null || row?.approved_at === undefined
            ? null
            : row.approved_at.toISOString(),
        rejection:
          rejection === null ||
          !(hooksLaunchRejectionReasons as readonly string[]).includes(
            rejection.reasonCode,
          )
            ? null
            : Object.freeze({
                reasonCode: rejection.reasonCode as HooksLaunchRejectionReason,
                note: rejection.note,
                at: new Date(rejection.at).toISOString(),
              }),
        latestJobId: row?.latest_job_id ?? null,
      });
    },
    async saveOwnedDraft(input: SaveHooksLaunchProjectConfigInput) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const project = await client.query({
          text: `
            select project_id from public.launch_projects
            where project_id = $1 and owner_user_id = $2
            for update
          `,
          values: [input.projectId, input.ownerUserId],
        });
        if (project.rowCount !== 1) throw new HooksLaunchProjectNotFoundError();

        const latest = await client.query<{ latest_version: number | null }>({
          text: `
            select max(config_version)::integer as latest_version
            from public.hooks_launch_project_config_versions
            where project_id = $1 and owner_user_id = $2
          `,
          values: [input.projectId, input.ownerUserId],
        });
        const currentVersion = latest.rows[0]?.latest_version ?? 0;
        if (currentVersion !== input.expectedVersion) {
          throw new HooksLaunchProjectVersionConflictError();
        }

        const inserted = await client.query({
          text: `
            insert into public.hooks_launch_project_config_versions (
              project_id, config_version, owner_user_id, template_version,
              config_hash, config
            ) values ($1, $2, $3, $4, $5, $6::jsonb)
            returning project_id, owner_user_id, config_version,
                      template_version, config, created_at as updated_at
          `,
          values: [
            input.projectId,
            input.expectedVersion + 1,
            input.ownerUserId,
            input.templateVersion,
            input.configHash,
            JSON.stringify(input.config),
          ],
        });
        await client.query("commit");
        return parseRow(inserted.rows[0]);
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
  });
}
