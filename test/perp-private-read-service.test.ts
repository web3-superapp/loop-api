import { describe, expect, it, vi } from "vitest";

import {
  createPerpPrivateReadCursorCodec,
  type PerpPrivateReadCursorCodec,
} from "../src/features/perp/private-read-cursor.js";
import {
  createPerpPrivateReadService,
  InvalidPerpReadRequestError,
  PERP_PRIVATE_LIST_DEFAULT_LIMIT,
  PERP_POSITIONS_DEFAULT_LIMIT,
  PerpReadFailedError,
  PerpReadUnavailableError,
  PerpWalletBindingRequiredError,
  type PerpPrivateReadRequest,
} from "../src/features/perp/private-read-service.js";
import {
  WalletBindingRequiredError,
  WalletBindingResolutionUnavailableError,
  type PerpWalletBindingResolver,
} from "../src/features/perp/wallet-binding-resolver.js";
import {
  HyperliquidPrivateReaderUnavailableError,
  RetryableHyperliquidReadError,
  type HyperliquidPrivateReadKind,
  type HyperliquidPrivateReader,
} from "../src/integrations/hyperliquid/private-reader.js";

const observedAt = new Date("2026-08-24T12:00:01.000Z");
const ownerUserId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const otherOwnerUserId = "90d2fcae-e660-45fa-8629-b3a5979868e6";
const privyUserId = "did:privy:verified-user";
const accountAddress = `0x${"12".repeat(20)}`;
const otherAccountAddress = `0x${"34".repeat(20)}`;
const principal = Object.freeze({
  userId: ownerUserId,
  privyUserId,
  streamUserId: "loop_6d12a86e413447e69312c5ef75a30f55",
});
const otherPrincipal = Object.freeze({
  userId: otherOwnerUserId,
  privyUserId: "did:privy:other-user",
  streamUserId: "loop_90d2fcaee66045fa8629b3a5979868e6",
});
const binding = Object.freeze({
  ownerUserId,
  privyUserId,
  accountAddress,
  accountKind: "master",
  bindingVersion: "1",
  verifiedAt: "2026-08-24T11:00:00.000Z",
  expiresAt: "2026-08-24T13:00:00.000Z",
});
const cursorSecret = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const hashA = `0x${"aa".repeat(32)}`;
const hashB = `0x${"bb".repeat(32)}`;
const cloidA = `0x${"11".repeat(16)}`;
const cloidB = `0x${"22".repeat(16)}`;
const allKinds = [
  "config",
  "account",
  "positions",
  "orders",
  "fills",
  "funding",
] as const satisfies readonly HyperliquidPrivateReadKind[];
const listKinds = ["positions", "orders", "fills", "funding"] as const;

function source(kind: HyperliquidPrivateReadKind) {
  return {
    provider: "hyperliquid",
    network: "testnet",
    market: "core_perps",
    dex: "",
    dataset: kind,
    fetched_at: "2026-08-24T12:00:00.000Z",
    expires_at:
      kind === "config"
        ? "2026-08-24T12:01:00.000Z"
        : "2026-08-24T12:00:02.000Z",
  } as const;
}

function coverage() {
  return {
    kind: "recent_window",
    started_at: "2026-08-24T11:00:00.000Z",
    ended_at: "2026-08-24T12:00:00.000Z",
    truncated: false,
  } as const;
}

function configResult(): unknown {
  return {
    scope: {
      network: "testnet",
      market: "core_perps",
      dex: "",
      coins: ["BTC", "ETH", "SOL"],
    },
    assets: [
      {
        coin: "BTC",
        size_decimals: 5,
        size_increment: "0.00001",
        max_leverage: "40",
        margin_mode: "cross_and_isolated",
        minimum_order_notional_usdc: { state: "available", value: "10" },
      },
      {
        coin: "ETH",
        size_decimals: 4,
        size_increment: "0.0001",
        max_leverage: "25",
        margin_mode: "cross_and_isolated",
        minimum_order_notional_usdc: { state: "unavailable" },
      },
      {
        coin: "SOL",
        size_decimals: 2,
        size_increment: "0.01",
        max_leverage: "20",
        margin_mode: "isolated_only",
        minimum_order_notional_usdc: { state: "available", value: "10.00" },
      },
    ],
    fees: {
      maker_rate: { state: "available", value: "-0.0001" },
      taker_rate: { state: "available", value: "0.00035" },
    },
    capabilities: {
      private_reads: "available",
      trading_mutations: "disabled",
    },
    source: source("config"),
  };
}

