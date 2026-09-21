import {
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  LimitExceededRpcError,
  multicall3Abi,
  numberToHex,
  type Transport,
} from "viem";
import { describe, expect, it, vi } from "vitest";

import type { BscChainConfig } from "../src/config.js";
import {
  erc20BalanceAbi,
  erc20IdentityAbi,
} from "../src/integrations/bsc/erc20-abi.js";
import {
  BscChainMismatchError,
  BscReadUnavailableError,
  createBscReadClient,
  createUnavailableBscReadClient,
  endpointLabelFor,
  endpointRefFor,
} from "../src/integrations/bsc/rpc-client.js";
import { createChainVerificationWatch } from "../src/integrations/bsc/chain-verification-watch.js";

/**
 * Every case here drives the real viem client through an in-memory transport.
 * No test opens a network connection, and no fixture is allowed to stand in
 * for a chain fact the client did not actually decode.
 */

const wbnb = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const owner = "0x00000000000000000000000000000000000000a1";
const headNumber = 44_000_000n;
const headHash =
  "0x1111111111111111111111111111111111111111111111111111111111111111";

function chainConfig(overrides: Partial<BscChainConfig> = {}): BscChainConfig {
  return Object.freeze({
    chainId: "eip155:56" as const,
    chainReference: 56 as const,
    rpcUrls: Object.freeze([
      "https://rpc-a.example/",
      "https://rpc-b.example/",
    ]),
    confirmations: 15,
    reorgDepthBlocks: 64,
    usd1TokenAddress: null,
    ...overrides,
  });
}

function blockResponse(blockNumber: bigint, hash: string): unknown {
  return {
    number: numberToHex(blockNumber),
    hash,
    parentHash:
      "0x2222222222222222222222222222222222222222222222222222222222222222",
    timestamp: numberToHex(1_760_000_000n),
    gasLimit: "0x1c9c380",
    gasUsed: "0x5208",
    baseFeePerGas: "0x3b9aca00",
    miner: "0x0000000000000000000000000000000000000001",
    extraData: "0x",
    size: "0x100",
    difficulty: "0x0",
    totalDifficulty: "0x0",
    nonce: "0x0000000000000000",
    logsBloom: `0x${"0".repeat(512)}`,
    transactionsRoot:
      "0x3333333333333333333333333333333333333333333333333333333333333333",
    stateRoot:
      "0x4444444444444444444444444444444444444444444444444444444444444444",
    receiptsRoot:
      "0x5555555555555555555555555555555555555555555555555555555555555555",
    sha3Uncles:
      "0x6666666666666666666666666666666666666666666666666666666666666666",
    transactions: [],
    uncles: [],
  };
}

interface RpcRequest {
  readonly method: string;
  readonly params?: unknown;
}

/**
 * Decodes an aggregate3 batch and answers each inner ERC-20 call, so the test
 * exercises viem's real multicall encoding and decoding path.
 */
function answerMulticall(data: `0x${string}`): `0x${string}` {
  const decoded = decodeFunctionData({ abi: multicall3Abi, data });
  if (decoded.functionName !== "aggregate3") {
    throw new Error("unexpected multicall function");
  }
  const calls = decoded.args[0];
  const results = calls.map((call) => {
    const selector = call.callData.slice(0, 10);
    switch (selector) {
      case "0x95d89b41": {
        return {
          success: true,
          returnData: encodeFunctionResult({
            abi: erc20IdentityAbi,
            functionName: "symbol",
            result: "WBNB",
          }),
        };
      }
      case "0x06fdde03": {
        return {
          success: true,
          returnData: encodeFunctionResult({
            abi: erc20IdentityAbi,
            functionName: "name",
            result: "Wrapped BNB",
          }),
        };
      }
      case "0x313ce567": {
        return {
          success: true,
          returnData: encodeFunctionResult({
            abi: erc20IdentityAbi,
            functionName: "decimals",
            result: 18,
          }),
        };
      }
      case "0x70a08231": {
        return {
          success: true,
          returnData: encodeFunctionResult({
            abi: erc20BalanceAbi,
            functionName: "balanceOf",
            result: 123_456_789_000_000_000n,
          }),
        };
      }
      default: {
        return { success: false, returnData: "0x" as const };
      }
    }
  });
  return encodeFunctionResult({
    abi: multicall3Abi,
    functionName: "aggregate3",
    result: results,
  });
}

