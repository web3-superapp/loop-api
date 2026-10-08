import { readFileSync } from "node:fs";

import { decodeFunctionData, toEventSelector } from "viem";
import { describe, expect, it } from "vitest";

import {
  memeCloneInitCodeHash,
  mineMemeSalts,
  predictMemeTokenAddress,
  randomMemeSalt,
} from "../src/features/meme/meme-create2.js";
import {
  checkMemeCurveAbi,
  extractAbi,
  formatAbiCheckReport,
} from "../src/integrations/meme/meme-abi-check.js";
import { memeCurveAbiV1 } from "../src/integrations/meme/meme-abi.v1.js";
import {
  MemeContractUnavailableError,
  decodeMemeCurveLogs,
  encodeMemeBuyCalldata,
  encodeMemeCreateTokenCalldata,
  encodeMemeGraduateCalldata,
  encodeMemeSellCalldata,
} from "../src/integrations/meme/meme-contract-adapter.js";
import {
  fixtureTxHash,
  memeCurveAddress,
  memeLog,
  memeTokenImplementation,
  onChainPrediction,
} from "./helpers/meme-fixtures.js";

/** Decision 0101: the LoopMemeCurve ABI v1, abi-check, calldata, logs, CREATE2. */

const reference = JSON.parse(
  readFileSync(
    new URL("../src/integrations/meme/meme-abi.v1.json", import.meta.url),
    "utf8",
  ),
) as unknown;
const token = "0x1111111111111111111111111111111111111111";
const wallet = "0x2222222222222222222222222222222222222222";

describe("LoopMemeCurve ABI v1 (Decision 0101)", () => {
  it("publishes exactly the TypeScript ABI as JSON", () => {
    expect(reference).toEqual(JSON.parse(JSON.stringify(memeCurveAbiV1)));
  });

  it("passes abi-check against itself and against an artifact wrapper", () => {
    const abi = extractAbi(reference);
    const report = checkMemeCurveAbi(abi, abi);
    expect(report.passed).toBe(true);
    expect(checkMemeCurveAbi(abi, extractAbi({ abi })).passed).toBe(true);
    expect(formatAbiCheckReport(report)).toContain("ABI v1 check passed");
    // docs/10 §3.3 event names and indexed flags are part of the contract.
    expect(
      report.items.filter(
        (item) => item.kind === "event" && item.status === "pass",
      ),
    ).toHaveLength(
      memeCurveAbiV1.filter((entry) => entry.type === "event").length,
    );
  });

  it("fails abi-check on a renamed parameter, a lost indexed flag, or a missing call", () => {
    const abi = extractAbi(reference) as readonly Record<string, unknown>[];
    const unindexed = abi.map((entry) =>
      entry["name"] === "Trade"
        ? {
            ...entry,
            inputs: (entry["inputs"] as Record<string, unknown>[]).map(
              (input) =>
                input["name"] === "wallet"
                  ? { ...input, indexed: false }
                  : input,
            ),
          }
        : entry,
    );
    const failed = checkMemeCurveAbi(abi, unindexed);
    expect(failed.passed).toBe(false);
    expect(formatAbiCheckReport(failed)).toContain("FAILED");
    const withoutBuy = abi.filter((entry) => entry["name"] !== "buy");
    expect(checkMemeCurveAbi(abi, withoutBuy).passed).toBe(false);
    const withoutError = abi.filter(
      (entry) => !(entry["type"] === "error" && entry["name"] === "SaltUsed"),
    );
    expect(checkMemeCurveAbi(abi, withoutError).passed).toBe(false);
    const extra = [
      ...abi,
      { type: "function", name: "skim", inputs: [], outputs: [] },
    ];
    const informational = checkMemeCurveAbi(abi, extra);
    expect(informational.passed).toBe(true);
    expect(
      informational.items.some(
        (item) => item.status === "info" && item.name === "skim",
      ),
    ).toBe(true);
  });

  it("encodes the four user calls in docs/10 §3.2 parameter order", () => {
    const create = encodeMemeCreateTokenCalldata({
      salt: onChainPrediction.salt,
      name: "Frog",
      symbol: "FROG",
      metadataHash: `0x${"cd".repeat(32)}`,
      initialBuyUsd1: 10n ** 19n,
      minTokensOut: 5n,
    });
    expect(
      decodeFunctionData({ abi: memeCurveAbiV1, data: create }).args,
    ).toEqual([
      onChainPrediction.salt,
      "Frog",
      "FROG",
      `0x${"cd".repeat(32)}`,
      10n ** 19n,
      5n,
    ]);
    const buy = encodeMemeBuyCalldata({
      token,
      usd1In: 7n,
      minTokensOut: 3n,
      deadline: 1_790_000_000n,
    });
    expect(decodeFunctionData({ abi: memeCurveAbiV1, data: buy })).toEqual({
      functionName: "buy",
      args: [token, 7n, 3n, 1_790_000_000n],
    });
    const sell = encodeMemeSellCalldata({
      token,
      tokensIn: 9n,
      minUsd1Out: 1n,
      deadline: 1_790_000_000n,
    });
    expect(
      decodeFunctionData({ abi: memeCurveAbiV1, data: sell }).functionName,
    ).toBe("sell");
    expect(encodeMemeGraduateCalldata(token).slice(0, 10)).toBe("0xff6d8d05");
    expect(() =>
      encodeMemeBuyCalldata({
        token,
        usd1In: -1n,
        minTokensOut: 0n,
        deadline: 0n,
      }),
    ).toThrow(RangeError);
  });

  it("decodes the lane's events and counts the ones it does not consume", () => {
    const logs = [
      memeLog({
        name: "TokenCreated",
        args: {
          token,
          creator: wallet,
          salt: onChainPrediction.salt,
          metadataHash: `0x${"cd".repeat(32)}`,
          name: "Frog",
          symbol: "FROG",
          at: 1_790_000_000n,
        },
        blockNumber: 10n,
        logIndex: 0,
        transactionHash: fixtureTxHash(1),
      }),
      memeLog({
        name: "Trade",
        args: {
          token,
          wallet,
          isBuy: true,
          usd1Amount: 10n,
          tokenAmount: 20n,
          feeUsd1: 1n,
          vUsd1After: 30n,
          vTokenAfter: 40n,
          soldAfter: 50n,
          at: 1_790_000_001n,
        },
        blockNumber: 10n,
        logIndex: 1,
        transactionHash: fixtureTxHash(1),
      }),
      memeLog({
        name: "GraduationResidual",
        args: { token, usd1Left: 3n, tokensLeft: 4n },
        blockNumber: 11n,
        logIndex: 0,
        transactionHash: fixtureTxHash(2),
      }),
      memeLog({
        name: "TreasuryChanged",
        args: { from: wallet, to: token },
        blockNumber: 11n,
        logIndex: 1,
        transactionHash: fixtureTxHash(2),
      }),
    ];
    const decoded = decodeMemeCurveLogs(logs);
    expect(decoded.ignored).toBe(1);
    expect(decoded.events.map((event) => event.eventName)).toEqual([
      "TokenCreated",
      "Trade",
      "GraduationResidual",
    ]);
    expect(decoded.events[1]).toMatchObject({
      eventName: "Trade",
      token,
      wallet,
      isBuy: true,
      soldAfter: 50n,
      address: memeCurveAddress,
    });
    // A matching topic with a broken body means the contract is not v1.
    const broken = { ...logs[1]!, data: "0x1234" };
    expect(() => decodeMemeCurveLogs([broken])).toThrow(
      MemeContractUnavailableError,
    );
    expect(
      toEventSelector(
        "Trade(address,address,bool,uint256,uint256,uint256,uint256,uint256,uint256,uint64)",
      ),
    ).toBe(logs[1]!.topics[0]);
  });
});

