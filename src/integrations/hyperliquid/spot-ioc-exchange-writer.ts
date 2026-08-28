import { parse } from "lossless-json";
import { z } from "zod";

import type { SpotIocExchangeWriter } from "../../features/spot/spot-intent-submission.js";
import {
  assertHyperliquidSpotIocTiming,
  assertHyperliquidSpotIocWriteAdmission,
  HyperliquidSpotIocAdapterUnavailableError,
  parseHyperliquidSpotIocAction,
  parseHyperliquidSpotIocRequestId,
  parseHyperliquidSpotIocSignature,
} from "./spot-ioc-wire.js";

export const HYPERLIQUID_TESTNET_EXCHANGE_URL =
  "https://api.hyperliquid-testnet.xyz/exchange";
export const HYPERLIQUID_SPOT_IOC_DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;

const maximumConfiguredResponseBytes = 1024 * 1024;
const writerInputSchema = z
  .object({
    transportAttemptId: z.string(),
    network: z.literal("testnet"),
    action: z.unknown(),
    nonce: z.string(),
    signature: z.unknown(),
    vaultAddress: z.null(),
    expiresAfter: z.string(),
    attemptDeadlineAt: z.string(),
    writeAdmissionExpiresAt: z.string(),
    signal: z.instanceof(AbortSignal),
  })
  .strict();

export interface CreateHyperliquidSpotIocExchangeWriterInput {
  readonly fetch?: typeof fetch;
  readonly maxResponseBytes?: number;
  readonly now?: () => Date;
}

interface BodyReadResult {
  readonly done: boolean;
  readonly value?: Uint8Array;
}

interface BodyReader {
  read(): Promise<BodyReadResult>;
  cancel(): Promise<void>;
  releaseLock(): void;
}

function unavailable(): never {
  throw new HyperliquidSpotIocAdapterUnavailableError();
}

function configuredMaximum(value: number | undefined): number {
  const maximum = value ?? HYPERLIQUID_SPOT_IOC_DEFAULT_MAX_RESPONSE_BYTES;
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > maximumConfiguredResponseBytes
  ) {
    throw new TypeError("Hyperliquid Spot IOC response byte limit is invalid");
  }
  return maximum;
}

function readNow(now: () => Date): number {
  let value: unknown;
  try {
    value = now();
  } catch {
    return unavailable();
  }
  if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime())) {
    return unavailable();
  }
  return value.getTime();
}

function validateContentType(response: Response): void {
  const mediaType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    return unavailable();
  }
}

function validateContentLength(response: Response, maximumBytes: number): void {
  const value = response.headers.get("content-length");
  if (value === null) {
    return;
  }
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    return unavailable();
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length > maximumBytes) {
    return unavailable();
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
      if (!(part.value instanceof Uint8Array)) {
        return unavailable();
      }
      bytesRead += part.value.byteLength;
      if (bytesRead > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        return unavailable();
      }
      parts.push(decoder.decode(part.value, { stream: true }));
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

function assertLosslessJson(value: string): void {
  try {
    parse(value);
  } catch {
    return unavailable();
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    if (response.body !== null && !response.body.locked) {
      await response.body.cancel();
    }
  } catch {
    // Best-effort connection cleanup must not replace the safe adapter error.
  }
}

export function createHyperliquidSpotIocExchangeWriter(
  input: CreateHyperliquidSpotIocExchangeWriterInput = {},
): SpotIocExchangeWriter {
  const fetchImplementation = input.fetch ?? fetch;
  const maximumBytes = configuredMaximum(input.maxResponseBytes);
  const now = input.now ?? (() => new Date());

  return Object.freeze({
    async submit(inputValue: unknown) {
      const parsedInput = writerInputSchema.safeParse(inputValue);
      if (!parsedInput.success) {
        return unavailable();
      }
      const rawInput = parsedInput.data;
      parseHyperliquidSpotIocRequestId(rawInput.transportAttemptId);
      const action = parseHyperliquidSpotIocAction(rawInput.action);
      const signature = parseHyperliquidSpotIocSignature(rawInput.signature);
      const nowMilliseconds = readNow(now);
      const timing = assertHyperliquidSpotIocTiming({
        nonce: rawInput.nonce,
        expiresAfter: rawInput.expiresAfter,
        attemptDeadlineAt: rawInput.attemptDeadlineAt,
        signal: rawInput.signal,
        nowMilliseconds,
      });
      assertHyperliquidSpotIocWriteAdmission({
        writeAdmissionExpiresAt: rawInput.writeAdmissionExpiresAt,
        attemptDeadlineAt: rawInput.attemptDeadlineAt,
        signal: rawInput.signal,
        nowMilliseconds,
      });
      const body = JSON.stringify({
        action,
        nonce: timing.nonce,
        signature,
        vaultAddress: null,
        expiresAfter: timing.expiresAfter,
      });

      let response: Response;
      try {
        response = await fetchImplementation(HYPERLIQUID_TESTNET_EXCHANGE_URL, {
          method: "POST",
          headers: Object.freeze({
            accept: "application/json",
            "content-type": "application/json",
          }),
          body,
          signal: rawInput.signal,
          redirect: "error",
          cache: "no-store",
          credentials: "omit",
        });
      } catch {
        rawInput.signal.throwIfAborted();
        return unavailable();
      }

      try {
        rawInput.signal.throwIfAborted();
        if (!(response instanceof Response)) {
          return unavailable();
        }
        if (!response.ok) {
          return unavailable();
        }
        validateContentType(response);
        const responseBody = await readBoundedUtf8(
          response,
          maximumBytes,
          rawInput.signal,
        );
        rawInput.signal.throwIfAborted();
        assertLosslessJson(responseBody);
      } catch {
        if (response instanceof Response) {
          await cancelResponseBody(response);
        }
        rawInput.signal.throwIfAborted();
        return unavailable();
      }
    },
  });
}
