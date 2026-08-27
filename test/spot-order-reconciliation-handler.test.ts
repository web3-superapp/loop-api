import { describe, expect, it, vi } from "vitest";

import type { AtomicDomainReconciliationInput } from "../src/features/reconciliation/authoritative-reader.js";
import {
  createSpotOrderReconciliationHandler,
  type SpotOrderAuthoritativeReader,
  type SpotOrderAuthoritativeReadResult,
} from "../src/features/spot/spot-order-reconciliation-handler.js";
import type {
  SpotIntentReconciliationSubject,
  SpotIntentTerminalResolution,
  SpotRejectedReconciliationReasonCode,
  SpotReconciliationCanonicalAction,
  SpotReconciliationRepository,
} from "../src/features/spot/spot-reconciliation-contract.js";

const operationId = "29c33b23-6134-489c-ab0d-a5c82a9b54e2";
const otherOperationId = "d7acf2fe-7ebd-4de8-8943-c029354f6541";
const ownerUserId = "abdf75db-f44f-475f-8f77-9445ab0671bf";
const otherOwnerUserId = "7d304ca1-c278-4c93-b450-6f6f1cc4be42";
const workerId = "63cab652-e1bd-48a0-9fb5-b11ea43abde3";
const readRequestId = "d843720c-629e-4602-8b91-b6b69c74f36c";
const finalizationRequestId = "f5be2a4d-4eaa-4056-a37a-1e24495dd33c";
const transportAttemptId = "8ac0735c-6fbe-4aee-a058-841229089e0a";
const otherTransportAttemptId = "87dc0715-6cba-468b-b32f-2b5eb0c4b0e7";
const marketId = "093032ce-3ba7-4f07-9f94-53bd1fdd89cc";
const clientOrderId = "0x0123456789abcdef0123456789abcdef";
const otherClientOrderId = "0xfedcba9876543210fedcba9876543210";
const baseTokenId = "0x11111111111111111111111111111111";
const quoteTokenId = "0x00000000000000000000000000000000";
const otherTokenId = "0x22222222222222222222222222222222";
const accountAddress = "0x1111111111111111111111111111111111111111";
const attemptCommittedAt = "2026-08-25T09:00:00.000Z";
const otherAttemptCommittedAt = "2026-08-25T09:00:01.000Z";
const observedAt = "2026-08-25T09:00:02.000Z";

type FilledResolution = Extract<
  SpotIntentTerminalResolution,
  { readonly state: "filled" }
>;

function canonicalAction(): SpotReconciliationCanonicalAction {
  return Object.freeze({
    type: "order",
    orders: Object.freeze([
      Object.freeze({
        a: 10_000,
        b: true,
        p: "50",
        s: "0.2",
        r: false,
        t: Object.freeze({
          limit: Object.freeze({ tif: "Ioc" }),
        }),
        c: clientOrderId,
      }),
    ] as const),
    grouping: "na",
  });
}

function spotSubject(
  overrides: Partial<SpotIntentReconciliationSubject> = {},
): SpotIntentReconciliationSubject {
  return Object.freeze({
    operationId,
    ownerUserId,
    network: "testnet",
    transportAttemptId,
    attemptCommittedAt,
    intentRecordVersion: "7",
    marketId,
    providerCoin: "PURR/USDC",
    baseTokenIndex: 1,
    baseTokenId,
    baseDisplayIdentity: "PURR",
    quoteTokenIndex: 0,
    quoteTokenId,
    quoteDisplayIdentity: "USDC",
    spotPairIndex: 0,
    exchangeOrderAsset: 10_000,
    side: "buy",
    amountMode: "quote",
    amountValue: "10",
    computedBaseSize: "0.2",
    worstIocLimitPrice: "50",
    accountAddress,
    accountKind: "master",
    clientOrderId,
    canonicalAction: canonicalAction(),
    ...overrides,
  });
}

