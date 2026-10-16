import { describe, expect, it, vi } from "vitest";

import { loadReconciliationWorkerConfig } from "../src/config.js";
import type {
  FiatFxRateRecord,
  FiatFxRateRepository,
} from "../src/database/fiat-fx-rate-repository.js";
import { createFiatFxRateLane } from "../src/fiat-fx-rate-worker.js";
import {
  createWalletNetWorthHistoryService,
  projectFiat,
} from "../src/features/wallet/wallet-networth-history.js";
import {
  canonicalFiatFxRate,
  createFrankfurterFiatFxProvider,
  FiatFxProviderError,
  fiatFxSourceFromUrl,
  type FiatFxProvider,
} from "../src/integrations/fx/frankfurter-adapter.js";
import type { ProviderFetch } from "../src/integrations/market/provider-http.js";

const defaultUrl = "https://api.frankfurter.dev/v2/providers/ecb/rate/USD/CNY";
const hourMs = 3_600_000;

function answering(status: number, body: string): ProviderFetch {
  return vi.fn(() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(body),
    }),
  );
}

function provider(fetch: ProviderFetch, timeoutMs?: number): FiatFxProvider {
  return createFrankfurterFiatFxProvider({
    url: defaultUrl,
    base: "USD",
    quote: "CNY",
    fetch,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(FiatFxProviderError);
    return (error as FiatFxProviderError).reasonCode;
  }
  throw new Error("expected a rejection");
}

describe("Decision 0149 Frankfurter FX adapter", () => {
  it("reads one observation losslessly (object and array forms)", async () => {
    const fetch = answering(
      200,
      '{"date":"2026-10-15","base":"USD","quote":"CNY","rate":6.6910}',
    );
    await expect(provider(fetch).readRate()).resolves.toEqual({
      base: "USD",
      quote: "CNY",
      rate: "6.691",
      source: "ecb",
      providerAsOf: "2026-10-15",
    });
    expect(fetch).toHaveBeenCalledWith(
      defaultUrl,
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          accept: "application/json",
        }) as unknown,
      }),
    );
    await expect(
      provider(
        answering(
          200,
          '[{"date":"2026-10-16","base":"USD","quote":"CNY","rate":6.686612345678}]',
        ),
      ).readRate(),
    ).resolves.toMatchObject({ rate: "6.686612345678" });
  });

  it("treats malformed bodies as failures", async () => {
    for (const body of [
      "not json",
      "[]",
      "null",
      '{"date":"2026-10-15","base":"USD","quote":"CNY","rate":"abc"}',
      '{"date":"2026-10-15","base":"USD","quote":"CNY","rate":true}',
      '{"date":"2026-10-15","base":"USD","quote":"CNY","rate":0}',
      '{"date":"2026-10-15","base":"USD","quote":"CNY","rate":-6.69}',
      '{"date":"2026-10-15","base":"USD","quote":"CNY","rate":1000.5}',
      '{"date":"2026-10-15","base":"USD","quote":"CNY","rate":6.69e0}',
      '{"date":"2026-10-15","base":"USD","quote":"CNY","rate":6.1234567890123}',
      '{"date":"2026-10-15","base":"USD","quote":"CNY"}',
      '{"date":"2026-02-30","base":"USD","quote":"CNY","rate":6.69}',
      '{"date":"15/10/2026","base":"USD","quote":"CNY","rate":6.69}',
      '{"date":"2026-10-15","base":"EUR","quote":"CNY","rate":7.8}',
      '[{"date":"2026-10-15","base":"USD","quote":"CNY","rate":6.69},{"date":"2026-10-14","base":"USD","quote":"CNY","rate":6.7}]',
    ]) {
      expect(
        await reasonOf(provider(answering(200, body)).readRate()),
        body,
      ).toBe("FIAT_FX_PROVIDER_RESPONSE_MALFORMED");
    }
  });

  it("maps non-200 answers, 429 and an unreachable provider", async () => {
    expect(await reasonOf(provider(answering(422, "{}")).readRate())).toBe(
      "FIAT_FX_PROVIDER_REQUEST_REJECTED",
    );
    expect(await reasonOf(provider(answering(500, "")).readRate())).toBe(
      "FIAT_FX_PROVIDER_REQUEST_REJECTED",
    );
    expect(await reasonOf(provider(answering(429, "")).readRate())).toBe(
      "FIAT_FX_PROVIDER_RATE_LIMITED",
    );
    const down: ProviderFetch = () =>
      Promise.reject(new TypeError("fetch failed"));
    expect(await reasonOf(provider(down).readRate())).toBe(
      "FIAT_FX_PROVIDER_UNREACHABLE",
    );
  });

  it("aborts a hanging request at the timeout", async () => {
    const hanging: ProviderFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    const started = Date.now();
    expect(await reasonOf(provider(hanging, 50).readRate())).toBe(
      "FIAT_FX_PROVIDER_UNREACHABLE",
    );
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("canonicalises rates and derives the source from the URL", () => {
    expect(canonicalFiatFxRate("6.6910")).toBe("6.691");
    expect(canonicalFiatFxRate("1000")).toBe("1000");
    expect(canonicalFiatFxRate("1000.0")).toBe("1000");
    expect(canonicalFiatFxRate("0.00001")).toBe("0.00001");
    for (const bad of ["0", "0.0", "1000.01", "01", "-1", "1e3", "", 6.69]) {
      expect(canonicalFiatFxRate(bad), String(bad)).toBeNull();
    }
    expect(fiatFxSourceFromUrl(defaultUrl)).toBe("ecb");
    expect(
      fiatFxSourceFromUrl(
        "https://api.frankfurter.dev/v2/providers/CFETS/rates?base=USD&quotes=CNY",
      ),
    ).toBe("cfets");
    expect(
      fiatFxSourceFromUrl("https://api.frankfurter.dev/v2/rates?base=USD"),
    ).toBeNull();
    expect(() =>
      createFrankfurterFiatFxProvider({
        url: "https://api.frankfurter.dev/v2/rates",
        base: "USD",
        quote: "CNY",
      }),
    ).toThrow();
  });
});

