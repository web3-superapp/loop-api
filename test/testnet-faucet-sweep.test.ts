import { describe, expect, it, vi } from "vitest";

import { createTestnetFaucetPendingSweep } from "../src/features/testnet-faucet/testnet-faucet-sweep.js";
import { createReconciliationWorkerLogger } from "../src/reconciliation-worker-logger.js";
import { createTestnetFaucetSweepLane } from "../src/testnet-faucet-sweep-worker.js";
import {
  bnbHash,
  createInMemoryFaucetRepository,
  embeddedAddress,
  usd1Hash,
} from "./helpers/testnet-faucet-fakes.js";

/**
 * S169 (Decision 0128 §9): the worker's pending sweep closes grants left
 * `pending` from the chain — `unknown` when the tBNB hash is known,
 * `failed` (TESTNET_FAUCET_PENDING_EXPIRED) when it is not or none was
 * stored — and leaves fresh grants and failed lookups alone.
 */

const NOW = new Date("2026-10-12T08:00:00.000Z");
const policy = {
  cooldownSeconds: 86_400,
  failedCooldownSeconds: 300,
  failedDailyLimit: 5,
};

async function seed(
  repository: ReturnType<typeof createInMemoryFaucetRepository>,
  index: number,
  ageSeconds: number,
  hash: string | null,
): Promise<string> {
  const grantId = `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
  await repository.reserve({
    ownerUserId: `owner-${index}`,
    idempotencyKey: `key-${index}`,
    requestSha256: "a".repeat(64),
    grantId,
    walletId: `wallet-${index}`,
    address: `0x${index.toString(16).padStart(40, "0")}`,
    chainId: "eip155:97",
    bnbAmount: "0.02",
    bnbAmountRaw: "20000000000000000",
    usd1Amount: "500",
    usd1AmountRaw: "500000000000000000000",
    usd1TokenAddress: embeddedAddress,
    operatorAddress: embeddedAddress,
    now: new Date(NOW.getTime() - ageSeconds * 1_000),
    policy,
  });
  if (hash !== null) {
    await repository.recordTransactionHash({
      grantId,
      leg: "bnb",
      transactionHash: hash,
    });
  }
  return grantId;
}

describe("testnet faucet pending sweep (S169)", () => {
  it("closes stale grants by what the chain knows and keeps the rest", async () => {
    const repository = createInMemoryFaucetRepository();
    const landed = await seed(repository, 1, 1_000, bnbHash);
    const dropped = await seed(repository, 2, 1_000, usd1Hash);
    const unsigned = await seed(repository, 3, 1_000, null);
    const flaky = await seed(repository, 4, 1_000, `0x${"d4".repeat(32)}`);
    const fresh = await seed(repository, 5, 600, bnbHash);
    const events: unknown[] = [];
    const sweep = createTestnetFaucetPendingSweep({
      repository,
      lookup: {
        lookup: (hash) =>
          hash === bnbHash
            ? Promise.resolve("found")
            : hash === usd1Hash
              ? Promise.resolve("not_found")
              : Promise.reject(new Error("rpc down")),
      },
      pendingTimeoutSeconds: 900,
      now: () => NOW,
      onEvent: (event) => events.push(event),
    });
    expect(await sweep.runOnce()).toEqual({
      scanned: 4,
      unknown: 1,
      failed: 2,
      skipped: 1,
    });
    const status = (grantId: string) =>
      repository.grants.find((grant) => grant.record.grantId === grantId)
        ?.record;
    expect(status(landed)).toMatchObject({
      status: "unknown",
      failureReasonCode: "TESTNET_FAUCET_SUBMISSION_UNKNOWN",
    });
    expect(status(dropped)).toMatchObject({
      status: "failed",
      failureReasonCode: "TESTNET_FAUCET_PENDING_EXPIRED",
    });
    expect(status(unsigned)).toMatchObject({
      status: "failed",
      failureReasonCode: "TESTNET_FAUCET_PENDING_EXPIRED",
    });
    expect(status(flaky)?.status).toBe("pending");
    expect(status(fresh)?.status).toBe("pending");
    expect(events).toContainEqual({
      kind: "lookup_failed",
      grantId: flaky,
      bnbTransactionHash: `0x${"d4".repeat(32)}`,
      errorClass: "Error",
    });
    // A sweep-expired failure never holds the address or the owner.
    expect(
      await repository.nextAvailableAt({
        address: `0x${(2).toString(16).padStart(40, "0")}`,
        ownerUserId: "owner-2",
        now: NOW,
        policy,
      }),
    ).toBeNull();
  });

  it("backs the lane off on a repository failure without stopping", async () => {
    const backoff = vi.fn();
    const controller = new AbortController();
    let calls = 0;
    const lane = createTestnetFaucetSweepLane({
      repository: {
        listStalePending: () => {
          calls += 1;
          if (calls >= 2) controller.abort();
          return Promise.reject(new Error("db down"));
        },
        resolveStalePending: () => Promise.resolve(false),
      },
      lookup: { lookup: () => Promise.resolve("found") },
      pendingTimeoutSeconds: 900,
      intervalMs: 10,
      onInfrastructureBackoff: backoff,
    });
    expect(lane.lane).toBe("testnet_faucet_pending_sweep");
    await lane.run(controller.signal);
    expect(backoff).toHaveBeenCalledWith({
      lane: "testnet_faucet_pending_sweep",
      consecutiveFailureCount: 1,
      retryDelayMs: 1_000,
      errorClass: "Error",
    });
  });

  it("logs the lane, grant ID, status, and hash through the worker logger allowlist", () => {
    const lines: string[] = [];
    const logger = createReconciliationWorkerLogger({
      level: "info",
      serviceVersion: "test",
      writeStdout: (line) => lines.push(line),
      writeStderr: (line) => lines.push(line),
    });
    logger.warn(
      {
        lane: "testnet_faucet_pending_sweep",
        testnetFaucetGrantId: "00000000-0000-4000-8000-000000000001",
        testnetFaucetStatus: "unknown",
        transactionHash: bnbHash,
      },
      "LOOP testnet faucet sweep closed a pending grant",
    );
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      lane: "testnet_faucet_pending_sweep",
      testnetFaucetGrantId: "00000000-0000-4000-8000-000000000001",
      testnetFaucetStatus: "unknown",
      transactionHash: bnbHash,
    });
  });
});
