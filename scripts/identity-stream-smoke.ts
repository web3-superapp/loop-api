import { randomUUID } from "node:crypto";
import {
  Agent as HttpAgent,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request as httpRequest,
} from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { deriveStreamUserId } from "../src/features/identity/loop-identifiers.js";

const maximumAccessTokenLength = 8_192 - "Bearer ".length;
const maximumBaseUrlLength = 2_048;
const maximumResponseBytes = 32 * 1_024;
const requestTimeoutMilliseconds = 10_000;
const developmentOrigin = "https://api-dev.quant-dinger.cc";
const bearerTokenPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const jwtSegmentPattern = /^[A-Za-z0-9_-]+$/;
const streamUserIdPattern = /^loop_[a-z0-9_-]{8,58}$/;
const terminatingSignals = Object.freeze([
  "SIGHUP",
  "SIGINT",
  "SIGTERM",
] as const satisfies readonly NodeJS.Signals[]);

export type IdentityStreamSmokeEndpoint = "bootstrap" | "chat" | "video";

export type IdentityStreamSmokeFailureCode =
  | "bootstrap_http_error"
  | "bootstrap_identity_unstable"
  | "bootstrap_response_invalid"
  | "chat_http_error"
  | "chat_response_invalid"
  | "smoke_arguments_invalid"
  | "smoke_base_url_invalid"
  | "smoke_failed"
  | "smoke_request_failed"
  | "smoke_runtime_unsafe"
  | "stream_api_key_mismatch"
  | "stream_token_response_invalid"
  | "token_input_cancelled"
  | "token_input_failed"
  | "token_input_invalid"
  | "video_http_error"
  | "video_response_invalid";

export class IdentityStreamSmokeError extends Error {
  constructor(readonly code: IdentityStreamSmokeFailureCode) {
    super("Identity/Stream credential smoke failed");
    this.name = "IdentityStreamSmokeError";
  }
}

export interface IdentityStreamSmokeTransportInput {
  readonly endpoint: IdentityStreamSmokeEndpoint;
  readonly url: string;
  readonly accessToken: string;
}

export type IdentityStreamSmokeTransport = (
  input: IdentityStreamSmokeTransportInput,
) => Promise<unknown>;

interface OutputWriter {
  readonly write: (contents: string) => unknown;
}

export interface VerifyIdentityStreamInput {
  readonly accessToken: string;
  readonly baseUrl: string;
  readonly transport?: IdentityStreamSmokeTransport;
}

export interface RunIdentityStreamSmokeOptions {
  readonly argv: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly stdout: OutputWriter;
  readonly stderr: OutputWriter;
  readonly readAccessToken?: () => Promise<string>;
  readonly transport?: IdentityStreamSmokeTransport;
}

interface SignalEventSource {
  readonly off: (event: NodeJS.Signals, listener: () => void) => unknown;
  readonly once: (event: NodeJS.Signals, listener: () => void) => unknown;
}

const bootstrapResponseSchema = z
  .object({
    user: z.object({ id: z.string().uuid() }).strict(),
    stream_user_id: z.string().regex(streamUserIdPattern),
  })
  .strict();

const streamTokenResponseSchema = z
  .object({
    api_key: z.string().min(1).max(512),
    token: z.string().min(32).max(16_384),
    expires_at: z.string().max(64).datetime({ offset: true }),
    user: z.object({ id: z.string().regex(streamUserIdPattern) }).strict(),
  })
  .strict();

const safeEpochSecondsSchema = z
  .number()
  .int()
  .positive()
  .max(8_640_000_000_000)
  .refine(Number.isSafeInteger);

const streamJwtHeaderSchema = z
  .object({ alg: z.literal("HS256"), typ: z.literal("JWT") })
  .strict();

const streamJwtPayloadSchema = z
  .object({
    user_id: z.string().regex(streamUserIdPattern),
    iat: safeEpochSecondsSchema,
    exp: safeEpochSecondsSchema,
  })
  .strict();

const endpointPath: Readonly<Record<IdentityStreamSmokeEndpoint, string>> =
  Object.freeze({
    bootstrap: "/v1/bootstrap",
    chat: "/v1/chat/token",
    video: "/v1/video/token",
  });

const httpFailureCode: Readonly<
  Record<IdentityStreamSmokeEndpoint, IdentityStreamSmokeFailureCode>
