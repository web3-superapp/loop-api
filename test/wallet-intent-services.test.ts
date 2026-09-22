import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { V2ApiError } from "../src/core/http/v2-error.js";
import { digestCanonicalPayload } from "../src/features/wallet-intents/intent-contract.js";
import { createApprovalService } from "../src/features/wallet-intents/approval-service.js";
import { createWalletIntentReconciler } from "../src/features/wallet-intents/intent-reconciliation.js";
import { createSendService } from "../src/features/wallet-intents/send-service.js";
import { createSwapService } from "../src/features/wallet-intents/swap-service.js";
import { createWalletIntentService } from "../src/features/wallet-intents/wallet-intent-service.js";
import {
  checksumAddress,
  fromHexQuantity,
} from "../src/integrations/bsc/tx-builder.js";
import type {
  BscTransactionObservation,
  BscTransactionReceiptObservation,
} from "../src/integrations/bsc/rpc-client.js";
import { PrivySwapProviderError } from "../src/integrations/privy/swap-adapter.js";
import {
  externalWalletId,
  nativeAssetId,
  principal,
  recipientAddress,
  runtimeFake,
  spenderAddress,
  swapAdapterFake,
  usdt,
  usdtAssetId,
  walletAddress,
  walletId,
  wbnbAssetId,
  type RuntimeFakeOptions,
} from "./wallet-intent-fakes.js";

const signal = new AbortController().signal;
const txHash = `0x${"7".repeat(64)}`;

function sendBody(overrides: Record<string, unknown> = {}) {
  return {
    walletId,
    assetId: usdtAssetId,
    amount: "1.5",
    recipientAddress,
    ...overrides,
  };
}

async function expectCode(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
  await promise.catch((error: unknown) => {
    expect(error).toBeInstanceOf(V2ApiError);
  });
}

function observedTransaction(
  transaction: NonNullable<
    Awaited<
      ReturnType<ReturnType<typeof createSendService>["prepare"]>
    >["resource"]["unsignedTransaction"]
  >,
  overrides: Partial<BscTransactionObservation> = {},
): BscTransactionObservation {
  return {
    hash: txHash,
    from: transaction.from,
    to: transaction.to,
    input: transaction.data,
    value: fromHexQuantity(transaction.value),
    nonce: Number(fromHexQuantity(transaction.nonce)),
    chainId: 56,
    blockNumber: null,
    ...overrides,
  };
}

/**
 * Stands in for the Provider-side simulation that does not exist yet: moves a
 * prepared swap intent to awaiting_signature so the execute path can be
 * exercised. Production has no such transition.
 */
function unlockForSigning(
  repository: ReturnType<typeof runtimeFake>["repository"],
  intentId: string,
): void {
  const record = repository.records.get(intentId);
  if (record === undefined) {
    throw new Error("missing intent");
  }
  repository.records.set(intentId, { ...record, state: "awaiting_signature" });
}

function build(options: RuntimeFakeOptions = {}) {
  const fixture = runtimeFake(options);
  return {
    ...fixture,
    send: createSendService(fixture.runtime),
    approvals: createApprovalService(fixture.runtime),
    intents: createWalletIntentService(fixture.runtime),
  };
}

