import {
  encodeAbiParameters,
  encodeFunctionData,
  hashTypedData,
  keccak256,
  concatHex,
  parseAbiParameters,
  toEventSelector,
  toFunctionSelector,
  toBytes,
  type Hex,
} from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  hooksLaunchFixedEconomics,
  hooksLaunchTemplateHash,
  parseHooksLaunchDraft,
} from "../src/features/launch/hooks-launch-config.js";
import {
  createHooksLaunchDeploymentTypedData,
  hooksLaunchDeploymentTypes,
} from "../src/features/launch/hooks-launch-deployment-crypto.js";
import { hooksLaunchDraftOnChainTerms } from "../src/features/launch/hooks-launch-deployment.js";
import {
  createHooksLaunchProjectConfigService,
  HooksLaunchProjectConfigUnavailableError,
  resetHooksLaunchProjectTermsProbeCache,
  type HooksLaunchProjectConfigRecord,
  type HooksLaunchProjectConfigRepository,
} from "../src/features/launch/hooks-launch-project-config.js";
import {
  HooksLaunchProjectTermsInvalidError,
  HooksLaunchProjectTermsUnsupportedError,
  hooksLaunchNftPriceWei,
  hooksLaunchProjectTermsArgs,
  hooksLaunchProjectTermsFromChain,
  hooksLaunchProjectTermsOnChain,
  hooksLaunchProjectTermsView,
  hooksLaunchWalletCapRaw,
  takeHooksLaunchProjectTerms,
} from "../src/features/launch/hooks-launch-project-terms.js";
import {
  verifyHooksLaunchDeployment,
  type HooksLaunchOnChainFacts,
} from "../src/features/launch/hooks-launch-verification.js";
import {
  expectedDeployment,
  launchDeployedEvent,
  passingFacts,
} from "./helpers/hooks-launch-executor-fixtures.js";
import {
  hooksLaunchFactoryTermsAbi,
  hooksLaunchModuleTermsAbi,
} from "../src/integrations/launch/hooks-launch-factory-terms-abi.js";

const recipient = "0x1234567890123456789012345678901234567890";
const body = {
  name: "LOOP 项目示例",
  ticker: "MEME",
  logoAssetUrl: "https://cdn.example.com/logo.png",
  description: "Project description",
  links: ["https://example.com"],
  nftSaleStartAt: "1800000000",
  buybackRecipient: recipient,
};
const projectId = "00000000-0000-4000-8000-000000000001";

describe("Decision 0199 launch terms: input rules", () => {
  it("defaults absent / null to 100 USD1 and 5 ‰", () => {
    expect(takeHooksLaunchProjectTerms({ a: 1 })).toEqual({
      terms: { nftPriceUsd1: 100, walletCapPerMille: 5 },
      rest: { a: 1 },
    });
    expect(
      takeHooksLaunchProjectTerms({
        nftPriceUsd1: null,
        walletCapPerMille: null,
      }).terms,
    ).toEqual({ nftPriceUsd1: 100, walletCapPerMille: 5 });
  });

  it("accepts whole numbers at both bounds", () => {
    for (const [price, cap] of [
      [1, 1],
      [1_000, 1_000],
      [250, 12],
    ] as const) {
      expect(
        takeHooksLaunchProjectTerms({
          nftPriceUsd1: price,
          walletCapPerMille: cap,
        }).terms,
      ).toEqual({ nftPriceUsd1: price, walletCapPerMille: cap });
    }
  });

  it.each([1.5, 0, -1, 1_001, 100_000, "100", Number.NaN, true])(
    "refuses nftPriceUsd1 = %s with LAUNCH2_NFT_PRICE_INVALID",
    (value) => {
      try {
        takeHooksLaunchProjectTerms({ nftPriceUsd1: value });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(HooksLaunchProjectTermsInvalidError);
        expect((error as HooksLaunchProjectTermsInvalidError).reasonCode).toBe(
          "LAUNCH2_NFT_PRICE_INVALID",
        );
        expect((error as HooksLaunchProjectTermsInvalidError).field).toBe(
          "nftPriceUsd1",
        );
      }
    },
  );

  it.each([0.5, 0, -5, 1_001, "5"])(
    "refuses walletCapPerMille = %s with LAUNCH2_WALLET_CAP_INVALID",
    (value) => {
      try {
        takeHooksLaunchProjectTerms({ walletCapPerMille: value });
        expect.unreachable();
      } catch (error) {
        expect((error as HooksLaunchProjectTermsInvalidError).reasonCode).toBe(
          "LAUNCH2_WALLET_CAP_INVALID",
        );
      }
    },
  );
});