> = Object.freeze({
  bootstrap: "bootstrap_http_error",
  chat: "chat_http_error",
  video: "video_http_error",
});

const responseFailureCode: Readonly<
  Record<IdentityStreamSmokeEndpoint, IdentityStreamSmokeFailureCode>
> = Object.freeze({
  bootstrap: "bootstrap_response_invalid",
  chat: "chat_response_invalid",
  video: "video_response_invalid",
});

function fail(code: IdentityStreamSmokeFailureCode): never {
  throw new IdentityStreamSmokeError(code);
}

function validateAccessToken(rawValue: string): string {
  if (
    rawValue.length === 0 ||
    rawValue.length > maximumAccessTokenLength ||
    !bearerTokenPattern.test(rawValue)
  ) {
    return fail("token_input_invalid");
  }

  return rawValue;
}

function normalizePipedAccessToken(rawValue: string): string {
  const withoutTerminalNewline = rawValue.endsWith("\r\n")
    ? rawValue.slice(0, -2)
    : rawValue.endsWith("\n")
      ? rawValue.slice(0, -1)
      : rawValue;
  return validateAccessToken(withoutTerminalNewline);
}

function parseBaseOrigin(rawValue: string | undefined): string {
  if (rawValue !== undefined && rawValue.length > maximumBaseUrlLength) {
    return fail("smoke_base_url_invalid");
  }

  let url: URL;

  try {
    url = new URL(rawValue ?? "http://127.0.0.1:3000");
  } catch {
    return fail("smoke_base_url_invalid");
  }

  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== "/"
  ) {
    return fail("smoke_base_url_invalid");
  }

  const isLiteralLoopback = new Set(["127.0.0.1", "[::1]"]).has(url.hostname);
  const isAllowedLoopback = isLiteralLoopback && url.protocol === "http:";
  const isAllowedDevelopmentOrigin = url.origin === developmentOrigin;

  if (!isAllowedLoopback && !isAllowedDevelopmentOrigin) {
    return fail("smoke_base_url_invalid");
  }

  return url.origin;
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Deliberately discard provider/body cancellation details.
  }
}

async function readBoundedJson(
  response: Response,
  endpoint: IdentityStreamSmokeEndpoint,
): Promise<unknown> {
  const invalidResponse = responseFailureCode[endpoint];
  const contentType = response.headers.get("content-type")?.toLowerCase();
  const cacheControl = response.headers.get("cache-control")?.toLowerCase();
  const contentEncoding = response.headers
    .get("content-encoding")
    ?.toLowerCase();
  const rawContentLength = response.headers.get("content-length");

  if (
    contentType === undefined ||
    !contentType.includes("application/json") ||
    cacheControl === undefined ||
    !cacheControl
      .split(",")
      .map((directive) => directive.trim())
      .includes("no-store") ||
    (contentEncoding !== undefined && contentEncoding !== "identity")
  ) {
    await discardResponseBody(response);
    return fail(invalidResponse);
  }

  if (rawContentLength !== null && /^\d+$/.test(rawContentLength)) {
    const contentLength = Number(rawContentLength);
    if (
      !Number.isSafeInteger(contentLength) ||
      contentLength > maximumResponseBytes
    ) {
      await discardResponseBody(response);
      return fail(invalidResponse);
    }
  }

  const reader = response.body?.getReader();
  if (reader === undefined) {
    return fail(invalidResponse);
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let responseComplete = false;

  try {
    while (!responseComplete) {
      const rawResult: unknown = await reader.read();
      if (
        typeof rawResult !== "object" ||
        rawResult === null ||
        Array.isArray(rawResult)
      ) {
        return fail(invalidResponse);
      }
      const descriptors = Object.getOwnPropertyDescriptors(rawResult);
      const done = descriptors["done"]?.value as unknown;
      const value = descriptors["value"]?.value as unknown;
      if (done === true) {
        responseComplete = true;
        continue;
      }
      if (done !== false || !(value instanceof Uint8Array)) {
        return fail(invalidResponse);
      }

      totalBytes += value.byteLength;
      if (totalBytes > maximumResponseBytes) {
        await reader.cancel();
        return fail(invalidResponse);
      }
      chunks.push(value);
    }
  } catch {
    return fail(invalidResponse);
  }

  let contents: string;
  try {
    const combined = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    contents = new TextDecoder("utf-8", { fatal: true }).decode(combined);
  } catch {
    return fail(invalidResponse);
  }

  try {
    return JSON.parse(contents) as unknown;
  } catch {
    return fail(invalidResponse);
  }
}

function validateEndpointTarget(input: IdentityStreamSmokeTransportInput): URL {
  let target: URL;
  try {
    target = new URL(input.url);
    const allowedOrigin = parseBaseOrigin(`${target.origin}/`);
    if (
      target.origin !== allowedOrigin ||
      target.username !== "" ||
      target.password !== "" ||
      target.pathname !== endpointPath[input.endpoint] ||
      target.search !== "" ||
      target.hash !== ""
    ) {
      return fail("smoke_base_url_invalid");
    }
  } catch (error) {
    if (error instanceof IdentityStreamSmokeError) {
      throw error;
    }
    return fail("smoke_base_url_invalid");
  }

  validateAccessToken(input.accessToken);
  return target;
}

function incomingHeader(
  headers: IncomingHttpHeaders,
  name:
    "cache-control" | "content-encoding" | "content-length" | "content-type",
): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) {
    return name === "cache-control" ? value.join(",") : undefined;
  }
  return value;
}

