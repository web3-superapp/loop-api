import { readFileSync } from "node:fs";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import {
  createUnavailableLaunchRepository,
  type LaunchDetailRecord,
  type LaunchRecord,
  type LaunchRepository,
} from "../src/features/launch/launch-repository.js";
import { launchContractEvidenceFrom } from "../src/features/meta/product-policy.js";
import {
  createLaunchContractAdapter,
  type LaunchContractAdapter,
  type LaunchContractConfig,
} from "../src/integrations/launch/launch-contract-adapter.js";
import {
  createMockLaunchpadChain,
  mockAllowlistRoot,
  mockBlockHash,
  mockBlockNumber,
  mockConfigVersion,
  mockLaunchpadAddress,
  mockLaunchpadTransportFactory,
  mockProjectTokenAddress,
  mockStateTupleDigest,
  mockUsd1Address,
  type MockLaunchpadChain,
} from "./helpers/launchpad-mock-chain.js";
import {
  s7AccountId,
  s7CommandHeaders,
  s7CommonHeaders,
  s7Database,
  s7PrivyVerifier,
  s7TestConfig,
} from "./s7-route-fakes.js";

/**
 * Decision 0076 route contract. The fixtures under
 * `test/fixtures/s83a-baseline/` were generated from the integration/v2
 * sources at 1ab26d7 (before this decision) with exactly the records below;
 * without a configured contract every response must match them byte for byte.
 */

const projectId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const launchId = "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f";
const roundId = "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
const createdAt = "2026-09-08T01:00:00.000Z";

const project = Object.freeze({
  projectId,
  ownerUserId: s7AccountId,
  name: "MoonCat",
  ticker: "MCAT",
  narrative: "A curated meme with a story.",
  officialLinks: {
    website: "https://mooncat.example",
    x: null,
    telegram: null,
    discord: null,
  },
  materialVersion: 1,
  reviewStatus: "approved" as const,
  kybStatus: "unavailable" as const,
  reviewReasonCode: null,
  submittedAt: createdAt,
  reviewedAt: createdAt,
  launchId,
  version: 3,
  createdAt,
  updatedAt: createdAt,
});

const unregistered: LaunchRecord = Object.freeze({
  launchId,
  projectId,
  chainId: "eip155:97",
  contractAddress: null,
  saleId: null,
  contractVersion: null,
  configVersionOnchain: null,
  configDigest: null,
  scheduleStatus: "scheduled",
  createdAt,
  updatedAt: createdAt,
});

const registered: LaunchRecord = Object.freeze({
  ...unregistered,
  contractAddress: mockLaunchpadAddress,
  saleId: "7",
  contractVersion: "1.0.0",
});

const pending: LaunchDetailRecord = {
  launch: unregistered,
  project,
  configs: [
    {
      configId: "7d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5f6",
      launchId,
      configVersion: "launchMoonCatV1",
      parameters: { walletRoundCap: "5000000", tierModeV1: "community" },
      status: "pending_confirmation",
      effectiveAt: null,
    },
  ],
  rounds: [
    {
      roundId,
      launchId,
      roundIndex: 1,
      configVersion: "launchMoonCatV1",
      status: "pending_confirmation",
      startsAt: null,
      endsAt: null,
      priceUsd1: null,
      eligibilityTier: null,
      walletRoundCapRaw: null,
    },
  ],
};

const confirmed: LaunchDetailRecord = {
  ...pending,
  configs: [
    {
      ...pending.configs[0]!,
      parameters: {
        walletRoundCap: "500000000000000000000",
        walletProjectCap: "1000000000000000000000",
        feeBps: "300",
        softCap: "20000000000000000000000",
        hardCap: "100000000000000000000000",
        tge: "2500",
        vesting: "7776000",
        tierModeV1: "whitelist",
      },
      status: "confirmed",
      effectiveAt: createdAt,
    },
  ],
  rounds: [
    {
      ...pending.rounds[0]!,
      status: "confirmed",
      startsAt: "2026-10-01T00:00:00.000Z",
      endsAt: "2026-10-03T00:00:00.000Z",
      priceUsd1: "0.01",
      eligibilityTier: "priority",
      walletRoundCapRaw: "500000000000000000000",
    },
  ],
};

const contract: LaunchContractConfig = Object.freeze({
  address: mockLaunchpadAddress,
  version: "1.0.0",
  versionMajor: 1,
  startBlock: 44_000_000n,
  usd1Address: mockUsd1Address,
});

