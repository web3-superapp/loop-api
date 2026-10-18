import { describe, expect, it } from "vitest";
import { getCreate2Address, hashTypedData } from "viem";

import {
  hooksLaunchDeploymentDomain,
  hooksLaunchDeploymentTypes,
  createHooksLaunchDeploymentTypedData,
  mineHooksLaunchSalt,
  mineMemeAddressSalt,
  mineMemeAddressSaltAsync,
  mineHooksLaunchSaltAsync,
  withHooksLaunchEip712Domain,
} from "../src/features/launch/hooks-launch-deployment-crypto.js";
import {
  createHooksLaunchDeploymentService,
  hooksLaunchSigningRequestChainBudgetMs,
  type HooksLaunchFactoryReader,
} from "../src/features/launch/hooks-launch-deployment.js";
import { hooksLaunchFixedEconomics } from "../src/features/launch/hooks-launch-config.js";
import type { AccountWalletRepository } from "../src/database/account-wallet-repository.js";
import type {
  HooksLaunchProjectConfigRepository,
  HooksLaunchProjectConfigRecord,
} from "../src/features/launch/hooks-launch-project-config.js";

describe("Hooks launch deployment crypto", { timeout: 60_000 }, () => {
  it("defines the exact EIP-712 domain and LaunchRequest field order used by Solidity", () => {
    expect(
      hooksLaunchDeploymentDomain(
        97,
        "0x1111111111111111111111111111111111111111",
      ),
    ).toEqual({
      name: "LOOP Launch Factory",
      version: "1",
      chainId: 97,
      verifyingContract: "0x1111111111111111111111111111111111111111",
    });
    expect(
      hooksLaunchDeploymentTypes.LaunchRequest.map(({ name, type }) => [
        name,
        type,
      ]),
    ).toEqual([
      ["configHash", "bytes32"],
      ["projectOwner", "address"],
      ["configVersion", "uint32"],
      ["name", "string"],
      ["ticker", "string"],
      ["nftSaleStart", "uint64"],
      ["buybackRecipient", "address"],
      ["deadline", "uint64"],
      ["memeSalt", "bytes32"],
      ["nonce", "uint256"],
      ["templateHash", "bytes32"],
    ]);
  });

  it("mines an independent MEME vanity salt ending in 6666 without changing Hook permission bits", () => {
    const result = mineMemeAddressSalt({
      deployer: "0x1234567890123456789012345678901234567890",
      launchId: `0x${"11".repeat(32)}`,
      initCodeHash: `0x${"ab".repeat(32)}`,
      maxAttempts: 1_000_000,
    });
    expect(result.address.toLowerCase()).toMatch(/6666$/);
    expect(result.salt).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("mines a deterministic CREATE2 salt whose Hook address has the required permission bits", () => {
    const deployer = "0x1234567890123456789012345678901234567890" as const;
    const initCodeHash = `0x${"ab".repeat(32)}` as const;
    const salt = mineHooksLaunchSalt({
      deployer,
      initCodeHash,
      maxAttempts: 100_000,
    });
    const address = getCreate2Address({
      from: deployer,
      salt,
      bytecodeHash: initCodeHash,
    });

    expect(BigInt(address) & 0x3fffn).toBe(0x20ccn);
    expect(
      mineHooksLaunchSalt({ deployer, initCodeHash, maxAttempts: 100_000 }),
    ).toBe(salt);
  });

  it("builds a JSON-safe wallet signing request bound to the owner, config, factory nonce, and template", () => {
    const typedData = createHooksLaunchDeploymentTypedData({
      chainId: 97,
      verifyingContract: "0x1111111111111111111111111111111111111111",
      request: {
        configHash: `0x${"cd".repeat(32)}`,
        projectOwner: "0x2222222222222222222222222222222222222222",
        configVersion: 3,
        name: "Project",
        ticker: "MEME",
        nftSaleStart: "1800000000",
        buybackRecipient: "0x3333333333333333333333333333333333333333",
        deadline: "1800000900",
        memeSalt: `0x${"00".repeat(32)}`,
        nonce: "7",
      },
    });

    expect(typedData.message).toMatchObject({
      projectOwner: "0x2222222222222222222222222222222222222222",
      configVersion: 3,
      nftSaleStart: "1800000000",
      deadline: "1800000900",
      nonce: "7",
    });
    expect(typedData.message.templateHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(JSON.stringify(typedData)).not.toContain("1800000000n");
  });

  it("adds the standard EIP712Domain type without changing the digest (Decision 0120)", () => {
    const typedData = createHooksLaunchDeploymentTypedData({
      chainId: 97,
      verifyingContract: "0x1111111111111111111111111111111111111111",
      request: {
        configHash: `0x${"cd".repeat(32)}`,
        projectOwner: "0x2222222222222222222222222222222222222222",
        configVersion: 3,
        name: "Project",
        ticker: "MEME",
        nftSaleStart: "1800000000",
        buybackRecipient: "0x3333333333333333333333333333333333333333",
        deadline: "1800000900",
        memeSalt: `0x${"00".repeat(32)}`,
        nonce: "7",
      },
    });
    const wire = withHooksLaunchEip712Domain(typedData);
    expect(Object.keys(wire.types)).toEqual(["EIP712Domain", "LaunchRequest"]);
    expect(wire.types.EIP712Domain).toEqual([
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ]);
    expect(wire.types.LaunchRequest).toBe(typedData.types.LaunchRequest);
    expect(wire.domain).toBe(typedData.domain);
    expect(wire.message).toBe(typedData.message);
    const message = {
      ...typedData.message,
      nftSaleStart: BigInt(typedData.message.nftSaleStart),
      deadline: BigInt(typedData.message.deadline),
      nonce: BigInt(typedData.message.nonce),
    };
    // The JSON a wallet receives (EIP712Domain listed explicitly) hashes to
    // the same digest the submission verifies against.
    const json = JSON.parse(JSON.stringify(wire)) as {
      domain: Record<string, unknown>;
      types: Record<string, { name: string; type: string }[]>;
    };
    expect(
      hashTypedData({
        domain: { ...json.domain, chainId: 97n },
        types: json.types,
        primaryType: "LaunchRequest",
        message,
      }),
    ).toBe(
      hashTypedData({
        domain: typedData.domain,
        types: typedData.types,
        primaryType: "LaunchRequest",
        message,
      }),
    );
  });

  it("rejects an invalid salt search budget", () => {
    expect(() =>
      mineHooksLaunchSalt({
        deployer: "0x1234567890123456789012345678901234567890",
        initCodeHash: `0x${"ab".repeat(32)}`,
        maxAttempts: 0,
      }),
    ).toThrow("Invalid Hook salt search input");
  });

  it("prepares signing data only for the owner's active registered wallet and current saved config", async () => {
    const config: HooksLaunchProjectConfigRecord = {
      projectId: "00000000-0000-4000-8000-000000000001",
      ownerUserId: "user-1",
      version: 4,
      templateVersion: "hooks_launch_v1",
      config: {
        templateVersion: "hooks_launch_v1",
        templateHash: `0x${"01".repeat(32)}`,
        name: "Project",
        ticker: "MEME",
        logoAssetUrl: "https://example.com/logo.png",
        description: "description",
        links: [],
        nftSaleStartAt: "1800000000",
        buybackRecipient: "0x3333333333333333333333333333333333333333",
        fixedEconomics: hooksLaunchFixedEconomics,
        configHash: `0x${"cd".repeat(32)}`,
      },
      updatedAt: "2026-10-09T00:00:00.000Z",
    };
    const repository = {
      getOwnedDraft: () => Promise.resolve(config),
      saveOwnedDraft: () => Promise.resolve(config),
      getOwnedProgress: () =>
        Promise.resolve({
          approvedAt: null,
          rejection: null,
          latestJobId: null,
        }),
    } as HooksLaunchProjectConfigRepository;
    const wallets = {
      get: (userId: string, walletId: string) =>
        Promise.resolve(
          userId === "user-1" && walletId === "wallet-1"
            ? {
                walletId,
                providerWalletId: "privy-wallet-1",
                address: "0x2222222222222222222222222222222222222222",
                kind: "embedded",
                status: "active",
                isActive: true,
                firstSeenAt: "2026-01-01T00:00:00.000Z",
                lastSeenAt: "2026-10-09T00:00:00.000Z",
              }
            : null,
        ),
    } as AccountWalletRepository;
    const reader: HooksLaunchFactoryReader = {
      factoryAddress: "0x1111111111111111111111111111111111111111",
      chainId: 97,
      nonce: () => Promise.resolve(7n),
      ownerVersionLaunchId: () => Promise.resolve(`0x${"0".repeat(64)}`),
      nftSaleDuration: () =>
        Promise.resolve({ seconds: 604_800, legacy: false }),
      tokenDeployment: () =>
        Promise.resolve({
          deployer: "0x5555555555555555555555555555555555555555",
          initCodeHash: `0x${"ef".repeat(32)}`,
        }),
      hookDeployment: () =>
        Promise.resolve({
          deployer: "0x4444444444444444444444444444444444444444",
          initCodeHash: `0x${"ab".repeat(32)}`,
        }),
    };
    const service = createHooksLaunchDeploymentService({
      fixedBuybackRecipient: "0x3333333333333333333333333333333333333333",
      configs: repository,
      wallets,
      reader,
      now: () => 1_800_000_000,
      signatureLifetimeSeconds: 900,
      maxSaltAttempts: 1_000_000,
    });

    const prepared = await service.prepareSigningRequest({
      ownerUserId: "user-1",
      projectId: config.projectId,
      walletId: "wallet-1",
    });

    expect(prepared.request).toMatchObject({
      projectOwner: "0x2222222222222222222222222222222222222222",
      configVersion: 4,
      configHash: config.config.configHash,
      nftSaleStart: "1800000000",
      nonce: "7",
    });
    expect(prepared.request.memeSalt).toMatch(/^0x[0-9a-f]{64}$/);
    expect(prepared.memeAddress.toLowerCase()).toMatch(/6666$/);
    expect(BigInt(prepared.hookAddress) & 0x3fffn).toBe(0x20ccn);
    expect(prepared.typedData.domain.chainId).toBe(97);
    expect(prepared.typedData.message.deadline).toBe("1800000900");
  });

  it("does not prepare a signing request for a wallet that is not the owner's active wallet", async () => {
    const service = createHooksLaunchDeploymentService({
      fixedBuybackRecipient: "0x3333333333333333333333333333333333333333",
      configs: {
        getOwnedDraft: () => Promise.resolve(null),
        saveOwnedDraft: () => Promise.reject(new Error("unused")),
        getOwnedProgress: () => Promise.reject(new Error("unused")),
      },
      wallets: {
        get: () => Promise.resolve(null),
      } as unknown as AccountWalletRepository,
      reader: {
        factoryAddress: "0x1111111111111111111111111111111111111111",
        chainId: 97,
        nonce: () => Promise.resolve(0n),
        ownerVersionLaunchId: () => Promise.resolve(`0x${"0".repeat(64)}`),
        nftSaleDuration: () =>
          Promise.resolve({ seconds: 604_800, legacy: false }),
        tokenDeployment: () => Promise.reject(new Error("unused")),
        hookDeployment: () =>
          Promise.resolve({
            deployer: "0x4444444444444444444444444444444444444444",
            initCodeHash: `0x${"ab".repeat(32)}`,
          }),
      },
      now: () => 1_800_000_000,
      signatureLifetimeSeconds: 900,
      maxSaltAttempts: 10,
    });
    await expect(
      service.prepareSigningRequest({
        ownerUserId: "user-1",
        projectId: "00000000-0000-4000-8000-000000000001",
        walletId: "foreign-wallet",
      }),
    ).rejects.toThrow("Hooks launch signing wallet unavailable");
  });
});

describe("cooperative salt mining", { timeout: 60_000 }, () => {
  it("lets unrelated I/O run while preserving deterministic addresses", async () => {
    const input = {
      deployer: "0x1111111111111111111111111111111111111111",
      launchId: `0x${"22".repeat(32)}`,
      initCodeHash: `0x${"33".repeat(32)}`,
      maxAttempts: 1_000_000,
    };
    let eventLoopRan = false;
    const tick = new Promise<void>((resolve) =>
      setImmediate(() => {
        eventLoopRan = true;
        resolve();
      }),
    );
    const result = await mineMemeAddressSaltAsync(input);
    expect(eventLoopRan).toBe(true);
    await tick;
    expect(result).toEqual(mineMemeAddressSalt(input));
    expect(await mineHooksLaunchSaltAsync(input)).toEqual(
      mineHooksLaunchSalt(input),
    );
  });
});

describe("deployment preparation admission control", () => {
  it("bounds overlapping work and releases slots after RPC/repository failure", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = createHooksLaunchDeploymentService({
      fixedBuybackRecipient: "0x3333333333333333333333333333333333333333",
      configs: {} as HooksLaunchProjectConfigRepository,
      wallets: {
        get: async () => {
          await blocked;
          return null;
        },
      } as unknown as AccountWalletRepository,
      reader: { chainId: 97 } as HooksLaunchFactoryReader,
      signatureLifetimeSeconds: 900,
      maxSaltAttempts: 1_000_000,
    });
    const request = {
      ownerUserId: "owner",
      projectId: "project",
      walletId: "wallet",
    };
    const pending = Array.from({ length: 4 }, () =>
      service.prepareSigningRequest(request).catch((error: unknown) => error),
    );
    await expect(service.prepareSigningRequest(request)).rejects.toThrow(
      "busy; retry later",
    );
    release();
    const results = await Promise.all(pending);
    expect(
      results.every(
        (error) =>
          error instanceof Error &&
          error.message.includes("wallet unavailable"),
      ),
    ).toBe(true);
    await expect(service.prepareSigningRequest(request)).rejects.toThrow(
      "wallet unavailable",
    );
  });
});

describe(
  "signing-request chain-read budget (Decision 0160)",
  { timeout: 60_000 },
  () => {
    const config: HooksLaunchProjectConfigRecord = {
      projectId: "00000000-0000-4000-8000-000000000001",
      ownerUserId: "user-1",
      version: 4,
      templateVersion: "hooks_launch_v1",
      config: {
        templateVersion: "hooks_launch_v1",
        templateHash: `0x${"01".repeat(32)}`,
        name: "Project",
        ticker: "MEME",
        logoAssetUrl: "https://example.com/logo.png",
        description: "description",
        links: [],
        nftSaleStartAt: "1800000000",
        buybackRecipient: "0x3333333333333333333333333333333333333333",
        fixedEconomics: hooksLaunchFixedEconomics,
        configHash: `0x${"cd".repeat(32)}`,
      },
      updatedAt: "2026-10-09T00:00:00.000Z",
    };
    const baseReader: HooksLaunchFactoryReader = {
      factoryAddress: "0x1111111111111111111111111111111111111111",
      chainId: 97,
      nonce: () => Promise.resolve(7n),
      ownerVersionLaunchId: () => Promise.resolve(`0x${"0".repeat(64)}`),
      nftSaleDuration: () =>
        Promise.resolve({ seconds: 604_800, legacy: false }),
      tokenDeployment: () =>
        Promise.resolve({
          deployer: "0x5555555555555555555555555555555555555555",
          initCodeHash: `0x${"ef".repeat(32)}`,
        }),
      hookDeployment: () =>
        Promise.resolve({
          deployer: "0x4444444444444444444444444444444444444444",
          initCodeHash: `0x${"ab".repeat(32)}`,
        }),
    };
    const request = {
      ownerUserId: "user-1",
      projectId: config.projectId,
      walletId: "wallet-1",
    };
    function fixture(options: {
      readonly reader: HooksLaunchFactoryReader;
      readonly chainBudgetMs?: number;
    }) {
      const writes: string[] = [];
      const configs = {
        getOwnedDraft: () => Promise.resolve(config),
        saveOwnedDraft: () => {
          writes.push("saveOwnedDraft");
          return Promise.resolve(config);
        },
        getOwnedProgress: () => Promise.reject(new Error("unused")),
      } as HooksLaunchProjectConfigRepository;
      const wallets = {
        get: () =>
          Promise.resolve({
            walletId: "wallet-1",
            providerWalletId: "privy-wallet-1",
            address: "0x2222222222222222222222222222222222222222",
            kind: "embedded",
            status: "active",
            isActive: true,
            firstSeenAt: "2026-01-01T00:00:00.000Z",
            lastSeenAt: "2026-10-09T00:00:00.000Z",
          }),
      } as unknown as AccountWalletRepository;
      const service = createHooksLaunchDeploymentService({
        fixedBuybackRecipient: "0x3333333333333333333333333333333333333333",
        configs,
        wallets,
        reader: options.reader,
        now: () => 1_800_000_000,
        signatureLifetimeSeconds: 900,
        maxSaltAttempts: 1_000_000,
        ...(options.chainBudgetMs === undefined
          ? {}
          : { chainBudgetMs: options.chainBudgetMs }),
      });
      return { service, writes };
    }

    it("ends a preparation on a hanging Factory read within the budget, unavailable and without writes", async () => {
      const hanging = new Promise<never>(() => undefined);
      const { service, writes } = fixture({
        chainBudgetMs: 200,
        reader: { ...baseReader, nonce: () => hanging },
      });
      const started = Date.now();
      await expect(
        service.prepareSigningRequest(request),
      ).rejects.toMatchObject({
        kind: "unavailable",
      });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(writes).toEqual([]);
      // The default budget stays well inside the 15 s handlerTimeout.
      expect(hooksLaunchSigningRequestChainBudgetMs).toBe(8_000);
      // The admission slot is released after a timeout.
      const ok = fixture({ reader: baseReader });
      expect(
        (await ok.service.prepareSigningRequest(request)).request.nonce,
      ).toBe("7");
    });

    it("also bounds the Hook deployer read that follows the MEME salt search", async () => {
      const hanging = new Promise<never>(() => undefined);
      const { service, writes } = fixture({
        chainBudgetMs: 1_500,
        reader: { ...baseReader, hookDeployment: () => hanging },
      });
      const started = Date.now();
      await expect(
        service.prepareSigningRequest(request),
      ).rejects.toMatchObject({
        kind: "unavailable",
      });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(writes).toEqual([]);
    });

    it("runs the independent Factory reads concurrently, so slow reads do not add up", async () => {
      const events: string[] = [];
      const slow =
        <T>(name: string, value: () => Promise<T>) =>
        async (): Promise<T> => {
          events.push(`start:${name}`);
          await new Promise((resolve) => setTimeout(resolve, 300));
          events.push(`end:${name}`);
          return value();
        };
      const { service } = fixture({
        chainBudgetMs: 1_150,
        reader: {
          ...baseReader,
          nftSaleDuration: slow("template", () => baseReader.nftSaleDuration()),
          ownerVersionLaunchId: slow("ownerVersion", () =>
            Promise.resolve(`0x${"0".repeat(64)}`),
          ),
          nonce: slow("nonce", () => Promise.resolve(7n)),
          tokenDeployment: (input) =>
            slow("token", () => baseReader.tokenDeployment(input))(),
        },
      });
      const prepared = await service.prepareSigningRequest(request);
      expect(prepared.request.nonce).toBe("7");
      expect(prepared.memeAddress.endsWith("6666")).toBe(true);
      expect(BigInt(prepared.hookAddress) & 0x3fffn).toBe(0x20ccn);
      // Every independent read starts before any of them finishes; run one
      // after another they would need >= 1,200 ms and blow the 1,150 ms budget.
      expect(
        events.slice(0, 4).every((event) => event.startsWith("start:")),
      ).toBe(true);
      expect(events).toHaveLength(8);
    });

    it("keeps the original check order when reads run concurrently", async () => {
      const mismatch = fixture({
        reader: {
          ...baseReader,
          nftSaleDuration: () => Promise.resolve({ seconds: 1, legacy: false }),
          ownerVersionLaunchId: () => Promise.resolve(`0x${"ab".repeat(32)}`),
          nonce: () => Promise.reject(new Error("rpc down")),
        },
      });
      await expect(
        mismatch.service.prepareSigningRequest(request),
      ).rejects.toMatchObject({ kind: "template_mismatch" });

      const used = fixture({
        reader: {
          ...baseReader,
          ownerVersionLaunchId: () => Promise.resolve(`0x${"ab".repeat(32)}`),
          nonce: () => Promise.reject(new Error("rpc down")),
        },
      });
      await expect(
        used.service.prepareSigningRequest(request),
      ).rejects.toMatchObject({ kind: "version_used" });

      const nonceDown = fixture({
        reader: {
          ...baseReader,
          nonce: () => Promise.reject(new Error("rpc down")),
          tokenDeployment: () => Promise.reject(new Error("rpc down")),
        },
      });
      await expect(
        nonceDown.service.prepareSigningRequest(request),
      ).rejects.toMatchObject({ kind: "unavailable" });
    });
  },
);