describe("send intent preparation", () => {
  it("fails closed with CAPABILITY_UNAVAILABLE when writes are disabled", async () => {
    const { send } = build({ writesEnabled: false });
    await expectCode(
      send.prepare({
        principal,
        idempotencyKey: randomUUID(),
        body: sendBody(),
        signal,
      }),
      "CAPABILITY_UNAVAILABLE",
    );
  });

  it("fails closed when the chain is not verified", async () => {
    const { send } = build({ readClient: { verified: false } });
    await expectCode(
      send.prepare({
        principal,
        idempotencyKey: randomUUID(),
        body: sendBody(),
        signal,
      }),
      "CAPABILITY_UNAVAILABLE",
    );
  });

  it("builds an ERC-20 transfer intent whose digest matches the canonical payload", async () => {
    const { send, repository, readClient } = build();
    const result = await send.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: sendBody(),
      signal,
    });
    expect(result.created).toBe(true);
    const resource = result.resource;
    expect(resource.state).toBe("awaiting_signature");
    expect(resource.signing).toEqual({
      mode: "device_eth_send_transaction",
      allowed: true,
      reasonCode: null,
    });
    expect(resource.simulation).toMatchObject({
      status: "passed",
      source: "rpc_call",
    });
    expect(resource.policy).toMatchObject({
      configVersion: "bscWriteCanaryV1",
      canaryMaxUsd: "20",
      valueUsd: "1.5",
      priceSource: "dexscreener",
    });
    const transaction = resource.unsignedTransaction;
    expect(transaction).toMatchObject({
      chainId: 56,
      from: walletAddress,
      to: usdt,
      value: "0x0",
      nonce: "0x7",
      type: "eip1559",
      maxFeePerGas: "0xb2d05e00",
      maxPriorityFeePerGas: "0x3b9aca00",
      gasPrice: null,
    });
    // 52_000 estimate × 1.2 headroom.
    expect(fromHexQuantity(transaction?.gas ?? "0x0")).toBe(62_400n);
    expect(transaction?.data.startsWith("0xa9059cbb")).toBe(true);
    expect(resource.review.decodedCall).toEqual({
      functionName: "transfer",
      selector: "0xa9059cbb",
      args: { to: recipientAddress, value: "1500000000000000000" },
    });
    expect(resource.review.recipient).toMatchObject({
      address: recipientAddress,
      isContract: false,
      isFirstRecipient: true,
      screening: { status: "unavailable" },
    });
    expect(resource.review.fee).toMatchObject({
      gasLimit: "62400",
      maximumFeeRaw: (62_400n * 3_000_000_000n).toString(10),
    });
    const record = repository.records.get(resource.intentId);
    expect(record).toBeDefined();
    expect(resource.reviewSha256).toBe(
      digestCanonicalPayload(record?.canonicalPayload),
    );
    expect(record?.canonicalPayload.transaction).toEqual(transaction);
    expect(readClient.calls).toHaveLength(1);
    expect(readClient.calls[0]).toMatchObject({
      from: walletAddress,
      to: usdt,
    });
    expect(
      Date.parse(resource.expiresAt) - Date.parse(resource.factsObservedAt),
    ).toBe(120_000);
  });

  it("builds an exact 21000-gas native transfer and honours the gas reserve", async () => {
    const { send } = build({ readClient: { gasEstimate: 21_000n } });
    const ok = await send.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: sendBody({ assetId: nativeAssetId, amount: "0.01" }),
      signal,
    });
    expect(ok.resource.unsignedTransaction).toMatchObject({
      to: recipientAddress,
      data: "0x",
      gas: "0x5208",
      value: "0x2386f26fc10000",
    });
    expect(ok.resource.policy.valueUsd).toBe("6");

    // 0.04 BNB × 600 USD is above the 20 USD canary ceiling.
    await expectCode(
      send.prepare({
        principal,
        idempotencyKey: randomUUID(),
        body: sendBody({ assetId: nativeAssetId, amount: "0.04" }),
        signal,
      }),
      "POLICY_BLOCKED",
    );

    // 2 BNB balance − 0.005 reserve: sending 1.999 leaves less than the reserve.
    const { send: generous } = build({
      canaryMaxUsd: "5000",
      readClient: { gasEstimate: 21_000n },
    });
    await expectCode(
      generous.prepare({
        principal,
        idempotencyKey: randomUUID(),
        body: sendBody({ assetId: nativeAssetId, amount: "1.999" }),
        signal,
      }),
      "INSUFFICIENT_BALANCE",
    );
  });

  it("refuses an amount above the token balance with INSUFFICIENT_BALANCE", async () => {
    const { send } = build({
      readClient: { tokenBalance: 1_000_000_000_000_000_000n },
    });
    await expectCode(
      send.prepare({
        principal,
        idempotencyKey: randomUUID(),
        body: sendBody(),
        signal,
      }),
      "INSUFFICIENT_BALANCE",
    );
  });

  it("refuses the canary asset allowlist and the USD ceiling with POLICY_BLOCKED and a distinguishing reasonCode", async () => {
    const { send } = build({ canaryAssetIds: [wbnbAssetId] });
    await expect(
      send.prepare({
        principal,
        idempotencyKey: randomUUID(),
        body: sendBody(),
        signal,
      }),
    ).rejects.toMatchObject({
      code: "POLICY_BLOCKED",
      detailsSafe: { reasonCode: "ASSET_NOT_IN_CANARY_ALLOWLIST" },
    });
    const { send: capped } = build({ canaryMaxUsd: "1" });
    await expect(
      capped.prepare({
        principal,
        idempotencyKey: randomUUID(),
        body: sendBody(),
        signal,
      }),
    ).rejects.toMatchObject({
      code: "POLICY_BLOCKED",
      detailsSafe: {
        reasonCode: "CANARY_CEILING_EXCEEDED",
        exposureUsd: expect.stringMatching(/^[0-9]+(\.[0-9]+)?$/) as string,
        ceilingUsd: "1",
      },
    });
  });

  it("admits only an allowlisted counterparty when the allowlist is not empty", async () => {
    const { send } = build({
      canaryCounterpartyAddresses: [recipientAddress],
    });
    const allowed = await send.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: sendBody(),
      signal,
    });
    expect(allowed.resource.state).toBe("awaiting_signature");

    const { send: restricted } = build({
      canaryCounterpartyAddresses: [spenderAddress],
    });
    await expect(
      restricted.prepare({
        principal,
        idempotencyKey: randomUUID(),
        body: sendBody(),
        signal,
      }),
    ).rejects.toMatchObject({
      code: "POLICY_BLOCKED",
      detailsSafe: { reasonCode: "COUNTERPARTY_NOT_IN_CANARY_ALLOWLIST" },
    });
  });

  it("counts the rolling day against the daily ceiling and blocks the intent that would cross it", async () => {
    // Each send is 1.5 USDT × 1 USD; the third crosses a 4 USD day. A
    // superseded (expired) intent never spent, so only the settled ones are
    // counted: the two below are moved to `confirmed` before the next
    // preparation, exactly as a broadcast that landed would.
    const { send, repository } = build({ canaryDailyMaxUsd: "4" });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await send.prepare({
        principal,
        idempotencyKey: randomUUID(),
        body: sendBody(),
        signal,
      });
      expect(result.resource.state).toBe("awaiting_signature");
      const record = repository.records.get(result.resource.intentId);
      expect(record).toBeDefined();
      if (record !== undefined) {
        repository.records.set(record.intentId, {
          ...record,
          state: "confirmed",
        });
      }
    }
    await expect(
      send.prepare({
        principal,
        idempotencyKey: randomUUID(),
        body: sendBody(),
        signal,
      }),
    ).rejects.toMatchObject({
      code: "POLICY_BLOCKED",
      detailsSafe: {
        reasonCode: "CANARY_DAILY_CEILING_EXCEEDED",
        exposureUsd: "4.5",
        ceilingUsd: "4",
      },
    });
  });

  it("does not consume the daily ceiling without one configured", async () => {
    const { send } = build();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await send.prepare({
        principal,
        idempotencyKey: randomUUID(),
        body: sendBody(),
        signal,
      });
      expect(result.resource.state).toBe("awaiting_signature");
    }
  });

  it("does not admit an amount it cannot price", async () => {
    const { send } = build({ marketFacts: null });
    await expectCode(
      send.prepare({
        principal,
        idempotencyKey: randomUUID(),
        body: sendBody(),
        signal,
      }),
      "CAPABILITY_UNAVAILABLE",
    );
  });

  it("refuses an external wallet, an unknown wallet, a self-send, and another chain", async () => {
    const { send } = build();
    await expectCode(
      send.prepare({
        principal,
        idempotencyKey: randomUUID(),
        body: sendBody({ walletId: externalWalletId }),
        signal,
      }),
      "VALIDATION_FAILED",
    );
    await expectCode(
      send.prepare({
        principal,
        idempotencyKey: randomUUID(),
        body: sendBody({ walletId: randomUUID() }),
        signal,
      }),
      "NOT_FOUND",
    );
    await expectCode(
      send.prepare({
        principal,
        idempotencyKey: randomUUID(),
        body: sendBody({ recipientAddress: walletAddress }),
        signal,
      }),
      "VALIDATION_FAILED",
    );
    await expectCode(
      send.prepare({
        principal,
        idempotencyKey: randomUUID(),
        body: sendBody({ chainId: "eip155:1" }),
        signal,
      }),
      "CHAIN_MISMATCH",
    );
  });

  it("creates a reverted intent that can never be signed or reported", async () => {
    const { send, intents } = build({
      readClient: {
        callOutcome: { status: "reverted", reasonCode: "BSC_CALL_REVERTED" },
      },
    });
    const { resource } = await send.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: sendBody(),
      signal,
    });
    expect(resource.state).toBe("prepared");
    expect(resource.simulation).toMatchObject({
      status: "reverted",
      reasonCode: "BSC_CALL_REVERTED",
    });
    expect(resource.signing).toEqual({
      mode: "device_eth_send_transaction",
      allowed: false,
      reasonCode: "BSC_CALL_REVERTED",
    });
    await expectCode(
      intents.reportBroadcast({
        principal,
        intentId: resource.intentId,
        body: { txHash },
      }),
      "SIMULATION_FAILED",
    );
  });

  it("marks the simulation unavailable when the endpoint fails but keeps the intent", async () => {
    const { send } = build({
      readClient: { callThrows: new Error("socket hang up") },
    });
    const { resource } = await send.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: sendBody(),
      signal,
    });
    expect(resource.state).toBe("prepared");
    expect(resource.simulation).toMatchObject({
      status: "unavailable",
      reasonCode: "SIMULATION_UNAVAILABLE",
    });
    expect(resource.signing.allowed).toBe(false);
  });

  it("replays the same Idempotency-Key and conflicts on a different body", async () => {
    const { send, repository } = build();
    const key = randomUUID();
    const first = await send.prepare({
      principal,
      idempotencyKey: key,
      body: sendBody(),
      signal,
    });
    const replay = await send.prepare({
      principal,
      idempotencyKey: key,
      body: sendBody(),
      signal,
    });
    expect(replay.created).toBe(false);
    expect(replay.resource.intentId).toBe(first.resource.intentId);
    expect(repository.records.size).toBe(1);
    await expectCode(
      send.prepare({
        principal,
        idempotencyKey: key,
        body: sendBody({ amount: "2" }),
        signal,
      }),
      "IDEMPOTENCY_CONFLICT",
    );
  });

  it("expires the previous open intent of the wallet when a new one is prepared", async () => {
    const { send, intents } = build();
    const first = await send.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: sendBody(),
      signal,
    });
    const second = await send.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: sendBody({ amount: "2" }),
      signal,
    });
    const superseded = await intents.get({
      principal,
      intentId: first.resource.intentId,
    });
    expect(superseded.state).toBe("expired");
    expect(superseded.result.reasonCode).toBe("INTENT_SUPERSEDED");
    expect(second.resource.state).toBe("awaiting_signature");
  });

  it("reports recipient facts in preflight without needing writes", async () => {
    const { send } = build({
      writesEnabled: false,
      readClient: { code: { [recipientAddress]: "0x6080" } },
    });
    const preflight = await send.preflight({
      principal,
      body: {
        walletId,
        address: recipientAddress.toUpperCase().replace("0X", "0x"),
      },
    });
    expect(preflight.recipient).toMatchObject({
      address: recipientAddress,
      isContract: true,
      isFirstRecipient: true,
    });
    expect(preflight.warnings).toEqual([
      "send.recipient.firstTime",
      "send.recipient.isContract",
      "send.recipient.screeningUnavailable",
    ]);
  });
});

