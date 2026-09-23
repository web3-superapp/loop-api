import { describe, expect, it, vi } from "vitest";

import {
  MarketFactCacheUnavailableError,
  type MarketFactCacheRecord,
  type MarketFactCacheRepository,
} from "../src/database/market-fact-cache-repository.js";
import {
  projectRange24h,
  projectSparkline,
  readSparklineRows,
  sparklineRowFromCandles,
} from "../src/features/market/market-sparkline.js";

const wbnb = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const poolAddress = "0x36696169c63e42cd08ce11f5deebbcebae652050";
const fetchedAt = "2026-09-23T11:00:00.000Z";

function row(
  overrides: Partial<MarketFactCacheRecord> = {},
): MarketFactCacheRecord {
  return {
    subjectKey: `token:${wbnb}`,
    factKind: "sparkline_1h",
    source: "geckoterminal",
    value: {
      interval: "1h",
      poolAddress,
      poolOrigin: "registry",
      poolChosenAt: fetchedAt,
      closes: ["747.12", "747.48"],
      candleCount: 2,
      high: "748.9",
      low: "746.5",
    },
    rawDigest: "c".repeat(64),
    fetchedAt,
    ttlSeconds: 300,
    ...overrides,
  };
}

const at = (seconds: number): number => Date.parse(fetchedAt) + seconds * 1_000;

