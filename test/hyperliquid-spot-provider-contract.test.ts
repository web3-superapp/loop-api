import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(
    await readFile(
      new URL(
        `../contracts/hyperliquid-spot/fixtures/${path}`,
        import.meta.url,
      ),
      "utf8",
    ),
  ) as T;
}

describe("Hyperliquid Spot provider fixture contract", () => {
  it("keeps all four PURR/USDC identifiers distinct and server-derived", async () => {
    const fixture = await readJson<{
      readonly classification: string;
      readonly runtime_fallback: boolean;
      readonly network: string;
      readonly response: readonly [
        {
          readonly tokens: readonly {
            readonly index: number;
            readonly tokenId: string;
          }[];
          readonly universe: readonly {
            readonly index: number;
            readonly tokens: readonly number[];
          }[];
        },
        readonly unknown[],
      ];
      readonly derived_identity_expectation: {
        readonly base_token_index: number;
        readonly base_token_id: string;
        readonly quote_token_index: number;
        readonly quote_token_id: string;
        readonly spot_pair_index: number;
        readonly exchange_order_asset: number;
      };
    }>("provider-spot-meta-purr-testnet.json");
    const [metadata] = fixture.response;
    const identity = fixture.derived_identity_expectation;
    const tokenByIndex = new Map(
      metadata.tokens.map((token) => [token.index, token]),
    );
    const [pair] = metadata.universe;

    expect(fixture).toMatchObject({
      classification: "public_testnet_provider_capture",
      runtime_fallback: false,
      network: "testnet",
    });
    expect(pair?.index).toBe(identity.spot_pair_index);
    expect(pair?.tokens).toEqual([
      identity.base_token_index,
      identity.quote_token_index,
    ]);
    expect(tokenByIndex.get(identity.base_token_index)?.tokenId).toBe(
      identity.base_token_id,
    );
    expect(tokenByIndex.get(identity.quote_token_index)?.tokenId).toBe(
      identity.quote_token_id,
    );
    expect(identity.exchange_order_asset).toBe(
      10_000 + identity.spot_pair_index,
    );
    expect(identity.base_token_id).not.toBe(identity.quote_token_id);
  });

  it("preserves exact L2 decimal strings and the provider side ordering", async () => {
    const fixture = await readJson<{
      readonly classification: string;
      readonly runtime_fallback: boolean;
      readonly response: {
        readonly coin: string;
        readonly time: number;
        readonly levels: readonly (readonly {
          readonly px: string;
          readonly sz: string;
          readonly n: number;
        }[])[];
      };
      readonly book_expectation: {
        readonly level_zero_side: string;
        readonly level_one_side: string;
        readonly best_bid: string;
        readonly best_ask: string;
        readonly crossed: boolean;
      };
    }>("provider-l2-book-purr-testnet.json");
    const [bids, asks] = fixture.response.levels;

    expect(fixture).toMatchObject({
      classification: "public_testnet_provider_capture",
      runtime_fallback: false,
      book_expectation: {
        level_zero_side: "bids",
        level_one_side: "asks",
        crossed: false,
      },
    });
    expect(fixture.response.coin).toBe("PURR/USDC");
    expect(Number.isSafeInteger(fixture.response.time)).toBe(true);
    expect(bids?.[0]?.px).toBe(fixture.book_expectation.best_bid);
    expect(asks?.[0]?.px).toBe(fixture.book_expectation.best_ask);
    expect(typeof bids?.[0]?.px).toBe("string");
    expect(typeof bids?.[0]?.sz).toBe("string");
    expect(typeof asks?.[0]?.px).toBe("string");
    expect(typeof asks?.[0]?.sz).toBe("string");
  });
});
