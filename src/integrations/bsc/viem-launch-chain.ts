import type { Chain } from "viem";
import { bsc, bscTestnet } from "viem/chains";

/**
 * Decision 0150: viem's chain definition for a launch-slot reference. The
 * adapters used to pin `bscTestnet`; they now follow the configured slot
 * (56 = `bsc`, anything else = `bscTestnet`, the pre-0150 default).
 */
export function viemLaunchChain(reference: number): Chain {
  return reference === 56 ? bsc : bscTestnet;
}
