import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { loadConfig, type AppConfig } from "../src/config.js";
import { createPostgresChainRegistryRepository } from "../src/database/chain-registry-repository.js";
import { createPostgresLaunchChainRepository } from "../src/database/launch-chain-repository.js";
import { createPostgresLaunchRepository } from "../src/database/launch-repository.js";
import { createAssetRegistryService } from "../src/features/chain/asset-registry-service.js";
import {
  LaunchSaleRegistrationError,
  type LaunchChainRepository,
} from "../src/features/launch/launch-chain-repository.js";
import type {
  LaunchDetailRecord,
  LaunchRepository,
} from "../src/features/launch/launch-repository.js";
import {
  createBscReadClient,
  createUnavailableBscReadClient,
  type BscReadClient,
} from "../src/integrations/bsc/rpc-client.js";
import {
  LaunchContractUnavailableError,
  createLaunchContractAdapter,
  isZeroBytes32,
  type LaunchContractConfig,
} from "../src/integrations/launch/launch-contract-adapter.js";

/**
 * Operator path that registers a LoopLaunchpad `saleId` on a LOOP launch
 * (Decision 0076 ruling 7, Decision 0077):
 *
 *   pnpm launch:register-sale --launch <launchId> --sale-id <n> [--confirm] [--rescan]
 *
 * It reads `getState` and `getSaleConfig` on the launch chain first and
 * refuses when the sale does not exist, settles in another token than
 * LAUNCH_USD1_ADDRESS, or sells another token than the confirmed
 * configuration's `projectTokenAddress`. Without `--confirm` it only prints
 * what it would write (a dry run). With `--confirm` it registers both tokens
 * in the Asset Registry of the launch chain (identity read from the token
 * contracts, status pending), writes `launches.sale_id` / contract /
 * version / expected configVersion / asset pair, and appends a
 * `sale_registered` audit row. Under NODE_ENV=production it refuses to run
 * without `--confirm`. `--rescan` additionally drops the `launch_event`
 * checkpoint so the lane re-reads from LAUNCH_CONTRACT_START_BLOCK (events
 * of a sale registered late were skipped as LAUNCH_SALE_UNREGISTERED).
 */

export type LaunchRegisterSaleErrorCode =
  | "launch_register_sale_arguments_invalid"
  | "launch_register_sale_configuration_invalid"
  | "launch_register_sale_contract_unconfigured"
  | "launch_register_sale_production_requires_confirm"
  | "launch_register_sale_failed";

const opaqueIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const saleIdPattern = /^[1-9][0-9]{0,18}$/;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;

export class LaunchRegisterSaleError extends Error {
  constructor(readonly code: LaunchRegisterSaleErrorCode) {
    super("Launch sale registration refused");
    this.name = "LaunchRegisterSaleError";
  }
}

export interface LaunchRegisterSaleRequest {
  readonly launchId: string;
  readonly saleId: string;
  readonly confirm: boolean;
  readonly rescan: boolean;
}

export function parseLaunchRegisterSaleArguments(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
): LaunchRegisterSaleRequest {
  const args = argv.slice(2);
  let launchId: string | undefined;
  let saleId: string | undefined;
  let confirm = false;
  let rescan = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--launch") {
      launchId = args[(index += 1)];
    } else if (arg === "--sale-id") {
      saleId = args[(index += 1)];
    } else if (arg === "--confirm") {
      confirm = true;
    } else if (arg === "--rescan") {
      rescan = true;
    } else {
      throw new LaunchRegisterSaleError(
        "launch_register_sale_arguments_invalid",
      );
    }
  }
  if (
    launchId === undefined ||
    !opaqueIdPattern.test(launchId) ||
    saleId === undefined ||
    !saleIdPattern.test(saleId) ||
    (rescan && !confirm)
  ) {
    throw new LaunchRegisterSaleError("launch_register_sale_arguments_invalid");
  }
  if (environment["NODE_ENV"]?.trim() === "production" && !confirm) {
    throw new LaunchRegisterSaleError(
      "launch_register_sale_production_requires_confirm",
    );
  }
  return Object.freeze({ launchId, saleId, confirm, rescan });
}

