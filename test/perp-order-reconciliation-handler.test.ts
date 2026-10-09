import { describe, expect, it, vi } from "vitest";

import {
  createPerpOrderReconciliationHandler,
  type PerpOrderAuthoritativeReader,
} from "../src/features/perp/perp-order-reconciliation-handler.js";
import type {
  PerpOrderReconciliationResolution,
  PerpReconciliationRepository,
  PerpReconciliationSubject,
} from "../src/features/perp/perp-reconciliation-contract.js";

const operationId = "29c33b23-6134-489c-ab0d-a5c82a9b54e2";
const ownerUserId = "abdf75db-f44f-475f-8f77-9445ab0671bf";
const workerId = "63cab652-e1bd-48a0-9fb5-b11ea43abde3";
const readRequestId = "d843720c-629e-4602-8b91-b6b69c74f36c";
const finalizationRequestId = "f5be2a4d-4eaa-4056-a37a-1e24495dd33c";
const transportAttemptId = "8ac0735c-6fbe-4aee-a058-841229089e0a";
const clientOrderId = "0x0123456789abcdef0123456789abcdef";
const accountAddress = "0x1111111111111111111111111111111111111111";
const attemptCommittedAt = "2026-08-25T09:00:00.000Z";

function limitOrderSubject(): PerpReconciliationSubject {
  return Object.freeze({
    operationId,
    ownerUserId,
    action: "order",
    accountAddress,
    accountKind: "master",
    attemptCommittedAt,
    intentRecordVersion: "7",
    canonicalAction: Object.freeze({
      action: "order",
      coin: "ETH",
      side: "buy",
      order_type: "limit",
      size: "1.25",
      limit_price: "3210.5",
      time_in_force: "gtc",
      reduce_only: false,
    }),
    items: Object.freeze([
      Object.freeze({
        index: 0,
        coin: "ETH",
        targetKind: null,
        targetOrderId: null,
        targetClientOrderId: null,
        generatedClientOrderId: clientOrderId,
      }),
    ]),
  });
}

function resolution(): PerpOrderReconciliationResolution {
  return Object.freeze({
    genericState: "succeeded",
    intentState: "filled",
    observedAt: "2026-08-25T09:00:02.000Z",
    reasonCode: null,
    items: Object.freeze([
      Object.freeze({
        index: 0,
        coin: "ETH",
        generatedClientOrderId: clientOrderId,
        state: "filled",
        providerOrderId: "18446744073709551615",
        clientOrderId,
        filledSize: "1.25",
        averageFillPrice: null,
        reasonCode: null,
      }),
    ]),
  });
}

function atomicInput(signal = new AbortController().signal) {
  return {
    readRequestId,
    finalizationRequestId,
    subject: Object.freeze({
      operationId,
      ownerUserId,
      domain: "hyperliquid",
      operationKind: "perp_intent",
      transportAttemptId,
    }),
    lease: Object.freeze({
      workerId,
      fenceToken: "4",
      recordVersion: "8",
      attemptCommittedAt,
    }),
    signal,
  } as const;
}

function fakes(subject = limitOrderSubject()) {
  const repository = {
    loadClaimedSubject: vi.fn(() => Promise.resolve(subject)),
    finalizeOrderResolution: vi.fn(() => Promise.resolve()),
  } satisfies PerpReconciliationRepository;
  const reader = {
    read: vi.fn<PerpOrderAuthoritativeReader["read"]>(() =>
      Promise.resolve({ kind: "resolved" as const, resolution: resolution() }),
    ),
  } satisfies PerpOrderAuthoritativeReader;
  return { repository, reader };
}

const unsupportedActionCases = [
  [
    "cancel",
    {
      action: "cancel",
      coin: "ETH",
      target: { kind: "client_order_id", client_order_id: clientOrderId },
    },
  ],
  [
    "modify",
    {
      action: "modify",
      coin: "ETH",
      target: { kind: "client_order_id", client_order_id: clientOrderId },
      side: "buy",
      size: "1.25",
      limit_price: "3210.5",
      time_in_force: "gtc",
      reduce_only: false,
    },
  ],
  [
    "batch_modify",
    {
      action: "batch_modify",
      modifications: [
        {
          coin: "ETH",
          target: { kind: "client_order_id", client_order_id: clientOrderId },
          side: "buy",
          size: "1.25",
          limit_price: "3210.5",
          time_in_force: "gtc",
          reduce_only: false,
        },
      ],
    },
  ],
  [
    "update_leverage",
    {
      action: "update_leverage",
      coin: "ETH",
      margin_mode: "cross",
      leverage: "2",
    },
  ],
  [
    "update_isolated_margin",
    {
      action: "update_isolated_margin",
      coin: "ETH",
      margin_delta_usdc: "1",
    },
  ],
] as const satisfies readonly (readonly [
  Exclude<PerpReconciliationSubject["action"], "order">,
  PerpReconciliationSubject["canonicalAction"],
])[];

