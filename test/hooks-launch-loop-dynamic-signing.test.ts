import {
  ContractFunctionZeroDataError,
  concatHex,
  getCreate2Address,
  keccak256,
  type Abi,
} from "viem";
import { describe, expect, it } from "vitest";

import {
  hooksLaunchLoopDynamicHookPermissionBits,
  hooksLaunchLoopDynamicTemplateHash,
  hooksLaunchTemplateHash,
  parseHooksLaunchDraft,
} from "../src/features/launch/hooks-launch-config.js";
import {
  createHooksLaunchDeploymentTypedData,
  mineHooksLaunchSalt,
} from "../src/features/launch/hooks-launch-deployment-crypto.js";
import { assertHooksLaunchFactoryTemplate } from "../src/features/launch/hooks-launch-deployment.js";
import { HooksLaunchFactoryTemplateMismatchError } from "../src/features/launch/hooks-launch-executor.js";
import { hooksLaunchFactoryHashPolicy } from "../src/features/launch/hooks-launch-project-config.js";
import { readHooksLaunchLoopDynamicTemplate } from "../src/integrations/launch/hooks-launch-factory-reader.js";
import {
  s193LoopDynamicParams,
  s209LoopDynamicParams,
  testnetLoopDynamicParams,
  testnetLoopDynamicTemplateHash,
} from "./helpers/hooks-launch-loop-dynamic-fixtures.js";

/**
 * Decision 0132: the LoopDynamic template read from a Factory, the Hook
 * salt mined for bits 0x10C4 (never the zero salt), the typed data over
 * the Factory's TEMPLATE_HASH, and the template binding of saved configs.
 */

const factory = "0xaf077cab35385027592f959aca185f815c3c5a5a";
const hookFactory = "0x1536992cfd3f8996f9d573cece3e08dead284d3b" as const;
const registry = "0xbed2c2e1f9341c1a821182d8f96df98d52dfabe5";

function chainReads(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    [`${factory}.hookKind`]: 1,
    [`${factory}.TEMPLATE_HASH`]: testnetLoopDynamicTemplateHash,
    [`${factory}.loopRouter`]: testnetLoopDynamicParams.router,
    [`${factory}.loopHookDeploymentFactory`]: hookFactory,
    [`${factory}.routerRegistry`]: registry,
    [`${hookFactory}.router`]: testnetLoopDynamicParams.router,
    [`${hookFactory}.baseSellFeePpm`]: 20_000,
    [`${hookFactory}.baseFeeRecipient`]:
      testnetLoopDynamicParams.baseFeeRecipient,
    [`${hookFactory}.priceTiming`]: 1,
    [`${hookFactory}.routingPolicy`]: 1,
    [`${hookFactory}.routerRegistry`]: registry,
    [`${hookFactory}.excludeBuybackFromRewards`]: true,
    [`${hookFactory}.buyFeePpm`]: 20_000,
    [`${hookFactory}.launchFactory`]: factory,
    // Decision 0152: a pre-S209 Hook factory requires 0x10C4.
    [`${hookFactory}.REQUIRED_PERMISSION_MASK`]: 0x10c4n,
    [`${registry}.admin`]: testnetLoopDynamicParams.routerRegistryAdmin,
    ...overrides,
  };
  return (address: string, _abi: Abi, name: string) => {
    const key = `${address.toLowerCase()}.${name}`;
    if (!(key in values)) {
      // An S165 Hook factory has no maxDynamicFeeWad(): the call returns
      // no data (a contract-level failure, not a transport one).
      // Decision 0152: likewise a pre-S209 Factory's maxCumulativeBuy().
      if (name === "maxDynamicFeeWad" || name === "maxCumulativeBuy") {
        return Promise.reject(
          new ContractFunctionZeroDataError({ functionName: name }),
        );
      }
      return Promise.reject(new Error(`no ${key}`));
    }
    return Promise.resolve(values[key]);
  };
}