/** What the chain says about the sale, at one block. */
export interface ObservedSale {
  readonly configVersion: string;
  readonly usd1: string;
  readonly projectToken: string;
  readonly blockNumber: string;
}

export interface LaunchRegisterSaleDependencies {
  readonly contract: LaunchContractConfig;
  readonly chainId: string;
  readonly launches: Pick<LaunchRepository, "getLaunch">;
  readonly chain: Pick<
    LaunchChainRepository,
    "registerSale" | "resetCheckpoint"
  >;
  /** Throws LaunchContractUnavailableError when the chain cannot answer. */
  readonly readSale: (saleId: bigint) => Promise<ObservedSale>;
  /** Registers both tokens in the launch chain's Asset Registry. */
  readonly registerAssets: (addresses: readonly string[]) => Promise<void>;
}

export interface LaunchRegisterSaleOutcome {
  readonly written: boolean;
  readonly observed: ObservedSale;
  readonly rescanned: boolean;
}

function projectTokenRecord(detail: LaunchDetailRecord): string | null {
  const confirmed = detail.configs.find(
    (config) => config.status === "confirmed",
  );
  const value = confirmed?.parameters["projectTokenAddress"];
  return typeof value === "string" && addressPattern.test(value)
    ? value.toLowerCase()
    : null;
}

/**
 * The registration itself. Every refusal is a `LaunchSaleRegistrationError`
 * with a stable reason code; nothing is written before every check passed.
 */
export async function registerLaunchSale(
  request: LaunchRegisterSaleRequest,
  deps: LaunchRegisterSaleDependencies,
): Promise<LaunchRegisterSaleOutcome> {
  const detail = await deps.launches.getLaunch(request.launchId);
  if (detail === null) {
    throw new LaunchSaleRegistrationError("LAUNCH_NOT_FOUND");
  }
  if (detail.launch.chainId !== deps.chainId) {
    throw new LaunchSaleRegistrationError("LAUNCH_CHAIN_MISMATCH");
  }
  if (detail.launch.saleId !== null) {
    throw new LaunchSaleRegistrationError(
      detail.launch.saleId === request.saleId
        ? "LAUNCH_SALE_ALREADY_REGISTERED"
        : "LAUNCH_SALE_REGISTERED_DIFFERENTLY",
    );
  }
  const recordedToken = projectTokenRecord(detail);
  if (recordedToken === null) {
    throw new LaunchSaleRegistrationError("LAUNCH_PROJECT_TOKEN_UNRECORDED");
  }
  let observed: ObservedSale;
  try {
    observed = await deps.readSale(BigInt(request.saleId));
  } catch (error) {
    if (error instanceof LaunchContractUnavailableError) {
      throw new LaunchSaleRegistrationError(error.reasonCode);
    }
    throw error;
  }
  if (isZeroBytes32(observed.configVersion)) {
    throw new LaunchSaleRegistrationError("LAUNCH_SALE_NOT_FOUND");
  }
  if (observed.usd1 !== deps.contract.usd1Address) {
    throw new LaunchSaleRegistrationError("LAUNCH_USD1_ADDRESS_MISMATCH");
  }
  if (observed.projectToken !== recordedToken) {
    throw new LaunchSaleRegistrationError("LAUNCH_PROJECT_TOKEN_MISMATCH");
  }
  if (!request.confirm) {
    return Object.freeze({ written: false, observed, rescanned: false });
  }
  await deps.registerAssets([observed.usd1, observed.projectToken]);
  await deps.chain.registerSale({
    launchId: request.launchId,
    saleId: request.saleId,
    contractAddress: deps.contract.address,
    contractVersion: deps.contract.version,
    configVersionOnchain: observed.configVersion,
    quoteTokenAddress: observed.usd1,
    projectTokenAddress: observed.projectToken,
    requestId: randomUUID(),
  });
  const rescanned = request.rescan
    ? await deps.chain.resetCheckpoint(detail.launch.chainId)
    : false;
  return Object.freeze({ written: true, observed, rescanned });
}

function launchReadClient(config: AppConfig): BscReadClient {
  const slot = config.launchChain;
  if (slot.rpcUrls.length === 0) {
    return createUnavailableBscReadClient({
      chainId: slot.chainId,
      chainReference: slot.chainReference,
      reasonCode: "LAUNCH_CHAIN_RPC_NOT_CONFIGURED",
    });
  }
  return createBscReadClient({ config: slot });
}

