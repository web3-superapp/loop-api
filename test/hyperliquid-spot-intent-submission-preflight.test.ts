import { describe, expect, it, vi } from "vitest";

import {
  SpotIntentExpiredError,
  SpotIntentStaleError,
} from "../src/features/spot/spot-intent-service.js";
import type {
  SpotIntentSubmissionPolicyGate,
  SpotIntentSubmissionPreflight,
  SpotIntentSubmissionSubject,
} from "../src/features/spot/spot-intent-submission.js";
import {
  SpotIntentPrepareAuthorityRequiredError,
  type SpotIntentPrepareAuthorityResolver,
} from "../src/features/spot/spot-intent-prepare.js";
import {
  SpotUnavailableError,
  SpotWalletBindingRequiredError,
} from "../src/features/spot/spot-errors.js";
import {
  HYPERLIQUID_TESTNET_USDC_TOKEN_ID,
  type HyperliquidSpotBalancesSnapshot,
  type HyperliquidSpotInfoReader,
  type HyperliquidSpotMetadataSnapshot,
  type HyperliquidSpotUserFeesSnapshot,
} from "../src/integrations/hyperliquid/spot-info-contract.js";
import { createHyperliquidSpotIntentSubmissionPreflight } from "../src/integrations/hyperliquid/spot-intent-submission-preflight.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";
const intentId = "22222222-2222-4222-8222-222222222222";
const marketId = "33333333-3333-4333-8333-333333333333";
const routeRequestId = "44444444-4444-4444-8444-444444444444";
const agentIdentityId = "55555555-5555-4555-8555-555555555555";
const firstAuthorityRequestId = "66666666-6666-4666-8666-666666666666";
const policyRequestId = "77777777-7777-4777-8777-777777777777";
const finalAuthorityRequestId = "88888888-8888-4888-8888-888888888888";
const nowIso = "2026-08-28T00:00:01.000Z";
const nowMilliseconds = Date.parse(nowIso);
const metadataVersion = "a".repeat(64);
const reviewSha256 = "b".repeat(64);
const baseTokenId = `0x${"11".repeat(16)}`;
const accountAddress = `0x${"22".repeat(20)}`;

function isoFromNow(offsetMilliseconds: number): string {
  return new Date(nowMilliseconds + offsetMilliseconds).toISOString();
}

function subject(
  overrides: Partial<SpotIntentSubmissionSubject> = {},
): SpotIntentSubmissionSubject {
  return Object.freeze({
    ownerUserId,
    intentId,
    network: "testnet",
    marketId,
    providerCoin: "PURR/USDC",
    baseTokenIndex: 1,
    baseTokenId,
    baseDisplayIdentity: "PURR",
    quoteTokenIndex: 0,
    quoteTokenId: HYPERLIQUID_TESTNET_USDC_TOKEN_ID,
    quoteDisplayIdentity: "USDC",
    spotPairIndex: 0,
    exchangeOrderAsset: 10_000,
    metadataVersion,
    metadataSha256: metadataVersion,
    policyVersion: "spot_test_policy_v1",
    accountAddress,
    bindingVersion: "7",
    agentIdentityId,
    reviewSha256,
    side: "buy",
    computedBaseSize: "2",
    maximumSpendOrMinimumReceive: Object.freeze({
      kind: "maximum_spend" as const,
      value: "10",
    }),
    feeRate: "0.001",
    expiresAt: isoFromNow(15_000),
    ...overrides,
  });
}

function authority(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    ownerUserId,
    privyUserId: "did:privy:spot-submit-preflight",
    walletId: "privy-wallet-submit-preflight",
    accountAddress,
    accountKind: "master",
    bindingVersion: "7",
    agentIdentityId,
    verifiedAt: isoFromNow(-100),
    expiresAt: isoFromNow(14_000),
    ...overrides,
  });
}

function metadata(
  overrides: Partial<HyperliquidSpotMetadataSnapshot> = {},
): HyperliquidSpotMetadataSnapshot {
  return Object.freeze({
    markets: Object.freeze([
      Object.freeze({
        marketId,
        coin: "PURR/USDC",
        base: Object.freeze({
          tokenIndex: 1,
          tokenId: baseTokenId,
          symbol: "PURR",
          fullName: "Purr",
          sizeDecimals: 5,
          weiDecimals: 8,
        }),
        quote: Object.freeze({
          tokenIndex: 0,
          tokenId: HYPERLIQUID_TESTNET_USDC_TOKEN_ID,
          symbol: "USDC",
          fullName: "USD Coin",
          sizeDecimals: 8,
          weiDecimals: 8,
        }),
        spotPairIndex: 0,
        exchangeOrderAsset: 10_000,
        context: Object.freeze({
          previousDayPrice: "5",
          dayNotionalVolume: "1000",
          markPrice: "5",
          midPrice: "5",
          circulatingSupply: "1000000",
          totalSupply: "1000000",
          dayBaseVolume: "200",
        }),
      }),
    ]),
    metadataVersion,
    source: Object.freeze({
      provider: "hyperliquid",
      network: "testnet",
      dataset: "spotMetaAndAssetCtxs",
      fetchedAt: isoFromNow(-100),
      expiresAt: isoFromNow(59_900),
    }),
    ...overrides,
  });
}

