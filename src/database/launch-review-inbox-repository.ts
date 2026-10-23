import type { PoolClient } from "pg";

import {
  launchDeployFailedNotification,
  launchReviewApprovedNotification,
  launchReviewRejectedNotification,
} from "../features/notifications/launch-review-inbox-contract.js";
import { insertNotificationRow } from "./notification-repository.js";

/**
 * Decision 0178: in-transaction writers of the project owner's launch
 * review / deployment progress notifications. Each runs inside the
 * transaction that makes the state change (the review command, the
 * executor's `failed` transition), so the row exists exactly when the
 * change commits; the dedupe key makes a repeat a no-op. The rows are
 * always written; `LAUNCH_REVIEW_INBOX_EMIT` only gates reads and push.
 */

type Client = Pick<PoolClient, "query">;

interface ProjectFacts {
  readonly ownerUserId: string;
  readonly name: string;
  readonly ticker: string | null;
  readonly at: string;
}

async function readProject(
  client: Client,
  projectId: string,
): Promise<ProjectFacts | null> {
  const result = await client.query<{
    owner_user_id: string;
    name: string;
    ticker: string | null;
    at: Date;
  }>(
    `select owner_user_id::text, name, ticker, clock_timestamp() as at
     from public.launch_projects where project_id = $1`,
    [projectId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    ownerUserId: row.owner_user_id,
    name: row.name,
    ticker: row.ticker,
    at: row.at.toISOString(),
  };
}

/** A config version was approved: the owner can now sign the deployment. */
export async function recordLaunchReviewApprovedNotification(
  client: Client,
  input: { readonly projectId: string; readonly configVersion: number },
): Promise<string | null> {
  const project = await readProject(client, input.projectId);
  if (project === null) return null;
  return insertNotificationRow(
    client,
    launchReviewApprovedNotification({
      ownerUserId: project.ownerUserId,
      projectId: input.projectId,
      projectName: project.name,
      symbol: project.ticker,
      configVersion: input.configVersion,
      approvedAt: project.at,
    }),
  );
}

/** The catalog material or a config version was rejected. */
export async function recordLaunchReviewRejectedNotification(
  client: Client,
  input: {
    readonly projectId: string;
    readonly decision:
      | { readonly kind: "material"; readonly rejectionId: string }
      | { readonly kind: "config"; readonly configVersion: number };
    readonly reasonCode: string;
    readonly note: string | null;
  },
): Promise<string | null> {
  const project = await readProject(client, input.projectId);
  if (project === null) return null;
  return insertNotificationRow(
    client,
    launchReviewRejectedNotification({
      ownerUserId: project.ownerUserId,
      projectId: input.projectId,
      projectName: project.name,
      symbol: project.ticker,
      decision: input.decision,
      reasonCode: input.reasonCode,
      note: input.note,
      rejectedAt: project.at,
    }),
  );
}

/**
 * A deployment task reached a final (non-retryable) `failed`. The project
 * name is the signed config's (what the owner launched), else the catalog
 * name.
 */
export async function recordLaunchDeployFailedNotification(
  client: Client,
  input: { readonly jobId: string },
): Promise<string | null> {
  const result = await client.query<{
    project_id: string;
    owner_user_id: string;
    name: string;
    ticker: string | null;
    failure_code: string | null;
    at: Date;
  }>(
    `select t.project_id::text, p.owner_user_id::text,
       coalesce(nullif(v.config ->> 'name', ''), p.name) as name,
       coalesce(nullif(v.config ->> 'ticker', ''), p.ticker) as ticker,
       t.failure_code, clock_timestamp() as at
     from public.hooks_launch_deployment_tasks t
     join public.launch_projects p on p.project_id = t.project_id
     left join public.hooks_launch_project_config_versions v
       on v.project_id = t.project_id and v.config_version = t.config_version
     where t.job_id = $1`,
    [input.jobId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return insertNotificationRow(
    client,
    launchDeployFailedNotification({
      ownerUserId: row.owner_user_id,
      projectId: row.project_id,
      jobId: input.jobId,
      projectName: row.name,
      symbol: row.ticker,
      failureCode: row.failure_code,
      failedAt: row.at.toISOString(),
    }),
  );
}