describe("Decision 0199 launch terms: on-chain conversion", () => {
  it("converts 100 USD1 → 1e20 wei and 5 ‰ → 5e24 raw MEME", () => {
    expect(hooksLaunchNftPriceWei(100)).toBe(10n ** 20n);
    expect(hooksLaunchWalletCapRaw(5)).toBe(5n * 10n ** 24n);
    expect(
      hooksLaunchProjectTermsOnChain({
        nftPriceUsd1: 100,
        walletCapPerMille: 5,
      }),
    ).toEqual({
      nftPrice: "100000000000000000000",
      maxCumulativeBuy: "5000000000000000000000000",
    });
    // 1000 ‰ = the whole 1e9 MEME supply.
    expect(hooksLaunchWalletCapRaw(1_000)).toBe(10n ** 27n);
  });

  it("derives the read keys and reverses chain values", () => {
    expect(
      hooksLaunchProjectTermsView({ nftPriceUsd1: 300, walletCapPerMille: 8 }),
    ).toEqual({
      nftPriceUsd1: 300,
      walletCapPerMille: 8,
      maxCumulativeBuyRaw: "8000000000000000000000000",
    });
    expect(
      hooksLaunchProjectTermsFromChain({
        nftPriceWei: 10n ** 20n,
        maxCumulativeBuyRaw: 5n * 10n ** 24n,
      }),
    ).toEqual({
      nftPriceUsd1: 100,
      walletCapPerMille: 5,
      maxCumulativeBuyRaw: "5000000000000000000000000",
    });
    // A pre-S359 admin cap that is not a whole permille.
    expect(
      hooksLaunchProjectTermsFromChain({
        nftPriceWei: 10n ** 20n,
        maxCumulativeBuyRaw: 2_500_000n * 10n ** 18n,
      }).walletCapPerMille,
    ).toBeNull();
    expect(hooksLaunchProjectTermsArgs({})).toBeNull();
  });
});