/** Decision 0152: an S209 Factory (purchase cap, 0x10CC, 12 fields). */
const s209TemplateHash = hooksLaunchLoopDynamicTemplateHash(
  s209LoopDynamicParams,
).toLowerCase();
function s209Reads(overrides: Record<string, unknown> = {}) {
  return chainReads({
    [`${factory}.TEMPLATE_HASH`]: s209TemplateHash,
    [`${factory}.loopRouter`]: s209LoopDynamicParams.router,
    [`${factory}.maxCumulativeBuy`]: 5_000_000n * 10n ** 18n,
    [`${hookFactory}.router`]: s209LoopDynamicParams.router,
    [`${hookFactory}.maxDynamicFeeWad`]: 200_000_000_000_000_000n,
    [`${hookFactory}.REQUIRED_PERMISSION_MASK`]: 0x10ccn,
    ...overrides,
  });
}

/** Decision 0144: an S193 Factory (cap getter, 11-field TEMPLATE_HASH). */
const s193TemplateHash = hooksLaunchLoopDynamicTemplateHash(
  s193LoopDynamicParams,
).toLowerCase();
function s193Reads(overrides: Record<string, unknown> = {}) {
  return chainReads({
    [`${factory}.TEMPLATE_HASH`]: s193TemplateHash,
    [`${factory}.loopRouter`]: s193LoopDynamicParams.router,
    [`${hookFactory}.router`]: s193LoopDynamicParams.router,
    [`${hookFactory}.maxDynamicFeeWad`]: 200_000_000_000_000_000n,
    ...overrides,
  });
}

