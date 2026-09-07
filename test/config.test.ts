import { describe, expect, it } from "vitest";

import { ConfigurationError, loadConfig } from "../src/config.js";

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
    ])("fails closed on %s", (_name, environment, message) => {
      expect(() => loadConfig(environment)).toThrow(ConfigurationError);
      expect(() => loadConfig(environment)).toThrow(message);
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