async function defaultRun(
  request: LaunchRegisterSaleRequest,
  config: AppConfig,
): Promise<LaunchRegisterSaleOutcome> {
  const contract = config.launchContract;
  if (contract === null) {
    throw new LaunchRegisterSaleError(
      "launch_register_sale_contract_unconfigured",
    );
  }
  const pool = new pg.Pool({
    application_name: "loop-api-launch-register-sale",
    connectionString: config.databaseUrl,
    max: 1,
  });
  try {
    const readClient = launchReadClient(config);
    const adapter = createLaunchContractAdapter({
      contract,
      chain: config.launchChain,
      verifyChain: () => readClient.verifyChain(),
    });
    const assets = createAssetRegistryService({
      repository: createPostgresChainRegistryRepository(pool),
      readClient,
      chainId: config.launchChain.chainId,
      verifiedUsd1Address: null,
    });
    return await registerLaunchSale(request, {
      contract,
      chainId: config.launchChain.chainId,
      launches: createPostgresLaunchRepository(pool, {
        launchChainId: config.launchChain.chainId,
      }),
      chain: createPostgresLaunchChainRepository(pool),
      readSale: async (saleId) => {
        const snapshot = await adapter.takeSnapshot();
        const [state, saleConfig] = await Promise.all([
          adapter.getState(saleId, snapshot),
          adapter.getSaleConfig(saleId, snapshot),
        ]);
        await adapter.confirmSnapshot(snapshot);
        if (state.value.configVersion !== saleConfig.value.configVersion) {
          throw new LaunchSaleRegistrationError(
            "LAUNCH_CONFIG_VERSION_MISMATCH",
          );
        }
        return Object.freeze({
          configVersion: saleConfig.value.configVersion,
          usd1: saleConfig.value.usd1,
          projectToken: saleConfig.value.projectToken,
          blockNumber: snapshot.blockNumber.toString(10),
        });
      },
      registerAssets: async (addresses) => {
        for (const address of addresses) {
          await assets.registerFromChain({ address, expectVerified: false });
        }
      },
    });
  } finally {
    await pool.end();
  }
}

interface OutputWriter {
  readonly write: (contents: string) => unknown;
}

export async function runLaunchRegisterSale(options: {
  readonly argv: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly stdout: OutputWriter;
  readonly stderr: OutputWriter;
  readonly run?: (
    request: LaunchRegisterSaleRequest,
    config: AppConfig,
  ) => Promise<LaunchRegisterSaleOutcome>;
}): Promise<0 | 1> {
  let request: LaunchRegisterSaleRequest;
  let config: AppConfig;
  try {
    request = parseLaunchRegisterSaleArguments(
      options.argv,
      options.environment,
    );
    try {
      config = loadConfig(options.environment);
    } catch {
      throw new LaunchRegisterSaleError(
        "launch_register_sale_configuration_invalid",
      );
    }
  } catch (error) {
    const code =
      error instanceof LaunchRegisterSaleError
        ? error.code
        : "launch_register_sale_failed";
    options.stderr.write(`Launch sale registration refused (${code})\n`);
    return 1;
  }
  try {
    const outcome = await (options.run ?? defaultRun)(request, config);
    options.stdout.write(
      `${outcome.written ? "Registered" : "Dry run (add --confirm to write):"} sale ${request.saleId} on launch ${request.launchId}` +
        ` configVersion=${outcome.observed.configVersion} block=${outcome.observed.blockNumber}` +
        (outcome.rescanned ? " launch_event checkpoint reset" : "") +
        "\n",
    );
    return 0;
  } catch (error) {
    const code =
      error instanceof LaunchSaleRegistrationError ||
      error instanceof LaunchContractUnavailableError
        ? error.reasonCode
        : error instanceof LaunchRegisterSaleError
          ? error.code
          : "launch_register_sale_failed";
    options.stderr.write(`Launch sale registration refused (${code})\n`);
    return 1;
  }
}

const directEntryPoint = process.argv[1];

if (
  directEntryPoint !== undefined &&
  resolve(directEntryPoint) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runLaunchRegisterSale({
    argv: process.argv,
    environment: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