describe("LoopDynamic Factory template read (Decision 0132)", () => {
  it("reads the testnet parameters and verifies TEMPLATE_HASH", async () => {
    const read = await readHooksLaunchLoopDynamicTemplate(
      chainReads(),
      factory,
    );
    expect(read.templateHash).toBe(testnetLoopDynamicTemplateHash);
    expect(read.params).toEqual(testnetLoopDynamicParams);
    expect(read.hookDeploymentFactory).toBe(hookFactory);
  });

  it.each([
    ["an OfficialTax hookKind", { [`${factory}.hookKind`]: 0 }],
    [
      "another TEMPLATE_HASH",
      { [`${factory}.TEMPLATE_HASH`]: `0x${"12".repeat(32)}` },
    ],
    ["another buy fee", { [`${hookFactory}.buyFeePpm`]: 30_000 }],
    [
      "a Hook factory of another launch factory",
      { [`${hookFactory}.launchFactory`]: registry },
    ],
    [
      "a Hook factory on another router",
      { [`${hookFactory}.router`]: registry },
    ],
  ])("refuses %s as a template mismatch", async (_name, overrides) => {
    await expect(
      readHooksLaunchLoopDynamicTemplate(chainReads(overrides), factory),
    ).rejects.toBeInstanceOf(HooksLaunchFactoryTemplateMismatchError);
  });

  it("reads an S193 Factory's cap and verifies the 11-field TEMPLATE_HASH (Decision 0144)", async () => {
    const read = await readHooksLaunchLoopDynamicTemplate(s193Reads(), factory);
    expect(read.params).toEqual(s193LoopDynamicParams);
    expect(read.params.maxDynamicFeeWad).toBe("200000000000000000");
    expect(read.templateHash).toBe(s193TemplateHash);
    expect(read.templateHash).not.toBe(testnetLoopDynamicTemplateHash);
    // Uncapped S193 Factory: the zero word is still hashed.
    const uncapped = { ...s193LoopDynamicParams, maxDynamicFeeWad: "0" };
    const zero = await readHooksLaunchLoopDynamicTemplate(
      s193Reads({
        [`${hookFactory}.maxDynamicFeeWad`]: 0n,
        [`${factory}.TEMPLATE_HASH`]:
          hooksLaunchLoopDynamicTemplateHash(uncapped).toLowerCase(),
      }),
      factory,
    );
    expect(zero.params.maxDynamicFeeWad).toBe("0");
  });

  it.each([
    [
      "an S193 cap with the S165 TEMPLATE_HASH",
      { [`${factory}.TEMPLATE_HASH`]: testnetLoopDynamicTemplateHash },
    ],
    [
      "another cap than the TEMPLATE_HASH commits",
      { [`${hookFactory}.maxDynamicFeeWad`]: 100_000_000_000_000_000n },
    ],
    [
      "a cap of 1e18 or more",
      { [`${hookFactory}.maxDynamicFeeWad`]: 10n ** 18n },
    ],
  ])("refuses %s as a template mismatch (Decision 0144)", async (_n, o) => {
    await expect(
      readHooksLaunchLoopDynamicTemplate(s193Reads(o), factory),
    ).rejects.toBeInstanceOf(HooksLaunchFactoryTemplateMismatchError);
  });

  it("lets a transport failure of the cap read through (not legacy, not a mismatch)", async () => {
    const reads = s193Reads();
    const failing = (address: string, abi: Abi, name: string) =>
      name === "maxDynamicFeeWad"
        ? Promise.reject(new Error("rpc down"))
        : reads(address, abi, name);
    await expect(
      readHooksLaunchLoopDynamicTemplate(failing, factory),
    ).rejects.toThrow("rpc down");
  });

  it("reads an S209 Factory's purchase cap, 0x10CC and the 12-field TEMPLATE_HASH (Decision 0152)", async () => {
    const read = await readHooksLaunchLoopDynamicTemplate(s209Reads(), factory);
    expect(read.params).toEqual(s209LoopDynamicParams);
    expect(read.templateHash).toBe(s209TemplateHash);
    expect(read.templateHash).not.toBe(s193TemplateHash);
    expect(hooksLaunchLoopDynamicHookPermissionBits(read.params)).toBe(0x10ccn);
    // A lower cap is another template (another hash).
    const lower = {
      ...s209LoopDynamicParams,
      maxCumulativeBuy: "1" + "0".repeat(24),
    };
    const read2 = await readHooksLaunchLoopDynamicTemplate(
      s209Reads({
        [`${factory}.maxCumulativeBuy`]: 10n ** 24n,
        [`${factory}.TEMPLATE_HASH`]:
          hooksLaunchLoopDynamicTemplateHash(lower).toLowerCase(),
      }),
      factory,
    );
    expect(read2.params.maxCumulativeBuy).toBe("1" + "0".repeat(24));
  });

  it.each([
    [
      "an S209 cap with the S193 TEMPLATE_HASH",
      { [`${factory}.TEMPLATE_HASH`]: s193TemplateHash },
    ],
    [
      "an S209 Factory whose Hook factory still requires 0x10C4",
      { [`${hookFactory}.REQUIRED_PERMISSION_MASK`]: 0x10c4n },
    ],
    ["a zero purchase cap", { [`${factory}.maxCumulativeBuy`]: 0n }],
    [
      "a purchase cap above the MEME supply",
      { [`${factory}.maxCumulativeBuy`]: 10n ** 27n + 1n },
    ],
  ])("refuses %s as a template mismatch (Decision 0152)", async (_n, o) => {
    await expect(
      readHooksLaunchLoopDynamicTemplate(s209Reads(o), factory),
    ).rejects.toBeInstanceOf(HooksLaunchFactoryTemplateMismatchError);
  });

  it("refuses a pre-S209 Factory whose Hook factory requires 0x10CC (Decision 0152)", async () => {
    await expect(
      readHooksLaunchLoopDynamicTemplate(
        s193Reads({ [`${hookFactory}.REQUIRED_PERMISSION_MASK`]: 0x10ccn }),
        factory,
      ),
    ).rejects.toBeInstanceOf(HooksLaunchFactoryTemplateMismatchError);
  });

  it("lets a transport failure of the purchase cap read through (Decision 0152)", async () => {
    const reads = s209Reads();
    const failing = (address: string, abi: Abi, name: string) =>
      name === "maxCumulativeBuy"
        ? Promise.reject(new Error("rpc down"))
        : reads(address, abi, name);
    await expect(
      readHooksLaunchLoopDynamicTemplate(failing, factory),
    ).rejects.toThrow("rpc down");
  });

  it("lets a transport failure through (not a mismatch)", async () => {
    const failing = () => Promise.reject(new Error("rpc down"));
    await expect(
      readHooksLaunchLoopDynamicTemplate(failing, factory),
    ).rejects.toThrow("rpc down");
  });
});

