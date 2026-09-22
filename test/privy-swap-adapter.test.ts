import { describe, expect, it, vi } from "vitest";

import {
  classifyPrivyFailure,
  createPrivySwapAdapter,
  createUnavailablePrivySwapAdapter,
  PrivySwapProviderError,
  type PrivySwapClient,
} from "../src/integrations/privy/swap-adapter.js";

const signal = new AbortController().signal;
const usdt = "0x55d398326f99059ff775485246999027b3197955";
const wbnb = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";

function clientFake(
  overrides: Partial<{
    readonly quote: unknown;
    readonly execute: unknown;
    readonly action: unknown;
    readonly quoteError: unknown;
    readonly executeError: unknown;
  }> = {},
) {
  const quote = vi.fn(() =>
    overrides.quoteError !== undefined
      ? Promise.reject(
          overrides.quoteError instanceof Error
            ? overrides.quoteError
            : new Error("quote failed"),
        )
      : Promise.resolve(
          overrides.quote ?? {
            caip2: "eip155:56",
            est_output_amount: "9990000000000000",
            gas_estimate: "150000",
            input_amount: "6000000000000000000",
            input_token: usdt.toUpperCase(),
            minimum_output_amount: "9940000000000000",
            output_token: wbnb,
          },
        ),
  );
  const execute = vi.fn(() =>
    overrides.executeError !== undefined
      ? Promise.reject(
          overrides.executeError instanceof Error
            ? overrides.executeError
            : new Error("execute failed"),
        )
      : Promise.resolve(
          overrides.execute ?? {
            id: "act_123",
            caip2: "eip155:56",
            created_at: "2026-09-08T00:00:00.000Z",
            input_amount: null,
            input_token: usdt,
            output_amount: null,
            output_token: wbnb,
            status: "pending",
            type: "swap",
            wallet_id: "wallet_1",
          },
        ),
  );
  const get = vi.fn(() =>
    Promise.resolve(
      overrides.action ?? {
        id: "act_123",
        status: "failed",
        failure_reason: { message: "Insufficient output amount!" },
        steps: [
          { status: "reverted", transaction_hash: `0x${"A".repeat(64)}` },
        ],
      },
    ),
  );
  const client: PrivySwapClient = {
    swap: { quote, execute },
    actions: { get },
  };
  return { client, quote, execute, get };
}

