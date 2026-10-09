import { describe, expect, it, vi } from "vitest";

import type { BscIndexerRepository } from "../src/database/bsc-indexer-repository.js";
import type { ChainRegistryRepository } from "../src/database/chain-registry-repository.js";
import { createChainStatusService } from "../src/features/chain/chain-status-service.js";
import {
  createUnavailableBscReadClient,
  type BscEndpointHealth,
  type BscReadClient,
  type ChainVerificationState,
} from "../src/integrations/bsc/rpc-client.js";

/**
 * Decision 0088: the chain status legs run together, the verification and
 * the endpoint probe are reused for 60 s, and the head is read every time.
 */

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

function endpoint(observedAt: string): BscEndpointHealth {
  return {
    endpointRef: "rpc-abcdefabcdef",
    label: "rpc-a.example",
    status: "healthy",
    latencyMs: 42,
    blockNumber: "100",
    blockLagBlocks: 0,
    chainVerification: "verified",
    observedAt,
  };
}

function client(
  overrides: Partial<BscReadClient> & {
    readonly chainReference?: 56 | 97;
  } = {},
): BscReadClient {
  const base = createUnavailableBscReadClient({
    chainId: overrides.chainReference === 97 ? "eip155:97" : "eip155:56",
    chainReference: overrides.chainReference ?? 56,
  });
  let head = 100n;
  return {
    ...base,
    endpointRefs: ["rpc-abcdefabcdef"],
    verifyChain: () => Promise.resolve("verified"),
    currentVerification: () => "verified",
    getHead: () => {
      head += 1n;
      return Promise.resolve({
        blockNumber: head,
        blockHash: `0x${"ab".repeat(32)}`,
        observedAt: new Date().toISOString(),
      });
    },
    probeEndpoints: () =>
      Promise.resolve([endpoint("2026-09-28T00:00:00.000Z")]),
    ...overrides,
  };
}

function repositories(order: string[] = []) {
  return {
    repository: {
      listReadableAssets: vi.fn(() => {
        order.push("assets");
        return Promise.resolve([]);
      }),
      listPools: vi.fn(() => {
        order.push("pools");
        return Promise.resolve([]);
      }),
    } as unknown as ChainRegistryRepository,
    indexerRepository: {
      getCheckpoint: vi.fn((lane: string) => {
        order.push(`checkpoint:${lane}`);
        return Promise.resolve({
          lastBlockNumber: "95",
          lastBlockHash: `0x${"cd".repeat(32)}`,
          reorgCount: 0,
          updatedAt: "2026-09-28T00:00:00.000Z",
        });
      }),
    } as unknown as BscIndexerRepository,
  };
}

function service(
  primary: BscReadClient,
  launch: BscReadClient | null,
  clockMs: { value: number },
  order: string[] = [],
) {
  return createChainStatusService({
    ...repositories(order),
    readClient: primary,
    launchReadClient: launch,
    chainId: "eip155:56",
    chainName: "BNB Smart Chain",
    chainReference: 56,
    nativeAssetId: "eip155:56:native",
    nowMs: () => clockMs.value,
  });
}

