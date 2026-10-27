import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { adminReasonCodes } from "../features/admin/admin-contract.js";
import { launch2PriceAt } from "../features/launch2/launch2-curve-math.js";
import { MiningSettlementInputError } from "../features/mining/hourly-settlement-calculator.js";
import {
  miningSettlementReasonCodes,
  parseMiningParameterDocument,
  type MiningClaimState,
  type MiningEpochState,
  type MiningParameterState,
} from "../features/mining/hourly-settlement-contract.js";
import {
  MiningClaimIdempotencyConflictError,
  MiningCommunityUnknownError,
  MiningSettlementConflictError,
  MiningSettlementUnavailableError,
  type CreateMiningClaimRecord,
  type MiningAssetFact,
  type MiningAuditInput,
  type MiningAuditRecord,
  type MiningClaimRecord,
  type MiningEpochRecord,
  type MiningEpochRewardRecord,
  type MiningErc20OpeningPin,
  type MiningParameterVersionRecord,
  type MiningSettlementRepository,
} from "../features/mining/hourly-settlement-ports.js";
import {
  claimV2Command,
  isUniqueViolation,
  lockV2Owner,
  withV2Transaction,
  type DatabaseClient,
} from "./v2-command-support.js";

/**
 * Decision 0116: PostgreSQL side of the hourly settlement. A settled epoch,
 * its reward rows, its `settled` ledger events, and the balance increments
 * are one transaction; a claim's `claimed` event and balance increment are
 * one transaction with its `succeeded` transition. Nothing here computes a
 * reward; it stores what the pure calculator produced.
 */

type Row = Record<string, unknown>;
type Queryable = Pool | PoolClient;

const zeroAddress = "0x0000000000000000000000000000000000000000";
const claimPrepareScope = "mining_claim_prepare";
const claimReportScope = "mining_claim_report";

export const miningClaimPrepareDigestVersion = "mining_claim_prepare_v1";
export const miningClaimReportDigestVersion = "mining_claim_report_v1";

class CallerCallbackError extends Error {
  constructor(readonly inner: unknown) {
    super("caller callback failed");
  }
}

function unavailable(): MiningSettlementUnavailableError {
  return new MiningSettlementUnavailableError();
}

function translate(error: unknown): never {
  if (error instanceof CallerCallbackError) throw error.inner;
  if (
    error instanceof MiningSettlementInputError ||
    error instanceof MiningSettlementConflictError ||
    error instanceof MiningCommunityUnknownError ||
    error instanceof MiningClaimIdempotencyConflictError ||
    error instanceof MiningSettlementUnavailableError
  ) {
    throw error;
  }
  throw new MiningSettlementUnavailableError({ cause: error });
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  throw new MiningSettlementUnavailableError();
}

function nullableText(row: Row, key: string): string | null {
  return row[key] === null || row[key] === undefined ? null : text(row, key);
}

function iso(row: Row, key: string): string {
  const value = row[key];
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  throw new MiningSettlementUnavailableError();
}

function nullableIso(row: Row, key: string): string | null {
  return row[key] === null || row[key] === undefined ? null : iso(row, key);
}

function isoOf(unixSeconds: bigint): string {
  return new Date(Number(unixSeconds) * 1000).toISOString();
}

function epochSeconds(row: Row, key: string): bigint {
  return BigInt(text(row, key));
}

const versionColumns = `
  version_id, config_version, status, document, effective_from,
  draft_author_actor, draft_author_account_id, approved_by, approved_at,
  created_at
`;

function mapVersion(row: Row): MiningParameterVersionRecord {
  return Object.freeze({
    versionId: text(row, "version_id"),
    configVersion: text(row, "config_version"),
    status: text(row, "status") as MiningParameterState,
    document: parseMiningParameterDocument(row["document"]),
    effectiveFrom: iso(row, "effective_from"),
    draftAuthor: Object.freeze({
      actor: text(row, "draft_author_actor"),
      accountId: nullableText(row, "draft_author_account_id"),
    }),
    approvedBy: nullableText(row, "approved_by"),
    approvedAt: nullableIso(row, "approved_at"),
    createdAt: iso(row, "created_at"),
  });
}

const epochColumns = `
  epoch_id, hour_start, hour_end, status, trigger, version_id,
  budget_nft_raw::text, budget_asset_raw::text, denominator_nft_power,
  denominator_asset_power, allocated_nft_raw::text, allocated_asset_raw::text,
  unallocated_nft_raw::text, unallocated_asset_raw::text, user_count,
  input_digest, input_summary, failure_reason_code, attempt_count,
  settled_at, updated_at
`;

function mapEpoch(row: Row): MiningEpochRecord {
  return Object.freeze({
    epochId: text(row, "epoch_id"),
    hourStart: iso(row, "hour_start"),
    hourEnd: iso(row, "hour_end"),
    status: text(row, "status") as MiningEpochState,
    versionId: nullableText(row, "version_id"),
    budgetNftRaw: text(row, "budget_nft_raw"),
    budgetAssetRaw: text(row, "budget_asset_raw"),
    denominatorNftPower: text(row, "denominator_nft_power"),
    denominatorAssetPower: text(row, "denominator_asset_power"),
    allocatedNftRaw: text(row, "allocated_nft_raw"),
    allocatedAssetRaw: text(row, "allocated_asset_raw"),
    unallocatedNftRaw: text(row, "unallocated_nft_raw"),
    unallocatedAssetRaw: text(row, "unallocated_asset_raw"),
    userCount: Number(row["user_count"]),
    inputDigest: nullableText(row, "input_digest"),
    inputSummary: Object.freeze(
      (row["input_summary"] ?? {}) as Record<string, unknown>,
    ),
    failureReasonCode: nullableText(row, "failure_reason_code"),
    attemptCount: Number(row["attempt_count"]),
    trigger:
      text(row, "trigger") === "test_trigger" ? "test_trigger" : "scheduled",
    settledAt: nullableIso(row, "settled_at"),
    updatedAt: iso(row, "updated_at"),
  });
}

const rewardColumns = `
  r.epoch_id, e.hour_start, e.hour_end, r.owner_user_id, r.nft_self_power,
  r.asset_self_power, r.nft_referral_power, r.asset_referral_power,
  r.nft_total_power, r.asset_total_power, r.referral_levels, r.nft_holdings,
  r.asset_holdings, r.nft_reward_raw::text, r.asset_reward_raw::text,
  r.total_reward_raw::text
`;

function mapReward(row: Row): MiningEpochRewardRecord {
  return Object.freeze({
    epochId: text(row, "epoch_id"),
    hourStart: iso(row, "hour_start"),
    hourEnd: iso(row, "hour_end"),
    userId: text(row, "owner_user_id"),
    nftSelfPower: text(row, "nft_self_power"),
    assetSelfPower: text(row, "asset_self_power"),
    nftReferralPower: text(row, "nft_referral_power"),
    assetReferralPower: text(row, "asset_referral_power"),
    nftTotalPower: text(row, "nft_total_power"),
    assetTotalPower: text(row, "asset_total_power"),
    levels: Object.freeze(
      row["referral_levels"] as MiningEpochRewardRecord["levels"],
    ),
    nftHoldings: Object.freeze(
      row["nft_holdings"] as MiningEpochRewardRecord["nftHoldings"],
    ),
    assetHoldings: Object.freeze(
      row["asset_holdings"] as MiningEpochRewardRecord["assetHoldings"],
    ),
    nftRewardRaw: text(row, "nft_reward_raw"),
    assetRewardRaw: text(row, "asset_reward_raw"),
    totalRewardRaw: text(row, "total_reward_raw"),
  });
}

const claimColumns = `
  claim_id, owner_user_id, wallet_id, wallet_address, chain_id,
  contract_address, cumulative_amount_raw::text, expected_delta_raw::text,
  nonce::text, deadline, signature, signer_address,
  prepared_block_number::text, unsigned_transaction, status, transaction_hash,
  block_number::text, confirmed_delta_raw::text, failure_reason_code,
  created_at, updated_at
`;

function mapClaim(row: Row): MiningClaimRecord {
  return Object.freeze({
    claimId: text(row, "claim_id"),
    userId: text(row, "owner_user_id"),
    walletId: text(row, "wallet_id"),
    walletAddress: text(row, "wallet_address"),
    chainId: text(row, "chain_id"),
    contractAddress: text(row, "contract_address"),
    cumulativeAmountRaw: text(row, "cumulative_amount_raw"),
    expectedDeltaRaw: text(row, "expected_delta_raw"),
    nonce: text(row, "nonce"),
    deadline: iso(row, "deadline"),
    signature: text(row, "signature"),
    signerAddress: text(row, "signer_address"),
    preparedBlockNumber: text(row, "prepared_block_number"),
    unsignedTransaction: Object.freeze(
      row["unsigned_transaction"] as Record<string, unknown>,
    ),
    status: text(row, "status") as MiningClaimState,
    transactionHash: nullableText(row, "transaction_hash"),
    blockNumber: nullableText(row, "block_number"),
    confirmedDeltaRaw: nullableText(row, "confirmed_delta_raw"),
    failureReasonCode: nullableText(row, "failure_reason_code"),
    createdAt: iso(row, "created_at"),
    updatedAt: iso(row, "updated_at"),
  });
}

