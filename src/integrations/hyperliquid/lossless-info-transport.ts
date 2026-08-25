import { parse } from "lossless-json";

import {
  HyperliquidPrivateReaderUnavailableError,
  RetryableHyperliquidReadError,
} from "./private-reader.js";

export const HYPERLIQUID_TESTNET_INFO_URL =
  "https://api.hyperliquid-testnet.xyz/info";
export const HYPERLIQUID_INFO_DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

const maximumConfiguredResponseBytes = 8 * 1024 * 1024;
const addressPattern = /^0x[0-9a-f]{40}$/;
const zeroAddress = `0x${"0".repeat(40)}`;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface MetaRequest {
  readonly type: "meta";
  readonly dex: "";
}

interface AccountRequest {
  readonly type: "clearinghouseState";
  readonly user: string;
  readonly dex: "";
}

interface OrdersRequest {
  readonly type: "frontendOpenOrders";
  readonly user: string;
  readonly dex: "";
}

interface FillsRequest {
  readonly type: "userFillsByTime";
  readonly user: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly aggregateByTime: false;
}

interface FundingRequest {
  readonly type: "userFunding";
  readonly user: string;
  readonly startTime: number;
  readonly endTime: number;
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

export type HyperliquidInfoRequest =
  MetaRequest | AccountRequest | OrdersRequest | FillsRequest | FundingRequest;

export interface HyperliquidLosslessInfoTransport {
  post(
    request: HyperliquidInfoRequest,
    signal: AbortSignal,
    callId: string,
  ): Promise<unknown>;
}

export interface CreateHyperliquidLosslessInfoTransportInput {
  readonly fetch?: typeof fetch;
  readonly maxResponseBytes?: number;
}

function unavailable(): never {
  throw new HyperliquidPrivateReaderUnavailableError();
}

function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasExactDataProperties(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== expectedKeys.length ||
    ownKeys.some((key) => typeof key !== "string")
  ) {
    return false;
  }

  const expected = new Set(expectedKeys);
  for (const key of ownKeys) {
    if (typeof key !== "string" || !expected.has(key)) {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      return false;
    }
  }
  return expectedKeys.every((key) => Object.hasOwn(value, key));
}

function isValidUser(value: unknown): value is string {
  return (
    typeof value === "string" &&
    addressPattern.test(value) &&
    value !== zeroAddress
  );
}

function isValidWindow(startTime: unknown, endTime: unknown): boolean {
  return (
    typeof startTime === "number" &&
    typeof endTime === "number" &&
    Number.isSafeInteger(startTime) &&
    Number.isSafeInteger(endTime) &&
    startTime >= 0 &&
    startTime <= endTime
  );
}

function serializeRequest(value: HyperliquidInfoRequest): string {
  const rawValue: unknown = value;
  if (!isPlainDataRecord(rawValue) || typeof rawValue["type"] !== "string") {
    return unavailable();
  }

  switch (rawValue["type"]) {
    case "meta":
      if (
        !hasExactDataProperties(rawValue, ["type", "dex"]) ||
        rawValue["dex"] !== ""
      ) {
        return unavailable();
      }
      return JSON.stringify({ type: "meta", dex: "" });
    case "clearinghouseState":
    case "frontendOpenOrders":
      if (
        !hasExactDataProperties(rawValue, ["type", "user", "dex"]) ||
        !isValidUser(rawValue["user"]) ||
        rawValue["dex"] !== ""
      ) {
        return unavailable();
      }
      return JSON.stringify({
        type: rawValue["type"],
        user: rawValue["user"],
        dex: "",
      });
    case "userFillsByTime":
      if (
        !hasExactDataProperties(rawValue, [
          "type",
          "user",
          "startTime",
          "endTime",
          "aggregateByTime",
        ]) ||
        !isValidUser(rawValue["user"]) ||
        !isValidWindow(rawValue["startTime"], rawValue["endTime"]) ||
        rawValue["aggregateByTime"] !== false
      ) {
        return unavailable();
      }
      return JSON.stringify({
        type: "userFillsByTime",
        user: rawValue["user"],
        startTime: rawValue["startTime"],
        endTime: rawValue["endTime"],
        aggregateByTime: false,
      });
    case "userFunding":
      if (
        !hasExactDataProperties(rawValue, [
          "type",
          "user",
          "startTime",
          "endTime",
        ]) ||
        !isValidUser(rawValue["user"]) ||
        !isValidWindow(rawValue["startTime"], rawValue["endTime"])
      ) {
        return unavailable();
      }
      return JSON.stringify({
        type: "userFunding",
        user: rawValue["user"],
        startTime: rawValue["startTime"],
        endTime: rawValue["endTime"],
      });
    default:
      return unavailable();
  }
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

export function createLosslessHyperliquidInfoTransport(
  input: CreateHyperliquidLosslessInfoTransportInput = {},
): HyperliquidLosslessInfoTransport {
  const fetchImplementation = input.fetch ?? fetch;
  const maximumBytes = configuredMaximum(input.maxResponseBytes);

  return Object.freeze({
    async post(
      request: HyperliquidInfoRequest,
      signal: AbortSignal,
      callId: string,
    ) {
      if (!(signal instanceof AbortSignal)) {
        return unavailable();
      }
      signal.throwIfAborted();
      if (typeof callId !== "string" || !uuidPattern.test(callId)) {
        return unavailable();
      }
      const body = serializeRequest(request);

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
        throw new RetryableHyperliquidReadError("pre_response_transport");
      }

      try {
        signal.throwIfAborted();
        if (!(response instanceof Response)) {
          return unavailable();
        }
        if (response.status >= 500 && response.status <= 599) {
          await cancelResponseBody(response);
          signal.throwIfAborted();
          throw new RetryableHyperliquidReadError("provider_5xx");
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
          error instanceof RetryableHyperliquidReadError ||
          error instanceof HyperliquidPrivateReaderUnavailableError
        ) {
          throw error;
        }
        return unavailable();
      }
    },
  });
}