function chainTransport(options: {
  readonly chainId?: string;
  readonly logs?: readonly unknown[];
  readonly failMethods?: ReadonlySet<string>;
  readonly onRequest?: (request: RpcRequest) => void;
}): Transport {
  return custom({
    request: (request: RpcRequest): Promise<unknown> => {
      options.onRequest?.(request);
      if (options.failMethods?.has(request.method) === true) {
        return Promise.reject(new Error("endpoint unavailable"));
      }
      switch (request.method) {
        case "eth_chainId": {
          return Promise.resolve(options.chainId ?? "0x38");
        }
        case "eth_getBlockByNumber": {
          const params = request.params as readonly [string, boolean];
          const tag = params[0];
          return Promise.resolve(
            tag === "latest"
              ? blockResponse(headNumber, headHash)
              : blockResponse(BigInt(tag), headHash),
          );
        }
        case "eth_blockNumber": {
          return Promise.resolve(numberToHex(headNumber));
        }
        case "eth_getBalance": {
          return Promise.resolve(numberToHex(7_000_000_000_000_000_000n));
        }
        case "eth_call": {
          const params = request.params as readonly [
            { readonly data: `0x${string}` },
          ];
          return Promise.resolve(answerMulticall(params[0].data));
        }
        case "eth_getLogs": {
          return Promise.resolve(options.logs ?? []);
        }
        default: {
          return Promise.reject(new Error(`unmocked ${request.method}`));
        }
      }
    },
  });
}

