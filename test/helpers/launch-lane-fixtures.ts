/**
 * TEST ONLY (Decision 0077). Builds `launch_event` lane inputs from raw logs
 * encoded through ABI v1 (`encodeLaunchpadLog`) and decoded by the real
 * decoder, so a fixture row is exactly what the lane would store for a v1
 * contract. Every address, amount, and block below is a test fixture, never a
 * product parameter or a chain fact.
 */
import { decodeLaunchpadLogs } from "../../src/integrations/launch/launch-contract-adapter.js";
import type { LaunchContractLog } from "../../src/integrations/launch/launch-contract-adapter.js";
import { toLaunchIndexedEvent } from "../../src/bsc-launch-indexer-worker.js";
import type { LaunchIndexedEventInput } from "../../src/features/launch/launch-chain-repository.js";
import { encodeLaunchpadLog } from "./launchpad-mock-chain.js";

export type LaunchpadEventName = Parameters<typeof encodeLaunchpadLog>[0];

export function fixtureBlockHash(block: bigint): string {
  return `0x${block.toString(16).padStart(64, "b")}`;
}

export function fixtureTxHash(block: bigint, logIndex: number): string {
  return `0x${`${block.toString(16)}${logIndex.toString(16).padStart(4, "0")}`.padStart(64, "c")}`;
}

export function fixtureLog(
  name: LaunchpadEventName,
  args: Readonly<Record<string, unknown>>,
  at: { readonly block: bigint; readonly logIndex: number },
): LaunchContractLog {
  return {
    ...encodeLaunchpadLog(name, args, at.logIndex),
    blockNumber: at.block,
    blockHash: fixtureBlockHash(at.block),
    transactionHash: fixtureTxHash(at.block, at.logIndex),
  };
}

export function fixtureEvent(
  launchId: string,
  name: LaunchpadEventName,
  args: Readonly<Record<string, unknown>>,
  at: { readonly block: bigint; readonly logIndex: number },
): LaunchIndexedEventInput {
  const decoded = decodeLaunchpadLogs([fixtureLog(name, args, at)]).events[0];
  if (decoded === undefined) {
    throw new Error(`fixture ${name} did not decode`);
  }
  return toLaunchIndexedEvent(decoded, launchId);
}

export const oneUsd1 = 10n ** 18n;
