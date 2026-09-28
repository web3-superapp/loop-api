import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  auditChannelType,
  createStreamChannelTypeClient,
  formatChannelTypeAudit,
  LOOP_CHAT_STREAM_CHANNEL_TYPE,
  type StreamChannelTypeClient,
} from "../src/integrations/stream/channel-type-grants.js";

/**
 * Read-only Stream audit (Decision 0091). Prints, for the channel type every
 * LOOP chat channel uses (`messaging`), which roles hold the permissions
 * behind `PinMessage`, `UnpinMessage`, `DeleteAnyMessage`, and
 * `UpdateAnyMessage`.
 *
 * Only `getChannelType` and `listPermissions` are called; nothing is
 * written. No credential or provider response field other than role names
 * and permission IDs is printed.
 *
 * Usage: `pnpm stream:channel-type-audit [--channel-type <name>]`
 */

export type StreamChannelTypeAuditErrorCode =
  | "stream_channel_type_audit_arguments_invalid"
  | "stream_channel_type_audit_stream_unconfigured"
  | "stream_channel_type_audit_failed";

interface OutputWriter {
  readonly write: (contents: string) => unknown;
}

export interface RunStreamChannelTypeAuditOptions {
  readonly argv: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly stdout: OutputWriter;
  readonly stderr: OutputWriter;
  readonly createClient?: (credentials: {
    readonly apiKey: string;
    readonly apiSecret: string;
  }) => Pick<StreamChannelTypeClient, "getChannelType" | "listPermissions">;
}

const channelTypeNamePattern = /^[a-z0-9_-]{1,64}$/;

export function parseStreamChannelTypeAuditArguments(
  argv: readonly string[],
): { readonly channelType: string } | null {
  const args = argv.slice(2);
  if (args.length === 0) {
    return { channelType: LOOP_CHAT_STREAM_CHANNEL_TYPE };
  }
  if (
    args.length === 2 &&
    args[0] === "--channel-type" &&
    channelTypeNamePattern.test(args[1] ?? "")
  ) {
    return { channelType: args[1] as string };
  }
  return null;
}

export function readStreamCredentials(
  environment: NodeJS.ProcessEnv,
): { readonly apiKey: string; readonly apiSecret: string } | null {
  const apiKey = environment["STREAM_API_KEY"]?.trim();
  const apiSecret = environment["STREAM_API_SECRET"];
  if (
    apiKey === undefined ||
    apiKey === "" ||
    apiSecret === undefined ||
    apiSecret.trim() === ""
  ) {
    return null;
  }
  return Object.freeze({ apiKey, apiSecret });
}

export async function runStreamChannelTypeAudit(
  options: RunStreamChannelTypeAuditOptions,
): Promise<0 | 1> {
  const request = parseStreamChannelTypeAuditArguments(options.argv);
  if (request === null) {
    options.stderr.write(
      "Stream channel type audit refused (stream_channel_type_audit_arguments_invalid)\n",
    );
    return 1;
  }
  const credentials = readStreamCredentials(options.environment);
  if (credentials === null) {
    options.stderr.write(
      "Stream channel type audit refused (stream_channel_type_audit_stream_unconfigured)\n",
    );
    return 1;
  }
  try {
    const client = (options.createClient ?? createStreamChannelTypeClient)(
      credentials,
    );
    const [snapshot, permissions] = await Promise.all([
      client.getChannelType(request.channelType),
      client.listPermissions(),
    ]);
    options.stdout.write(
      formatChannelTypeAudit(auditChannelType(snapshot, permissions)),
    );
    return 0;
  } catch {
    options.stderr.write(
      "Stream channel type audit failed (stream_channel_type_audit_failed)\n",
    );
    return 1;
  }
}

const directEntryPoint = process.argv[1];

if (
  directEntryPoint !== undefined &&
  resolve(directEntryPoint) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runStreamChannelTypeAudit({
    argv: process.argv,
    environment: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
