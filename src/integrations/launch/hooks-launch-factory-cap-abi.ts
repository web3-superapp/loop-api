import { decodeEventLog, type Abi } from "viem";

/**
 * Decision 0195 (LOOP Decision 0268, loop-contracts Decision 0018, S340):
 * hand-written fragments of the `LoopLaunchFactoryCore` purchase-cap
 * surface shared by both Factory lines. The generated protocol ABI
 * (`hooks-launch-protocol-abi.generated.ts`, source b440c4c) predates S340
 * and the contracts' ABI export does not cover the protocol factories, so
 * these are pinned here (selectors / topics asserted in the tests):
 *
 * - `maxCumulativeBuy()` `0x4c4d8734` — unchanged getter, now storage;
 * - `setMaxCumulativeBuy(uint256)` `0xcfc64a43` — admin (governance Safe)
 *   only; this backend never sends it;
 * - `MaxCumulativeBuyUpdated(uint256 previousCap, uint256 newCap)` topic0
 *   `0x05779db6…56e4cc` (also emitted at construction, previous = 0);
 * - `LaunchMaxCumulativeBuy(bytes32 indexed launchId, address indexed
 *   curve, uint256 maxCumulativeBuy)` topic0 `0xc6080497…c5fc2d`, emitted
 *   by `deployLaunch` right before `LaunchDeployed` with the value the
 *   launch's `CurveEngine` received.
 */
export const hooksLaunchFactoryCapAbi = [
  {
    type: "function",
    name: "maxCumulativeBuy",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "setMaxCumulativeBuy",
    stateMutability: "nonpayable",
    inputs: [{ name: "newCap", type: "uint256" }],
    outputs: [],
  },
  {
    type: "event",
    name: "MaxCumulativeBuyUpdated",
    anonymous: false,
    inputs: [
      { name: "previousCap", type: "uint256", indexed: false },
      { name: "newCap", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "LaunchMaxCumulativeBuy",
    anonymous: false,
    inputs: [
      { name: "launchId", type: "bytes32", indexed: true },
      { name: "curve", type: "address", indexed: true },
      { name: "maxCumulativeBuy", type: "uint256", indexed: false },
    ],
  },
] as const satisfies Abi;

export const hooksLaunchMaxCumulativeBuyUpdatedTopic =
  "0x05779db6c9acbc36c463616b29c6a221f1e9ad9874da4cb47752f5f25b56e4cc";
export const hooksLaunchLaunchMaxCumulativeBuyTopic =
  "0xc6080497ec822e7cd697e9d642c57ba5e074d91d6659e08625cf3f91e9c5fc2d";

interface RawLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}

/**
 * The `LaunchMaxCumulativeBuy` of `factory` in a receipt's logs (lowercase
 * hex; the cap as a bigint), or null when there is none (an S209 or older
 * Factory) or it does not decode.
 */
export function parseHooksLaunchMaxCumulativeBuyLog(
  logs: readonly RawLog[],
  factory: string,
): {
  readonly launchId: string;
  readonly curve: string;
  readonly maxCumulativeBuy: bigint;
} | null {
  for (const log of logs) {
    if (
      log.address.toLowerCase() !== factory.toLowerCase() ||
      log.topics[0]?.toLowerCase() !== hooksLaunchLaunchMaxCumulativeBuyTopic
    ) {
      continue;
    }
    try {
      const decoded = decodeEventLog({
        abi: hooksLaunchFactoryCapAbi,
        eventName: "LaunchMaxCumulativeBuy",
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
        data: log.data as `0x${string}`,
      });
      return Object.freeze({
        launchId: decoded.args.launchId.toLowerCase(),
        curve: decoded.args.curve.toLowerCase(),
        maxCumulativeBuy: decoded.args.maxCumulativeBuy,
      });
    } catch {
      return null;
    }
  }
  return null;
}

/** A decoded `MaxCumulativeBuyUpdated` (previous = 0 at construction). */
export function parseHooksLaunchMaxCumulativeBuyUpdatedLog(log: RawLog): {
  readonly previousCap: bigint;
  readonly newCap: bigint;
} | null {
  if (
    log.topics[0]?.toLowerCase() !== hooksLaunchMaxCumulativeBuyUpdatedTopic
  ) {
    return null;
  }
  try {
    const decoded = decodeEventLog({
      abi: hooksLaunchFactoryCapAbi,
      eventName: "MaxCumulativeBuyUpdated",
      topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      data: log.data as `0x${string}`,
    });
    return Object.freeze({
      previousCap: decoded.args.previousCap,
      newCap: decoded.args.newCap,
    });
  } catch {
    return null;
  }
}
