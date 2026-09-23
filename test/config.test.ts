import { describe, expect, it } from "vitest";

import { requestAbortDeadlineMilliseconds } from "../src/core/http/request-abort-signal.js";

import {
  ConfigurationError,
  loadConfig,
  parseLaunchChainIdEnvironment,
} from "../src/config.js";

function validEnvironment(): NodeJS.ProcessEnv {
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
  };
}

describe("loadConfig", () => {
  it("parses strict booleans and numeric defaults", () => {
    const config = loadConfig(validEnvironment());

    expect(config.apiDocsEnabled).toBe(false);
    expect(config.trustProxy).toBe(false);
    expect(config.databasePoolMax).toBe(10);
    expect(config.privy).toBeNull();
    expect(config.stream).toBeNull();
    expect(config.streamTokenQuota).toBeNull();
    expect(config.social).toBeNull();
    expect(config.perpReadCursor).toBeNull();
    expect(config.hyperliquidPrivateReads).toBeNull();
    expect(config.v2SessionEnabled).toBe(true);
    expect(config.serviceName).toBe("loop-api");
  });

  it("enables Privy verification only when both credentials are present", () => {
    const environment = validEnvironment();
    environment["PRIVY_APP_ID"] = "app_test";
    environment["PRIVY_APP_SECRET"] = "secret_test";

    const config = loadConfig(environment);

    expect(config.privy).toEqual({
      appId: "app_test",
      appSecret: "secret_test",
    });
    expect(Object.isFrozen(config.privy)).toBe(true);
  });

  it("treats blank Privy placeholders as unconfigured", () => {
    const environment = validEnvironment();
    environment["PRIVY_APP_ID"] = "";
    environment["PRIVY_APP_SECRET"] = "   ";

    expect(loadConfig(environment).privy).toBeNull();
  });

  it("parses an all-or-nothing Stream credential pair", () => {
    const environment = validEnvironment();
    environment["STREAM_API_KEY"] = "stream_key";
    environment["STREAM_API_SECRET"] = "stream_secret";

    const config = loadConfig(environment);

    expect(config.stream).toEqual({
      apiKey: "stream_key",
      apiSecret: "stream_secret",
    });
    expect(Object.isFrozen(config.stream)).toBe(true);
  });

  it("treats blank Stream placeholders as unconfigured", () => {
    const environment = validEnvironment();
    environment["STREAM_API_KEY"] = "";
    environment["STREAM_API_SECRET"] = "   ";

    expect(loadConfig(environment).stream).toBeNull();
  });

  it.each([
    ["STREAM_API_KEY", "stream_key"],
    ["STREAM_API_SECRET", "do-not-log-stream-secret"],
  ] as const)(
    "rejects a partial Stream credential pair without leaking %s",
    (key, value) => {
      const environment = validEnvironment();
      environment[key] = value;

      expect(() => loadConfig(environment)).toThrowError(
        /STREAM_API_KEY and STREAM_API_SECRET must be configured together/,
      );

      try {
        loadConfig(environment);
      } catch (error) {
        expect(String(error)).not.toContain(value);
      }
    },
  );

  it("enables a versioned Stream token quota only with a strong HMAC secret", () => {
    const environment = validEnvironment();
    environment["STREAM_TOKEN_QUOTA_HMAC_SECRET"] = "h".repeat(32);
    environment["STREAM_TOKEN_USER_LIMIT_PER_MINUTE"] = "7";
    environment["STREAM_TOKEN_IP_LIMIT_PER_MINUTE"] = "40";

    const config = loadConfig(environment);

    expect(config.streamTokenQuota).toEqual({
      hmacSecret: "h".repeat(32),
      policyVersion: "stream_token_v1",
      windowDurationSeconds: 60,
      userCapacity: 7,
      ipCapacity: 40,
    });
    expect(Object.isFrozen(config.streamTokenQuota)).toBe(true);
  });

  it("parses the canary guards and keeps writes closed without the switch (Decision 0065)", () => {
    expect(loadConfig(validEnvironment()).bscWrites).toBeNull();

    const enabled = validEnvironment();
    enabled["BSC_WRITES_ENABLED"] = "true";
    enabled["BSC_RPC_URLS"] = "https://bsc.example.test";
    enabled["BSC_WRITE_CANARY_ASSETS"] =
      "eip155:56:native,eip155:56:0x55d398326f99059ff775485246999027b3197955";
    enabled["BSC_WRITE_CANARY_MAX_USD"] = "5";
    enabled["BSC_WRITE_CANARY_DAILY_MAX_USD"] = "25";
    enabled["BSC_WRITE_CANARY_RECIPIENT_ALLOWLIST"] =
      "0xC8932B012DC70670D57278961E66431A5BDAF611";
    expect(loadConfig(enabled).bscWrites).toEqual({
      configVersion: "bscWriteCanaryV1",
      canaryAssetIds: [
        "eip155:56:native",
        "eip155:56:0x55d398326f99059ff775485246999027b3197955",
      ],
      canaryMaxUsd: "5",
      canaryDailyMaxUsd: "25",
      canaryCounterpartyAddresses: [
        "0xc8932b012dc70670d57278961e66431a5bdaf611",
      ],
      swapFeeBps: null,
    });

    const unrestricted = { ...enabled };
    delete unrestricted["BSC_WRITE_CANARY_RECIPIENT_ALLOWLIST"];
    delete unrestricted["BSC_WRITE_CANARY_DAILY_MAX_USD"];
    expect(loadConfig(unrestricted).bscWrites).toMatchObject({
      canaryDailyMaxUsd: null,
      canaryCounterpartyAddresses: [],
    });

    const badAddress = { ...enabled };
    badAddress["BSC_WRITE_CANARY_RECIPIENT_ALLOWLIST"] = "0xnot-an-address";
    expect(() => loadConfig(badAddress)).toThrow(ConfigurationError);

    const badDaily = { ...enabled };
    badDaily["BSC_WRITE_CANARY_DAILY_MAX_USD"] = "0";
    expect(() => loadConfig(badDaily)).toThrow(ConfigurationError);
  });

  it("keeps the Development mock holdings off by default and refuses them in production (Decision 0061)", () => {
    expect(loadConfig(validEnvironment()).miningMockHoldingsEnabled).toBe(
      false,
    );

    const development = validEnvironment();
    development["NODE_ENV"] = "development";
    development["MINING_MOCK_HOLDINGS_ENABLED"] = "true";
    expect(loadConfig(development).miningMockHoldingsEnabled).toBe(true);

    const production = validEnvironment();
    production["NODE_ENV"] = "production";
    production["PUBLIC_BASE_URL"] = "https://api.example.test";
    production["MINING_MOCK_HOLDINGS_ENABLED"] = "true";
    expect(() => loadConfig(production)).toThrow(ConfigurationError);
  });

  it("rejects a weak Stream token quota secret without echoing it", () => {
    const environment = validEnvironment();
    environment["STREAM_TOKEN_QUOTA_HMAC_SECRET"] = "weak-secret";

    expect(() => loadConfig(environment)).toThrow(ConfigurationError);

    try {
      loadConfig(environment);
    } catch (error) {
      expect(String(error)).not.toContain("weak-secret");
    }
  });

  it("enables social cursors and mutation quotas only as a strong pair", () => {
    const environment = validEnvironment();
    environment["SOCIAL_CURSOR_HMAC_SECRET"] = "c".repeat(32);
    environment["SOCIAL_QUOTA_HMAC_SECRET"] = "q".repeat(32);

    const config = loadConfig(environment);

    expect(config.social).toEqual({
      cursorHmacSecret: "c".repeat(32),
      quotaHmacSecret: "q".repeat(32),
      cursorTtlSeconds: 600,
    });
    expect(Object.isFrozen(config.social)).toBe(true);
  });

  it.each([
    ["SOCIAL_CURSOR_HMAC_SECRET", "c".repeat(32)],
    ["SOCIAL_QUOTA_HMAC_SECRET", "q".repeat(32)],
  ] as const)(
    "rejects a partial social secret pair without leaking %s",
    (key, value) => {
      const environment = validEnvironment();
      environment[key] = value;

      expect(() => loadConfig(environment)).toThrowError(
        /SOCIAL_CURSOR_HMAC_SECRET and SOCIAL_QUOTA_HMAC_SECRET must be configured together/,
      );
      try {
        loadConfig(environment);
      } catch (error) {
        expect(String(error)).not.toContain(value);
      }
    },
  );

  it("rejects weak social secrets without echoing them", () => {
    const environment = validEnvironment();
    environment["SOCIAL_CURSOR_HMAC_SECRET"] = "weak-cursor";
    environment["SOCIAL_QUOTA_HMAC_SECRET"] = "weak-quota";

    expect(() => loadConfig(environment)).toThrow(ConfigurationError);
    try {
      loadConfig(environment);
    } catch (error) {
      expect(String(error)).not.toContain("weak-cursor");
      expect(String(error)).not.toContain("weak-quota");
    }
  });

  it("enables owner-bound Perp read cursors only with a strong HMAC secret", () => {
    const environment = validEnvironment();
    environment["PERP_READ_CURSOR_HMAC_SECRET"] = "p".repeat(32);

    const config = loadConfig(environment);

    expect(config.perpReadCursor).toEqual({
      hmacSecret: "p".repeat(32),
      ttlSeconds: 600,
    });
    expect(Object.isFrozen(config.perpReadCursor)).toBe(true);
  });

  it("rejects a weak Perp read cursor secret without echoing it", () => {
    const environment = validEnvironment();
    environment["PERP_READ_CURSOR_HMAC_SECRET"] = "weak-cursor-secret";

    expect(() => loadConfig(environment)).toThrow(ConfigurationError);

    try {
      loadConfig(environment);
    } catch (error) {
      expect(String(error)).not.toContain("weak-cursor-secret");
    }
  });

  it("enables Hyperliquid private reads only with every server capability", () => {
    const environment = validEnvironment();
    environment["PRIVY_APP_ID"] = "app_test";
    environment["PRIVY_APP_SECRET"] = "secret_test";
    environment["PERP_READ_CURSOR_HMAC_SECRET"] = "p".repeat(32);
    environment["HYPERLIQUID_PRIVATE_READS_ENABLED"] = "true";
    environment["HYPERLIQUID_INFO_QUOTA_HMAC_SECRET"] = "q".repeat(32);
    environment["HYPERLIQUID_INFO_WEIGHT_LIMIT_PER_MINUTE"] = "900";

    const config = loadConfig(environment);

    expect(config.hyperliquidPrivateReads).toEqual({
      quotaHmacSecret: "q".repeat(32),
      policyVersion: "hyperliquid_info_v1",
      windowDurationSeconds: 60,
      weightCapacity: 900,
    });
    expect(Object.isFrozen(config.hyperliquidPrivateReads)).toBe(true);
  });

  it.each([
    "PRIVY_APP_ID",
    "PERP_READ_CURSOR_HMAC_SECRET",
    "HYPERLIQUID_INFO_QUOTA_HMAC_SECRET",
  ] as const)("rejects enabled Hyperliquid reads without %s", (missingKey) => {
    const environment = validEnvironment();
    environment["PRIVY_APP_ID"] = "app_test";
    environment["PRIVY_APP_SECRET"] = "secret_test";
    environment["PERP_READ_CURSOR_HMAC_SECRET"] = "p".repeat(32);
    environment["HYPERLIQUID_PRIVATE_READS_ENABLED"] = "true";
    environment["HYPERLIQUID_INFO_QUOTA_HMAC_SECRET"] = "q".repeat(32);
    delete environment[missingKey];
    if (missingKey === "PRIVY_APP_ID") {
      delete environment["PRIVY_APP_SECRET"];
    }

    expect(() => loadConfig(environment)).toThrow(ConfigurationError);
  });

  it("rejects a Hyperliquid weight limit above the provider ceiling", () => {
    const environment = validEnvironment();
    environment["HYPERLIQUID_INFO_WEIGHT_LIMIT_PER_MINUTE"] = "1201";

    expect(() => loadConfig(environment)).toThrow(ConfigurationError);
  });

  it.each([
    ["PRIVY_APP_ID", "app_test"],
    ["PRIVY_APP_SECRET", "do-not-log-this-secret"],
  ] as const)(
    "rejects a partial Privy credential pair without leaking %s",
    (key, value) => {
      const environment = validEnvironment();
      environment[key] = value;

      expect(() => loadConfig(environment)).toThrowError(
        /PRIVY_APP_ID and PRIVY_APP_SECRET must be configured together/,
      );

      try {
        loadConfig(environment);
      } catch (error) {
        expect(String(error)).not.toContain(value);
      }
    },
  );

  it("fails closed when the database URL is missing", () => {
    const environment = validEnvironment();
    delete environment["DATABASE_URL"];

    expect(() => loadConfig(environment)).toThrow(ConfigurationError);
  });

  it("does not include a rejected database password in the error", () => {
    const environment = validEnvironment();
    environment["DATABASE_URL"] =
      "https://loop_api:do-not-log-me@example.com/db";

    expect(() => loadConfig(environment)).toThrowError(
      /DATABASE_URL: protocol must be postgres or postgresql/,
    );

    try {
      loadConfig(environment);
    } catch (error) {
      expect(String(error)).not.toContain("do-not-log-me");
    }
  });

  it("requires HTTPS for a production public base URL", () => {
    const environment = validEnvironment();
    environment["NODE_ENV"] = "production";

    expect(() => loadConfig(environment)).toThrowError(
      /PUBLIC_BASE_URL: production requires https/,
    );
  });

  it("keeps HTTP OpenAPI retrieval disabled by default in production", () => {
    const environment = validEnvironment();
    environment["NODE_ENV"] = "production";
    environment["PUBLIC_BASE_URL"] = "https://api-dev.quant-dinger.cc";
    delete environment["API_DOCS_ENABLED"];

    expect(loadConfig(environment).apiDocsEnabled).toBe(false);
    expect(loadConfig(environment).v2SessionEnabled).toBe(false);
  });

  it("allows the v2 session slice to be explicitly gated", () => {
    const environment = validEnvironment();
    environment["V2_SESSION_ENABLED"] = "false";

    expect(loadConfig(environment).v2SessionEnabled).toBe(false);
  });

  describe("V2 policy gates, module gate, and cursor secret", () => {
    const versionPolicy = {
      V2_CLIENT_POLICY_CONFIG_VERSION: "productPolicyV2.2026-09-07",
      V2_CLIENT_POLICY_EFFECTIVE_AT: "2026-09-07T00:00:00Z",
      V2_CLIENT_POLICY_MIN_VERSION_IOS: "1.4.0",
      V2_CLIENT_POLICY_MIN_VERSION_ANDROID: "1.3.2",
      V2_CLIENT_POLICY_STORE_URL_IOS: "https://apps.apple.com/app/id1",
      V2_CLIENT_POLICY_STORE_URL_ANDROID:
        "https://play.google.com/store/apps/details?id=app.loop",
    } as const;

    function withPolicy(
      overrides: Readonly<Record<string, string>> = {},
    ): NodeJS.ProcessEnv {
      return { ...validEnvironment(), ...versionPolicy, ...overrides };
    }

    it("defaults every V2 gate to unconfigured", () => {
      const config = loadConfig({
        ...validEnvironment(),
        V2_MODULES_ENABLED: "  ",
        V2_TERMS_REQUIRED_VERSION: "",
      });

      expect(config.v2ModulesEnabled.size).toBe(0);
      expect(config.v2ClientPolicy).toEqual({
        configVersion: null,
        effectiveAt: null,
        versionPolicy: null,
        termsRequiredVersion: null,
      });
      expect(config.v2Cursor).toBeNull();
    });

    it("parses a complete version policy with the hard floor defaulting to the minimum", () => {
      const config = loadConfig(withPolicy());

      expect(config.v2ClientPolicy.versionPolicy).toEqual({
        minimumSupportedVersions: { ios: "1.4.0", android: "1.3.2" },
        forceUpdateBelow: { ios: "1.4.0", android: "1.3.2" },
        storeUrls: {
          ios: "https://apps.apple.com/app/id1",
          android: "https://play.google.com/store/apps/details?id=app.loop",
        },
      });
      expect(Object.isFrozen(config.v2ClientPolicy.versionPolicy)).toBe(true);
    });

    it("accepts explicit hard floors at or below the minimum", () => {
      const config = loadConfig(
        withPolicy({
          V2_CLIENT_POLICY_FORCE_UPDATE_BELOW_IOS: "1.4.0-rc.1",
          V2_CLIENT_POLICY_FORCE_UPDATE_BELOW_ANDROID: "1.0.0",
        }),
      );

      expect(config.v2ClientPolicy.versionPolicy?.forceUpdateBelow).toEqual({
        ios: "1.4.0-rc.1",
        android: "1.0.0",
      });
    });

    it.each([
      [
        "partial policy",
        { ...validEnvironment(), V2_CLIENT_POLICY_MIN_VERSION_IOS: "1.4.0" },
        /must be configured together/,
      ],
      [
        "hard floor without a policy",
        {
          ...validEnvironment(),
          V2_CLIENT_POLICY_FORCE_UPDATE_BELOW_IOS: "1.0.0",
        },
        /requires the complete V2 client version policy/,
      ],
      [
        "invalid semver",
        withPolicy({ V2_CLIENT_POLICY_MIN_VERSION_ANDROID: "1.3" }),
        /V2_CLIENT_POLICY_MIN_VERSION_ANDROID: must be a valid SemVer/,
      ],
      [
        "http store URL",
        withPolicy({ V2_CLIENT_POLICY_STORE_URL_IOS: "http://example.com/a" }),
        /V2_CLIENT_POLICY_STORE_URL_IOS: protocol must be https/,
      ],
      [
        "store URL with credentials",
        withPolicy({
          V2_CLIENT_POLICY_STORE_URL_ANDROID: "https://user:pw@example.com/a",
        }),
        /V2_CLIENT_POLICY_STORE_URL_ANDROID: credentials are not allowed/,
      ],
      [
        "hard floor above the minimum",
        withPolicy({ V2_CLIENT_POLICY_FORCE_UPDATE_BELOW_IOS: "1.5.0" }),
        /FORCE_UPDATE_BELOW_IOS: must not exceed/,
      ],
      [
        "malformed config version",
        withPolicy({ V2_CLIENT_POLICY_CONFIG_VERSION: "-bad" }),
        /V2_CLIENT_POLICY_CONFIG_VERSION/,
      ],
      [
        "effectiveAt without timezone",
        withPolicy({ V2_CLIENT_POLICY_EFFECTIVE_AT: "2026-09-07T00:00:00" }),
        /V2_CLIENT_POLICY_EFFECTIVE_AT/,
      ],
      [
        "unknown module",
        { ...validEnvironment(), V2_MODULES_ENABLED: "wallet,perp" },
        /V2_MODULES_ENABLED: unknown module ID/,
      ],
      [
        "duplicate module",
        { ...validEnvironment(), V2_MODULES_ENABLED: "launch,launch" },
        /V2_MODULES_ENABLED: duplicate module ID/,
      ],
      [
        "weak cursor secret",
        { ...validEnvironment(), V2_CURSOR_HMAC_SECRET: "short" },
        /V2_CURSOR_HMAC_SECRET/,
      ],
      [
        "version gate without the policy snapshot identity",
        withPolicy({ V2_CLIENT_POLICY_EFFECTIVE_AT: "" }),
        /V2_CLIENT_POLICY_CONFIG_VERSION and V2_CLIENT_POLICY_EFFECTIVE_AT are required/,
      ],
      [
        "terms gate without the policy snapshot identity",
        { ...validEnvironment(), V2_TERMS_REQUIRED_VERSION: "terms-2026-09" },
        /V2_CLIENT_POLICY_CONFIG_VERSION and V2_CLIENT_POLICY_EFFECTIVE_AT are required/,
      ],
      [
        "alias blocked term with a control character",
        { ...validEnvironment(), V2_ALIAS_BLOCKED_TERMS: "ok,bad\u0007term" },
        /V2_ALIAS_BLOCKED_TERMS/,
      ],
    ])("fails closed on %s", (_name, environment, message) => {
      expect(() => loadConfig(environment)).toThrow(ConfigurationError);
      expect(() => loadConfig(environment)).toThrow(message);
    });

    it("normalises the alias blocklist and defaults it to empty", () => {
      expect(loadConfig(validEnvironment()).v2AliasBlockedTerms).toEqual([]);
      const config = loadConfig({
        ...validEnvironment(),
        V2_ALIAS_BLOCKED_TERMS: " Scam , ,\uFF2Cegit , scam ,rug-pull",
      });
      expect(config.v2AliasBlockedTerms).toEqual(["scam", "legit", "rug-pull"]);
      expect(Object.isFrozen(config.v2AliasBlockedTerms)).toBe(true);
    });

    it("does not echo a rejected cursor secret", () => {
      const environment = validEnvironment();
      environment["V2_CURSOR_HMAC_SECRET"] = "short-secret-value";

      try {
        loadConfig(environment);
        expect.fail("expected a configuration error");
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigurationError);
        expect((error as Error).message).not.toContain("short-secret-value");
      }
    });

    it("parses terms, policy snapshot metadata, modules, and the cursor secret", () => {
      const secret = "c".repeat(48);
      const config = loadConfig({
        ...validEnvironment(),
        V2_TERMS_REQUIRED_VERSION: " terms-2026-09 ",
        V2_CLIENT_POLICY_CONFIG_VERSION: "productPolicyV2.2026-09-07",
        V2_CLIENT_POLICY_EFFECTIVE_AT: "2026-09-07T08:00:00+08:00",
        V2_MODULES_ENABLED: "profile, wallet ,community",
        V2_CURSOR_HMAC_SECRET: secret,
      });

      expect(config.v2ClientPolicy.termsRequiredVersion).toBe("terms-2026-09");
      expect(config.v2ClientPolicy.configVersion).toBe(
        "productPolicyV2.2026-09-07",
      );
      expect(config.v2ClientPolicy.effectiveAt).toBe(
        "2026-09-07T00:00:00.000Z",
      );
      expect([...config.v2ModulesEnabled]).toEqual([
        "profile",
        "wallet",
        "community",
      ]);
      expect(config.v2Cursor).toEqual({ hmacSecret: secret, ttlSeconds: 600 });
    });
  });
});

