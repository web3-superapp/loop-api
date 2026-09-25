import {
  custom,
  HttpRequestError,
  LimitExceededRpcError,
  numberToHex,
  RpcRequestError,
  type Transport,
} from "viem";
import { describe, expect, it } from "vitest";

import type { BscChainConfig } from "../src/config.js";
import {
  bscLogAddressLimitFloor,
  bscLogArchiveRequiredReasonCode,
  bscLogLimitRelaxAfterCleanReads,
  bscLogLimitRelaxMaximumCleanReads,
  bscLogRangeLimitFloor,
  bscLogTopicGroupLimitFloor,
  bscMaximumLogRequestsPerSegment,
  createBscReadClient,
  defaultBscLogAddressChunkSize,
  type BscLogQueryLimitsResetEvent,
  type BscReadClient,
} from "../src/integrations/bsc/rpc-client.js";

/**
 * Decision 0078: the narrowing order of a refused `eth_getLogs` request, the
 * configured address chunk, learned limits kept across reads, one attempt
 * per endpoint, and shape refusals attributed across the fallback list.
 *
 * The fixture chain is deterministic and in memory; every Provider policy
 * below mirrors one observed on 2026-09-25 (publicnode refuses more than 8
 * addresses with HTTP 403 / -32602 "Request blocked" whatever the topics or
 * span; go-ethereum refuses more than 1,000 sub-topics).
 */

const transferTopic =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const approvalTopic =
  "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const blockHash =
  "0x1111111111111111111111111111111111111111111111111111111111111111";

/** The eleven Asset Registry tokens of the development registry. */
const registryTokens = [
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
  "0x55d398326f99059ff775485246999027b3197955",
  "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c",
  "0x2170ed0880ac9a755fd29b2688956bd959f933f8",
  "0xba2ae424d960c26247dd6c32edc70b295c744c43",
  "0x1d2f0da169ceb9fc7b3144628db156f3f6c60dbe",
  "0x3ee2200efb3400fabb9aacf31297cbdd1d435d47",
  "0xf8a0bf9cf54bb92f17374d9e9a321e6a111a51bd",
  "0xbf5140a22578168fd562dccf235e5d43a02ce9b1",
  "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82",
  "0x7083609fce4d1d8dc0c979aab8c869ea2c873402",
] as const;
const wallets = Array.from(
  { length: 360 },
  (_, index) => `0x${(0xa11ce000 + index).toString(16).padStart(40, "0")}`,
);
const outsider = `0x${"e".repeat(40)}`;
const fromBlock = 44_000_000n;
const toBlock = fromBlock + 29n; // 30 blocks, head−30..head

interface ChainLog {
  readonly address: string;
  readonly topic0: string;
  readonly first: string;
  readonly second: string;
  readonly blockNumber: bigint;
  readonly logIndex: number;
}

function pad(address: string): string {
  return `0x000000000000000000000000${address.slice(2)}`;
}

/** A deterministic chain: per token and block, wallet and outsider traffic. */
function buildChain(): ChainLog[] {
  const logs: ChainLog[] = [];
  registryTokens.forEach((token, tokenIndex) => {
    for (let block = fromBlock; block <= toBlock; block += 1n) {
      const offset = Number(block - fromBlock);
      const base = tokenIndex * 10;
      const walletAt = (seed: number): string =>
        wallets[seed % wallets.length] ?? outsider;
      logs.push(
        {
          address: token,
          topic0: transferTopic,
          first: walletAt(tokenIndex * 37 + offset * 11),
          second: outsider,
          blockNumber: block,
          logIndex: base,
        },
        {
          address: token,
          topic0: transferTopic,
          first: outsider,
          second: walletAt(tokenIndex * 53 + offset * 7),
          blockNumber: block,
          logIndex: base + 1,
        },
        {
          // Wallet-to-wallet: matched by both sides, returned once.
          address: token,
          topic0: transferTopic,
          first: walletAt(tokenIndex * 5 + offset),
          second: walletAt(tokenIndex * 5 + offset + 200),
          blockNumber: block,
          logIndex: base + 2,
        },
        {
          // Outsider traffic the wallet scope must never return.
          address: token,
          topic0: transferTopic,
          first: outsider,
          second: outsider,
          blockNumber: block,
          logIndex: base + 3,
        },
        {
          address: token,
          topic0: approvalTopic,
          first: walletAt(tokenIndex * 17 + offset * 3),
          second: outsider,
          blockNumber: block,
          logIndex: base + 4,
        },
      );
    }
  });
  return logs;
}

const chain = buildChain();