describe("BSC read client", () => {
  it("verifies the chain ID once and caches the verified state", async () => {
    const onRequest = vi.fn();
    const client = createBscReadClient({
      config: chainConfig(),
      transportFactory: () => chainTransport({ onRequest }),
    });

    await expect(client.verifyChain()).resolves.toBe("verified");
    await expect(client.verifyChain()).resolves.toBe("verified");

    const chainIdCalls = onRequest.mock.calls.filter(
      ([request]) => (request as RpcRequest).method === "eth_chainId",
    );
    expect(chainIdCalls).toHaveLength(1);
  });

  it("fails closed when the endpoint serves another chain", async () => {
    const client = createBscReadClient({
      config: chainConfig(),
      transportFactory: () => chainTransport({ chainId: "0x1" }),
    });

    await expect(client.verifyChain()).resolves.toBe("mismatched");
    await expect(client.getHead()).rejects.toBeInstanceOf(
      BscChainMismatchError,
    );
    await expect(client.readTokenIdentity(wbnb)).rejects.toBeInstanceOf(
      BscChainMismatchError,
    );
  });

  it("reports an unreachable endpoint without claiming a verified chain", async () => {
    const client = createBscReadClient({
      config: chainConfig(),
      transportFactory: () =>
        chainTransport({ failMethods: new Set(["eth_chainId"]) }),
    });

    await expect(client.verifyChain()).resolves.toBe("unreachable");
    await expect(client.getHead()).rejects.toBeInstanceOf(
      BscReadUnavailableError,
    );
  });

  it("reads the head and the token identity from chain calls only", async () => {
    const client = createBscReadClient({
      config: chainConfig(),
      transportFactory: () => chainTransport({}),
    });

    const head = await client.getHead();
    expect(head.blockNumber).toBe(headNumber);
    expect(head.blockHash).toBe(headHash);

    await expect(client.readTokenIdentity(wbnb)).resolves.toEqual({
      symbol: "WBNB",
      name: "Wrapped BNB",
      decimals: 18,
    });
  });

  it("decodes multicall token balances and the native balance at one block", async () => {
    const client = createBscReadClient({
      config: chainConfig(),
      transportFactory: () => chainTransport({}),
    });

    const result = await client.readBalances(owner, [
      { assetId: `eip155:56:${wbnb}`, address: wbnb },
      { assetId: "eip155:56:native", address: null },
    ]);

    expect(result.head.blockNumber).toBe(headNumber);
    expect(result.balances).toEqual([
      {
        assetId: `eip155:56:${wbnb}`,
        rawValue: 123_456_789_000_000_000n,
        reasonCode: null,
      },
      {
        assetId: "eip155:56:native",
        rawValue: 7_000_000_000_000_000_000n,
        reasonCode: null,
      },
    ]);
  });

  it("issues the token multicall and the native read together, at the head block", async () => {
    const started: string[] = [];
    let releaseBalance: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      releaseBalance = resolve;
    });
    const client = createBscReadClient({
      config: chainConfig(),
      transportFactory: () =>
        custom({
          request: async (request: RpcRequest): Promise<unknown> => {
            started.push(request.method);
            switch (request.method) {
              case "eth_chainId": {
                return "0x38";
              }
              case "eth_getBlockByNumber": {
                return blockResponse(headNumber, headHash);
              }
              case "eth_getBalance": {
                // The native read is answered only once the multicall has
                // also been issued, which one after the other cannot do.
                await held;
                return numberToHex(7_000_000_000_000_000_000n);
              }
              case "eth_call": {
                releaseBalance?.();
                const params = request.params as readonly [
                  { readonly data: `0x${string}` },
                ];
                return answerMulticall(params[0].data);
              }
              default: {
                throw new Error(`unmocked ${request.method}`);
              }
            }
          },
        }),
    });

    const result = await client.readBalances(owner, [
      { assetId: `eip155:56:${wbnb}`, address: wbnb },
      { assetId: "eip155:56:native", address: null },
    ]);

    expect(result.balances.map((balance) => balance.rawValue)).toEqual([
      123_456_789_000_000_000n,
      7_000_000_000_000_000_000n,
    ]);
    expect(
      started.filter((method) => method === "eth_getBlockByNumber"),
    ).toHaveLength(1);
  });

  it("gives point reads a shorter per-endpoint budget than range scans", async () => {
    const budgets: { readonly url: string; readonly timeoutMs: number }[] = [];
    const client = createBscReadClient({
      config: chainConfig(),
      transportFactory: (url, options) => {
        budgets.push({ url, timeoutMs: options.timeoutMs });
        return chainTransport({});
      },
    });

    await client.getHead();

    const distinct = [...new Set(budgets.map((entry) => entry.timeoutMs))];
    expect(distinct.sort((left, right) => left - right)).toEqual([
      2_500, 6_000,
    ]);
    // Both lanes carry every configured endpoint, in the configured order.
    for (const timeoutMs of distinct) {
      const urls = budgets
        .filter((entry) => entry.timeoutMs === timeoutMs)
        .map((entry) => entry.url);
      expect([...new Set(urls)]).toEqual([
        "https://rpc-a.example/",
        "https://rpc-b.example/",
      ]);
    }
  });

  it("hands a failed point read to the next endpoint without retrying the chain", async () => {
    const attempts: string[] = [];
    const client = createBscReadClient({
      config: chainConfig(),
      transportFactory: (url) =>
        custom({
          request: (request: RpcRequest): Promise<unknown> => {
            attempts.push(`${url}|${request.method}`);
            if (url === "https://rpc-a.example/") {
              return Promise.reject(new Error("endpoint unavailable"));
            }
            switch (request.method) {
              case "eth_chainId": {
                return Promise.resolve("0x38");
              }
              case "eth_getBlockByNumber": {
                return Promise.resolve(blockResponse(headNumber, headHash));
              }
              default: {
                return Promise.reject(new Error(`unmocked ${request.method}`));
              }
            }
          },
        }),
    });

    const head = await client.getHead();

    expect(head.blockNumber).toBe(headNumber);
    // One attempt per endpoint per method: the chain is walked once, never
    // four times over.
    expect(
      attempts.filter(
        (attempt) => attempt === "https://rpc-a.example/|eth_getBlockByNumber",
      ),
    ).toHaveLength(1);
  });

  it("refuses a log range wider than one segment", async () => {
    const client = createBscReadClient({
      config: chainConfig(),
      transportFactory: () => chainTransport({}),
    });

    await expect(
      client.readTransferLogs({
        addresses: [wbnb],
        fromBlock: 1n,
        toBlock: 2_001n,
      }),
    ).rejects.toMatchObject({ reasonCode: "BSC_LOG_RANGE_TOO_WIDE" });
    await expect(
      client.readTransferLogs({
        addresses: [wbnb],
        fromBlock: 10n,
        toBlock: 9n,
      }),
    ).rejects.toMatchObject({ reasonCode: "BSC_LOG_RANGE_INVALID" });
  });

  it("normalises decoded transfer logs to lowercase chain facts", async () => {
    const client = createBscReadClient({
      config: chainConfig(),
      transportFactory: () =>
        chainTransport({
          logs: [
            {
              address: "0xBB4CDB9CBD36B01BD1CBAEBF2DE08D9173BC095C",
              blockHash: headHash,
              blockNumber: numberToHex(headNumber),
              data: numberToHex(1_000n, { size: 32 }),
              logIndex: "0x2",
              removed: false,
              topics: [
                "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
                `0x000000000000000000000000${owner.slice(2)}`,
                `0x000000000000000000000000${wbnb.slice(2)}`,
              ],
              transactionHash:
                "0x7777777777777777777777777777777777777777777777777777777777777777",
              transactionIndex: "0x0",
            },
          ],
        }),
    });

    const logs = await client.readTransferLogs({
      addresses: [wbnb],
      fromBlock: headNumber,
      toBlock: headNumber,
    });
    expect(logs).toEqual([
      {
        transactionHash:
          "0x7777777777777777777777777777777777777777777777777777777777777777",
        logIndex: 2,
        blockNumber: headNumber,
        blockHash: headHash,
        address: wbnb,
        from: owner,
        to: wbnb,
        value: 1_000n,
        removed: false,
      },
    ]);
  });

  it("halves a rejected range until the endpoint accepts it", async () => {
    const accepted: { from: bigint; to: bigint }[] = [];
    const client = createBscReadClient({
      config: chainConfig(),
      transportFactory: () =>
        custom({
          request: (request: RpcRequest): Promise<unknown> => {
            if (request.method === "eth_chainId") {
              return Promise.resolve("0x38");
            }
            if (request.method !== "eth_getLogs") {
              return Promise.reject(new Error(`unmocked ${request.method}`));
            }
            const params = request.params as readonly [
              { readonly fromBlock: string; readonly toBlock: string },
            ];
            const from = BigInt(params[0].fromBlock);
            const to = BigInt(params[0].toBlock);
            // The endpoint caps the span at 500 blocks.
            if (to - from + 1n > 500n) {
              return Promise.reject(
                new LimitExceededRpcError(new Error("limit exceeded")),
              );
            }
            accepted.push({ from, to });
            return Promise.resolve([]);
          },
        }),
    });

    await client.readTransferLogs({
      addresses: [wbnb],
      fromBlock: 1n,
      toBlock: 2_000n,
    });

    // Every block of the requested range is covered exactly once, in order.
    expect(accepted[0]?.from).toBe(1n);
    expect(accepted.at(-1)?.to).toBe(2_000n);
    let expectedNext = 1n;
    for (const range of accepted) {
      expect(range.from).toBe(expectedNext);
      expect(range.to - range.from + 1n).toBeLessThanOrEqual(500n);
      expectedNext = range.to + 1n;
    }
    expect(expectedNext).toBe(2_001n);
  });

  it("rethrows when even a single block exceeds the endpoint limit", async () => {
    const client = createBscReadClient({
      config: chainConfig(),
      transportFactory: () =>
        custom({
          request: (request: RpcRequest): Promise<unknown> =>
            request.method === "eth_chainId"
              ? Promise.resolve("0x38")
              : Promise.reject(
                  new LimitExceededRpcError(new Error("limit exceeded")),
                ),
        }),
    });

    // Returning an empty page here would silently drop real transfers.
    await expect(
      client.readTransferLogs({
        addresses: [wbnb],
        fromBlock: 10n,
        toBlock: 13n,
      }),
    ).rejects.toBeInstanceOf(LimitExceededRpcError);
  });

  it("probes every endpoint behind an opaque reference", async () => {
    const config = chainConfig();
    const client = createBscReadClient({
      config,
      transportFactory: (url) =>
        url === config.rpcUrls[1]
          ? chainTransport({ failMethods: new Set(["eth_blockNumber"]) })
          : chainTransport({}),
    });

    const endpoints = await client.probeEndpoints();
    expect(endpoints).toHaveLength(2);
    expect(endpoints[0]?.endpointRef).toBe(
      endpointRefFor(config.rpcUrls[0] as string),
    );
    expect(endpoints[0]?.status).toBe("healthy");
    expect(endpoints[0]?.blockNumber).toBe(headNumber.toString(10));
    expect(endpoints[1]?.status).toBe("unreachable");
    expect(endpoints[1]?.blockNumber).toBeNull();
    // The host name is published on purpose as the row's label (Decision
    // 0049); the URL itself (scheme, path, any key) still never is.
    expect(endpoints.map((endpoint) => endpoint.label)).toEqual([
      "rpc-a.example",
      "rpc-b.example",
    ]);
    for (const endpoint of endpoints) {
      expect(endpoint.endpointRef).toMatch(/^rpc-[0-9a-f]{12}$/);
      expect(JSON.stringify(endpoint)).not.toContain("https://");
      expect(JSON.stringify(endpoint)).not.toContain("example/");
    }
  });

  it("rejects every read when no endpoint is configured", async () => {
    const client = createUnavailableBscReadClient();
    await expect(client.verifyChain()).resolves.toBe("unknown");
    await expect(client.probeEndpoints()).resolves.toEqual([]);
    await expect(client.getHead()).rejects.toMatchObject({
      reasonCode: "BSC_RPC_NOT_CONFIGURED",
    });
    expect(client.currentVerification()).toBe("unknown");
    expect(client.confirmations).toBe(15);

    // The operator's configured policy still shows through a closed client.
    const configured = createUnavailableBscReadClient({
      confirmations: 21,
      reorgDepthBlocks: 96,
    });
    expect(configured.confirmations).toBe(21);
    expect(configured.reorgDepthBlocks).toBe(96);
  });

  it("serves the launch slot's testnet with the same verification discipline (Decision 0038)", async () => {
    const testnet = createBscReadClient({
      config: {
        chainId: "eip155:97",
        chainReference: 97,
        rpcUrls: ["https://bsc-testnet-rpc.example/"],
        confirmations: 5,
        reorgDepthBlocks: 15,
      },
      transportFactory: () => chainTransport({ chainId: "0x61" }),
    });
    expect(testnet.chainId).toBe("eip155:97");
    expect(testnet.chainReference).toBe(97);
    expect(testnet.confirmations).toBe(5);
    expect(testnet.reorgDepthBlocks).toBe(15);
    await expect(testnet.verifyChain()).resolves.toBe("verified");
    const balances = await testnet.readBalances(owner, [
      { assetId: "eip155:97:native", address: null },
    ]);
    expect(balances.head.blockNumber).toBe(headNumber);
    expect(balances.balances).toEqual([
      {
        assetId: "eip155:97:native",
        rawValue: 7_000_000_000_000_000_000n,
        reasonCode: null,
      },
    ]);

    // A mainnet endpoint behind the testnet slot is a mismatch, not a
    // silently wrong chain.
    const mainnetBehindTestnet = createBscReadClient({
      config: {
        chainId: "eip155:97",
        chainReference: 97,
        rpcUrls: ["https://rpc-a.example/"],
        confirmations: 5,
        reorgDepthBlocks: 15,
      },
      transportFactory: () => chainTransport({ chainId: "0x38" }),
    });
    await expect(mainnetBehindTestnet.verifyChain()).resolves.toBe(
      "mismatched",
    );
    await expect(
      mainnetBehindTestnet.readBalances(owner, [
        { assetId: "eip155:97:native", address: null },
      ]),
    ).rejects.toBeInstanceOf(BscChainMismatchError);
    const probes = await mainnetBehindTestnet.probeEndpoints();
    expect(probes[0]).toMatchObject({
      status: "degraded",
      chainVerification: "mismatched",
    });
  });

  it("closes the launch slot with its own identity and reason code when no endpoint is configured", async () => {
    const client = createUnavailableBscReadClient({
      chainId: "eip155:97",
      chainReference: 97,
      confirmations: 5,
      reorgDepthBlocks: 15,
      reasonCode: "LAUNCH_CHAIN_RPC_NOT_CONFIGURED",
    });
    expect(client.chainId).toBe("eip155:97");
    expect(client.chainReference).toBe(97);
    expect(client.endpointRefs).toEqual([]);
    await expect(
      client.readBalances(owner, [
        { assetId: "eip155:97:native", address: null },
      ]),
    ).rejects.toMatchObject({ reasonCode: "LAUNCH_CHAIN_RPC_NOT_CONFIGURED" });
    // The primary unavailable client is unchanged.
    expect(createUnavailableBscReadClient().chainId).toBe("eip155:56");
  });
});

