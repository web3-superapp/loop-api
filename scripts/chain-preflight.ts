import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import {
  ConfigurationError,
  parseChainGuardConfig,
  parseLaunchChainIdEnvironment,
  parseLaunchSlotRpcUrls,
} from "../src/config.js";
import { createPostgresChainGuardRepository } from "../src/database/chain-guard-repository.js";
import { bscChainId } from "../src/features/chain/chain-contract.js";
import type { ChainGuardInstanceRecord } from "../src/features/chain-guard/chain-guard-contract.js";
import {
  ChainGuardUsd1NotConfiguredError,
  collectChainGuardSnapshot,
  type ChainGuardChain,
} from "../src/features/chain-guard/chain-guard-collect.js";
import {
  chainPreflightReport,
  formatChainPreflightReport,
} from "../src/features/chain-guard/chain-guard-preflight.js";
import { createChainGuardChain } from "../src/integrations/chain-guard/chain-guard-chain.js";
import {
  chainGuardSignerAccounts,
  chainGuardTargets,
} from "../src/integrations/chain-guard/chain-guard-targets.js";

/**
 * Decision 0134: `pnpm chain:preflight [--dry] [--json] [--no-database]`.
 *
 * Reads, never signs: USD1 `paused()`, the EIP-1967 implementation and
 * ProxyAdmin, `frozen()` of every address we depend on (registered launch2
 * instances from DATABASE_URL, the Factories' PoolManager / tax receivers /
 * routers / keepers, LAUNCH2_POOL_ROUTER_ADDRESS, CHAIN_GUARD_WATCH_ADDRESSES,
 * the configured signer accounts), the PoolManager's protocol fee
 * controller and each graduated pool's protocol fee, and the signer
 * accounts' BNB balance. Exit 0 = every check passed; 1 = at least one
 * check failed; 2 = it could not run (configuration / RPC / database).
 * `--dry` prints the same table and exits 0 unless it could not run.
 */

interface OutputWriter {
  readonly write: (contents: string) => unknown;
}

export interface RunChainPreflightOptions {
  readonly argv: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly stdout: OutputWriter;
  readonly stderr: OutputWriter;
  /** Test seams. */
  readonly createChain?: (input: {
    readonly rpcUrls: readonly string[];
    readonly chainReference: number;
  }) => ChainGuardChain;
  readonly listInstances?: (
    chainId: string,
  ) => Promise<readonly ChainGuardInstanceRecord[]>;
}

const flags = new Set(["--dry", "--json", "--no-database"]);

export async function runChainPreflight(
  options: RunChainPreflightOptions,
): Promise<number> {
  const args = options.argv.slice(2);
  const unknown = args.filter((arg) => !flags.has(arg));
  if (unknown.length > 0) {
    options.stderr.write(
      "Usage: pnpm chain:preflight [--dry] [--json] [--no-database]\n",
    );
    return 2;
  }
  const dry = args.includes("--dry");
  const json = args.includes("--json");
  const useDatabase = !args.includes("--no-database");
  const environment = options.environment;

  let pool: pg.Pool | null = null;
  try {
    const config = parseChainGuardConfig(environment);
    const chainId = parseLaunchChainIdEnvironment(
      environment["LAUNCH_CHAIN_ID"],
    );
    const chainReference = chainId === bscChainId ? 56 : 97;
    const rpcUrls = parseLaunchSlotRpcUrls(environment);
    if (rpcUrls.length === 0 && options.createChain === undefined) {
      options.stderr.write(
        `chain:preflight cannot run: no RPC endpoint for ${chainId} (${chainReference === 56 ? "BSC_RPC_URLS" : "LAUNCH_BSC_RPC_URLS"})\n`,
      );
      return 2;
    }
    const chain = (options.createChain ?? createChainGuardChain)({
      rpcUrls,
      chainReference,
    });
    const observedChain = await chain.chainId();
    if (observedChain !== chainReference) {
      options.stderr.write(
        `chain:preflight cannot run: the endpoint is on chain ${observedChain}, LAUNCH_CHAIN_ID is ${chainReference}\n`,
      );
      return 2;
    }

    let instances: readonly ChainGuardInstanceRecord[] = [];
    const databaseUrl = environment["DATABASE_URL"]?.trim() ?? "";
    if (options.listInstances !== undefined) {
      instances = await options.listInstances(chainId);
    } else if (useDatabase && databaseUrl !== "") {
      pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
      instances =
        await createPostgresChainGuardRepository(pool).listWatchInstances(
          chainId,
        );
    } else if (useDatabase) {
      options.stderr.write(
        "chain:preflight: DATABASE_URL is not set; registered launch2 instances are not checked (pass --no-database to silence)\n",
      );
    }

    const signers = chainGuardSignerAccounts([
      {
        label: "hooksLaunchExecutor",
        privateKey: environment["HOOKS_LAUNCH_EXECUTOR_PRIVATE_KEY"],
      },
      {
        label: "launch2BuybackKeeper",
        privateKey: environment["LAUNCH2_BUYBACK_KEEPER_PRIVATE_KEY"],
      },
      {
        label: "launch2SnapshotSubmitter",
        privateKey:
          environment["LAUNCH2_SNAPSHOT_SUBMITTER_PRIVATE_KEY"] ??
          environment["HOOKS_LAUNCH_EXECUTOR_PRIVATE_KEY"],
      },
      {
        label: "launch2DynamicPoke",
        privateKey: environment["LAUNCH2_DYNAMIC_POKE_PRIVATE_KEY"],
      },
    ]);
    const policy = {
      expectedImplementation: config.expectedImplementation,
      expectedProtocolFeeController: config.expectedProtocolFeeController,
      protocolFeeAlertPips: config.protocolFeeAlertPips,
      minBnbWei: config.minBnbWei,
    };
    const collected = await collectChainGuardSnapshot({
      chain,
      targets: chainGuardTargets({ config, chainId, chainReference, signers }),
      instances,
    });
    const report = chainPreflightReport({ collected, policy });
    if (json) {
      options.stdout.write(
        `${JSON.stringify({ chainId, dry, ...report }, null, 2)}\n`,
      );
    } else {
      options.stdout.write(
        `chain:preflight ${chainId} (${instances.length} launch2 instance(s))${dry ? " — dry run" : ""}\n\n`,
      );
      options.stdout.write(formatChainPreflightReport(report));
    }
    if (report.failures > 0) {
      if (dry) {
        options.stdout.write(
          "Dry run: the checks above would fail the preflight.\n",
        );
        return 0;
      }
      return 1;
    }
    return 0;
  } catch (error) {
    if (error instanceof ConfigurationError) {
      options.stderr.write(
        `chain:preflight configuration refused: ${error.issues.join("; ")}\n`,
      );
    } else if (error instanceof ChainGuardUsd1NotConfiguredError) {
      options.stderr.write(
        "chain:preflight cannot run: set CHAIN_GUARD_USD1_ADDRESS (or a Factory address to read usd1() from)\n",
      );
    } else {
      options.stderr.write(
        `chain:preflight cannot run: ${error instanceof Error ? error.name : "UnknownError"}\n`,
      );
    }
    return 2;
  } finally {
    await pool?.end();
  }
}

const directEntryPoint = process.argv[1];

if (
  directEntryPoint !== undefined &&
  resolve(directEntryPoint) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runChainPreflight({
    argv: process.argv,
    environment: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
