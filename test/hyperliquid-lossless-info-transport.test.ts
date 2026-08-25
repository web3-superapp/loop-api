import { isLosslessNumber } from "lossless-json";
import { describe, expect, it, vi } from "vitest";

import {
  createLosslessHyperliquidInfoTransport,
  HYPERLIQUID_TESTNET_INFO_URL,
  type HyperliquidInfoRequest,
} from "../src/integrations/hyperliquid/lossless-info-transport.js";
import {
  HyperliquidPrivateReaderUnavailableError,
  RetryableHyperliquidReadError,
} from "../src/integrations/hyperliquid/private-reader.js";

const accountAddress = `0x${"12".repeat(20)}`;
const callId = "87654321-4321-4321-8321-cba987654321";
const request = Object.freeze({
  type: "clearinghouseState",
  user: accountAddress,
  dex: "",
} as const satisfies HyperliquidInfoRequest);

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("lossless Hyperliquid Info transport", () => {
  it("posts only to the compiled Testnet URL and preserves uint64 lexemes", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        jsonResponse('{"oid":18446744073709551615,"value":"0.01"}'),
      ),
    );
    const transport = createLosslessHyperliquidInfoTransport({ fetch });

    const result = (await transport.post(
      request,
      new AbortController().signal,
      callId,
    )) as Record<string, unknown>;

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe(HYPERLIQUID_TESTNET_INFO_URL);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify(request),
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

  it("rejects request keys and authorities outside the allowlist before fetch", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const transport = createLosslessHyperliquidInfoTransport({ fetch });
    const badRequest = {
      ...request,
      user: `0x${"0".repeat(40)}`,
      url: "https://example.invalid",
    } as unknown as HyperliquidInfoRequest;

    await expect(
      transport.post(badRequest, new AbortController().signal, callId),
    ).rejects.toBeInstanceOf(HyperliquidPrivateReaderUnavailableError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("classifies pre-response rejection and provider 5xx as retryable", async () => {
    const rejected = createLosslessHyperliquidInfoTransport({
      fetch: vi.fn<typeof globalThis.fetch>(() =>
        Promise.reject(new Error(`network ${accountAddress}`)),
      ),
    });
    await expect(
      rejected.post(request, new AbortController().signal, callId),
    ).rejects.toMatchObject({
      name: "RetryableHyperliquidReadError",
      reason: "pre_response_transport",
    });

    const serverFailure = createLosslessHyperliquidInfoTransport({
      fetch: vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(jsonResponse(`secret ${accountAddress}`, 503)),
      ),
    });
    await expect(
      serverFailure.post(request, new AbortController().signal, callId),
    ).rejects.toEqual(new RetryableHyperliquidReadError("provider_5xx"));
  });

  it("gives outer abort precedence after fetch resolves", async () => {
    const controller = new AbortController();
    const reason = new Error("outer request stopped");
    const transport = createLosslessHyperliquidInfoTransport({
      fetch: vi.fn<typeof globalThis.fetch>(() => {
        controller.abort(reason);
        return Promise.resolve(jsonResponse("{}", 503));
      }),
    });

    await expect(
      transport.post(request, controller.signal, callId),
    ).rejects.toBe(reason);
  });

  it.each([400, 401, 404, 429])(
    "makes provider %s a sanitized non-retryable failure",
    async (status) => {
      const transport = createLosslessHyperliquidInfoTransport({
        fetch: vi.fn<typeof globalThis.fetch>(() =>
          Promise.resolve(jsonResponse(`raw ${accountAddress}`, status)),
        ),
      });

      let failure: unknown;
      try {
        await transport.post(request, new AbortController().signal, callId);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(HyperliquidPrivateReaderUnavailableError);
      expect(failure).not.toBeInstanceOf(RetryableHyperliquidReadError);
      expect(String(failure)).not.toContain(accountAddress);
      expect(String(failure)).not.toContain("raw");
    },
  );

  it.each([
    ["wrong content type", new Response("{}", { status: 200 })],
    [
      "invalid JSON",
      new Response("{", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ],
    [
      "duplicate JSON keys",
      new Response('{"a":1,"a":2}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ],
  ])("rejects %s without retry", async (_label, response) => {
    const transport = createLosslessHyperliquidInfoTransport({
      fetch: vi.fn<typeof globalThis.fetch>(() => Promise.resolve(response)),
    });

    await expect(
      transport.post(request, new AbortController().signal, callId),
    ).rejects.toBeInstanceOf(HyperliquidPrivateReaderUnavailableError);
  });

  it("enforces the streaming response byte cap", async () => {
    const transport = createLosslessHyperliquidInfoTransport({
      maxResponseBytes: 8,
      fetch: vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(jsonResponse('{"long":"payload"}')),
      ),
    });

    await expect(
      transport.post(request, new AbortController().signal, callId),
    ).rejects.toBeInstanceOf(HyperliquidPrivateReaderUnavailableError);
  });

  it("sanitizes body-stream and malformed injected fetch results", async () => {
    const brokenBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error(`body ${accountAddress}`));
      },
    });
    const transport = createLosslessHyperliquidInfoTransport({
      fetch: vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(
          new Response(brokenBody, {
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    });
    await expect(
      transport.post(request, new AbortController().signal, callId),
    ).rejects.toBeInstanceOf(HyperliquidPrivateReaderUnavailableError);

    const malformed = createLosslessHyperliquidInfoTransport({
      fetch: vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve({ ok: true } as Response),
      ),
    });
    await expect(
      malformed.post(request, new AbortController().signal, callId),
    ).rejects.toBeInstanceOf(HyperliquidPrivateReaderUnavailableError);
  });

  it("rejects a malformed internal call ID without exposing it to the provider", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const transport = createLosslessHyperliquidInfoTransport({ fetch });

    await expect(
      transport.post(request, new AbortController().signal, "not-a-uuid"),
    ).rejects.toBeInstanceOf(HyperliquidPrivateReaderUnavailableError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects invalid byte-limit configuration", () => {
    expect(() =>
      createLosslessHyperliquidInfoTransport({ maxResponseBytes: 0 }),
    ).toThrow(TypeError);
  });
});