describe("Privy Swap adapter", () => {
  it("maps a quote and normalises token addresses", async () => {
    const { client, quote } = clientFake();
    const adapter = createPrivySwapAdapter(client);
    const result = await adapter.quote({
      providerWalletId: "wallet_1",
      source: { assetAddress: usdt, caip2: "eip155:56" },
      destination: { assetAddress: wbnb, caip2: "eip155:56" },
      baseAmount: "6000000000000000000",
      slippageBps: 50,
      feeBps: null,
      signal,
    });
    expect(result).toEqual({
      caip2: "eip155:56",
      inputToken: usdt,
      outputToken: wbnb,
      inputAmount: "6000000000000000000",
      estimatedOutputAmount: "9990000000000000",
      minimumOutputAmount: "9940000000000000",
      gasEstimate: "150000",
      providerExpiresAt: null,
    });
    expect(quote).toHaveBeenCalledWith(
      "wallet_1",
      {
        base_amount: "6000000000000000000",
        source: { asset_address: usdt, caip2: "eip155:56" },
        destination: { asset_address: wbnb, caip2: "eip155:56" },
        amount_type: "exact_input",
        slippage_bps: 50,
      },
      { signal, timeout: 8_000, maxRetries: 0 },
    );
  });

  it("forwards the device signature, idempotency key, and expiry unchanged on execute", async () => {
    const { client, execute } = clientFake();
    const adapter = createPrivySwapAdapter(client, {
      now: () => new Date("2026-09-08T00:00:00.000Z"),
    });
    const body = {
      base_amount: "6000000000000000000",
      source: { asset_address: usdt, caip2: "eip155:56" },
      destination: { asset_address: wbnb, caip2: "eip155:56" },
      amount_type: "exact_input" as const,
      slippage_bps: 50,
    };
    const action = await adapter.execute({
      providerWalletId: "wallet_1",
      body,
      authorizationSignature: "sig",
      idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      requestExpiryMs: String(Date.parse("2026-09-08T00:00:30.000Z")),
      signal,
    });
    expect(action).toMatchObject({
      actionId: "act_123",
      status: "pending",
      steps: [],
    });
    expect(execute).toHaveBeenCalledWith(
      "wallet_1",
      {
        ...body,
        "privy-authorization-signature": "sig",
        "privy-idempotency-key": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "privy-request-expiry": String(Date.parse("2026-09-08T00:00:30.000Z")),
      },
      { signal, timeout: 10_000, maxRetries: 0 },
    );
  });

  it("refuses to send an already-expired request", async () => {
    const { client, execute } = clientFake();
    const adapter = createPrivySwapAdapter(client, {
      now: () => new Date("2026-09-08T00:01:00.000Z"),
    });
    await expect(
      adapter.execute({
        providerWalletId: "wallet_1",
        body: {
          base_amount: "1",
          source: { asset_address: usdt, caip2: "eip155:56" },
          destination: { asset_address: wbnb, caip2: "eip155:56" },
          amount_type: "exact_input",
          slippage_bps: 50,
        },
        authorizationSignature: "sig",
        idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        requestExpiryMs: String(Date.parse("2026-09-08T00:00:30.000Z")),
        signal,
      }),
    ).rejects.toMatchObject({
      kind: "rejected",
      reasonCode: "PRIVY_REQUEST_EXPIRED",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("classifies definitive 4xx as rejected and everything else as ambiguous", () => {
    expect(classifyPrivyFailure({ status: 400 })).toBe("rejected");
    expect(classifyPrivyFailure({ status: 422 })).toBe("rejected");
    expect(classifyPrivyFailure({ status: 408 })).toBe("ambiguous");
    expect(classifyPrivyFailure({ status: 429 })).toBe("ambiguous");
    expect(classifyPrivyFailure({ status: 500 })).toBe("ambiguous");
    expect(classifyPrivyFailure(new Error("socket hang up"))).toBe("ambiguous");
  });

  it("wraps execute failures with the classification and never with the body", async () => {
    const rejected = createPrivySwapAdapter(
      clientFake({
        executeError: Object.assign(new Error("bad"), { status: 400 }),
      }).client,
    );
    const request = {
      providerWalletId: "wallet_1",
      body: {
        base_amount: "1",
        source: { asset_address: usdt, caip2: "eip155:56" },
        destination: { asset_address: wbnb, caip2: "eip155:56" },
        amount_type: "exact_input" as const,
        slippage_bps: 50,
      },
      authorizationSignature: "sig",
      idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      requestExpiryMs: String(Date.now() + 60_000),
      signal,
    };
    await expect(rejected.execute(request)).rejects.toMatchObject({
      kind: "rejected",
      reasonCode: "PRIVY_SWAP_REJECTED",
    });
    const ambiguous = createPrivySwapAdapter(
      clientFake({
        executeError: Object.assign(new Error("timeout"), { status: 504 }),
      }).client,
    );
    await expect(ambiguous.execute(request)).rejects.toMatchObject({
      kind: "ambiguous",
      reasonCode: "PRIVY_SWAP_RESULT_AMBIGUOUS",
    });
    const malformed = createPrivySwapAdapter(
      clientFake({ execute: { nope: true } }).client,
    );
    await expect(malformed.execute(request)).rejects.toMatchObject({
      kind: "ambiguous",
      reasonCode: "PRIVY_SWAP_RESPONSE_MALFORMED",
    });
  });

  it("maps action status, step hashes, and a bounded failure reason", async () => {
    const adapter = createPrivySwapAdapter(clientFake().client);
    const action = await adapter.getAction({
      providerWalletId: "wallet_1",
      actionId: "act_123",
      signal,
    });
    expect(action).toEqual({
      actionId: "act_123",
      status: "failed",
      inputAmount: null,
      outputAmount: null,
      steps: [{ status: "reverted", transactionHash: `0x${"a".repeat(64)}` }],
      failureReasonCode: "PRIVY_INSUFFICIENT_OUTPUT_AMOUNT",
    });
  });

  it("reports a Provider authorization refusal on a quote as unavailable (Decision 0065)", async () => {
    const refusal = Object.assign(
      new Error('403 {"error":"Swaps are not enabled for this app"}'),
      { status: 403 },
    );
    const adapter = createPrivySwapAdapter(
      clientFake({ quoteError: refusal }).client,
    );
    await expect(
      adapter.quote({
        providerWalletId: "wallet_1",
        source: { assetAddress: usdt, caip2: "eip155:56" },
        destination: { assetAddress: wbnb, caip2: "eip155:56" },
        baseAmount: "1",
        slippageBps: 50,
        feeBps: null,
        signal,
      }),
    ).rejects.toMatchObject({
      kind: "unavailable",
      reasonCode: "PRIVY_SWAP_NOT_AUTHORIZED",
    });

    const rejecting = createPrivySwapAdapter(
      clientFake({
        quoteError: Object.assign(new Error("400"), { status: 400 }),
      }).client,
    );
    await expect(
      rejecting.quote({
        providerWalletId: "wallet_1",
        source: { assetAddress: usdt, caip2: "eip155:56" },
        destination: { assetAddress: wbnb, caip2: "eip155:56" },
        baseAmount: "1",
        slippageBps: 50,
        feeBps: null,
        signal,
      }),
    ).rejects.toMatchObject({
      kind: "rejected",
      reasonCode: "PRIVY_SWAP_QUOTE_REJECTED",
    });
  });

  it("reports a malformed quote as unavailable and stays closed without credentials", async () => {
    const adapter = createPrivySwapAdapter(
      clientFake({ quote: { caip2: 5 } }).client,
    );
    await expect(
      adapter.quote({
        providerWalletId: "wallet_1",
        source: { assetAddress: usdt, caip2: "eip155:56" },
        destination: { assetAddress: wbnb, caip2: "eip155:56" },
        baseAmount: "1",
        slippageBps: 50,
        feeBps: 25,
        signal,
      }),
    ).rejects.toBeInstanceOf(PrivySwapProviderError);
    await expect(
      createUnavailablePrivySwapAdapter().getAction({
        providerWalletId: "wallet_1",
        actionId: "act_1",
        signal,
      }),
    ).rejects.toMatchObject({
      kind: "unavailable",
      reasonCode: "PRIVY_NOT_CONFIGURED",
    });
  });
});
