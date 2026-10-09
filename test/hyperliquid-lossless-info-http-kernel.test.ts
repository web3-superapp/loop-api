import { isLosslessNumber } from "lossless-json";
import { describe, expect, it, vi } from "vitest";

import {
  createLosslessHyperliquidInfoHttpKernel,
  HYPERLIQUID_TESTNET_INFO_URL,
  HyperliquidInfoTransportUnavailableError,
  RetryableHyperliquidInfoTransportError,
} from "../src/integrations/hyperliquid/lossless-info-http-kernel.js";

const callId = "12345678-1234-4234-8234-123456789abc";
const serializedBody = JSON.stringify({ type: "spotMeta" });

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("provider-generic Hyperliquid lossless Info HTTP kernel", () => {
  it("posts serialized requests only to Testnet and preserves integer lexemes", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse('{"oid":18446744073709551615}')),
    );
    const kernel = createLosslessHyperliquidInfoHttpKernel({ fetch });

    const result = (await kernel.postSerialized(
      serializedBody,
      new AbortController().signal,
      callId,
    )) as Record<string, unknown>;

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe(HYPERLIQUID_TESTNET_INFO_URL);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: serializedBody,
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
    });
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({
      accept: "application/json",
      "content-type": "application/json",
    });
    expect(isLosslessNumber(result["oid"])).toBe(true);
    expect(String(result["oid"])).toBe("18446744073709551615");
  });

  it("classifies only pre-response failures and provider 5xx as retryable", async () => {
    const rejected = createLosslessHyperliquidInfoHttpKernel({
      fetch: vi.fn<typeof globalThis.fetch>(() =>
        Promise.reject(new Error("raw transport detail")),
      ),
    });
    await expect(
      rejected.postSerialized(
        serializedBody,
        new AbortController().signal,
        callId,
      ),
    ).rejects.toEqual(
      new RetryableHyperliquidInfoTransportError("pre_response_transport"),
    );

    const serverFailure = createLosslessHyperliquidInfoHttpKernel({
      fetch: vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(jsonResponse("raw provider detail", 503)),
      ),
    });
    let failure: unknown;
    try {
      await serverFailure.postSerialized(
        serializedBody,
        new AbortController().signal,
        callId,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toEqual(
      new RetryableHyperliquidInfoTransportError("provider_5xx"),
    );
    expect(String(failure)).not.toContain("raw provider detail");
  });

  it.each([400, 401, 404, 429])(
    "makes provider %s a sanitized non-retryable failure",
    async (status) => {
      const kernel = createLosslessHyperliquidInfoHttpKernel({
        fetch: vi.fn<typeof globalThis.fetch>(() =>
          Promise.resolve(jsonResponse("private provider body", status)),
        ),
      });

      let failure: unknown;
      try {
        await kernel.postSerialized(
          serializedBody,
          new AbortController().signal,
          callId,
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(HyperliquidInfoTransportUnavailableError);
      expect(failure).not.toBeInstanceOf(
        RetryableHyperliquidInfoTransportError,
      );
      expect(String(failure)).not.toContain("private provider body");
    },
  );

  it.each([
    ["wrong content type", new Response("{}", { status: 200 })],
    ["invalid JSON", jsonResponse("{")],
    ["duplicate JSON keys", jsonResponse('{"a":1,"a":2}')],
  ])("rejects %s without retry", async (_label, response) => {
    const kernel = createLosslessHyperliquidInfoHttpKernel({
      fetch: vi.fn<typeof globalThis.fetch>(() => Promise.resolve(response)),
    });

    await expect(
      kernel.postSerialized(
        serializedBody,
        new AbortController().signal,
        callId,
      ),
    ).rejects.toBeInstanceOf(HyperliquidInfoTransportUnavailableError);
  });

  it("enforces the response byte cap and rejects malformed internal inputs", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse('{"long":"payload"}')),
    );
    const kernel = createLosslessHyperliquidInfoHttpKernel({
      fetch,
      maxResponseBytes: 8,
    });

    await expect(
      kernel.postSerialized(
        serializedBody,
        new AbortController().signal,
        callId,
      ),
    ).rejects.toBeInstanceOf(HyperliquidInfoTransportUnavailableError);
    await expect(
      kernel.postSerialized("", new AbortController().signal, callId),
    ).rejects.toBeInstanceOf(HyperliquidInfoTransportUnavailableError);
    await expect(
      kernel.postSerialized(
        serializedBody,
        new AbortController().signal,
        "not-a-uuid",
      ),
    ).rejects.toBeInstanceOf(HyperliquidInfoTransportUnavailableError);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("gives outer abort precedence and rejects invalid configuration", async () => {
    const controller = new AbortController();
    const reason = new Error("outer operation stopped");
    const kernel = createLosslessHyperliquidInfoHttpKernel({
      fetch: vi.fn<typeof globalThis.fetch>(() => {
        controller.abort(reason);
        return Promise.resolve(jsonResponse("{}", 503));
      }),
    });

    await expect(
      kernel.postSerialized(serializedBody, controller.signal, callId),
    ).rejects.toBe(reason);
    expect(() =>
      createLosslessHyperliquidInfoHttpKernel({ maxResponseBytes: 0 }),
    ).toThrow(TypeError);
  });
});
