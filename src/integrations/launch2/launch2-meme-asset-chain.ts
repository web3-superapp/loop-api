import {
  createPublicClient,
  erc20Abi,
  fallback,
  http,
  type Address,
  type Transport,
} from "viem";
import { bscTestnet } from "viem/chains";

import type { Launch2TokenIdentityReader } from "../../features/launch2/launch2-meme-assets.js";

/**
 * Decision 0125: reads a launch2 MEME's `symbol()` / `name()` /
 * `decimals()` pinned to one block on the launch slot (BSC Testnet), the
 * same three facts `pnpm asset:register` records. It never signs or sends.
 */
export function createLaunch2TokenIdentityReader(input: {
  readonly rpcUrls: readonly string[];
  /** Test seam (anvil); production uses the RPC URL list. */
  readonly transport?: Transport;
  readonly expectedChainId?: number;
}): Launch2TokenIdentityReader {
  const transport =
    input.transport ??
    fallback(
      input.rpcUrls.map((url) => http(url, { timeout: 10_000, retryCount: 1 })),
      { retryCount: 0 },
    );
  const client = createPublicClient({ chain: bscTestnet, transport });
  const expectedChainId = input.expectedChainId ?? 97;
  return Object.freeze({
    async readTokenIdentity(address: string) {
      if ((await client.getChainId()) !== expectedChainId) {
        throw new Error("LAUNCH2_CHAIN_MISMATCH");
      }
      const blockNumber = await client.getBlockNumber();
      const contract = { address: address as Address, abi: erc20Abi } as const;
      const [symbol, name, decimals] = await Promise.all([
        client.readContract({
          ...contract,
          functionName: "symbol",
          blockNumber,
        }),
        client.readContract({ ...contract, functionName: "name", blockNumber }),
        client.readContract({
          ...contract,
          functionName: "decimals",
          blockNumber,
        }),
      ]);
      return Object.freeze({
        symbol: symbol.trim(),
        name: name.trim(),
        decimals: Number(decimals),
        blockNumber,
      });
    },
  });
}