describe("launch chain slot (Decision 0038)", () => {
  it("defaults the launch slot to the primary chain and mirrors its read policy", () => {
    const environment = validEnvironment();
    environment["BSC_RPC_URLS"] =
      "https://rpc-a.example/,https://rpc-b.example/";
    environment["BSC_CONFIRMATIONS"] = "21";
    environment["BSC_REORG_DEPTH_BLOCKS"] = "96";

    const config = loadConfig(environment);

    expect(config.launchChain).toEqual({
      chainId: "eip155:56",
      chainReference: 56,
      rpcUrls: ["https://rpc-a.example/", "https://rpc-b.example/"],
      confirmations: 21,
      reorgDepthBlocks: 96,
      sharedWithPrimary: true,
    });
    expect(Object.isFrozen(config.launchChain)).toBe(true);
  });

  it("keeps the shared slot without endpoints when the primary chain has none", () => {
    const config = loadConfig(validEnvironment());
    expect(config.launchChain).toEqual({
      chainId: "eip155:56",
      chainReference: 56,
      rpcUrls: [],
      confirmations: 15,
      reorgDepthBlocks: 64,
      sharedWithPrimary: true,
    });
  });

  it("refuses LAUNCH_BSC_* overrides while the slot is shared with the primary chain", () => {
    for (const [key, value] of [
      ["LAUNCH_BSC_RPC_URLS", "https://testnet.example/"],
      ["LAUNCH_BSC_CONFIRMATIONS", "5"],
      ["LAUNCH_BSC_REORG_DEPTH_BLOCKS", "15"],
    ] as const) {
      const environment = validEnvironment();
      environment[key] = value;
      expect(() => loadConfig(environment)).toThrow(ConfigurationError);
      expect(() => loadConfig(environment)).toThrow(
        new RegExp(`${key}: must be blank while LAUNCH_CHAIN_ID=56`),
      );
      const explicit = validEnvironment();
      explicit["LAUNCH_CHAIN_ID"] = "56";
      explicit[key] = value;
      expect(() => loadConfig(explicit)).toThrow(ConfigurationError);
    }
  });

  it("names the BSC testnet without endpoints as an unavailable slot, never a startup failure", () => {
    const environment = validEnvironment();
    environment["LAUNCH_CHAIN_ID"] = "97";

    const config = loadConfig(environment);

    expect(config.launchChain).toEqual({
      chainId: "eip155:97",
      chainReference: 97,
      rpcUrls: [],
      confirmations: 5,
      reorgDepthBlocks: 15,
      sharedWithPrimary: false,
    });
    expect(config.bscChain).toBeNull();
  });

  it("parses the testnet endpoint list with the primary URL rules and its own defaults", () => {
    const environment = validEnvironment();
    environment["BSC_RPC_URLS"] = "https://rpc-a.example/";
    environment["LAUNCH_CHAIN_ID"] = "97";
    environment["LAUNCH_BSC_RPC_URLS"] =
      " https://bsc-testnet-rpc.example/ , https://bsc-testnet-rpc.example/, https://data-seed.example:8545 ";
    environment["LAUNCH_BSC_CONFIRMATIONS"] = "3";

    const config = loadConfig(environment);

    expect(config.launchChain).toEqual({
      chainId: "eip155:97",
      chainReference: 97,
      rpcUrls: [
        "https://bsc-testnet-rpc.example/",
        "https://data-seed.example:8545/",
      ],
      confirmations: 3,
      reorgDepthBlocks: 15,
      sharedWithPrimary: false,
    });
    // The primary slot is untouched by the launch slot.
    expect(config.bscChain).toMatchObject({
      chainId: "eip155:56",
      rpcUrls: ["https://rpc-a.example/"],
      confirmations: 15,
      reorgDepthBlocks: 64,
    });
  });

  it("rejects an unsupported launch chain, credentialed testnet URLs, and out-of-range policy", () => {
    for (const overrides of [
      { LAUNCH_CHAIN_ID: "1" },
      { LAUNCH_CHAIN_ID: "eip155:97" },
      {
        LAUNCH_CHAIN_ID: "97",
        LAUNCH_BSC_RPC_URLS: "https://user:pass@bsc-testnet.example/",
      },
      {
        LAUNCH_CHAIN_ID: "97",
        LAUNCH_BSC_RPC_URLS: "ws://bsc-testnet.example/",
      },
      { LAUNCH_CHAIN_ID: "97", LAUNCH_BSC_CONFIRMATIONS: "0" },
      { LAUNCH_CHAIN_ID: "97", LAUNCH_BSC_REORG_DEPTH_BLOCKS: "1001" },
    ]) {
      const environment = { ...validEnvironment(), ...overrides };
      expect(() => loadConfig(environment), JSON.stringify(overrides)).toThrow(
        ConfigurationError,
      );
    }
    const credentialed = validEnvironment();
    credentialed["LAUNCH_CHAIN_ID"] = "97";
    credentialed["LAUNCH_BSC_RPC_URLS"] =
      "https://user:pass@bsc-testnet.example/";
    expect(() => loadConfig(credentialed)).toThrow(/LAUNCH_BSC_RPC_URLS/);
    expect(() => loadConfig(credentialed)).not.toThrow(/pass@/);
  });

  it("reads the launch chain ID for operator scripts with exactly the loadConfig rule", () => {
    // Every value the script parser accepts or refuses must be accepted or
    // refused identically by loadConfig, with the same resulting chain.
    const matrix: readonly (string | undefined)[] = [
      undefined,
      "56",
      "97",
      "",
      " ",
      " 56 ",
      "56 ",
      "097",
      "1",
      "eip155:97",
      "0x61",
    ];
    for (const value of matrix) {
      const environment = validEnvironment();
      if (value !== undefined) {
        environment["LAUNCH_CHAIN_ID"] = value;
      }
      let viaConfig: string | null;
      try {
        viaConfig = loadConfig(environment).launchChain.chainId;
      } catch (error) {
        expect(error, JSON.stringify(value)).toBeInstanceOf(ConfigurationError);
        viaConfig = null;
      }
      let viaScript: string | null;
      try {
        viaScript = parseLaunchChainIdEnvironment(value);
      } catch (error) {
        expect(error, JSON.stringify(value)).toBeInstanceOf(ConfigurationError);
        viaScript = null;
      }
      expect(viaScript, JSON.stringify(value)).toBe(viaConfig);
    }
    expect(parseLaunchChainIdEnvironment(undefined)).toBe("eip155:56");
    expect(parseLaunchChainIdEnvironment("56")).toBe("eip155:56");
    expect(parseLaunchChainIdEnvironment("97")).toBe("eip155:97");
    for (const rejected of ["", " 56 ", "56 ", "1"]) {
      expect(() => parseLaunchChainIdEnvironment(rejected), rejected).toThrow(
        ConfigurationError,
      );
    }
  });
});

