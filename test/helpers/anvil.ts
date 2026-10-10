import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { mnemonicToAccount } from "viem/accounts";
import { toHex } from "viem";

/**
 * Decision 0112 test harness: a local `anvil --chain-id 97` plus the
 * loop-contracts Foundry scripts (`DeployBscTestnetBase`,
 * `DeployLoopFactoryBscTestnet`). Everything Foundry writes (out, cache,
 * broadcast) goes to a temp directory, never into loop-contracts. When
 * anvil, forge, or the protocol package is missing, `foundrySkipReason()`
 * says why and the suite skips.
 */

const anvilMnemonic =
  "test test test test test test test test test test test junk";

export interface FoundryTools {
  readonly anvil: string;
  readonly forge: string;
  readonly protocolDir: string;
}

function which(binary: string): string | null {
  const candidates = [
    ...(process.env["PATH"] ?? "")
      .split(path.delimiter)
      .filter((entry) => entry !== "")
      .map((entry) => path.join(entry, binary)),
    path.join(homedir(), ".foundry", "bin", binary),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function locateFoundry(): FoundryTools | string {
  const anvil = which("anvil");
  const forge = which("forge");
  if (anvil === null || forge === null) {
    return "anvil/forge not installed (https://getfoundry.sh); the Hooks executor chain suite needs a local anvil";
  }
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const explicit = process.env["LOOP_PROTOCOL_DIR"];
  const candidates =
    explicit === undefined
      ? [
          path.resolve(repositoryRoot, "../loop-contracts/protocol"),
          path.resolve(repositoryRoot, "../../loop-contracts/protocol"),
        ]
      : [path.resolve(explicit)];
  const protocolDir = candidates.find((candidate) =>
    existsSync(path.join(candidate, "foundry.toml")),
  );
  if (protocolDir === undefined) {
    return `loop-contracts/protocol not found (tried ${candidates.join(", ")}; set LOOP_PROTOCOL_DIR)`;
  }
  return { anvil, forge, protocolDir };
}

export function anvilAccount(index: number) {
  return mnemonicToAccount(anvilMnemonic, { addressIndex: index });
}

export function anvilPrivateKey(index: number): `0x${string}` {
  const key = anvilAccount(index).getHdKey().privateKey;
  if (key === null) throw new Error("anvil key derivation failed");
  return toHex(key);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address !== null) {
          resolve(address.port);
        } else {
          reject(new Error("no free port"));
        }
      });
    });
  });
}

export interface AnvilChain {
  readonly rpcUrl: string;
  request<T = unknown>(method: string, params?: readonly unknown[]): Promise<T>;
  mine(blocks: number): Promise<void>;
  stop(): Promise<void>;
}

export async function startAnvil(tools: FoundryTools): Promise<AnvilChain> {
  const port = await freePort();
  const child: ChildProcess = spawn(
    tools.anvil,
    [
      "--chain-id",
      "97",
      "--port",
      String(port),
      "--accounts",
      "15",
      "--gas-limit",
      "60000000",
      "--silent",
    ],
    { stdio: "ignore" },
  );
  const rpcUrl = `http://127.0.0.1:${port}`;
  let nextId = 1;
  async function request<T>(
    method: string,
    params: readonly unknown[] = [],
  ): Promise<T> {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    });
    const body = (await response.json()) as {
      readonly result?: T;
      readonly error?: { readonly message: string };
    };
    if (body.error !== undefined) throw new Error(body.error.message);
    return body.result as T;
  }
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      await request("eth_chainId");
      break;
    } catch (error) {
      if (Date.now() > deadline) {
        child.kill("SIGKILL");
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return {
    rpcUrl,
    request,
    async mine(blocks: number) {
      await request("anvil_mine", [toHex(blocks)]);
    },
    async stop() {
      if (child.exitCode !== null) return;
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
        setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 3_000).unref();
      });
    },
  };
}

