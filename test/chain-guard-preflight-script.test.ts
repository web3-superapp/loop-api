import { custom, encodeFunctionResult, parseAbi } from "viem";
import { describe, expect, it } from "vitest";

import { runChainPreflight } from "../scripts/chain-preflight.js";
import { createChainGuardChain } from "../src/integrations/chain-guard/chain-guard-chain.js";
import {
  createFakeChainGuardChain,
  factory,
  guardAddress,
  instanceRecord,
} from "./helpers/chain-guard-fakes.js";

/** Decision 0134: `pnpm chain:preflight` exit codes and the viem reader. */

function writer() {
  let text = "";
  return {
    write: (chunk: string) => {
      text += chunk;
      return true;
    },
    get text() {
      return text;
    },
  };
}

const baseEnvironment = {
  LAUNCH_CHAIN_ID: "97",
  LAUNCH_BSC_RPC_URLS: "https://bsc-testnet.example.invalid",
  HOOKS_LAUNCH_FACTORY_ADDRESS: factory,
  CHAIN_GUARD_USD1_IMPLEMENTATION: guardAddress(0x1111),
};

async function run(
  argv: string[],
  chainOverrides: Parameters<typeof createFakeChainGuardChain>[0] = {},
  environment: Record<string, string> = baseEnvironment,
) {
  const stdout = writer();
  const stderr = writer();
  const chain = createFakeChainGuardChain(chainOverrides);
  const code = await runChainPreflight({
    argv: ["node", "chain-preflight.ts", ...argv],
    environment,
    stdout,
    stderr,
    createChain: () => chain,
    listInstances: () => Promise.resolve([instanceRecord(1)]),
  });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

describe("pnpm chain:preflight (Decision 0134)", () => {
  it("exits 0 when every check passes", async () => {
    const result = await run([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "chain:preflight eip155:97 (1 launch2 instance(s))",
    );
    expect(result.stdout).toMatch(/0 failed, 1 warning\(s\)/u);
  });

  it("exits 1 when a check fails, 0 with --dry", async () => {
    const paused = await run([], { paused: true });
    expect(paused.code).toBe(1);
    expect(paused.stdout).toMatch(/FAIL {2}usd1\.paused/u);
    const dry = await run(["--dry"], { paused: true });
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("Dry run: the checks above would fail");
  });

  it("runs on the testnet mock token (unsupported reads warn)", async () => {
    const result = await run([], {
      paused: null,
      frozenSupported: false,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("unsupported");
  });

  it("prints JSON with --json", async () => {
    const result = await run(["--json"], {
      balances: new Map([[guardAddress(0xbee1), 0n]]),
    });
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout) as {
      chainId: string;
      failures: number;
      rows: { check: string; status: string }[];
    };
    expect(report.chainId).toBe("eip155:97");
    expect(report.failures).toBe(1);
    expect(report.rows.find((row) => row.status === "fail")?.check).toBe(
      "account.bnb",
    );
  });

  it("exits 2 when it cannot run", async () => {
    expect((await run(["--bogus"])).code).toBe(2);
    const wrongChain = await run([], { chainId: 56 });
    expect(wrongChain.code).toBe(2);
    expect(wrongChain.stderr).toContain("the endpoint is on chain 56");
    const badConfig = await run(
      [],
      {},
      { ...baseEnvironment, CHAIN_GUARD_MIN_BNB: "x" },
    );
    expect(badConfig.code).toBe(2);
    expect(badConfig.stderr).toContain("CHAIN_GUARD_MIN_BNB");
    const noUsd1 = await run(
      [],
      { factory: null },
      {
        LAUNCH_CHAIN_ID: "97",
        LAUNCH_BSC_RPC_URLS: "https://x.example.invalid",
      },
    );
    expect(noUsd1.code).toBe(2);
    expect(noUsd1.stderr).toContain("CHAIN_GUARD_USD1_ADDRESS");
  });
});

describe("chain guard viem reader (Decision 0134)", () => {
  const usd1Abi = parseAbi([
    "function paused() view returns (bool)",
    "function frozen(address) view returns (bool)",
  ]);
  const pausedSelector = "0x5c975abb";

  function transport(options: { readonly pausedImplemented: boolean }) {
    return custom({
      request: ({ method, params }: { method: string; params: unknown }) => {
        if (method === "eth_chainId") return Promise.resolve("0x61");
        if (method === "eth_getStorageAt") {
          const [, slot] = params as [string, string];
          return Promise.resolve(
            slot.startsWith("0x3608")
              ? `0x${"0".repeat(24)}694aa534bdef8ed63244eb902e7914e527891f08`
              : `0x${"0".repeat(64)}`,
          );
        }
        if (method === "eth_call") {
          const [call] = params as [{ data: string }];
          if (call.data.startsWith(pausedSelector)) {
            return Promise.resolve(
              options.pausedImplemented
                ? encodeFunctionResult({
                    abi: usd1Abi,
                    functionName: "paused",
                    result: true,
                  })
                : "0x",
            );
          }
          return Promise.resolve("0x");
        }
        return Promise.reject(new Error(`unexpected ${method}`));
      },
    });
  }

  it("reads paused / implementation / admin, and a missing paused() is null", async () => {
    const implemented = createChainGuardChain({
      rpcUrls: [],
      chainReference: 97,
      transport: transport({ pausedImplemented: true }),
    });
    expect(await implemented.readUsd1(guardAddress(0x05d1))).toEqual({
      paused: true,
      implementation: "0x694aa534bdef8ed63244eb902e7914e527891f08",
      proxyAdmin: null,
    });
    const mock = createChainGuardChain({
      rpcUrls: [],
      chainReference: 97,
      transport: transport({ pausedImplemented: false }),
    });
    expect((await mock.readUsd1(guardAddress(0x05d1))).paused).toBeNull();
    expect(
      await mock.readFrozen(guardAddress(0x05d1), [guardAddress(1)]),
    ).toEqual(new Map([[guardAddress(1), null]]));
  });

  it("a transport failure is an error, not 'unsupported'", async () => {
    const failing = createChainGuardChain({
      rpcUrls: [],
      chainReference: 97,
      transport: custom({
        request: () => Promise.reject(new Error("socket hang up")),
      }),
    });
    await expect(failing.readUsd1(guardAddress(0x05d1))).rejects.toThrow();
  });

  it("refuses to start without an endpoint", () => {
    expect(() =>
      createChainGuardChain({ rpcUrls: [], chainReference: 56 }),
    ).toThrow("CHAIN_GUARD_CHAIN_NOT_CONFIGURED");
  });
});