describe("audio-room user-role evidence reference (Decision 0039)", () => {
  const key = "STREAM_AUDIO_ROOM_USER_ROLE_EVIDENCE_REF";

  it("keeps the evidence pending (null) when the key is unset or blank", () => {
    expect(
      loadConfig(validEnvironment()).streamAudioRoomUserRoleEvidenceRef,
    ).toBeNull();
    for (const blank of ["", " ", "\t", " \n "]) {
      const environment = validEnvironment();
      environment[key] = blank;
      expect(
        loadConfig(environment).streamAudioRoomUserRoleEvidenceRef,
        JSON.stringify(blank),
      ).toBeNull();
    }
  });

  it("publishes a trimmed printable reference of 1 to 120 characters", () => {
    const environment = validEnvironment();
    environment[key] = "  dashboard-2026-09-10-user-role-no-create-call  ";
    expect(loadConfig(environment).streamAudioRoomUserRoleEvidenceRef).toBe(
      "dashboard-2026-09-10-user-role-no-create-call",
    );

    const longest = validEnvironment();
    longest[key] = "x".repeat(120);
    expect(loadConfig(longest).streamAudioRoomUserRoleEvidenceRef).toBe(
      "x".repeat(120),
    );

    const single = validEnvironment();
    single[key] = "a";
    expect(loadConfig(single).streamAudioRoomUserRoleEvidenceRef).toBe("a");

    // Non-ASCII printable text (an archive label in Chinese) is accepted.
    const unicode = validEnvironment();
    unicode[key] = "截图-2026-09-10 user 角色 Create call Not allowed";
    expect(loadConfig(unicode).streamAudioRoomUserRoleEvidenceRef).toBe(
      "截图-2026-09-10 user 角色 Create call Not allowed",
    );
  });

  it("refuses a reference longer than 120 characters", () => {
    const environment = validEnvironment();
    environment[key] = "x".repeat(121);
    expect(() => loadConfig(environment)).toThrow(ConfigurationError);
    expect(() => loadConfig(environment)).toThrow(new RegExp(`${key}: .*120`));
    // Trimming happens before the length check: padding does not rescue it.
    const padded = validEnvironment();
    padded[key] = ` ${"x".repeat(121)} `;
    expect(() => loadConfig(padded)).toThrow(ConfigurationError);
  });

  it("refuses control, format, and other non-printable characters", () => {
    for (const rejected of [
      "dashboard\u0000ref",
      "dashboard\u001bref",
      "dashboard\tref",
      "dashboard\nref",
      "dashboard\rref",
      "dashboard\u007fref",
      "dashboard\u0085ref",
      "dashboard\u200bref",
      "dashboard\u202eref",
      "dashboard\ufeffref",
      "\u0007",
    ]) {
      const environment = validEnvironment();
      environment[key] = rejected;
      expect(() => loadConfig(environment), JSON.stringify(rejected)).toThrow(
        ConfigurationError,
      );
      expect(() => loadConfig(environment), JSON.stringify(rejected)).toThrow(
        new RegExp(`${key}: must not contain control`),
      );
    }
  });
});

