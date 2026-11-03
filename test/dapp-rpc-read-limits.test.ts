import {
  HttpRequestError,
  LimitExceededRpcError,
  RpcRequestError,
  TimeoutError,
} from "viem";
import { describe, expect, it } from "vitest";

import { createTokenBucket } from "../src/core/http/token-bucket.js";
import { classifyRelayReadError } from "../src/integrations/bsc/rpc-client.js";

/**
 * S346 (Decision 0197 amendment, findings A3 / A7): the rpc-read proxy's
 * process-wide token bucket and the classification of a relayed read's
 * failure — provider quota / rate refusals become `limited` (503
 * RPC_UPSTREAM_LIMITED) and nothing of the provider's text is passed on.
 */

function rpcError(code: number, message: string, data?: unknown) {
  return new RpcRequestError({
    body: { method: "eth_call" },
    error: { code, message, ...(data === undefined ? {} : { data }) },
    url: "https://rpc.example.invalid/key-secret",
  });
}

describe("classifyRelayReadError (S346 A7)", () => {
  it("maps quota and rate refusals to limited", () => {
    for (const error of [
      rpcError(-32005, "limit exceeded"),
      rpcError(-32016, "over rate limit"),
      rpcError(429, "Too Many Requests"),
      rpcError(-32000, "daily request count exceeded, request rate limited"),
      rpcError(-32603, "monthly quota exhausted for key abc"),
      new LimitExceededRpcError(rpcError(-32005, "limit exceeded")),
      new HttpRequestError({
        url: "https://rpc.example.invalid/key-secret",
        status: 429,
        details: "Too Many Requests",
      }),
    ]) {
      expect(classifyRelayReadError(error)).toEqual({ status: "limited" });
    }
  });

  it("passes a revert through with its hex data", () => {
    expect(
      classifyRelayReadError(
        rpcError(3, "execution reverted: not owner", "0x08c379a0"),
      ),
    ).toEqual({
      status: "error",
      error: {
        code: 3,
        message: "execution reverted: not owner",
        data: "0x08c379a0",
      },
    });
    expect(
      classifyRelayReadError(
        rpcError(-32000, "insufficient funds for gas * price + value"),
      ),
    ).toMatchObject({
      status: "error",
      error: { message: "insufficient funds for gas * price + value" },
    });
  });

  it("replaces provider text and drops non-hex data", () => {
    const outcome = classifyRelayReadError(
      rpcError(-32601, "Upgrade to Pro at nodereal.io for this method", {
        plan: "free",
      }),
    );
    expect(outcome).toEqual({
      status: "error",
      error: { code: -32601, message: "RPC request failed", data: null },
    });
    expect(JSON.stringify(outcome)).not.toContain("nodereal");
  });

  it("returns null for transport failures", () => {
    expect(
      classifyRelayReadError(
        new TimeoutError({ body: {}, url: "https://rpc.example.invalid" }),
      ),
    ).toBeNull();
    expect(
      classifyRelayReadError(
        new HttpRequestError({
          url: "https://rpc.example.invalid",
          status: 502,
        }),
      ),
    ).toBeNull();
    expect(classifyRelayReadError(new Error("boom"))).toBeNull();
  });
});

describe("createTokenBucket (S346 A3)", () => {
  it("allows a burst of perMinute and refills evenly", () => {
    let now = 0;
    const bucket = createTokenBucket({ perMinute: 60, nowMs: () => now });
    for (let index = 0; index < 60; index += 1) {
      expect(bucket.take()).toBe(true);
    }
    expect(bucket.take()).toBe(false);
    now += 999;
    expect(bucket.take()).toBe(false);
    now += 1;
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
    // A long quiet period refills only up to the capacity.
    now += 3_600_000;
    for (let index = 0; index < 60; index += 1) {
      expect(bucket.take()).toBe(true);
    }
    expect(bucket.take()).toBe(false);
    // A clock that steps back neither refills nor breaks the bucket.
    now -= 10_000;
    expect(bucket.take()).toBe(false);
  });
});