describe("Decision 0149 fiat_fx_rate lane", () => {
  const observation = {
    base: "USD",
    quote: "CNY",
    rate: "6.691",
    source: "ecb",
    providerAsOf: "2026-10-15",
  };

  function repository() {
    const recordRate = vi.fn<(record: FiatFxRateRecord) => Promise<void>>(() =>
      Promise.resolve(),
    );
    return { recordRate };
  }

  it("records a successful read with source, provider date and fetch time", async () => {
    const repo = repository();
    const lane = createFiatFxRateLane({
      repository: repo,
      provider: { source: "ecb", readRate: () => Promise.resolve(observation) },
      refreshMs: hourMs,
      now: () => new Date("2026-10-16T04:00:00.000Z"),
    });
    expect(await lane.runOnce()).toEqual({
      written: true,
      reasonCode: null,
      quality: "fresh",
    });
    expect(repo.recordRate).toHaveBeenCalledWith({
      ...observation,
      fetchedAt: "2026-10-16T04:00:00.000Z",
      quality: "fresh",
    });
  });

  it("records an old provider date as stale and refuses a future one", async () => {
    const repo = repository();
    let providerAsOf = "2026-10-10";
    const lane = createFiatFxRateLane({
      repository: repo,
      provider: {
        source: "ecb",
        readRate: () => Promise.resolve({ ...observation, providerAsOf }),
      },
      refreshMs: hourMs,
      now: () => new Date("2026-10-16T04:00:00.000Z"),
    });
    expect(await lane.runOnce()).toMatchObject({ quality: "stale" });
    providerAsOf = "2026-10-11"; // five days: a long holiday is still fresh
    expect(await lane.runOnce()).toMatchObject({ quality: "fresh" });
    providerAsOf = "2026-10-18";
    expect(await lane.runOnce()).toEqual({
      written: false,
      reasonCode: "FIAT_FX_PROVIDER_RESPONSE_MALFORMED",
      quality: null,
    });
    expect(repo.recordRate).toHaveBeenCalledTimes(2);
  });

  it("writes nothing when the provider fails and reports the reason code", async () => {
    const repo = repository();
    const onPass = vi.fn();
    const lane = createFiatFxRateLane({
      repository: repo,
      provider: provider(answering(200, '{"rate":"x"}')),
      refreshMs: hourMs,
      onPass,
    });
    expect(await lane.runOnce()).toMatchObject({
      written: false,
      reasonCode: "FIAT_FX_PROVIDER_RESPONSE_MALFORMED",
    });
    expect(repo.recordRate).not.toHaveBeenCalled();
    expect(onPass).toHaveBeenCalledWith(
      expect.objectContaining({ written: false }),
    );
  });

  it("retries a provider failure after 60 s, doubling up to the refresh interval", () => {
    const lane = createFiatFxRateLane({
      repository: repository(),
      provider: { source: "ecb", readRate: () => Promise.resolve(observation) },
      refreshMs: hourMs,
    });
    expect(lane.nextDelayMs(0)).toBe(hourMs);
    expect(lane.nextDelayMs(1)).toBe(60_000);
    expect(lane.nextDelayMs(2)).toBe(120_000);
    expect(lane.nextDelayMs(6)).toBe(1_920_000);
    expect(lane.nextDelayMs(7)).toBe(hourMs);
    expect(lane.nextDelayMs(50)).toBe(hourMs);
  });

  it("runs: waits the refresh interval after a write, backs off provider and database failures", async () => {
    const controller = new AbortController();
    const waits: number[] = [];
    const answers: (() => Promise<typeof observation>)[] = [
      () =>
        Promise.reject(new FiatFxProviderError("FIAT_FX_PROVIDER_UNREACHABLE")),
      () =>
        Promise.reject(new FiatFxProviderError("FIAT_FX_PROVIDER_UNREACHABLE")),
      () => Promise.resolve(observation),
      () => Promise.resolve(observation),
      () => Promise.resolve(observation),
    ];
    const recordRate = vi
      .fn<(record: FiatFxRateRecord) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValue(undefined);
    const backoff = vi.fn();
    const lane = createFiatFxRateLane({
      repository: { recordRate },
      provider: {
        source: "ecb",
        readRate: () =>
          (answers.shift() ?? (() => Promise.resolve(observation)))(),
      },
      refreshMs: hourMs,
      now: () => new Date("2026-10-16T04:00:00.000Z"),
      wait: (delay) => {
        waits.push(delay);
        if (waits.length >= 5) {
          controller.abort();
        }
        return Promise.resolve();
      },
      onInfrastructureBackoff: backoff,
    });
    await lane.run(controller.signal);
    // fail, fail, write, database error, write.
    expect(waits).toEqual([60_000, 120_000, hourMs, 1_000, hourMs]);
    expect(backoff).toHaveBeenCalledWith(
      expect.objectContaining({
        lane: "fiat_fx_rate",
        consecutiveFailureCount: 1,
        retryDelayMs: 1_000,
      }),
    );
    expect(recordRate).toHaveBeenCalledTimes(3);
  });

  it("does not report a read cut short by shutdown", async () => {
    const controller = new AbortController();
    const onPass = vi.fn();
    const lane = createFiatFxRateLane({
      repository: { recordRate: vi.fn(() => Promise.resolve()) },
      provider: {
        source: "ecb",
        readRate: () => {
          controller.abort();
          return Promise.reject(
            new FiatFxProviderError("FIAT_FX_PROVIDER_UNREACHABLE"),
          );
        },
      },
      refreshMs: hourMs,
      onPass,
    });
    await lane.run(controller.signal);
    expect(onPass).not.toHaveBeenCalled();
  });
});