function repositoryFor(detail: LaunchDetailRecord): LaunchRepository {
  return {
    ...createUnavailableLaunchRepository(),
    getLaunch: vi.fn(() => Promise.resolve(detail)),
    listLaunches: vi.fn(() =>
      Promise.resolve([
        {
          launch: detail.launch,
          projectName: "MoonCat",
          projectTicker: "MCAT",
          confirmedConfigVersion: null,
        },
      ]),
    ),
  };
}

function mockAdapter(
  chain: MockLaunchpadChain,
  overrides: Partial<LaunchContractConfig> = {},
): LaunchContractAdapter {
  return createLaunchContractAdapter({
    contract: { ...contract, ...overrides },
    chain: {
      chainId: "eip155:97",
      chainReference: 97,
      rpcUrls: ["https://launch-rpc.invalid/"],
    },
    verifyChain: () => Promise.resolve("verified"),
    transportFactory: mockLaunchpadTransportFactory(chain),
  });
}

describe("V2 launch routes with the contract adapter (Decision 0076)", () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });

  async function createApp(
    detail: LaunchDetailRecord,
    options: {
      readonly env?: Readonly<Record<string, string>>;
      readonly adapter?: LaunchContractAdapter;
    } = {},
  ) {
    const app = await buildApp({
      config: s7TestConfig(options.env),
      contractSurface: "v2",
      database: s7Database({ launch: repositoryFor(detail) }),
      privyAccessTokenVerifier: s7PrivyVerifier(),
      ...(options.adapter === undefined
        ? {}
        : { launchContractAdapter: options.adapter }),
      logger: false,
    });
    apps.push(app);
    return app;
  }

  const baseline = (name: string): string =>
    readFileSync(
      new URL(`./fixtures/s83a-baseline/${name}.json`, import.meta.url),
      "utf8",
    );
  const withoutClock = (body: string): string =>
    body.replace(/"observedAt":"[^"]+"/g, '"observedAt":"<clock>"');

  it("keeps every Launch response byte-identical to 1ab26d7 while no contract is configured", async () => {
    for (const [name, detail] of [
      ["pending", pending],
      ["confirmed", confirmed],
    ] as const) {
      const app = await createApp(detail);
      for (const [file, url] of [
        [`launch-detail-${name}`, `/v2/launches/${launchId}`],
        [`eligibility-${name}`, `/v2/launch/${launchId}/eligibility`],
        [`holders-${name}`, `/v2/launch/${launchId}/holders`],
        [`history-${name}`, `/v2/launch/${launchId}/history`],
      ] as const) {
        const response = await app.inject({
          method: "GET",
          url,
          headers: s7CommonHeaders(),
        });
        expect(response.statusCode, file).toBe(200);
        expect(response.body, file).toBe(baseline(file));
      }
      const overview = await app.inject({
        method: "GET",
        url: "/v2/launch/overview",
        headers: s7CommonHeaders(),
      });
      expect(withoutClock(overview.body)).toBe(
        withoutClock(baseline(`overview-${name}`)),
      );
      const intent = await app.inject({
        method: "POST",
        url: `/v2/launch/${launchId}/intents`,
        headers: s7CommandHeaders(),
        payload: {
          walletId: "d64786bb-408d-415d-8a69-6277d56c921b",
          roundId,
          payAmount: "100",
        },
      });
      expect(
        JSON.stringify({
          statusCode: intent.statusCode,
          body: intent.body.replace(
            /"correlationId":"[^"]+"/,
            '"correlationId":"<id>"',
          ),
        }),
      ).toBe(baseline(`intents-${name}`));
    }
  });

  it("keeps the unavailable bytes when the adapter is explicitly unconfigured", async () => {
    const chain = createMockLaunchpadChain();
    const adapter = createLaunchContractAdapter({
      contract: null,
      chain: { chainId: "eip155:97", chainReference: 97, rpcUrls: [] },
      verifyChain: () => Promise.resolve("unknown"),
      transportFactory: mockLaunchpadTransportFactory(chain),
    });
    const app = await createApp(
      { ...confirmed, launch: registered },
      {
        adapter,
      },
    );
    const response = await app.inject({
      method: "GET",
      url: `/v2/launches/${launchId}`,
      headers: s7CommonHeaders(),
    });
    // A registered row changes nothing while the four keys are blank.
    expect(response.body).toBe(baseline("launch-detail-confirmed"));
    expect(chain.calls).toEqual([]);
  });

  it("reads the four axes, rounds, and configuration from the contract at one block", async () => {
    const chain = createMockLaunchpadChain();
    const app = await createApp(
      { ...pending, launch: registered },
      { adapter: mockAdapter(chain) },
    );
    const response = await app.inject({
      method: "GET",
      url: `/v2/launches/${launchId}`,
      headers: s7CommonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(body["launch"]).toMatchObject({
      contractAddress: mockLaunchpadAddress,
      configVersion: null,
      onChainState: {
        saleState: "LIVE",
        entitlementState: "NONE",
        liquidityState: "NOT_STARTED",
        operationalState: "ACTIVE",
        stateTupleDigest: mockStateTupleDigest,
        snapshotBlockNumber: mockBlockNumber.toString(),
        snapshotBlockHash: mockBlockHash,
        configVersion: mockConfigVersion,
        source: "chain",
        reasonCode: null,
      },
    });
    expect(body["configPending"]).toBeNull();
    expect(body["config"]).toEqual({
      status: "available",
      projectToken: mockProjectTokenAddress,
      usd1: mockUsd1Address,
      softCapUsd1: "20000000000000000000000",
      hardCapUsd1: "100000000000000000000000",
      walletProjectCapUsd1: "1000000000000000000000",
      minPurchaseUsd1: "10000000000000000000",
      protocolFeeBps: 300,
      liquidityBps: 5_000,
      tgeBps: 2_500,
      cliffSeconds: 0,
      vestingSeconds: 7_776_000,
      poolFeeTier: 2_500,
      lpLockSeconds: 31_536_000,
      configVersion: mockConfigVersion,
    });
    expect(body["rounds"]).toEqual([
      {
        status: "available",
        roundId,
        roundIndex: 1,
        startAt: "2026-09-21T14:13:20.000Z",
        endAt: "2026-09-23T14:13:20.000Z",
        priceUsd1PerToken: "10000000000000000",
        roundCapUsd1: "40000000000000000000000",
        walletRoundCapUsd1: "500000000000000000000",
        allowlistRoot: mockAllowlistRoot,
        raisedUsd1: "1234000000000000000000",
      },
      {
        status: "available",
        roundId: null,
        roundIndex: 2,
        startAt: "2026-09-23T14:13:20.000Z",
        endAt: "2026-09-26T14:13:20.000Z",
        priceUsd1PerToken: "10000000000000000",
        roundCapUsd1: "60000000000000000000000",
        walletRoundCapUsd1: "500000000000000000000",
        allowlistRoot: `0x${"00".repeat(32)}`,
        raisedUsd1: "0",
      },
    ]);
    // Every amount is a decimal string; no JSON number carries money.
    expect(response.body).not.toMatch(
      /"(?:[a-zA-Z]+Usd1|priceUsd1PerToken)":\d/,
    );
    // One snapshot: every eth_call is pinned to the same block.
    const blocks = chain.calls
      .filter((call) => call.method === "eth_call")
      .map((call) => call.params[1]);
    expect(blocks).toHaveLength(3);
    expect(new Set(blocks)).toEqual(
      new Set([`0x${mockBlockNumber.toString(16)}`]),
    );
    // Graduation, market, and holders stay unavailable in S83a.
    expect(body["holders"]).toEqual({
      status: "unavailable",
      reasonCode: "LAUNCH_CONTRACT_BASELINE_PENDING",
    });
    expect(response.body).not.toContain("launch-rpc.invalid");
  });

  it("fails closed with a named reason instead of publishing a doubtful chain fact", async () => {
    const cases: readonly {
      readonly name: string;
      readonly chain: Partial<MockLaunchpadChain>;
      readonly launch: LaunchRecord;
      readonly contract?: Partial<LaunchContractConfig>;
      readonly reasonCode: string;
    }[] = [
      {
        name: "unregistered sale",
        chain: {},
        launch: unregistered,
        reasonCode: "LAUNCH_SALE_NOT_REGISTERED",
      },
      {
        name: "another contract version",
        chain: {},
        launch: { ...registered, contractVersion: "0.9.0" },
        reasonCode: "LAUNCH_SALE_CONTRACT_MISMATCH",
      },
      {
        name: "no code at the address",
        chain: { code: "0x" },
        launch: registered,
        reasonCode: "LAUNCH_CONTRACT_CODE_MISSING",
      },
      {
        name: "unknown saleId",
        chain: {
          state: {
            saleState: 0,
            entitlementState: 0,
            liquidityState: 0,
            operationalState: 0,
            configVersion: `0x${"00".repeat(32)}`,
            stateTupleDigest: `0x${"00".repeat(32)}`,
          },
          saleConfigVersion: `0x${"00".repeat(32)}`,
        },
        launch: registered,
        reasonCode: "LAUNCH_SALE_NOT_FOUND",
      },
      {
        name: "expected configVersion differs",
        chain: {},
        launch: {
          ...registered,
          configVersionOnchain: `0x${"cc".repeat(32)}`,
        },
        reasonCode: "LAUNCH_CONFIG_VERSION_MISMATCH",
      },
      {
        name: "getState and getSaleConfig disagree",
        chain: { saleConfigVersion: `0x${"cc".repeat(32)}` },
        launch: registered,
        reasonCode: "LAUNCH_CONFIG_VERSION_MISMATCH",
      },
      {
        name: "another settlement token",
        chain: { usd1: "0x9999999999999999999999999999999999999999" },
        launch: registered,
        reasonCode: "LAUNCH_USD1_ADDRESS_MISMATCH",
      },
      {
        name: "endpoint failure",
        chain: { failCalls: true },
        launch: registered,
        reasonCode: "LAUNCH_CONTRACT_READ_FAILED",
      },
      {
        name: "reorg during the read",
        chain: { reorgHash: `0x${"98".repeat(32)}` },
        launch: registered,
        reasonCode: "LAUNCH_SNAPSHOT_REORGED",
      },
      {
        name: "unsupported ABI major",
        chain: {},
        launch: { ...registered, contractVersion: "2.0.0" },
        contract: { version: "2.0.0", versionMajor: 2 },
        reasonCode: "LAUNCH_CONTRACT_VERSION_UNSUPPORTED",
      },
    ];
    const offChain = JSON.parse(baseline("launch-detail-confirmed")) as {
      readonly rounds: unknown;
      readonly config: unknown;
    };
    for (const scenario of cases) {
      const chain = createMockLaunchpadChain(scenario.chain);
      const app = await createApp(
        { ...confirmed, launch: scenario.launch },
        { adapter: mockAdapter(chain, scenario.contract) },
      );
      const response = await app.inject({
        method: "GET",
        url: `/v2/launches/${launchId}`,
        headers: s7CommonHeaders(),
      });
      expect(response.statusCode, scenario.name).toBe(200);
      const body = response.json<{
        readonly launch: {
          readonly contractAddress: string | null;
          readonly onChainState: Record<string, unknown>;
        };
        readonly rounds: unknown;
        readonly config: unknown;
      }>();
      expect(body.launch.onChainState, scenario.name).toEqual({
        saleState: "unavailable",
        entitlementState: "unavailable",
        liquidityState: "unavailable",
        operationalState: "unavailable",
        stateTupleDigest: null,
        snapshotBlockNumber: null,
        snapshotBlockHash: null,
        source: "unavailable",
        reasonCode: scenario.reasonCode,
      });
      // The off-chain slots are published exactly as before.
      expect(body.rounds, scenario.name).toEqual(offChain.rounds);
      expect(body.config, scenario.name).toEqual(offChain.config);
    }
  });

  it("publishes the verified contract address in lists without reading the chain per launch", async () => {
    const chain = createMockLaunchpadChain();
    const adapter = mockAdapter(chain);
    await adapter.verifyAtStartup();
    const callsBefore = chain.calls.length;
    const app = await createApp(
      { ...pending, launch: registered },
      { adapter },
    );
    const response = await app.inject({
      method: "GET",
      url: "/v2/launch/overview",
      headers: s7CommonHeaders(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      segments: {
        upcoming: [
          {
            contractAddress: mockLaunchpadAddress,
            onChainState: {
              source: "unavailable",
              reasonCode: "LAUNCH_ONCHAIN_STATE_NOT_INDEXED",
            },
          },
        ],
      },
    });
    expect(chain.calls.length).toBe(callsBefore);
  });

  it("still answers the Intent route with the unchanged 503 when the contract is available", async () => {
    const chain = createMockLaunchpadChain();
    const app = await createApp(
      { ...pending, launch: registered },
      { adapter: mockAdapter(chain) },
    );
    const response = await app.inject({
      method: "POST",
      url: `/v2/launch/${launchId}/intents`,
      headers: s7CommandHeaders(),
      payload: {
        walletId: "d64786bb-408d-415d-8a69-6277d56c921b",
        roundId,
        payAmount: "100",
      },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
  });

  it("builds the adapter from configuration and stays BASELINE_PENDING with the keys blank", async () => {
    const app = await createApp(
      { ...confirmed, launch: registered },
      { env: { LAUNCH_CHAIN_ID: "97" } },
    );
    const response = await app.inject({
      method: "GET",
      url: `/v2/launches/${launchId}`,
      headers: s7CommonHeaders(),
    });
    expect(response.body).toBe(baseline("launch-detail-confirmed"));
  });

  describe("launch capability evidence (Decision 0083)", () => {
    async function launchCapability(
      app: FastifyInstance,
    ): Promise<Record<string, unknown>> {
      const response = await app.inject({
        method: "GET",
        url: "/v2/meta/capabilities",
      });
      expect(response.statusCode).toBe(200);
      const capability = response
        .json<{
          readonly capabilities: readonly Record<string, unknown>[];
        }>()
        .capabilities.find((entry) => entry["capabilityId"] === "launch");
      expect(capability).toBeDefined();
      return capability as Record<string, unknown>;
    }

    it("stays BASELINE_PENDING with the pre-0083 bytes while the four keys are blank", async () => {
      for (const env of [{}, { LAUNCH_CHAIN_ID: "97" }]) {
        const app = await createApp(
          { ...confirmed, launch: registered },
          {
            env,
          },
        );
        const capability = await launchCapability(app);
        expect(capability).toEqual({
          capabilityId: "launch",
          availability: "available",
          reasonCode: null,
          evidence: {
            status: "pending",
            reasonCode: "LAUNCH_CONTRACT_BASELINE_PENDING",
            ...(env.LAUNCH_CHAIN_ID === "97"
              ? { launchChainId: "eip155:97" }
              : {}),
          },
        });
        expect(
          Object.keys(capability["evidence"] as Record<string, unknown>),
        ).toEqual(
          env.LAUNCH_CHAIN_ID === "97"
            ? ["status", "reasonCode", "launchChainId"]
            : ["status", "reasonCode"],
        );
      }
    });

    it("stays pending with the adapter's reason when the code is missing or the ABI major is unsupported", async () => {
      const cases = [
        {
          chain: { code: "0x" as const },
          contract: {},
          reasonCode: "LAUNCH_CONTRACT_CODE_MISSING",
        },
        {
          chain: {},
          contract: { version: "2.0.0", versionMajor: 2 },
          reasonCode: "LAUNCH_CONTRACT_VERSION_UNSUPPORTED",
        },
      ];
      for (const scenario of cases) {
        const adapter = mockAdapter(
          createMockLaunchpadChain(scenario.chain),
          scenario.contract,
        );
        const app = await createApp(
          { ...confirmed, launch: registered },
          { env: { LAUNCH_CHAIN_ID: "97" }, adapter },
        );
        await adapter.availability();
        expect((await launchCapability(app))["evidence"]).toEqual({
          status: "pending",
          reasonCode: scenario.reasonCode,
          launchChainId: "eip155:97",
        });
      }
    });

    it("is confirmed with the contract version once the adapter observed the code", async () => {
      const adapter = mockAdapter(createMockLaunchpadChain());
      const app = await createApp(
        { ...confirmed, launch: registered },
        { env: { LAUNCH_CHAIN_ID: "97" }, adapter },
      );
      await adapter.availability();
      const capability = await launchCapability(app);
      expect(capability).toEqual({
        capabilityId: "launch",
        availability: "available",
        reasonCode: null,
        evidence: {
          status: "confirmed",
          reasonCode: "LAUNCH_CONTRACT_CONFIRMED",
          launchChainId: "eip155:97",
          launchContractVersion: "1.0.0",
        },
      });
      // Mining and referral keep their own pending evidence.
      const response = await app.inject({
        method: "GET",
        url: "/v2/meta/capabilities",
      });
      const others = response
        .json<{
          readonly capabilities: readonly {
            readonly capabilityId: string;
            readonly evidence: Record<string, unknown>;
          }[];
        }>()
        .capabilities.filter(
          (entry) =>
            entry.capabilityId === "mining" ||
            entry.capabilityId === "referral",
        );
      expect(others).toHaveLength(2);
      for (const entry of others) {
        expect(entry.evidence["status"]).toBe("pending");
        expect(Object.keys(entry.evidence)).toEqual(["status", "reasonCode"]);
      }
    });

    it("stays VERIFICATION_PENDING before the startup probe settled, without probing", () => {
      let probes = 0;
      const adapter = createLaunchContractAdapter({
        contract,
        chain: {
          chainId: "eip155:97",
          chainReference: 97,
          rpcUrls: ["https://launch-rpc.invalid/"],
        },
        verifyChain: () => {
          probes += 1;
          return Promise.resolve("verified");
        },
        transportFactory: mockLaunchpadTransportFactory(
          createMockLaunchpadChain(),
        ),
      });
      expect(launchContractEvidenceFrom(adapter)()).toEqual({
        status: "pending",
        reasonCode: "LAUNCH_CONTRACT_VERIFICATION_PENDING",
      });
      expect(probes).toBe(0);
    });
  });
});