describe("offline CREATE2 prediction (Decision 0101)", () => {
  it("matches the deployed curve's predictTokenAddress", () => {
    expect(
      predictMemeTokenAddress({
        deployer: memeCurveAddress,
        implementation: memeTokenImplementation,
        salt: onChainPrediction.salt,
      }),
    ).toBe(onChainPrediction.address);
  });

  it("mines salts whose predicted address ends in the suffix", () => {
    let counter = 0;
    const random = (bytes: number): Buffer => {
      counter += 1;
      return Buffer.from(counter.toString(16).padStart(bytes * 2, "0"), "hex");
    };
    const mined = mineMemeSalts({
      deployer: memeCurveAddress,
      implementation: memeTokenImplementation,
      suffix: "6",
      count: 3,
      maximumAttempts: 1_000,
      random,
    });
    expect(mined).toHaveLength(3);
    for (const item of mined) {
      expect(item.predictedAddress.endsWith("6")).toBe(true);
      expect(
        predictMemeTokenAddress({
          deployer: memeCurveAddress,
          implementation: memeTokenImplementation,
          salt: item.salt,
          initCodeHash: memeCloneInitCodeHash(memeTokenImplementation),
        }),
      ).toBe(item.predictedAddress);
    }
    expect(
      mineMemeSalts({
        deployer: memeCurveAddress,
        implementation: memeTokenImplementation,
        suffix: "ffffffff",
        count: 1,
        maximumAttempts: 10,
      }),
    ).toEqual([]);
    expect(() =>
      mineMemeSalts({
        deployer: memeCurveAddress,
        implementation: memeTokenImplementation,
        suffix: "xyz",
        count: 1,
        maximumAttempts: 1,
      }),
    ).toThrow(RangeError);
    const random32 = randomMemeSalt({
      deployer: memeCurveAddress,
      implementation: memeTokenImplementation,
    });
    expect(random32.salt).toMatch(/^0x[0-9a-f]{64}$/);
    expect(random32.predictedAddress).toMatch(/^0x[0-9a-f]{40}$/);
  });
});
