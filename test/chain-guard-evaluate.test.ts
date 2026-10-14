import { describe, expect, it } from "vitest";

import { ConfigurationError, parseChainGuardConfig } from "../src/config.js";
import { chainGuardIncidentReasonCode } from "../src/features/chain-guard/chain-guard-contract.js";
import {
  chainGuardLogFindings,
  decodeProtocolFee,
  evaluateChainGuardSnapshot,
  formatBnbAmount,
  mergeWatchedAddresses,
  parseBnbAmount,
  type ChainGuardPolicy,
  type ChainGuardSnapshot,
} from "../src/features/chain-guard/chain-guard-evaluate.js";
import {
  chainPreflightReport,
  formatChainPreflightReport,
} from "../src/features/chain-guard/chain-guard-preflight.js";
import {
  eip1967AdminSlot,
  eip1967ImplementationSlot,
  slotAddress,
} from "../src/integrations/chain-guard/chain-guard-chain.js";
import { chainGuardSignerAccounts } from "../src/integrations/chain-guard/chain-guard-targets.js";
import { keccak256, toHex } from "viem";
import {
  guardAddress,
  guardPoolId,
  proxyAdmin,
  slot0WithFee,
  usd1,
  usd1Log,
} from "./helpers/chain-guard-fakes.js";

/** Decision 0134: the pure judgments shared by the lane and the preflight. */

const implementation = guardAddress(0x694a);
const policy: ChainGuardPolicy = {
  expectedImplementation: implementation,
  expectedProtocolFeeController: guardAddress(0x6627),
  protocolFeeAlertPips: 500,
  minBnbWei: 5n * 10n ** 16n,
};

function snapshot(
  overrides: Partial<ChainGuardSnapshot> = {},
): ChainGuardSnapshot {
  return {
    chainReference: 56,
    usd1: { address: usd1, paused: false, implementation },
    factoryUsd1: [{ factory: guardAddress(0xfac), usd1 }],
    frozen: [
      { address: guardAddress(0xe5c), labels: ["escrow"], frozen: false },
    ],
    poolManagers: [
      {
        address: guardAddress(0x28e2),
        protocolFeeController: guardAddress(0x6627),
      },
    ],
    pools: [
      {
        poolId: guardPoolId(1),
        instanceId: "i-1",
        poolManager: guardAddress(0x28e2),
        zeroForOnePips: 0,
        oneForZeroPips: 0,
      },
    ],
    balances: [
      { address: guardAddress(0xe1), labels: ["executor"], wei: 10n ** 17n },
    ],
    ...overrides,
  };
}