interface LogFilter {
  readonly address?: string | readonly string[];
  readonly topics?: readonly (string | readonly string[] | null)[];
  readonly fromBlock: string;
  readonly toBlock: string;
}

function asList(value: string | readonly string[]): readonly string[] {
  return typeof value === "string" ? [value] : value;
}

function matcher(filter: LogFilter): (log: ChainLog) => boolean {
  const addresses =
    filter.address === undefined
      ? null
      : new Set(asList(filter.address).map((address) => address.toLowerCase()));
  const from = BigInt(filter.fromBlock);
  const to = BigInt(filter.toBlock);
  const positions = (filter.topics ?? []).map((position) =>
    position === null
      ? null
      : new Set(asList(position).map((topic) => topic.toLowerCase())),
  );
  return (log) => {
    if (addresses !== null && !addresses.has(log.address)) {
      return false;
    }
    if (log.blockNumber < from || log.blockNumber > to) {
      return false;
    }
    const values = [log.topic0, pad(log.first), pad(log.second)];
    return positions.every(
      (wanted, index) => wanted === null || wanted.has(values[index] ?? ""),
    );
  };
}

function rawLog(log: ChainLog): unknown {
  return {
    address: log.address,
    blockHash,
    blockNumber: numberToHex(log.blockNumber),
    data: numberToHex(1_000n, { size: 32 }),
    logIndex: numberToHex(BigInt(log.logIndex)),
    removed: false,
    topics: [log.topic0, pad(log.first), pad(log.second)],
    transactionHash: `0x${log.blockNumber.toString(16).padStart(60, "0")}${log.logIndex.toString(16).padStart(4, "0")}`,
    transactionIndex: "0x0",
  };
}

interface EndpointPolicy {
  /** More token addresses than this: HTTP 403 / -32602 "Request blocked". */
  readonly addressCap?: number | undefined;
  /** More sub-topics in one position than this: -32602 "too many topics". */
  readonly topicCap?: number;
  /** More blocks than this: -32602 "block range too large". */
  readonly rangeCap?: bigint;
  /** Every eth_getLogs is refused as a rate objection (HTTP 429). */
  readonly throttled?: boolean;
  /** The first N eth_getLogs are refused with HTTP 429, then served. */
  readonly throttleFirst?: number;
  /** More blocks than this: -32005 "limit exceeded" (names no dimension). */
  readonly unhintedRangeCap?: bigint;
  /** Every eth_getLogs is refused with -32005 "limit exceeded" (bsc-dataseed). */
  readonly limitExceeded?: boolean;
  /**
   * A switchable unhinted policy (-32005 "limit exceeded"): `floors` serves
   * only requests at or under the learned-limit floors, `singleBlock` only
   * one-block requests, `throttled` nothing (HTTP 429), `open` everything.
   */
  readonly mode?: { current: "floors" | "singleBlock" | "open" | "throttled" };
  /**
   * Age refusals observed 2026-09-25 (S82d): `publicnode` is mainnet's
   * HTTP 403 / -32602 "Archive requests require a personal token", `pruned`
   * the testnet's HTTP 200 / -32701 "History has been pruned for this
   * block". `off` serves normally.
   */
  readonly archive?: { current: "publicnode" | "pruned" | "off" };
}

interface EndpointStats {
  /** Every HTTP request the endpoint received, of any method. */
  requests: number;
  logRequests: number;
  refusals: number;
  readonly accepted: LogFilter[];
}

