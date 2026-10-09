import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import {
  createPostgresCommunityRepository,
  listVerifiedCommunitiesWithoutChannel,
  type CommunityMissingChannelRecord,
} from "../src/database/community-repository.js";
import type {
  CommunityRecord,
  CommunityRepository,
} from "../src/features/community/community-repository.js";

/**
 * Dev-only operator repair: allocate the official Stream channel for every
 * verified community that has none (Decision 0050).
 *
 * A community written outside the product write path (the seed) is verified
 * but never passed through `verifyCommunity`, which is the only place the
 * channel row is allocated and the per-member `add` jobs are enqueued. This
 * script re-drives exactly that path: `repository.verifyCommunity` on an
 * already verified community runs the `repair` branch, which allocates the
 * channel row, enqueues one `add` job per non-banned member that is not yet
 * `synced`, and touches nothing else. The Stream writes themselves are still
 * performed by the `community-channel-sync` worker lane after commit. Nothing
 * here writes `community_channels` directly.
 *
 * Communities that already have a channel are not candidates, so re-running
 * is a no-op. Refuses `NODE_ENV=production` before opening a connection.
 */

export type CommunityProvisionChannelsErrorCode =
  | "community_provision_channels_arguments_invalid"
  | "community_provision_channels_confirmation_required"
  | "community_provision_channels_database_unconfigured"
  | "community_provision_channels_forbidden_in_production"
  | "community_provision_channels_failed";

const reasonCode = "operator_channel_provision";

interface OutputWriter {
  readonly write: (contents: string) => unknown;
}

export type CreateCommunityProvisionChannelsDependencies = (
  databaseUrl: string,
) => {
  readonly repository: CommunityRepository;
  readonly listCandidates: () => Promise<
    readonly CommunityMissingChannelRecord[]
  >;
  readonly close: () => Promise<void>;
};

export interface RunCommunityProvisionChannelsOptions {
  readonly argv: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly stdout: OutputWriter;
  readonly stderr: OutputWriter;
  readonly createDependencies?: CreateCommunityProvisionChannelsDependencies;
}

export class CommunityProvisionChannelsError extends Error {
  constructor(readonly code: CommunityProvisionChannelsErrorCode) {
    super("Community channel provisioning failed");
    this.name = "CommunityProvisionChannelsError";
  }
}

function defaultCreateDependencies(
  databaseUrl: string,
): ReturnType<CreateCommunityProvisionChannelsDependencies> {
  const pool = new pg.Pool({
    application_name: "loop-api-community-provision-channels",
    connectionString: databaseUrl,
    max: 1,
  });
  return {
    repository: createPostgresCommunityRepository(pool),
    listCandidates: () => listVerifiedCommunitiesWithoutChannel(pool),
    close: () => pool.end(),
  };
}

export interface CommunityProvisionChannelsRequest {
  readonly databaseUrl: string;
}

export function parseCommunityProvisionChannelsRequest(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
): CommunityProvisionChannelsRequest {
  if (environment["NODE_ENV"]?.trim() === "production") {
    throw new CommunityProvisionChannelsError(
      "community_provision_channels_forbidden_in_production",
    );
  }
  const args = argv.slice(2);
  if (args.some((arg) => arg !== "--confirm")) {
    throw new CommunityProvisionChannelsError(
      "community_provision_channels_arguments_invalid",
    );
  }
  if (!args.includes("--confirm")) {
    throw new CommunityProvisionChannelsError(
      "community_provision_channels_confirmation_required",
    );
  }
  const databaseUrl = environment["DATABASE_URL"]?.trim();
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new CommunityProvisionChannelsError(
      "community_provision_channels_database_unconfigured",
    );
  }
  return Object.freeze({ databaseUrl });
}

export interface CommunityProvisionChannelsResult {
  readonly candidates: readonly CommunityMissingChannelRecord[];
  readonly provisioned: readonly CommunityRecord[];
  readonly failed: readonly {
    readonly communityId: string;
    readonly slug: string;
  }[];
}

export async function provisionMissingCommunityChannels(
  request: CommunityProvisionChannelsRequest,
  createDependencies: CreateCommunityProvisionChannelsDependencies = defaultCreateDependencies,
): Promise<CommunityProvisionChannelsResult> {
  const { repository, listCandidates, close } = createDependencies(
    request.databaseUrl,
  );
  try {
    const candidates = await listCandidates();
    const provisioned: CommunityRecord[] = [];
    const failed: { communityId: string; slug: string }[] = [];
    for (const candidate of candidates) {
      try {
        provisioned.push(
          (
            await repository.verifyCommunity({
              communityId: candidate.communityId,
              requestId: randomUUID(),
              reasonCode,
            })
          ).community,
        );
      } catch {
        // One refused community must not stop the rest; it is reported and
        // stays a candidate for the next run.
        failed.push({
          communityId: candidate.communityId,
          slug: candidate.slug,
        });
      }
    }
    return Object.freeze({
      candidates,
      provisioned: Object.freeze(provisioned),
      failed: Object.freeze(failed),
    });
  } finally {
    await close();
  }
}

export async function runCommunityProvisionChannels(
  options: RunCommunityProvisionChannelsOptions,
): Promise<0 | 1> {
  let request: CommunityProvisionChannelsRequest;
  try {
    request = parseCommunityProvisionChannelsRequest(
      options.argv,
      options.environment,
    );
  } catch (error) {
    const code =
      error instanceof CommunityProvisionChannelsError
        ? error.code
        : "community_provision_channels_failed";
    options.stderr.write(`Community channel provisioning refused (${code})\n`);
    return 1;
  }

  try {
    const result = await provisionMissingCommunityChannels(
      request,
      options.createDependencies,
    );
    if (result.candidates.length === 0) {
      options.stdout.write(
        "Every verified community already has an official channel; nothing to provision\n",
      );
      return 0;
    }
    for (const record of result.provisioned) {
      options.stdout.write(
        `Channel provisioning enqueued for ${record.communityId} (slug ${record.slug}, members ${String(record.memberCount)})\n`,
      );
    }
    for (const failure of result.failed) {
      options.stderr.write(
        `Channel provisioning failed for ${failure.communityId} (slug ${failure.slug})\n`,
      );
    }
    options.stdout.write(
      `Provisioned ${String(result.provisioned.length)} of ${String(result.candidates.length)} candidate communities; the community-channel-sync lane performs the Stream writes\n`,
    );
    return result.failed.length === 0 ? 0 : 1;
  } catch {
    options.stderr.write(
      "Community channel provisioning failed (community_provision_channels_failed)\n",
    );
    return 1;
  }
}

const directEntryPoint = process.argv[1];

if (
  directEntryPoint !== undefined &&
  resolve(directEntryPoint) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runCommunityProvisionChannels({
    argv: process.argv,
    environment: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
