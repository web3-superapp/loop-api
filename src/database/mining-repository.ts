import type { Pool } from "pg";
import { z } from "zod";

import {
  communityWeightStatuses,
  miningFormulaDocumentSchema,
  miningFormulaStatuses,
  miningPriceGuardRulesSchema,
  miningWeightRangeDocumentSchema,
  priceVersionPatternSource,
  unsignedDecimalPatternSource,
} from "../features/mining/mining-contract.js";
import {
  MiningFormulaNotFoundError,
  MiningFormulaStateError,
  MiningRepositoryUnavailableError,
  type CommunityWeightRecord,
  type MiningFormulaRecord,
  type MiningRepository,
  type MiningSnapshotRecord,
  type WriteMiningSnapshotInput,
} from "../features/mining/mining-repository.js";
import type {
  MiningBalanceInput,
  MiningCommunityWeightInput,
} from "../features/mining/mining-snapshot.js";
import {
  toIsoString,
  toNullableIsoString,
  withV2Transaction,
} from "./v2-command-support.js";

/**
 * PostgreSQL implementation of the Mining boundary (Decision 0036). Balance
 * inputs are the latest `wallet_balance_snapshots` row per active wallet and
 * readable asset; community weights join the community's canonical bound
 * asset key. Nothing here derives a number that was not observed or reviewed.
 */

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const opaqueIdSchema = z.string().regex(canonicalUuidPattern);
const uuidV4Schema = z.string().regex(uuidV4Pattern);
const configVersionSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const decimalSchema = z
  .string()
  .regex(new RegExp(unsignedDecimalPatternSource));
const blockNumberSchema = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
const blockHashSchema = z.string().regex(/^0x[0-9a-f]{64}$/);
const dateSchema = z.date().refine((value) => !Number.isNaN(value.getTime()));

const formulaRowSchema = z
  .object({
    config_version: configVersionSchema,
    formula: miningFormulaDocumentSchema,
    weight_range: miningWeightRangeDocumentSchema,
    price_guard_rules: miningPriceGuardRulesSchema,
    status: z.enum(miningFormulaStatuses),
    effective_at: dateSchema.nullable(),
    approved_at: dateSchema.nullable(),
    created_at: dateSchema,
  })
  .strict();

const weightRowSchema = z
  .object({
    community_id: opaqueIdSchema,
    community_name: z.string().min(1),
    bound_asset_id: z.string().nullable(),
    status: z.enum(communityWeightStatuses),
    weight: decimalSchema.nullable(),
    config_version: configVersionSchema.nullable(),
    reviewed_at: dateSchema.nullable(),
  })
  .strict();

const snapshotRowSchema = z
  .object({
    snapshot_id: opaqueIdSchema,
    block_number: blockNumberSchema,
    block_hash: blockHashSchema,
    formula_version: configVersionSchema,
    price_version: z.string().regex(new RegExp(priceVersionPatternSource)),
    total_power: decimalSchema,
    account_count: z.number().int().min(0),
    computed_at: dateSchema,
  })
  .strict();

const balanceRowSchema = z
  .object({
    owner_user_id: opaqueIdSchema,
    wallet_id: opaqueIdSchema,
    asset_id: z.string().min(1),
    decimals: z.number().int().min(0).max(36),
    raw_value: z.string().regex(/^(0|[1-9][0-9]{0,77})$/),
    block_number: blockNumberSchema,
    block_hash: blockHashSchema,
  })
  .strict();

const formulaColumns = `
  config_version, formula, weight_range, price_guard_rules, status,
  effective_at, approved_at, created_at
`;

function mapFormula(raw: unknown): MiningFormulaRecord {
  const row = formulaRowSchema.parse(raw);
  return Object.freeze({
    configVersion: row.config_version,
    formula: row.formula,
    weightRange: row.weight_range,
    priceGuardRules: Object.freeze(row.price_guard_rules),
    status: row.status,
    effectiveAt: toNullableIsoString(row.effective_at),
    approvedAt: toNullableIsoString(row.approved_at),
    createdAt: toIsoString(row.created_at),
  });
}