describe("chain guard judgments (Decision 0134)", () => {
  it("decodes the v4 slot0 protocol fee per direction", () => {
    expect(decodeProtocolFee(0n)).toEqual({
      zeroForOnePips: 0,
      oneForZeroPips: 0,
    });
    // docs/24 §7.2.1: 102425 = 25 | 25 << 12.
    expect(decodeProtocolFee(102_425n << 184n)).toEqual({
      zeroForOnePips: 25,
      oneForZeroPips: 25,
    });
    expect(decodeProtocolFee(slot0WithFee(1000, 400))).toEqual({
      zeroForOnePips: 1000,
      oneForZeroPips: 400,
    });
    // sqrtPrice and tick bits do not leak into the fee; the lpFee bits above do not either.
    const packed =
      (123n << 208n) |
      slot0WithFee(7, 9) |
      (0xabcn << 160n) |
      ((1n << 160n) - 1n);
    expect(decodeProtocolFee(packed)).toEqual({
      zeroForOnePips: 7,
      oneForZeroPips: 9,
    });
  });

  it("parses and formats BNB amounts as integers", () => {
    expect(parseBnbAmount("0.05")).toBe(5n * 10n ** 16n);
    expect(parseBnbAmount("1")).toBe(10n ** 18n);
    expect(parseBnbAmount("0.000000000000000001")).toBe(1n);
    expect(parseBnbAmount("1e3")).toBeNull();
    expect(parseBnbAmount("-1")).toBeNull();
    expect(formatBnbAmount(5n * 10n ** 16n)).toBe("0.05");
    expect(formatBnbAmount(0n)).toBe("0");
    expect(formatBnbAmount(12n * 10n ** 17n)).toBe("1.2");
  });

  it("merges duplicate watch addresses and drops zero / malformed ones", () => {
    expect(
      mergeWatchedAddresses([
        {
          address: guardAddress(2).toUpperCase().replace("0X", "0x"),
          label: "b",
        },
        { address: guardAddress(2), label: "a" },
        { address: guardAddress(0), label: "zero" },
        { address: "nope", label: "bad" },
      ]),
    ).toEqual([{ address: guardAddress(2), labels: ["b", "a"] }]);
  });

  it("finds nothing on a clean mainnet snapshot", () => {
    const result = evaluateChainGuardSnapshot(snapshot(), policy);
    expect(result.findings).toEqual([]);
    expect(result.notConfigured).toEqual([]);
    expect(result.evaluatedKinds).toContain("usd1_implementation_changed");
    expect(result.evaluatedKinds).toContain("protocol_fee_controller_changed");
  });

  it("flags every risky reading", () => {
    const result = evaluateChainGuardSnapshot(
      snapshot({
        usd1: { address: usd1, paused: true, implementation: guardAddress(9) },
        factoryUsd1: [
          { factory: guardAddress(0xfac), usd1: guardAddress(0xbad) },
        ],
        frozen: [
          { address: guardAddress(0xe5c), labels: ["escrow"], frozen: true },
        ],
        poolManagers: [
          {
            address: guardAddress(0x28e2),
            protocolFeeController: guardAddress(7),
          },
        ],
        pools: [
          {
            poolId: guardPoolId(1),
            instanceId: "i-1",
            poolManager: guardAddress(0x28e2),
            zeroForOnePips: 500,
            oneForZeroPips: 0,
          },
        ],
        balances: [
          { address: guardAddress(0xe1), labels: ["executor"], wei: 1n },
        ],
      }),
      policy,
    );
    expect(result.findings.map((finding) => finding.kind)).toEqual([
      "usd1_paused",
      "usd1_address_frozen",
      "usd1_implementation_changed",
      "usd1_address_mismatch",
      "protocol_fee_controller_changed",
      "pool_protocol_fee_nonzero",
      "pool_protocol_fee_high",
      "account_balance_low",
    ]);
    expect(chainGuardIncidentReasonCode("usd1_paused")).toBe(
      "CHAIN_GUARD_USD1_PAUSED",
    );
  });

  it("treats a nonzero fee under the threshold as nonzero only", () => {
    const result = evaluateChainGuardSnapshot(
      snapshot({
        pools: [
          {
            poolId: guardPoolId(1),
            instanceId: "i-1",
            poolManager: guardAddress(0x28e2),
            zeroForOnePips: 25,
            oneForZeroPips: 499,
          },
        ],
      }),
      policy,
    );
    expect(result.findings.map((finding) => finding.kind)).toEqual([
      "pool_protocol_fee_nonzero",
    ]);
  });

  it("does not evaluate checks without an expected value", () => {
    const result = evaluateChainGuardSnapshot(
      snapshot({
        usd1: { address: usd1, paused: false, implementation: guardAddress(9) },
      }),
      {
        ...policy,
        expectedImplementation: null,
        expectedProtocolFeeController: null,
      },
    );
    expect(result.findings).toEqual([]);
    expect(result.notConfigured).toEqual([
      "usd1.implementation",
      "poolManager.protocolFeeController",
    ]);
    expect(result.evaluatedKinds).not.toContain("usd1_implementation_changed");
  });

  it("an unsupported USD1 read is a finding on 56 and informational on 97", () => {
    const readings = {
      usd1: { address: usd1, paused: null, implementation },
      frozen: [{ address: guardAddress(1), labels: ["x"], frozen: null }],
    } as const;
    const mainnet = evaluateChainGuardSnapshot(snapshot(readings), policy);
    expect(mainnet.findings).toEqual([
      {
        kind: "usd1_read_unsupported",
        subject: usd1,
        details: { reads: ["usd1.paused", "usd1.frozen"] },
      },
    ]);
    const testnet = evaluateChainGuardSnapshot(
      snapshot({ ...readings, chainReference: 97 }),
      policy,
    );
    expect(testnet.findings).toEqual([]);
    expect(testnet.unsupported).toEqual(["usd1.paused", "usd1.frozen"]);
  });

  it("maps USD1 / ProxyAdmin logs, counting freezes only for watched addresses", () => {
    const ours = guardAddress(0xe5c);
    const stranger = guardAddress(0xdead);
    const result = chainGuardLogFindings({
      usd1,
      proxyAdmin,
      watched: new Set([ours]),
      logs: [
        usd1Log("Paused", 1n, { account: guardAddress(0x2ce4) }),
        usd1Log("Freeze", 2n, { caller: guardAddress(1), account: ours }),
        usd1Log("Freeze", 3n, { caller: guardAddress(1), account: stranger }),
        usd1Log("FrozenAccountDrained", 4n, {
          caller: guardAddress(1),
          account: ours,
          amount: "133333330000000000000000",
        }),
        usd1Log("FrozenFundsReallocated", 5n, {
          caller: guardAddress(1),
          from: stranger,
          to: guardAddress(2),
          amount: "1",
        }),
        usd1Log("Upgraded", 6n, { implementation: guardAddress(0x3333) }),
        usd1Log("AdminChanged", 7n, {
          previousAdmin: proxyAdmin,
          newAdmin: guardAddress(0xae),
        }),
        usd1Log("OwnershipTransferred", 8n, {
          previousOwner: guardAddress(0xee9b),
          newOwner: guardAddress(0xee9c),
        }),
        usd1Log(
          "OwnershipTransferred",
          9n,
          {
            previousOwner: guardAddress(0x6a8d),
            newOwner: guardAddress(0x6a8e),
          },
          proxyAdmin,
        ),
        usd1Log(
          "OwnershipTransferred",
          10n,
          { previousOwner: guardAddress(1), newOwner: guardAddress(2) },
          guardAddress(0x7777),
        ),
        usd1Log("Unpaused", 11n),
      ],
    });
    expect(
      result.state.map((finding) => [finding.kind, finding.subject]),
    ).toEqual([
      ["usd1_paused", usd1],
      ["usd1_address_frozen", ours],
    ]);
    expect(
      result.events.map((finding) => [finding.kind, finding.subject]),
    ).toEqual([
      ["usd1_frozen_funds_drained", ours],
      ["usd1_upgraded", guardAddress(0x3333)],
      ["usd1_proxy_admin_changed", guardAddress(0xae)],
      ["usd1_owner_transferred", guardAddress(0xee9c)],
      ["usd1_proxy_admin_ownership_transferred", guardAddress(0x6a8e)],
    ]);
    expect(result.events[0]?.details).toMatchObject({
      amountRaw: "133333330000000000000000",
      source: "event",
      blockNumber: "4",
    });
  });
});