function balances(
  availableQuote = "10",
  availableBase = "2",
  overrides: Partial<HyperliquidSpotBalancesSnapshot> = {},
): HyperliquidSpotBalancesSnapshot {
  return Object.freeze({
    items: Object.freeze([
      Object.freeze({
        token: metadata().markets[0]!.quote,
        total: availableQuote,
        hold: "0",
        available: availableQuote,
        entryNotional: "0",
      }),
      Object.freeze({
        token: metadata().markets[0]!.base,
        total: availableBase,
        hold: "0",
        available: availableBase,
        entryNotional: "10",
      }),
    ]),
    source: Object.freeze({
      provider: "hyperliquid",
      network: "testnet",
      dataset: "spotClearinghouseState",
      fetchedAt: isoFromNow(-50),
      expiresAt: isoFromNow(1_950),
      metadataVersion,
    }),
    ...overrides,
  });
}

function fees(
  takerRate = "0.0007",
  overrides: Partial<HyperliquidSpotUserFeesSnapshot> = {},
): HyperliquidSpotUserFeesSnapshot {
  return Object.freeze({
    accountSpotMakerRate: "0.0004",
    accountSpotTakerRate: takerRate,
    source: Object.freeze({
      provider: "hyperliquid",
      network: "testnet",
      dataset: "userFees",
      fetchedAt: isoFromNow(-50),
      expiresAt: isoFromNow(1_950),
    }),
    ...overrides,
  });
}

function policyEvidence() {
  return Object.freeze({
    ownerUserId,
    intentId,
    network: "testnet" as const,
    action: "spot_ioc_order" as const,
    decision: "allow" as const,
    policyVersion: "spot_test_policy_v1",
    productEnabled: true as const,
    legalEligible: true as const,
    sanctionsEligible: true as const,
    killSwitchOpen: true as const,
    signerReady: true as const,
    reconciliationReady: true as const,
    checkedAt: nowIso,
    expiresAt: isoFromNow(14_000),
  });
}

function submitInput(
  submissionSubject = subject(),
  signal = new AbortController().signal,
): Parameters<SpotIntentSubmissionPreflight["prepare"]>[0] {
  return {
    ownerUserId,
    privyUserId: "did:privy:spot-submit-preflight",
    intentId,
    marketId,
    network: "testnet",
    action: "spot_ioc_order",
    expectedReviewSha256: reviewSha256,
    subject: submissionSubject,
    requestId: routeRequestId,
    signal,
  };
}

function harness(
  options: {
    readonly authorities?: readonly unknown[];
    readonly metadata?: unknown;
    readonly balances?: unknown;
    readonly fees?: unknown;
    readonly policy?: unknown;
    readonly timeoutMilliseconds?: number;
  } = {},
) {
  const authorityValues = [
    ...(options.authorities ?? [authority(), authority()]),
  ];
  const authorityResolver = {
    resolve: vi.fn<SpotIntentPrepareAuthorityResolver["resolve"]>(() =>
      Promise.resolve(authorityValues.shift()),
    ),
  } satisfies SpotIntentPrepareAuthorityResolver;
  const readMetadata = vi.fn<HyperliquidSpotInfoReader["readMetadata"]>(() =>
    Promise.resolve(
      (options.metadata ?? metadata()) as HyperliquidSpotMetadataSnapshot,
    ),
  );
  const readBook = vi.fn<HyperliquidSpotInfoReader["readBook"]>();
  const readBalances = vi.fn<HyperliquidSpotInfoReader["readBalances"]>(() =>
    Promise.resolve(
      (options.balances ?? balances()) as HyperliquidSpotBalancesSnapshot,
    ),
  );
  const readUserFees = vi.fn<HyperliquidSpotInfoReader["readUserFees"]>(() =>
    Promise.resolve(
      (options.fees ?? fees()) as HyperliquidSpotUserFeesSnapshot,
    ),
  );
  const infoReader = {
    readMetadata,
    readBook,
    readBalances,
    readUserFees,
  } satisfies HyperliquidSpotInfoReader;
  const policyGate = {
    evaluate: vi.fn<SpotIntentSubmissionPolicyGate["evaluate"]>(() =>
      Promise.resolve(options.policy ?? policyEvidence()),
    ),
  } satisfies SpotIntentSubmissionPolicyGate;
  const requestIds = [
    firstAuthorityRequestId,
    policyRequestId,
    finalAuthorityRequestId,
  ];
  const preflight = createHyperliquidSpotIntentSubmissionPreflight({
    authorityResolver,
    infoReader,
    policyGate,
    createUuid: () => requestIds.shift() ?? routeRequestId,
    now: () => new Date(nowIso),
    ...(options.timeoutMilliseconds === undefined
      ? {}
      : { timeoutMilliseconds: options.timeoutMilliseconds }),
  });
  return { authorityResolver, infoReader, policyGate, preflight };
}