function mapSnapshot(raw: unknown): MiningSnapshotRecord {
  const row = snapshotRowSchema.parse(raw);
  return Object.freeze({
    snapshotId: row.snapshot_id,
    blockNumber: row.block_number,
    blockHash: row.block_hash,
    formulaVersion: row.formula_version,
    priceVersion: row.price_version,
    totalPower: row.total_power,
    accountCount: row.account_count,
    computedAt: toIsoString(row.computed_at),
  });
}

function unavailable(): MiningRepositoryUnavailableError {
  return new MiningRepositoryUnavailableError();
}

function translate(error: unknown): never {
  if (
    error instanceof MiningFormulaNotFoundError ||
    error instanceof MiningFormulaStateError ||
    error instanceof MiningRepositoryUnavailableError
  ) {
    throw error;
  }
  throw unavailable();
}

export function createPostgresMiningRepository(pool: Pool): MiningRepository {
  return Object.freeze({
    async getApprovedFormula() {
      try {
        const result = await pool.query({
          text: `
            select ${formulaColumns}
            from public.mining_formula_versions
            where status = 'approved'
            limit 1
          `,
        });
        const row: unknown = result.rows[0];
        return row === undefined ? null : mapFormula(row);
      } catch (error) {
        return translate(error);
      }
    },

    async listFormulaVersions() {
      try {
        const result = await pool.query({
          text: `
            select ${formulaColumns}
            from public.mining_formula_versions
            order by created_at desc, config_version desc
            limit 50
          `,
        });
        return Object.freeze(result.rows.map(mapFormula));
      } catch (error) {
        return translate(error);
      }
    },

    async approveFormula(
      rawInput: Parameters<MiningRepository["approveFormula"]>[0],
    ) {
      try {
        const configVersion = configVersionSchema.parse(rawInput.configVersion);
        uuidV4Schema.parse(rawInput.requestId);
        return await withV2Transaction(pool, unavailable, async (client) => {
          const current = await client.query({
            text: `
              select ${formulaColumns}
              from public.mining_formula_versions
              where config_version = $1
              for update
            `,
            values: [configVersion],
          });
          const raw: unknown = current.rows[0];
          if (raw === undefined) {
            throw new MiningFormulaNotFoundError();
          }
          const record = mapFormula(raw);
          if (record.status !== "pending_approval") {
            throw new MiningFormulaStateError();
          }
          await client.query({
            text: `
              update public.mining_formula_versions
              set status = 'retired', updated_at = clock_timestamp()
              where status = 'approved'
            `,
          });
          const approved = await client.query({
            text: `
              update public.mining_formula_versions
              set
                status = 'approved',
                effective_at = clock_timestamp(),
                approved_at = clock_timestamp(),
                updated_at = clock_timestamp()
              where config_version = $1
              returning ${formulaColumns}
            `,
            values: [configVersion],
          });
          return mapFormula(approved.rows[0]);
        });
      } catch (error) {
        return translate(error);
      }
    },

    async getCommunityWeight(
      rawCommunityId: Parameters<MiningRepository["getCommunityWeight"]>[0],
    ) {
      try {
        const communityId = opaqueIdSchema.parse(rawCommunityId);
        const result = await pool.query({
          text: `
            select
              c.community_id,
              c.name as community_name,
              c.bound_asset_key as bound_asset_id,
              coalesce(w.status, 'pending_review') as status,
              w.weight,
              w.config_version,
              w.reviewed_at
            from public.communities as c
            left join public.community_mining_weights as w
              on w.community_id = c.community_id
            where c.community_id = $1
          `,
          values: [communityId],
        });
        const raw: unknown = result.rows[0];
        if (raw === undefined) {
          return null;
        }
        const row = weightRowSchema.parse(raw);
        const record: CommunityWeightRecord = Object.freeze({
          communityId: row.community_id,
          communityName: row.community_name,
          boundAssetId: row.bound_asset_id,
          status: row.status,
          weight: row.weight,
          configVersion: row.config_version,
          reviewedAt: toNullableIsoString(row.reviewed_at),
        });
        return record;
      } catch (error) {
        return translate(error);
      }
    },

    async listCommunityWeightInputs() {
      try {
        const result = await pool.query({
          text: `
            select
              w.community_id,
              c.name as community_name,
              c.bound_asset_key as bound_asset_id,
              w.status,
              w.weight,
              w.config_version,
              w.reviewed_at
            from public.community_mining_weights as w
            join public.communities as c on c.community_id = w.community_id
            where c.bound_asset_key is not null
          `,
        });
        return Object.freeze(
          result.rows.map((raw): MiningCommunityWeightInput => {
            const row = weightRowSchema.parse(raw);
            return Object.freeze({
              communityId: row.community_id,
              assetId: row.bound_asset_id ?? "",
              weight: row.weight,
              status: row.status,
            });
          }),
        );
      } catch (error) {
        return translate(error);
      }
    },

    async getLatestSnapshot() {
      try {
        const result = await pool.query({
          text: `
            select
              snapshot_id, block_number::text as block_number, block_hash,
              formula_version, price_version, total_power, account_count, computed_at
            from public.mining_snapshots
            order by computed_at desc, snapshot_id desc
            limit 1
          `,
        });
        const row: unknown = result.rows[0];
        return row === undefined ? null : mapSnapshot(row);
      } catch (error) {
        return translate(error);
      }
    },

    async writeSnapshot(rawInput: WriteMiningSnapshotInput) {
      try {
        const snapshotId = uuidV4Schema.parse(rawInput.snapshotId);
        const blockNumber = blockNumberSchema.parse(rawInput.blockNumber);
        const blockHash = blockHashSchema.parse(rawInput.blockHash);
        const formulaVersion = configVersionSchema.parse(
          rawInput.formulaVersion,
        );
        const priceVersion = z
          .string()
          .regex(new RegExp(priceVersionPatternSource))
          .parse(rawInput.priceVersion);
        const totalPower = decimalSchema.parse(rawInput.totalPower);
        const accounts = new Set(rawInput.powers.map((row) => row.ownerUserId));
        return await withV2Transaction(pool, unavailable, async (client) => {
          const inserted = await client.query({
            text: `
              insert into public.mining_snapshots (
                snapshot_id, block_number, block_hash, formula_version,
                price_version, total_power, account_count
              )
              values ($1, $2, $3, $4, $5, $6, $7)
              returning
                snapshot_id, block_number::text as block_number, block_hash,
                formula_version, price_version, total_power, account_count, computed_at
            `,
            values: [
              snapshotId,
              blockNumber,
              blockHash,
              formulaVersion,
              priceVersion,
              totalPower,
              accounts.size,
            ],
          });
          for (const power of rawInput.powers) {
            await client.query({
              text: `
                insert into public.mining_snapshot_powers (
                  snapshot_id, owner_user_id, asset_id, holding,
                  reference_price_usd, weight, power, block_number
                )
                values ($1, $2, $3, $4, $5, $6, $7, $8)
              `,
              values: [
                snapshotId,
                opaqueIdSchema.parse(power.ownerUserId),
                power.assetId,
                decimalSchema.parse(power.holding),
                decimalSchema.parse(power.referencePriceUsd),
                decimalSchema.parse(power.weight),
                decimalSchema.parse(power.power),
                blockNumberSchema.parse(power.blockNumber),
              ],
            });
          }
          return mapSnapshot(inserted.rows[0]);
        });
      } catch (error) {
        return translate(error);
      }
    },

    async listBalanceInputs() {
      try {
        const result = await pool.query({
          text: `
            select distinct on (s.wallet_id, s.asset_id)
              w.owner_user_id,
              s.wallet_id,
              s.asset_id,
              a.decimals,
              s.raw_value::text as raw_value,
              s.block_number::text as block_number,
              s.block_hash
            from public.wallet_balance_snapshots as s
            join public.account_wallets as w on w.wallet_id = s.wallet_id
            join public.assets as a on a.asset_id = s.asset_id
            where w.status = 'active' and a.status <> 'blocked'
            order by s.wallet_id, s.asset_id, s.block_number desc
          `,
        });
        return Object.freeze(
          result.rows.map((raw): MiningBalanceInput => {
            const row = balanceRowSchema.parse(raw);
            return Object.freeze({
              ownerUserId: row.owner_user_id,
              walletId: row.wallet_id,
              assetId: row.asset_id,
              decimals: row.decimals,
              rawValue: row.raw_value,
              blockNumber: row.block_number,
              blockHash: row.block_hash,
            });
          }),
        );
      } catch (error) {
        return translate(error);
      }
    },
  });
}
