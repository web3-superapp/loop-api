import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  faucetDecimalToRaw,
  loadConfig,
  parseTestnetFaucet,
} from "../src/config.js";

/** Decision 0128: faucet configuration parsing and the chain-97 boot rule. */

const base = {
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  DATABASE_URL:
    "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
} as const;
const keyA = "aa".repeat(32);
const keyB = "bb".repeat(32);

function parse(overrides: Partial<Parameters<typeof parseTestnetFaucet>[0]>) {
  return parseTestnetFaucet({
    TESTNET_FAUCET_ENABLED: true,
    TESTNET_FAUCET_BNB_AMOUNT: "0.02",
    TESTNET_FAUCET_USD1_AMOUNT: "500",
    TESTNET_FAUCET_COOLDOWN_SECONDS: 86_400,
    ...overrides,
  });
}

describe("testnet faucet configuration (Decision 0128)", () => {
  it("defaults to disabled with 0.02 tBNB, 500 USD1, and 24 hours", () => {
    const config = loadConfig({ ...base });
    expect(config.testnetFaucet).toEqual({
      enabled: false,
      bnbAmount: "0.02",
      bnbAmountWei: "20000000000000000",
      usd1Amount: "500",
      cooldownSeconds: 86_400,
      operatorPrivateKey: null,
      usd1Source: null,
    });
  });

  it("refuses to boot when enabled off LAUNCH_CHAIN_ID=97", () => {
    expect(() =>
      loadConfig({ ...base, TESTNET_FAUCET_ENABLED: "true" }),
    ).toThrow(
      /TESTNET_FAUCET_ENABLED is permitted only when LAUNCH_CHAIN_ID=97/,
    );
    expect(() =>
      loadConfig({
        ...base,
        TESTNET_FAUCET_ENABLED: "true",
        LAUNCH_CHAIN_ID: "56",
      }),
    ).toThrow(ConfigurationError);
  });

  it("boots enabled on chain 97 under NODE_ENV=production (staging)", () => {
    const config = loadConfig({
      ...base,
      NODE_ENV: "production",
      PUBLIC_BASE_URL: "https://api-staging.example.test",
      LAUNCH_CHAIN_ID: "97",
      TESTNET_FAUCET_ENABLED: "true",
      MEME_OPERATOR_PRIVATE_KEY: keyA,
    });
    expect(config.testnetFaucet.enabled).toBe(true);
    expect(config.testnetFaucet.operatorPrivateKey).toBe(`0x${keyA}`);
  });

  it("falls back to MEME_OPERATOR_PRIVATE_KEY and prefers its own key", () => {
    expect(parse({ MEME_OPERATOR_PRIVATE_KEY: keyA }).operatorPrivateKey).toBe(
      `0x${keyA}`,
    );
    expect(
      parse({
        MEME_OPERATOR_PRIVATE_KEY: keyA,
        TESTNET_FAUCET_OPERATOR_PRIVATE_KEY: `0x${keyB.toUpperCase()}`,
      }).operatorPrivateKey,
    ).toBe(`0x${keyB}`);
    expect(parse({}).operatorPrivateKey).toBeNull();
  });

  it("refuses a malformed key or amount without echoing the key", () => {
    let message = "";
    try {
      parse({ TESTNET_FAUCET_OPERATOR_PRIVATE_KEY: "zz".repeat(32) });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/TESTNET_FAUCET_OPERATOR_PRIVATE_KEY/);
    expect(message).not.toContain("zz".repeat(32));
    for (const amount of ["0", "-1", "1e3", "0.0000000000000000001", "2", ""]) {
      expect(() => parse({ TESTNET_FAUCET_BNB_AMOUNT: amount })).toThrow(
        /TESTNET_FAUCET_BNB_AMOUNT/,
      );
    }
    expect(() => parse({ TESTNET_FAUCET_USD1_AMOUNT: "1000001" })).toThrow(
      /TESTNET_FAUCET_USD1_AMOUNT/,
    );
    expect(() =>
      loadConfig({ ...base, TESTNET_FAUCET_COOLDOWN_SECONDS: "59" }),
    ).toThrow(ConfigurationError);
  });

  it("canonicalises amounts and converts them exactly", () => {
    const config = parse({
      TESTNET_FAUCET_BNB_AMOUNT: "0.0200",
      TESTNET_FAUCET_USD1_AMOUNT: "500.0",
      LAUNCH_USD1_ADDRESS: "0xAbCdEf0000000000000000000000000000000001",
    });
    expect(config.bnbAmount).toBe("0.02");
    expect(config.usd1Amount).toBe("500");
    expect(config.usd1Source).toEqual({
      kind: "launch",
      address: "0xabcdef0000000000000000000000000000000001",
    });
    expect(faucetDecimalToRaw("500", 18)).toBe(500n * 10n ** 18n);
    expect(faucetDecimalToRaw("0.5", 6)).toBe(500_000n);
    expect(() => faucetDecimalToRaw("0.1234567", 6)).toThrow(RangeError);
  });

  describe("USD1 source priority (S156b)", () => {
    const launch2Usd1 = "0x3a1236E68eCf3225640367c84b6F50A51D0B0195";
    const idoUsd1 = "0x17d554fd00000000000000000000000000Ce2B00";
    const factory = "0x00000000000000000000000000000000000FAC70";

    it("1. an explicit TESTNET_FAUCET_USD1_ADDRESS wins over the Factory and LAUNCH_USD1_ADDRESS", () => {
      expect(
        parse({
          TESTNET_FAUCET_USD1_ADDRESS: launch2Usd1,
          HOOKS_LAUNCH_FACTORY_ADDRESS: factory,
          LAUNCH_USD1_ADDRESS: idoUsd1,
        }).usd1Source,
      ).toEqual({ kind: "explicit", address: launch2Usd1.toLowerCase() });
    });

    it("2. with launch2 configured, the Hooks Factory's usd1() wins over LAUNCH_USD1_ADDRESS", () => {
      expect(
        parse({
          HOOKS_LAUNCH_FACTORY_ADDRESS: factory,
          LAUNCH_USD1_ADDRESS: idoUsd1,
        }).usd1Source,
      ).toEqual({ kind: "factory", factoryAddress: factory.toLowerCase() });
    });

    it("3. only without a Factory does it fall back to LAUNCH_USD1_ADDRESS", () => {
      expect(parse({ LAUNCH_USD1_ADDRESS: idoUsd1 }).usd1Source).toEqual({
        kind: "launch",
        address: idoUsd1.toLowerCase(),
      });
      expect(parse({}).usd1Source).toBeNull();
    });

    it("refuses a malformed TESTNET_FAUCET_USD1_ADDRESS and reads it through loadConfig", () => {
      expect(() => parse({ TESTNET_FAUCET_USD1_ADDRESS: "0x1234" })).toThrow(
        /TESTNET_FAUCET_USD1_ADDRESS/,
      );
      const config = loadConfig({
        ...base,
        LAUNCH_CHAIN_ID: "97",
        HOOKS_LAUNCH_FACTORY_ADDRESS: factory,
        HOOKS_LAUNCH_FACTORY_CODE_HASH: `0x${"ab".repeat(32)}`,
      });
      expect(config.testnetFaucet.usd1Source).toEqual({
        kind: "factory",
        factoryAddress: factory.toLowerCase(),
      });
      expect(
        loadConfig({
          ...base,
          LAUNCH_CHAIN_ID: "97",
          HOOKS_LAUNCH_FACTORY_ADDRESS: factory,
          HOOKS_LAUNCH_FACTORY_CODE_HASH: `0x${"ab".repeat(32)}`,
          TESTNET_FAUCET_USD1_ADDRESS: launch2Usd1,
        }).testnetFaucet.usd1Source,
      ).toEqual({ kind: "explicit", address: launch2Usd1.toLowerCase() });
    });
  });
});
