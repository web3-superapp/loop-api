/**
 * TEST ONLY (Decision 0101). Encoded LoopMemeCurve logs and fixture
 * addresses. Every value is a test fixture, not a chain fact — except the
 * testnet CREATE2 pair, which was read from the deployed curve with
 * `predictTokenAddress` on 2026-10-08.
 */
import {
  encodeAbiParameters,
  encodeEventTopics,
  type AbiEvent,
  type Hex,
} from "viem";

import type { MemeContractLog } from "../../src/integrations/meme/meme-contract-adapter.js";
import { memeCurveAbiV1 } from "../../src/integrations/meme/meme-abi.v1.js";

export const memeCurveAddress = "0xe108d45e3e9d7b8c9c02c5e10544ad811cb39b8a";
export const memeTokenImplementation =
  "0xa87a54dc67e407e8b6d67e690abdfe02f979f4da";
/** `predictTokenAddress(0xabab…ab)` on the BSC testnet curve above. */
export const onChainPrediction = Object.freeze({
  salt: `0x${"ab".repeat(32)}`,
  address: "0xac42e9101f379437f3cce49a5b58609dd9a0ca94",
});
export const fakeUsd1 = "0x17d554fd27345940e21d1d7328d038bd4049ce2b";

export function fixtureBlockHash(block: bigint): string {
  return `0x${block.toString(16).padStart(64, "0")}`;
}

export function fixtureTxHash(seed: number): string {
  return `0x${seed.toString(16).padStart(64, "0")}`;
}

function eventOf(name: string): AbiEvent {
  const event = memeCurveAbiV1.find(
    (entry) => entry.type === "event" && entry.name === name,
  );
  if (event === undefined) {
    throw new Error(`no event ${name}`);
  }
  return event as AbiEvent;
}

/** Encodes one curve event as a raw log of `memeCurveAddress`. */
export function memeLog(input: {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly blockNumber: bigint;
  readonly logIndex: number;
  readonly transactionHash: string;
  readonly removed?: boolean;
  readonly address?: string;
}): MemeContractLog {
  const event = eventOf(input.name);
  const topics = encodeEventTopics({
    abi: [event],
    eventName: event.name,
    args: Object.fromEntries(
      event.inputs
        .filter((parameter) => parameter.indexed === true)
        .map((parameter) => [
          parameter.name as string,
          input.args[parameter.name as string],
        ]),
    ),
  }) as readonly Hex[];
  const dataInputs = event.inputs.filter(
    (parameter) => parameter.indexed !== true,
  );
  const data = encodeAbiParameters(
    dataInputs,
    dataInputs.map((parameter) => input.args[parameter.name as string]),
  );
  return Object.freeze({
    address: input.address ?? memeCurveAddress,
    topics: topics.map((topic) => topic.toLowerCase()),
    data: data.toLowerCase(),
    blockNumber: input.blockNumber,
    blockHash: fixtureBlockHash(input.blockNumber),
    transactionHash: input.transactionHash,
    logIndex: input.logIndex,
    removed: input.removed ?? false,
  });
}