describe("Perp limit-order reconciliation handler", () => {
  it("loads the claimed subject, reads once, and delegates the sole atomic completion", async () => {
    const { repository, reader } = fakes();
    const handler = createPerpOrderReconciliationHandler({
      repository,
      reader,
    });

    await expect(handler(atomicInput())).resolves.toEqual({
      kind: "resolved",
      state: "succeeded",
    });

    expect(repository.loadClaimedSubject).toHaveBeenCalledWith({
      ownerUserId,
      operationId,
      workerId,
      fenceToken: "4",
      recordVersion: "8",
    });
    expect(reader.read).toHaveBeenCalledOnce();
    expect(reader.read.mock.calls[0]?.[0].readRequestId).toBe(readRequestId);
    expect(reader.read.mock.calls[0]?.[0].subject).toMatchObject({
      operationId,
      ownerUserId,
    });
    expect(repository.finalizeOrderResolution).toHaveBeenCalledWith({
      ownerUserId,
      operationId,
      workerId,
      fenceToken: "4",
      recordVersion: "8",
      expectedIntentRecordVersion: "7",
      requestId: finalizationRequestId,
      resolution: resolution(),
    });
  });

  it("parks a market order before any provider read or completion", async () => {
    const marketSubject: PerpReconciliationSubject = Object.freeze({
      ...limitOrderSubject(),
      canonicalAction: Object.freeze({
        action: "order",
        coin: "ETH",
        side: "buy",
        order_type: "market",
        size: "1.25",
        max_slippage_percent: "0.5",
        reduce_only: false,
      }),
    });
    const { repository, reader } = fakes(marketSubject);
    const handler = createPerpOrderReconciliationHandler({
      repository,
      reader,
    });

    await expect(handler(atomicInput())).resolves.toEqual({
      kind: "operator_required",
      reasonCode: "unsupported_perp_reconciliation_action",
    });
    expect(reader.read).not.toHaveBeenCalled();
    expect(repository.finalizeOrderResolution).not.toHaveBeenCalled();
  });

  it.each(unsupportedActionCases)(
    "parks %s before any provider read or completion",
    async (action, canonicalAction) => {
      const unsupportedSubject: PerpReconciliationSubject = Object.freeze({
        ...limitOrderSubject(),
        action,
        canonicalAction,
      });
      const { repository, reader } = fakes(unsupportedSubject);
      const handler = createPerpOrderReconciliationHandler({
        repository,
        reader,
      });

      await expect(handler(atomicInput())).resolves.toEqual({
        kind: "operator_required",
        reasonCode: "unsupported_perp_reconciliation_action",
      });
      expect(reader.read).not.toHaveBeenCalled();
      expect(repository.finalizeOrderResolution).not.toHaveBeenCalled();
    },
  );

  it("returns pending evidence without entering the finalizer", async () => {
    const { repository } = fakes();
    const reader = {
      read: vi.fn(() =>
        Promise.resolve({
          kind: "pending" as const,
          reasonCode: "hyperliquid_order_not_yet_resolved",
          retryAfterMs: 5_000,
        }),
      ),
    } satisfies PerpOrderAuthoritativeReader;
    const handler = createPerpOrderReconciliationHandler({
      repository,
      reader,
    });

    await expect(handler(atomicInput())).resolves.toEqual({
      kind: "pending",
      reasonCode: "hyperliquid_order_not_yet_resolved",
      retryAfterMs: 5_000,
    });
    expect(repository.finalizeOrderResolution).not.toHaveBeenCalled();
  });

  it("does not enter the finalizer when the provider deadline aborts", async () => {
    const controller = new AbortController();
    const { repository } = fakes();
    const reader = {
      read: vi.fn(() => {
        controller.abort();
        return Promise.resolve({
          kind: "resolved" as const,
          resolution: resolution(),
        });
      }),
    } satisfies PerpOrderAuthoritativeReader;
    const handler = createPerpOrderReconciliationHandler({
      repository,
      reader,
    });

    await expect(handler(atomicInput(controller.signal))).rejects.toMatchObject(
      {
        name: "AbortError",
      },
    );
    expect(repository.finalizeOrderResolution).not.toHaveBeenCalled();
  });
});