function accountResult(): unknown {
  const marginSummary = {
    account_value: "1000.25",
    total_margin_used: "25.5",
    total_notional_position: "250.0",
    total_raw_usd: "1000.25",
  };
  return {
    margin_summary: marginSummary,
    cross_margin_summary: { ...marginSummary },
    withdrawable: "974.75",
    cross_maintenance_margin_used: null,
    source: source("account"),
  };
}

function positionsResult(): unknown {
  return {
    items: [
      {
        coin: "BTC",
        side: "long",
        size: "0.01",
        entry_price: "64000.5",
        leverage: { mode: "cross", value: "3", raw_usd: null },
        liquidation_price: "51000",
        margin_used: "213.335",
        position_value: "640.005",
        return_on_equity: "0.05",
        unrealized_pnl: "10.25",
        position_mode: "one_way",
      },
      {
        coin: "ETH",
        side: "short",
        size: "0.2",
        entry_price: null,
        leverage: { mode: "isolated", value: "2", raw_usd: "50" },
        liquidation_price: null,
        margin_used: "50",
        position_value: "100",
        return_on_equity: "-0.01",
        unrealized_pnl: "-1",
        position_mode: "one_way",
      },
    ],
    source: source("positions"),
  };
}

function ordersResult(): unknown {
  return {
    items: [
      {
        order_id: "20",
        client_order_id: cloidA,
        coin: "BTC",
        side: "buy",
        order_type: "limit",
        time_in_force: "gtc",
        limit_price: "63000",
        original_size: "0.10",
        remaining_size: "0.03",
        reduce_only: false,
        status: "open",
        created_at: "2026-08-24T11:59:59.000Z",
        status_at: "2026-08-24T12:00:00.000Z",
      },
      {
        order_id: "19",
        client_order_id: cloidB,
        coin: "ETH",
        side: "sell",
        order_type: "limit",
        time_in_force: "alo",
        limit_price: "3000",
        original_size: "1",
        remaining_size: "1.0",
        reduce_only: true,
        status: "open",
        created_at: "2026-08-24T11:59:59.000Z",
        status_at: "2026-08-24T11:59:59.500Z",
      },
    ],
    source: source("orders"),
  };
}

function fillsResult(): unknown {
  return {
    items: [
      {
        trade_id: "30",
        order_id: "20",
        transaction_hash: hashA,
        coin: "BTC",
        side: "buy",
        price: "64000",
        size: "0.01",
        start_position: "0",
        closed_pnl: "0",
        fee: "0.224",
        fee_asset: "USDC",
        crossed: true,
        filled_at: "2026-08-24T11:59:58.000Z",
      },
      {
        trade_id: "29",
        order_id: "19",
        transaction_hash: hashB,
        coin: "ETH",
        side: "sell",
        price: "3000",
        size: "0.1",
        start_position: "0.1",
        closed_pnl: "-0.25",
        fee: "0.105",
        fee_asset: "USDC",
        crossed: false,
        filled_at: "2026-08-24T11:59:58.000Z",
      },
    ],
    coverage: coverage(),
    source: source("fills"),
  };
}

function fundingResult(): unknown {
  return {
    items: [
      {
        transaction_hash: hashA,
        coin: "BTC",
        funding_rate: "0.0000125",
        position_size: "0.01",
        payment_usdc: "-0.008",
        settled_at: "2026-08-24T11:59:57.000Z",
      },
      {
        transaction_hash: hashB,
        coin: "ETH",
        funding_rate: "-0.00001",
        position_size: "-0.2",
        payment_usdc: "0.006",
        settled_at: "2026-08-24T11:59:57.000Z",
      },
    ],
    coverage: coverage(),
    source: source("funding"),
  };
}

function resultFor(kind: HyperliquidPrivateReadKind): unknown {
  switch (kind) {
    case "config":
      return configResult();
    case "account":
      return accountResult();
    case "positions":
      return positionsResult();
    case "orders":
      return ordersResult();
    case "fills":
      return fillsResult();
    case "funding":
      return fundingResult();
  }
}

