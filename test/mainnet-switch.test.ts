import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  loadConfig,
  loadReconciliationWorkerConfig,
} from "../src/config.js";
import {
  launchMainnetAckPhrase,
  launchSlotActionsOpen,
  launchSlotRefusal,
  type LaunchSlotPolicy,
} from "../src/features/chain/chain-contract.js";
import {
  createHooksLaunchDeploymentService,
  HooksLaunchDeploymentError,
  type HooksLaunchFactoryReader,
} from "../src/features/launch/hooks-launch-deployment.js";
import {
  createHooksLaunchSubmissionService,
  HooksLaunchSubmissionError,
} from "../src/features/launch/hooks-launch-submission.js";
import {
  createLaunch2DynamicPokeLane,
  type Launch2DynamicPokeChain,
} from "../src/features/launch2/launch2-dynamic-poke.js";
import {
  createLaunch2SnapshotPublisher,
  type Launch2PublicationRepository,
  type Launch2PublisherChain,
  type Launch2SnapshotSigner,
} from "../src/features/launch2/launch2-snapshot-publisher.js";
import { miningClaimUnavailableReason } from "../src/features/mining/hourly-rewards-service.js";

/**
 * Decision 0150: the mainnet switch matrix (chain × LAUNCH_MAINNET_ACK ×
 * BSC_WRITES_ENABLED × lane switch) on the API and worker configuration,
 * and the action-layer gate (wrong chain / 56 without ack / 56 with ack).
 */

const ack = launchMainnetAckPhrase;
const factory = "0x1111111111111111111111111111111111111111";
const hash = `0x${"ab".repeat(32)}`;
const key = `0x${"42".repeat(32)}`;
const otherKey = `0x${"43".repeat(32)}`;

function apiEnvironment(
  overrides: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: "3000",
    PUBLIC_BASE_URL: "http://127.0.0.1:3000",
    API_DOCS_ENABLED: "false",
    TRUST_PROXY: "false",
    LOG_LEVEL: "silent",
    DATABASE_URL:
      "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
    ...overrides,
  };
}

const workerBase = {
  DATABASE_URL: "postgres://loop:loop@127.0.0.1:5432/loop_test",
};

function refusalOf(load: () => unknown): string {
  try {
    load();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationError);
    const text = `${(error as Error).message} ${JSON.stringify(error)}`;
    // No key ever reaches a refusal.
    expect(text).not.toContain("42".repeat(32));
    expect(text).not.toContain("43".repeat(32));
    return text;
  }
  throw new Error("expected a configuration refusal");
}

/** The four launch-slot contract pairs S212 found refused on 56. */
const contractPairs = [
  {
    HOOKS_LAUNCH_FACTORY_ADDRESS: factory,
    HOOKS_LAUNCH_FACTORY_CODE_HASH: hash,
  },
  {
    LAUNCH2_POOL_ROUTER_ADDRESS: factory,
    LAUNCH2_POOL_ROUTER_CODE_HASH: hash,
  },
  {
    LAUNCH2_DYNAMIC_FACTORY_ADDRESS: factory,
    LAUNCH2_DYNAMIC_FACTORY_CODE_HASH: hash,
  },
  {
    LAUNCH2_DYNAMIC_ROUTER_ADDRESS: factory,
    LAUNCH2_DYNAMIC_ROUTER_CODE_HASH: hash,
  },
] as const;

const mainnetBscPrimary = {
  BSC_RPC_URLS: "https://bsc.example/rpc",
} as const;