function filledResolution(
  overrides: Partial<FilledResolution> = {},
): FilledResolution {
  return Object.freeze({
    state: "filled",
    providerOrderId: "18446744073709551615",
    clientOrderId,
    filledBaseSize: "0.2",
    quoteAmount: "10",
    averageFillPrice: "50",
    fee: Object.freeze({
      amount: "0.01",
      tokenIndex: 0,
      tokenId: quoteTokenId,
      assetDisplayIdentity: "USDC",
    }),
    observedAt,
    reasonCode: null,
    ...overrides,
  });
}

function notFilledResolution(): SpotIntentTerminalResolution {
  return Object.freeze({
    state: "not_filled",
    providerOrderId: "123",
    clientOrderId,
    filledBaseSize: null,
    quoteAmount: null,
    averageFillPrice: null,
    fee: null,
    observedAt,
    reasonCode: "hyperliquid_ioc_cancel_rejected",
  });
}

function rejectedResolution(
  reasonCode: SpotRejectedReconciliationReasonCode,
): SpotIntentTerminalResolution {
  return Object.freeze({
    state: "rejected",
    providerOrderId: "123",
    clientOrderId,
    filledBaseSize: null,
    quoteAmount: null,
    averageFillPrice: null,
    fee: null,
    observedAt,
    reasonCode,
  });
}

interface AtomicInputOptions {
  readonly domain?: string;
  readonly operationKind?: string;
  readonly transportAttemptId?: string | null;
  readonly leaseAttemptCommittedAt?: string | null;
  readonly signal?: AbortSignal;
}

function atomicInput(
  options: AtomicInputOptions = {},
): AtomicDomainReconciliationInput {
  return Object.freeze({
    readRequestId,
    finalizationRequestId,
    subject: Object.freeze({
      operationId,
      ownerUserId,
      domain: options.domain ?? "hyperliquid",
      operationKind: options.operationKind ?? "spot_intent",
      transportAttemptId:
        options.transportAttemptId === undefined
          ? transportAttemptId
          : options.transportAttemptId,
    }),
    lease: Object.freeze({
      workerId,
      fenceToken: "4",
      recordVersion: "8",
      attemptCommittedAt:
        options.leaseAttemptCommittedAt === undefined
          ? attemptCommittedAt
          : options.leaseAttemptCommittedAt,
    }),
    signal: options.signal ?? new AbortController().signal,
  });
}

function fakes(
  subject: SpotIntentReconciliationSubject = spotSubject(),
  result: SpotOrderAuthoritativeReadResult = Object.freeze({
    kind: "resolved",
    resolution: filledResolution(),
  }),
) {
  const repository = {
    quarantineExpiredSubmissions: vi.fn<
      SpotReconciliationRepository["quarantineExpiredSubmissions"]
    >(() => {
      throw new Error("unexpected shared control-plane transition");
    }),
    leaseProviderOperationsForReconciliation: vi.fn<
      SpotReconciliationRepository["leaseProviderOperationsForReconciliation"]
    >(() => {
      throw new Error("unexpected shared control-plane transition");
    }),
    completeProviderOperationReconciliation: vi.fn<
      SpotReconciliationRepository["completeProviderOperationReconciliation"]
    >(() => {
      throw new Error("unexpected shared control-plane transition");
    }),
    rescheduleProviderOperationReconciliation: vi.fn<
      SpotReconciliationRepository["rescheduleProviderOperationReconciliation"]
    >(() => {
      throw new Error("unexpected shared control-plane transition");
    }),
    holdProviderOperationForOperator: vi.fn<
      SpotReconciliationRepository["holdProviderOperationForOperator"]
    >(() => {
      throw new Error("unexpected shared control-plane transition");
    }),
    loadClaimedSpotIntentSubject: vi.fn<
      SpotReconciliationRepository["loadClaimedSpotIntentSubject"]
    >(() => Promise.resolve(subject)),
    finalizeSpotIntentResolution: vi.fn<
      SpotReconciliationRepository["finalizeSpotIntentResolution"]
    >(() => Promise.resolve()),
  } satisfies SpotReconciliationRepository;
  const reader = {
    read: vi.fn<SpotOrderAuthoritativeReader["read"]>(() =>
      Promise.resolve(result),
    ),
  } satisfies SpotOrderAuthoritativeReader;
  return { repository, reader };
}

