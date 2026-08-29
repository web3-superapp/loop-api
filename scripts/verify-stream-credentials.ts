import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { StreamClient } from "@stream-io/node-sdk";

const STREAM_PROBE_TIMEOUT_MS = 5_000;

export type StreamCredentialVerificationErrorCode =
  | "stream_credentials_unconfigured"
  | "stream_credentials_incomplete"
  | "stream_credentials_invalid"
  | "stream_credentials_rejected"
  | "stream_verification_arguments_invalid"
  | "stream_verification_failed";

interface StreamCredentials {
  readonly apiKey: string;
  readonly apiSecret: string;
}

export interface StreamCredentialProbe {
  readonly getApp: () => Promise<{
    readonly app: unknown;
    readonly metadata: Readonly<{ responseCode: number }>;
  }>;
}

export type CreateStreamCredentialProbe = (
  credentials: StreamCredentials,
) => StreamCredentialProbe;

interface OutputWriter {
  readonly write: (contents: string) => unknown;
}

export interface RunStreamCredentialVerificationOptions {
  readonly argv: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly stdout: OutputWriter;
  readonly stderr: OutputWriter;
  readonly createProbe?: CreateStreamCredentialProbe;
}

export class StreamCredentialVerificationError extends Error {
  constructor(readonly code: StreamCredentialVerificationErrorCode) {
    super("Stream credential verification failed");
    this.name = "StreamCredentialVerificationError";
  }
}

function configuredValue(
  environment: NodeJS.ProcessEnv,
  name: "STREAM_API_KEY" | "STREAM_API_SECRET",
): string | undefined {
  const rawValue = environment[name];
  if (rawValue === undefined || rawValue.trim() === "") {
    return undefined;
  }

  return name === "STREAM_API_KEY" ? rawValue.trim() : rawValue;
}

function readStreamCredentials(
  environment: NodeJS.ProcessEnv,
): StreamCredentials {
  const apiKey = configuredValue(environment, "STREAM_API_KEY");
  const apiSecret = configuredValue(environment, "STREAM_API_SECRET");

  if (apiKey === undefined && apiSecret === undefined) {
    throw new StreamCredentialVerificationError(
      "stream_credentials_unconfigured",
    );
  }

  if (apiKey === undefined || apiSecret === undefined) {
    throw new StreamCredentialVerificationError(
      "stream_credentials_incomplete",
    );
  }

  if (apiKey.length > 255 || apiSecret.length > 4_096) {
    throw new StreamCredentialVerificationError("stream_credentials_invalid");
  }

  return Object.freeze({ apiKey, apiSecret });
}

function createOfficialProbe(
  credentials: StreamCredentials,
): StreamCredentialProbe {
  return new StreamClient(credentials.apiKey, credentials.apiSecret, {
    timeout: STREAM_PROBE_TIMEOUT_MS,
  });
}

/**
 * Performs one authenticated, read-only Stream App lookup. A successful lookup
 * proves that the configured key and secret form an accepted credential pair;
 * neither credentials nor provider response fields leave this boundary.
 */
export async function verifyStreamCredentials(
  environment: NodeJS.ProcessEnv,
  createProbe: CreateStreamCredentialProbe = createOfficialProbe,
): Promise<void> {
  const credentials = readStreamCredentials(environment);

  try {
    const response = await createProbe(credentials).getApp();
    if (
      response.metadata.responseCode !== 200 ||
      typeof response.app !== "object" ||
      response.app === null
    ) {
      throw new StreamCredentialVerificationError(
        "stream_credentials_rejected",
      );
    }
  } catch {
    throw new StreamCredentialVerificationError("stream_credentials_rejected");
  }
}

export async function runStreamCredentialVerification(
  options: RunStreamCredentialVerificationOptions,
): Promise<number> {
  if (options.argv.length !== 2) {
    options.stderr.write(
      "Stream credential verification failed (stream_verification_arguments_invalid)\n",
    );
    return 1;
  }

  try {
    await verifyStreamCredentials(options.environment, options.createProbe);
    options.stdout.write("Stream credential verification passed\n");
    return 0;
  } catch (error) {
    const code =
      error instanceof StreamCredentialVerificationError
        ? error.code
        : "stream_verification_failed";
    options.stderr.write(`Stream credential verification failed (${code})\n`);
    return 1;
  }
}

const directEntryPoint = process.argv[1];

if (
  directEntryPoint !== undefined &&
  resolve(directEntryPoint) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runStreamCredentialVerification({
    argv: process.argv,
    environment: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