describe("Decision 0150 LAUNCH_MAINNET_ACK parsing", () => {
  it("is off by default on both chains and never opens 97", () => {
    expect(loadConfig(apiEnvironment()).launchChain).toMatchObject({
      chainId: "eip155:56",
      mainnetAcknowledged: false,
    });
    expect(
      loadConfig(apiEnvironment({ LAUNCH_CHAIN_ID: "97" })).launchChain,
    ).toMatchObject({ chainId: "eip155:97", mainnetAcknowledged: false });
    expect(
      loadReconciliationWorkerConfig(workerBase).launchChain
        .mainnetAcknowledged,
    ).toBe(false);
  });

  it("acknowledges chain 56 only with the exact phrase", () => {
    expect(
      loadConfig(apiEnvironment({ LAUNCH_MAINNET_ACK: ack })).launchChain
        .mainnetAcknowledged,
    ).toBe(true);
    expect(
      loadReconciliationWorkerConfig({
        ...workerBase,
        LAUNCH_MAINNET_ACK: ack,
      }).launchChain.mainnetAcknowledged,
    ).toBe(true);
    // Blank is the default (not acknowledged), never a refusal.
    expect(
      loadConfig(apiEnvironment({ LAUNCH_MAINNET_ACK: "  " })).launchChain
        .mainnetAcknowledged,
    ).toBe(false);
  });

  it.each([
    ["a different phrase", "yes"],
    ["the phrase in lower case", ack.toLowerCase()],
    ["the phrase with padding", ` ${ack} `],
  ])("refuses boot for %s", (_name, value) => {
    const api = refusalOf(() =>
      loadConfig(apiEnvironment({ LAUNCH_MAINNET_ACK: value })),
    );
    expect(api).toContain("LAUNCH_MAINNET_ACK");
    const worker = refusalOf(() =>
      loadReconciliationWorkerConfig({
        ...workerBase,
        LAUNCH_MAINNET_ACK: value,
      }),
    );
    expect(worker).toContain("LAUNCH_MAINNET_ACK");
  });

  it("refuses the phrase on BSC Testnet (97 + ack is refused, not ignored)", () => {
    const text = refusalOf(() =>
      loadConfig(
        apiEnvironment({ LAUNCH_CHAIN_ID: "97", LAUNCH_MAINNET_ACK: ack }),
      ),
    );
    expect(text).toContain("LAUNCH_MAINNET_ACK");
    expect(text).toContain("LAUNCH_CHAIN_ID=56");
    expect(
      refusalOf(() =>
        loadReconciliationWorkerConfig({
          ...workerBase,
          LAUNCH_CHAIN_ID: "97",
          LAUNCH_MAINNET_ACK: ack,
        }),
      ),
    ).toContain("LAUNCH_CHAIN_ID=56");
  });
});

