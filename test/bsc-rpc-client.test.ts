import {
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  HttpRequestError,
  LimitExceededRpcError,
  multicall3Abi,
  numberToHex,
  ResourceNotFoundRpcError,
  RpcRequestError,
  TimeoutError,
  type Transport,
} from "viem";
import { describe, expect, it, vi } from "vitest";

import type { BscChainConfig } from "../src/config.js";
import {
  erc20AllowanceAbi,
  erc20BalanceAbi,
  erc20IdentityAbi,
} from "../src/integrations/bsc/erc20-abi.js";
import {
  BscChainMismatchError,
  BscReadUnavailableError,
  bscLogLimitRelaxAfterCleanReads,
  bscMaximumLogRequestsPerSegment,
  classifyLogQueryError,
  createBscReadClient,
  createUnavailableBscReadClient,
  endpointLabelFor,
  endpointRefFor,
  isLogQueryRejection,
  summarizeRpcError,
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
    logAddressChunkSize: 8,
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
      case "0xdd62ed3e": {
        return {
          success: true,
          returnData: encodeFunctionResult({
            abi: erc20AllowanceAbi,
            functionName: "allowance",
            result: 5_000_000_000_000_000_000n,
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

  describe("allowance reads pinned to an observed block (Decision 0082, S86b)", () => {
    const usd1 = "0x2222222222222222222222222222222222222222";
    const spender = "0x1111111111111111111111111111111111111111";
    const item = { assetId: `eip155:56:${usd1}`, token: usd1, spender };
    const pinned = headNumber - 1n;
    const pinnedHash =
      "0x7777777777777777777777777777777777777777777777777777777777777777";

    function pinnedTransport(options: {
      readonly requests: RpcRequest[];
      readonly refuseBlock?: "error" | "null";
      readonly refuseCall?: boolean;
    }): Transport {
      return custom({
        request: (request: RpcRequest): Promise<unknown> => {
          options.requests.push(request);
          switch (request.method) {
            case "eth_chainId": {
              return Promise.resolve("0x38");
            }
            case "eth_getBlockByNumber": {
              const [tag] = request.params as readonly [string, boolean];
              if (tag === "latest") {
                return Promise.resolve(blockResponse(headNumber, headHash));
              }
              if (options.refuseBlock === "error") {
                return Promise.reject(
                  new RpcRequestError({
                    body: { method: "eth_getBlockByNumber" },
                    url: "https://rpc-a.example/",
                    error: { code: -32000, message: "header not found" },
                  }),
                );
              }
              if (options.refuseBlock === "null") {
                return Promise.resolve(null);
              }
              return Promise.resolve(blockResponse(BigInt(tag), pinnedHash));
            }
            case "eth_call": {
              if (options.refuseCall === true) {
                return Promise.reject(
                  new RpcRequestError({
                    body: { method: "eth_call" },
                    url: "https://rpc-a.example/",
                    error: { code: -32000, message: "header not found" },
                  }),
                );
              }
              const params = request.params as readonly [
                { readonly data: `0x${string}` },
              ];
              return Promise.resolve(answerMulticall(params[0].data));
            }
            default: {
              return Promise.reject(new Error(`unmocked ${request.method}`));
            }
          }
        },
      });
    }

    it("names the pinned block on every call and returns it as the head", async () => {
      const requests: RpcRequest[] = [];
      const client = createBscReadClient({
        config: chainConfig(),
        transportFactory: () => pinnedTransport({ requests }),
      });

      const result = await client.readAllowances(owner, [item], {
        atBlock: pinned,
      });

      expect(result.head.blockNumber).toBe(pinned);
      expect(result.head.blockHash).toBe(pinnedHash);
      expect(result.allowances).toEqual([
        {
          assetId: item.assetId,
          spender,
          rawValue: 5_000_000_000_000_000_000n,
          reasonCode: null,
        },
      ]);
      const calls = requests.filter((request) => request.method === "eth_call");
      expect(calls).toHaveLength(1);
      expect((calls[0]?.params as readonly unknown[])[1]).toBe(
        numberToHex(pinned),
      );
      const headers = requests.filter(
        (request) => request.method === "eth_getBlockByNumber",
      );
      expect(
        headers.map((request) => (request.params as readonly unknown[])[0]),
      ).toEqual([numberToHex(pinned)]);
    });

    it("shares the head of a balance read when pinned to it", async () => {
      const requests: RpcRequest[] = [];
      const client = createBscReadClient({
        config: chainConfig(),
        transportFactory: () =>
          custom({
            request: (request: RpcRequest): Promise<unknown> => {
              if (request.method === "eth_getBlockByNumber") {
                const [tag] = request.params as readonly [string, boolean];
                // The balance read observes one head; any later `latest`
                // would already be the next block.
                const seen = requests.some(
                  (earlier) => earlier.method === "eth_getBlockByNumber",
                );
                requests.push(request);
                return Promise.resolve(
                  tag === "latest"
                    ? blockResponse(
                        seen ? headNumber + 1n : headNumber,
                        headHash,
                      )
                    : blockResponse(BigInt(tag), headHash),
                );
              }
              requests.push(request);
              return request.method === "eth_chainId"
                ? Promise.resolve("0x38")
                : Promise.resolve(
                    answerMulticall(
                      (
                        request.params as readonly [
                          { readonly data: `0x${string}` },
                        ]
                      )[0].data,
                    ),
                  );
            },
          }),
      });

      const balances = await client.readBalances(owner, [
        { assetId: item.assetId, address: usd1 },
      ]);
      const allowances = await client.readAllowances(owner, [item], {
        atBlock: balances.head.blockNumber,
      });

      expect(allowances.head.blockNumber).toBe(balances.head.blockNumber);
      expect(allowances.head.blockHash).toBe(balances.head.blockHash);
      // Unpinned, the same sequence would have straddled the boundary.
      const unpinned = await client.readAllowances(owner, [item]);
      expect(unpinned.head.blockNumber).toBe(headNumber + 1n);
    });

    it.each(["error", "null"] as const)(
      "fails closed as BSC_PINNED_BLOCK_UNAVAILABLE when the endpoint no longer serves the block (%s)",
      async (refuseBlock) => {
        const client = createBscReadClient({
          config: chainConfig(),
          transportFactory: () =>
            pinnedTransport({ requests: [], refuseBlock }),
        });

        const failure = await client
          .readAllowances(owner, [item], { atBlock: pinned })
          .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(BscReadUnavailableError);
        expect(failure).toMatchObject({
          reasonCode: "BSC_PINNED_BLOCK_UNAVAILABLE",
        });
      },
    );

    it("reports a refused pinned eth_call as a failed item, never a value from another block", async () => {
      const requests: RpcRequest[] = [];
      const client = createBscReadClient({
        config: chainConfig(),
        transportFactory: () => pinnedTransport({ requests, refuseCall: true }),
      });

      const result = await client.readAllowances(owner, [item], {
        atBlock: pinned,
      });

      expect(result.head.blockNumber).toBe(pinned);
      expect(result.allowances).toEqual([
        {
          assetId: item.assetId,
          spender,
          rawValue: null,
          reasonCode: "BSC_ALLOWANCE_CALL_FAILED",
        },
      ]);
      expect(
        requests.some(
          (request) =>
            request.method === "eth_getBlockByNumber" &&
            (request.params as readonly unknown[])[0] === "latest",
        ),
      ).toBe(false);
    });
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

  it("fails closed as BSC_LOG_QUERY_REJECTED when even a single-address, single-block request is refused", async () => {
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
    const failure = await client
      .readTransferLogs({
        addresses: [wbnb],
        fromBlock: 10n,
        toBlock: 13n,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(BscReadUnavailableError);
    expect(failure).toMatchObject({
      reasonCode: "BSC_LOG_QUERY_REJECTED",
      rpcError: {
        errorClass: "LimitExceededRpcError",
        rpcCode: -32005,
        method: null,
      },
    });
    // The original Provider error stays reachable for a debugger.
    expect((failure as Error).cause).toBeInstanceOf(LimitExceededRpcError);
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

/**
 * The refusal observed on the Development stack on 2026-09-22 (Decision
 * 0068): a public endpoint answers `eth_getLogs` with HTTP 403 and a
 * JSON-RPC-shaped body, and viem surfaces it as an `HttpRequestError` that
 * is neither a `LimitExceededRpcError` nor an `InvalidParamsRpcError`.
 */
const keyedEndpointUrl =
  "https://user:secret@bsc-rpc.publicnode.com/v1/abcdef-provider-key?token=xyz";

function requestBlocked(body: Record<string, unknown>): HttpRequestError {
  return new HttpRequestError({
    body,
    details: '{"code":-32602,"message":"Request blocked"}',
    status: 403,
    url: keyedEndpointUrl,
  });
}

function rawTransferLog(
  address: string,
  blockNumber: bigint,
  logIndex: number,
): unknown {
  return {
    address,
    blockHash: headHash,
    blockNumber: numberToHex(blockNumber),
    data: numberToHex(1_000n, { size: 32 }),
    logIndex: numberToHex(BigInt(logIndex)),
    removed: false,
    topics: [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      `0x000000000000000000000000${owner.slice(2)}`,
      `0x000000000000000000000000${wbnb.slice(2)}`,
    ],
    transactionHash: `0x${blockNumber.toString(16).padStart(62, "0")}${String(logIndex).padStart(2, "0")}`,
    transactionIndex: "0x0",
  };
}

describe("BSC read client — Provider refusals of eth_getLogs (Decision 0068)", () => {
  const tokenA = "0x000000000000000000000000000000000000000a";
  const tokenB = "0x000000000000000000000000000000000000000b";
  const tokenC = "0x000000000000000000000000000000000000000c";

  it("summarises a refused request into loggable fields and never the URL, body, or key", () => {
    const summary = summarizeRpcError(
      requestBlocked({
        method: "eth_getLogs",
        params: [
          { address: [tokenA, tokenB], fromBlock: "0x1", toBlock: "0x2" },
        ],
      }),
    );
    expect(summary).toEqual({
      errorClass: "HttpRequestError",
      rpcStatus: 403,
      rpcCode: -32602,
      rpcUrlHost: "bsc-rpc.publicnode.com",
      method: "eth_getLogs",
    });
    const serialised = JSON.stringify(summary);
    expect(serialised).not.toContain("secret");
    expect(serialised).not.toContain("provider-key");
    expect(serialised).not.toContain("token=");
    expect(serialised).not.toContain(tokenA);
    expect(serialised).not.toContain("Request blocked");
  });

  it("classifies age refusals as archive before the shape codes, so -32602 with archive text never narrows (S82d)", () => {
    // publicnode mainnet, observed 2026-09-25 about 10,000 blocks back.
    expect(
      classifyLogQueryError(
        new HttpRequestError({
          status: 403,
          url: keyedEndpointUrl,
          details:
            '{"jsonrpc":"2.0","error":{"code":-32602,"message":"Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode"},"id":1}',
        }),
      ),
    ).toBe("archive");
    // publicnode testnet: HTTP 200, JSON-RPC -32701.
    expect(
      classifyLogQueryError(
        new RpcRequestError({
          body: { method: "eth_getLogs" },
          url: keyedEndpointUrl,
          error: {
            code: -32701,
            message: "History has been pruned for this block.",
          },
        }),
      ),
    ).toBe("archive");
    expect(
      classifyLogQueryError(
        new HttpRequestError({
          status: 400,
          url: keyedEndpointUrl,
          details:
            '{"code":-32000,"message":"historical data is not available on this plan"}',
        }),
      ),
    ).toBe("archive");
    // A quota text still wins: the rate is the objection.
    expect(
      classifyLogQueryError(
        new HttpRequestError({
          status: 429,
          url: keyedEndpointUrl,
          details: '{"code":-32005,"message":"archive quota exceeded"}',
        }),
      ),
    ).toBe("throttle");
    // The unchanged shape refusal.
    expect(
      classifyLogQueryError(requestBlocked({ method: "eth_getLogs" })),
    ).toBe("shape");
    expect(
      isLogQueryRejection(
        new HttpRequestError({
          status: 403,
          url: keyedEndpointUrl,
          details:
            '{"code":-32602,"message":"Archive requests require a personal token."}',
        }),
      ),
    ).toBe(false);
  });

  it("splits only on a shape refusal; a throttle propagates to the lane backoff and a transport failure is neither", () => {
    // Shape: the request itself is objected to.
    expect(
      classifyLogQueryError(requestBlocked({ method: "eth_getLogs" })),
    ).toBe("shape");
    expect(
      classifyLogQueryError(
        new LimitExceededRpcError(new Error("limit exceeded")),
      ),
    ).toBe("shape");
    expect(
      classifyLogQueryError(
        new HttpRequestError({
          status: 400,
          url: keyedEndpointUrl,
          details:
            '{"code":-32000,"message":"query returned more than 10000 results"}',
        }),
      ),
    ).toBe("shape");
    expect(
      classifyLogQueryError(
        new HttpRequestError({
          status: 413,
          url: keyedEndpointUrl,
        }),
      ),
    ).toBe("shape");
    // Throttle: the rate is objected to; narrowing would multiply requests.
    expect(
      classifyLogQueryError(
        new HttpRequestError({ status: 429, url: keyedEndpointUrl }),
      ),
    ).toBe("throttle");
    expect(
      classifyLogQueryError(
        new ResourceNotFoundRpcError(
          Object.assign(new Error("usage limit exceeded"), { code: -32001 }),
        ),
      ),
    ).toBe("throttle");
    expect(
      classifyLogQueryError(new LimitExceededRpcError(new Error("quota"))),
    ).toBe("throttle");
    expect(
      classifyLogQueryError(
        new HttpRequestError({
          status: 400,
          url: keyedEndpointUrl,
          details: '{"code":-32000,"message":"too many requests"}',
        }),
      ),
    ).toBe("throttle");
    // A too-long topic or address array is a shape refusal (Decision 0075).
    for (const message of [
      "too many topics",
      "too many sub-topics",
      "too many addresses",
      "exceed max topics",
      // go-ethereum / bnb-chain/bsc eth/filters: maxSubTopics = 1000.
      "exceed max addresses or topics per search position",
    ]) {
      expect(
        classifyLogQueryError(
          new HttpRequestError({
            status: 400,
            url: keyedEndpointUrl,
            details: `{"code":-32000,"message":"${message}"}`,
          }),
        ),
      ).toBe("shape");
    }
    // -32001 is "resource not found" in EIP-1474; only a usage-limit text
    // makes it a refusal.
    expect(
      classifyLogQueryError(
        new ResourceNotFoundRpcError(
          Object.assign(new Error("resource not found"), { code: -32001 }),
        ),
      ),
    ).toBeNull();
    // A 5xx body is never read: an outage page that says "blocked" is an
    // outage.
    expect(
      classifyLogQueryError(
        new HttpRequestError({
          status: 503,
          url: keyedEndpointUrl,
          details: '{"code":-32602,"message":"Request blocked"}',
        }),
      ),
    ).toBeNull();
    expect(
      classifyLogQueryError(
        new HttpRequestError({ status: 403, url: keyedEndpointUrl }),
      ),
    ).toBeNull();
    expect(classifyLogQueryError(new Error("limit exceeded"))).toBeNull();
    expect(classifyLogQueryError(new Error("endpoint unavailable"))).toBeNull();
    expect(classifyLogQueryError(new BscReadUnavailableError("X"))).toBeNull();
    expect(isLogQueryRejection(requestBlocked({ method: "eth_getLogs" }))).toBe(
      true,
    );
    expect(
      isLogQueryRejection(
        new HttpRequestError({ status: 429, url: keyedEndpointUrl }),
      ),
    ).toBe(false);
  });

  it("summarises hostile error values without throwing", () => {
    expect(summarizeRpcError("not an object").errorClass).toBe("string");
    expect(summarizeRpcError(new Error("plain"))).toEqual({
      errorClass: "Error",
      rpcStatus: null,
      rpcCode: null,
      rpcUrlHost: null,
      method: null,
    });
    expect(summarizeRpcError(Object.create(null)).errorClass).toBe("Unknown");
    expect(
      summarizeRpcError({ constructor: { name: 42 }, status: 403 }),
    ).toEqual({
      errorClass: "Unknown",
      rpcStatus: 403,
      rpcCode: null,
      rpcUrlHost: null,
      method: null,
    });
    // An unparseable URL yields the opaque endpoint ref, never the text.
    const unparseable = summarizeRpcError({
      name: "line\nbreak",
      url: "not a url",
    });
    expect(unparseable.errorClass).toBe("Unknown");
    expect(unparseable.rpcUrlHost).toMatch(/^rpc-[0-9a-f]{12}$/);
  });

  it("does not split on a 5xx whose body happens to say blocked, and rethrows it unchanged", async () => {
    let requestCount = 0;
    const client = createBscReadClient({
      config: chainConfig({ rpcUrls: ["https://rpc-a.example/"] }),
      transportFactory: () =>
        custom({
          request: (request: RpcRequest): Promise<unknown> => {
            if (request.method === "eth_chainId") {
              return Promise.resolve("0x38");
            }
            requestCount += 1;
            return Promise.reject(
              new HttpRequestError({
                status: 502,
                url: keyedEndpointUrl,
                details: "upstream blocked: limit exceeded",
              }),
            );
          },
        }),
    });
    await expect(
      client.readTransferLogs({
        addresses: [tokenA, tokenB],
        fromBlock: 1n,
        toBlock: 8n,
      }),
    ).rejects.toBeInstanceOf(HttpRequestError);
    // One client read, one attempt (Decision 0078), no narrowing.
    expect(requestCount).toBe(1);
  });

  it("splits on a -32000 'query returned more than 10000 results' refusal", async () => {
    const accepted: { from: bigint; to: bigint }[] = [];
    const client = createBscReadClient({
      config: chainConfig({ rpcUrls: ["https://rpc-a.example/"] }),
      transportFactory: () =>
        custom({
          request: (request: RpcRequest): Promise<unknown> => {
            if (request.method === "eth_chainId") {
              return Promise.resolve("0x38");
            }
            const params = request.params as readonly [
              { readonly fromBlock: string; readonly toBlock: string },
            ];
            const from = BigInt(params[0].fromBlock);
            const to = BigInt(params[0].toBlock);
            if (to - from + 1n > 500n) {
              return Promise.reject(
                Object.assign(
                  new Error("query returned more than 10000 results"),
                  { code: -32000 },
                ),
              );
            }
            accepted.push({ from, to });
            return Promise.resolve([]);
          },
        }),
    });
    await client.readTransferLogs({
      addresses: [tokenA],
      fromBlock: 1n,
      toBlock: 2_000n,
    });
    expect(accepted.length).toBeGreaterThanOrEqual(4);
    expect(accepted[0]?.from).toBe(1n);
    expect(accepted.at(-1)?.to).toBe(2_000n);
  });

  it("rejects the whole read when a later chunk times out, never a partial page", async () => {
    const accepted: { from: bigint; to: bigint }[] = [];
    const client = createBscReadClient({
      config: chainConfig({ rpcUrls: ["https://rpc-a.example/"] }),
      transportFactory: () =>
        custom({
          request: (request: RpcRequest): Promise<unknown> => {
            if (request.method === "eth_chainId") {
              return Promise.resolve("0x38");
            }
            const params = request.params as readonly [
              { readonly fromBlock: string; readonly toBlock: string },
            ];
            const from = BigInt(params[0].fromBlock);
            const to = BigInt(params[0].toBlock);
            if (to - from + 1n > 2n) {
              return Promise.reject(
                Object.assign(new Error("Request blocked"), { code: -32602 }),
              );
            }
            if (from >= 5n) {
              return Promise.reject(
                new TimeoutError({
                  body: { method: "eth_getLogs" },
                  url: keyedEndpointUrl,
                }),
              );
            }
            accepted.push({ from, to });
            return Promise.resolve([rawTransferLog(tokenA, to, 0)]);
          },
        }),
    });
    const failure = await client
      .readTransferLogs({ addresses: [tokenA], fromBlock: 1n, toBlock: 6n })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(TimeoutError);
    expect(failure).not.toBeInstanceOf(BscReadUnavailableError);
    // The first chunks were served; their logs are discarded with the read.
    expect(accepted.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps a learned range limit across reads so the next segment is issued at the known width", async () => {
    let rejectedCount = 0;
    const accepted: { from: bigint; to: bigint }[] = [];
    const client = createBscReadClient({
      config: chainConfig({ rpcUrls: ["https://rpc-a.example/"] }),
      transportFactory: () =>
        custom({
          request: (request: RpcRequest): Promise<unknown> => {
            if (request.method === "eth_chainId") {
              return Promise.resolve("0x38");
            }
            const params = request.params as readonly [
              { readonly fromBlock: string; readonly toBlock: string },
            ];
            const from = BigInt(params[0].fromBlock);
            const to = BigInt(params[0].toBlock);
            if (to - from + 1n > 500n) {
              rejectedCount += 1;
              return Promise.reject(
                Object.assign(new Error("Request blocked"), { code: -32602 }),
              );
            }
            accepted.push({ from, to });
            return Promise.resolve([]);
          },
        }),
    });
    await client.readTransferLogs({
      addresses: [tokenA],
      fromBlock: 1n,
      toBlock: 2_000n,
    });
    expect(rejectedCount).toBeGreaterThan(0);
    const learnedRejections = rejectedCount;
    accepted.length = 0;
    await client.readApprovalLogs({
      addresses: [tokenA],
      fromBlock: 2_001n,
      toBlock: 4_000n,
    });
    // The second segment goes straight out at the learned width.
    expect(rejectedCount).toBe(learnedRejections);
    expect(accepted).toEqual([
      { from: 2_001n, to: 2_500n },
      { from: 2_501n, to: 3_000n },
      { from: 3_001n, to: 3_500n },
      { from: 3_501n, to: 4_000n },
    ]);
    // One clean read does not relax the limit (Decisions 0078, 0079): every
    // read until the 4-read streak completes stays at the learned width.
    let nextFrom = 4_001n;
    for (
      let cleanReads = 1;
      cleanReads < bscLogLimitRelaxAfterCleanReads;
      cleanReads += 1
    ) {
      await client.readTransferLogs({
        addresses: [tokenA],
        fromBlock: nextFrom,
        toBlock: nextFrom + 1_999n,
      });
      nextFrom += 2_000n;
    }
    expect(rejectedCount).toBe(learnedRejections);
    // After the streak the limit is probed one step wider, so a Provider
    // that recovers is not pinned to the narrow width forever: the next
    // segment probes 1000 blocks once and is refused once.
    await client.readTransferLogs({
      addresses: [tokenA],
      fromBlock: nextFrom,
      toBlock: nextFrom + 1_999n,
    });
    expect(rejectedCount).toBe(learnedRejections + 1);
    // The refused probe is rolled back and the next one waits twice as long
    // (Decision 0079).
    expect(client.logQueryLimits?.()).toMatchObject({
      learnedRangeLimit: 500,
      relaxAfterCleanReads: bscLogLimitRelaxAfterCleanReads * 2,
    });
  });

  it("splits a 403 multi-address query by address once the range is a single block, and learns the group size once", async () => {
    const accepted: { from: bigint; to: bigint; addresses: string[] }[] = [];
    let rejectedCount = 0;
    const client = createBscReadClient({
      config: chainConfig({ rpcUrls: ["https://rpc-a.example/"] }),
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
              {
                readonly address: string | string[];
                readonly fromBlock: string;
                readonly toBlock: string;
              },
            ];
            const addresses = Array.isArray(params[0].address)
              ? params[0].address
              : [params[0].address];
            const from = BigInt(params[0].fromBlock);
            const to = BigInt(params[0].toBlock);
            // The Provider refuses every request naming more than one
            // address, whatever the block span, like the 2026-09-22 endpoint.
            if (addresses.length > 1) {
              rejectedCount += 1;
              // -32602 is not retried by viem, so one refusal is one request.
              return Promise.reject(
                Object.assign(new Error("Request blocked"), {
                  code: -32602,
                }),
              );
            }
            accepted.push({ from, to, addresses: [...addresses] });
            const [address] = addresses;
            if (address !== tokenB) {
              return Promise.resolve([]);
            }
            const logs: unknown[] = [];
            for (let block = to; block >= from; block -= 1n) {
              logs.push(
                rawTransferLog(tokenB, block, 1),
                rawTransferLog(tokenB, block, 0),
              );
            }
            return Promise.resolve(logs);
          },
        }),
    });

    const logs = await client.readTransferLogs({
      addresses: [tokenA, tokenB, tokenC],
      fromBlock: 1n,
      toBlock: 4n,
    });

    // Every block of every address is covered exactly once.
    for (const token of [tokenA, tokenB, tokenC]) {
      const covered = accepted
        .filter((request) => request.addresses[0]?.toLowerCase() === token)
        .flatMap((request) => {
          const blocks: bigint[] = [];
          for (let block = request.from; block <= request.to; block += 1n) {
            blocks.push(block);
          }
          return blocks;
        })
        .sort((left, right) => (left < right ? -1 : 1));
      expect(covered).toEqual([1n, 2n, 3n, 4n]);
    }
    expect(accepted.every((request) => request.addresses.length === 1)).toBe(
      true,
    );
    // The refusal names no dimension, so the address list is narrowed first
    // (Decision 0078): 3 → 2 → 1 costs two refusals, the learned limit is
    // applied to every remaining address without another refusal, and the
    // four-block range is never split.
    expect(rejectedCount).toBe(2);
    expect(accepted).toHaveLength(3);
    // Logs come back in block order even though the split reordered requests.
    expect(logs.map((log) => [log.blockNumber, log.logIndex])).toEqual([
      [1n, 0],
      [1n, 1],
      [2n, 0],
      [2n, 1],
      [3n, 0],
      [3n, 1],
      [4n, 0],
      [4n, 1],
    ]);
    expect(logs.every((log) => log.address === tokenB)).toBe(true);
  });

  it("fails closed as BSC_LOG_QUERY_REJECTED when a single-address, single-block 403 is still refused, without any partial page", async () => {
    let requestCount = 0;
    const client = createBscReadClient({
      config: chainConfig({ rpcUrls: ["https://rpc-a.example/"] }),
      transportFactory: () =>
        custom({
          request: (request: RpcRequest): Promise<unknown> => {
            if (request.method === "eth_chainId") {
              return Promise.resolve("0x38");
            }
            requestCount += 1;
            return Promise.reject(
              requestBlocked({
                method: request.method,
                params: request.params,
              }),
            );
          },
        }),
    });

    const failure = await client
      .readApprovalLogs({
        addresses: [tokenA, tokenB],
        fromBlock: 1n,
        toBlock: 2n,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(BscReadUnavailableError);
    expect(failure).toMatchObject({
      reasonCode: "BSC_LOG_QUERY_REJECTED",
      rpcError: {
        errorClass: "HttpRequestError",
        rpcStatus: 403,
        rpcCode: -32602,
        rpcUrlHost: "bsc-rpc.publicnode.com",
        method: "eth_getLogs",
      },
    });
    // [1..2]{A,B} → [1..2]{A} → [1]{A}: three refusals and no further
    // probing; the log lane sends each request once (Decision 0078).
    expect(requestCount).toBe(3);
  });

  it("fails closed as BSC_LOG_QUERY_BUDGET_EXHAUSTED instead of grinding a rationed endpoint block by block", async () => {
    let requestCount = 0;
    const client = createBscReadClient({
      config: chainConfig({ rpcUrls: ["https://rpc-a.example/"] }),
      transportFactory: () =>
        custom({
          request: (request: RpcRequest): Promise<unknown> => {
            if (request.method === "eth_chainId") {
              return Promise.resolve("0x38");
            }
            const params = request.params as readonly [
              { readonly fromBlock: string; readonly toBlock: string },
            ];
            requestCount += 1;
            // Only single-block requests are ever accepted; -32602 is not
            // retried by viem, so the walk is fast and the budget is what stops it.
            if (BigInt(params[0].toBlock) !== BigInt(params[0].fromBlock)) {
              return Promise.reject(
                Object.assign(new Error("Request blocked"), {
                  code: -32602,
                }),
              );
            }
            return Promise.resolve([]);
          },
        }),
    });

    await expect(
      client.readPoolEventLogs({
        addresses: [tokenA],
        fromBlock: 1n,
        toBlock: 2_000n,
      }),
    ).rejects.toMatchObject({
      name: "BscReadUnavailableError",
      reasonCode: "BSC_LOG_QUERY_BUDGET_EXHAUSTED",
    });
    expect(requestCount).toBe(bscMaximumLogRequestsPerSegment);
    // The learned range was kept at its 500-block floor while the read went
    // lower on its own; running out of budget resets it (Decision 0079).
    expect(client.logQueryLimits?.()).toMatchObject({
      learnedAddressLimit: 8,
      learnedRangeLimit: 2_000,
    });
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

describe("BSC read client — wallet-scoped ERC-20 logs (Decision 0075)", () => {
  const transferTopic =
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const approvalTopic =
    "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
  const wallets = [1, 2, 3, 4, 5].map(
    (index) => `0x${"0".repeat(38)}b${String(index)}`,
  );
  const outsider = `0x${"0".repeat(38)}ee`;

  function padTopic(address: string): string {
    return `0x000000000000000000000000${address.slice(2)}`;
  }

  function unpadTopic(topic: string): string {
    return `0x${topic.slice(26)}`.toLowerCase();
  }

  interface LogFilter {
    readonly address: string | string[];
    readonly topics?: readonly (string | readonly string[] | null)[];
    readonly fromBlock: string;
    readonly toBlock: string;
  }

  /** Topic position `index` of a filter as a lowercase address list, or null. */
  function topicAddresses(filter: LogFilter, index: number): string[] | null {
    const topic = filter.topics?.[index] ?? null;
    if (topic === null) {
      return null;
    }
    return (Array.isArray(topic) ? topic : [topic]).map((value: string) =>
      unpadTopic(value),
    );
  }

  function logTransport(
    respond: (filter: LogFilter) => Promise<unknown>,
  ): Transport {
    return custom({
      request: (request: RpcRequest): Promise<unknown> => {
        if (request.method === "eth_chainId") {
          return Promise.resolve("0x38");
        }
        if (request.method !== "eth_getLogs") {
          return Promise.reject(new Error(`unmocked ${request.method}`));
        }
        const [filter] = request.params as readonly [LogFilter];
        return respond(filter);
      },
    });
  }

  function rawLog(options: {
    readonly topic0: string;
    readonly first: string;
    readonly second: string;
    readonly blockNumber: bigint;
    readonly logIndex: number;
  }): unknown {
    return {
      address: wbnb,
      blockHash: headHash,
      blockNumber: numberToHex(options.blockNumber),
      data: numberToHex(1_000n, { size: 32 }),
      logIndex: numberToHex(BigInt(options.logIndex)),
      removed: false,
      topics: [
        options.topic0,
        padTopic(options.first),
        padTopic(options.second),
      ],
      transactionHash: `0x${options.blockNumber.toString(16).padStart(62, "0")}${String(options.logIndex).padStart(2, "0")}`,
      transactionIndex: "0x0",
    };
  }

  it("reads from ∈ W and to ∈ W separately and returns a wallet-to-wallet transfer once, in block order", async () => {
    const filters: LogFilter[] = [];
    const [first, second] = wallets as [string, string];
    const outgoing = rawLog({
      topic0: transferTopic,
      first,
      second: outsider,
      blockNumber: 12n,
      logIndex: 0,
    });
    const incoming = rawLog({
      topic0: transferTopic,
      first: outsider,
      second,
      blockNumber: 10n,
      logIndex: 3,
    });
    const internal = rawLog({
      topic0: transferTopic,
      first,
      second,
      blockNumber: 11n,
      logIndex: 1,
    });
    const client = createBscReadClient({
      config: chainConfig({ rpcUrls: ["https://rpc-a.example/"] }),
      transportFactory: () =>
        logTransport((filter) => {
          filters.push(filter);
          if (topicAddresses(filter, 1) !== null) {
            return Promise.resolve([outgoing, internal]);
          }
          return Promise.resolve([internal, incoming]);
        }),
    });

    const logs = await client.readTransferLogs({
      addresses: [wbnb],
      fromBlock: 10n,
      toBlock: 12n,
      walletFilter: {
        walletAddresses: [second, first.toUpperCase().replace("0X", "0x")],
        topicChunkSize: 200,
      },
    });

    expect(filters).toHaveLength(2);
    const [fromFilter, toFilter] = filters as [LogFilter, LogFilter];
    expect(fromFilter.topics?.[0]).toBe(transferTopic);
    expect(topicAddresses(fromFilter, 1)).toEqual([first, second]);
    expect(topicAddresses(fromFilter, 2)).toBeNull();
    expect(toFilter.topics?.[0]).toBe(transferTopic);
    expect(topicAddresses(toFilter, 1)).toBeNull();
    expect(topicAddresses(toFilter, 2)).toEqual([first, second]);
    // The token filter is kept on both reads.
    expect(fromFilter.address).toEqual([wbnb]);
    expect(toFilter.address).toEqual([wbnb]);

    expect(
      logs.map((log) => [log.blockNumber, log.logIndex, log.from, log.to]),
    ).toEqual([
      [10n, 3, outsider, second],
      [11n, 1, first, second],
      [12n, 0, first, outsider],
    ]);
  });

  it("chunks the wallet set into topic arrays of the configured size on every side", async () => {
    const transferFilters: LogFilter[] = [];
    const approvalFilters: LogFilter[] = [];
    const client = createBscReadClient({
      config: chainConfig({ rpcUrls: ["https://rpc-a.example/"] }),
      transportFactory: () =>
        logTransport((filter) => {
          (filter.topics?.[0] === approvalTopic
            ? approvalFilters
            : transferFilters
          ).push(filter);
          return Promise.resolve([]);
        }),
    });
    const walletFilter = { walletAddresses: wallets, topicChunkSize: 2 };

    await client.readTransferLogs({
      addresses: [wbnb],
      fromBlock: 1n,
      toBlock: 5n,
      walletFilter,
    });
    await client.readApprovalLogs({
      addresses: [wbnb],
      fromBlock: 1n,
      toBlock: 5n,
      walletFilter,
    });

    const fromChunks = transferFilters.flatMap((filter) => {
      const chunk = topicAddresses(filter, 1);
      return chunk === null ? [] : [chunk];
    });
    const toChunks = transferFilters.flatMap((filter) => {
      const chunk = topicAddresses(filter, 2);
      return chunk === null ? [] : [chunk];
    });
    const expectedChunks = [
      wallets.slice(0, 2),
      wallets.slice(2, 4),
      [wallets[4]],
    ];
    expect(fromChunks).toEqual(expectedChunks);
    expect(toChunks).toEqual(expectedChunks);
    expect(transferFilters).toHaveLength(6);
    // Approvals are scoped to `owner` only.
    expect(approvalFilters.map((filter) => topicAddresses(filter, 1))).toEqual(
      expectedChunks,
    );
    expect(
      approvalFilters.every((filter) => topicAddresses(filter, 2) === null),
    ).toBe(true);
    // Every request covers the whole range: chunking never trims blocks.
    for (const filter of [...transferFilters, ...approvalFilters]) {
      expect(BigInt(filter.fromBlock)).toBe(1n);
      expect(BigInt(filter.toBlock)).toBe(5n);
    }
  });

  it("reads nothing for an empty wallet set", async () => {
    let requestCount = 0;
    const client = createBscReadClient({
      config: chainConfig({ rpcUrls: ["https://rpc-a.example/"] }),
      transportFactory: () =>
        logTransport(() => {
          requestCount += 1;
          return Promise.resolve([]);
        }),
    });
    const walletFilter = { walletAddresses: [], topicChunkSize: 200 };

    await expect(
      client.readTransferLogs({
        addresses: [wbnb],
        fromBlock: 1n,
        toBlock: 5n,
        walletFilter,
      }),
    ).resolves.toEqual([]);
    await expect(
      client.readApprovalLogs({
        addresses: [wbnb],
        fromBlock: 1n,
        toBlock: 5n,
        walletFilter,
      }),
    ).resolves.toEqual([]);
    expect(requestCount).toBe(0);
  });

  it("halves a refused topic array and still covers every wallet exactly once", async () => {
    const accepted: string[][] = [];
    let refusals = 0;
    const client = createBscReadClient({
      config: chainConfig({ rpcUrls: ["https://rpc-a.example/"] }),
      transportFactory: () =>
        logTransport((filter) => {
          const chunk = topicAddresses(filter, 1);
          if (chunk === null) {
            return Promise.resolve([]);
          }
          // The Provider caps one topic position at two sub-topics.
          if (chunk.length > 2) {
            refusals += 1;
            return Promise.reject(
              Object.assign(new Error("too many topics"), { code: -32602 }),
            );
          }
          accepted.push(chunk);
          return Promise.resolve([]);
        }),
    });

    await client.readTransferLogs({
      addresses: [wbnb],
      fromBlock: 7n,
      toBlock: 7n,
      walletFilter: { walletAddresses: wallets, topicChunkSize: 5 },
    });

    expect(accepted.every((chunk) => chunk.length <= 2)).toBe(true);
    expect(accepted.flat().sort()).toEqual([...wallets].sort());
    // One refusal (5 → 3) and one more (3 → 2) to learn the cap; the
    // learned size is applied to the rest without another refusal.
    expect(refusals).toBe(2);
  });

  it("fails closed as BSC_LOG_QUERY_REJECTED when a single-wallet, single-address, single-block request is still refused, never dropping the chunk", async () => {
    let requestCount = 0;
    const client = createBscReadClient({
      config: chainConfig({ rpcUrls: ["https://rpc-a.example/"] }),
      transportFactory: () =>
        logTransport((filter) => {
          requestCount += 1;
          // The first chunk is accepted; every request of the second chunk
          // is refused however narrow it gets.
          const chunk = topicAddresses(filter, 1) ?? [];
          if (chunk.every((address) => wallets.slice(0, 2).includes(address))) {
            return Promise.resolve([
              rawLog({
                topic0: transferTopic,
                first: wallets[0] ?? "",
                second: outsider,
                blockNumber: 7n,
                logIndex: 0,
              }),
            ]);
          }
          return Promise.reject(
            requestBlocked({ method: "eth_getLogs", params: [filter] }),
          );
        }),
    });

    const failure = await client
      .readTransferLogs({
        addresses: [wbnb],
        fromBlock: 7n,
        toBlock: 7n,
        walletFilter: { walletAddresses: wallets, topicChunkSize: 2 },
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(BscReadUnavailableError);
    expect(failure).toMatchObject({
      reasonCode: "BSC_LOG_QUERY_REJECTED",
      rpcError: {
        errorClass: "HttpRequestError",
        rpcStatus: 403,
        rpcCode: -32602,
        rpcUrlHost: "bsc-rpc.publicnode.com",
        method: "eth_getLogs",
      },
    });
    const serialised = JSON.stringify(
      (failure as BscReadUnavailableError).rpcError,
    );
    expect(serialised).not.toContain(wallets[2]?.slice(2) ?? "unused");
    expect(requestCount).toBeGreaterThan(1);
  });

  it("rejects a malformed wallet filter instead of widening or narrowing the scope", async () => {
    let requestCount = 0;
    const client = createBscReadClient({
      config: chainConfig({ rpcUrls: ["https://rpc-a.example/"] }),
      transportFactory: () =>
        logTransport(() => {
          requestCount += 1;
          return Promise.resolve([]);
        }),
    });

    for (const walletFilter of [
      { walletAddresses: wallets, topicChunkSize: 0 },
      { walletAddresses: wallets, topicChunkSize: 1_001 },
      { walletAddresses: wallets, topicChunkSize: 1.5 },
      { walletAddresses: ["0x1234"], topicChunkSize: 200 },
    ]) {
      await expect(
        client.readTransferLogs({
          addresses: [wbnb],
          fromBlock: 1n,
          toBlock: 1n,
          walletFilter,
        }),
      ).rejects.toMatchObject({
        reasonCode: "BSC_LOG_WALLET_FILTER_INVALID",
      });
      await expect(
        client.readApprovalLogs({
          addresses: [wbnb],
          fromBlock: 1n,
          toBlock: 1n,
          walletFilter,
        }),
      ).rejects.toMatchObject({
        reasonCode: "BSC_LOG_WALLET_FILTER_INVALID",
      });
    }
    expect(requestCount).toBe(0);
  });

  it("keeps narrowing the block range of a wallet-scoped read that the Provider refuses by span", async () => {
    const accepted: {
      from: bigint;
      to: bigint;
      side: "from" | "to";
      wallet: string;
    }[] = [];
    const client = createBscReadClient({
      config: chainConfig({ rpcUrls: ["https://rpc-a.example/"] }),
      transportFactory: () =>
        logTransport((filter) => {
          const from = BigInt(filter.fromBlock);
          const to = BigInt(filter.toBlock);
          if (to - from + 1n > 500n) {
            return Promise.reject(
              new LimitExceededRpcError(new Error("limit exceeded")),
            );
          }
          const fromSide = topicAddresses(filter, 1);
          const side = fromSide === null ? "to" : "from";
          for (const wallet of fromSide ?? topicAddresses(filter, 2) ?? []) {
            accepted.push({ from, to, side, wallet });
          }
          return Promise.resolve([]);
        }),
    });

    await client.readTransferLogs({
      addresses: [wbnb],
      fromBlock: 1n,
      toBlock: 2_000n,
      walletFilter: { walletAddresses: wallets, topicChunkSize: 200 },
    });

    // A bare "limit exceeded" names no dimension, so the topic array is
    // narrowed before the range (Decision 0078); either way every block of
    // every wallet on every side is covered exactly once.
    for (const side of ["from", "to"] as const) {
      for (const wallet of wallets) {
        let expectedNext = 1n;
        for (const range of accepted.filter(
          (entry) => entry.side === side && entry.wallet === wallet,
        )) {
          expect(range.from).toBe(expectedNext);
          expect(range.to - range.from + 1n).toBeLessThanOrEqual(500n);
          expectedNext = range.to + 1n;
        }
        expect(expectedNext).toBe(2_001n);
      }
    }
  });
});