describe("broadcast report, cancel, expiry", () => {
  it("moves a matching hash to submitted and journals the single attempt", async () => {
    const transactions = new Map<string, BscTransactionObservation | null>();
    const { send, intents, repository, controlPlane } = build({
      readClient: { transactions },
    });
    const { resource } = await send.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: sendBody(),
      signal,
    });
    const transaction = resource.unsignedTransaction;
    if (transaction === null) {
      throw new Error("expected an unsigned transaction");
    }
    transactions.set(txHash, observedTransaction(transaction));
    const reported = await intents.reportBroadcast({
      principal,
      intentId: resource.intentId,
      body: { txHash: txHash.toUpperCase().replace("0X", "0x") },
    });
    expect(reported.state).toBe("submitted");
    expect(reported.result.transactionHash).toBe(txHash);
    expect(reported.result.reasonCode).toBeNull();
    const operation = [...controlPlane.operations.values()][0];
    expect(operation).toMatchObject({ state: "accepted", attemptCount: 1 });
    expect(repository.events.map((event) => event.eventType)).toEqual([
      "intent_prepared",
      "broadcast_reported",
    ]);
    // Same hash again is idempotent.
    const again = await intents.reportBroadcast({
      principal,
      intentId: resource.intentId,
      body: { txHash },
    });
    expect(again.state).toBe("submitted");
  });

  it("rejects a hash whose payload differs and records the audit event", async () => {
    const transactions = new Map<string, BscTransactionObservation | null>();
    const { send, intents, repository } = build({
      readClient: { transactions },
    });
    const { resource } = await send.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: sendBody(),
      signal,
    });
    const transaction = resource.unsignedTransaction;
    if (transaction === null) {
      throw new Error("expected an unsigned transaction");
    }
    transactions.set(txHash, observedTransaction(transaction, { value: 1n }));
    await expectCode(
      intents.reportBroadcast({
        principal,
        intentId: resource.intentId,
        body: { txHash },
      }),
      "VALIDATION_FAILED",
    );
    expect(repository.events.at(-1)).toMatchObject({
      eventType: "broadcast_report_rejected",
      reasonCode: "TX_PAYLOAD_MISMATCH",
    });
    expect(repository.records.get(resource.intentId)?.state).toBe(
      "awaiting_signature",
    );
  });

  it("accepts an unseen hash as pending verification for the lane", async () => {
    const { send, intents } = build();
    const { resource } = await send.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: sendBody(),
      signal,
    });
    const reported = await intents.reportBroadcast({
      principal,
      intentId: resource.intentId,
      body: { txHash },
    });
    expect(reported.state).toBe("submitted");
    expect(reported.result.reasonCode).toBe("TX_PENDING_VERIFICATION");
  });

  it("cancels an open intent, refuses to cancel a submitted one, and projects expiry", async () => {
    let clock = Date.parse("2026-09-08T00:00:00.000Z");
    const { send, intents } = build({ now: () => new Date(clock) });
    const first = await send.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: sendBody(),
      signal,
    });
    const cancelled = await intents.cancel({
      principal,
      intentId: first.resource.intentId,
    });
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.signing.allowed).toBe(false);

    const second = await send.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: sendBody(),
      signal,
    });
    await intents.reportBroadcast({
      principal,
      intentId: second.resource.intentId,
      body: { txHash },
    });
    await expectCode(
      intents.cancel({ principal, intentId: second.resource.intentId }),
      "DATA_STALE",
    );

    const third = await send.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: sendBody(),
      signal,
    });
    clock += 121_000;
    const projected = await intents.get({
      principal,
      intentId: third.resource.intentId,
    });
    expect(projected.state).toBe("expired");
    expect(projected.signing).toMatchObject({
      allowed: false,
      reasonCode: "INTENT_EXPIRED",
    });
    await expectCode(
      intents.reportBroadcast({
        principal,
        intentId: third.resource.intentId,
        body: { txHash },
      }),
      "DATA_STALE",
    );
  });

  it("accepts a late report for an expired or cancelled intent only when the chain already shows the payload", async () => {
    const transactions = new Map<string, BscTransactionObservation | null>();
    let clock = Date.parse("2026-09-08T00:00:00.000Z");
    const { send, intents, repository } = build({
      readClient: { transactions },
      now: () => new Date(clock),
    });
    const first = await send.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: sendBody(),
      signal,
    });
    const transaction = first.resource.unsignedTransaction;
    if (transaction === null) {
      throw new Error("expected an unsigned transaction");
    }
    // Superseded by a newer prepare on the same wallet.
    await send.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: sendBody({ amount: "2" }),
      signal,
    });
    expect(repository.records.get(first.resource.intentId)?.state).toBe(
      "expired",
    );
    // Unobserved: still stale.
    await expectCode(
      intents.reportBroadcast({
        principal,
        intentId: first.resource.intentId,
        body: { txHash },
      }),
      "DATA_STALE",
    );
    // Observed and matching: the chain wins.
    transactions.set(txHash, observedTransaction(transaction));
    const late = await intents.reportBroadcast({
      principal,
      intentId: first.resource.intentId,
      body: { txHash },
    });
    expect(late.state).toBe("submitted");
    expect(repository.events.at(-1)).toMatchObject({
      eventType: "late_broadcast_report",
      toState: "submitted",
    });
    expect(
      repository.records.get(first.resource.intentId)?.payloadVerified,
    ).toBe(true);

    // Cancelled, then broadcast anyway with a matching payload.
    const third = await send.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: sendBody({ amount: "3" }),
      signal,
    });
    await intents.cancel({ principal, intentId: third.resource.intentId });
    const otherHash = `0x${"6".repeat(64)}`;
    const thirdTransaction = third.resource.unsignedTransaction;
    if (thirdTransaction === null) {
      throw new Error("expected an unsigned transaction");
    }
    transactions.set(
      otherHash,
      observedTransaction(thirdTransaction, { hash: otherHash }),
    );
    const cancelledLate = await intents.reportBroadcast({
      principal,
      intentId: third.resource.intentId,
      body: { txHash: otherHash },
    });
    expect(cancelledLate.state).toBe("submitted");

    // Expired by the clock with an unobserved hash: expiry is persisted.
    const fourth = await send.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: sendBody({ amount: "4" }),
      signal,
    });
    clock += 121_000;
    await expectCode(
      intents.reportBroadcast({
        principal,
        intentId: fourth.resource.intentId,
        body: { txHash: `0x${"5".repeat(64)}` },
      }),
      "DATA_STALE",
    );
    expect(repository.records.get(fourth.resource.intentId)?.state).toBe(
      "expired",
    );
  });

  it("records a refused late report without calling the chain when writes are off", async () => {
    const { send, intents, repository, runtime } = build();
    const { resource } = await send.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: sendBody(),
      signal,
    });
    (runtime.config as { bscWrites: unknown }).bscWrites = null;
    await expectCode(
      intents.reportBroadcast({
        principal,
        intentId: resource.intentId,
        body: { txHash },
      }),
      "CAPABILITY_UNAVAILABLE",
    );
    expect(repository.events.at(-1)).toMatchObject({
      eventType: "broadcast_report_refused",
      reasonCode: "BSC_WRITES_DISABLED",
    });
  });

  it("refuses a broadcast report when the policy version changed underneath", async () => {
    const { send, intents, repository } = build();
    const { resource } = await send.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: sendBody(),
      signal,
    });
    const record = repository.records.get(resource.intentId);
    if (record === undefined) {
      throw new Error("missing record");
    }
    repository.records.set(resource.intentId, {
      ...record,
      policyConfigVersion: "bscWriteCanaryV0",
    });
    await expectCode(
      intents.reportBroadcast({
        principal,
        intentId: resource.intentId,
        body: { txHash },
      }),
      "DATA_STALE",
    );
  });
});