describe("Decision 0150 launch-slot contract keys", () => {
  it.each(contractPairs)(
    "97: accepted as before (%o)",
    (pair: Readonly<Record<string, string>>) => {
      expect(() =>
        loadConfig(apiEnvironment({ LAUNCH_CHAIN_ID: "97", ...pair })),
      ).not.toThrow();
      expect(() =>
        loadReconciliationWorkerConfig({
          ...workerBase,
          LAUNCH_CHAIN_ID: "97",
          ...pair,
        }),
      ).not.toThrow();
    },
  );

  it.each(contractPairs)(
    "56 without the ack: refused with the pre-0150 message (%o)",
    (pair: Readonly<Record<string, string>>) => {
      expect(refusalOf(() => loadConfig(apiEnvironment(pair)))).toContain(
        "is permitted only when LAUNCH_CHAIN_ID=97",
      );
    },
  );

  it("56 without the ack: the worker refuses the Factory pairs too", () => {
    for (const pair of [contractPairs[0], contractPairs[1], contractPairs[2]]) {
      expect(
        refusalOf(() =>
          loadReconciliationWorkerConfig({ ...workerBase, ...pair }),
        ),
      ).toContain("is permitted only when LAUNCH_CHAIN_ID=97");
    }
  });

  it.each(contractPairs)(
    "56 with the ack: accepted (%o)",
    (pair: Readonly<Record<string, string>>) => {
      expect(() =>
        loadConfig(apiEnvironment({ LAUNCH_MAINNET_ACK: ack, ...pair })),
      ).not.toThrow();
    },
  );

  it("56 with the ack: the API exposes the pairs and the worker indexes the Factory", () => {
    const config = loadConfig(
      apiEnvironment({
        LAUNCH_MAINNET_ACK: ack,
        ...contractPairs[0],
        ...contractPairs[1],
        ...contractPairs[3],
      }),
    );
    expect(config.hooksLaunch.factoryAddress).toBe(factory);
    expect(config.launch2.poolRouter).toMatchObject({ address: factory });
    expect(config.launch2.dynamicRouter).toMatchObject({ address: factory });
    const worker = loadReconciliationWorkerConfig({
      ...workerBase,
      LAUNCH_MAINNET_ACK: ack,
      LAUNCH2_INDEXER_ENABLED: "true",
      ...contractPairs[0],
    });
    expect(worker.launch2Indexer?.factoryAddress).toBe(factory);
  });

  it("56 with the ack: address and code-hash validation is unchanged", () => {
    expect(
      refusalOf(() =>
        loadConfig(
          apiEnvironment({
            LAUNCH_MAINNET_ACK: ack,
            HOOKS_LAUNCH_FACTORY_ADDRESS: factory,
            HOOKS_LAUNCH_FACTORY_CODE_HASH: "0x1234",
          }),
        ),
      ),
    ).toContain("32-byte runtime code hash");
    expect(
      refusalOf(() =>
        loadConfig(
          apiEnvironment({
            LAUNCH_MAINNET_ACK: ack,
            LAUNCH2_POOL_ROUTER_ADDRESS: factory,
          }),
        ),
      ),
    ).toContain("must be configured together");
  });

  it("56 with the ack: the testnet faucet stays refused", () => {
    expect(
      refusalOf(() =>
        loadConfig(
          apiEnvironment({
            LAUNCH_MAINNET_ACK: ack,
            TESTNET_FAUCET_ENABLED: "true",
          }),
        ),
      ),
    ).toContain("TESTNET_FAUCET_ENABLED is permitted only when");
  });
});

/** Each server-signed lane, its switch, and what it needs besides the ack. */
const lanes = [
  {
    name: "Hooks executor",
    switchKey: "HOOKS_LAUNCH_EXECUTOR_ENABLED",
    env: {
      HOOKS_LAUNCH_EXECUTOR_ENABLED: "on",
      HOOKS_LAUNCH_EXECUTOR_PRIVATE_KEY: key,
      ...contractPairs[0],
    },
    configKey: "hooksLaunchExecutor",
    needsChainGuard: true,
  },
  {
    name: "snapshot publisher",
    switchKey: "LAUNCH2_SNAPSHOT_PUBLISHER_ENABLED",
    env: {
      LAUNCH2_SNAPSHOT_PUBLISHER_ENABLED: "true",
      LAUNCH2_SNAPSHOT_SIGNER_PRIVATE_KEYS: `${key},${otherKey}`,
      LAUNCH2_SNAPSHOT_SUBMITTER_PRIVATE_KEY: key,
    },
    configKey: "launch2SnapshotPublisher",
    needsChainGuard: false,
  },
  {
    name: "dynamic poke keeper",
    switchKey: "LAUNCH2_DYNAMIC_POKE_ENABLED",
    env: {
      LAUNCH2_DYNAMIC_POKE_ENABLED: "true",
      LAUNCH2_DYNAMIC_POKE_PRIVATE_KEY: key,
    },
    configKey: "launch2DynamicPoke",
    needsChainGuard: true,
  },
  {
    name: "buyback keeper",
    switchKey: "LAUNCH2_BUYBACK_KEEPER_ENABLED",
    env: {
      LAUNCH2_BUYBACK_KEEPER_ENABLED: "true",
      LAUNCH2_BUYBACK_KEEPER_PRIVATE_KEY: key,
      ...contractPairs[0],
    },
    configKey: "launch2BuybackKeeper",
    needsChainGuard: true,
  },
] as const;

