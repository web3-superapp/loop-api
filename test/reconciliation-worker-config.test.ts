import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  loadReconciliationWorkerConfig,
} from "../src/config.js";

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL:
      "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
  };
}

describe("loadReconciliationWorkerConfig", () => {
  it("keeps authoritative provider reads disabled by default", () => {
    const environment = validEnvironment();
    environment["PRIVY_APP_ID"] = "partial-provider-configuration";
    environment["STREAM_API_KEY"] = "not-for-this-lane";
    environment["STREAM_API_SECRET"] = "not-for-this-process";
    environment["HYPERLIQUID_PRIVATE_READS_ENABLED"] = "malformed";

    const config = loadReconciliationWorkerConfig(environment);

    expect(config).toEqual({
      nodeEnv: "test",
      logLevel: "silent",
      databaseUrl:
        "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
      databasePoolMax: 10,
      databaseConnectionTimeoutMs: 3_000,
      databaseStatementTimeoutMs: 5_000,
      bscChain: null,
      bscIndexer: null,
      launchChain: {
        chainId: "eip155:56",
        chainReference: 56,
        rpcUrls: [],
        confirmations: 15,
        reorgDepthBlocks: 64,
        logAddressChunkSize: 8,
        sharedWithPrimary: true,
      },
      launchContract: null,
      launchIndexerEnabled: false,
      meme: {
        contract: null,
        unconfiguredReason: "MEME_CONTRACT_NOT_CONFIGURED",
        saltPoolTarget: 50,
        vanitySuffix: "6666",
        createDailyLimit: 3,
        classicCreateEnabled: false,
      },
      memeIndexerEnabled: false,
      memeGraduationExecutor: null,
      hooksLaunchExecutor: null,
      launch2Indexer: null,
      launch2SnapshotPublisher: null,
      launch2BuybackKeeper: null,
      launch2DynamicPoke: null,
      chainGuard: null,
      chainGuardAlerts: null,
      // S169: the faucet pending sweep is off while the faucet is.
      testnetFaucetSweep: null,
      // Decision 0143: the square ingest lane is on by default.
      squareFeedIngest: { intervalMs: 60_000, usd1Address: null },
      // Decision 0145: the hourly net worth snapshot lane is on by default.
      walletNetWorthSnapshot: { intervalMs: 3_600_000, batchSize: 200 },
      fiatFxRate: {
        providerUrl:
          "https://api.frankfurter.dev/v2/providers/ecb/rate/USD/CNY",
        source: "ecb",
        base: "USD",
        quote: "CNY",
        refreshMs: 3_600_000,
      },
      hyperliquidReconciliationReads: null,
      hyperliquidSpotReconciliationReads: null,
      spotAgentLifecycleMaintenanceEnabled: true,
      issuanceRateRecordCleanupEnabled: true,
      communityChannelSync: null,
      market: {
        dexscreener: {
          enabled: true,
          budgetApiPerMinute: 120,
          budgetWorkerPerMinute: 120,
        },
        geckoterminal: {
          enabled: false,
          rateLimitPerMinute: 30,
          budgetWorkerPerMinute: 10,
        },
        goplus: null,
        priceTtlSeconds: 30,
        securityTtlSeconds: 600,
        candlesTtlSeconds: 60,
        sparklineTtlSeconds: 300,
        staleGraceSeconds: 900,
        unlistedPriceTtlSeconds: 60,
        unlistedMetadataTtlSeconds: 3_600,
      },
      alertEvaluator: null,
      sparklineWarm: { intervalMs: 4_000 },
      // Decision 0094: default on; the Stream pair is the lane's own.
      voiceRoomReaper: {
        intervalMs: 60_000,
        idleEndMinutes: 10,
        maxLiveHours: 12,
        stream: {
          apiKey: "not-for-this-lane",
          apiSecret: "not-for-this-process",
        },
      },
      // Decision 0097: default on; the Stream pair is the lane's own.
      communityMemberBuyFeed: {
        intervalMs: 15_000,
        usd1Address: null,
        stream: {
          apiKey: "not-for-this-lane",
          apiSecret: "not-for-this-process",
        },
      },
      walletIntentReconcile: null,
      miningSnapshotEnabled: false,
      push: null,
      miningMockHoldingsEnabled: false,
      miningSettlement: {
        enabled: false,
        pollIntervalMs: 60_000,
        catchupHours: 48,
        claimContractAddress: null,
        usdtAddress: null,
        claimConfirmations: 3,
        indexerGraceSeconds: 120,
      },
      // Decision 0095: real identity in community chat by default.
      communityChatRealIdentity: true,
      publicBaseUrl: "http://127.0.0.1:3000/",
      serviceName: "loop-reconciliation-worker",
      serviceVersion: "0.1.0",
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  describe("community_member_buy_feed lane (Decision 0097)", () => {
    it("is on by default at 15 s with no Stream pair and no USD1", () => {
      expect(loadReconciliationWorkerConfig(validEnvironment())).toMatchObject({
        communityMemberBuyFeed: {
          intervalMs: 15_000,
          usd1Address: null,
          stream: null,
        },
      });
    });

    it("reads the interval and a verified USD1, and can be switched off", () => {
      const environment = validEnvironment();
      environment["COMMUNITY_MEMBER_BUY_FEED_INTERVAL_MS"] = "600000";
      environment["BSC_USD1_TOKEN_ADDRESS"] =
        "0x8D0D000Ee44948FC98c9B98A4FA4921476f08B0d";
      expect(
        loadReconciliationWorkerConfig(environment).communityMemberBuyFeed,
      ).toMatchObject({ intervalMs: 600_000, usd1Address: null });
      environment["BSC_USD1_VERIFIED"] = "true";
      expect(
        loadReconciliationWorkerConfig(environment).communityMemberBuyFeed,
      ).toMatchObject({
        usd1Address: "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d",
      });
      environment["COMMUNITY_MEMBER_BUY_FEED_ENABLED"] = "false";
      expect(
        loadReconciliationWorkerConfig(environment).communityMemberBuyFeed,
      ).toBeNull();
    });

    it.each([
      ["COMMUNITY_MEMBER_BUY_FEED_INTERVAL_MS", "4999"],
      ["COMMUNITY_MEMBER_BUY_FEED_INTERVAL_MS", "600001"],
      ["COMMUNITY_MEMBER_BUY_FEED_ENABLED", "yes"],
      ["BSC_USD1_TOKEN_ADDRESS", "0x123"],
    ])("refuses %s=%s", (key, value) => {
      const environment = validEnvironment();
      environment[key] = value;
      expect(() => loadReconciliationWorkerConfig(environment)).toThrow(
        ConfigurationError,
      );
    });
  });

  describe("voice_room_reaper lane (Decision 0094)", () => {
    it("is on by default with 60 s, 10 min and 12 h and no Stream pair", () => {
      expect(loadReconciliationWorkerConfig(validEnvironment())).toMatchObject({
        voiceRoomReaper: {
          intervalMs: 60_000,
          idleEndMinutes: 10,
          maxLiveHours: 12,
          stream: null,
        },
      });
    });

    it("reads the thresholds and can be switched off", () => {
      const environment = validEnvironment();
      environment["VOICE_ROOM_REAPER_INTERVAL_MS"] = "30000";
      environment["VOICE_ROOM_IDLE_END_MINUTES"] = "5";
      environment["VOICE_ROOM_MAX_LIVE_HOURS"] = "24";
      expect(loadReconciliationWorkerConfig(environment)).toMatchObject({
        voiceRoomReaper: {
          intervalMs: 30_000,
          idleEndMinutes: 5,
          maxLiveHours: 24,
        },
      });
      environment["VOICE_ROOM_REAPER_ENABLED"] = "false";
      expect(
        loadReconciliationWorkerConfig(environment).voiceRoomReaper,
      ).toBeNull();
    });

    it.each([
      ["VOICE_ROOM_IDLE_END_MINUTES", "0"],
      ["VOICE_ROOM_IDLE_END_MINUTES", "1441"],
      ["VOICE_ROOM_IDLE_END_MINUTES", "2.5"],
      ["VOICE_ROOM_MAX_LIVE_HOURS", "0"],
      ["VOICE_ROOM_MAX_LIVE_HOURS", "169"],
      ["VOICE_ROOM_REAPER_INTERVAL_MS", "999"],
      ["VOICE_ROOM_REAPER_ENABLED", "yes"],
    ])("refuses %s=%s", (key, value) => {
      const environment = validEnvironment();
      environment[key] = value;
      expect(() => loadReconciliationWorkerConfig(environment)).toThrow(
        ConfigurationError,
      );
    });
  });

  it("loads the explicit Testnet reconciliation read capability", () => {
    const environment = validEnvironment();
    environment["HYPERLIQUID_RECONCILIATION_READS_ENABLED"] = "true";
    environment["HYPERLIQUID_INFO_QUOTA_HMAC_SECRET"] = "q".repeat(32);
    environment["HYPERLIQUID_INFO_WEIGHT_LIMIT_PER_MINUTE"] = "720";

    expect(loadReconciliationWorkerConfig(environment)).toMatchObject({
      hyperliquidReconciliationReads: {
        quotaHmacSecret: "q".repeat(32),
        policyVersion: "hyperliquid_info_v1",
        windowDurationSeconds: 60,
        weightCapacity: 720,
      },
      hyperliquidSpotReconciliationReads: null,
    });
  });

  it("keeps the independent Perp capability off when only Spot reads are enabled", () => {
    const environment = validEnvironment();
    environment["HYPERLIQUID_SPOT_RECONCILIATION_READS_ENABLED"] = "true";
    environment["HYPERLIQUID_INFO_QUOTA_HMAC_SECRET"] = "s".repeat(32);
    environment["HYPERLIQUID_INFO_WEIGHT_LIMIT_PER_MINUTE"] = "840";

    expect(loadReconciliationWorkerConfig(environment)).toMatchObject({
      hyperliquidReconciliationReads: null,
      hyperliquidSpotReconciliationReads: {
        quotaHmacSecret: "s".repeat(32),
        policyVersion: "hyperliquid_info_v1",
        windowDurationSeconds: 60,
        weightCapacity: 840,
      },
    });
  });

  it("binds enabled Perp and Spot readers to the same quota capability", () => {
    const environment = validEnvironment();
    environment["HYPERLIQUID_RECONCILIATION_READS_ENABLED"] = "true";
    environment["HYPERLIQUID_SPOT_RECONCILIATION_READS_ENABLED"] = "true";
    environment["HYPERLIQUID_INFO_QUOTA_HMAC_SECRET"] = "b".repeat(32);
    environment["HYPERLIQUID_INFO_WEIGHT_LIMIT_PER_MINUTE"] = "900";

    const config = loadReconciliationWorkerConfig(environment);

    expect(config.hyperliquidReconciliationReads).not.toBeNull();
    expect(config.hyperliquidSpotReconciliationReads).toBe(
      config.hyperliquidReconciliationReads,
    );
    expect(config.hyperliquidSpotReconciliationReads).toEqual({
      quotaHmacSecret: "b".repeat(32),
      policyVersion: "hyperliquid_info_v1",
      windowDurationSeconds: 60,
      weightCapacity: 900,
    });
  });

  it("fails closed when reconciliation reads lack a strong quota secret", () => {
    const environment = validEnvironment();
    environment["HYPERLIQUID_RECONCILIATION_READS_ENABLED"] = "true";

    expect(() => loadReconciliationWorkerConfig(environment)).toThrowError(
      /Hyperliquid reconciliation reads require HYPERLIQUID_INFO_QUOTA_HMAC_SECRET/,
    );

    environment["HYPERLIQUID_INFO_QUOTA_HMAC_SECRET"] = "too-short";
    expect(() => loadReconciliationWorkerConfig(environment)).toThrowError(
      /HYPERLIQUID_INFO_QUOTA_HMAC_SECRET/,
    );
  });

  it("fails closed when Spot reconciliation reads lack a strong quota secret", () => {
    const environment = validEnvironment();
    environment["HYPERLIQUID_SPOT_RECONCILIATION_READS_ENABLED"] = "true";

    expect(() => loadReconciliationWorkerConfig(environment)).toThrowError(
      /Hyperliquid Spot reconciliation reads require HYPERLIQUID_INFO_QUOTA_HMAC_SECRET/,
    );

    environment["HYPERLIQUID_INFO_QUOTA_HMAC_SECRET"] = "too-short";
    expect(() => loadReconciliationWorkerConfig(environment)).toThrowError(
      /HYPERLIQUID_INFO_QUOTA_HMAC_SECRET/,
    );
  });

  it("rejects a malformed reconciliation switch independently of the API flag", () => {
    const environment = validEnvironment();
    environment["HYPERLIQUID_RECONCILIATION_READS_ENABLED"] = "malformed";

    expect(() => loadReconciliationWorkerConfig(environment)).toThrowError(
      ConfigurationError,
    );
  });

  it("rejects a malformed Spot reconciliation switch independently of the Perp switch", () => {
    const environment = validEnvironment();
    environment["HYPERLIQUID_RECONCILIATION_READS_ENABLED"] = "false";
    environment["HYPERLIQUID_SPOT_RECONCILIATION_READS_ENABLED"] = "malformed";

    expect(() => loadReconciliationWorkerConfig(environment)).toThrowError(
      ConfigurationError,
    );
  });

  it("allows the database-only Agent lifecycle maintenance to be disabled", () => {
    const environment = validEnvironment();
    environment["SPOT_AGENT_LIFECYCLE_MAINTENANCE_ENABLED"] = "false";

    expect(loadReconciliationWorkerConfig(environment)).toMatchObject({
      spotAgentLifecycleMaintenanceEnabled: false,
    });

    environment["SPOT_AGENT_LIFECYCLE_MAINTENANCE_ENABLED"] = "malformed";
    expect(() => loadReconciliationWorkerConfig(environment)).toThrowError(
      ConfigurationError,
    );
  });

  it("allows issuance quota cleanup to be paused without changing retention", () => {
    const environment = validEnvironment();
    environment["ISSUANCE_RATE_RECORD_CLEANUP_ENABLED"] = "false";

    expect(loadReconciliationWorkerConfig(environment)).toMatchObject({
      issuanceRateRecordCleanupEnabled: false,
    });

    environment["ISSUANCE_RATE_RECORD_CLEANUP_ENABLED"] = "malformed";
    expect(() => loadReconciliationWorkerConfig(environment)).toThrowError(
      ConfigurationError,
    );
  });

  it("validates worker database pool and timeout overrides", () => {
    const environment = validEnvironment();
    environment["DATABASE_POOL_MAX"] = "4";
    environment["DATABASE_CONNECTION_TIMEOUT_MS"] = "750";
    environment["DATABASE_STATEMENT_TIMEOUT_MS"] = "1200";

    expect(loadReconciliationWorkerConfig(environment)).toMatchObject({
      databasePoolMax: 4,
      databaseConnectionTimeoutMs: 750,
      databaseStatementTimeoutMs: 1_200,
    });
  });

  it("fails closed without leaking a rejected database password", () => {
    const environment = validEnvironment();
    environment["DATABASE_URL"] =
      "https://loop_api:do-not-log-me@example.com/private";

    expect(() => loadReconciliationWorkerConfig(environment)).toThrowError(
      /DATABASE_URL: protocol must be postgres or postgresql/,
    );

    try {
      loadReconciliationWorkerConfig(environment);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(String(error)).not.toContain("do-not-log-me");
    }
  });

  it("parses the Launch contract keys with the API rules (Decision 0076)", () => {
    const complete = validEnvironment();
    complete["LAUNCH_CONTRACT_ADDRESS"] =
      "0x1111111111111111111111111111111111111111";
    complete["LAUNCH_CONTRACT_VERSION"] = "1.0.0";
    complete["LAUNCH_CONTRACT_START_BLOCK"] = "44000000";
    complete["LAUNCH_USD1_ADDRESS"] =
      "0x2222222222222222222222222222222222222222";
    expect(loadReconciliationWorkerConfig(complete).launchContract).toEqual({
      address: "0x1111111111111111111111111111111111111111",
      version: "1.0.0",
      versionMajor: 1,
      startBlock: 44_000_000n,
      usd1Address: "0x2222222222222222222222222222222222222222",
    });
    const partial = validEnvironment();
    partial["LAUNCH_CONTRACT_ADDRESS"] =
      "0x1111111111111111111111111111111111111111";
    expect(() => loadReconciliationWorkerConfig(partial)).toThrow(
      /LAUNCH_USD1_ADDRESS: is required/,
    );
  });

  it("hands the worker BSC client the configured log address chunk (Decision 0078)", () => {
    const environment = validEnvironment();
    environment["BSC_RPC_URLS"] = "https://rpc-a.example/";
    environment["BSC_LOG_ADDRESS_CHUNK_SIZE"] = "4";
    const config = loadReconciliationWorkerConfig(environment);
    expect(config.bscChain?.logAddressChunkSize).toBe(4);
    expect(config.launchChain.logAddressChunkSize).toBe(4);
    environment["BSC_LOG_ADDRESS_CHUNK_SIZE"] = "101";
    expect(() => loadReconciliationWorkerConfig(environment)).toThrow(
      /BSC_LOG_ADDRESS_CHUNK_SIZE/,
    );
  });

  it("parses the launch chain slot with the API rules so one environment file behaves identically (Decision 0038)", () => {
    const testnet = validEnvironment();
    testnet["LAUNCH_CHAIN_ID"] = "97";
    testnet["LAUNCH_BSC_RPC_URLS"] = "https://bsc-testnet-rpc.example/";
    expect(loadReconciliationWorkerConfig(testnet).launchChain).toEqual({
      chainId: "eip155:97",
      chainReference: 97,
      rpcUrls: ["https://bsc-testnet-rpc.example/"],
      confirmations: 5,
      reorgDepthBlocks: 15,
      logAddressChunkSize: 8,
      sharedWithPrimary: false,
    });
    // The indexer lane keeps driving only the primary chain: it needs
    // BSC_RPC_URLS regardless of the launch slot.
    testnet["BSC_INDEXER_ENABLED"] = "true";
    expect(() => loadReconciliationWorkerConfig(testnet)).toThrow(
      /BSC_INDEXER_ENABLED: The BSC indexer lane requires BSC_RPC_URLS/,
    );

    const shared = validEnvironment();
    shared["LAUNCH_BSC_RPC_URLS"] = "https://bsc-testnet-rpc.example/";
    expect(() => loadReconciliationWorkerConfig(shared)).toThrow(
      ConfigurationError,
    );
  });

  it("keeps the Development mock holdings off by default and refuses them in production (Decision 0061)", () => {
    const environment = validEnvironment();
    environment["MINING_MOCK_HOLDINGS_ENABLED"] = "true";
    environment["NODE_ENV"] = "development";
    expect(
      loadReconciliationWorkerConfig(environment).miningMockHoldingsEnabled,
    ).toBe(true);

    const production = validEnvironment();
    production["NODE_ENV"] = "production";
    production["MINING_MOCK_HOLDINGS_ENABLED"] = "true";
    expect(() => loadReconciliationWorkerConfig(production)).toThrow();
  });
});
