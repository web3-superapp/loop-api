import { describe, expect, it, vi } from "vitest";

import {
  attachSparkline24h,
  createMarketRowSparkline24hReader,
  fillHourlySparkline24h,
  limitSparkline24h,
  marketRowSparklineWindow,
  sparkline24hFromProjection,
  type MarketRowHourlyRecord,
  type MarketRowSeriesStore,
} from "../src/features/market/market-row-sparkline24h.js";

/** Decision 0186 pure rules: window, aggregation, gap fill, two-point minimum, memo. */

const h = 3_600;
const e18 = 10n ** 18n;
/** An hour-aligned instant plus 25 minutes. */
const nowSeconds = 1_800_000_000 + 1_500;
const window = marketRowSparklineWindow(nowSeconds);

function wei(value: string): string {
  const [whole, fraction = ""] = value.split(".");
  return (
    BigInt(whole ?? "0") * e18 +
    BigInt((fraction + "0".repeat(18)).slice(0, 18))
  ).toString();
}

describe("market row sparkline24h (Decision 0186)", () => {
  it("windows the 24 UTC hours ending with the current hour", () => {
    expect(window.endBucket).toBe(1_800_000_000);
    expect(window.fromSeconds).toBe(1_800_000_000 - 23 * h);
    expect(window.toSeconds).toBe(1_800_000_000 + h);
  });

  it("keeps the last 24 points and refuses fewer than 2", () => {
    expect(limitSparkline24h([])).toBeNull();
    expect(limitSparkline24h(["1"])).toBeNull();
    expect(limitSparkline24h(["1", "2"])).toEqual(["1", "2"]);
    const thirty = Array.from({ length: 30 }, (_, i) => String(i));
    expect(limitSparkline24h(thirty)).toEqual(thirty.slice(6));
  });

  it("takes the row's own sparkline only when it is available", () => {
    expect(
      sparkline24hFromProjection({
        status: "available",
        interval: "1h",
        closes: ["747.12", "747.48", "748"],
        observedAt: "2026-10-25T00:00:00.000Z",
        source: "geckoterminal",
        quality: "stale",
      }),
    ).toEqual(["747.12", "747.48", "748"]);
    expect(
      sparkline24hFromProjection({
        status: "available",
        interval: "1h",
        closes: ["747.12"],
        observedAt: "2026-10-25T00:00:00.000Z",
        source: "geckoterminal",
        quality: "fresh",
      }),
    ).toBeNull();
    expect(
      sparkline24hFromProjection({
        status: "unavailable",
        reasonCode: "MARKET_SPARKLINE_NOT_CACHED",
      }),
    ).toBeNull();
  });

  it("fills a full day from the prior close, repeating it through empty hours", () => {
    const record: MarketRowHourlyRecord = {
      firstAt: window.fromSeconds - 10 * h,
      priorCloseE18: wei("0.5"),
      buckets: [
        { t: window.fromSeconds + 2 * h, closeE18: wei("0.6") },
        { t: window.endBucket, closeE18: wei("0.000012345") },
      ],
    };
    const series = fillHourlySparkline24h({
      record,
      fromSeconds: window.fromSeconds,
      endBucket: window.endBucket,
    });
    expect(series).toHaveLength(24);
    expect(series?.slice(0, 4)).toEqual(["0.5", "0.5", "0.6", "0.6"]);
    expect(series?.at(-2)).toBe("0.6");
    expect(series?.at(-1)).toBe("0.000012345");
  });

  it("starts at the first trade's hour for a token younger than a day", () => {
    const record: MarketRowHourlyRecord = {
      firstAt: window.endBucket - 2 * h + 59,
      priorCloseE18: null,
      buckets: [
        { t: window.endBucket - 2 * h, closeE18: wei("1") },
        { t: window.endBucket, closeE18: wei("2") },
      ],
    };
    expect(
      fillHourlySparkline24h({
        record,
        fromSeconds: window.fromSeconds,
        endBucket: window.endBucket,
      }),
    ).toEqual(["1", "1", "2"]);
  });

  it("is null when the only trades fall in the current hour", () => {
    expect(
      fillHourlySparkline24h({
        record: {
          firstAt: window.endBucket + 60,
          priorCloseE18: null,
          buckets: [{ t: window.endBucket, closeE18: wei("1") }],
        },
        fromSeconds: window.fromSeconds,
        endBucket: window.endBucket,
      }),
    ).toBeNull();
  });

  it("draws a quiet day flat at the last price, never zero", () => {
    const series = fillHourlySparkline24h({
      record: {
        firstAt: window.fromSeconds - 100 * h,
        priorCloseE18: wei("3.25"),
        buckets: [],
      },
      fromSeconds: window.fromSeconds,
      endBucket: window.endBucket,
    });
    expect(series).toEqual(Array.from({ length: 24 }, () => "3.25"));
  });

  describe("reader", () => {
    const record: MarketRowHourlyRecord = {
      firstAt: window.fromSeconds - h,
      priorCloseE18: wei("1"),
      buckets: [{ t: window.endBucket, closeE18: wei("2") }],
    };

    function store(): MarketRowSeriesStore & {
      readonly calls: (readonly string[])[];
    } {
      const calls: (readonly string[])[] = [];
      return {
        calls,
        readHourlyCloses: vi.fn<MarketRowSeriesStore["readHourlyCloses"]>(
          (input) => {
            calls.push(input.assetIds);
            expect(input.fromSeconds).toBe(window.fromSeconds);
            expect(input.toSeconds).toBe(window.toSeconds);
            return Promise.resolve(
              new Map(
                input.assetIds
                  .filter((id) => id === "meme")
                  .map((id) => [id, record] as const),
              ),
            );
          },
        ),
      };
    }

    it("reads many assets in one call and memoises inside the TTL and the hour", async () => {
      let clock = nowSeconds * 1_000;
      const source = store();
      const onRead = vi.fn();
      const reader = createMarketRowSparkline24hReader({
        store: source,
        ttlMs: 60_000,
        now: () => new Date(clock),
        onRead,
      });
      const first = await reader.read(["meme", "major", "meme"]);
      expect(source.calls).toEqual([["meme", "major"]]);
      expect(first.get("meme")).toHaveLength(24);
      expect(first.get("major")).toBeNull();
      expect(onRead).toHaveBeenCalledWith(
        expect.objectContaining({ assets: 2, withSeries: 1 }),
      );

      clock += 30_000;
      await reader.read(["meme", "major", "other"]);
      expect(source.calls).toEqual([["meme", "major"], ["other"]]);

      clock += 31_000; // past the TTL
      await reader.read(["meme"]);
      expect(source.calls.at(-1)).toEqual(["meme"]);

      // Inside the TTL but the hour rolled over: read again.
      clock = (window.endBucket + h) * 1_000 + 1;
      await reader.read(["meme"]);
      expect(source.calls).toHaveLength(4);
    });

    it("answers null without memoising when the read fails, and null without a store", async () => {
      const onReadFailed = vi.fn();
      const failing: MarketRowSeriesStore = {
        readHourlyCloses: vi
          .fn<MarketRowSeriesStore["readHourlyCloses"]>()
          .mockRejectedValueOnce(new Error("db down"))
          .mockResolvedValue(new Map([["meme", record]])),
      };
      const reader = createMarketRowSparkline24hReader({
        store: failing,
        ttlMs: 60_000,
        now: () => new Date(nowSeconds * 1_000),
        onReadFailed,
      });
      expect((await reader.read(["meme"])).get("meme")).toBeNull();
      expect(onReadFailed).toHaveBeenCalledOnce();
      expect((await reader.read(["meme"])).get("meme")).toHaveLength(24);

      const none = createMarketRowSparkline24hReader({
        store: null,
        ttlMs: 60_000,
      });
      expect((await none.read(["meme"])).get("meme")).toBeNull();
    });

    it("attaches the own sparkline first and reads the chain only for the rest", async () => {
      const source = store();
      const reader = createMarketRowSparkline24hReader({
        store: source,
        ttlMs: 60_000,
        now: () => new Date(nowSeconds * 1_000),
      });
      const rows = await attachSparkline24h(
        [
          {
            assetId: "major",
            sparkline: {
              status: "available",
              interval: "1h",
              closes: ["1", "2"],
              observedAt: "2026-10-25T00:00:00.000Z",
              source: "geckoterminal",
              quality: "fresh",
            },
          },
          {
            assetId: "meme",
            sparkline: {
              status: "unavailable",
              reasonCode: "MEME_CURVE_SPARKLINE_UNAVAILABLE",
            },
          },
          {
            assetId: "none",
            sparkline: {
              status: "unavailable",
              reasonCode: "MARKET_CHAIN_NOT_PRICED",
            },
          },
        ] as const,
        reader,
      );
      expect(source.calls).toEqual([["meme", "none"]]);
      expect(rows.map((row) => row.sparkline24h?.length ?? null)).toEqual([
        2,
        24,
        null,
      ]);
      expect(rows[0]?.sparkline24h).toEqual(["1", "2"]);
    });
  });
});