describe("Decision 0199 launch terms: Factory ABI and EIP-712 (loop-contracts S359)", () => {
  it("pins the S359 selectors and event topic", () => {
    const deploy = hooksLaunchFactoryTermsAbi.find(
      (item) => item.type === "function" && item.name === "deployLaunch",
    );
    expect(deploy).toBeDefined();
    expect(
      toFunctionSelector(
        "deployLaunch((address,uint32,bytes32,string,string,uint64,address,uint64,bytes32,uint256,uint256),bytes32,bytes)",
      ),
    ).toBe("0xd2d589a0");
    const data = encodeFunctionData({
      abi: hooksLaunchFactoryTermsAbi,
      functionName: "deployLaunch",
      args: [
        {
          projectOwner: recipient,
          configVersion: 1,
          configHash: `0x${"11".repeat(32)}`,
          name: "N",
          ticker: "T",
          nftSaleStart: 1n,
          buybackRecipient: recipient,
          deadline: 2n,
          memeSalt: `0x${"22".repeat(32)}`,
          nftPrice: 300n * 10n ** 18n,
          maxCumulativeBuy: 5n * 10n ** 24n,
        },
        `0x${"33".repeat(32)}`,
        "0x",
      ],
    });
    expect(data.slice(0, 10)).toBe("0xd2d589a0");
    expect(
      encodeFunctionData({
        abi: hooksLaunchFactoryTermsAbi,
        functionName: "DEFAULT_NFT_PRICE",
      }),
    ).toBe("0xef14e547");
    expect(
      toEventSelector("LaunchNftPrice(bytes32,address,uint256)").toLowerCase(),
    ).toBe(
      "0x3931ee0db3404c939a8f1852f3fb42f26ce5af6fdacbd8ace77864fa1fc6b96a",
    );
    expect(
      encodeFunctionData({
        abi: hooksLaunchModuleTermsAbi,
        functionName: "ORDER_AMOUNT",
      }),
    ).toBe(toFunctionSelector("ORDER_AMOUNT()"));
  });

  it("matches the contracts' independent S359 digest (domain v2, terms appended)", () => {
    const factory = "0x00000000000000000000000000000000000000f1";
    const templateHash = `0x${"ab".repeat(32)}`;
    const request = {
      configHash: `0x${"11".repeat(32)}`,
      projectOwner: "0x00000000000000000000000000000000000000a1",
      configVersion: 7,
      name: "LOOP",
      ticker: "MEME",
      nftSaleStart: "1800000000",
      buybackRecipient: recipient,
      deadline: "1800000900",
      memeSalt: `0x${"22".repeat(32)}`,
      nonce: "3",
      nftPrice: "300000000000000000000",
      maxCumulativeBuy: "5000000000000000000000000",
    };
    const typed = createHooksLaunchDeploymentTypedData({
      chainId: 97,
      verifyingContract: factory,
      request,
      templateHash,
    });
    expect(typed.domain.version).toBe("2");
    const digest = hashTypedData({
      ...typed,
      message: {
        ...typed.message,
        nftSaleStart: BigInt(request.nftSaleStart),
        deadline: BigInt(request.deadline),
        nonce: BigInt(request.nonce),
        ...hooksLaunchProjectTermsArgs(request),
      },
    });
    // testS359DigestCommitsToTermsAndMatchesIndependentEip712, in TS.
    const domain = keccak256(
      encodeAbiParameters(
        parseAbiParameters("bytes32,bytes32,bytes32,uint256,address"),
        [
          keccak256(
            toBytes(
              "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
            ),
          ),
          keccak256(toBytes("LOOP Launch Factory")),
          keccak256(toBytes("2")),
          97n,
          factory,
        ],
      ),
    );
    const structHash = keccak256(
      encodeAbiParameters(
        parseAbiParameters(
          "bytes32,bytes32,address,uint32,bytes32,bytes32,uint64,address,uint64,bytes32,uint256,bytes32,uint256,uint256",
        ),
        [
          keccak256(
            toBytes(
              "LaunchRequest(bytes32 configHash,address projectOwner,uint32 configVersion,string name,string ticker,uint64 nftSaleStart,address buybackRecipient,uint64 deadline,bytes32 memeSalt,uint256 nonce,bytes32 templateHash,uint256 nftPrice,uint256 maxCumulativeBuy)",
            ),
          ),
          request.configHash as Hex,
          request.projectOwner as Hex,
          7,
          keccak256(toBytes(request.name)),
          keccak256(toBytes(request.ticker)),
          1_800_000_000n,
          recipient,
          1_800_000_900n,
          request.memeSalt as Hex,
          3n,
          templateHash as Hex,
          300n * 10n ** 18n,
          5n * 10n ** 24n,
        ],
      ),
    );
    expect(digest).toBe(keccak256(concatHex(["0x1901", domain, structHash])));
  });

  it("keeps the pre-S359 typed data byte-identical (domain v1, no terms)", () => {
    const typed = createHooksLaunchDeploymentTypedData({
      chainId: 97,
      verifyingContract: "0x00000000000000000000000000000000000000f1",
      request: {
        configHash: `0x${"11".repeat(32)}`,
        projectOwner: "0x00000000000000000000000000000000000000a1",
        configVersion: 7,
        name: "LOOP",
        ticker: "MEME",
        nftSaleStart: "1",
        buybackRecipient: recipient,
        deadline: "2",
        memeSalt: `0x${"22".repeat(32)}`,
        nonce: "0",
      },
    });
    expect(typed.domain.version).toBe("1");
    expect(typed.types).toBe(hooksLaunchDeploymentTypes);
    expect("nftPrice" in typed.message).toBe(false);
    expect(typed.message.templateHash).toBe(hooksLaunchTemplateHash);
  });

  it("refuses half-present terms", () => {
    expect(() =>
      createHooksLaunchDeploymentTypedData({
        chainId: 97,
        verifyingContract: "0x00000000000000000000000000000000000000f1",
        request: {
          configHash: `0x${"11".repeat(32)}`,
          projectOwner: "0x00000000000000000000000000000000000000a1",
          configVersion: 7,
          name: "LOOP",
          ticker: "MEME",
          nftSaleStart: "1",
          buybackRecipient: recipient,
          deadline: "2",
          memeSalt: `0x${"22".repeat(32)}`,
          nonce: "0",
          nftPrice: "100000000000000000000",
        },
      }),
    ).toThrow();
  });
});