describe("BSC read client — cold start self-healing (preflight 2026-09-16)", () => {
  it("flips from unreachable to verified through the startup retry without any chain read", async () => {
    let reachable = false;
    const chainIdCalls: number[] = [];
    const client = createBscReadClient({
      config: chainConfig(),
      transportFactory: () =>
        custom({
          request: (request: RpcRequest): Promise<unknown> => {
            if (request.method === "eth_chainId") {
              chainIdCalls.push(Date.now());
              return reachable
                ? Promise.resolve("0x38")
                : Promise.reject(new Error("endpoint unavailable"));
            }
            return Promise.reject(new Error(`unmocked ${request.method}`));
          },
          // The client's own probe must decide; no transport-level retries.
          retryCount: 0,
        }),
    });
    const sleeps: number[] = [];
    const logger = { warn: vi.fn(), info: vi.fn() };
    const watch = createChainVerificationWatch({
      client,
      chainSlot: "primary",
      logger,
      retry: {
        maxAttempts: 5,
        initialDelayMs: 2_000,
        maxDelayMs: 16_000,
        maxTotalMs: 60_000,
      },
      monotonicMs: () => sleeps.reduce((sum, ms) => sum + ms, 0),
      sleep: (ms) => {
        sleeps.push(ms);
        // The endpoint comes back while the second delay is pending.
        if (sleeps.length === 2) {
          reachable = true;
        }
        return Promise.resolve();
      },
    });

    // Cold start: the projection reads `unknown` while the probe is pending.
    const startup = watch.verifyAtStartup();
    expect(client.currentVerification()).toBe("unknown");

    await expect(startup).resolves.toBe("verified");
    expect(client.currentVerification()).toBe("verified");
    expect(watch.current()).toBe("verified");
    expect(sleeps).toEqual([2_000, 4_000]);
    // Each probe hits both endpoints of the fallback transport once.
    expect(chainIdCalls.length).toBeGreaterThanOrEqual(3);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ chainVerification: "verified", attempt: 3 }),
      expect.stringContaining("recovered"),
    );
  });

  it("keeps a mismatched chain closed and never re-probes it from the projection", async () => {
    const client = createBscReadClient({
      config: chainConfig(),
      transportFactory: () => chainTransport({ chainId: "0x1" }),
    });
    const sleep = vi.fn(() => Promise.resolve());
    const watch = createChainVerificationWatch({
      client,
      chainSlot: "primary",
      logger: null,
      sleep,
      monotonicMs: () => 0,
    });
    await expect(watch.verifyAtStartup()).resolves.toBe("mismatched");
    expect(sleep).not.toHaveBeenCalled();
    expect(watch.current()).toBe("mismatched");
    await expect(client.getHead()).rejects.toBeInstanceOf(
      BscChainMismatchError,
    );
  });
});

describe("endpointLabelFor", () => {
  it("publishes only the host name, never scheme, port, path, query, or user-info", () => {
    expect(
      endpointLabelFor(
        "https://user:key@bsc-rpc.publicnode.com:8545/v1/abc?token=x",
      ),
    ).toBe("bsc-rpc.publicnode.com");
    expect(endpointLabelFor("https://rpc-a.example/")).toBe("rpc-a.example");
  });

  it("falls back to the opaque ref when the URL cannot be parsed", () => {
    expect(endpointLabelFor("not a url")).toBe(endpointRefFor("not a url"));
  });
});