describe("market row sparkline projection (Decision 0074)", () => {
  it("is not cached without a row and is fresh inside the TTL", () => {
    expect(
      projectSparkline({
        record: null,
        nowMs: at(1),
        staleGraceSeconds: 900,
        proxied: false,
      }),
    ).toEqual({
      status: "unavailable",
      reasonCode: "MARKET_SPARKLINE_NOT_CACHED",
    });
    expect(
      projectSparkline({
        record: row(),
        nowMs: at(299),
        staleGraceSeconds: 900,
        proxied: false,
      }),
    ).toEqual({
      status: "available",
      interval: "1h",
      closes: ["747.12", "747.48"],
      observedAt: fetchedAt,
      source: "geckoterminal",
      quality: "fresh",
    });
  });

  it("is stale inside the grace window and expired past it", () => {
    expect(
      projectSparkline({
        record: row(),
        nowMs: at(300),
        staleGraceSeconds: 900,
        proxied: false,
      }),
    ).toMatchObject({ status: "available", quality: "stale" });
    expect(
      projectSparkline({
        record: row(),
        nowMs: at(1_200),
        staleGraceSeconds: 900,
        proxied: false,
      }),
    ).toEqual({
      status: "unavailable",
      reasonCode: "MARKET_SPARKLINE_EXPIRED",
    });
    // A row from the future is not trusted either.
    expect(
      projectSparkline({
        record: row(),
        nowMs: at(-1),
        staleGraceSeconds: 900,
        proxied: false,
      }),
    ).toMatchObject({ reasonCode: "MARKET_SPARKLINE_EXPIRED" });
  });

  it("labels the native asset's row proxied, never stale", () => {
    expect(
      projectSparkline({
        record: row(),
        nowMs: at(600),
        staleGraceSeconds: 900,
        proxied: true,
      }),
    ).toMatchObject({ status: "available", quality: "proxied" });
  });

  it("publishes no line for a pool the Provider answered without candles, and none for a row it cannot read", () => {
    expect(
      projectSparkline({
        record: row({
          value: {
            interval: "1h",
            poolAddress,
            poolOrigin: "provider",
            poolChosenAt: fetchedAt,
            closes: [],
            candleCount: 0,
            high: null,
            low: null,
          },
        }),
        nowMs: at(1),
        staleGraceSeconds: 900,
        proxied: false,
      }),
    ).toEqual({ status: "unavailable", reasonCode: "MARKET_SPARKLINE_EMPTY" });
    expect(
      projectSparkline({
        record: row({ value: { closes: [1, 2] } }),
        nowMs: at(1),
        staleGraceSeconds: 900,
        proxied: false,
      }),
    ).toEqual({
      status: "unavailable",
      reasonCode: "MARKET_SPARKLINE_NOT_CACHED",
    });
  });

  it("keeps only the last 24 closes of a longer series, oldest first", () => {
    const candles = Array.from({ length: 30 }, (_, index) => ({
      openTime: new Date(Date.UTC(2026, 8, 22, index)).toISOString(),
      open: String(index),
      high: String(index),
      low: String(index),
      close: `${String(index)}.5`,
      volume: "1",
    }));
    const value = sparklineRowFromCandles({
      poolAddress,
      poolOrigin: "provider",
      poolChosenAt: fetchedAt,
      snapshot: { poolAddress, candles },
    });
    expect(value.closes).toHaveLength(24);
    expect(value.closes[0]).toBe("6.5");
    expect(value.closes[23]).toBe("29.5");
    expect(value.candleCount).toBe(24);
    // The range covers the kept 24 candles only, compared as decimals.
    expect(value.high).toBe("29");
    expect(value.low).toBe("6");
    expect(
      sparklineRowFromCandles({
        poolAddress,
        poolOrigin: "provider",
        poolChosenAt: fetchedAt,
        snapshot: {
          poolAddress,
          candles: [
            { ...candles[0]!, high: "9.5", low: "0.25" },
            { ...candles[1]!, high: "10", low: "0.3" },
          ],
        },
      }),
    ).toMatchObject({ high: "10", low: "0.25", candleCount: 2 });
  });

  it("projects the 24h range from the same row with the same freshness and reasons", () => {
    expect(
      projectRange24h({
        record: row(),
        nowMs: at(10),
        staleGraceSeconds: 900,
        proxied: false,
      }),
    ).toEqual({
      status: "available",
      high: "748.9",
      low: "746.5",
      bars: 2,
      observedAt: fetchedAt,
      source: "geckoterminal",
      quality: "fresh",
    });
    expect(
      projectRange24h({
        record: row(),
        nowMs: at(600),
        staleGraceSeconds: 900,
        proxied: true,
      }),
    ).toMatchObject({ status: "available", quality: "proxied" });
    expect(
      projectRange24h({
        record: null,
        nowMs: at(1),
        staleGraceSeconds: 900,
        proxied: false,
      }),
    ).toEqual({
      status: "unavailable",
      reasonCode: "MARKET_SPARKLINE_NOT_CACHED",
    });
    expect(
      projectRange24h({
        record: row({
          value: {
            ...row().value,
            closes: [],
            candleCount: 0,
            high: null,
            low: null,
          },
        }),
        nowMs: at(1),
        staleGraceSeconds: 900,
        proxied: false,
      }),
    ).toEqual({ status: "unavailable", reasonCode: "MARKET_SPARKLINE_EMPTY" });
    expect(
      projectRange24h({
        record: row(),
        nowMs: at(1_300),
        staleGraceSeconds: 900,
        proxied: false,
      }),
    ).toEqual({
      status: "unavailable",
      reasonCode: "MARKET_SPARKLINE_EXPIRED",
    });
  });

  it("reads every row in one query and answers null when the cache is unavailable", async () => {
    const getMany = vi.fn<MarketFactCacheRepository["getMany"]>(() =>
      Promise.resolve(new Map([[`token:${wbnb}`, row()]])),
    );
    const cache: MarketFactCacheRepository = {
      get: vi.fn(() => Promise.reject(new Error("not used"))),
      getMany,
      put: vi.fn(() => Promise.reject(new Error("not used"))),
      findVerifiedCommunityByAssetId: vi.fn(() => Promise.resolve(null)),
    };
    const rows = await readSparklineRows(cache, [wbnb, "0x" + "1".repeat(40)]);
    expect(getMany).toHaveBeenCalledTimes(1);
    expect(getMany).toHaveBeenCalledWith(
      [`token:${wbnb}`, `token:0x${"1".repeat(40)}`],
      "sparkline_1h",
      "geckoterminal",
    );
    expect(rows?.get(wbnb)?.fetchedAt).toBe(fetchedAt);
    expect(rows?.has("0x" + "1".repeat(40))).toBe(false);

    const broken: MarketFactCacheRepository = {
      ...cache,
      getMany: vi.fn(() =>
        Promise.reject(new MarketFactCacheUnavailableError()),
      ),
    };
    await expect(readSparklineRows(broken, [wbnb])).resolves.toBeNull();
    await expect(readSparklineRows(cache, [])).resolves.toEqual(new Map());
  });
});
