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
  });
});