describe("Decision 0149 history fiat block", () => {
  const rate: FiatFxRateRecord = {
    base: "USD",
    quote: "CNY",
    rate: "7.113",
    source: "ecb",
    providerAsOf: "2026-10-15",
    fetchedAt: "2026-10-16T04:00:00.000Z",
    quality: "fresh",
  };

  it("is fresh up to 26 h after the fetch, stale after, null without a rate", () => {
    const at = (ms: number) => new Date(Date.parse(rate.fetchedAt) + ms);
    expect(projectFiat("6352.815", rate, at(hourMs))).toEqual({
      currency: "CNY",
      rate: "7.113",
      amount: "45187.57",
      source: "ecb",
      asOf: "2026-10-15",
      fetchedAt: "2026-10-16T04:00:00.000Z",
      quality: "fresh",
    });
    expect(projectFiat("6352.815", rate, at(26 * hourMs))?.quality).toBe(
      "fresh",
    );
    expect(projectFiat("6352.815", rate, at(26 * hourMs + 1))?.quality).toBe(
      "stale",
    );
    expect(
      projectFiat("6352.815", { ...rate, quality: "stale" }, at(hourMs))
        ?.quality,
    ).toBe("stale");
    expect(projectFiat("6352.815", null, at(hourMs))).toBeNull();
    // Half away from zero at 2 places: 0.005 × 1 → 0.01.
    expect(
      projectFiat("0.005", { ...rate, rate: "1" }, at(hourMs))?.amount,
    ).toBe("0.01");
  });

  it("reads the latest USD/CNY rate per request; a failed read publishes null", async () => {
    const walletId = "11111111-1111-4111-8111-111111111111";
    const wallets = {
      get: vi.fn(() => Promise.resolve({ walletId, address: "0x1" } as never)),
    };
    const snapshots = {
      listSnapshotCandidates: vi.fn(),
      recordSnapshots: vi.fn(),
      readDownsampled: vi.fn(() => Promise.resolve([])),
      readExtremes: vi.fn(() => Promise.resolve({ high: null, low: null })),
      readLatest: vi.fn(() => Promise.resolve(null)),
    };
    const now = new Date("2026-10-16T12:00:00.000Z");
    const readLatest = vi
      .fn<FiatFxRateRepository["readLatest"]>()
      .mockResolvedValueOnce(rate)
      .mockResolvedValueOnce({ ...rate, fetchedAt: "2026-10-14T00:00:00.000Z" })
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("relation does not exist"));
    const service = createWalletNetWorthHistoryService({
      wallets,
      snapshots,
      measure: () =>
        Promise.resolve({
          netWorthUsd: "100",
          quality: "fresh" as const,
          unavailableCount: 0,
          asOf: now.toISOString(),
        }),
      fiatRates: { readLatest },
      now: () => now,
    });
    const read = async () =>
      (
        await service.getHistory({
          principal: { userId: "u" },
          walletId,
          range: "1d",
          signal: new AbortController().signal,
        })
      ).fiat;
    expect(await read()).toMatchObject({ amount: "711.3", quality: "fresh" });
    expect(await read()).toMatchObject({ quality: "stale" });
    expect(await read()).toBeNull();
    expect(await read()).toBeNull();
    expect(readLatest).toHaveBeenCalledWith({ base: "USD", quote: "CNY" });
  });
});