function hasNoStoreDirective(value: string | undefined): boolean {
  return (
    value
      ?.toLowerCase()
      .split(",")
      .map((directive) => directive.trim())
      .includes("no-store") ?? false
  );
}

function decodeJsonChunks(
  chunks: readonly Uint8Array[],
  endpoint: IdentityStreamSmokeEndpoint,
): unknown {
  const invalidResponse = responseFailureCode[endpoint];
  try {
    const combined = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    const contents = new TextDecoder("utf-8", { fatal: true }).decode(combined);
    return JSON.parse(contents) as unknown;
  } catch {
    return fail(invalidResponse);
  }
}

function readDirectResponseJson(
  response: IncomingMessage,
  endpoint: IdentityStreamSmokeEndpoint,
): Promise<unknown> {
  const invalidResponse = responseFailureCode[endpoint];
  const contentType = incomingHeader(
    response.headers,
    "content-type",
  )?.toLowerCase();
  const cacheControl = incomingHeader(response.headers, "cache-control");
  const contentEncoding = incomingHeader(
    response.headers,
    "content-encoding",
  )?.toLowerCase();
  const rawContentLength = incomingHeader(response.headers, "content-length");

  if (
    contentType === undefined ||
    !contentType.includes("application/json") ||
    !hasNoStoreDirective(cacheControl) ||
    (contentEncoding !== undefined && contentEncoding !== "identity")
  ) {
    response.destroy();
    return Promise.reject(new IdentityStreamSmokeError(invalidResponse));
  }

  if (rawContentLength !== undefined && /^\d+$/.test(rawContentLength)) {
    const contentLength = Number(rawContentLength);
    if (
      !Number.isSafeInteger(contentLength) ||
      contentLength > maximumResponseBytes
    ) {
      response.destroy();
      return Promise.reject(new IdentityStreamSmokeError(invalidResponse));
    }
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    let settled = false;

    const rejectInvalid = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      response.destroy();
      rejectPromise(new IdentityStreamSmokeError(invalidResponse));
    };

    response.on("data", (rawChunk: Buffer | string) => {
      if (settled) {
        return;
      }
      const chunk = Buffer.isBuffer(rawChunk)
        ? rawChunk
        : Buffer.from(rawChunk, "utf8");
      totalBytes += chunk.byteLength;
      if (totalBytes > maximumResponseBytes) {
        rejectInvalid();
        return;
      }
      chunks.push(chunk);
    });
    response.once("aborted", rejectInvalid);
    response.once("error", rejectInvalid);
    response.once("end", () => {
      if (settled) {
        return;
      }
      if (!response.complete) {
        rejectInvalid();
        return;
      }

      try {
        const value = decodeJsonChunks(chunks, endpoint);
        settled = true;
        resolvePromise(value);
      } catch {
        rejectInvalid();
      }
    });
  });
}

