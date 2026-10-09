import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { loadConfig, type AppConfig } from "../src/config.js";
import { createPostgresChainRegistryRepository } from "../src/database/chain-registry-repository.js";
import {
  createAssetRegistryService,
  type AssetResource,
} from "../src/features/chain/asset-registry-service.js";
import { bscChainId } from "../src/features/chain/chain-contract.js";
import { createBscReadClient } from "../src/integrations/bsc/rpc-client.js";

/**
 * Dev-only operator path that registers one BSC ERC-20 asset
 * (Decision 0033).
 *
 * `symbol`, `name`, and `decimals` are always read from the token contract
 * itself; the operator supplies only an address. A row becomes `verified`
 * exclusively when the address matches the configured, independently verified
 * USD1 slot and `--verified` is passed. Everything else stays `pending`.
 *
 * Usage: `pnpm asset:register <0xaddress> [--verified]`
 */

export type AssetRegisterErrorCode =
  | "asset_register_arguments_invalid"
  | "asset_register_chain_unconfigured"
  | "asset_register_database_unconfigured"
  | "asset_register_failed";

const anyCaseAddressPattern = /^0x[0-9a-fA-F]{40}$/;

interface OutputWriter {
  readonly write: (contents: string) => unknown;
}

export class AssetRegisterError extends Error {
  constructor(readonly code: AssetRegisterErrorCode) {
    super("Asset registration failed");
    this.name = "AssetRegisterError";
  }
}

export interface AssetRegisterRequest {
  readonly address: string;
  readonly expectVerified: boolean;
  readonly config: AppConfig;
}

export function parseAssetRegisterRequest(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
): AssetRegisterRequest {
  const positional = argv.slice(2);
  const address = positional[0];
  const flags = positional.slice(1);
  if (
    address === undefined ||
    !anyCaseAddressPattern.test(address) ||
    flags.some((flag) => flag !== "--verified")
  ) {
    throw new AssetRegisterError("asset_register_arguments_invalid");
  }

  let config: AppConfig;
  try {
    config = loadConfig(environment);
  } catch {
    throw new AssetRegisterError("asset_register_database_unconfigured");
  }
  if (config.bscChain === null) {
    throw new AssetRegisterError("asset_register_chain_unconfigured");
  }

  return Object.freeze({
    address,
    expectVerified: flags.includes("--verified"),
    config,
  });
}

export async function registerAsset(
  request: AssetRegisterRequest,
): Promise<AssetResource> {
  const chainConfig = request.config.bscChain;
  if (chainConfig === null) {
    throw new AssetRegisterError("asset_register_chain_unconfigured");
  }
  const pool = new pg.Pool({
    application_name: "loop-api-asset-register",
    connectionString: request.config.databaseUrl,
    max: 1,
  });
  try {
    const service = createAssetRegistryService({
      repository: createPostgresChainRegistryRepository(pool),
      readClient: createBscReadClient({ config: chainConfig }),
      chainId: bscChainId,
      verifiedUsd1Address: chainConfig.usd1TokenAddress,
    });
    return await service.registerFromChain({
      address: request.address,
      expectVerified: request.expectVerified,
    });
  } finally {
    await pool.end();
  }
}

export async function runAssetRegister(options: {
  readonly argv: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly stdout: OutputWriter;
  readonly stderr: OutputWriter;
  readonly register?: (request: AssetRegisterRequest) => Promise<AssetResource>;
}): Promise<0 | 1> {
  let request: AssetRegisterRequest;
  try {
    request = parseAssetRegisterRequest(options.argv, options.environment);
  } catch (error) {
    const code =
      error instanceof AssetRegisterError
        ? error.code
        : "asset_register_failed";
    options.stderr.write(`Asset registration refused (${code})\n`);
    return 1;
  }

  try {
    const register = options.register ?? registerAsset;
    const resource = await register(request);
    options.stdout.write(
      `Registered ${resource.asset.assetId} symbol=${resource.asset.symbol} decimals=${String(resource.asset.decimals)} status=${resource.asset.status} block=${resource.asset.source.blockNumber ?? "unknown"}\n`,
    );
    return 0;
  } catch {
    options.stderr.write("Asset registration failed (asset_register_failed)\n");
    return 1;
  }
}

const directEntryPoint = process.argv[1];

if (
  directEntryPoint !== undefined &&
  resolve(directEntryPoint) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runAssetRegister({
    argv: process.argv,
    environment: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
