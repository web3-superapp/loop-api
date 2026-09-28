import { describe, expect, it } from "vitest";

import {
  formatRouteLatency,
  parseArguments,
  parseCompletedRequest,
  summarizeRouteLatency,
} from "../scripts/route-latency.js";

function completed(route: string, ms: number, method = "GET"): string {
  return JSON.stringify({
    level: 30,
    msg: "Request completed",
    requestId: "r",
    method,
    route,
    statusCode: 200,
    responseTimeMs: ms,
  });
}

describe("route latency script (Decision 0088)", () => {
  it("reads only completed requests, through ANSI colours and prefixes", () => {
    expect(
      parseCompletedRequest(
        `[12:00:00] \u001b[32mINFO\u001b[39m ${completed("/v2/wallets", 12.5)}`,
      ),
    ).toEqual({ method: "GET", route: "/v2/wallets", responseTimeMs: 12.5 });
    expect(
      parseCompletedRequest(
        JSON.stringify({ msg: "Request received", method: "GET", route: "/x" }),
      ),
    ).toBeNull();
    // pino-pretty: the message is printed before the object.
    expect(
      parseCompletedRequest(
        '[18:16:41.195] \u001b[32mINFO\u001b[39m (30991): \u001b[36mRequest completed\u001b[39m \u001b[90m{"method":"GET","route":"/v2/wallets","statusCode":200,"responseTimeMs":10.6}\u001b[39m',
      ),
    ).toEqual({ method: "GET", route: "/v2/wallets", responseTimeMs: 10.6 });
    expect(
      parseCompletedRequest(
        '[18:16:41.195] INFO (30991): Request received {"method":"GET","route":"/v2/wallets","responseTimeMs":10.6}',
      ),
    ).toBeNull();
    expect(parseCompletedRequest("no json here")).toBeNull();
    expect(parseCompletedRequest("{ not json")).toBeNull();
    expect(parseCompletedRequest(completed("/health/live", 1))).toBeNull();
  });

  it("summarizes per method and route with the ops percentile rule, slowest p95 first", () => {
    const lines = [
      ...[100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].map((ms) =>
        completed("/v2/communities/:communityId", ms),
      ),
      completed("/v2/chain/status", 2_000),
      completed("/v2/communities/:communityId", 50, "PATCH"),
      "garbage",
    ];
    const rows = summarizeRouteLatency(lines);
    expect(rows[0]).toEqual({
      method: "GET",
      route: "/v2/chain/status",
      count: 1,
      p50Ms: 2_000,
      p95Ms: 2_000,
      maxMs: 2_000,
    });
    // n = 10: p50 = sorted[5], p95 = sorted[floor(9.5) - 1] = sorted[8].
    expect(rows[1]).toEqual({
      method: "GET",
      route: "/v2/communities/:communityId",
      count: 10,
      p50Ms: 600,
      p95Ms: 900,
      maxMs: 1_000,
    });
    expect(rows).toHaveLength(3);
    expect(
      summarizeRouteLatency(lines, { routeFilter: "/v2/chain" }),
    ).toHaveLength(1);
  });

  it("formats a bounded table and parses its arguments", () => {
    const text = formatRouteLatency(
      summarizeRouteLatency([completed("/v2/a", 5), completed("/v2/b", 7)]),
      1,
    );
    expect(text.trimEnd().split("\n")).toHaveLength(2);
    expect(text).toContain("GET /v2/b");
    expect(
      parseArguments(["--top", "5", "--route", "/v2/w", "a.log", "b.log"]),
    ).toEqual({ files: ["a.log", "b.log"], top: 5, routeFilter: "/v2/w" });
    expect(() => parseArguments(["--top", "0"])).toThrow(RangeError);
    expect(() => parseArguments(["--route"])).toThrow(RangeError);
  });
});
