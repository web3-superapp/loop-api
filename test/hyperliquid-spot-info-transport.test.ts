import { isLosslessNumber } from "lossless-json";
import { describe, expect, it, vi } from "vitest";

import {
  HyperliquidSpotInfoUnavailableError,
  RetryableHyperliquidSpotInfoError,
  type HyperliquidSpotInfoRequest,
} from "../src/integrations/hyperliquid/spot-info-contract.js";
import {
  createHyperliquidSpotInfoTransport,
  HYPERLIQUID_TESTNET_INFO_URL,
} from "../src/integrations/hyperliquid/spot-info-transport.js";

const callId = "12345678-1234-4234-8234-123456789abc";
const accountAddress = `0x${"12".repeat(20)}`;

function jsonResponse(body = "{}"): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Hyperliquid Spot Info transport", () => {
  it("serializes only the four exact Spot requests with canonical bytes", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse('{"time":18446744073709551615}')),
    );
    const transport = createHyperliquidSpotInfoTransport({ fetch });
    const signal = new AbortController().signal;

    const responses = await Promise.all([
      transport.post({ type: "spotMetaAndAssetCtxs" }, signal, callId),
      transport.post(
        {
          type: "l2Book",
          coin: "PURR/USDC",
          nSigFigs: 5,
          mantissa: null,
        },
        signal,
        callId,
      ),
      transport.post(
        {
          type: "l2Book",
          coin: "@1",
          nSigFigs: 5,
          mantissa: null,
        },
        signal,
        callId,
      ),
      transport.post(
        { type: "spotClearinghouseState", user: accountAddress },
        signal,
        callId,
      ),
      transport.post(
        { type: "userFees", user: accountAddress },
        signal,
        callId,
      ),
    ]);

    expect(fetch).toHaveBeenCalledTimes(5);
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      HYPERLIQUID_TESTNET_INFO_URL,
      HYPERLIQUID_TESTNET_INFO_URL,
      HYPERLIQUID_TESTNET_INFO_URL,
      HYPERLIQUID_TESTNET_INFO_URL,
      HYPERLIQUID_TESTNET_INFO_URL,
    ]);
    expect(fetch.mock.calls.map((call) => call[1]?.body)).toEqual([
      '{"type":"spotMetaAndAssetCtxs"}',
      '{"type":"l2Book","coin":"PURR/USDC","nSigFigs":5,"mantissa":null}',
      '{"type":"l2Book","coin":"@1","nSigFigs":5,"mantissa":null}',
      `{"type":"spotClearinghouseState","user":"${accountAddress}"}`,
      `{"type":"userFees","user":"${accountAddress}"}`,
    ]);
    expect(
      responses.every(
        (response) =>
          typeof response === "object" &&
          response !== null &&
          isLosslessNumber((response as Record<string, unknown>)["time"]),
      ),
    ).toBe(true);
  });

  it.each([
    ["metadata unknown field", { type: "spotMetaAndAssetCtxs", dex: "" }],
    [
      "book alternate hash asset",
      { type: "l2Book", coin: "#1", nSigFigs: 5, mantissa: null },
    ],
    [
      "book alternate plus asset",
      { type: "l2Book", coin: "+1", nSigFigs: 5, mantissa: null },
    ],
    [
      "book non-PURR display pair",
      { type: "l2Book", coin: "OTHER/USDC", nSigFigs: 5, mantissa: null },
    ],
    [
      "book provider wire drift",
      { type: "l2Book", coin: "PURR/USDC", nSigFigs: 4, mantissa: null },
    ],
    [
      "uppercase account",
      {
        type: "spotClearinghouseState",
        user: `0x${"AB".repeat(20)}`,
      },
    ],
    [
      "zero account",
      { type: "spotClearinghouseState", user: `0x${"0".repeat(40)}` },
    ],
    [
      "fees extra wallet authority",
      { type: "userFees", user: accountAddress, wallet: accountAddress },
    ],
    [
      "fees uppercase account",
      { type: "userFees", user: `0x${"AB".repeat(20)}` },
    ],
    ["fees zero account", { type: "userFees", user: `0x${"0".repeat(40)}` }],
  ])("rejects %s before HTTP", async (_label, request) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const transport = createHyperliquidSpotInfoTransport({ fetch });

    await expect(
      transport.post(
        request as HyperliquidSpotInfoRequest,
        new AbortController().signal,
        callId,
      ),
    ).rejects.toBeInstanceOf(HyperliquidSpotInfoUnavailableError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects accessors, symbol keys, and non-plain request objects without reading them", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const transport = createHyperliquidSpotInfoTransport({ fetch });
    const getter = vi.fn(() => "spotMetaAndAssetCtxs");
    const accessor = {};
    Object.defineProperty(accessor, "type", { enumerable: true, get: getter });
    const symbolKeyed = { type: "spotMetaAndAssetCtxs" };
    Object.defineProperty(symbolKeyed, Symbol("hidden"), {
      enumerable: true,
      value: "authority",
    });

    for (const request of [
      accessor,
      symbolKeyed,
      Object.assign(Object.create({}), { type: "spotMetaAndAssetCtxs" }),
    ]) {
      await expect(
        transport.post(
          request as HyperliquidSpotInfoRequest,
          new AbortController().signal,
          callId,
        ),
      ).rejects.toBeInstanceOf(HyperliquidSpotInfoUnavailableError);
    }
    expect(getter).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps retryable kernel failures to a sanitized Spot-local error", async () => {
    const transport = createHyperliquidSpotInfoTransport({
      fetch: vi.fn<typeof globalThis.fetch>(() =>
        Promise.reject(new Error("private transport detail")),
      ),
    });

    let failure: unknown;
    try {
      await transport.post(
        { type: "spotMetaAndAssetCtxs" },
        new AbortController().signal,
        callId,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toEqual(
      new RetryableHyperliquidSpotInfoError("pre_response_transport"),
    );
    expect(String(failure)).not.toContain("private transport detail");
  });

  it("gives the outer abort priority and rejects malformed call IDs", async () => {
    const controller = new AbortController();
    const reason = new Error("outer Spot read stopped");
    controller.abort(reason);
    const fetch = vi.fn<typeof globalThis.fetch>();
    const transport = createHyperliquidSpotInfoTransport({ fetch });

    await expect(
      transport.post(
        { type: "spotMetaAndAssetCtxs" },
        controller.signal,
        callId,
      ),
    ).rejects.toBe(reason);
    await expect(
      transport.post(
        { type: "spotMetaAndAssetCtxs" },
        new AbortController().signal,
        "not-a-uuid",
      ),
    ).rejects.toBeInstanceOf(HyperliquidSpotInfoUnavailableError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
