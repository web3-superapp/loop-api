import type { Pool } from "pg";
import { z } from "zod";

import {
  assetIdPatternSource,
  assetStatuses,
  chainIdPatternSource,
  evmAddressPatternSource,
  type AssetStatus,
} from "../features/chain/chain-contract.js";

/**
 * PostgreSQL access for the BSC chain and Asset Registry (Decision 0033).
 *
 * The repository owns storage only. Whether an asset may be shown, swapped, or
 * indexed is feature policy and lives in `asset-registry-service`.
 */

const assetRowSchema = z
  .object({
    asset_id: z.string().regex(new RegExp(assetIdPatternSource)),
    chain_id: z.string().regex(new RegExp(chainIdPatternSource)),
    address: z.string().regex(new RegExp(evmAddressPatternSource)).nullable(),
    symbol: z.string().min(1).max(32),
    name: z.string().min(1).max(128),
    decimals: z.number().int().min(0).max(36),
    status: z.enum(assetStatuses),
    source_kind: z.enum(["chain_call", "chain_native", "operator_block"]),
    source_block_number: z
      .string()
      .regex(/^[0-9]+$/)
      .nullable(),
    source_verified_at: z.date().nullable(),
    updated_at: z.date(),
  })
  .strict();

const chainRowSchema = z
  .object({
    chain_id: z.string().regex(new RegExp(chainIdPatternSource)),
    reference: z.number().int().positive(),
    name: z.string().min(1).max(64),
    native_asset_id: z.string().regex(new RegExp(assetIdPatternSource)),
    confirmations: z.number().int().positive(),
    reorg_depth_blocks: z.number().int().positive(),
    status: z.enum(["enabled", "disabled"]),
  })
  .strict();

const poolRowSchema = z
  .object({
    pool_id: z.string().uuid(),
    chain_id: z.string().regex(new RegExp(chainIdPatternSource)),
    protocol: z.literal("pancakeswap_v3"),
    address: z.string().regex(new RegExp(evmAddressPatternSource)),
    token0_asset_id: z.string().regex(new RegExp(assetIdPatternSource)),
    token1_asset_id: z.string().regex(new RegExp(assetIdPatternSource)),
    fee: z.number().int().min(0),
    tick_spacing: z.number().int().positive(),
    status: z.enum(["registered", "blocked"]),
  })
  .strict();

export interface ChainRecord {
  readonly chainId: string;
  readonly reference: number;
  readonly name: string;
  readonly nativeAssetId: string;
  readonly confirmations: number;
  readonly reorgDepthBlocks: number;
  readonly status: "enabled" | "disabled";
}

export interface AssetRecord {
  readonly assetId: string;
  readonly chainId: string;
  readonly address: string | null;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly status: AssetStatus;
  readonly sourceKind: "chain_call" | "chain_native" | "operator_block";
  readonly sourceBlockNumber: string | null;
  readonly sourceVerifiedAt: string | null;
  readonly updatedAt: string;
}

export interface PoolRecord {
  readonly poolId: string;
  readonly chainId: string;
  readonly protocol: "pancakeswap_v3";
  readonly address: string;
  readonly token0AssetId: string;
  readonly token1AssetId: string;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly status: "registered" | "blocked";
}

export interface UpsertAssetInput {
  readonly assetId: string;
  readonly chainId: string;
  readonly address: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly status: AssetStatus;
  readonly sourceBlockNumber: string;
}

export interface UpsertPoolInput {
  readonly chainId: string;
  readonly address: string;
  readonly token0AssetId: string;
  readonly token1AssetId: string;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly sourceBlockNumber: string;
}

export interface ChainRegistryRepository {
  getChain(chainId: string): Promise<ChainRecord | null>;
  getAsset(assetId: string): Promise<AssetRecord | null>;
  listAssets(assetIds: readonly string[]): Promise<readonly AssetRecord[]>;
  /** Registry assets a read may project: everything except `blocked`. */
  listReadableAssets(chainId: string): Promise<readonly AssetRecord[]>;
  upsertAsset(input: UpsertAssetInput): Promise<AssetRecord>;
  listPools(chainId: string): Promise<readonly PoolRecord[]>;
  upsertPool(input: UpsertPoolInput): Promise<PoolRecord>;
}

export class ChainRegistryUnavailableError extends Error {
  readonly code = "chain_registry_unavailable";

  constructor() {
    super("The chain registry repository is unavailable");
    this.name = "ChainRegistryUnavailableError";
  }
}

const assetColumns = `
  asset_id,
  chain_id,
  address,
  symbol,
  name,
  decimals,
  status,
  source_kind,
  source_block_number::text as source_block_number,
  source_verified_at,
  updated_at
`;

function mapAsset(row: unknown): AssetRecord {
  const parsed = assetRowSchema.parse(row);
  return Object.freeze({
    assetId: parsed.asset_id,
    chainId: parsed.chain_id,
    address: parsed.address,
    symbol: parsed.symbol,
    name: parsed.name,
    decimals: parsed.decimals,
    status: parsed.status,
    sourceKind: parsed.source_kind,
    sourceBlockNumber: parsed.source_block_number,
    sourceVerifiedAt:
      parsed.source_verified_at === null
        ? null
        : parsed.source_verified_at.toISOString(),
    updatedAt: parsed.updated_at.toISOString(),
  });
}

function mapPool(row: unknown): PoolRecord {
  const parsed = poolRowSchema.parse(row);
  return Object.freeze({
    poolId: parsed.pool_id,
    chainId: parsed.chain_id,
    protocol: parsed.protocol,
    address: parsed.address,
    token0AssetId: parsed.token0_asset_id,
    token1AssetId: parsed.token1_asset_id,
    fee: parsed.fee,
    tickSpacing: parsed.tick_spacing,
    status: parsed.status,
  });
}