describe("chain guard reader helpers (Decision 0134)", () => {
  it("uses the EIP-1967 slots", () => {
    const minusOne = (label: string) =>
      toHex(BigInt(keccak256(toHex(label))) - 1n, { size: 32 });
    expect(eip1967ImplementationSlot).toBe(
      minusOne("eip1967.proxy.implementation"),
    );
    expect(eip1967AdminSlot).toBe(minusOne("eip1967.proxy.admin"));
    expect(
      slotAddress(
        `0x${"0".repeat(24)}694aa534bdef8ed63244eb902e7914e527891f08`,
      ),
    ).toBe("0x694aa534bdef8ed63244eb902e7914e527891f08");
    expect(slotAddress(`0x${"0".repeat(64)}`)).toBeNull();
  });

  it("derives signer addresses locally and skips missing keys", () => {
    // The fixture key the worker-runtime tests use ("61" × 32).
    const accounts = chainGuardSignerAccounts([
      {
        label: "hooksLaunchExecutor",
        privateKey: "61".repeat(32),
      },
      { label: "launch2DynamicPoke", privateKey: undefined },
      { label: "bad", privateKey: "0x1234" },
    ]);
    expect(accounts).toEqual([
      {
        address: "0xed5970f07eea5a9e7b359d3c5d3f82b34a8f1e15",
        label: "hooksLaunchExecutor",
      },
    ]);
  });
});

