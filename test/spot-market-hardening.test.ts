import { describe, expect, it, vi } from "vitest";

import { deriveStreamUserId } from "../src/features/identity/loop-identifiers.js";
import {
  parseSpotBalancesResource,
  parseSpotMarketFactsResource,
} from "../src/features/spot/spot-market-contract.js";
import { createSpotMarketService } from "../src/features/spot/spot-market-service.js";
import { SpotUnavailableError } from "../src/features/spot/spot-errors.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const assetId = "22222222-2222-4222-8222-222222222222";
const principal = Object.freeze({
  userId: ownerUserId,
  privyUserId: "did:privy:spot-market-hardening",
  streamUserId: deriveStreamUserId(ownerUserId),
});
const source = Object.freeze({
  provider: "hyperliquid" as const,
  network: "testnet" as const,
  metadata_version: "metadata_v1",
  fetched_at: "2026-08-26T07:00:00.000Z",
  expires_at: "2026-08-26T07:00:02.000Z",
});

function balances(overrides: Record<string, unknown> = {}) {
  return {
    binding_version: "1",
    account_kind: "master",
    items: [
      {
        asset_id: assetId,
        display_identity: "USDC",
        total: "10.00",
        available: "7.5",
        hold: "2.500",
      },
    ],
    source,
    ...overrides,
  };
}

function facts(overrides: Record<string, unknown> = {}) {
  return {
    market_id: "33333333-3333-4333-8333-333333333333",
    enabled: true,
    base_display_identity: "PURR",
    quote_display_identity: "USDC",
    base_size_decimals: 0,
    book: {
      best_bid: { price: "4.99", size: "10" },
      best_ask: { price: "5", size: "12" },
      observed_at: source.fetched_at,
    },
    limits: {
      minimum_base_size: { state: "available", value: "1" },
      minimum_quote_notional: { state: "unavailable" },
    },
    source,
    ...overrides,
  };
}

describe("Spot market contract hardening", () => {
  it("requires a bound epoch and exact total = available + hold", () => {
    expect(parseSpotBalancesResource(balances()).binding_version).toBe("1");
    expect(() =>
      parseSpotBalancesResource(balances({ binding_version: "0" })),
    ).toThrow();
    expect(() =>
      parseSpotBalancesResource(
        balances({
          items: [
            {
              asset_id: assetId,
              display_identity: "USDC",
              total: "10",
              available: "8",
              hold: "1",
            },
          ],
        }),
      ),
    ).toThrow();
  });

  it("rejects disabled and crossed executable market facts", () => {
    expect(parseSpotMarketFactsResource(facts()).enabled).toBe(true);
    expect(() =>
      parseSpotMarketFactsResource(facts({ enabled: false })),
    ).toThrow();
    expect(() =>
      parseSpotMarketFactsResource(
        facts({
          book: {
            best_bid: { price: "5", size: "10" },
            best_ask: { price: "4.99", size: "12" },
            observed_at: source.fetched_at,
          },
        }),
      ),
    ).toThrow();
  });

  it("rejects otherwise valid resources after their source expiry", async () => {
    const service = createSpotMarketService({
      now: () => new Date("2026-08-26T07:00:02.000Z"),
      createUuid: () => "44444444-4444-4444-8444-444444444444",
      reader: {
        readConfig: vi.fn(() =>
          Promise.resolve({
            network: "testnet",
            markets: [],
            capabilities: {
              market_facts: "unavailable",
              balances: "unavailable",
              intent_prepare: "unavailable",
              intent_submit: "unavailable",
              agent_authorization: "unavailable",
            },
            review_policy: {
              execution: "aggressive_limit_ioc",
              default_max_slippage_bps: 25,
              maximum_max_slippage_bps: 100,
              review_ttl_ms: 15_000,
            },
            source,
          }),
        ),
        readMarketFacts: vi.fn(() => Promise.resolve(facts())),
        readBalances: vi.fn(() => Promise.resolve(balances())),
      },
    });

    const input = {
      principal,
      signal: new AbortController().signal,
    };
    await expect(service.getConfig(input)).rejects.toBeInstanceOf(
      SpotUnavailableError,
    );
    await expect(
      service.getMarketFacts({
        ...input,
        marketId: "33333333-3333-4333-8333-333333333333",
      }),
    ).rejects.toBeInstanceOf(SpotUnavailableError);
    await expect(
      service.getBalances({
        principal,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(SpotUnavailableError);
  });

  it("maps a malformed reader projection to sanitized Spot unavailable", async () => {
    const service = createSpotMarketService({
      createUuid: () => "33333333-3333-4333-8333-333333333333",
      reader: {
        readConfig: vi.fn(() => Promise.resolve({ network: "mainnet" })),
        readMarketFacts: vi.fn(),
        readBalances: vi.fn(),
      },
    });

    await expect(
      service.getConfig({
        principal,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(SpotUnavailableError);
  });
});