describe("Decision 0150 worker write lanes", () => {
  describe.each(lanes)("$name", (lane) => {
    const load = (overrides: Readonly<Record<string, string>>) =>
      loadReconciliationWorkerConfig({
        ...workerBase,
        ...lane.env,
        ...overrides,
      });

    it("97: enabled exactly as before, without BSC_WRITES_ENABLED", () => {
      const config = load({
        LAUNCH_CHAIN_ID: "97",
        LAUNCH_BSC_RPC_URLS: "https://bsc-testnet.example/rpc",
      });
      expect(config[lane.configKey]).not.toBeNull();
    });

    it("56 without the ack: refused with the pre-0150 message, whatever the write switch", () => {
      for (const writes of ["false", "true"]) {
        const text = refusalOf(() =>
          load({ ...mainnetBscPrimary, BSC_WRITES_ENABLED: writes }),
        );
        // Lanes that need the Factory pair are refused at the pair first
        // (schema refinement); either way the pre-0150 97-only refusal.
        expect(text).toMatch(
          !("HOOKS_LAUNCH_FACTORY_ADDRESS" in lane.env)
            ? `${lane.switchKey}: permitted only when LAUNCH_CHAIN_ID=97 (BSC Mainnet signing stays closed)`
            : "HOOKS_LAUNCH_FACTORY_ADDRESS: is permitted only when LAUNCH_CHAIN_ID=97",
        );
      }
    });

    it("56 with the ack but without BSC_WRITES_ENABLED: refused", () => {
      const text = refusalOf(() =>
        load({
          ...mainnetBscPrimary,
          LAUNCH_MAINNET_ACK: ack,
          CHAIN_GUARD_ENABLED: "true",
        }),
      );
      expect(text).toContain(
        `${lane.switchKey}: on LAUNCH_CHAIN_ID=56 also requires BSC_WRITES_ENABLED=true`,
      );
    });

    it("56 with the ack and BSC_WRITES_ENABLED: chain guard rule as documented", () => {
      const open = {
        ...mainnetBscPrimary,
        LAUNCH_MAINNET_ACK: ack,
        BSC_WRITES_ENABLED: "true",
      };
      if (lane.needsChainGuard) {
        expect(refusalOf(() => load(open))).toContain(
          `${lane.switchKey}: on LAUNCH_CHAIN_ID=56 also requires CHAIN_GUARD_ENABLED=true`,
        );
        expect(
          load({ ...open, CHAIN_GUARD_ENABLED: "true" })[lane.configKey],
        ).not.toBeNull();
      } else {
        expect(load(open)[lane.configKey]).not.toBeNull();
      }
    });

    it("56 with the ack, BSC_WRITES_ENABLED and the chain guard but the lane off: nothing runs", () => {
      const config = loadReconciliationWorkerConfig({
        ...workerBase,
        ...mainnetBscPrimary,
        LAUNCH_MAINNET_ACK: ack,
        BSC_WRITES_ENABLED: "true",
        CHAIN_GUARD_ENABLED: "true",
        ...contractPairs[0],
      });
      expect(config[lane.configKey]).toBeNull();
    });
  });
});

