import {
  createLosslessHyperliquidInfoHttpKernel,
  HyperliquidInfoTransportUnavailableError,
  RetryableHyperliquidInfoTransportError,
  type CreateHyperliquidLosslessInfoHttpKernelInput,
} from "./lossless-info-http-kernel.js";
import {
  HyperliquidSpotInfoUnavailableError,
  RetryableHyperliquidSpotInfoError,
  type HyperliquidSpotInfoRequest,
  type HyperliquidSpotInfoTransport,
} from "./spot-info-contract.js";

export {
  HYPERLIQUID_INFO_DEFAULT_MAX_RESPONSE_BYTES,
  HYPERLIQUID_TESTNET_INFO_URL,
} from "./lossless-info-http-kernel.js";

const addressPattern = /^0x[0-9a-f]{40}$/;
const zeroAddress = `0x${"0".repeat(40)}`;
const indexedSpotCoinPattern = /^@(0|[1-9][0-9]{0,9})$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type CreateHyperliquidSpotInfoTransportInput =
  CreateHyperliquidLosslessInfoHttpKernelInput;

function unavailable(): never {
  throw new HyperliquidSpotInfoUnavailableError();
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
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string")
  ) {
    return false;
  }

  const expected = new Set(expectedKeys);
  for (const key of keys) {
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

function isSpotProviderCoin(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value === "PURR/USDC" || indexedSpotCoinPattern.test(value))
  );
}

function isAccountAddress(value: unknown): value is string {
  return (
    typeof value === "string" &&
    addressPattern.test(value) &&
    value !== zeroAddress
  );
}

function serializeRequest(request: HyperliquidSpotInfoRequest): string {
  const raw: unknown = request;
  if (!isPlainDataRecord(raw)) {
    return unavailable();
  }
  const typeDescriptor = Object.getOwnPropertyDescriptor(raw, "type");
  if (
    typeDescriptor === undefined ||
    !("value" in typeDescriptor) ||
    typeof typeDescriptor.value !== "string"
  ) {
    return unavailable();
  }

  switch (typeDescriptor.value) {
    case "spotMetaAndAssetCtxs":
      if (!hasExactDataProperties(raw, ["type"])) {
        return unavailable();
      }
      return '{"type":"spotMetaAndAssetCtxs"}';
    case "l2Book":
      if (
        !hasExactDataProperties(raw, [
          "type",
          "coin",
          "nSigFigs",
          "mantissa",
        ]) ||
        !isSpotProviderCoin(raw["coin"]) ||
        raw["nSigFigs"] !== 5 ||
        raw["mantissa"] !== null
      ) {
        return unavailable();
      }
      return JSON.stringify({
        type: "l2Book",
        coin: raw["coin"],
        nSigFigs: 5,
        mantissa: null,
      });
    case "spotClearinghouseState":
      if (
        !hasExactDataProperties(raw, ["type", "user"]) ||
        !isAccountAddress(raw["user"])
      ) {
        return unavailable();
      }
      return JSON.stringify({
        type: "spotClearinghouseState",
        user: raw["user"],
      });
    default:
      return unavailable();
  }
}

export function createHyperliquidSpotInfoTransport(
  input: CreateHyperliquidSpotInfoTransportInput = {},
): HyperliquidSpotInfoTransport {
  const kernel = createLosslessHyperliquidInfoHttpKernel(input);

  return Object.freeze({
    async post(
      request: HyperliquidSpotInfoRequest,
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
      let body: string;
      try {
        body = serializeRequest(request);
      } catch {
        signal.throwIfAborted();
        return unavailable();
      }

      try {
        return await kernel.postSerialized(body, signal, callId);
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof RetryableHyperliquidInfoTransportError) {
          throw new RetryableHyperliquidSpotInfoError(error.reason);
        }
        if (error instanceof HyperliquidInfoTransportUnavailableError) {
          return unavailable();
        }
        return unavailable();
      }
    },
  });
}