function cursorCodec(): PerpPrivateReadCursorCodec {
  return createPerpPrivateReadCursorCodec({
    secret: cursorSecret,
    now: () => observedAt,
  });
}

interface HarnessOptions {
  readonly bindingResult?: unknown;
  readonly result?: unknown;
  readonly codec?: PerpPrivateReadCursorCodec | null;
  readonly requestPrincipal?: typeof principal | typeof otherPrincipal;
}

function harness(
  kind: HyperliquidPrivateReadKind,
  options: HarnessOptions = {},
) {
  const resolvedBinding = Object.hasOwn(options, "bindingResult")
    ? options.bindingResult
    : options.requestPrincipal === otherPrincipal
      ? {
          ...binding,
          ownerUserId: otherOwnerUserId,
          privyUserId: otherPrincipal.privyUserId,
          accountAddress: otherAccountAddress,
        }
      : binding;
  const resolve = vi.fn<PerpWalletBindingResolver["resolve"]>(() =>
    Promise.resolve(resolvedBinding),
  );
  const read = vi.fn<HyperliquidPrivateReader["read"]>(() =>
    Promise.resolve(
      Object.hasOwn(options, "result") ? options.result : resultFor(kind),
    ),
  );
  const service = createPerpPrivateReadService({
    bindingResolver: { resolve },
    cursorCodec: Object.hasOwn(options, "codec")
      ? (options.codec ?? null)
      : cursorCodec(),
    reader: { read },
    now: () => observedAt,
  });

  return { resolve, read, service };
}

