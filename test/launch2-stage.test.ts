import { describe, expect, it } from "vitest";

import {
  deriveLaunch2Stage,
  launch2EarlyRoundEnd,
  launch2NftSaleEnd,
} from "../src/features/launch2/launch2-stage.js";

/** Decision 0114 §2: the instance stage is derived from facts + the clock. */

const saleStart = 1_800_000_000n;
const saleEnd = saleStart + 604_800n;
const base = {
  nftSaleStart: saleStart,
  snapshotPublishedAt: null,
  graduated: false,
  holdReason: null,
} as const;

describe("launch2 stage derivation (Decision 0114)", () => {
  it("is upcoming before the NFT sale and counts down to the start", () => {
    expect(deriveLaunch2Stage({ ...base, nowSeconds: saleStart - 1n })).toEqual(
      {
        stage: "upcoming",
        nextChangeAt: saleStart,
      },
    );
  });

  it("sells NFTs for exactly 604,800 s from the signed start", () => {
    expect(launch2NftSaleEnd(saleStart)).toBe(saleEnd);
    expect(deriveLaunch2Stage({ ...base, nowSeconds: saleStart })).toEqual({
      stage: "nft_sale",
      nextChangeAt: saleEnd,
    });
    expect(deriveLaunch2Stage({ ...base, nowSeconds: saleEnd - 1n })).toEqual({
      stage: "nft_sale",
      nextChangeAt: saleEnd,
    });
  });

  it("waits for the published list after the sale with no clock", () => {
    expect(deriveLaunch2Stage({ ...base, nowSeconds: saleEnd })).toEqual({
      stage: "snapshot_pending",
      nextChangeAt: null,
    });
    expect(
      deriveLaunch2Stage({ ...base, nowSeconds: saleEnd + 86_400n * 30n }),
    ).toEqual({ stage: "snapshot_pending", nextChangeAt: null });
  });

  it("runs the priority hour from the publication, then the public curve", () => {
    const published = saleEnd + 500n;
    expect(launch2EarlyRoundEnd(published)).toBe(published + 3_600n);
    expect(
      deriveLaunch2Stage({
        ...base,
        snapshotPublishedAt: published,
        nowSeconds: published,
      }),
    ).toEqual({ stage: "priority", nextChangeAt: published + 3_600n });
    expect(
      deriveLaunch2Stage({
        ...base,
        snapshotPublishedAt: published,
        nowSeconds: published + 3_600n,
      }),
    ).toEqual({ stage: "public", nextChangeAt: null });
  });

  it("graduates immediately when a round sells out, before the hour ends", () => {
    const published = saleEnd + 10n;
    // Inside the priority hour: the last buy graduated atomically.
    expect(
      deriveLaunch2Stage({
        ...base,
        snapshotPublishedAt: published,
        graduated: true,
        nowSeconds: published + 60n,
      }),
    ).toEqual({ stage: "graduated", nextChangeAt: null });
    // In the public round as well.
    expect(
      deriveLaunch2Stage({
        ...base,
        snapshotPublishedAt: published,
        graduated: true,
        nowSeconds: published + 7_200n,
      }),
    ).toEqual({ stage: "graduated", nextChangeAt: null });
  });

  it("is paused by an integrity hold whatever the clock or graduation says", () => {
    for (const nowSeconds of [
      saleStart - 10n,
      saleStart + 10n,
      saleEnd + 10n,
    ]) {
      expect(
        deriveLaunch2Stage({
          ...base,
          nowSeconds,
          graduated: true,
          holdReason: "LAUNCH2_DEPLOYED_EVENT_MISMATCH",
        }),
      ).toEqual({ stage: "paused", nextChangeAt: null });
    }
  });
});
