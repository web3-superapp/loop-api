import { custom, HttpRequestError, numberToHex, type Transport } from "viem";
import { describe, expect, it } from "vitest";

import type { BscChainConfig } from "../src/config.js";
import {
  bscLogLimitRelaxAfterCleanReads,
  createBscReadClient,
  defaultBscLogAddressChunkSize,
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
  readonly addressCap?: number;
  /** More sub-topics in one position than this: -32602 "too many topics". */
  readonly topicCap?: number;
  /** More blocks than this: -32602 "block range too large". */
  readonly rangeCap?: bigint;
  /** Every eth_getLogs is refused as a rate objection (HTTP 429). */
  readonly throttled?: boolean;
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

  it("narrows on an earlier endpoint's shape refusal even when the last endpoint's error is a throttle", async () => {
    const reference = await unchunkedReference();
    // publicnode first, a quota-exhausted endpoint last: viem's fallback
    // rethrows the 429, but the 403 "Request blocked" decides the narrowing.
    const { client, stats } = clientWith(
      [{ addressCap: 8 }, { throttled: true }],
      100,
    );

    const transfers = await client.readTransferLogs(transferQuery());

    expect(transfers).toEqual(reference.transfers);
    expect(stats[0]?.refusals).toBe(1);
    // The quota endpoint saw only the one refused request, once.
    expect(stats[1]?.logRequests).toBe(1);
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
