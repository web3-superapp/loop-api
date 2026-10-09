import { describe, expect, it, vi } from "vitest";

import {
  canonicalizePerpIntentRequest,
  createPerpClientOrderId,
  digestPerpIntentRequest,
  InvalidPerpIntentContractError,
  InvalidPerpIntentIdempotencyKeyError,
  parsePerpIntentIdempotencyKey,
  parsePerpIntentRequest,
  parsePerpIntentResource,
  parsePerpIntentResult,
  parsePerpPublicReview,
  parsePerpPublicReviewForRequest,
  PERP_INTENT_BATCH_MAX_ITEMS,
  PERP_INTENT_IDEMPOTENCY_SCOPE,
  PERP_INTENT_REVIEW_MAX_AGE_MS,
  PERP_INTENT_REQUEST_DIGEST_VERSION,
  PERP_MARKET_ORDER_REVIEW_MAX_AGE_MS,
  type PerpIntentRequest,
} from "../src/features/perp/perp-intent-contract.js";

const intentId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const idempotencyKey = "90d2fcae-e660-45fa-8629-b3a5979868e6";
const cloidA = `0x${"11".repeat(16)}`;
const cloidB = `0x${"22".repeat(16)}`;
const maximumUint64 = "18446744073709551615";
const fetchedAt = "2026-08-24T12:00:00.000Z";
const expiresAt = "2026-08-24T12:00:02.000Z";

function limitOrder(overrides: Record<string, unknown> = {}): unknown {
  return {
    action: "order",
    coin: "BTC",
    side: "buy",
    order_type: "limit",
    size: "1.0",
    limit_price: "64000",
    time_in_force: "gtc",
    reduce_only: false,
    ...overrides,
  };
}

function marketOrder(overrides: Record<string, unknown> = {}): unknown {
  return {
    action: "order",
    coin: "ETH",
    side: "sell",
    order_type: "market",
    size: "0.25",
    max_slippage_percent: "0.50",
    reduce_only: true,
    ...overrides,
  };
}

function orderIdTarget(orderId = "7") {
  return { kind: "order_id", order_id: orderId };
}

function clientOrderIdTarget(clientOrderId = cloidA) {
  return { kind: "client_order_id", client_order_id: clientOrderId };
}

function modification(orderId = "7", overrides: Record<string, unknown> = {}) {
  return {
    coin: "SOL",
    target: orderIdTarget(orderId),
    side: "buy",
    size: "2.5",
    limit_price: "150.25",
    time_in_force: "alo",
    reduce_only: false,
    ...overrides,
  };
}

function review(action: unknown, overrides: Record<string, unknown> = {}) {
  return {
    version: "perp_review_v1",
    provider: "hyperliquid",
    network: "testnet",
    market: "core_perps",
    dex: "",
    action,
    source: {
      fetched_at: fetchedAt,
      expires_at: expiresAt,
    },
    ...overrides,
  };
}

function limitReviewAction(overrides: Record<string, unknown> = {}) {
  return {
    ...(limitOrder() as Record<string, unknown>),
    client_order_id: cloidA,
    ...overrides,
  };
}

function resultItem(overrides: Record<string, unknown> = {}) {
  return {
    index: 0,
    state: "accepted",
    order_id: "42",
    client_order_id: cloidA,
    filled_size: null,
    average_fill_price: null,
    reason_code: null,
    ...overrides,
  };
}

function result(overrides: Record<string, unknown> = {}) {
  return {
    observed_at: "2026-08-24T12:00:05.000Z",
    items: [resultItem()],
    ...overrides,
  };
}

function resource(overrides: Record<string, unknown> = {}) {
  return {
    intent_id: intentId,
    action: "order",
    state: "prepared",
    review: review(limitReviewAction()),
    expires_at: expiresAt,
    submission: { state: "disabled" },
    result: null,
    created_at: fetchedAt,
    updated_at: fetchedAt,
    ...overrides,
  };
}

