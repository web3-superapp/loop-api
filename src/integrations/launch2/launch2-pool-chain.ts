import {
  BaseError,
  createPublicClient,
  decodeErrorResult,
  encodeAbiParameters,
  encodePacked,
  erc20Abi,
  fallback,
  http,
  keccak256,
  type Abi,
  type Address,
  type PublicClient,
  type Hex,
  type StateOverride,
  type Transport,
} from "viem";
import { bscTestnet } from "viem/chains";

import type {
  Launch2PoolCall,
  Launch2PoolChain,
  Launch2PoolChainState,
  Launch2PoolRouterCheck,
  Launch2PoolSimulation,
} from "../../features/launch2/launch2-ports.js";
import { launch2PoolReasonCodes } from "../../features/launch2/launch2-pool.js";
import {
  curveEngineAbi,
  officialPoolRouterAbi,
  officialTaxHookAbi,
  poolManagerAbi,
} from "../launch/hooks-launch-protocol-abi.generated.js";

/**
 * Decision 0124: the launch-slot reader behind `/v2/launch2/instances/{id}/
 * pool/*`. It verifies the configured `OfficialPoolRouter` by runtime code
 * hash, reads the official pool (hook immutables, PoolManager slot0 via
 * `extsload`) and the wallet's balances / allowances at one block, and
 * simulates router calls with `eth_call` / `eth_estimateGas`. A quote
 * simulates from the wallet with the input token's balance and allowance
 * overridden in the call only (`stateDiff`): the ERC-20 storage slots are
 * discovered once per token by probing `balanceOf` / `allowance` under an
 * override (Solidity and Vyper mapping layouts, plain slots 0..15 and the
 * OpenZeppelin v5 namespaced ERC20 storage) and cached; a token whose
 * layout is not found is `override_unsupported` (no fixture answer). It
 * never signs or sends.
 */

const ozErc20NamespacedBase =
  0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00n;
const plainSlots = Array.from({ length: 16 }, (_, index) => BigInt(index));
const probeValue =
  0x4c4f4f505f504f4f4c5f50524f42455f00000000000000000000000000000001n;