export function createPostgresChainRegistryRepository(
  pool: Pool,
): ChainRegistryRepository {
  return Object.freeze({
    async getChain(chainId: string): Promise<ChainRecord | null> {
      const result = await pool.query<Record<string, unknown>>({
        text: `
          select chain_id, reference, name, native_asset_id, confirmations,
                 reorg_depth_blocks, status
          from public.chains
          where chain_id = $1
          limit 1
        `,
        values: [chainId],
      });
      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }
      const parsed = chainRowSchema.parse(row);
      return Object.freeze({
        chainId: parsed.chain_id,
        reference: parsed.reference,
        name: parsed.name,
        nativeAssetId: parsed.native_asset_id,
        confirmations: parsed.confirmations,
        reorgDepthBlocks: parsed.reorg_depth_blocks,
        status: parsed.status,
      });
    },

    async getAsset(assetId: string): Promise<AssetRecord | null> {
      const result = await pool.query<Record<string, unknown>>({
        text: `select ${assetColumns} from public.assets where asset_id = $1 limit 1`,
        values: [assetId],
      });
      const row = result.rows[0];
      return row === undefined ? null : mapAsset(row);
    },

    async listAssets(
      assetIds: readonly string[],
    ): Promise<readonly AssetRecord[]> {
      if (assetIds.length === 0) {
        return Object.freeze([]);
      }
      const result = await pool.query<Record<string, unknown>>({
        text: `
          select ${assetColumns}
          from public.assets
          where asset_id = any($1::text[])
          order by asset_id asc
        `,
        values: [[...assetIds]],
      });
      return Object.freeze(result.rows.map(mapAsset));
    },

    async listReadableAssets(chainId: string): Promise<readonly AssetRecord[]> {
      const result = await pool.query<Record<string, unknown>>({
        text: `
          select ${assetColumns}
          from public.assets
          where chain_id = $1 and status <> 'blocked'
          order by (address is null) desc, asset_id asc
        `,
        values: [chainId],
      });
      return Object.freeze(result.rows.map(mapAsset));
    },

    async upsertAsset(input: UpsertAssetInput): Promise<AssetRecord> {
      const result = await pool.query<Record<string, unknown>>({
        text: `
          insert into public.assets (
            asset_id, chain_id, address, symbol, name, decimals, status,
            source_kind, source_block_number, source_verified_at
          )
          values ($1, $2, $3, $4, $5, $6, $7, 'chain_call', $8::numeric, clock_timestamp())
          on conflict (asset_id) do update set
            symbol = excluded.symbol,
            name = excluded.name,
            decimals = excluded.decimals,
            status = excluded.status,
            source_kind = excluded.source_kind,
            source_block_number = excluded.source_block_number,
            source_verified_at = excluded.source_verified_at,
            updated_at = clock_timestamp()
          returning ${assetColumns}
        `,
        values: [
          input.assetId,
          input.chainId,
          input.address,
          input.symbol,
          input.name,
          input.decimals,
          input.status,
          input.sourceBlockNumber,
        ],
      });
      const row = result.rows[0];
      if (row === undefined) {
        throw new ChainRegistryUnavailableError();
      }
      return mapAsset(row);
    },

    async listPools(chainId: string): Promise<readonly PoolRecord[]> {
      const result = await pool.query<Record<string, unknown>>({
        text: `
          select pool_id, chain_id, protocol, address, token0_asset_id,
                 token1_asset_id, fee, tick_spacing, status
          from public.pools
          where chain_id = $1 and status = 'registered'
          order by address asc
        `,
        values: [chainId],
      });
      return Object.freeze(result.rows.map(mapPool));
    },

    async upsertPool(input: UpsertPoolInput): Promise<PoolRecord> {
      const result = await pool.query<Record<string, unknown>>({
        text: `
          insert into public.pools (
            chain_id, protocol, address, token0_asset_id, token1_asset_id,
            fee, tick_spacing, source_block_number, source_verified_at
          )
          values ($1, 'pancakeswap_v3', $2, $3, $4, $5, $6, $7::numeric, clock_timestamp())
          on conflict (chain_id, address) do update set
            token0_asset_id = excluded.token0_asset_id,
            token1_asset_id = excluded.token1_asset_id,
            fee = excluded.fee,
            tick_spacing = excluded.tick_spacing,
            source_block_number = excluded.source_block_number,
            source_verified_at = excluded.source_verified_at,
            updated_at = clock_timestamp()
          returning pool_id, chain_id, protocol, address, token0_asset_id,
                    token1_asset_id, fee, tick_spacing, status
        `,
        values: [
          input.chainId,
          input.address,
          input.token0AssetId,
          input.token1AssetId,
          input.fee,
          input.tickSpacing,
          input.sourceBlockNumber,
        ],
      });
      const row = result.rows[0];
      if (row === undefined) {
        throw new ChainRegistryUnavailableError();
      }
      return mapPool(row);
    },
  });
}

function unavailable(): Promise<never> {
  return Promise.reject(new ChainRegistryUnavailableError());
}

export function createUnavailableChainRegistryRepository(): ChainRegistryRepository {
  return Object.freeze({
    getChain: unavailable,
    getAsset: unavailable,
    listAssets: unavailable,
    listReadableAssets: unavailable,
    upsertAsset: unavailable,
    listPools: unavailable,
    upsertPool: unavailable,
  });
}
