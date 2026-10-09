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