describe("chain guard configuration (Decision 0134)", () => {
  it("defaults", () => {
    const config = parseChainGuardConfig({});
    expect(config).toMatchObject({
      intervalSeconds: 60,
      protocolFeeAlertPips: 500,
      minBnb: "0.05",
      minBnbWei: 5n * 10n ** 16n,
      usd1Address: null,
      expectedImplementation: null,
      factories: [],
      watch: [],
      balanceAccounts: [],
    });
  });

  it("reads every key and prefers CHAIN_GUARD_USD1_ADDRESS", () => {
    const config = parseChainGuardConfig({
      CHAIN_GUARD_INTERVAL_SECONDS: "30",
      CHAIN_GUARD_USD1_ADDRESS: "0x8D0D000Ee44948FC98c9B98A4FA4921476f08B0d",
      LAUNCH_USD1_ADDRESS: guardAddress(1),
      CHAIN_GUARD_USD1_IMPLEMENTATION:
        "0x694Aa534bdef8eD63244eB902E7914e527891F08",
      CHAIN_GUARD_POOL_MANAGER_ADDRESS:
        "0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF",
      CHAIN_GUARD_PROTOCOL_FEE_CONTROLLER: guardAddress(0x6627),
      CHAIN_GUARD_PROTOCOL_FEE_ALERT_PIPS: "1",
      CHAIN_GUARD_MIN_BNB: "0.2",
      HOOKS_LAUNCH_FACTORY_ADDRESS: guardAddress(0xfac),
      LAUNCH2_DYNAMIC_FACTORY_ADDRESS: guardAddress(0xfad),
      LAUNCH2_POOL_ROUTER_ADDRESS: guardAddress(0x2007),
      CHAIN_GUARD_WATCH_ADDRESSES: `loopRouter:${guardAddress(0x100)}, feeVault:${guardAddress(0x101)}`,
      CHAIN_GUARD_BALANCE_ACCOUNTS: `snapshotPublisher:${guardAddress(0x102)}`,
    });
    expect(config).toMatchObject({
      intervalSeconds: 30,
      usd1Address: "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d",
      expectedImplementation: "0x694aa534bdef8ed63244eb902e7914e527891f08",
      poolManagerAddress: "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df",
      protocolFeeAlertPips: 1,
      minBnbWei: 2n * 10n ** 17n,
      factories: [guardAddress(0xfac), guardAddress(0xfad)],
      poolRouterAddress: guardAddress(0x2007),
      watch: [
        { address: guardAddress(0x100), label: "loopRouter" },
        { address: guardAddress(0x101), label: "feeVault" },
      ],
      balanceAccounts: [
        { address: guardAddress(0x102), label: "snapshotPublisher" },
      ],
    });
  });

  it("refuses malformed values", () => {
    expect(() =>
      parseChainGuardConfig({
        CHAIN_GUARD_USD1_IMPLEMENTATION: "0x1234",
        CHAIN_GUARD_INTERVAL_SECONDS: "5",
        CHAIN_GUARD_PROTOCOL_FEE_ALERT_PIPS: "1001",
        CHAIN_GUARD_MIN_BNB: "0.05 BNB",
        CHAIN_GUARD_WATCH_ADDRESSES: guardAddress(1),
      }),
    ).toThrow(ConfigurationError);
    try {
      parseChainGuardConfig({ CHAIN_GUARD_MIN_BNB: "1e-2" });
    } catch (error) {
      expect((error as ConfigurationError).issues).toEqual([
        "CHAIN_GUARD_MIN_BNB: must be a decimal BNB amount (≤ 18 decimals)",
      ]);
    }
  });
});

describe("chain:preflight verdict (Decision 0134)", () => {
  function collected(overrides: Partial<ChainGuardSnapshot> = {}) {
    return {
      usd1,
      proxyAdmin,
      watched: [],
      snapshot: snapshot(overrides),
    };
  }

  it("passes a clean mainnet snapshot", () => {
    const report = chainPreflightReport({ collected: collected(), policy });
    expect(report.failures).toBe(0);
    expect(report.warnings).toBe(0);
    expect(formatChainPreflightReport(report)).toContain(
      "0 failed, 0 warning(s)",
    );
  });

  it("fails each risk and warns on a small nonzero fee", () => {
    const report = chainPreflightReport({
      collected: collected({
        usd1: { address: usd1, paused: true, implementation },
        frozen: [
          { address: guardAddress(0xe5c), labels: ["escrow"], frozen: true },
        ],
        pools: [
          {
            poolId: guardPoolId(1),
            instanceId: "i-1",
            poolManager: guardAddress(0x28e2),
            zeroForOnePips: 25,
            oneForZeroPips: 25,
          },
        ],
        balances: [
          { address: guardAddress(0xe1), labels: ["executor"], wei: 0n },
        ],
      }),
      policy,
    });
    expect(
      report.rows
        .filter((row) => row.status !== "ok")
        .map((row) => [row.check, row.status]),
    ).toEqual([
      ["usd1.paused", "fail"],
      ["usd1.frozen", "fail"],
      ["pool.protocolFee", "warn"],
      ["account.bnb", "fail"],
    ]);
    expect(report.failures).toBe(3);
  });

  it("on mainnet an unpinned implementation and unsupported reads fail; on testnet they warn", () => {
    const readings = {
      usd1: { address: usd1, paused: null, implementation: null },
    } as const;
    const unpinned = { ...policy, expectedImplementation: null };
    const mainnet = chainPreflightReport({
      collected: collected(readings),
      policy: unpinned,
    });
    expect(mainnet.failures).toBe(2);
    const testnet = chainPreflightReport({
      collected: collected({ ...readings, chainReference: 97 }),
      policy: unpinned,
    });
    expect(testnet.failures).toBe(0);
    expect(testnet.warnings).toBe(2);
  });

  it("fails a mismatched implementation, Factory USD1, and fee controller", () => {
    const report = chainPreflightReport({
      collected: collected({
        usd1: { address: usd1, paused: false, implementation: guardAddress(9) },
        factoryUsd1: [
          { factory: guardAddress(0xfac), usd1: guardAddress(0xbad) },
        ],
        poolManagers: [
          {
            address: guardAddress(0x28e2),
            protocolFeeController: guardAddress(7),
          },
        ],
      }),
      policy,
    });
    expect(
      report.rows
        .filter((row) => row.status === "fail")
        .map((row) => row.check),
    ).toEqual([
      "usd1.implementation",
      "factory.usd1",
      "poolManager.protocolFeeController",
    ]);
  });
});
