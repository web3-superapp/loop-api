import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { check } from "prettier";
import {
  custom,
  encodeAbiParameters,
  keccak256,
  toEventSelector,
  toFunctionSelector,
  type AbiFunction,
} from "viem";
import { describe, expect, it } from "vitest";

import {
  formatHooksLaunchAbiModule,
  renderHooksLaunchAbiModule,
} from "../scripts/hooks-launch-abi-selection.js";
import {
  HooksLaunchRequestTermsMissingError,
  hooksLaunchProjectTermsTupleComponents,
} from "../src/features/launch/hooks-launch-project-terms.js";
import { createHooksLaunchExecutorChain } from "../src/integrations/launch/hooks-launch-executor-chain.js";
import { createHooksLaunchFactoryReader } from "../src/integrations/launch/hooks-launch-factory-reader.js";
import {
  buybackExecutorAbi,
  loopDynamicLaunchFactoryAbi,
  loopLaunchFactoryAbi,
} from "../src/integrations/launch/hooks-launch-protocol-abi.generated.js";

/**
 * Decision 0200: the S359 Factory surface comes from `pnpm hooks:abi-sync`
 * (the hand-written terms fragments are gone); pre-S359 requests (no
 * terms) are never encoded.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseRequestFields = [
  ["projectOwner", "address"],
  ["configVersion", "uint32"],
  ["configHash", "bytes32"],
  ["name", "string"],
  ["ticker", "string"],
  ["nftSaleStart", "uint64"],
  ["buybackRecipient", "address"],
  ["deadline", "uint64"],
  ["memeSalt", "bytes32"],
] as const;

type AbiEntry = { readonly type: string; readonly name?: string };

function abiFunction(abi: readonly unknown[], name: string): AbiFunction {
  const item = (abi as readonly AbiEntry[]).find(
    (entry) => entry.type === "function" && entry.name === name,
  );
  expect(item, name).toBeDefined();
  return item as AbiFunction;
}

function requestTuple(abi: readonly unknown[], name: string) {
  const tuple = abiFunction(abi, name).inputs[0] as {
    readonly type: string;
    readonly components: readonly { name: string; type: string }[];
  };
  expect(tuple.type).toBe("tuple");
  return tuple.components.map((c) => [c.name, c.type]);
}

const request = {
  projectOwner: "0x00000000000000000000000000000000000000a1",
  configVersion: 1,
  configHash: `0x${"11".repeat(32)}`,
  name: "LOOP",
  ticker: "MEME",
  nftSaleStart: "1800000000",
  buybackRecipient: "0x00000000000000000000000000000000000000b1",
  deadline: "1800000900",
  memeSalt: `0x${"22".repeat(32)}`,
};
const terms = {
  nftPrice: "300000000000000000000",
  maxCumulativeBuy: "5000000000000000000000000",
};

describe("Decision 0200: S359 ABI from hooks:abi-sync", () => {
  it.each([
    ["LoopLaunchFactory", loopLaunchFactoryAbi, "deployLaunch"],
    ["LoopLaunchFactory", loopLaunchFactoryAbi, "previewHookInitCodeHash"],
    ["LoopDynamicLaunchFactory", loopDynamicLaunchFactoryAbi, "deployLaunch"],
    [
      "LoopDynamicLaunchFactory",
      loopDynamicLaunchFactoryAbi,
      "previewLoopHookInitCodeHash",
    ],
  ] as const)(
    "%s.%s takes the 11-field request ending in the project terms",
    (_contract, abi, name) => {
      expect(requestTuple(abi, name)).toEqual([
        ...baseRequestFields,
        ...hooksLaunchProjectTermsTupleComponents.map((c) => [c.name, c.type]),
      ]);
    },
  );

  it("pins the S359 selectors, event topic and module getters", () => {
    const deploy = abiFunction(loopLaunchFactoryAbi, "deployLaunch");
    expect(toFunctionSelector(deploy)).toBe("0xd2d589a0");
    for (const abi of [loopLaunchFactoryAbi, loopDynamicLaunchFactoryAbi]) {
      const probe = abiFunction(abi, "DEFAULT_NFT_PRICE");
      expect(toFunctionSelector(probe)).toBe("0xef14e547");
      const event = (abi as readonly { type: string; name?: string }[]).find(
        (i) => i.type === "event" && i.name === "LaunchNftPrice",
      );
      expect(toEventSelector(event as never).toLowerCase()).toBe(
        "0x3931ee0db3404c939a8f1852f3fb42f26ce5af6fdacbd8ace77864fa1fc6b96a",
      );
    }
    const getters = (buybackExecutorAbi as readonly AbiEntry[])
      .filter((i) => i.type === "function")
      .map((i) => i.name);
    expect(getters).toEqual(
      expect.arrayContaining(["orderAmount", "ORDER_AMOUNT"]),
    );
  });

  it("writes the generated module in the repository's Prettier format", async () => {
    const target = path.join(
      root,
      "src/integrations/launch/hooks-launch-protocol-abi.generated.ts",
    );
    const raw = renderHooksLaunchAbiModule(
      { LoopRouterRegistry: [{ type: "function", name: "admin" }] },
      "e40a593",
    );
    expect(await check(raw, { filepath: target })).toBe(false);
    const formatted = await formatHooksLaunchAbiModule(raw, target);
    expect(await check(formatted, { filepath: target })).toBe(true);
    // The committed file is already formatted (no follow-up `pnpm format`).
    expect(
      await formatHooksLaunchAbiModule(readFileSync(target, "utf8"), target),
    ).toBe(readFileSync(target, "utf8"));
  });
});

describe("Decision 0200: requests without terms are not encoded", () => {
  const code = `0x${"60".repeat(64)}` as const;

  function transport(calls: { method: string; data?: string | undefined }[]) {
    return custom({
      request: ({
        method,
        params,
      }: {
        method: string;
        params?: readonly { data?: string }[];
      }) => {
        calls.push({ method, data: params?.[0]?.data });
        if (method === "eth_chainId") return Promise.resolve("0x61");
        if (method === "eth_getCode") return Promise.resolve(code);
        if (method === "eth_call")
          return Promise.resolve(
            encodeAbiParameters(
              [{ type: "address" }],
              ["0x00000000000000000000000000000000000000c1"],
            ),
          );
        if (method === "eth_estimateGas") return Promise.resolve("0x5208");
        return Promise.reject(new Error(`unexpected ${method}`));
      },
    });
  }

  it.each(["officialTax", "loopDynamic"] as const)(
    "the %s Factory reader previews only an S359 request",
    async (hookKind) => {
      const calls: { method: string; data?: string | undefined }[] = [];
      const reader = createHooksLaunchFactoryReader({
        factoryAddress: "0x1111111111111111111111111111111111111111",
        expectedRuntimeCodeHash: keccak256(code),
        rpcUrls: [],
        transport: transport(calls),
        hookKind,
      });
      await expect(reader.hookDeployment(request)).rejects.toBeInstanceOf(
        HooksLaunchRequestTermsMissingError,
      );
      expect(calls.some((c) => c.method === "eth_call")).toBe(false);

      const preview = await reader.hookDeployment({ ...request, ...terms });
      expect(preview.deployer.toLowerCase()).toBe(
        "0x00000000000000000000000000000000000000c1",
      );
      const previewName =
        hookKind === "loopDynamic"
          ? "previewLoopHookInitCodeHash"
          : "previewHookInitCodeHash";
      const abi =
        hookKind === "loopDynamic"
          ? loopDynamicLaunchFactoryAbi
          : loopLaunchFactoryAbi;
      const selector = toFunctionSelector(abiFunction(abi, previewName));
      expect(selector).toBe(
        toFunctionSelector(
          `${previewName}((address,uint32,bytes32,string,string,uint64,address,uint64,bytes32,uint256,uint256))`,
        ),
      );
      expect(
        calls.some(
          (c) => c.method === "eth_call" && c.data?.startsWith(selector),
        ),
      ).toBe(true);
    },
  );

  it("the executor chain encodes deployLaunch only with terms", async () => {
    const calls: { method: string; data?: string | undefined }[] = [];
    const chain = createHooksLaunchExecutorChain({
      privateKey: `0x${"01".repeat(32)}`,
      factoryAddress: "0x1111111111111111111111111111111111111111",
      rpcUrls: [],
      transport: transport(calls),
    });
    const call = {
      request: {
        ...request,
        nftSaleStart: BigInt(request.nftSaleStart),
        deadline: BigInt(request.deadline),
      },
      hookSalt: `0x${"33".repeat(32)}`,
      signature: `0x${"44".repeat(65)}`,
    };
    await expect(chain.estimateDeploy(call)).rejects.toBeInstanceOf(
      HooksLaunchRequestTermsMissingError,
    );
    expect(calls).toEqual([]);
    await chain.estimateDeploy({
      ...call,
      request: {
        ...call.request,
        nftPrice: BigInt(terms.nftPrice),
        maxCumulativeBuy: BigInt(terms.maxCumulativeBuy),
      },
    });
    const estimate = calls.find((c) => c.method === "eth_estimateGas");
    expect(estimate?.data?.slice(0, 10)).toBe("0xd2d589a0");
  });
});
