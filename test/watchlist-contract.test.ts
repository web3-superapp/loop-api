import { describe, expect, it } from "vitest";

import {
  InvalidWatchlistContractError,
  emptyWatchlistSnapshot,
  parseWatchlistReplaceRequest,
  parseWatchlistSnapshot,
  watchlistGroupsEqual,
  WATCHLIST_MAX_GROUPS,
  WATCHLIST_MAX_ITEMS,
} from "../src/features/watchlist/watchlist-contract.js";

function item(index: number) {
  return { asset_key: `ASSET_${index}` };
}

function validRequest(overrides: Record<string, unknown> = {}): unknown {
  return {
    expected_version: 0,
    groups: [
      {
        key: "favorites",
        name: "Favorites",
        items: [{ asset_key: "BTC" }, { asset_key: "ETH:PERP" }],
      },
      {
        key: "alts_1",
        name: "山寨币",
        items: [{ asset_key: "SOL" }],
      },
    ],
    ...overrides,
  };
}

function expectInvalid(action: () => unknown): void {
  expect(action).toThrow(InvalidWatchlistContractError);
  try {
    action();
  } catch (error) {
    expect(error).toEqual(
      expect.objectContaining({
        code: "invalid_watchlist_contract",
        message: "The Watchlist contract value is invalid",
      }),
    );
  }
}

function expectDeepFrozen(value: unknown): void {
  if (typeof value !== "object" || value === null) {
    return;
  }
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) {
    expectDeepFrozen(child);
  }
}