describe("Decision 0199 launch terms: draft hashing and deploy gate", () => {
  const policy = {
    nowUnixSeconds: "1790000000",
    minimumLeadSeconds: 86_400,
    nftSaleDurationSeconds: 604_800,
  };

  it("hashes the terms into fixedEconomics only for an S359 Factory", () => {
    const legacy = parseHooksLaunchDraft(body, policy);
    expect(legacy.fixedEconomics).toBe(hooksLaunchFixedEconomics);
    const defaults = parseHooksLaunchDraft(body, {
      ...policy,
      projectTerms: { nftPriceUsd1: 100, walletCapPerMille: 5 },
    });
    // Default terms on an S359 Factory: the same values, same hash.
    expect(defaults.configHash).toBe(legacy.configHash);
    const custom = parseHooksLaunchDraft(body, {
      ...policy,
      projectTerms: { nftPriceUsd1: 300, walletCapPerMille: 8 },
    });
    expect(custom.fixedEconomics).toMatchObject({
      nftPriceUsd1Raw: "300000000000000000000",
      buybackOrderUsd1Raw: "300000000000000000000",
      perAddressLifetimeBuyCapRaw: "8000000000000000000000000",
    });
    expect(Object.keys(custom.fixedEconomics)).toEqual(
      Object.keys(hooksLaunchFixedEconomics),
    );
    expect(custom.configHash).not.toBe(legacy.configHash);
  });

  it("passes the draft's terms on an S359 Factory and refuses mismatches", () => {
    const errors = {
      unsupported: () => new Error("unsupported"),
      mismatch: () => new Error("mismatch"),
    };
    const terms = { nftPriceUsd1: 300, walletCapPerMille: 8 };
    const config = parseHooksLaunchDraft(body, {
      ...policy,
      projectTerms: terms,
    });
    expect(
      hooksLaunchDraftOnChainTerms(true, { config, terms }, errors),
    ).toEqual({
      nftPrice: "300000000000000000000",
      maxCumulativeBuy: "8000000000000000000000000",
    });
    // A pre-S359 Factory: defaults → no struct fields; others refused.
    const legacyConfig = parseHooksLaunchDraft(body, policy);
    expect(
      hooksLaunchDraftOnChainTerms(false, { config: legacyConfig }, errors),
    ).toBeNull();
    expect(() =>
      hooksLaunchDraftOnChainTerms(false, { config, terms }, errors),
    ).toThrow("unsupported");
    // Default terms saved on the no-probe path: still passed on chain.
    expect(
      hooksLaunchDraftOnChainTerms(true, { config: legacyConfig }, errors),
    ).toEqual({
      nftPrice: "100000000000000000000",
      maxCumulativeBuy: "5000000000000000000000000",
    });
    // Terms saved for another Factory (fixedEconomics without them).
    expect(() =>
      hooksLaunchDraftOnChainTerms(
        true,
        { config: legacyConfig, terms },
        errors,
      ),
    ).toThrow("mismatch");
  });
});