describe("Hyperliquid Spot intent submission preflight", () => {
  it("returns sanitized fresh authority evidence after exact buy funds and fee checks", async () => {
    const input = harness();

    const evidence = await input.preflight.prepare(submitInput());

    expect(evidence).toEqual({
      walletEvidence: {
        ownerUserId,
        privyUserId: "did:privy:spot-submit-preflight",
        walletId: "privy-wallet-submit-preflight",
        accountAddress,
        accountKind: "master",
        bindingVersion: "7",
        verifiedAt: isoFromNow(-100),
        expiresAt: isoFromNow(14_000),
      },
      marketEvidence: {
        provider: "hyperliquid",
        network: "testnet",
        dataset: "spotMetaAndAssetCtxs",
        marketId,
        providerCoin: "PURR/USDC",
        baseTokenIndex: 1,
        baseTokenId,
        quoteTokenIndex: 0,
        quoteTokenId: HYPERLIQUID_TESTNET_USDC_TOKEN_ID,
        spotPairIndex: 0,
        exchangeOrderAsset: 10_000,
        metadataVersion,
        metadataSha256: metadataVersion,
        fetchedAt: isoFromNow(-100),
        expiresAt: isoFromNow(59_900),
      },
      accountEvidence: {
        provider: "hyperliquid",
        network: "testnet",
        accountAddress,
        metadataVersion,
        balance: {
          dataset: "spotClearinghouseState",
          tokenIndex: 0,
          tokenId: HYPERLIQUID_TESTNET_USDC_TOKEN_ID,
          available: "10",
          fetchedAt: isoFromNow(-50),
          expiresAt: isoFromNow(1_950),
        },
        fees: {
          dataset: "userFees",
          currentTakerRate: "0.0007",
          fetchedAt: isoFromNow(-50),
          expiresAt: isoFromNow(1_950),
        },
      },
      policyEvidence: policyEvidence(),
    });
    expect(input.authorityResolver.resolve).toHaveBeenCalledTimes(2);
    expect(
      input.authorityResolver.resolve.mock.calls.map(
        ([value]) => value.requestId,
      ),
    ).toEqual([firstAuthorityRequestId, finalAuthorityRequestId]);
    expect(input.infoReader.readMetadata).toHaveBeenCalledOnce();
    expect(
      input.infoReader.readBalances.mock.calls[0]?.[0].accountAddress,
    ).toBe(accountAddress);
    expect(
      input.infoReader.readBalances.mock.calls[0]?.[0].signal,
    ).toBeInstanceOf(AbortSignal);
    expect(
      input.infoReader.readUserFees.mock.calls[0]?.[0].accountAddress,
    ).toBe(accountAddress);
    expect(
      input.infoReader.readUserFees.mock.calls[0]?.[0].signal,
    ).toBeInstanceOf(AbortSignal);
    expect(input.infoReader.readBook).not.toHaveBeenCalled();
    expect(input.policyGate.evaluate.mock.calls[0]?.[0].subject).toEqual(
      subject(),
    );
    expect(input.policyGate.evaluate.mock.calls[0]?.[0].requestId).toBe(
      policyRequestId,
    );
    expect(input.policyGate.evaluate.mock.calls[0]?.[0].signal).toBeInstanceOf(
      AbortSignal,
    );
    expect(JSON.stringify(evidence)).not.toContain("entryNotional");
    expect(JSON.stringify(evidence)).not.toContain("accountSpotMakerRate");
    expect(JSON.stringify(evidence)).not.toContain('"total"');
    expect(JSON.stringify(evidence)).not.toContain('"hold"');
  });

  it("accepts exact buy and sell balance boundaries without Number coercion", async () => {
    const buy = harness({ balances: balances("10.00000000", "2") });
    await expect(buy.preflight.prepare(submitInput())).resolves.toBeDefined();

    const sellSubject = subject({
      side: "sell",
      computedBaseSize: "2.00000",
      maximumSpendOrMinimumReceive: Object.freeze({
        kind: "minimum_receive",
        value: "9.98",
      }),
    });
    const sell = harness({ balances: balances("0", "2") });
    await expect(
      sell.preflight.prepare(submitInput(sellSubject)),
    ).resolves.toBeDefined();
  });

  it("accepts 18-decimal balance atoms, signed entry notional, and a maker rebate", async () => {
    const originalMetadata = metadata();
    const originalMarket = originalMetadata.markets[0]!;
    const base = Object.freeze({
      ...originalMarket.base,
      weiDecimals: 18,
    });
    const metadataWithAtomicBase = Object.freeze({
      ...originalMetadata,
      markets: Object.freeze([Object.freeze({ ...originalMarket, base })]),
    });
    const balanceWithAtomicBase = Object.freeze({
      ...balances(),
      items: Object.freeze([
        Object.freeze({
          token: base,
          total: "2.000000000000000001",
          hold: "0",
          available: "2.000000000000000001",
          entryNotional: "-0.01",
        }),
      ]),
    });
    const sellSubject = subject({
      side: "sell",
      computedBaseSize: "2.00000",
      maximumSpendOrMinimumReceive: Object.freeze({
        kind: "minimum_receive",
        value: "9.98",
      }),
    });
    const input = harness({
      metadata: metadataWithAtomicBase,
      balances: balanceWithAtomicBase,
      fees: fees("0.001", { accountSpotMakerRate: "-0.0004" }),
    });

    await expect(
      input.preflight.prepare(submitInput(sellSubject)),
    ).resolves.toHaveProperty(
      "accountEvidence.balance.available",
      "2.000000000000000001",
    );
  });

  it("rejects a sell size outside the current market lot precision", async () => {
    const sellSubject = subject({
      side: "sell",
      computedBaseSize: "2.000001",
      maximumSpendOrMinimumReceive: Object.freeze({
        kind: "minimum_receive",
        value: "9.98",
      }),
    });
    const input = harness({ balances: balances("0", "3") });

    await expect(
      input.preflight.prepare(submitInput(sellSubject)),
    ).rejects.toBeInstanceOf(SpotUnavailableError);
    expect(input.authorityResolver.resolve).toHaveBeenCalledOnce();
  });

  it.each([
    ["buy", subject(), balances("9.99999999", "100")],
    [
      "sell",
      subject({
        side: "sell",
        computedBaseSize: "2.00001",
        maximumSpendOrMinimumReceive: Object.freeze({
          kind: "minimum_receive",
          value: "9.98",
        }),
      }),
      balances("100", "2"),
    ],
  ] as const)(
    "rejects insufficient %s available balance before final authority resolution",
    async (_side, submissionSubject, balanceSnapshot) => {
      const input = harness({ balances: balanceSnapshot });

      await expect(
        input.preflight.prepare(submitInput(submissionSubject)),
      ).rejects.toBeInstanceOf(SpotUnavailableError);

      expect(input.authorityResolver.resolve).toHaveBeenCalledOnce();
    },
  );

  it("rejects a fresh account fee above the persisted review ceiling", async () => {
    const input = harness({ fees: fees("0.0010000001") });

    await expect(input.preflight.prepare(submitInput())).rejects.toBeInstanceOf(
      SpotIntentStaleError,
    );
    expect(input.authorityResolver.resolve).toHaveBeenCalledOnce();
  });

  it("accepts a fresh account fee exactly equal to the persisted ceiling", async () => {
    const input = harness({ fees: fees("0.0010000") });

    await expect(input.preflight.prepare(submitInput())).resolves.toBeDefined();
  });

  it("rejects metadata drift before private balance or fee reads", async () => {
    const drifted = metadata({ metadataVersion: "c".repeat(64) });
    const input = harness({ metadata: drifted });

    await expect(input.preflight.prepare(submitInput())).rejects.toBeInstanceOf(
      SpotIntentStaleError,
    );
    expect(input.infoReader.readBalances).not.toHaveBeenCalled();
    expect(input.infoReader.readUserFees).not.toHaveBeenCalled();
    expect(input.policyGate.evaluate).not.toHaveBeenCalled();
  });

  it("rejects wallet, binding, or Agent drift after provider reads", async () => {
    const input = harness({
      authorities: [authority(), authority({ bindingVersion: "8" })],
    });

    await expect(input.preflight.prepare(submitInput())).rejects.toBeInstanceOf(
      SpotIntentStaleError,
    );
    expect(input.infoReader.readBalances).toHaveBeenCalledOnce();
    expect(input.policyGate.evaluate).toHaveBeenCalledOnce();
  });

  it("preserves the allowlisted wallet-authority-required outcome", async () => {
    const input = harness();
    input.authorityResolver.resolve.mockRejectedValueOnce(
      new SpotIntentPrepareAuthorityRequiredError(),
    );

    await expect(input.preflight.prepare(submitInput())).rejects.toBeInstanceOf(
      SpotWalletBindingRequiredError,
    );
    expect(input.infoReader.readMetadata).not.toHaveBeenCalled();
  });

  it("rejects an expired review before any dependency read", async () => {
    const input = harness();
    const expired = subject({ expiresAt: nowIso });

    await expect(
      input.preflight.prepare(submitInput(expired)),
    ).rejects.toBeInstanceOf(SpotIntentExpiredError);
    expect(input.authorityResolver.resolve).not.toHaveBeenCalled();
    expect(input.infoReader.readMetadata).not.toHaveBeenCalled();
  });

  it("rejects malformed, stale, short-lived, or mismatched policy evidence", async () => {
    const cases: unknown[] = [
      { ...policyEvidence(), decision: "deny" },
      { ...policyEvidence(), ownerUserId: intentId },
      { ...policyEvidence(), policyVersion: "changed_policy" },
      { ...policyEvidence(), expiresAt: nowIso },
      { ...policyEvidence(), expiresAt: isoFromNow(9_999) },
      { ...policyEvidence(), arbitrary: true },
    ];
    for (const policy of cases) {
      const input = harness({ policy });
      await expect(
        input.preflight.prepare(submitInput()),
      ).rejects.toBeInstanceOf(SpotUnavailableError);
    }
  });

  it("rejects malformed balance arithmetic and duplicate target tokens", async () => {
    const invalidArithmetic = balances("10", "2", {
      items: Object.freeze([
        Object.freeze({
          ...balances().items[0]!,
          total: "10",
          hold: "1",
          available: "10",
        }),
      ]),
    });
    const duplicate = balances("10", "2", {
      items: Object.freeze([balances().items[0]!, { ...balances().items[0]! }]),
    });
    for (const balanceSnapshot of [invalidArithmetic, duplicate]) {
      const input = harness({ balances: balanceSnapshot });
      await expect(
        input.preflight.prepare(submitInput()),
      ).rejects.toBeInstanceOf(SpotUnavailableError);
    }
  });

  it("enforces a hard internal deadline even when a dependency ignores abort", async () => {
    const input = harness({ timeoutMilliseconds: 20 });
    input.infoReader.readMetadata.mockImplementationOnce(
      () => new Promise(() => undefined),
    );

    await expect(input.preflight.prepare(submitInput())).rejects.toBeInstanceOf(
      SpotUnavailableError,
    );
    expect(input.infoReader.readBalances).not.toHaveBeenCalled();
  });

  it("rejects strict input drift and an already aborted request before dependencies", async () => {
    const strict = harness();
    await expect(
      strict.preflight.prepare({
        ...submitInput(),
        extra: true,
      } as Parameters<SpotIntentSubmissionPreflight["prepare"]>[0]),
    ).rejects.toBeInstanceOf(SpotUnavailableError);
    expect(strict.authorityResolver.resolve).not.toHaveBeenCalled();

    const aborted = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(
      aborted.preflight.prepare(submitInput(subject(), controller.signal)),
    ).rejects.toBeInstanceOf(SpotUnavailableError);
    expect(aborted.authorityResolver.resolve).not.toHaveBeenCalled();
  });

  it("sanitizes provider and policy failures without returning raw details", async () => {
    const provider = harness();
    provider.infoReader.readBalances.mockRejectedValueOnce(
      new Error("raw account balance payload"),
    );
    const failure = await provider.preflight
      .prepare(submitInput())
      .catch((error: unknown) => error);
    expect(failure).toEqual(new SpotUnavailableError());
    expect(String(failure)).not.toContain("raw account balance payload");

    const policy = harness();
    policy.policyGate.evaluate.mockRejectedValueOnce(
      new Error("private sanctions provider detail"),
    );
    await expect(policy.preflight.prepare(submitInput())).rejects.toEqual(
      new SpotUnavailableError(),
    );
  });
});