describe("Watchlist contract", () => {
  it("normalizes display names, preserves canonical order, and deeply freezes input", () => {
    const parsed = parseWatchlistReplaceRequest(
      validRequest({
        expected_version: 7,
        groups: [
          {
            key: "favorites",
            name: "  重点关注  ",
            items: [{ asset_key: "ETH" }, { asset_key: "BTC" }],
          },
          { key: "empty", name: "Empty", items: [] },
        ],
      }),
    );

    expect(parsed).toEqual({
      expected_version: 7,
      groups: [
        {
          key: "favorites",
          name: "重点关注",
          items: [{ asset_key: "ETH" }, { asset_key: "BTC" }],
        },
        { key: "empty", name: "Empty", items: [] },
      ],
    });
    expectDeepFrozen(parsed);
  });

  it("counts Unicode code points instead of UTF-16 code units", () => {
    expect(
      parseWatchlistReplaceRequest(
        validRequest({
          groups: [{ key: "emoji", name: "😀".repeat(40), items: [] }],
        }),
      ).groups[0]?.name,
    ).toBe("😀".repeat(40));

    expectInvalid(() =>
      parseWatchlistReplaceRequest(
        validRequest({
          groups: [{ key: "emoji", name: "😀".repeat(41), items: [] }],
        }),
      ),
    );
  });

  it.each([
    ["empty display name", { groups: [{ key: "x", name: "   ", items: [] }] }],
    [
      "control character",
      { groups: [{ key: "x", name: "bad\nname", items: [] }] },
    ],
    [
      "trimmed control character",
      { groups: [{ key: "x", name: "\tname", items: [] }] },
    ],
    [
      "bidirectional override",
      { groups: [{ key: "x", name: "safe\u202eevil", items: [] }] },
    ],
    [
      "unpaired surrogate",
      { groups: [{ key: "x", name: "bad\ud800", items: [] }] },
    ],
    ["invalid group key", { groups: [{ key: "Bad", name: "x", items: [] }] }],
    [
      "invalid asset key",
      {
        groups: [{ key: "x", name: "x", items: [{ asset_key: "eth/usd" }] }],
      },
    ],
    [
      "duplicate group key",
      {
        groups: [
          { key: "same", name: "A", items: [] },
          { key: "same", name: "B", items: [] },
        ],
      },
    ],
    [
      "duplicate asset in one group",
      {
        groups: [
          {
            key: "x",
            name: "x",
            items: [{ asset_key: "BTC" }, { asset_key: "BTC" }],
          },
        ],
      },
    ],
    ["fractional version", { expected_version: 1.5 }],
    ["negative version", { expected_version: -1 }],
    ["string version", { expected_version: "0" }],
    ["unknown top-level value", { owner_user_id: "client-selected" }],
  ])("rejects %s", (_label, overrides) => {
    expectInvalid(() => parseWatchlistReplaceRequest(validRequest(overrides)));
  });

  it("allows the same asset in distinct groups but enforces aggregate limits", () => {
    expect(
      parseWatchlistReplaceRequest(
        validRequest({
          groups: [
            {
              key: "one",
              name: "One",
              items: [{ asset_key: "BTC" }],
            },
            {
              key: "two",
              name: "Two",
              items: [{ asset_key: "BTC" }],
            },
          ],
        }),
      ).groups,
    ).toHaveLength(2);

    expectInvalid(() =>
      parseWatchlistReplaceRequest(
        validRequest({
          groups: Array.from(
            { length: WATCHLIST_MAX_GROUPS + 1 },
            (_, index) => ({
              key: `g${index}`,
              name: `Group ${index}`,
              items: [],
            }),
          ),
        }),
      ),
    );

    expectInvalid(() =>
      parseWatchlistReplaceRequest(
        validRequest({
          groups: [
            {
              key: "one",
              name: "One",
              items: Array.from({ length: 51 }, (_, index) => item(index)),
            },
            {
              key: "two",
              name: "Two",
              items: Array.from({ length: 50 }, (_, index) => item(index + 51)),
            },
          ],
        }),
      ),
    );

    expect(WATCHLIST_MAX_ITEMS).toBe(100);
  });

  it("accepts the exact 20-group and 100-item aggregate boundary", () => {
    const parsed = parseWatchlistReplaceRequest(
      validRequest({
        groups: Array.from(
          { length: WATCHLIST_MAX_GROUPS },
          (_, groupIndex) => ({
            key: `g${groupIndex}`,
            name: `Group ${groupIndex}`,
            items: Array.from({ length: 5 }, (_, itemIndex) => ({
              asset_key: `ASSET_${groupIndex}_${itemIndex}`,
            })),
          }),
        ),
      }),
    );

    expect(parsed.groups).toHaveLength(WATCHLIST_MAX_GROUPS);
    expect(
      parsed.groups.reduce((total, group) => total + group.items.length, 0),
    ).toBe(WATCHLIST_MAX_ITEMS);
  });

  it("rejects nested unknown fields and non-JSON descriptor values", () => {
    expectInvalid(() =>
      parseWatchlistReplaceRequest(
        validRequest({
          groups: [
            {
              key: "x",
              name: "X",
              items: [{ asset_key: "BTC", provider: "untrusted" }],
            },
          ],
        }),
      ),
    );

    const request = validRequest() as Record<string, unknown>;
    Object.defineProperty(request, "groups", {
      enumerable: true,
      get: () => [],
    });
    expectInvalid(() => parseWatchlistReplaceRequest(request));

    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expectInvalid(() => parseWatchlistReplaceRequest(cyclic));
  });

  it("validates truthful default and committed response shapes", () => {
    const empty = emptyWatchlistSnapshot();
    expect(empty).toEqual({ version: 0, groups: [], updated_at: null });
    expectDeepFrozen(empty);

    const committed = parseWatchlistSnapshot({
      version: 2,
      groups: [
        {
          key: "favorites",
          name: "Favorites",
          items: [{ asset_key: "BTC" }],
        },
      ],
      updated_at: "2026-08-25T01:02:03.000Z",
    });
    expect(committed.version).toBe(2);
    expectDeepFrozen(committed);

    expectInvalid(() =>
      parseWatchlistSnapshot({
        version: 0,
        groups: [],
        updated_at: "2026-08-25T01:02:03.000Z",
      }),
    );
    expectInvalid(() =>
      parseWatchlistSnapshot({ version: 1, groups: [], updated_at: null }),
    );
    expectInvalid(() =>
      parseWatchlistSnapshot({
        version: 1,
        groups: [{ key: "x", name: " X ", items: [] }],
        updated_at: "2026-08-25T01:02:03.000Z",
      }),
    );
  });

  it("compares normalized snapshots including order", () => {
    const first = parseWatchlistReplaceRequest(validRequest()).groups;
    const same = parseWatchlistReplaceRequest(validRequest()).groups;
    const reordered = parseWatchlistReplaceRequest(
      validRequest({ groups: [...first].reverse() }),
    ).groups;

    expect(watchlistGroupsEqual(first, same)).toBe(true);
    expect(watchlistGroupsEqual(first, reordered)).toBe(false);
  });
});