async function insertAudit(
  client: Queryable,
  input: MiningAuditInput,
): Promise<MiningAuditRecord> {
  const result = await client.query<Row>({
    text: `
      insert into public.admin_audit_log (
        audit_id, actor, action, target_type, target_id, before, after,
        request_id, actor_account_id
      )
      values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
      returning audit_id, seq::text as seq, at, action
    `,
    values: [
      randomUUID(),
      input.actor,
      input.action,
      input.targetType,
      input.targetId,
      JSON.stringify(input.before ?? null),
      JSON.stringify(input.after ?? null),
      input.requestId,
      input.actorAccountId,
    ],
  });
  const row = result.rows[0] as Row;
  return Object.freeze({
    auditId: text(row, "audit_id"),
    seq: Number(text(row, "seq")),
    at: iso(row, "at"),
    action: text(row, "action"),
  });
}

/** Decision 0111: the approving reviewer's account and operator must be live. */
async function assertApproverActive(
  client: DatabaseClient,
  accountId: string,
): Promise<void> {
  const account = await client.query<{
    disabled: boolean;
    operator_user_id: string | null;
  }>({
    text: `
      select disabled_at is not null as disabled, operator_user_id
      from public.admin_accounts where id = $1 for share
    `,
    values: [accountId],
  });
  const row = account.rows[0];
  if (row === undefined || row.disabled) {
    throw new MiningSettlementConflictError(adminReasonCodes.accountDisabled);
  }
  if (row.operator_user_id === null) {
    throw new MiningSettlementConflictError(adminReasonCodes.operatorDisabled);
  }
  const operator = await client.query<{ enabled: boolean }>({
    text: `select enabled from public.ops_operators where user_id = $1 for share`,
    values: [row.operator_user_id],
  });
  if (operator.rows[0]?.enabled !== true) {
    throw new MiningSettlementConflictError(adminReasonCodes.operatorDisabled);
  }
}

function splitAssetId(assetId: string): { chainId: string; address: string } {
  const index = assetId.lastIndexOf(":");
  return {
    chainId: assetId.slice(0, index),
    address: assetId.slice(index + 1),
  };
}

/** Decision 0189: the settlement source column of a roster candidate. */
function settlementSourceOf(
  value: string | null,
): "launch2" | "meme_v1" | "erc20" | null {
  return value === "launch2" || value === "meme_v1" || value === "erc20"
    ? value
    : null;
}