describe("Community AI Provider configuration (Decision 0066, amended 2026-09-23)", () => {
  it("stays deferred when neither COMMUNITY_AI_API_KEY nor ANTHROPIC_API_KEY is set", () => {
    const config = loadConfig(validEnvironment());

    expect(config.communityAi).toBeNull();
  });

  it("treats a blank key as unset", () => {
    const environment = validEnvironment();
    environment["COMMUNITY_AI_API_KEY"] = "   ";
    environment["ANTHROPIC_API_KEY"] = "";

    expect(loadConfig(validEnvironment()).communityAi).toBeNull();
    expect(loadConfig(environment).communityAi).toBeNull();
  });

  it("falls back to ANTHROPIC_API_KEY and to the Anthropic origin", () => {
    const environment = validEnvironment();
    environment["ANTHROPIC_API_KEY"] = "sk-ant-fallback-key";

    const config = loadConfig(environment);

    expect(config.communityAi).toMatchObject({
      apiKey: "sk-ant-fallback-key",
      baseUrl: "https://api.anthropic.com",
      model: "claude-sonnet-5",
      // Below the 15 s HTTP deadlines with room for knowledge assembly.
      timeoutMs: 11_000,
    });
    expect(config.communityAi?.timeoutMs).toBeLessThan(
      requestAbortDeadlineMilliseconds,
    );
    expect(Object.isFrozen(config.communityAi)).toBe(true);
  });

  it("prefers COMMUNITY_AI_API_KEY over ANTHROPIC_API_KEY", () => {
    const environment = validEnvironment();
    environment["ANTHROPIC_API_KEY"] = "sk-ant-fallback-key";
    environment["COMMUNITY_AI_API_KEY"] = "sk-or-primary-key";

    expect(loadConfig(environment).communityAi?.apiKey).toBe(
      "sk-or-primary-key",
    );

    const blankPrimary = validEnvironment();
    blankPrimary["ANTHROPIC_API_KEY"] = "sk-ant-fallback-key";
    blankPrimary["COMMUNITY_AI_API_KEY"] = "";

    expect(loadConfig(blankPrimary).communityAi?.apiKey).toBe(
      "sk-ant-fallback-key",
    );
  });

  it("accepts an Anthropic-compatible gateway origin and normalises a trailing slash", () => {
    const environment = validEnvironment();
    environment["COMMUNITY_AI_API_KEY"] = "sk-or-primary-key";
    environment["COMMUNITY_AI_BASE_URL"] = "https://api.onlyrouter.ai/";

    expect(loadConfig(environment).communityAi?.baseUrl).toBe(
      "https://api.onlyrouter.ai",
    );

    environment["COMMUNITY_AI_BASE_URL"] = "  https://API.OnlyRouter.ai  ";
    expect(loadConfig(environment).communityAi?.baseUrl).toBe(
      "https://api.onlyrouter.ai",
    );
  });

  it.each([
    ["http origin", "http://api.onlyrouter.ai", /protocol must be https/],
    ["not a URL", "onlyrouter", /must be a valid URL/],
    [
      "credentials",
      "https://user:pass@api.onlyrouter.ai",
      /credentials are not allowed/,
    ],
    [
      "path",
      "https://api.onlyrouter.ai/v1",
      /must be an origin without path, query, or fragment/,
    ],
    [
      "messages path",
      "https://api.onlyrouter.ai/v1/messages",
      /must be an origin without path, query, or fragment/,
    ],
    [
      "query",
      "https://api.onlyrouter.ai/?x=1",
      /must be an origin without path, query, or fragment/,
    ],
    [
      "fragment",
      "https://api.onlyrouter.ai/#frag",
      /must be an origin without path, query, or fragment/,
    ],
  ])("rejects COMMUNITY_AI_BASE_URL with %s", (_label, value, message) => {
    const environment = validEnvironment();
    environment["COMMUNITY_AI_API_KEY"] = "sk-or-primary-key";
    environment["COMMUNITY_AI_BASE_URL"] = value;

    expect(() => loadConfig(environment)).toThrow(ConfigurationError);
    expect(() => loadConfig(environment)).toThrowError(message);
  });

  it("rejects a malformed COMMUNITY_AI_BASE_URL even without a key", () => {
    const environment = validEnvironment();
    environment["COMMUNITY_AI_BASE_URL"] = "http://api.onlyrouter.ai";

    expect(() => loadConfig(environment)).toThrow(ConfigurationError);
  });
});
