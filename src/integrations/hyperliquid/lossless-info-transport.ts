import {
  createLosslessHyperliquidInfoHttpKernel,
  HyperliquidInfoTransportUnavailableError,
  RetryableHyperliquidInfoTransportError,
} from "./lossless-info-http-kernel.js";
import {
  HyperliquidPrivateReaderUnavailableError,
  RetryableHyperliquidReadError,
} from "./private-reader.js";

export {
  HYPERLIQUID_INFO_DEFAULT_MAX_RESPONSE_BYTES,
  HYPERLIQUID_TESTNET_INFO_URL,
} from "./lossless-info-http-kernel.js";

const addressPattern = /^0x[0-9a-f]{40}$/;
const zeroAddress = `0x${"0".repeat(40)}`;
const clientOrderIdPattern = /^0x[0-9a-f]{32}$/;
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

interface OrderStatusByClientOrderIdRequest {
  readonly type: "orderStatus";
  readonly user: string;
  readonly oid: string;
}

export type HyperliquidInfoRequest =
  | MetaRequest
  | AccountRequest
  | OrdersRequest
  | FillsRequest
  | FundingRequest
  | OrderStatusByClientOrderIdRequest;

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
    case "orderStatus":
      if (
        !hasExactDataProperties(rawValue, ["type", "user", "oid"]) ||
        !isValidUser(rawValue["user"]) ||
        typeof rawValue["oid"] !== "string" ||
        !clientOrderIdPattern.test(rawValue["oid"])
      ) {
        return unavailable();
      }
      return JSON.stringify({
        type: "orderStatus",
        user: rawValue["user"],
        oid: rawValue["oid"],
      });
    default:
      return unavailable();
  }
}

export function createLosslessHyperliquidInfoTransport(
  input: CreateHyperliquidLosslessInfoTransportInput = {},
): HyperliquidLosslessInfoTransport {
  const kernel = createLosslessHyperliquidInfoHttpKernel(input);

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

      try {
        return await kernel.postSerialized(body, signal, callId);
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof RetryableHyperliquidInfoTransportError) {
          throw new RetryableHyperliquidReadError(error.reason);
        }
        if (error instanceof HyperliquidInfoTransportUnavailableError) {
          return unavailable();
        }
        return unavailable();
      }
    },
  });
}