const revertAbi = [
  ...officialPoolRouterAbi,
  ...officialTaxHookAbi,
  ...poolManagerAbi,
  ...erc20Abi,
  {
    type: "error",
    name: "ERC20InsufficientBalance",
    inputs: [
      { name: "sender", type: "address" },
      { name: "balance", type: "uint256" },
      { name: "needed", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "ERC20InsufficientAllowance",
    inputs: [
      { name: "spender", type: "address" },
      { name: "allowance", type: "uint256" },
      { name: "needed", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "WrappedError",
    inputs: [
      { name: "target", type: "address" },
      { name: "selector", type: "bytes4" },
      { name: "reason", type: "bytes" },
      { name: "details", type: "bytes" },
    ],
  },
] as unknown as Abi;

function lower(value: string): string {
  return value.toLowerCase();
}

export function slotHex(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

/** `keccak256(abi.encode(key, slot))` (Solidity) or `(slot, key)` (Vyper). */
export function mappingSlot(
  key: string,
  base: bigint,
  order: "solidity" | "vyper",
): bigint {
  const encoded =
    order === "solidity"
      ? encodeAbiParameters(
          [{ type: "address" }, { type: "uint256" }],
          [key as Address, base],
        )
      : encodeAbiParameters(
          [{ type: "uint256" }, { type: "address" }],
          [base, key as Address],
        );
  return BigInt(keccak256(encoded));
}

export function nestedSlot(
  owner: string,
  spender: string,
  base: bigint,
  order: "solidity" | "vyper",
): bigint {
  const inner = mappingSlot(owner, base, order);
  return mappingSlot(spender, inner, order);
}

export interface TokenLayout {
  readonly balanceBase: bigint;
  readonly allowanceBase: bigint;
  readonly order: "solidity" | "vyper";
}

/** The revert data of a viem call error, if the node returned any. */
export function revertData(error: unknown): Hex | null {
  if (!(error instanceof BaseError)) return null;
  let found: Hex | null = null;
  error.walk((cause) => {
    const data = (cause as { data?: unknown }).data;
    if (typeof data === "string" && /^0x[0-9a-fA-F]*$/u.test(data)) {
      found = data as Hex;
      return true;
    }
    if (
      typeof data === "object" &&
      data !== null &&
      typeof (data as { data?: unknown }).data === "string"
    ) {
      found = (data as { data: Hex }).data;
      return true;
    }
    return false;
  });
  return found;
}

/** Decodes a custom error name, unwrapping the v4 `WrappedError`. */
export function launch2PoolErrorName(data: Hex | null): string | null {
  if (data === null || data.length < 10) return null;
  try {
    const decoded = decodeErrorResult({ abi: revertAbi, data });
    if (decoded.errorName === "WrappedError") {
      const args = decoded.args as readonly unknown[];
      const inner = launch2PoolErrorName(args[2] as Hex);
      return inner ?? "WrappedError";
    }
    return decoded.errorName;
  } catch {
    return null;
  }
}

/** A `stateDiff` override of one contract's storage slots. */
export function tokenOverride(
  token: string,
  entries: readonly { readonly slot: bigint; readonly value: bigint }[],
): StateOverride {
  return [
    {
      address: token as Address,
      stateDiff: entries.map((entry) => ({
        slot: slotHex(entry.slot),
        value: slotHex(entry.value),
      })),
    },
  ];
}

/**
 * Decision 0124 (shared with Decision 0131): finds an ERC-20's balance and
 * allowance mapping slots by reading `balanceOf` / `allowance(owner,
 * spender)` under a probe override (Solidity and Vyper layouts, plain
 * slots 0..15, OpenZeppelin v5 namespaced storage). Null when not found.
 */
export async function probeErc20Layout(
  client: PublicClient,
  token: string,
  owner: string,
  spender: string,
  blockNumber: bigint,
): Promise<TokenLayout | null> {
  const balanceOf = async (slot: bigint): Promise<bigint | null> => {
    try {
      return await client.readContract({
        address: token as Address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner as Address],
        blockNumber,
        stateOverride: tokenOverride(token, [{ slot, value: probeValue }]),
      });
    } catch {
      return null;
    }
  };
  const allowanceOf = async (slot: bigint): Promise<bigint | null> => {
    try {
      return await client.readContract({
        address: token as Address,
        abi: erc20Abi,
        functionName: "allowance",
        args: [owner as Address, spender as Address],
        blockNumber,
        stateOverride: tokenOverride(token, [{ slot, value: probeValue }]),
      });
    } catch {
      return null;
    }
  };
  const bases = [...plainSlots, ozErc20NamespacedBase];
  for (const order of ["solidity", "vyper"] as const) {
    for (const base of bases) {
      if ((await balanceOf(mappingSlot(owner, base, order))) !== probeValue) {
        continue;
      }
      const allowanceBases = [
        base + 1n,
        base + 2n,
        ...plainSlots.filter((slot) => slot !== base),
      ];
      for (const allowanceBase of allowanceBases) {
        const slot = nestedSlot(owner, spender, allowanceBase, order);
        if ((await allowanceOf(slot)) === probeValue) {
          return { balanceBase: base, allowanceBase, order };
        }
      }
      return null;
    }
  }
  return null;
}

export function createLaunch2PoolChain(input: {
  readonly rpcUrls: readonly string[];
  readonly router: string;
  readonly expectedRuntimeCodeHash: string;
  /** Test seam (anvil); production uses the RPC URL list. */
  readonly transport?: Transport;
  /** Re-verify a failed router check after this long (default 60 s). */
  readonly retryAfterMs?: number;
  readonly now?: () => number;
}): Launch2PoolChain {
  if (
    !/^0x[0-9a-fA-F]{40}$/u.test(input.router) ||
    !/^0x[0-9a-fA-F]{64}$/u.test(input.expectedRuntimeCodeHash)
  ) {
    throw new Error("Launch2 pool router address / code hash are malformed");
  }
  const router = lower(input.router);
  const expectedCodeHash = lower(input.expectedRuntimeCodeHash);
  const retryAfterMs = input.retryAfterMs ?? 60_000;
  const now = input.now ?? Date.now;
  const transport =
    input.transport ??
    fallback(
      input.rpcUrls.map((url) =>
        http(url, { timeout: 10_000, retryCount: 1, batch: { batchSize: 32 } }),
      ),
      { retryCount: 0 },
    );
  const client = createPublicClient({ chain: bscTestnet, transport });
  let verified: Launch2PoolRouterCheck | null = null;
  let failedAt = 0;
  let inFlight: Promise<Launch2PoolRouterCheck> | null = null;
  const layouts = new Map<string, TokenLayout | null>();

  async function checkRouter(): Promise<Launch2PoolRouterCheck> {
    const code = await client.getCode({ address: router as Address });
    if (code === undefined || code === "0x") {
      return {
        status: "unavailable",
        reasonCode: launch2PoolReasonCodes.routerCodeMismatch,
      };
    }
    if (lower(keccak256(code)) !== expectedCodeHash) {
      return {
        status: "unavailable",
        reasonCode: launch2PoolReasonCodes.routerCodeMismatch,
      };
    }
    const poolManager = await client.readContract({
      address: router as Address,
      abi: officialPoolRouterAbi,
      functionName: "poolManager",
    });
    return { status: "ok", poolManager: lower(poolManager) };
  }

  function override(
    token: string,
    entries: readonly { readonly slot: bigint; readonly value: bigint }[],
  ): StateOverride {
    return [
      {
        address: token as Address,
        stateDiff: entries.map((entry) => ({
          slot: slotHex(entry.slot),
          value: slotHex(entry.value),
        })),
      },
    ];
  }

  async function probe(
    token: string,
    owner: string,
    blockNumber: bigint,
  ): Promise<TokenLayout | null> {
    return probeErc20Layout(client, token, owner, router, blockNumber);
  }

  async function layoutOf(
    token: string,
    owner: string,
    blockNumber: bigint,
  ): Promise<TokenLayout | null> {
    const key = lower(token);
    if (layouts.has(key)) return layouts.get(key) ?? null;
    const layout = await probe(key, owner, blockNumber);
    layouts.set(key, layout);
    return layout;
  }

  async function stateOverrideFor(
    call: Launch2PoolCall,
  ): Promise<StateOverride | undefined | "unsupported"> {
    if (call.override === null) return undefined;
    const { token, balance, allowance } = call.override;
    const layout = await layoutOf(token, call.from, call.blockNumber);
    if (layout === null) return "unsupported";
    const entries = [
      {
        slot: nestedSlot(
          lower(call.from),
          router,
          layout.allowanceBase,
          layout.order,
        ),
        value: allowance,
      },
    ];
    if (balance !== null) {
      entries.push({
        slot: mappingSlot(lower(call.from), layout.balanceBase, layout.order),
        value: balance,
      });
    }
    return override(lower(token), entries);
  }

  return Object.freeze<Launch2PoolChain>({
    router,

    async verifyRouter() {
      if (verified?.status === "ok") return verified;
      if (verified !== null && now() - failedAt < retryAfterMs) {
        return verified;
      }
      if (inFlight !== null) return inFlight;
      inFlight = checkRouter()
        .then((result) => {
          verified = result;
          if (result.status !== "ok") failedAt = now();
          return result;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },

    async readPoolState(request): Promise<Launch2PoolChainState> {
      const block = await client.getBlock({ blockTag: "latest" });
      const at = block.number;
      const hook = request.hook as Address;
      const slot = keccak256(
        encodePacked(
          ["bytes32", "bytes32"],
          [request.poolId as Hex, slotHex(6n)],
        ),
      );
      const [hookPoolManager, currency0, currency1, curveUsd1] =
        await Promise.all([
          client.readContract({
            address: hook,
            abi: officialTaxHookAbi,
            functionName: "poolManager",
            blockNumber: at,
          }),
          client.readContract({
            address: hook,
            abi: officialTaxHookAbi,
            functionName: "currency0",
            blockNumber: at,
          }),
          client.readContract({
            address: hook,
            abi: officialTaxHookAbi,
            functionName: "currency1",
            blockNumber: at,
          }),
          client.readContract({
            address: request.curve as Address,
            abi: curveEngineAbi,
            functionName: "usd1",
            blockNumber: at,
          }),
        ]);
      const usd1 = lower(curveUsd1);
      const wallet = request.wallet as Address;
      const [slot0, usd1Balance, memeBalance, usd1Allowance, memeAllowance] =
        await Promise.all([
          client.readContract({
            address: hookPoolManager,
            abi: poolManagerAbi,
            functionName: "extsload",
            args: [slot],
            blockNumber: at,
          }),
          client.readContract({
            address: usd1 as Address,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [wallet],
            blockNumber: at,
          }),
          client.readContract({
            address: request.meme as Address,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [wallet],
            blockNumber: at,
          }),
          client.readContract({
            address: usd1 as Address,
            abi: erc20Abi,
            functionName: "allowance",
            args: [wallet, router as Address],
            blockNumber: at,
          }),
          client.readContract({
            address: request.meme as Address,
            abi: erc20Abi,
            functionName: "allowance",
            args: [wallet, router as Address],
            blockNumber: at,
          }),
        ]);
      return Object.freeze({
        blockNumber: at,
        blockHash: lower(block.hash),
        blockTimestamp: block.timestamp,
        hookPoolManager: lower(hookPoolManager),
        currency0: lower(currency0),
        currency1: lower(currency1),
        curveUsd1: usd1,
        sqrtPriceX96: BigInt(slot0) & ((1n << 160n) - 1n),
        usd1Balance,
        memeBalance,
        usd1Allowance,
        memeAllowance,
      });
    },

    async simulate(call): Promise<Launch2PoolSimulation> {
      const stateOverride = await stateOverrideFor(call);
      if (stateOverride === "unsupported") {
        return { status: "override_unsupported" };
      }
      try {
        const result = await client.call({
          account: call.from as Address,
          to: router as Address,
          data: call.data as Hex,
          blockNumber: call.blockNumber,
          ...(stateOverride === undefined ? {} : { stateOverride }),
        });
        const data = result.data ?? "0x";
        if (data.length < 66) {
          return { status: "reverted", errorName: null };
        }
        return { status: "ok", returned: BigInt(data.slice(0, 66)) };
      } catch (error) {
        const data = revertData(error);
        if (data === null) {
          // No revert data: a transport failure is not a revert.
          if (
            error instanceof BaseError &&
            /revert/iu.test(error.shortMessage)
          ) {
            return { status: "reverted", errorName: null };
          }
          throw error;
        }
        return { status: "reverted", errorName: launch2PoolErrorName(data) };
      }
    },

    async estimateGas(call) {
      const stateOverride = await stateOverrideFor(call);
      if (stateOverride === "unsupported") return null;
      try {
        return await client.estimateGas({
          account: call.from as Address,
          to: router as Address,
          data: call.data as Hex,
          ...(stateOverride === undefined ? {} : { stateOverride }),
        });
      } catch {
        return null;
      }
    },
  });
}