describe("approve and revoke intents", () => {
  it("prepares an exact approve with the decoded call and prices unlimited by actual exposure", async () => {
    const { approvals } = build({
      readClient: { code: { [spenderAddress]: "0x60" } },
    });
    const { resource } = await approvals.prepareApprove({
      principal,
      idempotencyKey: randomUUID(),
      body: {
        walletId,
        assetId: usdtAssetId,
        spenderAddress,
        allowance: { mode: "exact", amount: "3" },
      },
      signal,
    });
    expect(resource.kind).toBe("approve");
    expect(resource.state).toBe("awaiting_signature");
    expect(resource.review.spender).toEqual({
      address: spenderAddress,
      checksumAddress: checksumAddress(spenderAddress),
      isContract: true,
      isUnlimited: false,
    });
    expect(resource.review.decodedCall).toEqual({
      functionName: "approve",
      selector: "0x095ea7b3",
      args: { spender: spenderAddress, value: "3000000000000000000" },
    });
    expect(resource.policy).toMatchObject({
      valueUsd: "3",
      exposureBasis: "balance_at_prepare",
      exposureRaw: "3000000000000000000",
      exposureBlockNumber: "44000000",
    });

    // Unlimited: exposure is the 5 USDT balance (5 USD), under the ceiling.
    const unlimited = await approvals.prepareApprove({
      principal,
      idempotencyKey: randomUUID(),
      body: {
        walletId,
        assetId: usdtAssetId,
        spenderAddress,
        allowance: { mode: "unlimited" },
        acknowledgeUnlimited: true,
      },
      signal,
    });
    expect(unlimited.resource.review.spender?.isUnlimited).toBe(true);
    expect(unlimited.resource.review.amount.display).toBe("unlimited");
    expect(unlimited.resource.policy).toMatchObject({
      valueUsd: "5",
      exposureBasis: "balance_at_prepare",
      exposureRaw: "5000000000000000000",
    });
    // A balance above the ceiling makes the same unlimited approval POLICY_BLOCKED.
    const { approvals: rich } = build({
      readClient: { tokenBalance: 30_000_000_000_000_000_000n },
    });
    await expect(
      rich.prepareApprove({
        principal,
        idempotencyKey: randomUUID(),
        body: {
          walletId,
          assetId: usdtAssetId,
          spenderAddress,
          allowance: { mode: "unlimited" },
          acknowledgeUnlimited: true,
        },
        signal,
      }),
    ).rejects.toMatchObject({
      code: "POLICY_BLOCKED",
      detailsSafe: {
        reasonCode: "UNLIMITED_EXPOSURE_EXCEEDS_CEILING",
        exposureUsd: expect.any(String) as string,
        ceilingUsd: expect.any(String) as string,
      },
    });
    await expectCode(
      approvals.prepareApprove({
        principal,
        idempotencyKey: randomUUID(),
        body: {
          walletId,
          assetId: usdtAssetId,
          spenderAddress,
          allowance: { mode: "unlimited" },
        },
        signal,
      }),
      "VALIDATION_FAILED",
    );
    await expectCode(
      approvals.prepareApprove({
        principal,
        idempotencyKey: randomUUID(),
        body: {
          walletId,
          assetId: nativeAssetId,
          spenderAddress,
          allowance: { mode: "exact", amount: "1" },
        },
        signal,
      }),
      "VALIDATION_FAILED",
    );
  });

  it("prepares a revoke as approve(spender, 0) without a USD valuation", async () => {
    const { approvals } = build({ marketFacts: null });
    const { resource } = await approvals.prepareRevoke({
      principal,
      idempotencyKey: randomUUID(),
      body: { walletId, assetId: usdtAssetId, spenderAddress },
      signal,
    });
    expect(resource.kind).toBe("revoke");
    expect(resource.review.amount).toEqual({ raw: "0", display: "0" });
    expect(resource.review.decodedCall?.args).toEqual({
      spender: spenderAddress,
      value: "0",
    });
    expect(resource.policy.valueUsd).toBeNull();
    expect(resource.unsignedTransaction?.data.endsWith("0".repeat(64))).toBe(
      true,
    );
  });

  it("lists allowances from indexed approvals with live reads and omits zero rows", async () => {
    const otherSpender = "0x00000000000000000000000000000000000000d4";
    const { approvals } = build({
      readClient: {
        allowances: {
          [`${usdtAssetId}:${spenderAddress}`]: 3_000_000_000_000_000_000n,
          [`${usdtAssetId}:${otherSpender}`]: 0n,
          [`${wbnbAssetId}:${spenderAddress}`]: null,
        },
      },
      indexer: (await import("./wallet-intent-fakes.js")).indexerFake({
        approvals: [
          {
            transactionHash: txHash,
            logIndex: 1,
            blockNumber: "43999990",
            blockHash: `0x${"2".repeat(64)}`,
            assetId: usdtAssetId,
            ownerAddress: walletAddress,
            spenderAddress,
            rawValue: "3000000000000000000",
            removed: false,
            observedAt: "2026-09-08T00:00:00.000Z",
          },
          {
            transactionHash: `0x${"8".repeat(64)}`,
            logIndex: 0,
            blockNumber: "43999980",
            blockHash: `0x${"2".repeat(64)}`,
            assetId: usdtAssetId,
            ownerAddress: walletAddress,
            spenderAddress: otherSpender,
            rawValue: "1",
            removed: false,
            observedAt: "2026-09-08T00:00:00.000Z",
          },
          {
            transactionHash: `0x${"9".repeat(64)}`,
            logIndex: 0,
            blockNumber: "43999970",
            blockHash: `0x${"2".repeat(64)}`,
            assetId: wbnbAssetId,
            ownerAddress: walletAddress,
            spenderAddress,
            rawValue: "5",
            removed: false,
            observedAt: "2026-09-08T00:00:00.000Z",
          },
        ],
      }),
    });
    const list = await approvals.list({ principal, walletId });
    expect(
      list.items.map((item) => [item.assetId, item.allowance.status]),
    ).toEqual([
      [usdtAssetId, "available"],
      [wbnbAssetId, "unavailable"],
    ]);
    expect(list.items[0]?.allowance).toMatchObject({
      rawValue: "3000000000000000000",
      displayValue: "3",
      isUnlimited: false,
      blockNumber: "44000000",
    });
    expect(list.items[0]?.lastApproval?.transactionHash).toBe(txHash);
    expect(list.summary).toEqual({ activeCount: 1, unlimitedCount: 0 });
    expect(list.freshness.indexerBlockNumber).toBe("43999995");

    const detail = await approvals.get({
      principal,
      walletId,
      assetId: usdtAssetId,
      spender: spenderAddress,
    });
    expect(detail.item.allowance).toMatchObject({
      status: "available",
      rawValue: "3000000000000000000",
    });
  });

  it("is INDEXING_DELAYED before the transfer lane has a checkpoint", async () => {
    const { approvals } = build({
      indexer: (await import("./wallet-intent-fakes.js")).indexerFake({
        checkpoint: false,
      }),
    });
    await expectCode(
      approvals.list({ principal, walletId }),
      "INDEXING_DELAYED",
    );
  });

  it("is INDEXING_DELAYED while the lane has a checkpoint but no Approval coverage", async () => {
    // A lane backfilled before migration 000021: transfers exist, approvals
    // were never decoded. An empty inventory here would be a lie.
    const { approvals } = build({
      indexer: (await import("./wallet-intent-fakes.js")).indexerFake({
        approvalCoverageFromBlockNumber: null,
      }),
    });
    await expectCode(
      approvals.list({ principal, walletId }),
      "INDEXING_DELAYED",
    );
  });

  it("is INDEXING_DELAYED while Approval coverage starts after the wallet's earliest indexed activity", async () => {
    const fakes = await import("./wallet-intent-fakes.js");
    const { approvals: gap } = build({
      indexer: fakes.indexerFake({
        approvalCoverageFromBlockNumber: "43500000",
        earliestActivityBlockNumber: "43400000",
      }),
    });
    await expectCode(gap.list({ principal, walletId }), "INDEXING_DELAYED");

    // Coverage reaching back to (or below) the first activity is enough, and
    // a wallet the lane has never seen is not blocked by coverage.
    for (const indexer of [
      fakes.indexerFake({
        approvalCoverageFromBlockNumber: "43400000",
        earliestActivityBlockNumber: "43400000",
      }),
      fakes.indexerFake({
        approvalCoverageFromBlockNumber: "43500000",
        earliestActivityBlockNumber: null,
      }),
    ]) {
      const { approvals: covered } = build({ indexer });
      const list = await covered.list({ principal, walletId });
      expect(list.items).toEqual([]);
      expect(list.freshness.approvalCoverageFromBlockNumber).toMatch(
        /^43[45]00000$/,
      );
    }
  });

  it("refuses a native-asset approval as VALIDATION_FAILED before the canary allowlist is consulted", async () => {
    const { approvals } = build({ canaryAssetIds: [usdtAssetId] });
    await expect(
      approvals.prepareApprove({
        principal,
        idempotencyKey: randomUUID(),
        body: {
          walletId,
          assetId: "eip155:56:native",
          spenderAddress,
          allowance: { mode: "exact", amount: "1" },
        },
        signal,
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      detailsSafe: { reasonCode: "NATIVE_ASSET_NOT_APPROVABLE" },
    });
  });
});

describe("swap quote, prepare, execute", () => {
  function swapBuild(
    options: RuntimeFakeOptions & { readonly clock?: { value: number } } = {},
  ) {
    const clock = options.clock ?? {
      value: Date.parse("2026-09-08T00:00:00.000Z"),
    };
    const fixture = runtimeFake({
      ...options,
      now: () => new Date(clock.value),
    });
    const swap = createSwapService({ runtime: fixture.runtime });
    return {
      ...fixture,
      swap,
      clock,
      intents: createWalletIntentService(fixture.runtime),
    };
  }
  const quoteBody = {
    walletId,
    sourceAssetId: usdtAssetId,
    destinationAssetId: wbnbAssetId,
    amount: "4",
  };

  it("quotes through the adapter, values price impact, and binds the swap policy", async () => {
    const adapter = swapAdapterFake();
    const { swap } = swapBuild({ swapAdapter: adapter.adapter });
    const resource = await swap.quote({ principal, body: quoteBody, signal });
    expect(adapter.quoteCalls[0]).toMatchObject({
      providerWalletId: "wallet_privy_1",
      source: { assetAddress: usdt, caip2: "eip155:56" },
      destination: {
        assetAddress: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
        caip2: "eip155:56",
      },
      baseAmount: "4000000000000000000",
      slippageBps: 50,
      feeBps: null,
    });
    expect(resource.quote).toMatchObject({
      provider: "privy",
      amountType: "exact_input",
      inputAmount: { raw: "4000000000000000000", display: "4" },
      estimatedOutputAmount: { raw: "5970000000000000", display: "0.00597" },
      slippageBps: 50,
      platformFeeBps: null,
    });
    // 0.00597 WBNB × 600 USD = 3.582 USD against 4 USD in: 10.45% impact.
    expect(resource.quote.priceImpact).toMatchObject({
      status: "available",
      value: "0.1045",
      decision: "blocked",
    });
    expect(resource.policy.configVersion).toBe("swapPolicyV1");
    expect(resource.canary).toEqual({
      configVersion: "bscWriteCanaryV1",
      canaryMaxUsd: "20",
      inputValueUsd: "4",
    });
    expect(
      Date.parse(resource.quote.expiresAt) -
        Date.parse(resource.quote.quotedAt),
    ).toBe(30_000);
  });

  it("refuses slippage above 300 bps, the same asset, and unpriceable pairs", async () => {
    const { swap } = swapBuild();
    await expectCode(
      swap.quote({
        principal,
        body: { ...quoteBody, slippageBps: 301 },
        signal,
      }),
      "INVALID_REQUEST",
    );
    await expectCode(
      swap.quote({
        principal,
        body: { ...quoteBody, destinationAssetId: usdtAssetId },
        signal,
      }),
      "VALIDATION_FAILED",
    );
    const { swap: unpriced } = swapBuild({ marketFacts: null });
    await expectCode(
      unpriced.quote({ principal, body: quoteBody, signal }),
      "CAPABILITY_UNAVAILABLE",
    );
  });

  it("prepares an intent with the authorization payload and executes it once", async () => {
    const adapter = swapAdapterFake({
      quote: {
        estimatedOutputAmount: "6650000000000000",
        minimumOutputAmount: "6620000000000000",
      },
    });
    const { swap, controlPlane, intents, repository } = swapBuild({
      swapAdapter: adapter.adapter,
    });
    const quoted = await swap.quote({ principal, body: quoteBody, signal });
    expect(quoted.quote.priceImpact.decision).toBe("allowed");
    const prepared = await swap.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: { walletId, quoteId: quoted.quote.quoteId },
      signal,
    });
    const resource = prepared.resource;
    expect(resource.kind).toBe("swap");
    // No Provider-side simulation exists yet: the intent is prepared, never
    // signable, and execute is SIMULATION_FAILED (main-agent ruling).
    expect(resource.state).toBe("prepared");
    expect(resource.signing).toEqual({
      mode: "privy_authorization_signature",
      allowed: false,
      reasonCode: "SWAP_SIMULATION_PROVIDER_PENDING",
    });
    expect(resource.simulation).toMatchObject({
      status: "unavailable",
      source: "provider_quote",
      reasonCode: "SWAP_SIMULATION_PROVIDER_PENDING",
    });
    await expectCode(
      swap.execute({
        principal,
        intentId: resource.intentId,
        body: { authorizationSignature: "sig-from-device" },
        signal,
      }),
      "SIMULATION_FAILED",
    );
    // A second prepare on the same quote is refused: the quote was spent.
    await expectCode(
      swap.prepare({
        principal,
        idempotencyKey: randomUUID(),
        body: { walletId, quoteId: quoted.quote.quoteId },
        signal,
      }),
      "QUOTE_EXPIRED",
    );
    unlockForSigning(repository, resource.intentId);
    expect(resource.unsignedTransaction).toBeNull();
    expect(resource.authorizationPayload).toEqual({
      version: 1,
      method: "POST",
      url: "https://api.privy.io/v1/wallets/wallet_privy_1/swap",
      body: {
        base_amount: "4000000000000000000",
        source: { asset_address: usdt, caip2: "eip155:56" },
        destination: {
          asset_address: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
          caip2: "eip155:56",
        },
        amount_type: "exact_input",
        slippage_bps: 50,
      },
      headers: {
        "privy-app-id": "app_test",
        "privy-idempotency-key": resource.intentId,
        "privy-request-expiry": String(Date.parse(resource.expiresAt)),
      },
    });
    expect(resource.review.swap?.quote.quoteId).toBe(quoted.quote.quoteId);

    const executed = await swap.execute({
      principal,
      intentId: resource.intentId,
      body: { authorizationSignature: "sig-from-device" },
      signal,
    });
    expect(executed.state).toBe("submitted");
    expect(executed.result.providerActionId).toBe("act_1");
    expect(adapter.executeCalls[0]).toMatchObject({
      providerWalletId: "wallet_privy_1",
      authorizationSignature: "sig-from-device",
      idempotencyKey: resource.intentId,
      requestExpiryMs: String(Date.parse(resource.expiresAt)),
      body: resource.authorizationPayload?.body,
    });
    expect([...controlPlane.operations.values()][0]).toMatchObject({
      state: "accepted",
      attemptCount: 1,
    });
    await expectCode(
      swap.execute({
        principal,
        intentId: resource.intentId,
        body: { authorizationSignature: "sig-from-device" },
        signal,
      }),
      "SUBMISSION_UNKNOWN",
    );
    expect(adapter.executeCalls).toHaveLength(1);
    await expectCode(
      intents.cancel({ principal, intentId: resource.intentId }),
      "DATA_STALE",
    );
  });

  it("requires confirmation for a 1–5% impact and blocks above 5%", async () => {
    const confirmAdapter = swapAdapterFake({
      quote: { estimatedOutputAmount: "6560000000000000" },
    });
    const { swap } = swapBuild({ swapAdapter: confirmAdapter.adapter });
    const quoted = await swap.quote({ principal, body: quoteBody, signal });
    expect(quoted.quote.priceImpact.decision).toBe("confirm");
    await expectCode(
      swap.prepare({
        principal,
        idempotencyKey: randomUUID(),
        body: { walletId, quoteId: quoted.quote.quoteId },
        signal,
      }),
      "VALIDATION_FAILED",
    );
    const prepared = await swap.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: {
        walletId,
        quoteId: quoted.quote.quoteId,
        confirmPriceImpact: true,
      },
      signal,
    });
    expect(prepared.resource.state).toBe("prepared");

    const { swap: blocked } = swapBuild();
    const blockedQuote = await blocked.quote({
      principal,
      body: quoteBody,
      signal,
    });
    await expectCode(
      blocked.prepare({
        principal,
        idempotencyKey: randomUUID(),
        body: {
          walletId,
          quoteId: blockedQuote.quote.quoteId,
          confirmPriceImpact: true,
        },
        signal,
      }),
      "POLICY_BLOCKED",
    );
  });

  it("expires the quote after 30 seconds and the intent with it", async () => {
    const adapter = swapAdapterFake({
      quote: { estimatedOutputAmount: "6650000000000000" },
    });
    const { swap, clock, repository } = swapBuild({
      swapAdapter: adapter.adapter,
    });
    const quoted = await swap.quote({ principal, body: quoteBody, signal });
    const prepared = await swap.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: { walletId, quoteId: quoted.quote.quoteId },
      signal,
    });
    unlockForSigning(repository, prepared.resource.intentId);
    clock.value += 31_000;
    await expectCode(
      swap.execute({
        principal,
        intentId: prepared.resource.intentId,
        body: { authorizationSignature: "sig" },
        signal,
      }),
      "QUOTE_EXPIRED",
    );
    await expectCode(
      swap.prepare({
        principal,
        idempotencyKey: randomUUID(),
        body: { walletId, quoteId: quoted.quote.quoteId },
        signal,
      }),
      "QUOTE_EXPIRED",
    );
    expect(adapter.executeCalls).toHaveLength(0);
  });

  it("reports a Provider that has Swap disabled as CAPABILITY_UNAVAILABLE, not a validation error (Decision 0065)", async () => {
    const refusing = swapAdapterFake();
    refusing.adapter.quote = () =>
      Promise.reject(
        new PrivySwapProviderError("unavailable", "PRIVY_SWAP_NOT_AUTHORIZED"),
      );
    const { swap } = swapBuild({ swapAdapter: refusing.adapter });
    await expectCode(
      swap.quote({ principal, body: quoteBody, signal }),
      "CAPABILITY_UNAVAILABLE",
    );

    const rejecting = swapAdapterFake();
    rejecting.adapter.quote = () =>
      Promise.reject(
        new PrivySwapProviderError("rejected", "PRIVY_SWAP_QUOTE_REJECTED"),
      );
    const { swap: invalid } = swapBuild({ swapAdapter: rejecting.adapter });
    await expectCode(
      invalid.quote({ principal, body: quoteBody, signal }),
      "VALIDATION_FAILED",
    );
  });

  it("turns a Provider rejection into failed and an ambiguous transport into unknown", async () => {
    const rejected = swapAdapterFake({
      quote: { estimatedOutputAmount: "6650000000000000" },
      execute: () =>
        Promise.reject(
          new PrivySwapProviderError("rejected", "PRIVY_SWAP_REJECTED"),
        ),
    });
    const first = swapBuild({ swapAdapter: rejected.adapter });
    const quotedA = await first.swap.quote({
      principal,
      body: quoteBody,
      signal,
    });
    const preparedA = await first.swap.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: { walletId, quoteId: quotedA.quote.quoteId },
      signal,
    });
    unlockForSigning(first.repository, preparedA.resource.intentId);
    const failed = await first.swap.execute({
      principal,
      intentId: preparedA.resource.intentId,
      body: { authorizationSignature: "sig" },
      signal,
    });
    expect(failed.state).toBe("failed");
    expect(failed.result.reasonCode).toBe("PRIVY_SWAP_REJECTED");
    expect([...first.controlPlane.operations.values()][0]?.state).toBe(
      "rejected",
    );

    const ambiguous = swapAdapterFake({
      quote: { estimatedOutputAmount: "6650000000000000" },
      execute: () =>
        Promise.reject(
          new PrivySwapProviderError(
            "ambiguous",
            "PRIVY_SWAP_RESULT_AMBIGUOUS",
          ),
        ),
    });
    const second = swapBuild({ swapAdapter: ambiguous.adapter });
    const quotedB = await second.swap.quote({
      principal,
      body: quoteBody,
      signal,
    });
    const preparedB = await second.swap.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: { walletId, quoteId: quotedB.quote.quoteId },
      signal,
    });
    unlockForSigning(second.repository, preparedB.resource.intentId);
    const unknown = await second.swap.execute({
      principal,
      intentId: preparedB.resource.intentId,
      body: { authorizationSignature: "sig" },
      signal,
    });
    expect(unknown.state).toBe("unknown");
    expect(unknown.result.reasonCode).toBe("PROVIDER_RESULT_AMBIGUOUS");
    expect([...second.controlPlane.operations.values()][0]?.state).toBe(
      "unknown",
    );
    await expectCode(
      second.swap.execute({
        principal,
        intentId: preparedB.resource.intentId,
        body: { authorizationSignature: "sig" },
        signal,
      }),
      "SUBMISSION_UNKNOWN",
    );
  });

  it("marks a proven-not-sent Provider failure as failed without reconciliation", async () => {
    const notSent = swapAdapterFake({
      quote: { estimatedOutputAmount: "6650000000000000" },
      execute: () =>
        Promise.reject(
          new PrivySwapProviderError("unavailable", "PRIVY_NOT_CONFIGURED"),
        ),
    });
    const { swap, repository } = swapBuild({ swapAdapter: notSent.adapter });
    const quoted = await swap.quote({ principal, body: quoteBody, signal });
    const prepared = await swap.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: { walletId, quoteId: quoted.quote.quoteId },
      signal,
    });
    unlockForSigning(repository, prepared.resource.intentId);
    const failed = await swap.execute({
      principal,
      intentId: prepared.resource.intentId,
      body: { authorizationSignature: "sig" },
      signal,
    });
    expect(failed.state).toBe("failed");
    expect(failed.result.reasonCode).toBe("PRIVY_SWAP_NOT_SENT");
  });

  it("fails closed without Privy configuration", async () => {
    const { swap } = swapBuild({ privyAppId: null });
    await expectCode(
      swap.quote({ principal, body: quoteBody, signal }),
      "CAPABILITY_UNAVAILABLE",
    );
  });
});