function fixtureEndpoint(policy: EndpointPolicy): {
  readonly transport: Transport;
  readonly stats: EndpointStats;
} {
  const stats: EndpointStats = {
    requests: 0,
    logRequests: 0,
    refusals: 0,
    accepted: [],
  };
  const transport = custom({
    request: ({
      method,
      params,
    }: {
      readonly method: string;
      readonly params?: unknown;
    }): Promise<unknown> => {
      stats.requests += 1;
      if (method === "eth_chainId") {
        return Promise.resolve("0x38");
      }
      if (method !== "eth_getLogs") {
        return Promise.reject(new Error(`unmocked ${method}`));
      }
      stats.logRequests += 1;
      const [filter] = params as readonly [LogFilter];
      const refuse = (error: Error): Promise<never> => {
        stats.refusals += 1;
        return Promise.reject(error);
      };
      const limitExceeded = (): Promise<never> =>
        refuse(new LimitExceededRpcError(new Error("limit exceeded")));
      if (
        policy.throttleFirst !== undefined &&
        stats.logRequests <= policy.throttleFirst
      ) {
        return refuse(
          new HttpRequestError({
            status: 429,
            url: "https://bsc-rpc.publicnode.com/",
            details: '{"code":-32005,"message":"too many requests"}',
          }),
        );
      }
      if (policy.archive?.current === "publicnode") {
        return refuse(
          new HttpRequestError({
            status: 403,
            url: "https://bsc-rpc.publicnode.com/",
            details:
              '{"jsonrpc":"2.0","error":{"code":-32602,"message":"Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode"},"id":1}',
          }),
        );
      }
      if (policy.archive?.current === "pruned") {
        return refuse(
          new RpcRequestError({
            body: { method: "eth_getLogs" },
            url: "https://bsc-testnet-rpc.publicnode.com/",
            error: {
              code: -32701,
              message:
                "History has been pruned for this block. To remove restrictions, order a dedicated full node here: https://www.allnodes.com/bnb/host",
            },
          }),
        );
      }
      if (policy.limitExceeded === true) {
        return limitExceeded();
      }
      const span = BigInt(filter.toBlock) - BigInt(filter.fromBlock) + 1n;
      if (
        policy.unhintedRangeCap !== undefined &&
        span > policy.unhintedRangeCap
      ) {
        return limitExceeded();
      }
      if (policy.mode?.current === "throttled") {
        return refuse(
          new HttpRequestError({
            status: 429,
            url: "https://bsc-rpc.publicnode.com/",
            details: '{"code":-32005,"message":"Rate limit exceeded"}',
          }),
        );
      }
      if (policy.mode?.current === "singleBlock" && span > 1n) {
        return limitExceeded();
      }
      if (policy.mode?.current === "floors") {
        const addressCount =
          filter.address === undefined ? 0 : asList(filter.address).length;
        const widestTopic = Math.max(
          0,
          ...(filter.topics ?? [])
            .slice(1)
            .map((position) =>
              position === null ? 0 : asList(position).length,
            ),
        );
        if (
          addressCount > bscLogAddressLimitFloor ||
          widestTopic > bscLogTopicGroupLimitFloor ||
          span > bscLogRangeLimitFloor
        ) {
          return limitExceeded();
        }
      }
      if (policy.throttled === true) {
        return refuse(
          new HttpRequestError({
            status: 429,
            url: "https://quota.example/",
            details: '{"code":-32005,"message":"rate limit exceeded"}',
          }),
        );
      }
      const addressCount =
        filter.address === undefined ? 0 : asList(filter.address).length;
      if (policy.addressCap !== undefined && addressCount > policy.addressCap) {
        return refuse(
          new HttpRequestError({
            status: 403,
            url: "https://bsc-rpc.publicnode.com/",
            details: '{"code":-32602,"message":"Request blocked"}',
          }),
        );
      }
      const topicCap = policy.topicCap ?? 1_000;
      if (
        (filter.topics ?? []).some(
          (position) => position !== null && asList(position).length > topicCap,
        )
      ) {
        return refuse(
          Object.assign(new Error("too many topics"), { code: -32602 }),
        );
      }
      if (
        policy.rangeCap !== undefined &&
        BigInt(filter.toBlock) - BigInt(filter.fromBlock) + 1n > policy.rangeCap
      ) {
        return refuse(
          Object.assign(new Error("block range too large"), { code: -32602 }),
        );
      }
      stats.accepted.push(filter);
      return Promise.resolve(chain.filter(matcher(filter)).map(rawLog));
    },
  });
  return { transport, stats };
}

function chainConfig(
  rpcUrls: readonly string[],
  logAddressChunkSize: number = defaultBscLogAddressChunkSize,
): BscChainConfig {
  return Object.freeze({
    chainId: "eip155:56" as const,
    chainReference: 56 as const,
    rpcUrls: Object.freeze([...rpcUrls]),
    confirmations: 15,
    reorgDepthBlocks: 64,
    logAddressChunkSize,
    usd1TokenAddress: null,
  });
}

function clientWith(
  policies: readonly EndpointPolicy[],
  logAddressChunkSize?: number,
  onLogQueryLimitsReset?: (event: BscLogQueryLimitsResetEvent) => void,
): { readonly client: BscReadClient; readonly stats: EndpointStats[] } {
  const endpoints = policies.map((policy) => fixtureEndpoint(policy));
  const urls = policies.map((_, index) => `https://rpc-${String(index)}.test/`);
  const client = createBscReadClient({
    config: chainConfig(urls, logAddressChunkSize),
    transportFactory: (url) => {
      const endpoint = endpoints[urls.indexOf(url)];
      if (endpoint === undefined) {
        throw new Error("unknown fixture endpoint");
      }
      return endpoint.transport;
    },
    ...(onLogQueryLimitsReset === undefined ? {} : { onLogQueryLimitsReset }),
  });
  return { client, stats: endpoints.map((endpoint) => endpoint.stats) };
}