describe("LoopDynamic signing material (Decision 0132)", () => {
  const initCodeHash = `0x${"9a".repeat(32)}` as const;

  it("mines a non-zero salt whose CREATE2 address carries 0x10CC (S209) or, asked for, 0x10C4", () => {
    const salt = mineHooksLaunchSalt({
      deployer: hookFactory,
      initCodeHash,
      maxAttempts: 1_000_000,
      hookKind: "loopDynamic",
    });
    expect(salt).not.toBe(`0x${"0".repeat(64)}`);
    const hook = getCreate2Address({
      from: hookFactory,
      salt,
      bytecodeHash: initCodeHash,
    });
    // Decision 0152: the current build's LoopDynamic bits.
    expect(BigInt(hook) & 0x3fffn).toBe(0x10ccn);
    // A pre-S209 Factory's template asks for 0x10C4.
    const legacySalt = mineHooksLaunchSalt({
      deployer: hookFactory,
      initCodeHash,
      maxAttempts: 1_000_000,
      hookKind: "loopDynamic",
      permissionBits: hooksLaunchLoopDynamicHookPermissionBits(
        testnetLoopDynamicParams,
      ),
    });
    expect(legacySalt).not.toBe(`0x${"0".repeat(64)}`);
    const legacyHook = getCreate2Address({
      from: hookFactory,
      salt: legacySalt,
      bytecodeHash: initCodeHash,
    });
    expect(BigInt(legacyHook) & 0x3fffn).toBe(0x10c4n);
    // OfficialTax mining is unchanged (0x20CC).
    const official = mineHooksLaunchSalt({
      deployer: hookFactory,
      initCodeHash,
      maxAttempts: 1_000_000,
    });
    const officialHook = keccak256(
      concatHex([`0xff${hookFactory.slice(2)}`, official, initCodeHash]),
    );
    expect(BigInt(`0x${officialHook.slice(-4)}`) & 0x3fffn).toBe(0x20ccn);
  });

  it("signs over the Factory's TEMPLATE_HASH and keeps the OfficialTax constant by default", () => {
    const request = {
      configHash: `0x${"c0".repeat(32)}`,
      projectOwner: "0x1111111111111111111111111111111111111111",
      configVersion: 1,
      name: "Project",
      ticker: "MEME",
      nftSaleStart: "4000000000",
      buybackRecipient: "0x3333333333333333333333333333333333333333",
      deadline: "1800000900",
      memeSalt: `0x${"00".repeat(31)}09`,
      nonce: "0",
    };
    expect(
      createHooksLaunchDeploymentTypedData({
        chainId: 97,
        verifyingContract: factory,
        request,
      }).message.templateHash,
    ).toBe(hooksLaunchTemplateHash);
    expect(
      createHooksLaunchDeploymentTypedData({
        chainId: 97,
        verifyingContract: factory,
        request,
        templateHash: testnetLoopDynamicTemplateHash,
      }).message.templateHash,
    ).toBe(testnetLoopDynamicTemplateHash);
    expect(() =>
      createHooksLaunchDeploymentTypedData({
        chainId: 97,
        verifyingContract: factory,
        request,
        templateHash: "0x12",
      }),
    ).toThrow();
  });
});