describe("reconciliation lane", () => {
  it("verifies a pending hash, waits for confirmations, then confirms", async () => {
    const transactions = new Map<string, BscTransactionObservation | null>();
    const receipts = new Map<string, BscTransactionReceiptObservation | null>();
    const { send, intents, runtime, repository } = build({
      readClient: { transactions, receipts },
    });
    const { resource } = await send.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: sendBody(),
      signal,
    });
    await intents.reportBroadcast({
      principal,
      intentId: resource.intentId,
      body: { txHash },
    });
    const reconciler = createWalletIntentReconciler({
      repository: runtime.repository,
      wallets: runtime.wallets,
      readClient: runtime.readClient,
      swapAdapter: runtime.swapAdapter,
      createUuid: randomUUID,
    });

    // Not seen yet: nothing changes.
    let result = await reconciler.reconcileOnce();
    expect(result.transitions).toEqual([]);
    expect(repository.records.get(resource.intentId)?.state).toBe("submitted");

    // Seen and matching, but no receipt: pending marker cleared.
    const transaction = resource.unsignedTransaction;
    if (transaction === null) {
      throw new Error("expected an unsigned transaction");
    }
    transactions.set(txHash, observedTransaction(transaction));
    for (const record of repository.records.values()) {
      repository.records.set(record.intentId, {
        ...record,
        reconcileAfter: null,
      });
    }
    result = await reconciler.reconcileOnce();
    expect(result.transitions).toEqual([
      { intentId: resource.intentId, toState: "submitted", reasonCode: null },
    ]);

    // Receipt with 5 confirmations: still submitted, receipt stored.
    receipts.set(txHash, {
      hash: txHash,
      status: "success",
      blockNumber: 43_999_996n,
      blockHash: `0x${"4".repeat(64)}`,
      gasUsed: 51_000n,
      effectiveGasPrice: 1_000_000_000n,
    });
    for (const record of repository.records.values()) {
      repository.records.set(record.intentId, {
        ...record,
        reconcileAfter: null,
      });
    }
    await reconciler.reconcileOnce();
    expect(repository.records.get(resource.intentId)).toMatchObject({
      state: "submitted",
      receipt: { status: "success", blockNumber: "43999996" },
    });

    // Receipt older than 15 blocks: confirmed.
    receipts.set(txHash, {
      hash: txHash,
      status: "success",
      blockNumber: 43_999_900n,
      blockHash: `0x${"4".repeat(64)}`,
      gasUsed: 51_000n,
      effectiveGasPrice: 1_000_000_000n,
    });
    for (const record of repository.records.values()) {
      repository.records.set(record.intentId, {
        ...record,
        reconcileAfter: null,
      });
    }
    result = await reconciler.reconcileOnce();
    expect(result.transitions).toEqual([
      { intentId: resource.intentId, toState: "confirmed", reasonCode: null },
    ]);
    const projected = await intents.get({
      principal,
      intentId: resource.intentId,
    });
    expect(projected.result.receipt).toMatchObject({
      status: "success",
      confirmations: 101,
    });
  });

  it("fails an intent whose broadcast hash carries a different payload and reverts on a failed receipt", async () => {
    const transactions = new Map<string, BscTransactionObservation | null>();
    const receipts = new Map<string, BscTransactionReceiptObservation | null>();
    const { send, intents, runtime, repository } = build({
      readClient: { transactions, receipts },
    });
    const { resource } = await send.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: sendBody(),
      signal,
    });
    await intents.reportBroadcast({
      principal,
      intentId: resource.intentId,
      body: { txHash },
    });
    const transaction = resource.unsignedTransaction;
    if (transaction === null) {
      throw new Error("expected an unsigned transaction");
    }
    transactions.set(
      txHash,
      observedTransaction(transaction, { to: recipientAddress }),
    );
    const reconciler = createWalletIntentReconciler({
      repository: runtime.repository,
      wallets: runtime.wallets,
      readClient: runtime.readClient,
      swapAdapter: runtime.swapAdapter,
      createUuid: randomUUID,
    });
    for (const record of repository.records.values()) {
      repository.records.set(record.intentId, {
        ...record,
        reconcileAfter: null,
      });
    }
    const result = await reconciler.reconcileOnce();
    expect(result.transitions).toEqual([
      {
        intentId: resource.intentId,
        toState: "failed",
        reasonCode: "TX_PAYLOAD_MISMATCH",
      },
    ]);

    const other = await send.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: sendBody({ amount: "2" }),
      signal,
    });
    const otherHash = `0x${"6".repeat(64)}`;
    const otherTransaction = other.resource.unsignedTransaction;
    if (otherTransaction === null) {
      throw new Error("expected an unsigned transaction");
    }
    transactions.set(
      otherHash,
      observedTransaction(otherTransaction, { hash: otherHash }),
    );
    await intents.reportBroadcast({
      principal,
      intentId: other.resource.intentId,
      body: { txHash: otherHash },
    });
    receipts.set(otherHash, {
      hash: otherHash,
      status: "reverted",
      blockNumber: 43_999_000n,
      blockHash: `0x${"4".repeat(64)}`,
      gasUsed: 30_000n,
      effectiveGasPrice: 1_000_000_000n,
    });
    for (const record of repository.records.values()) {
      repository.records.set(record.intentId, {
        ...record,
        reconcileAfter: null,
      });
    }
    const reverted = await reconciler.reconcileOnce();
    expect(reverted.transitions).toEqual([
      {
        intentId: other.resource.intentId,
        toState: "reverted",
        reasonCode: "TX_REVERTED",
      },
    ]);
  });

  it("re-verifies the payload before finalising, drops a lost receipt, and survives a failing read", async () => {
    const transactions = new Map<string, BscTransactionObservation | null>();
    const receipts = new Map<string, BscTransactionReceiptObservation | null>();
    const { send, intents, runtime, repository } = build({
      readClient: { transactions, receipts },
    });
    const { resource } = await send.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: sendBody(),
      signal,
    });
    const transaction = resource.unsignedTransaction;
    if (transaction === null) {
      throw new Error("expected an unsigned transaction");
    }
    transactions.set(txHash, observedTransaction(transaction));
    const reported = await intents.reportBroadcast({
      principal,
      intentId: resource.intentId,
      body: { txHash },
    });
    expect(repository.records.get(reported.intentId)?.payloadVerified).toBe(
      true,
    );
    const reconciler = createWalletIntentReconciler({
      repository: runtime.repository,
      wallets: runtime.wallets,
      readClient: runtime.readClient,
      swapAdapter: runtime.swapAdapter,
      createUuid: randomUUID,
    });
    const reset = (): void => {
      for (const record of repository.records.values()) {
        repository.records.set(record.intentId, {
          ...record,
          reconcileAfter: null,
        });
      }
    };
    // A receipt with too few confirmations is stored…
    receipts.set(txHash, {
      hash: txHash,
      status: "success",
      blockNumber: 43_999_996n,
      blockHash: `0x${"4".repeat(64)}`,
      gasUsed: 51_000n,
      effectiveGasPrice: 1_000_000_000n,
    });
    reset();
    await reconciler.reconcileOnce();
    expect(repository.records.get(resource.intentId)?.receipt).not.toBeNull();
    // …and dropped again when the block is reorged out.
    receipts.delete(txHash);
    reset();
    const lost = await reconciler.reconcileOnce();
    expect(lost.transitions).toEqual([
      { intentId: resource.intentId, toState: "submitted", reasonCode: null },
    ]);
    expect(repository.records.get(resource.intentId)?.receipt).toBeNull();
    expect(repository.events.at(-1)?.eventType).toBe("receipt_lost");

    // A refused receipt read (403) is recorded and does not stop the batch.
    const failing = build({ readClient: { transactions } });
    const other = await failing.send.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: sendBody(),
      signal,
    });
    const otherTransaction = other.resource.unsignedTransaction;
    if (otherTransaction === null) {
      throw new Error("expected an unsigned transaction");
    }
    transactions.set(txHash, observedTransaction(otherTransaction));
    await failing.intents.reportBroadcast({
      principal,
      intentId: other.resource.intentId,
      body: { txHash },
    });
    const forbidden = Object.assign(new Error("forbidden"), { status: 403 });
    const failingReconciler = createWalletIntentReconciler({
      repository: failing.runtime.repository,
      wallets: failing.runtime.wallets,
      readClient: {
        ...failing.runtime.readClient,
        getTransactionReceipt: () => Promise.reject(forbidden),
      },
      swapAdapter: failing.runtime.swapAdapter,
      createUuid: randomUUID,
    });
    for (const record of failing.repository.records.values()) {
      failing.repository.records.set(record.intentId, {
        ...record,
        reconcileAfter: null,
      });
    }
    const result = await failingReconciler.reconcileOnce();
    expect(result.leasedCount).toBe(1);
    expect(result.transitions).toEqual([]);
    expect(failing.repository.events.at(-1)).toMatchObject({
      eventType: "reconciliation_read_failed",
      reasonCode: "RPC_RECEIPT_UNAVAILABLE",
    });
    expect(failing.repository.records.get(other.resource.intentId)?.state).toBe(
      "submitted",
    );
  });

  it("gives up on a hash that never appears and locks it as unknown", async () => {
    const { send, intents, runtime, repository } = build();
    const { resource } = await send.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: sendBody(),
      signal,
    });
    await intents.reportBroadcast({
      principal,
      intentId: resource.intentId,
      body: { txHash },
    });
    const record = repository.records.get(resource.intentId);
    if (record === undefined) {
      throw new Error("missing");
    }
    repository.records.set(resource.intentId, {
      ...record,
      reconcileAfter: null,
      reconcileAttemptCount: 240,
    });
    const reconciler = createWalletIntentReconciler({
      repository: runtime.repository,
      wallets: runtime.wallets,
      readClient: runtime.readClient,
      swapAdapter: runtime.swapAdapter,
      createUuid: randomUUID,
    });
    const result = await reconciler.reconcileOnce();
    expect(result.transitions).toEqual([
      {
        intentId: resource.intentId,
        toState: "unknown",
        reasonCode: "TX_NOT_OBSERVED",
      },
    ]);
    // An unknown intent is not silently retried into any other state.
    const again = await reconciler.reconcileOnce();
    expect(again.transitions).toEqual([]);
  });

  it("resolves swap intents from Privy action status", async () => {
    let status: "pending" | "succeeded" | "rejected" | "failed" = "pending";
    const adapter = swapAdapterFake({
      quote: { estimatedOutputAmount: "6650000000000000" },
      action: () =>
        Promise.resolve({
          actionId: "act_1",
          status,
          inputAmount: null,
          outputAmount: null,
          steps: [
            {
              status: status === "failed" ? "reverted" : "confirmed",
              transactionHash: txHash,
            },
          ],
          failureReasonCode: null,
        }),
    });
    const clock = { value: Date.parse("2026-09-08T00:00:00.000Z") };
    const fixture = runtimeFake({
      swapAdapter: adapter.adapter,
      now: () => new Date(clock.value),
    });
    const swap = createSwapService({ runtime: fixture.runtime });
    const quoted = await swap.quote({
      principal,
      body: {
        walletId,
        sourceAssetId: usdtAssetId,
        destinationAssetId: wbnbAssetId,
        amount: "4",
      },
      signal,
    });
    const prepared = await swap.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: { walletId, quoteId: quoted.quote.quoteId },
      signal,
    });
    unlockForSigning(fixture.repository, prepared.resource.intentId);
    await swap.execute({
      principal,
      intentId: prepared.resource.intentId,
      body: { authorizationSignature: "sig" },
      signal,
    });
    const reconciler = createWalletIntentReconciler({
      repository: fixture.runtime.repository,
      wallets: fixture.runtime.wallets,
      readClient: fixture.runtime.readClient,
      swapAdapter: fixture.runtime.swapAdapter,
      createUuid: randomUUID,
      now: fixture.runtime.now,
    });
    clock.value += 6_000;
    let result = await reconciler.reconcileOnce();
    expect(result.transitions).toEqual([
      {
        intentId: prepared.resource.intentId,
        toState: "submitted",
        reasonCode: null,
      },
    ]);
    expect(
      fixture.repository.records.get(prepared.resource.intentId)
        ?.transactionHash,
    ).toBe(txHash);

    status = "succeeded";
    clock.value += 16_000;
    result = await reconciler.reconcileOnce();
    expect(result.transitions).toEqual([
      {
        intentId: prepared.resource.intentId,
        toState: "confirmed",
        reasonCode: null,
      },
    ]);
  });
});