function totalRequests(stats: readonly EndpointStats[]): number {
  return stats.reduce((sum, endpoint) => sum + endpoint.requests, 0);
}

const walletFilter = { walletAddresses: wallets, topicChunkSize: 200 };

function transferQuery(addresses: readonly string[] = registryTokens) {
  return { addresses, fromBlock, toBlock, walletFilter };
}

/** The same reads against an endpoint without any cap, in one request per side. */
async function unchunkedReference() {
  const { client } = clientWith([{}], 100);
  const query = {
    addresses: registryTokens,
    fromBlock,
    toBlock,
    walletFilter: { walletAddresses: wallets, topicChunkSize: 1_000 },
  };
  return {
    transfers: await client.readTransferLogs(query),
    approvals: await client.readApprovalLogs(query),
  };
}

describe("eth_getLogs narrowing order (Decision 0078)", () => {
  it("reads 11 tokens × 360 wallets × 30 blocks within 12 HTTP requests per read, equal to the unchunked read", async () => {
    const reference = await unchunkedReference();
    // Sanity: the fixture chain has wallet traffic on every side.
    expect(reference.transfers.length).toBeGreaterThan(600);
    expect(reference.approvals.length).toBe(registryTokens.length * 30);

    const { client, stats } = clientWith([{ addressCap: 8 }]);

    const transfers = await client.readTransferLogs(transferQuery());
    // eth_chainId once, then 2 sides × 2 wallet chunks × 2 token chunks.
    expect(totalRequests(stats)).toBe(9);
    expect(totalRequests(stats)).toBeLessThanOrEqual(12);
    expect(stats[0]?.refusals).toBe(0);
    expect(transfers).toEqual(reference.transfers);

    const before = totalRequests(stats);
    const approvals = await client.readApprovalLogs(transferQuery());
    // `owner ∈ W` only: 2 wallet chunks × 2 token chunks.
    expect(totalRequests(stats) - before).toBe(4);
    expect(approvals).toEqual(reference.approvals);

    // No accepted request ever carried more than the configured 8 tokens.
    for (const filter of stats[0]?.accepted ?? []) {
      expect(asList(filter.address ?? []).length).toBeLessThanOrEqual(8);
    }
  });

  it("learns a tighter address cap from one refusal and reuses it on the next read", async () => {
    const reference = await unchunkedReference();
    // The operator allowed 100 tokens per request; the Provider allows 8.
    const { client, stats } = clientWith([{ addressCap: 8 }], 100);

    const first = await client.readTransferLogs(transferQuery());
    const firstRequests = totalRequests(stats);
    // One refusal (11 → 6), then 6 + 5 on every chunk: 1 + 1 + 2×2×2 = 10.
    expect(stats[0]?.refusals).toBe(1);
    expect(firstRequests).toBe(10);
    expect(first).toEqual(reference.transfers);

    const second = await client.readTransferLogs(transferQuery());
    const secondRequests = totalRequests(stats) - firstRequests;
    // Straight out at the learned cap: no refusal, fewer requests.
    expect(stats[0]?.refusals).toBe(1);
    expect(secondRequests).toBe(8);
    expect(secondRequests).toBeLessThan(firstRequests);
    expect(second).toEqual(reference.transfers);
  });

  it("does not re-probe a learned cap on every read, and never probes past the configured chunk", async () => {
    // A small wallet set keeps this many reads fast; the shape is the same.
    const smallQuery = {
      addresses: registryTokens,
      fromBlock,
      toBlock,
      walletFilter: {
        walletAddresses: wallets.slice(0, 10),
        topicChunkSize: 200,
      },
    };
    const { client, stats } = clientWith([{ addressCap: 8 }], 100);
    await client.readTransferLogs(smallQuery);
    expect(stats[0]?.refusals).toBe(1);
    // Each wallet-scoped transfer read is two segment reads (from, to); the
    // first read's `to` side already counted one clean read.
    const readsBeforeProbe = bscLogLimitRelaxAfterCleanReads / 2 - 1;
    for (let read = 0; read < readsBeforeProbe; read += 1) {
      await client.readTransferLogs(smallQuery);
    }
    expect(stats[0]?.refusals).toBe(1);
    // The streak completes on the next read's `from` side; its `to` side
    // probes 12 tokens once, is refused once, and learns 6 again.
    await client.readTransferLogs(smallQuery);
    expect(stats[0]?.refusals).toBe(2);

    // With the default chunk equal to the Provider cap, probing is a no-op.
    const capped = clientWith([{ addressCap: 8 }]);
    for (let read = 0; read < bscLogLimitRelaxAfterCleanReads * 2; read += 1) {
      await capped.client.readTransferLogs(smallQuery);
    }
    expect(capped.stats[0]?.refusals).toBe(0);
  });

  it("narrows the topic array when the refusal names topics, never the tokens or the range", async () => {
    const reference = await unchunkedReference();
    const { client, stats } = clientWith([{ addressCap: 8, topicCap: 150 }]);

    const transfers = await client.readTransferLogs(transferQuery());

    expect(transfers).toEqual(reference.transfers);
    // 200 → 100 learned once; 160 → 100 + 60 afterwards.
    expect(stats[0]?.refusals).toBe(1);
    for (const filter of stats[0]?.accepted ?? []) {
      expect(BigInt(filter.toBlock) - BigInt(filter.fromBlock) + 1n).toBe(30n);
    }
  });

  it("still halves the block range when the refusal names the range", async () => {
    const reference = await unchunkedReference();
    const { client, stats } = clientWith([{ addressCap: 8, rangeCap: 10n }]);

    const transfers = await client.readTransferLogs(transferQuery());

    expect(transfers).toEqual(reference.transfers);
    const accepted = stats[0]?.accepted ?? [];
    expect(accepted.length).toBeGreaterThan(0);
    for (const filter of accepted) {
      expect(
        BigInt(filter.toBlock) - BigInt(filter.fromBlock) + 1n,
      ).toBeLessThanOrEqual(10n);
      // The refusal named the range, so tokens stay at the configured chunk.
      expect([8, 3]).toContain(asList(filter.address ?? []).length);
    }
    // 30 → 15 → 8 learned in two refusals, then applied without another.
    expect(stats[0]?.refusals).toBe(2);
    // The refusal named the range, so the kept limit may go below the
    // 500-block floor (Decision 0079).
    expect(client.logQueryLimits?.().learnedRangeLimit).toBe(8);
  });

  it("propagates a throttle unchanged after one attempt per endpoint, never narrowing", async () => {
    const { client, stats } = clientWith([
      { throttled: true },
      { throttled: true },
    ]);

    await expect(
      client.readTransferLogs(transferQuery()),
    ).rejects.toMatchObject({ name: "HttpRequestError", status: 429 });

    // One eth_getLogs per endpoint: no whole-chain retry, no split.
    expect(stats.map((endpoint) => endpoint.logRequests)).toEqual([1, 1]);
  });

  it("treats a throttle from the last endpoint as a throttle even when an earlier endpoint refused the shape (Decision 0079 amends 0078 rule 5)", async () => {
    // publicnode first, a quota-exhausted endpoint last. Decision 0078
    // narrowed on the 403; Decision 0079 lets the 429 win: the rate
    // objection is temporary and narrowing would spend the quota faster.
    const { client, stats } = clientWith(
      [{ addressCap: 8 }, { throttled: true }],
      100,
    );
    const before = client.logQueryLimits?.();

    await expect(
      client.readTransferLogs(transferQuery()),
    ).rejects.toMatchObject({ name: "HttpRequestError", status: 429 });

    expect(stats[0]?.refusals).toBe(1);
    expect(stats[1]?.logRequests).toBe(1);
    // Nothing was learned from the 403 that came with the throttle.
    expect(client.logQueryLimits?.().learnedAddressLimit).toBe(
      before?.learnedAddressLimit,
    );
  });

  it("costs one attempt per endpoint for a refused request, not four passes over the list", async () => {
    const { client, stats } = clientWith(
      [{ addressCap: 8 }, { addressCap: 8 }],
      100,
    );

    await client.readTransferLogs(transferQuery());

    // One refusal of the 11-token request on each endpoint, then every
    // narrowed request is served by the first endpoint.
    expect(stats.map((endpoint) => endpoint.refusals)).toEqual([1, 1]);
    expect(stats[1]?.logRequests).toBe(1);
  });
});