describe("config template binding (Decision 0132)", () => {
  const body = {
    name: "Project",
    ticker: "MEME",
    logoAssetUrl: "https://example.com/logo.png",
    description: "Test",
    links: [],
    nftSaleStartAt: "1900000000",
    buybackRecipient: "0x3333333333333333333333333333333333333333",
  };
  const policy = {
    nowUnixSeconds: "1800000000",
    minimumLeadSeconds: 86_400,
    nftSaleDurationSeconds: 3_600,
  };
  const official = parseHooksLaunchDraft(body, policy);
  const dynamic = parseHooksLaunchDraft(body, {
    ...policy,
    loopDynamic: testnetLoopDynamicParams,
  });
  const dynamicReader = {
    hookKind: "loopDynamic" as const,
    nftSaleDuration: () => Promise.resolve({ seconds: 3_600, legacy: false }),
    loopDynamicTemplate: () =>
      Promise.resolve({
        params: testnetLoopDynamicParams,
        templateHash: testnetLoopDynamicTemplateHash,
      }),
  };
  const officialReader = {
    nftSaleDuration: () => Promise.resolve({ seconds: 3_600, legacy: false }),
  };
  const mismatch = () => new Error("mismatch");

  it("hashes the LoopDynamic template only for a LoopDynamic Factory", async () => {
    expect(await hooksLaunchFactoryHashPolicy(officialReader)).toEqual({
      nftSaleDurationSeconds: 3_600,
    });
    expect(await hooksLaunchFactoryHashPolicy(dynamicReader)).toEqual({
      nftSaleDurationSeconds: 3_600,
      loopDynamic: testnetLoopDynamicParams,
    });
    expect(dynamic.templateHash).toBe(testnetLoopDynamicTemplateHash);
    expect(dynamic.configHash).not.toBe(official.configHash);
  });

  it("signs a config only for the Factory template it was hashed for", async () => {
    await expect(
      assertHooksLaunchFactoryTemplate(dynamicReader, dynamic, mismatch),
    ).resolves.toBeUndefined();
    await expect(
      assertHooksLaunchFactoryTemplate(officialReader, official, mismatch),
    ).resolves.toBeUndefined();
    await expect(
      assertHooksLaunchFactoryTemplate(dynamicReader, official, mismatch),
    ).rejects.toThrow("mismatch");
    await expect(
      assertHooksLaunchFactoryTemplate(officialReader, dynamic, mismatch),
    ).rejects.toThrow("mismatch");
  });

  it("refuses a config hashed for the S165 template once the Factory is S193 (Decision 0144)", async () => {
    const s193Reader = {
      ...dynamicReader,
      loopDynamicTemplate: () =>
        Promise.resolve({
          params: s193LoopDynamicParams,
          templateHash: s193TemplateHash,
        }),
    };
    const s193 = parseHooksLaunchDraft(body, {
      ...policy,
      loopDynamic: s193LoopDynamicParams,
    });
    expect(s193.templateHash).toBe(s193TemplateHash);
    expect(s193.configHash).not.toBe(dynamic.configHash);
    expect(await hooksLaunchFactoryHashPolicy(s193Reader)).toEqual({
      nftSaleDurationSeconds: 3_600,
      loopDynamic: s193LoopDynamicParams,
    });
    // A draft saved before the redeploy is re-saved, never signed as is.
    await expect(
      assertHooksLaunchFactoryTemplate(s193Reader, dynamic, mismatch),
    ).rejects.toThrow("mismatch");
    await expect(
      assertHooksLaunchFactoryTemplate(s193Reader, s193, mismatch),
    ).resolves.toBeUndefined();
    await expect(
      assertHooksLaunchFactoryTemplate(dynamicReader, s193, mismatch),
    ).rejects.toThrow("mismatch");
  });
});