describe("Decision 0149 configuration", () => {
  const workerBase = {
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL:
      "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
  };

  it("defaults to the ECB reference rate hourly, and can be turned off", () => {
    expect(loadReconciliationWorkerConfig(workerBase).fiatFxRate).toEqual({
      providerUrl: defaultUrl,
      source: "ecb",
      base: "USD",
      quote: "CNY",
      refreshMs: hourMs,
    });
    expect(
      loadReconciliationWorkerConfig({
        ...workerBase,
        FIAT_FX_RATE_ENABLED: "false",
      }).fiatFxRate,
    ).toBeNull();
    expect(
      loadReconciliationWorkerConfig({
        ...workerBase,
        FIAT_FX_PROVIDER_URL:
          "https://api.frankfurter.dev/v2/providers/cfets/rate/USD/CNY",
        FIAT_FX_REFRESH_SECONDS: "600",
      }).fiatFxRate,
    ).toMatchObject({ source: "cfets", refreshMs: 600_000 });
  });

  it("refuses a non-https URL, one without a provider, and an out-of-range refresh", () => {
    for (const bad of [
      {
        FIAT_FX_PROVIDER_URL:
          "http://api.frankfurter.dev/v2/providers/ecb/rate/USD/CNY",
      },
      { FIAT_FX_PROVIDER_URL: "https://api.frankfurter.dev/v2/rates?base=USD" },
      {
        FIAT_FX_PROVIDER_URL:
          "https://u:p@api.frankfurter.dev/v2/providers/ecb/rate/USD/CNY",
      },
      { FIAT_FX_PROVIDER_URL: "not a url" },
      { FIAT_FX_REFRESH_SECONDS: "59" },
      { FIAT_FX_REFRESH_SECONDS: "86401" },
    ]) {
      expect(
        () => loadReconciliationWorkerConfig({ ...workerBase, ...bad }),
        JSON.stringify(bad),
      ).toThrow();
    }
  });
});