function unsafeReaderReturning(value: unknown) {
  const read = vi.fn(() => Promise.resolve(value));
  const reader: SpotOrderAuthoritativeReader = Object.freeze({
    read: read as unknown as SpotOrderAuthoritativeReader["read"],
  });
  return { reader, read };
}

describe("Spot IOC-order reconciliation handler", () => {
  it("loads and reads once, then delegates the sole atomic filled finalizer", async () => {
    const subject = spotSubject();
    const resolution = filledResolution();
    const { repository, reader } = fakes(
      subject,
      Object.freeze({ kind: "resolved", resolution }),
    );
    const handler = createSpotOrderReconciliationHandler({
      repository,
      reader,
    });
    const input = atomicInput();

    await expect(handler(input)).resolves.toEqual({
      kind: "resolved",
      state: "succeeded",
    });

    expect(repository.loadClaimedSpotIntentSubject).toHaveBeenCalledOnce();
    expect(repository.loadClaimedSpotIntentSubject).toHaveBeenCalledWith({
      ownerUserId,
      operationId,
      workerId,
      fenceToken: "4",
      recordVersion: "8",
    });
    expect(reader.read).toHaveBeenCalledOnce();
    expect(reader.read).toHaveBeenCalledWith({
      readRequestId,
      subject,
      signal: input.signal,
    });
    expect(repository.finalizeSpotIntentResolution).toHaveBeenCalledOnce();
    expect(repository.finalizeSpotIntentResolution).toHaveBeenCalledWith({
      ownerUserId,
      operationId,
      workerId,
      fenceToken: "4",
      recordVersion: "8",
      expectedIntentRecordVersion: "7",
      requestId: finalizationRequestId,
      resolution,
    });
    expect(
      repository.completeProviderOperationReconciliation,
    ).not.toHaveBeenCalled();
    expect(
      repository.rescheduleProviderOperationReconciliation,
    ).not.toHaveBeenCalled();
    expect(repository.holdProviderOperationForOperator).not.toHaveBeenCalled();
  });

  it.each([
    [
      "pending",
      Object.freeze({
        kind: "pending" as const,
        reasonCode: "hyperliquid_order_not_yet_resolved",
        retryAfterMs: 5_000,
      }),
    ],
    [
      "retry",
      Object.freeze({
        kind: "retry" as const,
        reasonCode: "hyperliquid_info_unavailable",
        retryAfterMs: 10_000,
      }),
    ],
    [
      "operator_required",
      Object.freeze({
        kind: "operator_required" as const,
        reasonCode: "hyperliquid_snapshot_conflict",
      }),
    ],
  ] satisfies readonly (readonly [
    string,
    Exclude<SpotOrderAuthoritativeReadResult, { readonly kind: "resolved" }>,
  ])[])("returns %s without entering the finalizer", async (_name, result) => {
    const { repository, reader } = fakes(spotSubject(), result);
    const handler = createSpotOrderReconciliationHandler({
      repository,
      reader,
    });

    await expect(handler(atomicInput())).resolves.toEqual(result);
    expect(reader.read).toHaveBeenCalledOnce();
    expect(repository.finalizeSpotIntentResolution).not.toHaveBeenCalled();
  });

  it("does not enter the finalizer after the provider read aborts", async () => {
    const controller = new AbortController();
    const { repository } = fakes();
    const reader = {
      read: vi.fn<SpotOrderAuthoritativeReader["read"]>(() => {
        controller.abort();
        return Promise.resolve({
          kind: "resolved",
          resolution: filledResolution(),
        });
      }),
    } satisfies SpotOrderAuthoritativeReader;
    const handler = createSpotOrderReconciliationHandler({
      repository,
      reader,
    });

    await expect(
      handler(atomicInput({ signal: controller.signal })),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(repository.finalizeSpotIntentResolution).not.toHaveBeenCalled();
  });

  it("checks abort again immediately before entering the finalizer", async () => {
    const controller = new AbortController();
    const reason = new Error("reconciliation deadline elapsed");
    const rawResult = {
      kind: "resolved",
      get resolution() {
        controller.abort(reason);
        return filledResolution();
      },
    };
    const { repository } = fakes();
    const { reader } = unsafeReaderReturning(rawResult);
    const handler = createSpotOrderReconciliationHandler({
      repository,
      reader,
    });

    await expect(
      handler(atomicInput({ signal: controller.signal })),
    ).rejects.toBe(reason);
    expect(repository.finalizeSpotIntentResolution).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong domain", { domain: "privy" }],
    ["wrong operation kind", { operationKind: "perp_intent" }],
    ["missing transport attempt", { transportAttemptId: null }],
    ["missing committed-at lease fact", { leaseAttemptCommittedAt: null }],
  ] satisfies readonly (readonly [string, AtomicInputOptions])[])(
    "parks a generic %s mismatch before loading or reading",
    async (_name, options) => {
      const { repository, reader } = fakes();
      const handler = createSpotOrderReconciliationHandler({
        repository,
        reader,
      });

      await expect(handler(atomicInput(options))).resolves.toEqual({
        kind: "operator_required",
        reasonCode: "invalid_spot_reconciliation_subject",
      });
      expect(repository.loadClaimedSpotIntentSubject).not.toHaveBeenCalled();
      expect(reader.read).not.toHaveBeenCalled();
      expect(repository.finalizeSpotIntentResolution).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["operation identity", { operationId: otherOperationId }],
    ["owner identity", { ownerUserId: otherOwnerUserId }],
    ["transport identity", { transportAttemptId: otherTransportAttemptId }],
    ["committed-at time", { attemptCommittedAt: otherAttemptCommittedAt }],
  ] satisfies readonly (readonly [
    string,
    Partial<SpotIntentReconciliationSubject>,
  ])[])(
    "parks a loaded subject with mismatched %s before reading",
    async (_name, overrides) => {
      const { repository, reader } = fakes(spotSubject(overrides));
      const handler = createSpotOrderReconciliationHandler({
        repository,
        reader,
      });

      await expect(handler(atomicInput())).resolves.toEqual({
        kind: "operator_required",
        reasonCode: "invalid_spot_reconciliation_subject",
      });
      expect(repository.loadClaimedSpotIntentSubject).toHaveBeenCalledOnce();
      expect(reader.read).not.toHaveBeenCalled();
      expect(repository.finalizeSpotIntentResolution).not.toHaveBeenCalled();
    },
  );

  it("parks a non-canonical Spot action before reading", async () => {
    const action = canonicalAction();
    const order = action.orders[0];
    const unsupportedAction: SpotReconciliationCanonicalAction = Object.freeze({
      ...action,
      orders: Object.freeze([
        Object.freeze({
          ...order,
          p: "49",
        }),
      ] as const),
    });
    const { repository, reader } = fakes(
      spotSubject({ canonicalAction: unsupportedAction }),
    );
    const handler = createSpotOrderReconciliationHandler({
      repository,
      reader,
    });

    await expect(handler(atomicInput())).resolves.toEqual({
      kind: "operator_required",
      reasonCode: "unsupported_spot_reconciliation_action",
    });
    expect(reader.read).not.toHaveBeenCalled();
    expect(repository.finalizeSpotIntentResolution).not.toHaveBeenCalled();
  });

  it.each([
    [
      "an extra resolved-envelope field",
      Object.freeze({
        kind: "resolved",
        resolution: filledResolution(),
        replay: true,
      }),
    ],
    [
      "an extra terminal-resolution field",
      Object.freeze({
        kind: "resolved",
        resolution: Object.freeze({
          ...filledResolution(),
          rawProviderPayload: "do-not-accept",
        }),
      }),
    ],
    [
      "a negative fee",
      Object.freeze({
        kind: "resolved",
        resolution: Object.freeze({
          ...filledResolution(),
          fee: Object.freeze({
            ...filledResolution().fee,
            amount: "-0.01",
          }),
        }),
      }),
    ],
    [
      "an invalid pending reason",
      Object.freeze({
        kind: "pending",
        reasonCode: "NOT_SANITIZED",
      }),
    ],
  ])(
    "parks malformed reader output containing %s",
    async (_name, rawResult) => {
      const { repository } = fakes();
      const { reader, read } = unsafeReaderReturning(rawResult);
      const handler = createSpotOrderReconciliationHandler({
        repository,
        reader,
      });

      await expect(handler(atomicInput())).resolves.toEqual({
        kind: "operator_required",
        reasonCode: "invalid_spot_reconciliation_result",
      });
      expect(read).toHaveBeenCalledOnce();
      expect(repository.finalizeSpotIntentResolution).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "client order identity",
      filledResolution({ clientOrderId: otherClientOrderId }),
    ],
    [
      "full base size",
      filledResolution({
        filledBaseSize: "0.1",
        quoteAmount: "5",
      }),
    ],
    [
      "IOC price bound",
      filledResolution({
        quoteAmount: "10.2",
        averageFillPrice: "51",
      }),
    ],
    [
      "fee token identity",
      filledResolution({
        fee: Object.freeze({
          amount: "0.01",
          tokenIndex: 2,
          tokenId: otherTokenId,
          assetDisplayIdentity: "OTHER",
        }),
      }),
    ],
    [
      "fee economic upper bound",
      filledResolution({
        fee: Object.freeze({
          amount: "10.01",
          tokenIndex: 0,
          tokenId: quoteTokenId,
          assetDisplayIdentity: "USDC",
        }),
      }),
    ],
  ] satisfies readonly (readonly [string, FilledResolution])[])(
    "parks an authority mismatch in %s",
    async (_name, resolution) => {
      const { repository, reader } = fakes(
        spotSubject(),
        Object.freeze({ kind: "resolved", resolution }),
      );
      const handler = createSpotOrderReconciliationHandler({
        repository,
        reader,
      });

      await expect(handler(atomicInput())).resolves.toEqual({
        kind: "operator_required",
        reasonCode: "invalid_spot_reconciliation_result",
      });
      expect(reader.read).toHaveBeenCalledOnce();
      expect(repository.finalizeSpotIntentResolution).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "not_filled",
      notFilledResolution(),
      "succeeded",
      "hyperliquid_ioc_cancel_rejected",
    ],
    ...(
      [
        "hyperliquid_insufficient_spot_balance_rejected",
        "hyperliquid_min_trade_ntl_rejected",
        "hyperliquid_oracle_rejected",
        "hyperliquid_tick_rejected",
        "hyperliquid_rejected",
      ] as const satisfies readonly SpotRejectedReconciliationReasonCode[]
    ).map(
      (reasonCode) =>
        [
          "rejected",
          rejectedResolution(reasonCode),
          "rejected",
          reasonCode,
        ] as const,
    ),
  ] as const)(
    "maps a valid %s terminal resolution through the atomic finalizer",
    async (_name, resolution, state, reasonCode) => {
      const { repository, reader } = fakes(
        spotSubject(),
        Object.freeze({ kind: "resolved", resolution }),
      );
      const handler = createSpotOrderReconciliationHandler({
        repository,
        reader,
      });

      await expect(handler(atomicInput())).resolves.toEqual({
        kind: "resolved",
        state,
        reasonCode,
      });
      expect(repository.finalizeSpotIntentResolution).toHaveBeenCalledOnce();
      expect(repository.finalizeSpotIntentResolution).toHaveBeenCalledWith(
        expect.objectContaining({ resolution }),
      );
      expect(
        repository.completeProviderOperationReconciliation,
      ).not.toHaveBeenCalled();
    },
  );
});
