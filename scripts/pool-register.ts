import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { loadConfig, type AppConfig } from "../src/config.js";
import {
  createPostgresChainRegistryRepository,
  type PoolRecord,
} from "../src/database/chain-registry-repository.js";
import {
  assetIdForAddress,
  bscChainId,
  normalizeEvmAddress,
} from "../src/features/chain/chain-contract.js";
import { createBscReadClient } from "../src/integrations/bsc/rpc-client.js";

/**
 * Dev-only operator path that registers one PancakeSwap V3 pool
 * (Decision 0033).
 *
 * `token0`, `token1`, `fee`, and `tickSpacing` are read from the pool contract
 * itself, and both tokens must already be readable Asset Registry rows. A pool
 * whose pair is unknown is refused rather than registered on trust, because
 * only registered pools are indexed.
 *
 * Usage: `pnpm pool:register <0xpoolAddress>`
 */

export type PoolRegisterErrorCode =
  | "pool_register_arguments_invalid"
  | "pool_register_chain_unconfigured"
  | "pool_register_database_unconfigured"
  | "pool_register_token_not_registered"
  | "pool_register_failed";

const anyCaseAddressPattern = /^0x[0-9a-fA-F]{40}$/;

interface OutputWriter {
  readonly write: (contents: string) => unknown;
}

export class PoolRegisterError extends Error {
  constructor(readonly code: PoolRegisterErrorCode) {
    super("Pool registration failed");
    this.name = "PoolRegisterError";
  }
}

export interface PoolRegisterRequest {
  readonly address: string;
  readonly config: AppConfig;
}

export function parsePoolRegisterRequest(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
): PoolRegisterRequest {
  const positional = argv.slice(2);
  const address = positional[0];
  if (
    positional.length !== 1 ||
    address === undefined ||
    !anyCaseAddressPattern.test(address)
  ) {
    throw new PoolRegisterError("pool_register_arguments_invalid");
  }

  let config: AppConfig;
  try {
    config = loadConfig(environment);
  } catch {
    throw new PoolRegisterError("pool_register_database_unconfigured");
  }
  if (config.bscChain === null) {
    throw new PoolRegisterError("pool_register_chain_unconfigured");
  }
  return Object.freeze({ address, config });
}

export async function registerPool(
  request: PoolRegisterRequest,
): Promise<PoolRecord> {
  const chainConfig = request.config.bscChain;
  if (chainConfig === null) {
    throw new PoolRegisterError("pool_register_chain_unconfigured");
  }
  const pool = new pg.Pool({
    application_name: "loop-api-pool-register",
    connectionString: request.config.databaseUrl,
    max: 1,
  });
  try {
    const repository = createPostgresChainRegistryRepository(pool);
    const readClient = createBscReadClient({ config: chainConfig });
    const address = normalizeEvmAddress(request.address);
    const head = await readClient.getHead();
    const identity = await readClient.readPoolIdentity(address);
    const token0AssetId = assetIdForAddress(bscChainId, identity.token0);
    const token1AssetId = assetIdForAddress(bscChainId, identity.token1);
    const registered = await repository.listAssets([
      token0AssetId,
      token1AssetId,
    ]);
    const readable = new Set(
      registered
        .filter((asset) => asset.status !== "blocked")
        .map((asset) => asset.assetId),
    );
    if (!readable.has(token0AssetId) || !readable.has(token1AssetId)) {
      throw new PoolRegisterError("pool_register_token_not_registered");
    }
    return await repository.upsertPool({
      chainId: bscChainId,
      address,
      token0AssetId,
      token1AssetId,
      fee: identity.fee,
      tickSpacing: identity.tickSpacing,
      sourceBlockNumber: head.blockNumber.toString(10),
    });
  } finally {
    await pool.end();
  }
}

export async function runPoolRegister(options: {
  readonly argv: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly stdout: OutputWriter;
  readonly stderr: OutputWriter;
  readonly register?: (request: PoolRegisterRequest) => Promise<PoolRecord>;
}): Promise<0 | 1> {
  let request: PoolRegisterRequest;
  try {
    request = parsePoolRegisterRequest(options.argv, options.environment);
  } catch (error) {
    const code =
      error instanceof PoolRegisterError ? error.code : "pool_register_failed";
    options.stderr.write(`Pool registration refused (${code})\n`);
    return 1;
  }

  try {
    const register = options.register ?? registerPool;
    const record = await register(request);
    options.stdout.write(
      `Registered pool ${record.poolId} ${record.token0AssetId} / ${record.token1AssetId} fee=${String(record.fee)}\n`,
    );
    return 0;
  } catch (error) {
    const code =
      error instanceof PoolRegisterError ? error.code : "pool_register_failed";
    options.stderr.write(`Pool registration failed (${code})\n`);
    return 1;
  }
}

const directEntryPoint = process.argv[1];

if (
  directEntryPoint !== undefined &&
  resolve(directEntryPoint) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runPoolRegister({
    argv: process.argv,
    environment: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