describe("chain status reads (Decision 0088)", () => {
  it("starts the probe, both heads and the database reads together", async () => {
    const order: string[] = [];
    const probe = deferred<readonly BscEndpointHealth[]>();
    const primaryHead = deferred<{
      blockNumber: bigint;
      blockHash: string;
      observedAt: string;
    }>();
    const launchHead = deferred<{
      blockNumber: bigint;
      blockHash: string;
      observedAt: string;
    }>();
    const primary = client({
      probeEndpoints: () => {
        order.push("probe");
        return probe.promise;
      },
      getHead: () => {
        order.push("head:primary");
        return primaryHead.promise;
      },
    });
    const launch = client({
      chainReference: 97,
      getHead: () => {
        order.push("head:launch");
        return launchHead.promise;
      },
    });
    const pending = service(primary, launch, { value: 0 }, order).getStatus();
    await flush();
    // Nothing has answered yet, and every leg is already in flight.
    expect([...order].sort()).toEqual([
      "assets",
      "checkpoint:erc20_transfer",
      "checkpoint:pool_event",
      "head:launch",
      "head:primary",
      "pools",
      "probe",
    ]);
    probe.resolve([endpoint("2026-09-28T00:00:00.000Z")]);
    primaryHead.resolve({
      blockNumber: 100n,
      blockHash: `0x${"ab".repeat(32)}`,
      observedAt: "2026-09-28T00:00:01.000Z",
    });
    launchHead.resolve({
      blockNumber: 7n,
      blockHash: `0x${"ef".repeat(32)}`,
      observedAt: "2026-09-28T00:00:01.000Z",
    });
    const status = await pending;
    expect(status.rpc.head?.blockNumber).toBe("100");
    expect(status.indexer.map((lane) => lane.lagBlocks)).toEqual([5, 5]);
    expect(status.launchChain?.head?.blockNumber).toBe("7");
  });

  it("reuses the endpoint probe for 60 s, refreshes it beside the call past 30 s, and never reuses the head", async () => {
    let probes = 0;
    const primary = client({
      probeEndpoints: () => {
        probes += 1;
        return Promise.resolve([
          endpoint(new Date(probes * 1_000).toISOString()),
        ]);
      },
    });
    const getHead = vi.spyOn(primary, "getHead");
    const clockMs = { value: 0 };
    const subject = service(primary, null, clockMs);

    const first = await subject.getStatus();
    expect(probes).toBe(1);
    clockMs.value = 29_999;
    const second = await subject.getStatus();
    expect(probes).toBe(1);
    expect(second.rpc.endpoints).toBe(first.rpc.endpoints);
    // The head is a live read on every call.
    expect(getHead).toHaveBeenCalledTimes(2);
    expect(second.rpc.head?.blockNumber).not.toBe(first.rpc.head?.blockNumber);

    clockMs.value = 30_000;
    const third = await subject.getStatus();
    expect(third.rpc.endpoints).toBe(first.rpc.endpoints);
    await flush();
    expect(probes).toBe(2);
    const fourth = await subject.getStatus();
    // The refreshed probe keeps the time it was taken.
    expect(fourth.rpc.endpoints[0]?.observedAt).toBe(
      new Date(2_000).toISOString(),
    );

    clockMs.value = 90_000;
    await subject.getStatus();
    expect(probes).toBe(3);
  });

  it("asks an unreachable chain again at most once per window and reports a recovery at once", async () => {
    let verification: ChainVerificationState = "unreachable";
    const verifyChain = vi.fn(() => Promise.resolve(verification));
    const primary = client({
      verifyChain,
      currentVerification: () => verification,
    });
    const clockMs = { value: 0 };
    const subject = service(primary, null, clockMs);

    const first = await subject.getStatus();
    expect(first.rpc).toMatchObject({
      status: "unavailable",
      reasonCode: "BSC_RPC_UNREACHABLE",
      head: null,
    });
    clockMs.value = 59_999;
    await subject.getStatus();
    expect(verifyChain).toHaveBeenCalledTimes(1);
    clockMs.value = 60_000;
    await subject.getStatus();
    expect(verifyChain).toHaveBeenCalledTimes(2);

    // Another read verified the chain: the next status says so without a
    // probe of its own.
    verification = "verified";
    clockMs.value = 60_001;
    const recovered = await subject.getStatus();
    expect(recovered.rpc.status).toBe("available");
    expect(recovered.rpc.head).not.toBeNull();
    expect(verifyChain).toHaveBeenCalledTimes(2);
  });

  it("shares one probe between concurrent calls and never remembers a failed one", async () => {
    const probe = deferred<readonly BscEndpointHealth[]>();
    let calls = 0;
    const primary = client({
      probeEndpoints: () => {
        calls += 1;
        return calls === 1
          ? probe.promise
          : calls === 2
            ? Promise.reject(new Error("probe failed"))
            : Promise.resolve([endpoint("2026-09-28T00:00:03.000Z")]);
      },
    });
    const clockMs = { value: 0 };
    const subject = service(primary, null, clockMs);
    const both = Promise.all([subject.getStatus(), subject.getStatus()]);
    await flush();
    probe.resolve([endpoint("2026-09-28T00:00:01.000Z")]);
    await both;
    expect(calls).toBe(1);

    clockMs.value = 60_000;
    await expect(subject.getStatus()).rejects.toThrow("probe failed");
    const after = await subject.getStatus();
    expect(calls).toBe(3);
    expect(after.rpc.endpoints[0]?.observedAt).toBe("2026-09-28T00:00:03.000Z");
  });

  it("probes every time with a zero window", async () => {
    const probeEndpoints = vi.fn(() =>
      Promise.resolve([endpoint("2026-09-28T00:00:00.000Z")]),
    );
    const primary = client({ probeEndpoints });
    const subject = createChainStatusService({
      ...repositories(),
      readClient: primary,
      launchReadClient: null,
      chainId: "eip155:56",
      chainName: "BNB Smart Chain",
      chainReference: 56,
      nativeAssetId: "eip155:56:native",
      observationTtlMs: 0,
    });
    await subject.getStatus();
    await subject.getStatus();
    expect(probeEndpoints).toHaveBeenCalledTimes(2);
  });
});
