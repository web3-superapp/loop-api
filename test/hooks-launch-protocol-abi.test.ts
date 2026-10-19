import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BaseError,
  HttpRequestError,
  decodeErrorResult,
  toFunctionSelector,
} from "viem";
import { describe, expect, it } from "vitest";

import {
  hooksLaunchAbiSelection,
  selectHooksLaunchAbi,
} from "../scripts/hooks-launch-abi-selection.js";
import { classifyHooksLaunchSendError } from "../src/integrations/launch/hooks-launch-executor-chain.js";
import * as generated from "../src/integrations/launch/hooks-launch-protocol-abi.generated.js";

/**
 * Decision 0112: the executor ABI is generated from the loop-contracts
 * Foundry build, never hand-written. When the protocol build is present
 * (local checkout), the committed module must equal it.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const protocolOut = [
  process.env["LOOP_PROTOCOL_DIR"],
  path.resolve(root, "../loop-contracts/protocol"),
  path.resolve(root, "../../loop-contracts/protocol"),
]
  .filter((entry): entry is string => entry !== undefined)
  .map((entry) => path.join(entry, "out"))
  // Decision 0131: a checkout whose build predates the selection (an
  // artifact missing) is not the current build; the parity check skips.
  // Decision 0144: so is one whose artifacts lack a selected item (a
  // pre-S193 build without `maxDynamicFeeWad`).
  .find((entry) =>
    Object.entries(hooksLaunchAbiSelection).every(([contract, names]) => {
      const file = path.join(entry, `${contract}.sol`, `${contract}.json`);
      if (!existsSync(file)) return false;
      const artifact = JSON.parse(readFileSync(file, "utf8")) as {
        readonly abi?: readonly { readonly name?: string }[];
      };
      const present = new Set((artifact.abi ?? []).map((item) => item.name));
      return names.every((name) => present.has(name));
    }),
  );

const exportName = (contract: string) =>
  `${contract.charAt(0).toLowerCase()}${contract.slice(1)}Abi`;

describe("Hooks launch protocol ABI (Decision 0112)", () => {
  it("exports every selected contract with every selected item", () => {
    for (const [contract, names] of Object.entries(hooksLaunchAbiSelection)) {
      const abi = (generated as Record<string, unknown>)[
        exportName(contract)
      ] as readonly { readonly name?: string }[];
      expect(Array.isArray(abi), contract).toBe(true);
      for (const name of names) {
        expect(
          abi.some((item) => item.name === name),
          `${contract}.${name}`,
        ).toBe(true);
      }
    }
  });

  it.skipIf(protocolOut === undefined)(
    "equals the current loop-contracts Foundry build",
    () => {
      const artifacts: Record<string, unknown> = {};
      for (const contract of Object.keys(hooksLaunchAbiSelection)) {
        artifacts[contract] = JSON.parse(
          readFileSync(
            path.join(protocolOut!, `${contract}.sol`, `${contract}.json`),
            "utf8",
          ),
        );
      }
      const selected = selectHooksLaunchAbi(artifacts);
      for (const [contract, abi] of Object.entries(selected)) {
        expect(
          (generated as Record<string, unknown>)[exportName(contract)],
          contract,
        ).toEqual(abi);
      }
    },
  );

  it("carries the S242 field errors with their selectors (Decision 0164)", () => {
    expect(toFunctionSelector("InvalidName()")).toBe("0x430f13b3");
    expect(toFunctionSelector("InvalidTicker()")).toBe("0x9ceb5e72");
    for (const abi of [
      generated.loopLaunchFactoryAbi,
      generated.loopDynamicLaunchFactoryAbi,
    ]) {
      expect(decodeErrorResult({ abi, data: "0x430f13b3" }).errorName).toBe(
        "InvalidName",
      );
      expect(decodeErrorResult({ abi, data: "0x9ceb5e72" }).errorName).toBe(
        "InvalidTicker",
      );
    }
  });

  it("classifies node refusals without swallowing transport failures", () => {
    const refusal = (details: string) =>
      new BaseError("Transaction failed", { details });
    expect(classifyHooksLaunchSendError(refusal("already known"))).toBe(
      "known",
    );
    expect(classifyHooksLaunchSendError(refusal("nonce too low"))).toBe(
      "nonce_too_low",
    );
    expect(
      classifyHooksLaunchSendError(refusal("insufficient funds for gas")),
    ).toBe("insufficient_funds");
    expect(classifyHooksLaunchSendError(refusal("intrinsic gas too low"))).toBe(
      "rejected",
    );
    expect(() =>
      classifyHooksLaunchSendError(
        new HttpRequestError({ url: "https://rpc.invalid", status: 502 }),
      ),
    ).toThrow();
  });
});