function createDirectIdentityStreamSmokeTransport(): IdentityStreamSmokeTransport {
  const httpAgent = new HttpAgent({ keepAlive: false, maxSockets: 1 });
  const httpsAgent = new HttpsAgent({ keepAlive: false, maxSockets: 1 });

  return async (input) => {
    const target = validateEndpointTarget(input);

    const requestFunction =
      target.protocol === "https:" ? httpsRequest : httpRequest;
    const agent = target.protocol === "https:" ? httpsAgent : httpAgent;
    const signal = AbortSignal.timeout(requestTimeoutMilliseconds);

    return new Promise((resolvePromise, rejectPromise) => {
      let request;
      try {
        request = requestFunction(
          target,
          {
            method: "POST",
            agent,
            headers: {
              accept: "application/json",
              "accept-encoding": "identity",
              authorization: `Bearer ${input.accessToken}`,
              "x-loop-smoke-request-id": randomUUID(),
            },
            signal,
          },
          (response) => {
            if (response.statusCode !== 200) {
              response.destroy();
              rejectPromise(
                new IdentityStreamSmokeError(httpFailureCode[input.endpoint]),
              );
              return;
            }

            void readDirectResponseJson(response, input.endpoint).then(
              resolvePromise,
              rejectPromise,
            );
          },
        );
      } catch {
        rejectPromise(new IdentityStreamSmokeError("smoke_request_failed"));
        return;
      }

      request.once("error", () => {
        rejectPromise(new IdentityStreamSmokeError("smoke_request_failed"));
      });
      request.end();
    });
  };
}

export function createIdentityStreamSmokeTransport(
  fetchImplementation?: typeof fetch,
): IdentityStreamSmokeTransport {
  if (fetchImplementation === undefined) {
    return createDirectIdentityStreamSmokeTransport();
  }

  return async (input) => {
    const target = validateEndpointTarget(input);
    let response: Response;

    try {
      response = await fetchImplementation(target.toString(), {
        method: "POST",
        headers: {
          accept: "application/json",
          "accept-encoding": "identity",
          authorization: `Bearer ${input.accessToken}`,
          "x-loop-smoke-request-id": randomUUID(),
        },
        redirect: "error",
        cache: "no-store",
        credentials: "omit",
        signal: AbortSignal.timeout(requestTimeoutMilliseconds),
      });
    } catch {
      return fail("smoke_request_failed");
    }

    if (response.status !== 200) {
      await discardResponseBody(response);
      return fail(httpFailureCode[input.endpoint]);
    }

    return readBoundedJson(response, input.endpoint);
  };
}

function parseBootstrapResponse(value: unknown) {
  const parsed = bootstrapResponseSchema.safeParse(value);
  if (!parsed.success) {
    return fail("bootstrap_response_invalid");
  }

  let expectedStreamUserId: string;
  try {
    expectedStreamUserId = deriveStreamUserId(parsed.data.user.id);
  } catch {
    return fail("bootstrap_response_invalid");
  }

  if (parsed.data.stream_user_id !== expectedStreamUserId) {
    return fail("bootstrap_response_invalid");
  }

  return parsed.data;
}

function parseJwtJsonSegment(encoded: string): unknown {
  if (!jwtSegmentPattern.test(encoded)) {
    return fail("stream_token_response_invalid");
  }

  try {
    const decodedBytes = Buffer.from(encoded, "base64url");
    if (decodedBytes.toString("base64url") !== encoded) {
      return fail("stream_token_response_invalid");
    }
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      decodedBytes,
    );
    return JSON.parse(decoded) as unknown;
  } catch {
    return fail("stream_token_response_invalid");
  }
}

function validateStreamTokenResponse(
  value: unknown,
  expectedStreamUserId: string,
): Readonly<{ apiKey: string }> {
  const parsed = streamTokenResponseSchema.safeParse(value);
  if (!parsed.success || parsed.data.user.id !== expectedStreamUserId) {
    return fail("stream_token_response_invalid");
  }

  const segments = parsed.data.token.split(".");
  if (segments.length !== 3) {
    return fail("stream_token_response_invalid");
  }
  const [encodedHeader, encodedPayload, signature] = segments;
  if (
    encodedHeader === undefined ||
    encodedPayload === undefined ||
    signature === undefined ||
    !jwtSegmentPattern.test(signature)
  ) {
    return fail("stream_token_response_invalid");
  }
  const decodedSignature = Buffer.from(signature, "base64url");
  if (
    decodedSignature.toString("base64url") !== signature ||
    decodedSignature.byteLength !== 32
  ) {
    return fail("stream_token_response_invalid");
  }

  const header = streamJwtHeaderSchema.safeParse(
    parseJwtJsonSegment(encodedHeader),
  );
  const payload = streamJwtPayloadSchema.safeParse(
    parseJwtJsonSegment(encodedPayload),
  );
  if (
    !header.success ||
    !payload.success ||
    payload.data.user_id !== expectedStreamUserId ||
    payload.data.exp !== payload.data.iat + 3_600
  ) {
    return fail("stream_token_response_invalid");
  }

  let expectedExpiresAt: string;
  try {
    expectedExpiresAt = new Date(payload.data.exp * 1_000).toISOString();
  } catch {
    return fail("stream_token_response_invalid");
  }

  if (parsed.data.expires_at !== expectedExpiresAt) {
    return fail("stream_token_response_invalid");
  }

  return Object.freeze({ apiKey: parsed.data.api_key });
}