function expectInvalidContract(action: () => unknown): void {
  expect(action).toThrow(InvalidPerpIntentContractError);
  try {
    action();
  } catch (error) {
    expect(error).toEqual(
      expect.objectContaining({
        code: "invalid_perp_intent_contract",
        message: "The Perp intent contract value is invalid",
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

describe("Perp intent request contract", () => {
  const variants: readonly [string, unknown][] = [
    ["limit order", limitOrder()],
    ["market order", marketOrder()],
    [
      "cancel by order ID",
      { action: "cancel", coin: "BTC", target: orderIdTarget() },
    ],
    [
      "cancel by client order ID",
      { action: "cancel", coin: "ETH", target: clientOrderIdTarget() },
    ],
    [
      "modify",
      {
        action: "modify",
        coin: "SOL",
        target: orderIdTarget(),
        side: "sell",
        size: "3",
        limit_price: "155.0",
        time_in_force: "ioc",
        reduce_only: true,
      },
    ],
    [
      "batch modify",
      {
        action: "batch_modify",
        modifications: [
          modification("7"),
          modification("8", { coin: "ETH", target: clientOrderIdTarget() }),
        ],
      },
    ],
    [
      "leverage update",
      {
        action: "update_leverage",
        coin: "BTC",
        margin_mode: "isolated",
        leverage: "20",
      },
    ],
    [
      "isolated margin update",
      {
        action: "update_isolated_margin",
        coin: "SOL",
        margin_delta_usdc: "-12.000001",
      },
    ],
  ];

  it.each(variants)("parses and deeply freezes %s", (_name, raw) => {
    const parsed = parsePerpIntentRequest(raw);

    expect(parsed).toEqual(raw);
    expectDeepFrozen(parsed);
  });

  it("locks the idempotency scope, digest version, and Core batch policy", () => {
    expect(PERP_INTENT_IDEMPOTENCY_SCOPE).toBe("perp_intent_prepare");
    expect(PERP_INTENT_REQUEST_DIGEST_VERSION).toBe("perp_intent_request_v1");
    expect(PERP_INTENT_BATCH_MAX_ITEMS).toBe(39);
    expect(PERP_INTENT_REVIEW_MAX_AGE_MS).toBe(60_000);
    expect(PERP_MARKET_ORDER_REVIEW_MAX_AGE_MS).toBe(2_000);
  });

  it.each([
    "owner_user_id",
    "user_id",
    "account",
    "wallet",
    "address",
    "agent",
    "network",
    "dex",
    "asset",
    "client_order_id",
    "nonce",
    "signature",
    "vaultAddress",
    "builder",
    "priority",
    "expiresAfter",
    "a",
    "b",
    "p",
    "s",
    "r",
    "t",
    "c",
  ])("rejects client authority or provider-wire field %s", (field) => {
    expectInvalidContract(() =>
      parsePerpIntentRequest(limitOrder({ [field]: "forbidden" })),
    );
  });

  it.each([
    ["JSON size number", limitOrder({ size: 1 })],
    ["JSON price number", limitOrder({ limit_price: 64_000 })],
    [
      "JSON leverage number",
      {
        action: "update_leverage",
        coin: "BTC",
        margin_mode: "cross",
        leverage: 3,
      },
    ],
    [
      "JSON margin number",
      { action: "update_isolated_margin", coin: "BTC", margin_delta_usdc: 1 },
    ],
    ["unsupported coin", limitOrder({ coin: "DOGE" })],
    ["Mainnet", limitOrder({ network: "mainnet" })],
    ["trigger", limitOrder({ order_type: "trigger" })],
    ["schedule cancel", { action: "schedule_cancel", coin: "BTC" }],
    ["leverage bundled with order", limitOrder({ leverage: "3" })],
    ["market fields on limit", limitOrder({ max_slippage_percent: "0.5" })],
    ["limit fields on market", marketOrder({ limit_price: "3000" })],
  ])("rejects %s", (_name, raw) => {
    expectInvalidContract(() => parsePerpIntentRequest(raw));
  });

  it.each([
    "0",
    "0.0",
    "-1",
    "+1",
    "01",
    "1.",
    ".1",
    "1e2",
    " 1",
    "1 ",
    "1,0",
    "NaN",
    "Infinity",
  ])("rejects invalid positive decimal %s", (value) => {
    expectInvalidContract(() =>
      parsePerpIntentRequest(limitOrder({ size: value })),
    );
  });

  it("accepts a 128-character positive decimal and rejects a longer one", () => {
    expect(
      parsePerpIntentRequest(limitOrder({ size: "9".repeat(128) })),
    ).toBeDefined();
    expectInvalidContract(() =>
      parsePerpIntentRequest(limitOrder({ size: "9".repeat(129) })),
    );
  });

  it.each(["0.0000001", "0.50", "1", "1.0", "1.00", "1.000"])(
    "accepts bounded positive market slippage %s percent",
    (value) => {
      expect(
        parsePerpIntentRequest(marketOrder({ max_slippage_percent: value })),
      ).toBeDefined();
    },
  );

  it.each(["0", "0.0", "-0.1", "1.0001", "1.01", "2", "1e-2"])(
    "rejects out-of-contract market slippage %s percent",
    (value) => {
      expectInvalidContract(() =>
        parsePerpIntentRequest(marketOrder({ max_slippage_percent: value })),
      );
    },
  );

  it.each(["1", "1.2", "-1", "-0.000001", "999999.999999"])(
    "accepts nonzero isolated margin delta %s with at most six decimals",
    (value) => {
      expect(
        parsePerpIntentRequest({
          action: "update_isolated_margin",
          coin: "BTC",
          margin_delta_usdc: value,
        }),
      ).toBeDefined();
    },
  );

  it.each(["0", "0.0", "-0", "-0.000000", "1.0000001", "01", "+1"])(
    "rejects isolated margin delta %s",
    (value) => {
      expectInvalidContract(() =>
        parsePerpIntentRequest({
          action: "update_isolated_margin",
          coin: "BTC",
          margin_delta_usdc: value,
        }),
      );
    },
  );

  it.each(["0", maximumUint64])("accepts uint64 order ID %s", (orderId) => {
    expect(
      parsePerpIntentRequest({
        action: "cancel",
        coin: "BTC",
        target: orderIdTarget(orderId),
      }),
    ).toBeDefined();
  });

  it.each(["18446744073709551616", "01", "-1", "1.0"])(
    "rejects invalid uint64 order ID %s",
    (orderId) => {
      expectInvalidContract(() =>
        parsePerpIntentRequest({
          action: "cancel",
          coin: "BTC",
          target: orderIdTarget(orderId),
        }),
      );
    },
  );

  it.each([cloidA, cloidB])("accepts lowercase 128-bit cloid %s", (cloid) => {
    expect(
      parsePerpIntentRequest({
        action: "cancel",
        coin: "BTC",
        target: clientOrderIdTarget(cloid),
      }),
    ).toBeDefined();
  });

  it.each([
    `0X${"11".repeat(16)}`,
    `0x${"AA".repeat(16)}`,
    `0x${"11".repeat(15)}`,
    `0x${"11".repeat(17)}`,
    "11".repeat(16),
  ])("rejects invalid cloid %s", (cloid) => {
    expectInvalidContract(() =>
      parsePerpIntentRequest({
        action: "cancel",
        coin: "BTC",
        target: clientOrderIdTarget(cloid),
      }),
    );
  });

  it("accepts 39 unique batch targets", () => {
    const modifications = Array.from(
      { length: PERP_INTENT_BATCH_MAX_ITEMS },
      (_, index) => modification(String(index)),
    );

    expect(
      parsePerpIntentRequest({ action: "batch_modify", modifications }),
    ).toBeDefined();
  });

  it.each([
    ["empty", []],
    [
      "too large",
      Array.from({ length: PERP_INTENT_BATCH_MAX_ITEMS + 1 }, (_, index) =>
        modification(String(index)),
      ),
    ],
    ["duplicate target", [modification("7"), modification("7")]],
  ])("rejects a %s modification batch", (_name, modifications) => {
    expectInvalidContract(() =>
      parsePerpIntentRequest({ action: "batch_modify", modifications }),
    );
  });

  it("rejects accessors without invoking them", () => {
    const raw = limitOrder() as Record<string, unknown>;
    const getter = vi.fn(() => "1");
    Object.defineProperty(raw, "size", { enumerable: true, get: getter });

    expectInvalidContract(() => parsePerpIntentRequest(raw));
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects symbols, non-enumerable fields, class instances, cycles, and sparse arrays", () => {
    const withSymbol = limitOrder() as Record<PropertyKey, unknown>;
    withSymbol[Symbol("authority")] = "forbidden";
    expectInvalidContract(() => parsePerpIntentRequest(withSymbol));

    const withHidden = limitOrder() as Record<string, unknown>;
    Object.defineProperty(withHidden, "nonce", {
      enumerable: false,
      value: "forbidden",
    });
    expectInvalidContract(() => parsePerpIntentRequest(withHidden));

    class ForgedRequest {
      action = "order";
      coin = "BTC";
      side = "buy";
      order_type = "limit";
      size = "1";
      limit_price = "1";
      time_in_force = "gtc";
      reduce_only = false;
    }
    expectInvalidContract(() => parsePerpIntentRequest(new ForgedRequest()));

    const cyclicTarget = orderIdTarget() as Record<string, unknown>;
    cyclicTarget["self"] = cyclicTarget;
    expectInvalidContract(() =>
      parsePerpIntentRequest({
        action: "cancel",
        coin: "BTC",
        target: cyclicTarget,
      }),
    );

    const sparse = new Array(1);
    expectInvalidContract(() =>
      parsePerpIntentRequest({ action: "batch_modify", modifications: sparse }),
    );
  });
});

describe("Perp intent canonical request digest", () => {
  it("uses fixed key order and the versioned domain separator", () => {
    const raw = {
      reduce_only: false,
      time_in_force: "gtc",
      limit_price: "64000",
      size: "1.0",
      order_type: "limit",
      side: "buy",
      coin: "BTC",
      action: "order",
    };
    const parsed = parsePerpIntentRequest(raw);

    expect(canonicalizePerpIntentRequest(parsed)).toBe(
      '{"action":"order","coin":"BTC","side":"buy","order_type":"limit","size":"1.0","limit_price":"64000","time_in_force":"gtc","reduce_only":false}',
    );
    expect(digestPerpIntentRequest(parsed)).toBe(
      "363d49ff857e87ca4053e5dd9190d531d35ea12edd851380ec78d74e5dc6e2f0",
    );
  });

  it("is independent of input object key order", () => {
    const first = parsePerpIntentRequest(limitOrder());
    const second = parsePerpIntentRequest({
      reduce_only: false,
      limit_price: "64000",
      action: "order",
      time_in_force: "gtc",
      coin: "BTC",
      size: "1.0",
      side: "buy",
      order_type: "limit",
    });

    expect(canonicalizePerpIntentRequest(first)).toBe(
      canonicalizePerpIntentRequest(second),
    );
    expect(digestPerpIntentRequest(first)).toBe(
      digestPerpIntentRequest(second),
    );
  });

  it("preserves exact decimal lexical identity", () => {
    const one = parsePerpIntentRequest(limitOrder({ size: "1" }));
    const onePointZero = parsePerpIntentRequest(limitOrder({ size: "1.0" }));

    expect(digestPerpIntentRequest(one)).not.toBe(
      digestPerpIntentRequest(onePointZero),
    );
  });

  it("canonicalizes target and batch field order without normalizing values", () => {
    const parsed = parsePerpIntentRequest({
      modifications: [
        {
          reduce_only: true,
          time_in_force: "ioc",
          limit_price: "1.00",
          size: "2.0",
          side: "sell",
          target: { order_id: "7", kind: "order_id" },
          coin: "SOL",
        },
      ],
      action: "batch_modify",
    });

    expect(canonicalizePerpIntentRequest(parsed)).toBe(
      '{"action":"batch_modify","modifications":[{"coin":"SOL","target":{"kind":"order_id","order_id":"7"},"side":"sell","size":"2.0","limit_price":"1.00","time_in_force":"ioc","reduce_only":true}]}',
    );
  });

  it("revalidates runtime values even when TypeScript claims the request type", () => {
    expectInvalidContract(() =>
      canonicalizePerpIntentRequest({
        action: "order",
        coin: "BTC",
        side: "buy",
        order_type: "limit",
        size: 1,
        limit_price: "1",
        time_in_force: "gtc",
        reduce_only: false,
      } as unknown as PerpIntentRequest),
    );
  });
});

describe("Perp intent idempotency key", () => {
  it("reads exactly one canonical lowercase UUID from raw headers", () => {
    expect(
      parsePerpIntentIdempotencyKey([
        "authorization",
        "Bearer redacted",
        "IDEMPOTENCY-KEY",
        idempotencyKey,
      ]),
    ).toBe(idempotencyKey);
  });

  it.each([
    ["missing", ["authorization", "Bearer redacted"]],
    [
      "duplicate identical",
      ["Idempotency-Key", idempotencyKey, "idempotency-key", idempotencyKey],
    ],
    ["uppercase UUID", ["Idempotency-Key", idempotencyKey.toUpperCase()]],
    ["surrounding whitespace", ["Idempotency-Key", ` ${idempotencyKey}`]],
    ["nil UUID", ["Idempotency-Key", "00000000-0000-0000-0000-000000000000"]],
    [
      "invalid variant",
      ["Idempotency-Key", "90d2fcae-e660-45fa-7629-b3a5979868e6"],
    ],
    ["odd raw headers", ["Idempotency-Key"]],
  ])("rejects a %s idempotency header", (_name, rawHeaders) => {
    expect(() => parsePerpIntentIdempotencyKey(rawHeaders)).toThrow(
      InvalidPerpIntentIdempotencyKeyError,
    );
  });

  it("rejects a non-array runtime value", () => {
    expect(() =>
      parsePerpIntentIdempotencyKey({
        0: "Idempotency-Key",
        1: idempotencyKey,
      } as unknown as readonly string[]),
    ).toThrow(InvalidPerpIntentIdempotencyKeyError);
  });
});

describe("server-generated Perp client order IDs", () => {
  it("uses exactly 128 random bits and emits canonical lowercase hex", () => {
    const entropy = Uint8Array.from({ length: 16 }, (_, index) => index);
    const generator = vi.fn(() => entropy);

    expect(createPerpClientOrderId(generator)).toBe(
      "0x000102030405060708090a0b0c0d0e0f",
    );
    expect(generator).toHaveBeenCalledExactlyOnceWith(16);
  });

  it.each([15, 17])("rejects %s bytes of injected entropy", (length) => {
    expect(() => createPerpClientOrderId(() => new Uint8Array(length))).toThrow(
      "Perp client order ID entropy is invalid",
    );
  });

  it("rejects a non-byte runtime entropy value", () => {
    expect(() =>
      createPerpClientOrderId(
        (() => "not bytes") as unknown as (size: number) => Uint8Array,
      ),
    ).toThrow("Perp client order ID entropy is invalid");
  });
});

describe("Perp public review contract", () => {
  const reviewActions: readonly [string, unknown][] = [
    ["limit order", limitReviewAction()],
    [
      "market order",
      {
        ...(marketOrder() as Record<string, unknown>),
        final_limit_price: "2990.5",
        client_order_id: cloidA,
      },
    ],
    ["cancel", { action: "cancel", coin: "BTC", target: orderIdTarget() }],
    [
      "modify",
      {
        action: "modify",
        coin: "ETH",
        target: clientOrderIdTarget(),
        side: "sell",
        size: "1",
        limit_price: "3000",
        time_in_force: "gtc",
        reduce_only: false,
        replacement_client_order_id: cloidB,
      },
    ],
    [
      "batch modify",
      {
        action: "batch_modify",
        modifications: [
          { ...modification("7"), replacement_client_order_id: cloidA },
          { ...modification("8"), replacement_client_order_id: cloidB },
        ],
      },
    ],
    [
      "leverage",
      {
        action: "update_leverage",
        coin: "BTC",
        margin_mode: "cross",
        leverage: "3",
      },
    ],
    [
      "isolated margin",
      {
        action: "update_isolated_margin",
        coin: "SOL",
        margin_delta_usdc: "5.25",
      },
    ],
  ];

  it.each(reviewActions)("parses and freezes %s review", (_name, action) => {
    const parsed = parsePerpPublicReview(review(action));

    expect(parsed.action).toEqual(action);
    expectDeepFrozen(parsed);
  });

  it("proves the review materially matches the exact business request", () => {
    const request = parsePerpIntentRequest(limitOrder());
    const parsed = parsePerpPublicReviewForRequest(
      request,
      review(limitReviewAction()),
    );

    expect(parsed.action).toEqual(limitReviewAction());
  });

  it("allows only the reviewed market final price and server cloid to augment a market request", () => {
    const request = marketOrder();

    expect(
      parsePerpPublicReviewForRequest(
        request,
        review({
          ...(request as Record<string, unknown>),
          final_limit_price: "2990",
          client_order_id: cloidB,
        }),
      ),
    ).toBeDefined();
    expectInvalidContract(() =>
      parsePerpPublicReviewForRequest(
        request,
        review({
          ...(request as Record<string, unknown>),
          size: "0.50",
          final_limit_price: "2990",
          client_order_id: cloidB,
        }),
      ),
    );
  });

  it("rejects a materially changed review action", () => {
    expectInvalidContract(() =>
      parsePerpPublicReviewForRequest(
        limitOrder(),
        review(limitReviewAction({ limit_price: "64001" })),
      ),
    );
  });

  it("rejects stale chronology, wrong scope, unknown/provider fields, and numeric prices", () => {
    expectInvalidContract(() =>
      parsePerpPublicReview(
        review(limitReviewAction(), {
          source: { fetched_at: expiresAt, expires_at: fetchedAt },
        }),
      ),
    );
    expectInvalidContract(() =>
      parsePerpPublicReview(
        review(limitReviewAction(), { network: "mainnet" }),
      ),
    );
    expectInvalidContract(() =>
      parsePerpPublicReview(review(limitReviewAction({ asset: "0" }))),
    );
    expectInvalidContract(() =>
      parsePerpPublicReview(review(limitReviewAction({ limit_price: 64_000 }))),
    );
  });

  it("rejects duplicate batch targets or replacement cloids", () => {
    const first = { ...modification("7"), replacement_client_order_id: cloidA };
    expectInvalidContract(() =>
      parsePerpPublicReview(
        review({ action: "batch_modify", modifications: [first, first] }),
      ),
    );
    expectInvalidContract(() =>
      parsePerpPublicReview(
        review({
          action: "batch_modify",
          modifications: [
            first,
            { ...modification("8"), replacement_client_order_id: cloidA },
          ],
        }),
      ),
    );
  });
});

describe("Perp result and resource contracts", () => {
  it("parses public result facts with small integer indexes", () => {
    const parsed = parsePerpIntentResult(result());

    expect(parsed.items[0]?.index).toBe(0);
    expectDeepFrozen(parsed);
  });

  it.each([
    ["string index", result({ items: [resultItem({ index: "0" })] })],
    ["negative index", result({ items: [resultItem({ index: -1 })] })],
    ["large index", result({ items: [resultItem({ index: 39 })] })],
    [
      "duplicate index",
      result({ items: [resultItem(), resultItem({ order_id: "43" })] }),
    ],
    ["empty items", result({ items: [] })],
    ["numeric fill", result({ items: [resultItem({ filled_size: 1 })] })],
    [
      "unsafe reason",
      result({ items: [resultItem({ reason_code: "raw provider message" })] }),
    ],
    ["unknown field", result({ provider_payload: {} })],
  ])("rejects result with %s", (_name, raw) => {
    expectInvalidContract(() => parsePerpIntentResult(raw));
  });

  it("parses a prepared resource without claiming provider execution", () => {
    const parsed = parsePerpIntentResource(resource());

    expect(parsed).toMatchObject({
      intent_id: intentId,
      action: "order",
      state: "prepared",
      submission: { state: "disabled" },
      result: null,
    });
    expectDeepFrozen(parsed);
    expect(JSON.stringify(parsed)).not.toContain("address");
  });

  it("parses a result only when item indexes exactly cover the reviewed action", () => {
    const parsed = parsePerpIntentResource(
      resource({
        state: "accepted",
        submission: { state: "requires_revalidation" },
        result: result(),
      }),
    );

    expect(parsed.result?.items).toHaveLength(1);
  });

  it.each([
    ["action mismatch", resource({ action: "cancel" })],
    [
      "review expiry mismatch",
      resource({ expires_at: "2026-08-24T12:00:31.000Z" }),
    ],
    [
      "missing batch result item",
      resource({
        action: "batch_modify",
        review: review({
          action: "batch_modify",
          modifications: [
            { ...modification("7"), replacement_client_order_id: cloidA },
            { ...modification("8"), replacement_client_order_id: cloidB },
          ],
        }),
        result: result(),
      }),
    ],
    [
      "noncanonical item indexes",
      resource({ result: result({ items: [resultItem({ index: 1 })] }) }),
    ],
    ["client authority", resource({ account_address: `0x${"12".repeat(20)}` })],
    ["uppercase UUID", resource({ intent_id: intentId.toUpperCase() })],
  ])("rejects resource with %s", (_name, raw) => {
    expectInvalidContract(() => parsePerpIntentResource(raw));
  });
});