describe("Decision 0150 launch-slot gate", () => {
  const testnet: LaunchSlotPolicy = {
    chainReference: 97,
    mainnetAcknowledged: false,
  };
  const mainnetClosed: LaunchSlotPolicy = {
    chainReference: 56,
    mainnetAcknowledged: false,
  };
  const mainnetOpen: LaunchSlotPolicy = {
    chainReference: 56,
    mainnetAcknowledged: true,
  };

  it("opens 97 always and 56 only with the ack", () => {
    expect(launchSlotActionsOpen(testnet)).toBe(true);
    expect(launchSlotActionsOpen(mainnetClosed)).toBe(false);
    expect(launchSlotActionsOpen(mainnetOpen)).toBe(true);
    expect(launchSlotRefusal(testnet, 97)).toBeNull();
    expect(launchSlotRefusal(testnet, 56)).toBe("wrong_chain");
    expect(launchSlotRefusal(mainnetOpen, 97)).toBe("wrong_chain");
    expect(launchSlotRefusal(mainnetClosed, 56)).toBe("not_acknowledged");
    expect(launchSlotRefusal(mainnetOpen, 56)).toBeNull();
  });

  function reader(chainId: number): HooksLaunchFactoryReader {
    return { factoryAddress: factory, chainId } as HooksLaunchFactoryReader;
  }

  async function deploymentOutcome(
    slot: LaunchSlotPolicy | undefined,
    chainId: number,
  ): Promise<string> {
    const service = createHooksLaunchDeploymentService({
      configs: {} as never,
      // Past the gate the next step is the wallet read: null → invalid.
      wallets: { get: () => Promise.resolve(null) } as never,
      reader: reader(chainId),
      signatureLifetimeSeconds: 900,
      maxSaltAttempts: 1,
      ...(slot === undefined ? {} : { launchSlot: slot }),
    });
    try {
      await service.prepareSigningRequest({
        ownerUserId: "00000000-0000-4000-8000-000000000001",
        projectId: "00000000-0000-4000-8000-000000000002",
        walletId: "00000000-0000-4000-8000-000000000003",
      });
    } catch (error) {
      expect(error).toBeInstanceOf(HooksLaunchDeploymentError);
      return (error as HooksLaunchDeploymentError).kind;
    }
    throw new Error("expected a refusal");
  }

  it("Hooks signing request: wrong chain and 56 without the ack are unavailable; 56 + ack passes", async () => {
    expect(await deploymentOutcome(undefined, 97)).toBe("invalid");
    expect(await deploymentOutcome(undefined, 56)).toBe("unavailable");
    expect(await deploymentOutcome(testnet, 56)).toBe("unavailable");
    expect(await deploymentOutcome(mainnetOpen, 97)).toBe("unavailable");
    expect(await deploymentOutcome(mainnetClosed, 56)).toBe("unavailable");
    expect(await deploymentOutcome(mainnetOpen, 56)).toBe("invalid");
  });

  async function submissionOutcome(
    slot: LaunchSlotPolicy | undefined,
    chainId: number,
  ): Promise<string> {
    const service = createHooksLaunchSubmissionService({
      configs: {} as never,
      wallets: {} as never,
      reader: reader(chainId),
      repository: {} as never,
      ...(slot === undefined ? {} : { launchSlot: slot }),
    });
    try {
      // Past the gate the next step is the body schema: {} → invalid.
      await service.submit({
        ownerUserId: "00000000-0000-4000-8000-000000000001",
        projectId: "00000000-0000-4000-8000-000000000002",
        idempotencyKey: "00000000-0000-4000-8000-000000000004",
        body: {},
      });
    } catch (error) {
      expect(error).toBeInstanceOf(HooksLaunchSubmissionError);
      return (error as HooksLaunchSubmissionError).kind;
    }
    throw new Error("expected a refusal");
  }

  it("Hooks submission: wrong chain and 56 without the ack are unavailable; 56 + ack passes", async () => {
    expect(await submissionOutcome(undefined, 97)).toBe("invalid");
    expect(await submissionOutcome(undefined, 56)).toBe("unavailable");
    expect(await submissionOutcome(mainnetOpen, 97)).toBe("unavailable");
    expect(await submissionOutcome(mainnetClosed, 56)).toBe("unavailable");
    expect(await submissionOutcome(mainnetOpen, 56)).toBe("invalid");
  });

  function pokeLane(chainId: number, options: Record<string, unknown>) {
    const chain = {
      pokerAddress: factory,
      chainId: () => Promise.resolve(chainId),
    } as unknown as Launch2DynamicPokeChain;
    return createLaunch2DynamicPokeLane({
      repository: { listLaneInstances: () => Promise.resolve([]) },
      chain,
      chainId: chainId === 56 ? "eip155:56" : "eip155:97",
      intervalSeconds: 60,
      ...options,
    });
  }

  it("poke keeper: wrong chain, 56 without the ack, 56 + ack", async () => {
    expect(await pokeLane(56, {}).runOnce()).toMatchObject({
      reasonCode: "LAUNCH2_CHAIN_MISMATCH",
    });
    expect(
      await pokeLane(56, { expectedChainReference: 56 }).runOnce(),
    ).toMatchObject({ reasonCode: "LAUNCH_MAINNET_NOT_ACKNOWLEDGED" });
    const open = await pokeLane(56, {
      expectedChainReference: 56,
      mainnetAcknowledged: true,
    }).runOnce();
    expect(open).not.toHaveProperty("reasonCode");
    expect(open).toMatchObject({ checked: 0, poked: 0 });
    // 97 ignores the flag entirely.
    expect(await pokeLane(97, {}).runOnce()).toMatchObject({ checked: 0 });
  });

  function publisher(chainId: number, policy: Record<string, unknown>) {
    const signers: Launch2SnapshotSigner[] = ["1", "2"].map((digit) => ({
      address: `0x${digit.repeat(40)}`,
      digest: () => `0x${"dd".repeat(32)}`,
      sign: () => Promise.resolve(`0x${digit.repeat(130)}`),
    }));
    const chain = {
      submitterAddress: factory,
      chainId: () => Promise.resolve(chainId),
      head: () =>
        Promise.resolve({
          number: 1n,
          hash: `0x${"ee".repeat(32)}`,
          timestamp: 1n,
        }),
    } as unknown as Launch2PublisherChain;
    return createLaunch2SnapshotPublisher({
      repository: {
        listCandidates: () => Promise.resolve([]),
      } as unknown as Launch2PublicationRepository,
      launch2: {
        getCheckpoint: () => Promise.resolve(null),
        nftHoldersAt: () => Promise.resolve([]),
      },
      chain,
      signers,
      policy: {
        chainId: "eip155:56",
        confirmations: 3,
        maxGasPriceWei: 5_000_000_000n,
        gasLimitCap: 1_000_000n,
        maxAttempts: 2,
        retryDelaySeconds: 0,
        ...policy,
      },
    });
  }

  it("snapshot publisher: wrong chain, 56 without the ack, 56 + ack", async () => {
    expect((await publisher(97, {}).runOnce()).reasonCode).toBe(
      "LAUNCH2_SNAPSHOT_CHAIN_MISMATCH",
    );
    expect((await publisher(56, {}).runOnce()).reasonCode).toBe(
      "LAUNCH_MAINNET_NOT_ACKNOWLEDGED",
    );
    const open = await publisher(56, { mainnetAcknowledged: true }).runOnce();
    expect(open.kind).not.toBe("unavailable");
  });

  it("Mining claim voucher: 56 is closed without the ack and open with it", () => {
    const deps = {
      repository: {} as never,
      chain: {} as never,
      callClient: {} as never,
      signer: {} as never,
      contractAddress: factory,
      writesEnabled: true,
      wallets: {} as never,
    };
    expect(
      miningClaimUnavailableReason({ ...deps, chainId: "eip155:97" }),
    ).toBeNull();
    expect(
      miningClaimUnavailableReason({ ...deps, chainId: "eip155:56" }),
    ).toBe("MINING_CLAIM_MAINNET_CLOSED");
    expect(
      miningClaimUnavailableReason({
        ...deps,
        chainId: "eip155:56",
        mainnetAcknowledged: true,
      }),
    ).toBeNull();
    // The ack never replaces the write switch.
    expect(
      miningClaimUnavailableReason({
        ...deps,
        chainId: "eip155:56",
        mainnetAcknowledged: true,
        writesEnabled: false,
      }),
    ).toBe("MINING_CLAIM_WRITES_DISABLED");
  });
});
