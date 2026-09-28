import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  computePinGrantChanges,
  createStreamChannelTypeClient,
  formatPinGrantChanges,
  LOOP_CHAT_STREAM_CHANNEL_TYPE,
  rolesWithCollateralGrantChanges,
  type StreamChannelTypeClient,
} from "../src/integrations/stream/channel-type-grants.js";
import { readStreamCredentials } from "./stream-channel-type-audit.js";

/**
 * Operator script (Decision 0091): restrict message pinning in the LOOP chat
 * channel type (`messaging`) to the `channel_moderator` and `admin` roles.
 *
 * - default / `--dry-run`: reads the channel type and the permission catalog
 *   and prints the per-role diff. Nothing is written.
 * - `--apply`: sends exactly the changed roles (each with its complete next
 *   grant list) in one `updateChannelType`, then re-reads the channel type
 *   and fails unless the diff is empty and no grant other than pin/unpin
 *   of any role changed.
 *
 * `--channel-type <name>` targets another type (default `messaging`).
 *
 * The `messaging` type also carries LOOP friend-group and direct channels
 * (Decision 0025); `--apply` removes pinning from their members too.
 */

export type StreamChannelTypeGrantsErrorCode =
  | "stream_channel_type_grants_arguments_invalid"
  | "stream_channel_type_grants_stream_unconfigured"
  | "stream_channel_type_grants_failed"
  | "stream_channel_type_grants_not_converged"
  | "stream_channel_type_grants_collateral_change";

interface OutputWriter {
  readonly write: (contents: string) => unknown;
}

export interface StreamChannelTypeGrantsRequest {
  readonly mode: "dry-run" | "apply";
  readonly channelType: string;
}

export interface RunStreamChannelTypeGrantsOptions {
  readonly argv: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly stdout: OutputWriter;
  readonly stderr: OutputWriter;
  readonly createClient?: (credentials: {
    readonly apiKey: string;
    readonly apiSecret: string;
  }) => StreamChannelTypeClient;
}

const channelTypeNamePattern = /^[a-z0-9_-]{1,64}$/;

export function parseStreamChannelTypeGrantsArguments(
  argv: readonly string[],
): StreamChannelTypeGrantsRequest | null {
  const args = argv.slice(2);
  let mode: "dry-run" | "apply" | null = null;
  let channelType = LOOP_CHAT_STREAM_CHANNEL_TYPE;
  let channelTypeSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run" || arg === "--apply") {
      const next = arg === "--apply" ? "apply" : "dry-run";
      if (mode !== null) {
        return null;
      }
      mode = next;
      continue;
    }
    if (arg === "--channel-type" && !channelTypeSeen) {
      const value = args[index + 1];
      if (value === undefined || !channelTypeNamePattern.test(value)) {
        return null;
      }
      channelType = value;
      channelTypeSeen = true;
      index += 1;
      continue;
    }
    return null;
  }
  return Object.freeze({ mode: mode ?? "dry-run", channelType });
}

export async function runStreamChannelTypeGrants(
  options: RunStreamChannelTypeGrantsOptions,
): Promise<0 | 1> {
  const request = parseStreamChannelTypeGrantsArguments(options.argv);
  if (request === null) {
    options.stderr.write(
      "Stream channel type grants refused (stream_channel_type_grants_arguments_invalid)\n",
    );
    return 1;
  }
  const credentials = readStreamCredentials(options.environment);
  if (credentials === null) {
    options.stderr.write(
      "Stream channel type grants refused (stream_channel_type_grants_stream_unconfigured)\n",
    );
    return 1;
  }
  const client = (options.createClient ?? createStreamChannelTypeClient)(
    credentials,
  );
  try {
    const [snapshot, permissions] = await Promise.all([
      client.getChannelType(request.channelType),
      client.listPermissions(),
    ]);
    const changes = computePinGrantChanges(snapshot, permissions);
    options.stdout.write(formatPinGrantChanges(snapshot.name, changes));
    if (request.mode === "dry-run") {
      if (changes.length > 0) {
        options.stdout.write("Dry run: nothing written; rerun with --apply\n");
      }
      return 0;
    }
    if (changes.length === 0) {
      return 0;
    }
    await client.updateChannelTypeGrants(
      snapshot,
      Object.fromEntries(changes.map((change) => [change.role, change.next])),
    );
    const after = await client.getChannelType(request.channelType);
    const remaining = computePinGrantChanges(after, permissions);
    if (remaining.length > 0) {
      options.stderr.write(
        formatPinGrantChanges(after.name, remaining) +
          "Stream channel type grants not converged (stream_channel_type_grants_not_converged)\n",
      );
      return 1;
    }
    const collateral = rolesWithCollateralGrantChanges(
      snapshot,
      after,
      permissions,
    );
    if (collateral.length > 0) {
      options.stderr.write(
        `Grants outside pin/unpin changed for: ${collateral.join(", ")}\n` +
          "Stream channel type grants changed more than pinning (stream_channel_type_grants_collateral_change)\n",
      );
      return 1;
    }
    options.stdout.write(
      `Applied: ${String(changes.length)} role(s) updated and re-read\n`,
    );
    return 0;
  } catch {
    options.stderr.write(
      "Stream channel type grants failed (stream_channel_type_grants_failed)\n",
    );
    return 1;
  }
}

const directEntryPoint = process.argv[1];

if (
  directEntryPoint !== undefined &&
  resolve(directEntryPoint) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runStreamChannelTypeGrants({
    argv: process.argv,
    environment: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