function request(
  kind: HyperliquidPrivateReadKind,
  overrides: Partial<PerpPrivateReadRequest> = {},
): PerpPrivateReadRequest {
  return {
    principal,
    kind,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe("Perp private-read service", () => {
  it.each(allKinds)(
    "returns a strict, immutable %s projection without exposing the wallet address",
    async (kind) => {
      const inputs = harness(kind);
      const response = await inputs.service.read(request(kind));

      expect(JSON.stringify(response)).not.toContain(accountAddress);
      expect(Object.isFrozen(response)).toBe(true);
      expect(response.source).toEqual(source(kind));
      const resolveInput = inputs.resolve.mock.calls[0]?.[0];
      expect(resolveInput).toMatchObject({
        ownerUserId,
        privyUserId,
      });
      expect(resolveInput?.signal).toBeInstanceOf(AbortSignal);
      expect(inputs.read).toHaveBeenCalledOnce();
      const readInput = inputs.read.mock.calls[0]?.[0];
      expect(readInput).toMatchObject({
        network: "testnet",
        dex: "",
        accountAddress,
        kind,
        ...(kind === "positions"
          ? { limit: PERP_POSITIONS_DEFAULT_LIMIT }
          : listKinds.includes(kind as (typeof listKinds)[number])
            ? { limit: PERP_PRIVATE_LIST_DEFAULT_LIMIT }
            : {}),
      });
      expect(readInput?.transportAttemptId).toMatch(/^[0-9a-f-]{36}$/);
      expect(readInput?.signal).toBeInstanceOf(AbortSignal);
      if (listKinds.includes(kind as (typeof listKinds)[number])) {
        expect(response).toHaveProperty("next_cursor", null);
      }
    },
  );

  it("keeps config facts exact, including unavailable minimums and a negative maker rebate", async () => {
    const response = await harness("config").service.read(request("config"));

    expect(response).toEqual(configResult());
    expect(response).toMatchObject({
      fees: {
        maker_rate: { state: "available", value: "-0.0001" },
        taker_rate: { state: "available", value: "0.00035" },
      },
      capabilities: {
        private_reads: "available",
        trading_mutations: "disabled",
      },
    });
  });

  it("maps missing or ambiguous binding evidence to a stable required error before reader work", async () => {
    for (const missing of [null, [], [binding, binding]]) {
      const inputs = harness("account", { bindingResult: missing });
      await expect(
        inputs.service.read(request("account")),
      ).rejects.toBeInstanceOf(PerpWalletBindingRequiredError);
      expect(inputs.read).not.toHaveBeenCalled();
    }

    const inputs = harness("account");
    inputs.resolve.mockRejectedValueOnce(new WalletBindingRequiredError());
    await expect(
      inputs.service.read(request("account")),
    ).rejects.toBeInstanceOf(PerpWalletBindingRequiredError);
    expect(inputs.read).not.toHaveBeenCalled();
  });

  it("checks binding evidence before treating an absent cursor capability as unavailable", async () => {
    const missing = harness("positions", { bindingResult: null, codec: null });
    await expect(
      missing.service.read(request("positions")),
    ).rejects.toBeInstanceOf(PerpWalletBindingRequiredError);
    expect(missing.read).not.toHaveBeenCalled();

    const valid = harness("positions", { codec: null });
    await expect(
      valid.service.read(request("positions")),
    ).rejects.toBeInstanceOf(PerpReadUnavailableError);
    expect(valid.resolve).toHaveBeenCalledOnce();
    expect(valid.read).not.toHaveBeenCalled();
  });

  it("rechecks binding expiry after resolver latency and before provider work", async () => {
    let currentTime = observedAt;
    const expiresAt = new Date(observedAt.getTime() + 1_000);
    const resolve = vi.fn<PerpWalletBindingResolver["resolve"]>(async () => {
      await Promise.resolve();
      currentTime = expiresAt;
      return { ...binding, expiresAt: expiresAt.toISOString() };
    });
    const read = vi.fn<HyperliquidPrivateReader["read"]>(() =>
      Promise.resolve(accountResult()),
    );
    const service = createPerpPrivateReadService({
      bindingResolver: { resolve },
      cursorCodec: cursorCodec(),
      reader: { read },
      now: () => currentTime,
    });

    await expect(service.read(request("account"))).rejects.toBeInstanceOf(
      PerpWalletBindingRequiredError,
    );
    expect(resolve).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
  });

  it("rechecks binding expiry before a retry and never starts the second provider call", async () => {
    let currentTime = observedAt;
    const expiresAt = new Date(observedAt.getTime() + 1_000);
    const resolve = vi.fn<PerpWalletBindingResolver["resolve"]>(() =>
      Promise.resolve({ ...binding, expiresAt: expiresAt.toISOString() }),
    );
    const read = vi.fn<HyperliquidPrivateReader["read"]>(() => {
      currentTime = expiresAt;
      return Promise.reject(
        new RetryableHyperliquidReadError("pre_response_transport"),
      );
    });
    const service = createPerpPrivateReadService({
      bindingResolver: { resolve },
      cursorCodec: cursorCodec(),
      reader: { read },
      now: () => currentTime,
    });

    await expect(service.read(request("account"))).rejects.toBeInstanceOf(
      PerpWalletBindingRequiredError,
    );
    expect(read).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "mixed-case address",
      { ...binding, accountAddress: accountAddress.toUpperCase() },
    ],
    ["forged owner", { ...binding, ownerUserId: otherOwnerUserId }],
    ["forged Privy owner", { ...binding, privyUserId: "did:privy:attacker" }],
    ["unknown key", { ...binding, selectedByClient: true }],
    ["zero version", { ...binding, bindingVersion: "0" }],
    [
      "future verification",
      { ...binding, verifiedAt: "2026-08-24T12:00:02.000Z" },
    ],
  ])(
    "fails closed on a malformed binding with %s",
    async (_name, malformed) => {
      const inputs = harness("account", { bindingResult: malformed });
      const result = inputs.service.read(request("account"));
      await expect(result).rejects.toBeInstanceOf(PerpReadUnavailableError);
      await expect(result).rejects.not.toThrow(accountAddress);
      expect(inputs.read).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["zero address", { ...binding, accountAddress: `0x${"0".repeat(40)}` }],
    ["agent address", { ...binding, accountKind: "agent" }],
    ["unapproved address", { ...binding, accountKind: "unapproved" }],
    [
      "expired verification",
      { ...binding, expiresAt: observedAt.toISOString() },
    ],
  ])(
    "requires a new verified binding for %s before reader work",
    async (_name, ineligible) => {
      const inputs = harness("account", { bindingResult: ineligible });

      await expect(
        inputs.service.read(request("account")),
      ).rejects.toBeInstanceOf(PerpWalletBindingRequiredError);
      expect(inputs.read).not.toHaveBeenCalled();
    },
  );

  it("maps the resolver's known unavailable state without leaking its detail", async () => {
    const inputs = harness("account");
    inputs.resolve.mockRejectedValueOnce(
      new WalletBindingResolutionUnavailableError(),
    );

    await expect(inputs.service.read(request("account"))).rejects.toEqual(
      expect.objectContaining({
        name: "PerpReadUnavailableError",
        code: "perp_read_unavailable",
        message: "Perp private reads are unavailable",
      }),
    );
    expect(inputs.read).not.toHaveBeenCalled();
  });

  it.each([
    ["limit and cursor", { kind: "orders", limit: 2, cursor: "x" }],
    ["positions limit above three", { kind: "positions", limit: 4 }],
    ["history limit above fifty", { kind: "fills", limit: 51 }],
    ["pagination on account", { kind: "account", limit: 1 }],
    ["unknown kind", { kind: "liquidations" }],
    [
      "forged Stream subject",
      { principal: { ...principal, streamUserId: "loop_forged" } },
    ],
    ["extra authority", { accountAddress }],
  ])(
    "rejects strict input with %s before binding resolution",
    async (_name, patch) => {
      const inputs = harness("orders");
      const malformed = {
        ...request("orders"),
        ...patch,
      } as PerpPrivateReadRequest;

      await expect(inputs.service.read(malformed)).rejects.toBeInstanceOf(
        InvalidPerpReadRequestError,
      );
      expect(inputs.resolve).not.toHaveBeenCalled();
      expect(inputs.read).not.toHaveBeenCalled();
    },
  );

  it("encodes provider state and decodes a cursor bound to owner, wallet version, route, and limit", async () => {
    const fullPage = clone(positionsResult()) as Record<string, unknown>;
    fullPage["items"] = [
      ...(fullPage["items"] as unknown[]),
      {
        coin: "SOL",
        side: "long",
        size: "1",
        entry_price: "100",
        leverage: { mode: "cross", value: "2", raw_usd: null },
        liquidation_price: null,
        margin_used: "50",
        position_value: "100",
        return_on_equity: "0",
        unrealized_pnl: "0",
        position_mode: "one_way",
      },
    ];
    fullPage["next_provider_cursor_state"] = "c3RhdGU";
    const inputs = harness("positions", { result: fullPage });
    const first = await inputs.service.read(request("positions", { limit: 3 }));
    expect(first).toHaveProperty("next_cursor", expect.any(String));
    const nextCursor = (first as { next_cursor: string }).next_cursor;

    inputs.read.mockResolvedValueOnce({
      items: [],
      source: source("positions"),
    });
    await inputs.service.read(request("positions", { cursor: nextCursor }));
    expect(inputs.read.mock.calls[1]?.[0]).toMatchObject({
      kind: "positions",
      limit: 3,
      providerCursorState: "c3RhdGU",
    });

    await expect(
      inputs.service.read(request("orders", { cursor: nextCursor })),
    ).rejects.toBeInstanceOf(InvalidPerpReadRequestError);
    expect(inputs.read).toHaveBeenCalledTimes(2);

    inputs.resolve.mockResolvedValueOnce({ ...binding, bindingVersion: "2" });
    await expect(
      inputs.service.read(request("positions", { cursor: nextCursor })),
    ).rejects.toBeInstanceOf(InvalidPerpReadRequestError);
    expect(inputs.read).toHaveBeenCalledTimes(2);
  });

  it("rejects an owner-bound cursor under another authenticated owner", async () => {
    const codec = cursorCodec();
    const cursor = codec.encode({
      ownerUserId,
      accountAddress,
      bindingVersion: "1",
      scope: "orders",
      limit: 20,
      providerCursorState: "c3RhdGU",
    });
    const inputs = harness("orders", {
      codec,
      requestPrincipal: otherPrincipal,
    });

    await expect(
      inputs.service.read(
        request("orders", { principal: otherPrincipal, cursor }),
      ),
    ).rejects.toBeInstanceOf(InvalidPerpReadRequestError);
    expect(inputs.read).not.toHaveBeenCalled();
  });

  it.each(["pre_response_transport", "provider_5xx"] as const)(
    "retries one %s failure with a fresh transport UUID and fixed Testnet Core scope",
    async (reason) => {
      const inputs = harness("account");
      inputs.read
        .mockRejectedValueOnce(new RetryableHyperliquidReadError(reason))
        .mockResolvedValueOnce(accountResult());

      await expect(inputs.service.read(request("account"))).resolves.toEqual(
        accountResult(),
      );
      expect(inputs.read).toHaveBeenCalledTimes(2);
      const first = inputs.read.mock.calls[0]?.[0];
      const second = inputs.read.mock.calls[1]?.[0];
      expect(first).toMatchObject({
        network: "testnet",
        dex: "",
        accountAddress,
      });
      expect(second).toMatchObject({
        network: "testnet",
        dex: "",
        accountAddress,
      });
      expect(first?.transportAttemptId).not.toBe(second?.transportAttemptId);
      expect(first?.transportAttemptId).toMatch(/^[0-9a-f-]{36}$/);
      expect(second?.transportAttemptId).toMatch(/^[0-9a-f-]{36}$/);
    },
  );

  it("stops after two known retryable failures", async () => {
    const inputs = harness("account");
    inputs.read.mockRejectedValue(
      new RetryableHyperliquidReadError("provider_5xx"),
    );

    await expect(
      inputs.service.read(request("account")),
    ).rejects.toBeInstanceOf(PerpReadUnavailableError);
    expect(inputs.read).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "provider unavailable",
      new HyperliquidPrivateReaderUnavailableError(),
      PerpReadUnavailableError,
    ],
    [
      "provider 429",
      Object.assign(new Error("secret 429 body"), { statusCode: 429 }),
      PerpReadFailedError,
    ],
    [
      "unknown adapter error",
      new Error("secret provider response"),
      PerpReadFailedError,
    ],
  ])("does not retry a %s", async (_name, failure, ExpectedError) => {
    const inputs = harness("account");
    inputs.read.mockRejectedValueOnce(failure);

    const result = inputs.service.read(request("account"));
    await expect(result).rejects.toBeInstanceOf(ExpectedError);
    await expect(result).rejects.not.toThrow("secret");
    expect(inputs.read).toHaveBeenCalledOnce();
  });

  it("retries one hard five-second attempt timeout and then fails unavailable", async () => {
    vi.useFakeTimers();
    try {
      const inputs = harness("account");
      const attemptSignals: AbortSignal[] = [];
      inputs.read.mockImplementation((readInput) => {
        attemptSignals.push(readInput.signal);
        return new Promise<never>(() => undefined);
      });
      const result = inputs.service.read(request("account"));
      const rejection = expect(result).rejects.toBeInstanceOf(
        PerpReadUnavailableError,
      );

      await vi.advanceTimersByTimeAsync(5_000);
      expect(inputs.read).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(5_000);
      await rejection;
      expect(attemptSignals).toHaveLength(2);
      expect(attemptSignals.every((signal) => signal.aborted)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves an outer route-timeout reason and never retries it", async () => {
    const inputs = harness("account");
    const controller = new AbortController();
    let started: (() => void) | undefined;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    inputs.read.mockImplementation(
      (readInput) =>
        new Promise<never>((_resolve, reject) => {
          started?.();
          readInput.signal.addEventListener(
            "abort",
            () =>
              reject(
                readInput.signal.reason instanceof Error
                  ? readInput.signal.reason
                  : new Error("The read signal was aborted"),
              ),
            { once: true },
          );
        }),
    );
    const timeoutReason = new Error("route timeout sentinel");
    const result = inputs.service.read(
      request("account", { signal: controller.signal }),
    );
    await didStart;
    controller.abort(timeoutReason);

    await expect(result).rejects.toBe(timeoutReason);
    expect(inputs.read).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "extra field",
      (value: Record<string, unknown>) => {
        value["wallet"] = accountAddress;
      },
    ],
    [
      "numeric decimal",
      (value: Record<string, unknown>) => {
        (value["items"] as Record<string, unknown>[])[0]!["size"] = 1;
      },
    ],
    [
      "oversized decimal",
      (value: Record<string, unknown>) => {
        (value["items"] as Record<string, unknown>[])[0]!["size"] = "1".repeat(
          129,
        );
      },
    ],
    [
      "non-Core coin",
      (value: Record<string, unknown>) => {
        (value["items"] as Record<string, unknown>[])[0]!["coin"] = "DOGE";
      },
    ],
    [
      "nonempty DEX",
      (value: Record<string, unknown>) => {
        (value["source"] as Record<string, unknown>)["dex"] = "xyz";
      },
    ],
    [
      "wrong dataset",
      (value: Record<string, unknown>) => {
        (value["source"] as Record<string, unknown>)["dataset"] = "orders";
      },
    ],
    [
      "stale source",
      (value: Record<string, unknown>) => {
        (value["source"] as Record<string, unknown>)["expires_at"] =
          observedAt.toISOString();
      },
    ],
    [
      "future source",
      (value: Record<string, unknown>) => {
        (value["source"] as Record<string, unknown>)["fetched_at"] =
          "2026-08-24T12:00:01.500Z";
        (value["source"] as Record<string, unknown>)["expires_at"] =
          "2026-08-24T12:00:02.500Z";
      },
    ],
  ])(
    "rejects a malformed provider result with %s without retry or filtering",
    async (_name, mutate) => {
      const malformed = clone(positionsResult()) as Record<string, unknown>;
      mutate(malformed);
      const inputs = harness("positions", { result: malformed });

      await expect(
        inputs.service.read(request("positions")),
      ).rejects.toBeInstanceOf(PerpReadUnavailableError);
      expect(inputs.read).toHaveBeenCalledOnce();
    },
  );

  it.each([
    [
      "position order",
      "positions",
      3,
      (value: Record<string, unknown>) => {
        (value["items"] as unknown[]).reverse();
      },
    ],
    [
      "duplicate order",
      "orders",
      20,
      (value: Record<string, unknown>) => {
        const items = value["items"] as Record<string, unknown>[];
        items[1]!["order_id"] = items[0]!["order_id"];
      },
    ],
    [
      "order size growth",
      "orders",
      20,
      (value: Record<string, unknown>) => {
        (value["items"] as Record<string, unknown>[])[0]!["remaining_size"] =
          "0.1001";
      },
    ],
    [
      "fill sort",
      "fills",
      20,
      (value: Record<string, unknown>) => {
        (value["items"] as unknown[]).reverse();
      },
    ],
    [
      "funding coin tie sort",
      "funding",
      20,
      (value: Record<string, unknown>) => {
        (value["items"] as unknown[]).reverse();
      },
    ],
  ])(
    "rejects invalid list invariants: %s",
    async (_name, kind, limit, mutate) => {
      const malformed = clone(
        resultFor(kind as HyperliquidPrivateReadKind),
      ) as Record<string, unknown>;
      mutate(malformed);
      const inputs = harness(kind as HyperliquidPrivateReadKind, {
        result: malformed,
      });

      await expect(
        inputs.service.read(
          request(kind as HyperliquidPrivateReadKind, { limit }),
        ),
      ).rejects.toBeInstanceOf(PerpReadUnavailableError);
    },
  );

  it("rejects more items than requested and provider continuation on a non-full page", async () => {
    const tooMany = harness("positions");
    await expect(
      tooMany.service.read(request("positions", { limit: 1 })),
    ).rejects.toBeInstanceOf(PerpReadUnavailableError);

    const shortWithCursor = clone(positionsResult()) as Record<string, unknown>;
    shortWithCursor["next_provider_cursor_state"] = "c3RhdGU";
    const inputs = harness("positions", { result: shortWithCursor });
    await expect(
      inputs.service.read(request("positions", { limit: 3 })),
    ).rejects.toBeInstanceOf(PerpReadUnavailableError);
  });

  it.each(listKinds)(
    "accepts a fresh empty %s page as explicit provider truth",
    async (kind) => {
      const empty = {
        items: [],
        ...(kind === "fills" || kind === "funding"
          ? { coverage: coverage() }
          : {}),
        source: source(kind),
      };
      const response = await harness(kind, { result: empty }).service.read(
        request(kind),
      );

      expect(response).toEqual({ ...empty, next_cursor: null });
    },
  );
});