describe("Decision 0199 launch terms: config save", () => {
  beforeEach(() => {
    resetHooksLaunchProjectTermsProbeCache();
  });

  function harness(
    projectTermsSupported?: () => Promise<boolean>,
    factoryAddress?: string,
  ) {
    let record: HooksLaunchProjectConfigRecord | null = null;
    const repository: HooksLaunchProjectConfigRepository = {
      getOwnedDraft: () => Promise.resolve(record),
      saveOwnedDraft(input) {
        record = Object.freeze({
          ...input,
          version: 1,
          updatedAt: "2026-11-04T00:00:00.000Z",
        });
        return Promise.resolve(record);
      },
      getOwnedProgress: () =>
        Promise.resolve({
          approvedAt: null,
          rejection: null,
          latestJobId: null,
        }),
    };
    const service = createHooksLaunchProjectConfigService({
      fixedBuybackRecipient: recipient,
      repository,
      factory: {
        nftSaleDuration: () =>
          Promise.resolve({ seconds: 604_800, legacy: false }),
        ...(projectTermsSupported === undefined
          ? {}
          : { projectTermsSupported }),
        ...(factoryAddress === undefined
          ? {}
          : { factoryAddress, chainId: 97 }),
      },
      minimumLeadSeconds: 86_400,
      now: () => 1_790_000_000,
    });
    const save = (extra: Record<string, unknown>) =>
      service.saveDraft({
        ownerUserId: "user-1",
        projectId,
        expectedVersion: 0,
        body: { ...body, ...extra },
      });
    return { service, save };
  }

  it("stores the terms with the version (S359 Factory)", async () => {
    const { save, service } = harness(() => Promise.resolve(true));
    const saved = await save({ nftPriceUsd1: 300, walletCapPerMille: 8 });
    expect(saved.terms).toEqual({ nftPriceUsd1: 300, walletCapPerMille: 8 });
    expect(saved.config.fixedEconomics.nftPriceUsd1Raw).toBe(
      "300000000000000000000",
    );
    expect(service.projectTermsEmit).toBe(false);
  });

  it("stores defaults when omitted and refuses invalid values first", async () => {
    const { save } = harness();
    const saved = await save({});
    expect(saved.terms).toEqual({ nftPriceUsd1: 100, walletCapPerMille: 5 });
    await expect(save({ nftPriceUsd1: 2.5 })).rejects.toBeInstanceOf(
      HooksLaunchProjectTermsInvalidError,
    );
    await expect(save({ walletCapPerMille: 0 })).rejects.toBeInstanceOf(
      HooksLaunchProjectTermsInvalidError,
    );
  });

  it("refuses non-default terms on a pre-S359 Factory; an unreadable probe is unavailable", async () => {
    await expect(
      harness(() => Promise.resolve(false)).save({ nftPriceUsd1: 200 }),
    ).rejects.toBeInstanceOf(HooksLaunchProjectTermsUnsupportedError);
    await expect(
      harness().save({ walletCapPerMille: 6 }),
    ).rejects.toBeInstanceOf(HooksLaunchProjectTermsUnsupportedError);
    await expect(
      harness(() => Promise.reject(new Error("rpc"))).save({
        nftPriceUsd1: 200,
      }),
    ).rejects.toBeInstanceOf(HooksLaunchProjectConfigUnavailableError);
  });

  it("saves default terms without probing, even with the chain unreachable", async () => {
    const probe = vi.fn(() => Promise.reject(new Error("rpc down")));
    const { save } = harness(
      probe,
      "0x00000000000000000000000000000000000000f1",
    );
    for (const extra of [
      {},
      { nftPriceUsd1: null, walletCapPerMille: null },
      { nftPriceUsd1: 100, walletCapPerMille: 5 },
    ]) {
      const saved = await save(extra);
      expect(saved.terms).toEqual({ nftPriceUsd1: 100, walletCapPerMille: 5 });
      expect(saved.config.fixedEconomics.nftPriceUsd1Raw).toBe(
        "100000000000000000000",
      );
    }
    expect(probe).not.toHaveBeenCalled();
  });

  it("caches the probe per Factory address; a hit reads no chain", async () => {
    const factory = "0x00000000000000000000000000000000000000f2";
    const probe = vi.fn(() => Promise.resolve(true));
    await harness(probe, factory).save({ nftPriceUsd1: 300 });
    expect(probe).toHaveBeenCalledTimes(1);
    // Another reader / service of the same Factory: served from the cache,
    // even if the chain is now unreachable.
    const down = vi.fn(() => Promise.reject(new Error("rpc down")));
    const saved = await harness(
      down,
      factory.toUpperCase().replace("0X", "0x"),
    ).save({
      walletCapPerMille: 9,
    });
    expect(saved.config.fixedEconomics.perAddressLifetimeBuyCapRaw).toBe(
      "9000000000000000000000000",
    );
    expect(down).not.toHaveBeenCalled();
    // A failed probe is not cached.
    const other = "0x00000000000000000000000000000000000000f3";
    await expect(
      harness(down, other).save({ nftPriceUsd1: 2 }),
    ).rejects.toBeInstanceOf(HooksLaunchProjectConfigUnavailableError);
    const up = vi.fn(() => Promise.resolve(false));
    await expect(
      harness(up, other).save({ nftPriceUsd1: 2 }),
    ).rejects.toBeInstanceOf(HooksLaunchProjectTermsUnsupportedError);
    expect(up).toHaveBeenCalledTimes(1);
  });
});