export async function verifyIdentityStream(
  input: VerifyIdentityStreamInput,
): Promise<void> {
  const accessToken = validateAccessToken(input.accessToken);
  const baseOrigin = parseBaseOrigin(input.baseUrl);
  const transport = input.transport ?? createIdentityStreamSmokeTransport();

  const request = async (
    endpoint: IdentityStreamSmokeEndpoint,
  ): Promise<unknown> => {
    try {
      return await transport({
        endpoint,
        url: new URL(endpointPath[endpoint], `${baseOrigin}/`).toString(),
        accessToken,
      });
    } catch (error) {
      if (error instanceof IdentityStreamSmokeError) {
        throw error;
      }
      return fail("smoke_request_failed");
    }
  };

  const firstBootstrap = parseBootstrapResponse(await request("bootstrap"));
  const secondBootstrap = parseBootstrapResponse(await request("bootstrap"));

  if (
    firstBootstrap.user.id !== secondBootstrap.user.id ||
    firstBootstrap.stream_user_id !== secondBootstrap.stream_user_id
  ) {
    return fail("bootstrap_identity_unstable");
  }

  const chat = validateStreamTokenResponse(
    await request("chat"),
    firstBootstrap.stream_user_id,
  );
  const video = validateStreamTokenResponse(
    await request("video"),
    firstBootstrap.stream_user_id,
  );

  if (chat.apiKey !== video.apiKey) {
    return fail("stream_api_key_mismatch");
  }
}

async function readPipedAccessToken(input: NodeJS.ReadStream): Promise<string> {
  let contents = "";

  for await (const rawChunk of input as AsyncIterable<Buffer | string>) {
    const chunk =
      typeof rawChunk === "string" ? rawChunk : rawChunk.toString("utf8");
    contents += chunk;
    if (contents.length > maximumAccessTokenLength + 2) {
      return fail("token_input_invalid");
    }
  }

  return normalizePipedAccessToken(contents);
}

function readHiddenAccessToken(
  input: NodeJS.ReadStream,
  output: OutputWriter,
  signalSource: SignalEventSource,
): Promise<string> {
  const originalRawMode = input.isRaw;
  output.write("Privy access token (hidden): ");

  try {
    input.setRawMode(true);
    input.resume();
  } catch {
    try {
      input.setRawMode(originalRawMode);
    } catch {
      // Keep the terminal failure opaque and continue with the fixed code.
    }
    try {
      input.pause();
    } catch {
      // Keep the terminal failure opaque and continue with the fixed code.
    }
    try {
      output.write("\n");
    } catch {
      // The caller still receives the fixed failure code.
    }
    return Promise.reject(new IdentityStreamSmokeError("token_input_failed"));
  }

  return new Promise((resolvePromise, rejectPromise) => {
    let value = "";
    let settled = false;

    const cleanup = (): void => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      input.off("close", onClose);
      for (const signal of terminatingSignals) {
        try {
          signalSource.off(signal, onSignal);
        } catch {
          // Keep cleanup best-effort and the result code fixed.
        }
      }
      try {
        input.setRawMode(originalRawMode);
      } catch {
        // The fixed failure result below remains the only diagnostic output.
      }
      try {
        input.pause();
      } catch {
        // The fixed result remains independent from terminal implementation.
      }
      try {
        output.write("\n");
      } catch {
        // The token is still never emitted when terminal output is unavailable.
      }
    };

    const rejectWith = (code: IdentityStreamSmokeFailureCode): void => {
      if (settled) {
        return;
      }
      settled = true;
      value = "";
      cleanup();
      rejectPromise(new IdentityStreamSmokeError(code));
    };

    const complete = (): void => {
      if (settled) {
        return;
      }
      try {
        const token = validateAccessToken(value);
        settled = true;
        value = "";
        cleanup();
        resolvePromise(token);
      } catch (error) {
        rejectWith(
          error instanceof IdentityStreamSmokeError
            ? error.code
            : "token_input_failed",
        );
      }
    };

    const onData = (rawChunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(rawChunk)
        ? rawChunk
        : Buffer.from(rawChunk, "utf8");

      for (const [index, byte] of bytes.entries()) {
        if (byte === 3 || byte === 4) {
          rejectWith("token_input_cancelled");
          return;
        }
        if (byte === 10 || byte === 13) {
          const remaining = bytes.subarray(index + 1);
          const isTerminalCrLf =
            byte === 13 && remaining.length === 1 && remaining[0] === 10;
          if (remaining.length > 0 && !isTerminalCrLf) {
            rejectWith("token_input_invalid");
            return;
          }
          complete();
          return;
        }
        if (byte === 8 || byte === 127) {
          value = value.slice(0, -1);
          continue;
        }

        const character = String.fromCharCode(byte);
        if (!/[A-Za-z0-9_.-]/.test(character)) {
          rejectWith("token_input_invalid");
          return;
        }
        if (value.length >= maximumAccessTokenLength) {
          rejectWith("token_input_invalid");
          return;
        }
        value += character;
      }
    };

    const onEnd = (): void => rejectWith("token_input_invalid");
    const onError = (): void => rejectWith("token_input_failed");
    const onClose = (): void => rejectWith("token_input_cancelled");
    const onSignal = (): void => rejectWith("token_input_cancelled");

    try {
      input.on("data", onData);
      input.once("end", onEnd);
      input.once("error", onError);
      input.once("close", onClose);
      for (const signal of terminatingSignals) {
        signalSource.once(signal, onSignal);
      }
    } catch {
      rejectWith("token_input_failed");
    }
  });
}