function forgeScript(
  tools: FoundryTools,
  script: string,
  rpcUrl: string,
  environment: Readonly<Record<string, string>>,
): string {
  const work = path.join(tmpdir(), "loop-hooks-executor-forge");
  mkdirSync(work, { recursive: true });
  const result = spawnSync(
    tools.forge,
    ["script", script, "--rpc-url", rpcUrl, "--broadcast"],
    {
      cwd: tools.protocolDir,
      encoding: "utf8",
      timeout: 900_000,
      env: {
        ...process.env,
        FOUNDRY_OUT: path.join(work, "out"),
        FOUNDRY_CACHE_PATH: path.join(work, "cache"),
        FOUNDRY_BROADCAST: path.join(work, "broadcast"),
        NO_COLOR: "1",
        ...environment,
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `forge script ${script} failed: ${(result.stderr || result.stdout).slice(-2_000)}`,
    );
  }
  return result.stdout;
}

function logged(output: string, label: string): `0x${string}` {
  const match = new RegExp(`${label}\\s*(0x[0-9a-fA-F]{40})`, "u").exec(output);
  if (match?.[1] === undefined) {
    throw new Error(`forge output has no ${label}`);
  }
  return match[1].toLowerCase() as `0x${string}`;
}

export interface DeployedProtocol {
  readonly poolManager: `0x${string}`;
  readonly usd1: `0x${string}`;
  readonly factory: `0x${string}`;
  readonly roles: Readonly<Record<string, `0x${string}`>>;
  /** Private key of the Factory's deployment executor (anvil account 2). */
  readonly executorKey: `0x${string}`;
}

/**
 * Deploys PoolManager + tUSD1 and the Factory with the anvil default
 * accounts as roles: 0 deployer, 1 admin, 2 executor, 3 tax receiver,
 * 4 fee vault, 5/6 keepers, 7/8 pause/resume, 9-11 snapshot signers.
 */
export function deployProtocol(
  tools: FoundryTools,
  rpcUrl: string,
  options: {
    /**
     * Decision 0119: `LOOP_NFT_SALE_DURATION_SECONDS` for the Factory
     * script (3,600..604,800). Always set explicitly so an ambient env
     * value never changes a suite; default the 7-day mainnet period.
     */
    readonly nftSaleDurationSeconds?: number;
  } = {},
): DeployedProtocol {
  const address = (index: number) =>
    anvilAccount(index).address.toLowerCase() as `0x${string}`;
  const deployerKey = anvilPrivateKey(0);
  const base = forgeScript(
    tools,
    "script/DeployBscTestnetBase.s.sol:DeployBscTestnetBase",
    rpcUrl,
    { BSC_TESTNET_DEPLOYER_PRIVATE_KEY: deployerKey },
  );
  const poolManager = logged(base, "PoolManager candidate:");
  const usd1 = logged(base, "TestnetUSD1 candidate:");
  const roles = {
    LOOP_FACTORY_ADMIN: address(1),
    LOOP_FACTORY_EXECUTOR: address(2),
    LOOP_PLATFORM_TAX_RECEIVER: address(3),
    LOOP_FEE_VAULT: address(4),
    LOOP_PRIMARY_KEEPER: address(5),
    LOOP_FALLBACK_KEEPER: address(6),
    LOOP_BUYBACK_PAUSE_AUTHORITY: address(7),
    LOOP_BUYBACK_RESUME_AUTHORITY: address(8),
    LOOP_SNAPSHOT_SIGNER_0: address(9),
    LOOP_SNAPSHOT_SIGNER_1: address(10),
    LOOP_SNAPSHOT_SIGNER_2: address(11),
  } as const;
  const factoryOutput = forgeScript(
    tools,
    "script/DeployLoopFactoryBscTestnet.s.sol:DeployLoopFactoryBscTestnet",
    rpcUrl,
    {
      BSC_TESTNET_DEPLOYER_PRIVATE_KEY: deployerKey,
      BSC_TESTNET_EXPECTED_DEPLOYER: address(0),
      LOOP_TESTNET_POOL_MANAGER: poolManager,
      LOOP_TESTNET_USD1: usd1,
      LOOP_NFT_SALE_DURATION_SECONDS: String(
        options.nftSaleDurationSeconds ?? 604_800,
      ),
      ...roles,
      ...(options.nftSaleDurationSeconds === undefined
        ? {}
        : {
            LOOP_NFT_SALE_DURATION_SECONDS: String(
              options.nftSaleDurationSeconds,
            ),
          }),
    },
  );
  return {
    poolManager,
    usd1,
    factory: logged(factoryOutput, "launch factory candidate:"),
    roles,
    executorKey: anvilPrivateKey(2),
  };
}