describe("Decision 0199 launch terms: read-back verification", () => {
  const terms = {
    nftPrice: 300n * 10n ** 18n,
    maxCumulativeBuy: 8n * 10n ** 24n,
  };
  function facts(
    nftPrice: bigint,
    cap: bigint,
    orderAmount: bigint | undefined,
  ): HooksLaunchOnChainFacts {
    const base = passingFacts();
    return {
      ...base,
      nft: base.nft === null ? null : { ...base.nft, price: nftPrice },
      curve:
        base.curve === null ? null : { ...base.curve, maxCumulativeBuy: cap },
      buyback:
        base.buyback === null
          ? null
          : {
              ...base.buyback,
              ...(orderAmount === undefined ? {} : { orderAmount }),
            },
    };
  }
  const run = (f: HooksLaunchOnChainFacts, withTerms: boolean) =>
    verifyHooksLaunchDeployment({
      expected: {
        ...expectedDeployment(),
        ...(withTerms ? { projectTerms: terms } : {}),
      },
      event: launchDeployedEvent(),
      facts: f,
    });

  it("passes when NFT price, curve cap and order amount are the signed terms", () => {
    expect(
      run(facts(terms.nftPrice, terms.maxCumulativeBuy, terms.nftPrice), true)
        .failedChecks,
    ).toEqual([]);
  });

  it("fails each mismatching term", () => {
    expect(
      run(facts(10n ** 20n, terms.maxCumulativeBuy, terms.nftPrice), true)
        .failedChecks,
    ).toEqual(["nft_params"]);
    expect(
      run(facts(terms.nftPrice, 5n * 10n ** 24n, terms.nftPrice), true)
        .failedChecks,
    ).toEqual(["curve_caps"]);
    expect(
      run(facts(terms.nftPrice, terms.maxCumulativeBuy, 10n ** 20n), true)
        .failedChecks,
    ).toEqual(["buyback_params"]);
    expect(
      run(facts(terms.nftPrice, terms.maxCumulativeBuy, undefined), true)
        .failedChecks,
    ).toEqual(["buyback_params"]);
  });

  it("keeps the template constants without terms (pre-S359)", () => {
    expect(run(passingFacts(), false).failedChecks).toEqual([]);
    expect(
      run(facts(terms.nftPrice, terms.maxCumulativeBuy, terms.nftPrice), false)
        .failedChecks,
    ).toEqual(["curve_caps", "nft_params"]);
  });
});
