import { parse } from "lossless-json";

export const HYPERLIQUID_TESTNET_INFO_URL =
  "https://api.hyperliquid-testnet.xyz/info";
export const HYPERLIQUID_INFO_DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

const maximumConfiguredResponseBytes = 8 * 1024 * 1024;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface BodyReadResult {
  readonly done: boolean;
  readonly value?: Uint8Array;
}

interface BodyReader {
  read(): Promise<BodyReadResult>;
  cancel(): Promise<void>;
  releaseLock(): void;
}

export type RetryableHyperliquidInfoTransportReason =
  "pre_response_transport" | "provider_5xx";

const retryableReasons: ReadonlySet<string> = new Set([
  "pre_response_transport",
  "provider_5xx",
]);

export class RetryableHyperliquidInfoTransportError extends Error {
  readonly code = "retryable_hyperliquid_info_transport";
  readonly reason: RetryableHyperliquidInfoTransportReason;

  constructor(reason: RetryableHyperliquidInfoTransportReason) {
    if (!retryableReasons.has(reason)) {
      throw new TypeError("Hyperliquid Info transport retry reason is invalid");
    }
    super("The Hyperliquid Info transport may be retried");
    this.name = "RetryableHyperliquidInfoTransportError";
    this.reason = reason;
  }
}

export class HyperliquidInfoTransportUnavailableError extends Error {
  readonly code = "hyperliquid_info_transport_unavailable";

  constructor() {
    super("The Hyperliquid Info transport is unavailable");
    this.name = "HyperliquidInfoTransportUnavailableError";
  }
}

export interface HyperliquidLosslessInfoHttpKernel {
  postSerialized(
    body: string,
    signal: AbortSignal,
    callId: string,
  ): Promise<unknown>;
}

export interface CreateHyperliquidLosslessInfoHttpKernelInput {
  readonly fetch?: typeof fetch;
  readonly maxResponseBytes?: number;
}

function unavailable(): never {
  throw new HyperliquidInfoTransportUnavailableError();
}

function validateContentLength(response: Response, maximumBytes: number): void {
  const header = response.headers.get("content-length");
  if (header === null) {
    return;
  }
  if (!/^(?:0|[1-9][0-9]*)$/.test(header)) {
    unavailable();
  }
  const length = Number(header);
  if (!Number.isSafeInteger(length) || length > maximumBytes) {
    unavailable();
  }
}

function validateContentType(response: Response): void {
  const header = response.headers.get("content-type");
  const mediaType = header?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    unavailable();
  }
}

async function readBoundedUtf8(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<string> {
  validateContentLength(response, maximumBytes);
  if (response.body === null) {
    return unavailable();
  }

  const reader = response.body.getReader() as unknown as BodyReader;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parts: string[] = [];
  let bytesRead = 0;

  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) {
        break;
      }
      const chunk = part.value;
      if (!(chunk instanceof Uint8Array)) {
        return unavailable();
      }
      bytesRead += chunk.byteLength;
      if (bytesRead > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        return unavailable();
      }
      parts.push(decoder.decode(chunk, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } catch {
    signal.throwIfAborted();
    return unavailable();
  } finally {
    reader.releaseLock();
  }
}

function parseLosslessly(text: string): unknown {
  try {
    return parse(text);
  } catch {
    return unavailable();
  }
}

function configuredMaximum(value: number | undefined): number {
  const resolved = value ?? HYPERLIQUID_INFO_DEFAULT_MAX_RESPONSE_BYTES;
  if (
    !Number.isInteger(resolved) ||
    resolved < 1 ||
    resolved > maximumConfiguredResponseBytes
  ) {
    throw new TypeError("Hyperliquid response byte limit is invalid");
  }
  return resolved;
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export function createLosslessHyperliquidInfoHttpKernel(
  input: CreateHyperliquidLosslessInfoHttpKernelInput = {},
): HyperliquidLosslessInfoHttpKernel {
  const fetchImplementation = input.fetch ?? fetch;
  const maximumBytes = configuredMaximum(input.maxResponseBytes);

  return Object.freeze({
    async postSerialized(body: string, signal: AbortSignal, callId: string) {
      if (!(signal instanceof AbortSignal)) {
        return unavailable();
      }
      signal.throwIfAborted();
      if (
        typeof body !== "string" ||
        body.length === 0 ||
        typeof callId !== "string" ||
        !uuidPattern.test(callId)
      ) {
        return unavailable();
      }

      let response: Response;
      try {
        response = await fetchImplementation(HYPERLIQUID_TESTNET_INFO_URL, {
          method: "POST",
          headers: Object.freeze({
            accept: "application/json",
            "content-type": "application/json",
          }),
          body,
          signal,
          redirect: "error",
          cache: "no-store",
          credentials: "omit",
        });
      } catch {
        signal.throwIfAborted();
        throw new RetryableHyperliquidInfoTransportError(
          "pre_response_transport",
        );
      }

      try {
        signal.throwIfAborted();
        if (!(response instanceof Response)) {
          return unavailable();
        }
        if (response.status >= 500 && response.status <= 599) {
          await cancelResponseBody(response);
          signal.throwIfAborted();
          throw new RetryableHyperliquidInfoTransportError("provider_5xx");
        }
        if (!response.ok) {
          await cancelResponseBody(response);
          signal.throwIfAborted();
          return unavailable();
        }

        validateContentType(response);
        const text = await readBoundedUtf8(response, maximumBytes, signal);
        signal.throwIfAborted();
        return parseLosslessly(text);
      } catch (error) {
        signal.throwIfAborted();
        if (
          error instanceof RetryableHyperliquidInfoTransportError ||
          error instanceof HyperliquidInfoTransportUnavailableError
        ) {
          throw error;
        }
        return unavailable();
      }
    },
  });
}
