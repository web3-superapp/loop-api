import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  checkLaunchpadAbi,
  extractAbi,
  formatAbiCheckReport,
} from "../src/integrations/launch/launchpad-abi-check.js";
import { launchpadAbiV1 } from "../src/integrations/launch/launchpad-abi.v1.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const jsonPath = path.join(
  repositoryRoot,
  "src/integrations/launch/launchpad-abi.v1.json",
);

type Entry = {
  type: string;
  name: string;
  inputs: { name: string; type: string; indexed?: boolean }[];
  outputs?: {
    name: string;
    type: string;
    components?: { name: string; type: string }[];
  }[];
};

function readJsonAbi(): Entry[] {
  return JSON.parse(readFileSync(jsonPath, "utf8")) as Entry[];
}

describe("LoopLaunchpad ABI v1 (Decision 0076, 06 §3/§4)", () => {
  it("publishes a JSON spec identical to the typed ABI the adapter uses", () => {
    expect(readJsonAbi()).toEqual(launchpadAbiV1);
  });

  it("has 14 events, 9 functions, and the 4 structs with 06 field order", () => {
    const abi = readJsonAbi();
    expect(abi.filter((entry) => entry.type === "event")).toHaveLength(14);
    expect(
      abi.filter((entry) => entry.type === "function").map((fn) => fn.name),
    ).toEqual([
      "buy",
      "claim",
      "claimRefund",
      "getState",
      "getRounds",
      "getSaleConfig",
      "quote",
      "getPosition",
      "getRoundPosition",
    ]);
    const struct = (fn: string) =>
      abi
        .find((entry) => entry.name === fn)
        ?.outputs?.[0]?.components?.map(
          (field) => `${field.type} ${field.name}`,
        );
    expect(struct("getState")).toEqual([
      "uint8 saleState",
      "uint8 entitlementState",
      "uint8 liquidityState",
      "uint8 operationalState",
      "bytes32 configVersion",
      "bytes32 stateTupleDigest",
    ]);
    expect(struct("getRounds")).toEqual([
      "uint16 roundId",
      "uint64 startAt",
      "uint64 endAt",
      "uint256 priceUsd1PerToken",
      "uint256 roundCapUsd1",
      "uint256 walletRoundCapUsd1",
      "bytes32 allowlistRoot",
      "uint256 raisedUsd1",
    ]);
    expect(struct("getSaleConfig")).toEqual([
      "address projectToken",
      "address usd1",
      "uint256 softCapUsd1",
      "uint256 hardCapUsd1",
      "uint256 walletProjectCapUsd1",
      "uint256 minPurchaseUsd1",
      "uint16 protocolFeeBps",
      "uint16 liquidityBps",
      "uint16 tgeBps",
      "uint32 cliffSeconds",
      "uint32 vestingSeconds",
      "uint24 poolFeeTier",
      "uint32 lpLockSeconds",
      "bytes32 configVersion",
    ]);
    expect(struct("getPosition")).toEqual([
      "uint256 cumulativeUsd1",
      "uint256 purchasedTokens",
      "uint256 entitledTokens",
      "uint256 claimableTokens",
      "uint256 claimedTokens",
      "uint256 refundableUsd1",
      "uint256 refundedUsd1",
    ]);
    expect(
      abi
        .find((entry) => entry.name === "buy")
        ?.inputs.map((input) => `${input.type} ${input.name}`),
    ).toEqual([
      "uint256 saleId",
      "uint16 roundId",
      "uint256 usd1Amount",
      "uint256 minTokenAmount",
      "uint64 deadline",
      "bytes32[] eligibilityProof",
    ]);
    // saleId is the first, indexed parameter of every event.
    for (const event of abi.filter((entry) => entry.type === "event")) {
      expect(event.inputs[0]).toMatchObject({
        name: "saleId",
        type: "uint256",
        indexed: true,
      });
    }
  });

  it("checks v1 against itself with every item passing", () => {
    const abi = readJsonAbi();
    const report = checkLaunchpadAbi(abi, abi);
    expect(report.passed).toBe(true);
    expect(report.items.filter((item) => item.status === "pass")).toHaveLength(
      23,
    );
    expect(formatAbiCheckReport(report)).toContain(
      "ABI v1 check passed: 23 items ✓",
    );
  });

  it("fails a copy with one renamed event and accepts an artifact with extra OpenZeppelin items", () => {
    const abi = readJsonAbi();
    const renamed = abi.map((entry) =>
      entry.name === "Purchased" ? { ...entry, name: "Bought" } : entry,
    );
    const report = checkLaunchpadAbi(abi, renamed);
    expect(report.passed).toBe(false);
    expect(
      report.items.filter((item) => item.status === "fail").map((i) => i.name),
    ).toEqual(["Purchased"]);
    expect(formatAbiCheckReport(report)).toMatch(/✗ event Purchased\(/);

    const withExtras = extractAbi({
      abi: [
        ...abi,
        {
          type: "event",
          name: "Paused",
          anonymous: false,
          inputs: [{ name: "account", type: "address", indexed: false }],
        },
        {
          type: "function",
          name: "pause",
          stateMutability: "nonpayable",
          inputs: [{ name: "saleId", type: "uint256" }],
          outputs: [],
        },
      ],
    });
    const tolerant = checkLaunchpadAbi(abi, withExtras);
    expect(tolerant.passed).toBe(true);
    expect(
      tolerant.items.filter((item) => item.status === "info"),
    ).toHaveLength(2);
  });

  it("fails a moved indexed flag, a reordered struct field, and a changed buy parameter", () => {
    const abi = readJsonAbi();
    const movedIndex = abi.map((entry) =>
      entry.name === "Claimed"
        ? {
            ...entry,
            inputs: entry.inputs.map((input) =>
              input.name === "wallet" ? { ...input, indexed: false } : input,
            ),
          }
        : entry,
    );
    expect(checkLaunchpadAbi(abi, movedIndex).passed).toBe(false);
    const reordered = abi.map((entry) =>
      entry.name === "getPosition"
        ? {
            ...entry,
            outputs: entry.outputs?.map((output) => ({
              ...output,
              components: [...(output.components ?? [])].reverse(),
            })),
          }
        : entry,
    );
    const reorderedReport = checkLaunchpadAbi(abi, reordered);
    expect(
      reorderedReport.items.find((item) => item.name === "getPosition")?.status,
    ).toBe("fail");
    const buyChanged = abi.map((entry) =>
      entry.name === "buy"
        ? {
            ...entry,
            inputs: entry.inputs.map((input) =>
              input.name === "deadline" ? { ...input, type: "uint256" } : input,
            ),
          }
        : entry,
    );
    expect(
      checkLaunchpadAbi(abi, buyChanged).items.find(
        (item) => item.name === "buy",
      )?.status,
    ).toBe("fail");
  });

  it("runs as pnpm launch:abi-check with exit 0 for v1 and exit 1 for a renamed event", () => {
    const tsx = path.join(repositoryRoot, "node_modules/.bin/tsx");
    const script = path.join(repositoryRoot, "scripts/launch-abi-check.ts");
    const ok = execFileSync(tsx, [script, jsonPath], { encoding: "utf8" });
    expect(ok).toContain("ABI v1 check passed");
    const directory = mkdtempSync(path.join(tmpdir(), "loop-abi-"));
    const renamedPath = path.join(directory, "renamed.json");
    writeFileSync(
      renamedPath,
      JSON.stringify(
        readJsonAbi().map((entry) =>
          entry.name === "Refunded" ? { ...entry, name: "Refund" } : entry,
        ),
      ),
    );
    let status = 0;
    let output = "";
    try {
      execFileSync(tsx, [script, renamedPath], { encoding: "utf8" });
    } catch (error) {
      status = (error as { status: number }).status;
      output = String((error as { stdout: string }).stdout);
    }
    expect(status).toBe(1);
    expect(output).toMatch(/✗ event Refunded\(/);
  });
});