/** Two thousand blocks from the fixture chain's first block: a full segment. */
const wideQuery = {
  addresses: registryTokens,
  fromBlock,
  toBlock: fromBlock + 1_999n,
  walletFilter,
};
const configuredLimits = {
  learnedAddressLimit: defaultBscLogAddressChunkSize,
  learnedTopicGroupLimit: 200,
  learnedRangeLimit: 2_000,
  relaxAfterCleanReads: bscLogLimitRelaxAfterCleanReads,
};
const floorLimits = {
  learnedAddressLimit: bscLogAddressLimitFloor,
  learnedTopicGroupLimit: bscLogTopicGroupLimitFloor,
  learnedRangeLimit: Number(bscLogRangeLimitFloor),
  relaxAfterCleanReads: bscLogLimitRelaxAfterCleanReads,
};

describe("learned-limit floors, throttle priority, and reset (Decision 0079)", () => {
  it("does not narrow when one endpoint throttles and the other refuses every request: the lane gets the throttle", async () => {
    const reference = await unchunkedReference();
    // The 2026-09-25 incident: publicnode rate-limited for a while, and
    // bsc-dataseed answering every eth_getLogs with -32005.
    const resets: BscLogQueryLimitsResetEvent[] = [];
    const { client, stats } = clientWith(
      [{ addressCap: 8, throttleFirst: 3 }, { limitExceeded: true }],
      undefined,
      (event) => resets.push(event),
    );

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        client.readApprovalLogs(transferQuery()),
      ).rejects.toMatchObject({ name: "HttpRequestError", status: 429 });
      expect(client.logQueryLimits?.()).toEqual(configuredLimits);
    }
    // One request per attempt reached each endpoint: no split, no narrowing.
    expect(stats[0]?.logRequests).toBe(3);
    expect(stats[1]?.logRequests).toBe(3);

    // publicnode recovers: the read goes out at the configured shape.
    const approvals = await client.readApprovalLogs(transferQuery());
    expect(approvals).toEqual(reference.approvals);
    expect(stats[0]?.logRequests).toBe(3 + 4);
    expect(stats[1]?.logRequests).toBe(3);
    expect(client.logQueryLimits?.()).toEqual(configuredLimits);
    // Nothing was narrowed, so the throttles reset nothing either.
    expect(resets).toEqual([]);
  });

  it("resets narrowed limits when a throttle aborts a read, so a rate-limited lane does not grind at the floors", async () => {
    const mode: {
      current: "floors" | "singleBlock" | "open" | "throttled";
    } = { current: "floors" };
    const resets: BscLogQueryLimitsResetEvent[] = [];
    const { client, stats } = clientWith([{ mode }], undefined, (event) =>
      resets.push(event),
    );
    await client.readApprovalLogs(wideQuery);
    expect(client.logQueryLimits?.()).toEqual(floorLimits);

    mode.current = "throttled";
    await expect(client.readApprovalLogs(wideQuery)).rejects.toMatchObject({
      name: "HttpRequestError",
      status: 429,
    });
    expect(resets).toEqual([
      {
        reasonCode: "BSC_LOG_LIMITS_RESET",
        trigger: "BSC_LOG_QUERY_THROTTLED",
        before: floorLimits,
        after: configuredLimits,
      },
    ]);
    // Throttled again at the configured shape: nothing left to reset.
    await expect(client.readApprovalLogs(wideQuery)).rejects.toMatchObject({
      status: 429,
    });
    expect(resets).toHaveLength(1);

    mode.current = "open";
    const before = stats[0]?.logRequests ?? 0;
    await client.readApprovalLogs(wideQuery);
    expect((stats[0]?.logRequests ?? 0) - before).toBe(4);
  });

  it("keeps unhinted narrowing at the floors, finishes a segment there, and climbs back after clean reads", async () => {
    const reference = await unchunkedReference();
    const mode: { current: "floors" | "singleBlock" | "open" | "throttled" } = {
      current: "floors",
    };
    const { client, stats } = clientWith([{ mode }]);

    const first = await client.readApprovalLogs(wideQuery);
    expect(first).toEqual(reference.approvals);
    expect(client.logQueryLimits?.()).toEqual(floorLimits);
    // 8→4→2→1 addresses (pre-split at the configured 8), 200→100 wallets,
    // 2000→1000→500 blocks: one refusal per halving, none below a floor.
    expect(stats[0]?.refusals).toBe(3 + 1 + 2);

    // At the floors a segment is 11 tokens × 4 wallet arrays × 4 ranges.
    const atFloors = stats[0]?.logRequests ?? 0;
    await client.readApprovalLogs(wideQuery);
    expect((stats[0]?.logRequests ?? 0) - atFloors).toBe(176);
    expect(176).toBeLessThan(bscMaximumLogRequestsPerSegment);

    // The Provider stops refusing: every 4 clean reads double each limit.
    mode.current = "open";
    const cleanReads = async (count: number): Promise<void> => {
      for (let read = 0; read < count; read += 1) {
        await client.readApprovalLogs(wideQuery);
      }
    };
    await cleanReads(bscLogLimitRelaxAfterCleanReads - 1);
    expect(client.logQueryLimits?.()).toEqual({
      ...configuredLimits,
      learnedAddressLimit: 2,
      learnedTopicGroupLimit: 200,
      learnedRangeLimit: 1_000,
    });
    await cleanReads(bscLogLimitRelaxAfterCleanReads);
    expect(client.logQueryLimits?.()).toEqual({
      ...configuredLimits,
      learnedAddressLimit: 4,
    });
    await cleanReads(bscLogLimitRelaxAfterCleanReads);
    expect(client.logQueryLimits?.()).toEqual(configuredLimits);
    const refusals = stats[0]?.refusals;
    const before = stats[0]?.logRequests ?? 0;
    await client.readApprovalLogs(wideQuery);
    expect((stats[0]?.logRequests ?? 0) - before).toBe(4);
    expect(stats[0]?.refusals).toBe(refusals);
  });

  it("narrows below a floor for the read in flight only when the refusal names no dimension", async () => {
    const { client, stats } = clientWith([{ unhintedRangeCap: 100n }]);
    const query = {
      addresses: [registryTokens[0]],
      fromBlock,
      toBlock: fromBlock + 1_999n,
    };

    await client.readTransferLogs(query);
    // 2000 → 1000 → 500 kept; 500 → 250 → 125 → 63 for this read only.
    expect(stats[0]?.refusals).toBe(5);
    expect(client.logQueryLimits?.().learnedRangeLimit).toBe(500);

    await client.readTransferLogs(query);
    // The next read starts at the kept floor: 500 → 250 → 125 → 63 again.
    expect(stats[0]?.refusals).toBe(5 + 3);
    expect(client.logQueryLimits?.().learnedRangeLimit).toBe(500);
  });

  it("resets the learned limits and reports BSC_LOG_LIMITS_RESET when a read runs out of budget", async () => {
    const mode: { current: "floors" | "singleBlock" | "open" | "throttled" } = {
      current: "singleBlock",
    };
    const resets: BscLogQueryLimitsResetEvent[] = [];
    const { client, stats } = clientWith([{ mode }], undefined, (event) =>
      resets.push(event),
    );

    await expect(client.readApprovalLogs(wideQuery)).rejects.toMatchObject({
      name: "BscReadUnavailableError",
      reasonCode: "BSC_LOG_QUERY_BUDGET_EXHAUSTED",
    });
    expect(stats[0]?.logRequests).toBe(bscMaximumLogRequestsPerSegment);
    expect(resets).toEqual([
      {
        reasonCode: "BSC_LOG_LIMITS_RESET",
        trigger: "BSC_LOG_QUERY_BUDGET_EXHAUSTED",
        before: floorLimits,
        after: configuredLimits,
      },
    ]);
    expect(client.logQueryLimits?.()).toEqual(configuredLimits);

    // The next segment probes from the top instead of the narrowest shape.
    mode.current = "open";
    const before = stats[0]?.logRequests ?? 0;
    await client.readApprovalLogs(wideQuery);
    expect((stats[0]?.logRequests ?? 0) - before).toBe(4);
  });

  it("rolls a refused probe back and doubles the streak before the next one, up to 32; a probe that holds restores 4", async () => {
    const smallQuery = {
      addresses: registryTokens,
      fromBlock,
      toBlock,
      walletFilter: {
        walletAddresses: wallets.slice(0, 10),
        topicChunkSize: 200,
      },
    };
    const policy: { addressCap: number | undefined } = { addressCap: 8 };
    const { client, stats } = clientWith([policy], 100);
    const limits = () => client.logQueryLimits?.();
    const cleanReads = async (count: number): Promise<void> => {
      const refusals = stats[0]?.refusals;
      for (let read = 0; read < count; read += 1) {
        await client.readApprovalLogs(smallQuery);
      }
      expect(stats[0]?.refusals).toBe(refusals);
    };

    await client.readApprovalLogs(smallQuery);
    expect(stats[0]?.refusals).toBe(1);
    expect(limits()?.learnedAddressLimit).toBe(6);

    let streak = bscLogLimitRelaxAfterCleanReads;
    const thresholds: number[] = [];
    for (let probe = 0; probe < 4; probe += 1) {
      await cleanReads(streak);
      // Widened to 12 tokens: the probe read is refused once and rolled back.
      expect(limits()?.learnedAddressLimit).toBe(12);
      const refusals = stats[0]?.refusals ?? 0;
      await client.readApprovalLogs(smallQuery);
      expect(stats[0]?.refusals).toBe(refusals + 1);
      expect(limits()?.learnedAddressLimit).toBe(6);
      streak = limits()?.relaxAfterCleanReads ?? 0;
      thresholds.push(streak);
    }
    expect(thresholds).toEqual([8, 16, 32, bscLogLimitRelaxMaximumCleanReads]);

    // The Provider lifts its cap: the next probe holds and the base returns.
    policy.addressCap = undefined;
    await cleanReads(streak);
    expect(limits()?.learnedAddressLimit).toBe(12);
    await cleanReads(1);
    expect(limits()?.relaxAfterCleanReads).toBe(
      bscLogLimitRelaxAfterCleanReads,
    );
  });

  it("shares learned limits between the transfer and pool lanes, and a reset from one lane frees the other", async () => {
    const mode: { current: "floors" | "singleBlock" | "open" | "throttled" } = {
      current: "floors",
    };
    const resets: BscLogQueryLimitsResetEvent[] = [];
    const { client, stats } = clientWith([{ mode }], undefined, (event) =>
      resets.push(event),
    );

    // The erc20_transfer lane narrows the shared client to its floors.
    await client.readApprovalLogs(wideQuery);
    expect(client.logQueryLimits?.()).toEqual(floorLimits);

    // The pool_event lane then runs out of budget on the same client.
    mode.current = "singleBlock";
    await expect(
      client.readPoolEventLogs({
        addresses: registryTokens,
        fromBlock,
        toBlock: fromBlock + 1_999n,
      }),
    ).rejects.toMatchObject({
      reasonCode: "BSC_LOG_QUERY_BUDGET_EXHAUSTED",
    });
    expect(resets).toHaveLength(1);
    expect(client.logQueryLimits?.()).toEqual(configuredLimits);

    // Both lanes go out at the configured shape again.
    mode.current = "open";
    let before = stats[0]?.logRequests ?? 0;
    await client.readApprovalLogs(wideQuery);
    expect((stats[0]?.logRequests ?? 0) - before).toBe(4);
    before = stats[0]?.logRequests ?? 0;
    await client.readPoolEventLogs({
      addresses: registryTokens,
      fromBlock,
      toBlock: fromBlock + 1_999n,
    });
    expect((stats[0]?.logRequests ?? 0) - before).toBe(2);
  });
});