export function readAccessTokenFromStdin(
  input: NodeJS.ReadStream = process.stdin,
  promptOutput: OutputWriter = process.stderr,
  signalSource: SignalEventSource = process,
): Promise<string> {
  return input.isTTY
    ? readHiddenAccessToken(input, promptOutput, signalSource)
    : readPipedAccessToken(input);
}

function validateRuntimeEnvironment(environment: NodeJS.ProcessEnv): void {
  if (
    (environment["NODE_DEBUG"]?.trim().length ?? 0) > 0 ||
    environment["NODE_TLS_REJECT_UNAUTHORIZED"] === "0"
  ) {
    return fail("smoke_runtime_unsafe");
  }
}

function failureCode(error: unknown): IdentityStreamSmokeFailureCode {
  return error instanceof IdentityStreamSmokeError
    ? error.code
    : "smoke_failed";
}

export async function runIdentityStreamSmoke(
  options: RunIdentityStreamSmokeOptions,
): Promise<number> {
  if (options.argv.length !== 2) {
    options.stderr.write(
      "Identity/Stream credential smoke failed (smoke_arguments_invalid)\n",
    );
    return 1;
  }

  let baseOrigin: string;
  try {
    validateRuntimeEnvironment(options.environment);
    baseOrigin = parseBaseOrigin(
      options.environment["PUBLIC_BASE_URL"] ?? "http://127.0.0.1:3000",
    );
  } catch (error) {
    options.stderr.write(
      `Identity/Stream credential smoke failed (${failureCode(error)})\n`,
    );
    return 1;
  }

  let accessToken: string;
  try {
    accessToken = await (
      options.readAccessToken ??
      (() => readAccessTokenFromStdin(process.stdin, options.stderr))
    )();
  } catch (error) {
    const code =
      error instanceof IdentityStreamSmokeError
        ? error.code
        : "token_input_failed";
    options.stderr.write(`Identity/Stream credential smoke failed (${code})\n`);
    return 1;
  }

  try {
    await verifyIdentityStream({
      accessToken,
      baseUrl: baseOrigin,
      ...(options.transport === undefined
        ? {}
        : { transport: options.transport }),
    });
    options.stdout.write("Identity/Stream credential smoke passed\n");
    return 0;
  } catch (error) {
    options.stderr.write(
      `Identity/Stream credential smoke failed (${failureCode(error)})\n`,
    );
    return 1;
  }
}

const directEntryPoint = process.argv[1];

if (
  directEntryPoint !== undefined &&
  resolve(directEntryPoint) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runIdentityStreamSmoke({
    argv: process.argv,
    environment: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