export function createPostgresMiningSettlementRepository(
  pool: Pool,
): MiningSettlementRepository {
  async function query<T extends Row = Row>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<T[]> {
    try {
      const result = await pool.query<T>({ text: sql, values: [...values] });
      return result.rows;
    } catch (error) {
      return translate(error);
    }
  }

  async function readVersion(
    client: Queryable,
    versionId: string,
    lock: boolean,
  ): Promise<MiningParameterVersionRecord | null> {
    const result = await client.query<Row>({
      text: `select ${versionColumns} from public.mining_parameter_versions
        where version_id = $1 ${lock ? "for update" : ""}`,
      values: [versionId],
    });
    return result.rows[0] === undefined ? null : mapVersion(result.rows[0]);
  }

  /**
   * Decision 0189: the `erc20` holdings of one external token for
   * [hourStart, hourEnd) — null when the token has no such source (not a
   * registered unblocked asset, or no `erc20_transfer` lane on its chain).
   *
   * Holders = the active wallets (Decision 0184 kind scope, first seen
   * before the hour end) of the members (and creators) of the verified
   * communities bound to the token during the hour — anyone else is gated
   * to 0 by Decision 0183 anyway. Per address:
   *
   * - opening reading = the latest chain `wallet_balance_snapshots` row of
   *   the address observed before the hour start whose block is at or after
   *   the address's `indexer_wallet_coverage.from_block_number` − 1 (every
   *   later transfer of the address is indexed), or the pinned row on replay;
   * - opening = reading + the indexed transfers with block > reading block
   *   observed before the hour start; moves = those observed inside the
   *   hour, at their `observed_at` second (the lane's own clock: the table
   *   has no block time);
   * - no coverage / no reading / a negative roll-forward → unknown holder.
   */
  async function erc20Facts(input: {
    readonly assetId: string;
    readonly hourStart: bigint;
    readonly hourEnd: bigint;
    readonly embeddedWalletOnly: boolean;
    readonly pins: readonly MiningErc20OpeningPin[] | null;
  }): Promise<MiningAssetFact | null> {
    const { chainId } = splitAssetId(input.assetId);
    const start = isoOf(input.hourStart);
    const end = isoOf(input.hourEnd);
    const source = await query(
      `select exists (
         select 1 from public.assets where asset_id = $1 and status <> 'blocked'
       ) and exists (
         select 1 from public.indexer_checkpoints
         where lane = 'erc20_transfer' and chain_id = $2
       ) as readable`,
      [input.assetId, chainId],
    );
    if (source[0]?.["readable"] !== true) return null;
    const holders = await query(
      `with gated as (
         select community_id, created_by_user_id, created_at
         from public.communities
         where verification_status = 'verified' and bound_asset_key = $1
       ), members as (
         select h.user_id from public.community_membership_history h
         join gated g on g.community_id = h.community_id
         where h.joined_at < $3::timestamptz
           and (h.left_at is null or h.left_at > $2::timestamptz)
         union
         select g.created_by_user_id from gated g
         where g.created_at < $3::timestamptz
       )
       select distinct w.address
       from public.account_wallets w
       join members m on m.user_id = w.owner_user_id
       where w.status = 'active'
         and ($4::boolean is false or w.kind = 'embedded')
         and w.first_seen_at < $3::timestamptz
       order by w.address`,
      [input.assetId, start, end, input.embeddedWalletOnly],
    );
    const addresses = holders.map((row) => text(row, "address"));
    const unknownHolders: { address: string; reasonCode: string }[] = [];
    const empty = (): MiningAssetFact =>
      Object.freeze({
        assetId: input.assetId,
        source: "erc20" as const,
        graduatedAt: null,
        openingPriceE18: 0n,
        openingBalances: Object.freeze([]),
        moves: Object.freeze([]),
        unknownHolders: Object.freeze(
          unknownHolders.map((row) => Object.freeze(row)),
        ),
        openingPins: Object.freeze([]),
      });
    if (addresses.length === 0) return empty();
    const coverageRows = await query(
      `select address, from_block_number::text as from_block
       from public.indexer_wallet_coverage
       where chain_id = $1 and lane = 'erc20_transfer' and address = any($2::text[])`,
      [chainId, addresses],
    );
    const coverage = new Map(
      coverageRows.map((row) => [
        text(row, "address"),
        BigInt(text(row, "from_block")),
      ]),
    );
    const pinnedByWallet =
      input.pins === null
        ? null
        : input.pins.filter((pin) => pin.assetId === input.assetId);
    const readings =
      pinnedByWallet === null
        ? await query(
            `select distinct on (w.address) w.address, s.wallet_id::text as wallet_id,
               s.block_number::text as block_number, s.raw_value::text as raw_value
             from public.wallet_balance_snapshots s
             join public.account_wallets w on w.wallet_id = s.wallet_id
             where s.asset_id = $1 and s.source = 'chain'
               and w.address = any($2::text[])
               and s.observed_at < $3::timestamptz
             order by w.address, s.block_number desc, s.wallet_id`,
            [input.assetId, addresses, start],
          )
        : pinnedByWallet.length === 0
          ? []
          : await query(
              `select w.address, s.wallet_id::text as wallet_id,
                 s.block_number::text as block_number, s.raw_value::text as raw_value
               from unnest($2::uuid[], $3::bigint[]) as pin(wallet_id, block_number)
               join public.wallet_balance_snapshots s
                 on s.wallet_id = pin.wallet_id and s.block_number = pin.block_number
                 and s.asset_id = $1
               join public.account_wallets w on w.wallet_id = s.wallet_id
               where w.address = any($4::text[])
               order by w.address, s.block_number desc, s.wallet_id`,
              [
                input.assetId,
                pinnedByWallet.map((pin) => pin.walletId),
                pinnedByWallet.map((pin) => pin.blockNumber),
                addresses,
              ],
            );
    const readingOf = new Map<
      string,
      { walletId: string; block: bigint; raw: bigint }
    >();
    for (const row of readings) {
      const holder = text(row, "address");
      if (readingOf.has(holder)) continue;
      readingOf.set(holder, {
        walletId: text(row, "wallet_id"),
        block: BigInt(text(row, "block_number")),
        raw: BigInt(text(row, "raw_value")),
      });
    }
    const known: string[] = [];
    for (const holder of addresses) {
      const from = coverage.get(holder);
      if (from === undefined) {
        unknownHolders.push({
          address: holder,
          reasonCode: miningSettlementReasonCodes.externalBalanceUncovered,
        });
        continue;
      }
      const reading = readingOf.get(holder);
      if (reading === undefined || reading.block + 1n < from) {
        unknownHolders.push({
          address: holder,
          reasonCode: miningSettlementReasonCodes.externalOpeningMissing,
        });
        continue;
      }
      known.push(holder);
    }
    if (known.length === 0) return empty();
    const transfers = await query(
      `with reading(address, block_number) as (
         select * from unnest($3::text[], $4::bigint[])
       )
       select t.from_address, t.to_address, t.raw_value::text as amount,
         t.block_number::text as block_number,
         extract(epoch from t.observed_at)::bigint::text as at,
         t.observed_at < $5::timestamptz as before_hour
       from public.indexed_transfers t
       where t.chain_id = $1 and t.asset_id = $2 and not t.removed
         and t.observed_at < $6::timestamptz
         and exists (
           select 1 from reading r
           where (r.address = t.from_address or r.address = t.to_address)
             and t.block_number > r.block_number
         )
       order by t.observed_at, t.block_number, t.log_index`,
      [
        chainId,
        input.assetId,
        known,
        known.map((holder) => (readingOf.get(holder)?.block ?? 0n).toString()),
        start,
        end,
      ],
    );
    const opening = new Map<string, bigint>(
      known.map((holder) => [holder, readingOf.get(holder)?.raw ?? 0n]),
    );
    const movesOf = new Map<string, { deltaRaw: bigint; at: bigint }[]>();
    for (const row of transfers) {
      const amount = BigInt(text(row, "amount"));
      const block = BigInt(text(row, "block_number"));
      const sides: Array<[string, bigint]> = [
        [text(row, "from_address"), -amount],
        [text(row, "to_address"), amount],
      ];
      for (const [holder, delta] of sides) {
        const reading = readingOf.get(holder);
        if (!opening.has(holder) || reading === undefined) continue;
        if (block <= reading.block) continue;
        if (row["before_hour"] === true) {
          opening.set(holder, (opening.get(holder) ?? 0n) + delta);
        } else {
          const list = movesOf.get(holder) ?? [];
          list.push({ deltaRaw: delta, at: epochSeconds(row, "at") });
          movesOf.set(holder, list);
        }
      }
    }
    const openingBalances: { address: string; balanceRaw: bigint }[] = [];
    const moves: {
      address: string;
      deltaRaw: bigint;
      at: bigint;
      priceAfterE18: bigint;
    }[] = [];
    const pins: MiningErc20OpeningPin[] = [];
    for (const holder of known) {
      let balance = opening.get(holder) ?? 0n;
      let consistent = balance >= 0n;
      const list = movesOf.get(holder) ?? [];
      for (const move of list) {
        balance += move.deltaRaw;
        if (balance < 0n) consistent = false;
      }
      if (!consistent) {
        unknownHolders.push({
          address: holder,
          reasonCode: miningSettlementReasonCodes.externalBalanceInconsistent,
        });
        continue;
      }
      const reading = readingOf.get(holder);
      if (reading !== undefined) {
        pins.push(
          Object.freeze({
            assetId: input.assetId,
            walletId: reading.walletId,
            blockNumber: reading.block.toString(),
          }),
        );
      }
      openingBalances.push(
        Object.freeze({
          address: holder,
          balanceRaw: opening.get(holder) ?? 0n,
        }),
      );
      for (const move of list) {
        moves.push(
          Object.freeze({
            address: holder,
            deltaRaw: move.deltaRaw,
            at: move.at,
            priceAfterE18: 0n,
          }),
        );
      }
    }
    return Object.freeze({
      assetId: input.assetId,
      source: "erc20" as const,
      graduatedAt: null,
      openingPriceE18: 0n,
      openingBalances: Object.freeze(openingBalances),
      moves: Object.freeze(moves),
      unknownHolders: Object.freeze(
        unknownHolders
          .sort((a, b) => (a.address < b.address ? -1 : 1))
          .map((row) => Object.freeze(row)),
      ),
      openingPins: Object.freeze(
        pins.sort((a, b) =>
          a.walletId === b.walletId
            ? a.blockNumber < b.blockNumber
              ? -1
              : 1
            : a.walletId < b.walletId
              ? -1
              : 1,
        ),
      ),
    });
  }

  async function assetFacts(input: {
    readonly chainId: string;
    readonly hourStart: bigint;
    readonly hourEnd: bigint;
    readonly assetIds: readonly string[];
    readonly embeddedWalletOnly: boolean;
    readonly external?: {
      readonly assetIds: readonly string[];
      readonly staleAssetIds: readonly string[];
      readonly pins?: readonly MiningErc20OpeningPin[] | null;
    };
  }): Promise<{
    readonly assets: MiningAssetFact[];
    readonly unknown: string[];
    readonly externalExcluded: { assetId: string; reasonCode: string }[];
  }> {
    const assets: MiningAssetFact[] = [];
    const unknown: string[] = [];
    const externalExcluded: { assetId: string; reasonCode: string }[] = [];
    const externalIds = new Set(input.external?.assetIds ?? []);
    const staleIds = new Set(input.external?.staleAssetIds ?? []);
    const start = isoOf(input.hourStart);
    const end = isoOf(input.hourEnd);
    for (const assetId of input.assetIds) {
      if (externalIds.has(assetId) && staleIds.has(assetId)) {
        externalExcluded.push({
          assetId,
          reasonCode: miningSettlementReasonCodes.sourceStale,
        });
        continue;
      }
      const { chainId, address } = splitAssetId(assetId);
      const launch2 =
        chainId === input.chainId
          ? await query(
              `select instance_id, graduated_at,
                 extract(epoch from graduated_at)::bigint::text as graduated_s,
                 extract(epoch from meme_transfers_complete_at)::bigint::text
                   as transfers_complete_s
               from public.launch2_instances
               where chain_id = $1 and meme_address = $2`,
              [chainId, address],
            )
          : [];
      if (launch2[0] !== undefined) {
        const instanceId = text(launch2[0], "instance_id");
        const graduated =
          launch2[0]["graduated_s"] === null
            ? null
            : epochSeconds(launch2[0], "graduated_s");
        const soldBefore = await query(
          `select coalesce(sum(case side when 'buy' then meme_amount else -meme_amount end), 0)::text as sold
           from public.launch2_trades
           where instance_id = $1 and not removed and traded_at < $2::timestamptz`,
          [instanceId, start],
        );
        const openings = await query(
          `select trader_address as address,
             sum(case side when 'buy' then meme_amount else -meme_amount end)::text as balance
           from public.launch2_trades
           where instance_id = $1 and not removed and traded_at < $2::timestamptz
           group by trader_address
           having sum(case side when 'buy' then meme_amount else -meme_amount end) <> 0`,
          [instanceId, start],
        );
        const trades = await query(
          `select trader_address as address, side, meme_amount::text as amount,
             extract(epoch from traded_at)::bigint::text as at
           from public.launch2_trades
           where instance_id = $1 and not removed
             and traded_at >= $2::timestamptz and traded_at < $3::timestamptz
           order by block_number, log_index`,
          [instanceId, start, end],
        );
        let sold = BigInt(text(soldBefore[0] as Row, "sold"));
        const priceOf = (value: bigint): bigint => {
          try {
            return launch2PriceAt(value);
          } catch {
            throw new MiningSettlementInputError(
              miningSettlementReasonCodes.inputInvalid,
              "curve price out of range",
            );
          }
        };
        const openingPrice = sold > 0n ? priceOf(sold) : 0n;
        const moves = trades.map((row) => {
          const amount = BigInt(text(row, "amount"));
          const delta = text(row, "side") === "buy" ? amount : -amount;
          sold += delta;
          return Object.freeze({
            address: text(row, "address"),
            deltaRaw: delta,
            at: epochSeconds(row, "at"),
            priceAfterE18: priceOf(sold),
          });
        });
        // Decision 0125: post-graduation ERC-20 balances, only for an hour
        // that ended after the MEME transfer coverage was complete (an
        // earlier hour was settled without them and replays the same way).
        const complete =
          launch2[0]["transfers_complete_s"] === null
            ? null
            : epochSeconds(launch2[0], "transfers_complete_s");
        let postGraduation: MiningAssetFact["postGraduation"] = null;
        if (
          graduated !== null &&
          graduated < input.hourEnd &&
          complete !== null &&
          complete < input.hourEnd
        ) {
          const from =
            graduated > input.hourStart ? graduated : input.hourStart;
          const fromIso = isoOf(from);
          const transferOpenings = await query(
            `select address, sum(delta)::text as balance from (
               select to_address as address, amount as delta
               from public.launch2_meme_transfers
               where instance_id = $1 and not removed
                 and transferred_at < $2::timestamptz and to_address <> $3
               union all
               select from_address, -amount
               from public.launch2_meme_transfers
               where instance_id = $1 and not removed
                 and transferred_at < $2::timestamptz and from_address <> $3
             ) moves
             group by address having sum(delta) <> 0
             order by address`,
            [instanceId, fromIso, zeroAddress],
          );
          const transfers = await query(
            `select from_address, to_address, amount::text as amount,
               extract(epoch from transferred_at)::bigint::text as at
             from public.launch2_meme_transfers
             where instance_id = $1 and not removed
               and transferred_at >= $2::timestamptz
               and transferred_at < $3::timestamptz
             order by block_number, log_index`,
            [instanceId, fromIso, end],
          );
          const transferMoves: {
            address: string;
            deltaRaw: bigint;
            at: bigint;
          }[] = [];
          for (const row of transfers) {
            const amount = BigInt(text(row, "amount"));
            const at = epochSeconds(row, "at");
            const fromAddress = text(row, "from_address");
            const toAddress = text(row, "to_address");
            if (fromAddress !== zeroAddress) {
              transferMoves.push({
                address: fromAddress,
                deltaRaw: -amount,
                at,
              });
            }
            if (toAddress !== zeroAddress) {
              transferMoves.push({ address: toAddress, deltaRaw: amount, at });
            }
          }
          for (const row of transferOpenings) {
            if (BigInt(text(row, "balance")) < 0n) {
              throw new MiningSettlementInputError(
                miningSettlementReasonCodes.inputInvalid,
                "negative MEME balance",
              );
            }
          }
          postGraduation = Object.freeze({
            from,
            openingBalances: transferOpenings.map((row) =>
              Object.freeze({
                address: text(row, "address"),
                balanceRaw: BigInt(text(row, "balance")),
              }),
            ),
            moves: transferMoves.map((move) => Object.freeze(move)),
          });
        }
        assets.push(
          Object.freeze({
            assetId,
            source: "launch2" as const,
            postGraduation,
            graduatedAt: graduated,
            openingPriceE18: openingPrice,
            openingBalances: openings.map((row) =>
              Object.freeze({
                address: text(row, "address"),
                balanceRaw: BigInt(text(row, "balance")),
              }),
            ),
            moves,
          }),
        );
        continue;
      }
      const meme =
        chainId === input.chainId
          ? await query(
              `select meme_token_id,
                 extract(epoch from graduated_at)::bigint::text as graduated_s
               from public.meme_tokens
               where chain_id = $1 and token_address = $2`,
              [chainId, address],
            )
          : [];
      if (meme[0] === undefined) {
        // Decision 0189: an external token read from its ERC-20 transfers.
        const erc20 = externalIds.has(assetId)
          ? await erc20Facts({
              assetId,
              hourStart: input.hourStart,
              hourEnd: input.hourEnd,
              embeddedWalletOnly: input.embeddedWalletOnly,
              pins: input.external?.pins ?? null,
            })
          : null;
        if (erc20 !== null) {
          assets.push(erc20);
        } else if (externalIds.has(assetId)) {
          externalExcluded.push({
            assetId,
            reasonCode: miningSettlementReasonCodes.assetSourceUnknown,
          });
        } else {
          unknown.push(assetId);
        }
        continue;
      }
      const tokenId = text(meme[0], "meme_token_id");
      const lastPrice = await query(
        `select price_after_e18::text as price from public.meme_trades
         where meme_token_id = $1 and not removed and traded_at < $2::timestamptz
         order by block_number desc, log_index desc limit 1`,
        [tokenId, start],
      );
      const openings = await query(
        `select wallet as address,
           sum(case when is_buy then token_amount else -token_amount end)::text as balance
         from public.meme_trades
         where meme_token_id = $1 and not removed and traded_at < $2::timestamptz
         group by wallet
         having sum(case when is_buy then token_amount else -token_amount end) <> 0`,
        [tokenId, start],
      );
      const trades = await query(
        `select wallet as address, is_buy, token_amount::text as amount,
           price_after_e18::text as price,
           extract(epoch from traded_at)::bigint::text as at
         from public.meme_trades
         where meme_token_id = $1 and not removed
           and traded_at >= $2::timestamptz and traded_at < $3::timestamptz
         order by block_number, log_index`,
        [tokenId, start, end],
      );
      assets.push(
        Object.freeze({
          assetId,
          source: "meme_v1" as const,
          graduatedAt:
            meme[0]["graduated_s"] === null
              ? null
              : epochSeconds(meme[0], "graduated_s"),
          openingPriceE18:
            lastPrice[0] === undefined
              ? 0n
              : BigInt(text(lastPrice[0], "price")),
          openingBalances: openings.map((row) =>
            Object.freeze({
              address: text(row, "address"),
              balanceRaw: BigInt(text(row, "balance")),
            }),
          ),
          moves: trades.map((row) => {
            const amount = BigInt(text(row, "amount"));
            return Object.freeze({
              address: text(row, "address"),
              deltaRaw: row["is_buy"] === true ? amount : -amount,
              at: epochSeconds(row, "at"),
              priceAfterE18: BigInt(text(row, "price")),
            });
          }),
        }),
      );
    }
    return { assets, unknown, externalExcluded };
  }

  async function applyClaimTransition(
    client: DatabaseClient,
    claim: MiningClaimRecord,
    transition: Parameters<
      MiningSettlementRepository["transitionClaim"]
    >[0]["transition"],
  ): Promise<void> {
    const terminal =
      claim.status === "succeeded" ||
      claim.status === "failed" ||
      claim.status === "expired";
    if (transition.kind === "expired") {
      if (claim.status !== "claimable") return;
      await client.query({
        text: `update public.mining_claims set status = 'expired',
          failure_reason_code = 'MINING_CLAIM_EXPIRED', updated_at = clock_timestamp()
          where claim_id = $1`,
        values: [claim.claimId],
      });
      return;
    }
    const hash = transition.transactionHash;
    if (
      hash !== null &&
      claim.transactionHash !== null &&
      claim.transactionHash !== hash
    ) {
      throw new MiningSettlementConflictError(
        "MINING_CLAIM_TRANSACTION_CONFLICT",
      );
    }
    if (terminal) return;
    if (transition.kind === "submitted") {
      if (claim.status !== "claimable") return;
      await client.query({
        text: `update public.mining_claims set status = 'submitting',
          transaction_hash = $2, updated_at = clock_timestamp() where claim_id = $1`,
        values: [claim.claimId, hash],
      });
      return;
    }
    if (transition.kind === "confirming") {
      await client.query({
        text: `update public.mining_claims set status = 'confirming',
          transaction_hash = $2, block_number = $3::numeric,
          updated_at = clock_timestamp() where claim_id = $1`,
        values: [claim.claimId, hash, transition.blockNumber],
      });
      return;
    }
    if (transition.kind === "failed") {
      await client.query({
        text: `update public.mining_claims set status = 'failed',
          transaction_hash = coalesce($2, transaction_hash),
          block_number = coalesce($3::numeric, block_number),
          failure_reason_code = $4, updated_at = clock_timestamp()
          where claim_id = $1`,
        values: [
          claim.claimId,
          hash,
          transition.blockNumber,
          transition.reasonCode,
        ],
      });
      return;
    }
    // succeeded: the claimed event and the balance move in this transaction.
    await client.query({
      text: `update public.mining_claims set status = 'succeeded',
        transaction_hash = $2, block_number = $3::numeric,
        confirmed_delta_raw = $4::numeric, failure_reason_code = null,
        updated_at = clock_timestamp() where claim_id = $1`,
      values: [
        claim.claimId,
        hash,
        transition.blockNumber,
        transition.deltaRaw,
      ],
    });
    // A claim can only pay out settled rewards, so the balance row exists;
    // an UPDATE (not an upsert) keeps `claimed ≤ settled` checked on the
    // real row.
    const moved = await client.query<{ inserted: boolean; updated: boolean }>({
      text: `
        with inserted as (
          insert into public.mining_reward_ledger_events (
            event_id, owner_user_id, kind, amount_raw, claim_id
          )
          values ($1, $2, 'claimed', $3::numeric, $4)
          on conflict do nothing
          returning owner_user_id, amount_raw
        ), updated as (
          update public.mining_reward_balances b set
            claimed_total_raw = b.claimed_total_raw + i.amount_raw,
            updated_at = clock_timestamp()
          from inserted i where b.owner_user_id = i.owner_user_id
          returning b.owner_user_id
        )
        select exists (select 1 from inserted) as inserted,
          exists (select 1 from updated) as updated
      `,
      values: [randomUUID(), claim.userId, transition.deltaRaw, claim.claimId],
    });
    const row = moved.rows[0];
    if (row !== undefined && row.inserted && !row.updated) {
      throw new MiningSettlementUnavailableError();
    }
  }

  const repository: MiningSettlementRepository = {
    async listApprovedParameterVersions() {
      const rows = await query(
        `select ${versionColumns} from public.mining_parameter_versions
         where status = 'approved' order by effective_from`,
      );
      return Object.freeze(rows.map(mapVersion));
    },

    async listParameterVersions() {
      const rows = await query(
        `select ${versionColumns} from public.mining_parameter_versions
         order by created_at desc, version_id desc limit 50`,
      );
      return Object.freeze(rows.map(mapVersion));
    },

    async getParameterVersion(versionId) {
      try {
        return await readVersion(pool, versionId, false);
      } catch (error) {
        return translate(error);
      }
    },

    async listApprovedCommunityWeights() {
      const rows = await query(
        `select community_id, weight from public.community_mining_weights
         where status = 'approved' and weight is not null order by community_id`,
      );
      return Object.freeze(
        rows.map((row) =>
          Object.freeze({
            communityId: text(row, "community_id"),
            weight: text(row, "weight"),
          }),
        ),
      );
    },

    async findUnverifiedCommunityIds(communityIds) {
      if (communityIds.length === 0) return Object.freeze([]);
      const rows = await query(
        `select community_id::text as community_id from public.communities
         where verification_status = 'verified'
           and community_id::text = any($1::text[])`,
        [[...communityIds]],
      );
      const verified = new Set(rows.map((row) => text(row, "community_id")));
      return Object.freeze(communityIds.filter((id) => !verified.has(id)));
    },

    async findUnknownAssetIds(assetIds) {
      const unknown: string[] = [];
      for (const assetId of assetIds) {
        const { chainId, address } = splitAssetId(assetId);
        const rows = await query(
          `select 1 from public.launch2_instances where chain_id = $1 and meme_address = $2
           union all
           select 1 from public.meme_tokens where chain_id = $1 and token_address = $2
           limit 1`,
          [chainId, address],
        );
        if (rows.length === 0) unknown.push(assetId);
      }
      return Object.freeze(unknown);
    },

    async findVerifiedBoundAssetIds(assetIds) {
      if (assetIds.length === 0) return Object.freeze([]);
      const rows = await query(
        `select distinct bound_asset_key from public.communities
         where verification_status = 'verified'
           and bound_asset_key = any($1::text[])`,
        [[...assetIds]],
      );
      const bound = new Set(rows.map((row) => text(row, "bound_asset_key")));
      return Object.freeze(assetIds.filter((id) => bound.has(id)));
    },

    async listMiningPoolCandidates(input) {
      // Decision 0187: verified community × the launch2 MEME it binds.
      // Decision 0189: every other bound asset is an `external` row.
      const limit =
        input.limit === undefined || input.limit === null
          ? null
          : Math.max(1, Math.min(Math.trunc(input.limit), 10_000));
      const pattern =
        input.query === undefined || input.query === null
          ? null
          : `%${input.query.replace(/[\\%_]/gu, (match) => `\\${match}`)}%`;
      const rows = await query(
        `select * from (
           select c.community_id::text as community_id,
             c.name as community_name,
             c.bound_asset_key as asset_id,
             split_part(c.bound_asset_key, ':', 1) || ':'
               || split_part(c.bound_asset_key, ':', 2) as chain_id,
             split_part(c.bound_asset_key, ':', 3) as meme_address,
             case when i.instance_id is null then 'external' else 'platform'
               end as kind,
             coalesce(i.ticker, a.symbol) as ticker,
             i.instance_id::text as instance_id, i.launch_id,
             case
               when i.instance_id is not null then 'launch2'
               when exists (
                 select 1 from public.meme_tokens as t
                 where t.chain_id || ':' || t.token_address = c.bound_asset_key
               ) then 'meme_v1'
               -- Decision 0189: a registered, unblocked token on a chain the
               -- erc20_transfer lane indexes (openings + indexed transfers).
               when a.status is not null and a.status <> 'blocked'
                 and exists (
                   select 1 from public.indexer_checkpoints as k
                   where k.lane = 'erc20_transfer' and k.chain_id = a.chain_id
                 ) then 'erc20'
             end as settlement_source
           from public.communities c
           left join public.launch2_instances i
             on c.bound_asset_key = i.chain_id || ':' || i.meme_address
           left join public.assets a on a.asset_id = c.bound_asset_key
           where c.verification_status = 'verified'
             and c.bound_asset_key is not null
         ) as candidate
         where ($1::text is null or chain_id = $1)
           and ($2::text is null or meme_address = lower($2))
           and ($3::text is null or community_name ilike $3 or ticker ilike $3)
           and ($4::text is null or (community_name, community_id) > ($4, $5::text))
           and ($7::text is null or kind = $7)
         order by community_name, community_id
         limit $6`,
        [
          input.chainId ?? null,
          input.address ?? null,
          pattern,
          input.after?.communityName ?? null,
          input.after?.communityId ?? null,
          limit,
          input.kind ?? null,
        ],
      );
      return Object.freeze(
        rows.map((row) =>
          Object.freeze({
            communityId: text(row, "community_id"),
            communityName: text(row, "community_name"),
            assetId: text(row, "asset_id"),
            chainId: text(row, "chain_id"),
            memeAddress: text(row, "meme_address"),
            kind:
              text(row, "kind") === "platform"
                ? ("platform" as const)
                : ("external" as const),
            symbol: nullableText(row, "ticker"),
            instanceId: nullableText(row, "instance_id"),
            launchId: nullableText(row, "launch_id"),
            settlementSource: settlementSourceOf(
              nullableText(row, "settlement_source"),
            ),
          }),
        ),
      );
    },

    async readLaunch2Checkpoint(chainId) {
      const rows = await query(
        `select last_block_number::text as block_number, last_block_hash
         from public.indexer_checkpoints
         where lane = 'launch2_event' and chain_id = $1`,
        [chainId],
      );
      const row = rows[0];
      return row === undefined
        ? null
        : Object.freeze({
            blockNumber: text(row, "block_number"),
            blockHash: text(row, "last_block_hash"),
          });
    },

    async createParameterDraft(input) {
      try {
        return await withV2Transaction(pool, unavailable, async (client) => {
          const exists = await client.query({
            text: `select 1 from public.mining_parameter_versions where config_version = $1`,
            values: [input.configVersion],
          });
          if (exists.rows.length > 0) {
            throw new MiningSettlementConflictError(
              "ADMIN_MINING_PARAMETERS_VERSION_EXISTS",
            );
          }
          const versionId = randomUUID();
          await client.query({
            text: `
              insert into public.mining_parameter_versions (
                version_id, config_version, document, effective_from,
                draft_author_actor, draft_author_account_id
              ) values ($1, $2, $3::jsonb, $4::timestamptz, $5, $6)
            `,
            values: [
              versionId,
              input.configVersion,
              JSON.stringify(input.document),
              input.effectiveFrom,
              input.author.actor,
              input.author.accountId,
            ],
          });
          const version = (await readVersion(
            client,
            versionId,
            false,
          )) as MiningParameterVersionRecord;
          const audit = await insertAudit(client, {
            ...input.audit,
            targetId: versionId,
            after: {
              versionId,
              configVersion: input.configVersion,
              effectiveFrom: version.effectiveFrom,
            },
          });
          return Object.freeze({ version, audit });
        });
      } catch (error) {
        return translate(error);
      }
    },

    async approveParameterVersion(input) {
      try {
        return await withV2Transaction(pool, unavailable, async (client) => {
          await assertApproverActive(client, input.approver.accountId);
          const current = await readVersion(client, input.versionId, true);
          if (current === null) {
            throw new MiningSettlementConflictError(
              "ADMIN_MINING_PARAMETERS_NOT_FOUND",
            );
          }
          if (current.status !== "pending_approval") {
            throw new MiningSettlementConflictError(
              "ADMIN_MINING_PARAMETERS_STATE",
            );
          }
          if (current.document.assetPowerBasis !== "quantity") {
            // Decision 0123: a draft written under the 0116 valuation rule
            // (no assetPowerBasis) can only be withdrawn and redrafted.
            throw new MiningSettlementConflictError(
              "ADMIN_MINING_PARAMETERS_BASIS_RETIRED",
            );
          }
          // Decision 0183: every listed community must still exist and be
          // verified when the version is approved.
          // Decision 0187: the excluded communities too.
          const listed = [
            ...new Set([
              ...current.document.communityCoefficients.map(
                (entry) => entry.communityId,
              ),
              ...(current.document.excludedCommunities ?? []),
            ]),
          ];
          if (listed.length > 0) {
            const found = await client.query<{ community_id: string }>({
              text: `select community_id::text as community_id
                from public.communities
                where verification_status = 'verified'
                  and community_id::text = any($1::text[])`,
              values: [listed],
            });
            const verified = new Set(found.rows.map((row) => row.community_id));
            const unknown = listed.filter((id) => !verified.has(id));
            if (unknown.length > 0)
              throw new MiningCommunityUnknownError(unknown);
          }
          if (
            current.draftAuthor?.accountId !== null &&
            current.draftAuthor?.accountId === input.approver.accountId
          ) {
            throw new MiningSettlementConflictError(
              adminReasonCodes.formulaSelfApproval,
            );
          }
          const timing = await client.query<{ past: boolean }>({
            text: `select $1::timestamptz < clock_timestamp() as past`,
            values: [current.effectiveFrom],
          });
          if (timing.rows[0]?.past === true) {
            throw new MiningSettlementConflictError(
              "ADMIN_MINING_PARAMETERS_EFFECTIVE_PASSED",
            );
          }
          const clash = await client.query({
            text: `select 1 from public.mining_parameter_versions
              where status = 'approved' and effective_from = $1::timestamptz`,
            values: [current.effectiveFrom],
          });
          if (clash.rows.length > 0) {
            throw new MiningSettlementConflictError(
              "ADMIN_MINING_PARAMETERS_EFFECTIVE_TAKEN",
            );
          }
          await client.query({
            text: `
              update public.mining_parameter_versions set
                status = 'approved', approved_by = $2,
                approved_by_account_id = $3, approved_at = clock_timestamp(),
                requested_audit_id = $4, updated_at = clock_timestamp()
              where version_id = $1
            `,
            values: [
              current.versionId,
              input.approver.actor,
              input.approver.accountId,
              input.requestedAuditId,
            ],
          });
          const version = (await readVersion(
            client,
            current.versionId,
            false,
          )) as MiningParameterVersionRecord;
          const audit = await insertAudit(client, {
            ...input.audit,
            before: { status: current.status },
            after: {
              status: version.status,
              configVersion: version.configVersion,
              effectiveFrom: version.effectiveFrom,
              draftAuthor: current.draftAuthor,
              approvedBy: version.approvedBy,
              requestedAuditId: input.requestedAuditId,
            },
          });
          return Object.freeze({ version, audit });
        });
      } catch (error) {
        return translate(error);
      }
    },

    async withdrawParameterVersion(input) {
      try {
        return await withV2Transaction(pool, unavailable, async (client) => {
          const current = await readVersion(client, input.versionId, true);
          if (current === null) {
            throw new MiningSettlementConflictError(
              "ADMIN_MINING_PARAMETERS_NOT_FOUND",
            );
          }
          if (current.status !== "pending_approval") {
            throw new MiningSettlementConflictError(
              "ADMIN_MINING_PARAMETERS_STATE",
            );
          }
          await client.query({
            text: `update public.mining_parameter_versions set status = 'withdrawn',
              updated_at = clock_timestamp() where version_id = $1`,
            values: [current.versionId],
          });
          const version = (await readVersion(
            client,
            current.versionId,
            false,
          )) as MiningParameterVersionRecord;
          const audit = await insertAudit(client, {
            ...input.audit,
            before: { status: current.status },
            after: { status: version.status },
          });
          return Object.freeze({ version, audit });
        });
      } catch (error) {
        return translate(error);
      }
    },

    async recordAudit(input) {
      try {
        return await insertAudit(pool, input);
      } catch (error) {
        return translate(error);
      }
    },

    async readIndexerFreshness(input) {
      const memeAddresses = input.assetIds
        .map(splitAssetId)
        .filter((asset) => asset.chainId === input.chainId)
        .map((asset) => asset.address);
      const rows = await query(
        `
          select
            exists (select 1 from public.launch2_instances where chain_id = $1) as launch2_sources,
            exists (select 1 from public.meme_tokens
              where chain_id = $1 and token_address = any($2::text[])) as meme_sources,
            (select updated_at from public.indexer_checkpoints
              where lane = 'launch2_event' and chain_id = $1) as launch2_at,
            (select updated_at from public.indexer_checkpoints
              where lane = 'meme_event' and chain_id = $1) as meme_at
        `,
        [input.chainId, memeAddresses],
      );
      const row = rows[0] as Row;
      // Decision 0189: the erc20_transfer lane of every chain an admitted
      // external `erc20` token lives on (separate: stale → those assets
      // leave the hour, nothing else waits).
      const externalIds = [...new Set(input.externalAssetIds ?? [])].filter(
        (assetId) => input.assetIds.includes(assetId),
      );
      const erc20Lanes =
        externalIds.length === 0
          ? []
          : await query(
              `select a.chain_id, k.updated_at,
                 array_agg(a.asset_id order by a.asset_id) as asset_ids
               from public.assets a
               join public.indexer_checkpoints k
                 on k.lane = 'erc20_transfer' and k.chain_id = a.chain_id
               where a.asset_id = any($1::text[]) and a.status <> 'blocked'
                 and not exists (
                   select 1 from public.meme_tokens t
                   where t.chain_id = $2
                     and t.chain_id || ':' || t.token_address = a.asset_id
                 )
                 and not exists (
                   select 1 from public.launch2_instances i
                   where i.chain_id = $2
                     and i.chain_id || ':' || i.meme_address = a.asset_id
                 )
               group by a.chain_id, k.updated_at
               order by a.chain_id`,
              [externalIds.sort(), input.chainId],
            );
      return Object.freeze({
        lanes: Object.freeze([
          Object.freeze({
            lane: "launch2_event",
            hasSources: row["launch2_sources"] === true,
            updatedAt: nullableIso(row, "launch2_at"),
          }),
          Object.freeze({
            lane: "meme_event",
            hasSources: row["meme_sources"] === true,
            updatedAt: nullableIso(row, "meme_at"),
          }),
          ...erc20Lanes.map((lane) =>
            Object.freeze({
              lane: "erc20_transfer",
              hasSources: true,
              updatedAt: nullableIso(lane, "updated_at"),
              chainId: text(lane, "chain_id"),
              externalAssetIds: Object.freeze(
                [...(lane["asset_ids"] as string[])].sort(),
              ),
            }),
          ),
        ]),
      });
    },

    async readSettlementFacts(input) {
      if (typeof input.embeddedWalletOnly !== "boolean") {
        throw new TypeError("embeddedWalletOnly must be a boolean");
      }
      const embeddedWalletOnly = input.embeddedWalletOnly;
      const start = isoOf(input.hourStart);
      const end = isoOf(input.hourEnd);
      const instances = await query(
        `
          select i.instance_id, i.chain_id || ':' || i.meme_address as asset_id,
            coalesce(array_agg(c.community_id::text order by c.community_id)
              filter (where c.community_id is not null), '{}') as community_ids
          from public.launch2_instances i
          left join public.communities c
            on c.bound_asset_key = i.chain_id || ':' || i.meme_address
              and c.verification_status = 'verified'
          where i.chain_id = $1
          group by i.instance_id, i.chain_id, i.meme_address
          order by i.instance_id
        `,
        [input.chainId],
      );
      const openings = await query(
        `
          select instance_id, holder, sum(delta)::text as n from (
            select instance_id, payload ->> 'to' as holder, 1 as delta
            from public.launch2_events
            where chain_id = $1 and not removed and event_name = 'Transfer'
              and event_at < $2::timestamptz and payload ->> 'to' <> $3
            union all
            select instance_id, payload ->> 'from', -1
            from public.launch2_events
            where chain_id = $1 and not removed and event_name = 'Transfer'
              and event_at < $2::timestamptz and payload ->> 'from' <> $3
          ) moves
          group by instance_id, holder having sum(delta) <> 0
        `,
        [input.chainId, start, zeroAddress],
      );
      const moves = await query(
        `
          select instance_id, payload ->> 'from' as from_address,
            payload ->> 'to' as to_address,
            extract(epoch from event_at)::bigint::text as at,
            block_number::text as block_number, log_index
          from public.launch2_events
          where chain_id = $1 and not removed and event_name = 'Transfer'
            and event_at >= $2::timestamptz and event_at < $3::timestamptz
          order by block_number, log_index
        `,
        [input.chainId, start, end],
      );
      for (const row of openings) {
        if (BigInt(text(row, "n")) < 0n) {
          throw new MiningSettlementInputError(
            miningSettlementReasonCodes.inputInvalid,
            "negative NFT balance",
          );
        }
      }
      const { assets, unknown, externalExcluded } = await assetFacts({
        chainId: input.chainId,
        hourStart: input.hourStart,
        hourEnd: input.hourEnd,
        assetIds: input.assetIds,
        embeddedWalletOnly,
        ...(input.external === undefined ? {} : { external: input.external }),
      });
      const addresses = new Set<string>();
      for (const row of openings) addresses.add(text(row, "holder"));
      for (const row of moves) {
        for (const key of ["from_address", "to_address"]) {
          const value = nullableText(row, key);
          if (value !== null && value !== zeroAddress) addresses.add(value);
        }
      }
      for (const asset of assets) {
        for (const opening of asset.openingBalances) {
          addresses.add(opening.address);
        }
        for (const move of asset.moves) addresses.add(move.address);
        for (const holder of asset.unknownHolders ?? []) {
          addresses.add(holder.address);
        }
      }
      const owners = await query(
        `select address, array_agg(distinct owner_user_id::text order by owner_user_id::text) as users
         from public.account_wallets
         where status = 'active'
           -- Decision 0184: embedded-only only when MINING_EMBEDDED_WALLET_ONLY.
           and ($3::boolean is false or kind = 'embedded')
           and address = any($1::text[])
           and first_seen_at < $2::timestamptz
         group by address`,
        [[...addresses].sort(), end, embeddedWalletOnly],
      );
      const edges = await query(
        `select inviter_user_id, invitee_user_id, depth,
           extract(epoch from effective_from)::bigint::text as from_s,
           extract(epoch from effective_to)::bigint::text as to_s
         from public.referral_edges
         where effective_from < $2::timestamptz
           and (effective_to is null or effective_to > $1::timestamptz)
         order by inviter_user_id, invitee_user_id, depth, effective_from`,
        [start, end],
      );
      // Decision 0183: verified communities bound to the MEMEs this hour
      // reads (every launch2 instance's MEME and every admitted asset), and
      // the membership intervals of those communities overlapping the hour.
      // The creator counts as a member from the community's creation.
      const gatedAssetIds = [
        ...new Set([
          ...instances.map((row) => text(row, "asset_id")),
          ...input.assetIds,
        ]),
      ].sort();
      const bindings = await query(
        `select bound_asset_key as asset_id,
           array_agg(community_id::text order by community_id) as community_ids
         from public.communities
         where verification_status = 'verified'
           and bound_asset_key = any($1::text[])
         group by bound_asset_key
         order by bound_asset_key`,
        [gatedAssetIds],
      );
      const memberships = await query(
        `with gated as (
           select community_id, created_by_user_id, created_at
           from public.communities
           where verification_status = 'verified'
             and bound_asset_key = any($1::text[])
         )
         select h.user_id::text as user_id, h.community_id::text as community_id,
           ceil(extract(epoch from h.joined_at))::bigint::text as from_s,
           floor(extract(epoch from h.left_at))::bigint::text as to_s
         from public.community_membership_history h
         join gated g on g.community_id = h.community_id
         where h.joined_at < $3::timestamptz
           and (h.left_at is null or h.left_at > $2::timestamptz)
         union all
         select g.created_by_user_id::text, g.community_id::text,
           ceil(extract(epoch from g.created_at))::bigint::text, null
         from gated g
         where g.created_at < $3::timestamptz
         order by 1, 2, 3`,
        [gatedAssetIds, start, end],
      );
      return Object.freeze({
        walletKinds: embeddedWalletOnly ? "embedded" : "all",
        membershipGate: Object.freeze({
          assetCommunities: bindings.map((row) =>
            Object.freeze({
              assetId: text(row, "asset_id"),
              communityIds: Object.freeze(row["community_ids"] as string[]),
            }),
          ),
          memberships: memberships.map((row) =>
            Object.freeze({
              userId: text(row, "user_id"),
              communityId: text(row, "community_id"),
              from: epochSeconds(row, "from_s"),
              to: row["to_s"] === null ? null : epochSeconds(row, "to_s"),
            }),
          ),
        }),
        nftInstances: instances.map((row) =>
          Object.freeze({
            instanceId: text(row, "instance_id"),
            memeAssetId: text(row, "asset_id"),
            communityIds: Object.freeze(row["community_ids"] as string[]),
          }),
        ),
        nftOpenings: openings.map((row) =>
          Object.freeze({
            instanceId: text(row, "instance_id"),
            address: text(row, "holder"),
            count: BigInt(text(row, "n")),
          }),
        ),
        nftMoves: moves.map((row) => {
          const from = nullableText(row, "from_address");
          const to = nullableText(row, "to_address");
          return Object.freeze({
            instanceId: text(row, "instance_id"),
            from: from === null || from === zeroAddress ? null : from,
            to: to === null || to === zeroAddress ? null : to,
            at: epochSeconds(row, "at"),
            blockNumber: BigInt(text(row, "block_number")),
            logIndex: Number(row["log_index"]),
          });
        }),
        assets,
        unknownAssetIds: unknown,
        ...(input.external === undefined
          ? {}
          : {
              externalExcludedAssets: externalExcluded.map((row) =>
                Object.freeze(row),
              ),
            }),
        walletOwners: owners.map((row) =>
          Object.freeze({
            address: text(row, "address"),
            userIds: Object.freeze(row["users"] as string[]),
          }),
        ),
        referralEdges: edges.map((row) =>
          Object.freeze({
            inviterUserId: text(row, "inviter_user_id"),
            inviteeUserId: text(row, "invitee_user_id"),
            depth: Number(row["depth"]),
            from: epochSeconds(row, "from_s"),
            to: row["to_s"] === null ? null : epochSeconds(row, "to_s"),
          }),
        ),
      });
    },

    async getEpochByHour(hourStart) {
      const rows = await query(
        `select ${epochColumns} from public.mining_epochs where hour_start = $1::timestamptz`,
        [hourStart],
      );
      return rows[0] === undefined ? null : mapEpoch(rows[0]);
    },

    async getEpoch(epochId) {
      const rows = await query(
        `select ${epochColumns} from public.mining_epochs where epoch_id = $1`,
        [epochId],
      );
      return rows[0] === undefined ? null : mapEpoch(rows[0]);
    },

    async recordEpochFailure(input) {
      const rows = await query(
        `
          insert into public.mining_epochs (
            epoch_id, hour_start, hour_end, idempotency_key, status, trigger,
            version_id, failure_reason_code, attempt_count, input_summary
          ) values ($1, $2::timestamptz, $3::timestamptz, $4, 'failed', $5, $6, $7, 1, $8::jsonb)
          on conflict (hour_start) do update set
            status = 'failed', trigger = excluded.trigger,
            version_id = excluded.version_id,
            failure_reason_code = excluded.failure_reason_code,
            attempt_count = public.mining_epochs.attempt_count + 1,
            input_summary = excluded.input_summary,
            updated_at = clock_timestamp()
          where public.mining_epochs.status <> 'settled'
          returning ${epochColumns}
        `,
        [
          randomUUID(),
          input.hourStart,
          input.hourEnd,
          `mining_hourly:${input.hourStart}`,
          input.trigger,
          input.versionId,
          input.reasonCode,
          JSON.stringify(input.inputSummary),
        ],
      );
      if (rows[0] !== undefined) return mapEpoch(rows[0]);
      const existing = await repository.getEpochByHour(input.hourStart);
      if (existing === null) throw unavailable();
      return existing;
    },

    async commitEpoch(input) {
      try {
        return await withV2Transaction(pool, unavailable, async (client) => {
          await client.query({
            text: `
              insert into public.mining_epochs (
                epoch_id, hour_start, hour_end, idempotency_key, status, trigger, version_id
              ) values ($1, $2::timestamptz, $3::timestamptz, $4, 'pending', $5, $6)
              on conflict (hour_start) do nothing
            `,
            values: [
              randomUUID(),
              input.hourStart,
              input.hourEnd,
              `mining_hourly:${input.hourStart}`,
              input.trigger,
              input.versionId,
            ],
          });
          const locked = await client.query<Row>({
            text: `select ${epochColumns} from public.mining_epochs
              where hour_start = $1::timestamptz for update`,
            values: [input.hourStart],
          });
          const current = mapEpoch(locked.rows[0] as Row);
          if (current.status === "settled") {
            return Object.freeze({ created: false, epoch: current });
          }
          await client.query({
            text: `update public.mining_epochs set status = 'settling',
              trigger = $2, version_id = $3, updated_at = clock_timestamp()
              where epoch_id = $1`,
            values: [current.epochId, input.trigger, input.versionId],
          });
          const payload = JSON.stringify(
            input.rewards.map((reward) => ({
              owner_user_id: reward.userId,
              nft_self_power: reward.nftSelfPower,
              asset_self_power: reward.assetSelfPower,
              nft_referral_power: reward.nftReferralPower,
              asset_referral_power: reward.assetReferralPower,
              nft_total_power: reward.nftTotalPower,
              asset_total_power: reward.assetTotalPower,
              referral_levels: reward.levels,
              nft_holdings: reward.nftHoldings,
              asset_holdings: reward.assetHoldings,
              nft_reward_raw: reward.nftRewardRaw,
              asset_reward_raw: reward.assetRewardRaw,
              total_reward_raw: reward.totalRewardRaw,
            })),
          );
          await client.query({
            text: `
              insert into public.mining_epoch_rewards (
                epoch_id, owner_user_id, nft_self_power, asset_self_power,
                nft_referral_power, asset_referral_power, nft_total_power,
                asset_total_power, referral_levels, nft_holdings, asset_holdings,
                nft_reward_raw, asset_reward_raw, total_reward_raw
              )
              select $1, r.owner_user_id, r.nft_self_power, r.asset_self_power,
                r.nft_referral_power, r.asset_referral_power, r.nft_total_power,
                r.asset_total_power, r.referral_levels, r.nft_holdings,
                r.asset_holdings, r.nft_reward_raw::numeric,
                r.asset_reward_raw::numeric, r.total_reward_raw::numeric
              from jsonb_to_recordset($2::jsonb) as r(
                owner_user_id uuid, nft_self_power text, asset_self_power text,
                nft_referral_power text, asset_referral_power text,
                nft_total_power text, asset_total_power text,
                referral_levels jsonb, nft_holdings jsonb, asset_holdings jsonb,
                nft_reward_raw text, asset_reward_raw text, total_reward_raw text)
            `,
            values: [current.epochId, payload],
          });
          await client.query({
            text: `
              with inserted as (
                insert into public.mining_reward_ledger_events (
                  event_id, owner_user_id, kind, amount_raw, epoch_id
                )
                select gen_random_uuid(), r.owner_user_id, 'settled',
                  r.total_reward_raw::numeric, $1
                from jsonb_to_recordset($2::jsonb) as r(owner_user_id uuid, total_reward_raw text)
                where r.total_reward_raw::numeric > 0
                on conflict do nothing
                returning owner_user_id, amount_raw
              )
              insert into public.mining_reward_balances (owner_user_id, settled_total_raw)
              select owner_user_id, amount_raw from inserted
              on conflict (owner_user_id) do update set
                settled_total_raw = public.mining_reward_balances.settled_total_raw
                  + excluded.settled_total_raw,
                updated_at = clock_timestamp()
            `,
            values: [current.epochId, payload],
          });
          const settled = await client.query<Row>({
            text: `
              update public.mining_epochs set
                status = 'settled', settled_at = clock_timestamp(),
                budget_nft_raw = $2::numeric, budget_asset_raw = $3::numeric,
                denominator_nft_power = $4, denominator_asset_power = $5,
                allocated_nft_raw = $6::numeric, allocated_asset_raw = $7::numeric,
                unallocated_nft_raw = $8::numeric, unallocated_asset_raw = $9::numeric,
                user_count = $10, input_digest = $11, input_summary = $12::jsonb,
                failure_reason_code = null, attempt_count = attempt_count + 1,
                updated_at = clock_timestamp()
              where epoch_id = $1
              returning ${epochColumns}
            `,
            values: [
              current.epochId,
              input.budgetNftRaw,
              input.budgetAssetRaw,
              input.denominatorNftPower,
              input.denominatorAssetPower,
              input.allocatedNftRaw,
              input.allocatedAssetRaw,
              input.unallocatedNftRaw,
              input.unallocatedAssetRaw,
              input.rewards.length,
              input.inputDigest,
              JSON.stringify(input.inputSummary),
            ],
          });
          return Object.freeze({
            created: true,
            epoch: mapEpoch(settled.rows[0] as Row),
          });
        });
      } catch (error) {
        return translate(error);
      }
    },

    async listEpochs(input) {
      const rows = await query(
        `select ${epochColumns} from public.mining_epochs
         where ($1::timestamptz is null or hour_start < $1::timestamptz)
         order by hour_start desc limit $2`,
        [input.beforeHourStart, input.limit],
      );
      return Object.freeze(rows.map(mapEpoch));
    },

    async listEpochRewards(input) {
      const rows = await query(
        `select ${rewardColumns} from public.mining_epoch_rewards r
         join public.mining_epochs e on e.epoch_id = r.epoch_id
         where r.epoch_id = $1 order by r.owner_user_id`,
        [input.epochId],
      );
      return Object.freeze(rows.map(mapReward));
    },

    async latestSettledEpoch() {
      const rows = await query(
        `select ${epochColumns} from public.mining_epochs
         where status = 'settled' order by hour_start desc limit 1`,
      );
      return rows[0] === undefined ? null : mapEpoch(rows[0]);
    },

    async totalUnclaimedRaw() {
      const rows = await query(
        `select coalesce(sum(unclaimed_raw), 0)::text as total from public.mining_reward_balances`,
      );
      return text(rows[0] as Row, "total");
    },

    async getBalance(userId) {
      const rows = await query(
        `select settled_total_raw::text, claimed_total_raw::text, unclaimed_raw::text
         from public.mining_reward_balances where owner_user_id = $1`,
        [userId],
      );
      const row = rows[0];
      return Object.freeze({
        settledTotalRaw:
          row === undefined ? "0" : text(row, "settled_total_raw"),
        claimedTotalRaw:
          row === undefined ? "0" : text(row, "claimed_total_raw"),
        unclaimedRaw: row === undefined ? "0" : text(row, "unclaimed_raw"),
      });
    },

    async getUserEpochReward(userId, epochId) {
      const rows = await query(
        `select ${rewardColumns} from public.mining_epoch_rewards r
         join public.mining_epochs e on e.epoch_id = r.epoch_id
         where r.epoch_id = $1 and r.owner_user_id = $2`,
        [epochId, userId],
      );
      return rows[0] === undefined ? null : mapReward(rows[0]);
    },

    async listUserEpochRewards(input) {
      const rows = await query(
        `select ${rewardColumns} from public.mining_epoch_rewards r
         join public.mining_epochs e on e.epoch_id = r.epoch_id
         where r.owner_user_id = $1 and e.status = 'settled'
           and ($2::timestamptz is null or e.hour_start < $2::timestamptz)
           -- Decision 0125 (S138 D2): a zero-power hour is not listed.
           and (r.nft_total_power::numeric > 0 or r.asset_total_power::numeric > 0
             or r.total_reward_raw > 0)
         order by e.hour_start desc limit $3`,
        [input.userId, input.beforeHourStart, input.limit],
      );
      return Object.freeze(rows.map(mapReward));
    },

    async listUserClaimWallets(userId) {
      const rows = await query(
        `select distinct wallet_address from public.mining_claims
         where owner_user_id = $1 order by wallet_address`,
        [userId],
      );
      return Object.freeze(rows.map((row) => text(row, "wallet_address")));
    },

    async listOpenClaims(userId) {
      const rows = await query(
        `select ${claimColumns} from public.mining_claims
         where owner_user_id = $1 and status in ('claimable', 'submitting', 'confirming')
         order by created_at desc`,
        [userId],
      );
      return Object.freeze(rows.map(mapClaim));
    },

    async createClaim(input) {
      try {
        const claimed = await withV2Transaction(
          pool,
          unavailable,
          async (client) => {
            await lockV2Owner(client, input.userId, unavailable);
            const recordId = await claimV2Command(
              client,
              {
                ownerUserId: input.userId,
                scope: claimPrepareScope,
                digestVersion: miningClaimPrepareDigestVersion,
                idempotencyKey: input.idempotencyKey,
                requestSha256: input.requestSha256,
              },
              () => new MiningClaimIdempotencyConflictError(),
            );
            const existing = await client.query<Row>({
              text: `select ${claimColumns} from public.mining_claims where idempotency_record_id = $1`,
              values: [recordId],
            });
            return {
              recordId,
              existing:
                existing.rows[0] === undefined
                  ? null
                  : mapClaim(existing.rows[0]),
            };
          },
        );
        if (claimed.existing !== null) {
          return Object.freeze({ created: false, claim: claimed.existing });
        }
        let built: CreateMiningClaimRecord;
        try {
          built = await input.build();
        } catch (error) {
          throw new CallerCallbackError(error);
        }
        return await withV2Transaction(pool, unavailable, async (client) => {
          await lockV2Owner(client, input.userId, unavailable);
          const raced = await client.query<Row>({
            text: `select ${claimColumns} from public.mining_claims where idempotency_record_id = $1`,
            values: [claimed.recordId],
          });
          if (raced.rows[0] !== undefined) {
            return Object.freeze({
              created: false,
              claim: mapClaim(raced.rows[0]),
            });
          }
          // Re-checked under the owner lock: no claim in flight, and no live
          // voucher for another wallet (it could still land on chain).
          const busy = await client.query({
            text: `
              select 1 from public.mining_claims
              where owner_user_id = $1 and (
                status in ('submitting', 'confirming')
                or (status = 'claimable' and wallet_address <> $2
                    and deadline + interval '60 seconds' > clock_timestamp()))
              limit 1
            `,
            values: [input.userId, built.walletAddress],
          });
          if (busy.rows.length > 0) {
            throw new MiningSettlementConflictError("MINING_CLAIM_IN_FLIGHT");
          }
          const inserted = await client.query<Row>({
            text: `
              insert into public.mining_claims (
                claim_id, owner_user_id, idempotency_record_id, wallet_id,
                wallet_address, chain_id, contract_address, cumulative_amount_raw,
                expected_delta_raw, nonce, deadline, signature, signer_address,
                prepared_block_number, unsigned_transaction
              ) values ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::numeric,
                $10::numeric, $11::timestamptz, $12, $13, $14::numeric, $15::jsonb)
              returning ${claimColumns}
            `,
            values: [
              built.claimId,
              input.userId,
              claimed.recordId,
              built.walletId,
              built.walletAddress,
              built.chainId,
              built.contractAddress,
              built.cumulativeAmountRaw,
              built.expectedDeltaRaw,
              built.nonce,
              built.deadline,
              built.signature,
              built.signerAddress,
              built.preparedBlockNumber,
              JSON.stringify(built.unsignedTransaction),
            ],
          });
          return Object.freeze({
            created: true,
            claim: mapClaim(inserted.rows[0] as Row),
          });
        });
      } catch (error) {
        return translate(error);
      }
    },

    async getClaim(userId, claimId) {
      const rows = await query(
        `select ${claimColumns} from public.mining_claims
         where owner_user_id = $1 and claim_id = $2`,
        [userId, claimId],
      );
      return rows[0] === undefined ? null : mapClaim(rows[0]);
    },

    async claimReportCommand(input) {
      try {
        await withV2Transaction(pool, unavailable, async (client) => {
          await claimV2Command(
            client,
            {
              ownerUserId: input.userId,
              scope: claimReportScope,
              digestVersion: miningClaimReportDigestVersion,
              idempotencyKey: input.idempotencyKey,
              requestSha256: input.requestSha256,
            },
            () => new MiningClaimIdempotencyConflictError(),
          );
        });
      } catch (error) {
        return translate(error);
      }
    },

    async transitionClaim(input) {
      try {
        return await withV2Transaction(pool, unavailable, async (client) => {
          const locked = await client.query<Row>({
            text: `select ${claimColumns} from public.mining_claims where claim_id = $1 for update`,
            values: [input.claimId],
          });
          if (locked.rows[0] === undefined) throw unavailable();
          await applyClaimTransition(
            client,
            mapClaim(locked.rows[0]),
            input.transition,
          );
          const after = await client.query<Row>({
            text: `select ${claimColumns} from public.mining_claims where claim_id = $1`,
            values: [input.claimId],
          });
          return mapClaim(after.rows[0] as Row);
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new MiningSettlementConflictError(
            "MINING_CLAIM_TRANSACTION_CONFLICT",
          );
        }
        return translate(error);
      }
    },

    async listClaims(input) {
      const rows = await query(
        `select ${claimColumns} from public.mining_claims
         where owner_user_id = $1
           and ($2::timestamptz is null or (created_at, claim_id) < ($2::timestamptz, $3::uuid))
         order by created_at desc, claim_id desc limit $4`,
        [input.userId, input.beforeCreatedAt, input.beforeClaimId, input.limit],
      );
      return Object.freeze(rows.map(mapClaim));
    },

    async listUnresolvedClaims(limit) {
      const rows = await query(
        `select ${claimColumns} from public.mining_claims
         where status in ('claimable', 'submitting', 'confirming')
         order by updated_at limit $1`,
        [limit],
      );
      return Object.freeze(rows.map(mapClaim));
    },
  };
  return Object.freeze(repository);
}