describe("archive refusals are a third class (Decision 0079, S82d)", () => {
  it("fails a publicnode archive refusal closed at once: no narrowing, learned limits unchanged, reason code BSC_LOG_ARCHIVE_REQUIRED", async () => {
    const archive = { current: "off" as "publicnode" | "pruned" | "off" };
    const resets: BscLogQueryLimitsResetEvent[] = [];
    const { client, stats } = clientWith(
      [{ addressCap: 8, archive }],
      100,
      (event) => resets.push(event),
    );
    // Learn the 8-address cap first so there is a narrowed value to keep.
    await client.readTransferLogs(transferQuery());
    const learned = client.logQueryLimits?.();
    expect(learned?.learnedAddressLimit).toBeLessThan(100);

    archive.current = "publicnode";
    const before = stats[0]?.logRequests ?? 0;
    await expect(
      client.readTransferLogs(transferQuery()),
    ).rejects.toMatchObject({
      name: "BscReadUnavailableError",
      reasonCode: bscLogArchiveRequiredReasonCode,
      rpcError: { rpcStatus: 403, rpcCode: -32602 },
    });
    // One request: the refusal is not narrowed along any dimension.
    expect((stats[0]?.logRequests ?? 0) - before).toBe(1);
    expect(client.logQueryLimits?.()).toEqual(learned);
    expect(resets).toEqual([]);
  });

  it("classifies the pruned-history wording the same way, with -32701 in an HTTP 200 body", async () => {
    const { client, stats } = clientWith([{ archive: { current: "pruned" } }]);
    const initial = client.logQueryLimits?.();
    await expect(
      client.readPoolEventLogs({
        addresses: registryTokens.slice(0, 2),
        fromBlock,
        toBlock,
      }),
    ).rejects.toMatchObject({
      reasonCode: bscLogArchiveRequiredReasonCode,
      rpcError: { rpcCode: -32701 },
    });
    expect(stats[0]?.logRequests).toBe(1);
    expect(client.logQueryLimits?.()).toEqual(initial);
  });

  it("still narrows when another endpoint of the same request refuses the shape", async () => {
    const reference = await unchunkedReference();
    const { client } = clientWith(
      [{ archive: { current: "publicnode" } }, { addressCap: 8 }],
      100,
    );
    // The second endpoint answers once the request is narrowed for it.
    const transfers = await client.readTransferLogs(transferQuery());
    expect(transfers).toEqual(reference.transfers);
    expect(client.logQueryLimits?.().learnedAddressLimit).toBeLessThanOrEqual(
      8,
    );
  });
});
