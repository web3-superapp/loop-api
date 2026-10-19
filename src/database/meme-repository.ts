import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import { launchChainIds } from "../features/chain/chain-contract.js";
import {
  memeIntentKinds,
  memeIntentStates,
  memeOnChainStatuses,
  memeRules,
  memeTokenStatuses,
  type MemeTokenStatus,
} from "../features/meme/meme-contract.js";
import {
  memeSaleSupply,
  memeT0,
  memeV0,
} from "../features/meme/meme-curve-math.js";
import {
  MemeCreateIntentInFlightError,
  MemeCreateRateLimitedError,
  MemeIdempotencyConflictError,
  MemeImageNotOwnedError,
  MemeIntentReportConflictError,
  MemeRepositoryUnavailableError,
  MemeTokenNotDraftError,
  memeCreateDigestVersion,
  memeCreateIdempotencyScope,
  memeEventLane,
  memeIntentDigestVersion,
  memeIntentIdempotencyScope,
  type CommitMemeSegmentInput,
  type CreateMemeIntentRecord,
  type MemeBestTradeRecord,
  type MemeCandleRecord,
  type MemeCheckpointRecord,
  type MemeCreatorProjection,
  type MemeHolderRecord,
  type MemeIntentReceipt,
  type MemeIntentRecord,
  type MemeLaneEventInput,
  type MemeRepository,
  type MemeSaltScope,
  type MemeTokenListRecord,
  type MemeTokenRecord,
  type MemeTradeRecord,
} from "../features/meme/meme-repository.js";
import type { CanaryExposureAdmission } from "../features/wallet-intents/intent-contract.js";
import {
  claimV2Command,
  lockV2Owner,
  toIsoString,
  toNullableIsoString,
  withV2Transaction,
  type DatabaseClient,
} from "./v2-command-support.js";
import {
  admitCanaryExposure,
  sumCanaryExposureUsd,
} from "./canary-exposure.js";

/**
 * PostgreSQL side of the MEME launchpad (Decision 0101). The `meme_event`
 * lane commits a segment in one transaction: rewind, raw events and
 * trades, the derived token / holder projections of every touched token,
 * Intent confirmations, and the checkpoint. Projections are recomputed
 * from the stored logs, never incremented, so a replayed or rewound
 * segment converges to the same rows.
 */

const uuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
const uuidV4Schema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const addressSchema = z.string().regex(/^0x[0-9a-f]{40}$/u);
const bytes32Schema = z.string().regex(/^0x[0-9a-f]{64}$/u);
const blockSchema = z.string().regex(/^(0|[1-9][0-9]{0,18})$/u);
const rawSchema = z.string().regex(/^(0|[1-9][0-9]{0,77})$/u);
const chainIdSchema = z.enum(launchChainIds);
const dateSchema = z.date();

function unavailable(): MemeRepositoryUnavailableError {
  return new MemeRepositoryUnavailableError();
}

class CallerCallbackError extends Error {
  constructor(readonly callerError: unknown) {
    super("Caller callback failed");
    this.name = "CallerCallbackError";
  }
}

function translate(error: unknown): never {
  if (error instanceof CallerCallbackError) {
    throw error.callerError;
  }
  if (
    error instanceof MemeRepositoryUnavailableError ||
    error instanceof MemeIdempotencyConflictError ||
    error instanceof MemeCreateRateLimitedError ||
    error instanceof MemeImageNotOwnedError ||
    error instanceof MemeIntentReportConflictError ||
    error instanceof MemeCreateIntentInFlightError ||
    error instanceof MemeTokenNotDraftError
  ) {
    throw error;
  }
  throw new MemeRepositoryUnavailableError({ cause: error });
}

// ---------------------------------------------------------------------------
// Token projection
// ---------------------------------------------------------------------------

const tokenColumns = `
  t.meme_token_id, t.chain_id, t.contract_address, t.contract_version,
  t.creator_user_id, t.creator_wallet,
  cp.public_profile_id::text as creator_public_profile_id,
  cp.alias as creator_alias, cp.avatar_ref as creator_avatar_ref,
  t.name, t.symbol, t.description, t.image_media_id::text as image_media_id,
  t.links, t.metadata_hash, t.salt, t.predicted_address, t.vanity,
  t.token_address, t.asset_id, t.status,
  t.created_block::text as created_block, t.created_tx_hash, t.chain_created_at,
  t.v_usd1::text as v_usd1, t.v_token::text as v_token,
  t.real_usd1::text as real_usd1, t.sold::text as sold,
  t.holder_count, t.trade_count, t.last_trade_at, t.full_at, t.graduated_at,
  t.pool_address, t.graduation_tx_hash, t.lp_token_id::text as lp_token_id,
  t.usd1_to_pool::text as usd1_to_pool, t.tokens_to_pool::text as tokens_to_pool,
  t.graduation_fee_usd1::text as graduation_fee_usd1,
  t.residual_usd1::text as residual_usd1, t.residual_tokens::text as residual_tokens,
  t.graduation_attempts, t.graduation_needs_operator, t.created_at, t.updated_at,
  t.listing, t.listing_reason_code, t.listing_reason_text
`;

const tokenFrom = `
  public.meme_tokens as t
  left join public.user_profiles as cp
    on cp.owner_user_id = t.creator_user_id and cp.profile_status = 'active'
`;

/** Trade aggregates for list rows; `$now` must be bound by the caller. */
function statsJoin(nowParameter: string): string {
  return `
    left join lateral (
      select coalesce(sum(tr.usd1_amount), 0)::text as volume_24h
      from public.meme_trades as tr
      where tr.meme_token_id = t.meme_token_id and not tr.removed
        and tr.traded_at > ${nowParameter}::timestamptz - interval '24 hours'
    ) as vol on true
    left join lateral (
      select tr.price_after_e18::text as price_1h_ago
      from public.meme_trades as tr
      where tr.meme_token_id = t.meme_token_id and not tr.removed
        and tr.traded_at <= ${nowParameter}::timestamptz - interval '1 hour'
      order by tr.traded_at desc, tr.block_number desc, tr.log_index desc
      limit 1
    ) as ago on true
  `;
}

const nullableRaw = rawSchema.nullable();
const tokenRowSchema = z.object({
  meme_token_id: uuidSchema,
  chain_id: chainIdSchema,
  contract_address: addressSchema,
  contract_version: z.string(),
  creator_user_id: uuidSchema,
  creator_wallet: addressSchema.nullable(),
  creator_public_profile_id: z.string().nullable(),
  creator_alias: z.string().nullable(),
  creator_avatar_ref: z.string().nullable(),
  name: z.string(),
  symbol: z.string(),
  description: z.string(),
  image_media_id: z.string().nullable(),
  links: z.record(z.string(), z.unknown()),
  metadata_hash: bytes32Schema,
  salt: bytes32Schema.nullable(),
  predicted_address: addressSchema.nullable(),
  vanity: z.boolean(),
  token_address: addressSchema.nullable(),
  asset_id: z.string().nullable(),
  status: z.enum(memeTokenStatuses),
  created_block: blockSchema.nullable(),
  created_tx_hash: bytes32Schema.nullable(),
  chain_created_at: dateSchema.nullable(),
  v_usd1: rawSchema,
  v_token: rawSchema,
  real_usd1: rawSchema,
  sold: rawSchema,
  holder_count: z.number().int(),
  trade_count: z.number().int(),
  last_trade_at: dateSchema.nullable(),
  full_at: dateSchema.nullable(),
  graduated_at: dateSchema.nullable(),
  pool_address: addressSchema.nullable(),
  graduation_tx_hash: bytes32Schema.nullable(),
  lp_token_id: nullableRaw,
  usd1_to_pool: nullableRaw,
  tokens_to_pool: nullableRaw,
  graduation_fee_usd1: nullableRaw,
  residual_usd1: nullableRaw,
  residual_tokens: nullableRaw,
  graduation_attempts: z.number().int(),
  graduation_needs_operator: z.boolean(),
  created_at: dateSchema,
  updated_at: dateSchema,
  listing: z.enum(["listed", "hidden"]),
  listing_reason_code: z.string().nullable(),
  listing_reason_text: z.string().nullable(),
});

function linkOf(links: Record<string, unknown>, key: string): string | null {
  const value = links[key];
  return typeof value === "string" ? value : null;
}

function creatorOf(
  publicProfileId: string | null,
  alias: string | null,
  avatarRef: string | null,
): MemeCreatorProjection {
  return Object.freeze({
    publicProfileId,
    displayName: alias,
    avatarRef,
  });
}

function mapToken(raw: unknown): MemeTokenRecord {
  const row = tokenRowSchema.parse(raw);
  return Object.freeze({
    memeTokenId: row.meme_token_id,
    chainId: row.chain_id,
    contractAddress: row.contract_address,
    contractVersion: row.contract_version,
    creatorUserId: row.creator_user_id,
    creatorWallet: row.creator_wallet,
    creator: creatorOf(
      row.creator_public_profile_id,
      row.creator_alias,
      row.creator_avatar_ref,
    ),
    name: row.name,
    symbol: row.symbol,
    description: row.description,
    imageMediaId: row.image_media_id,
    links: Object.freeze({
      twitter: linkOf(row.links, "twitter"),
      telegram: linkOf(row.links, "telegram"),
      website: linkOf(row.links, "website"),
    }),
    metadataHash: row.metadata_hash,
    salt: row.salt,
    predictedAddress: row.predicted_address,
    vanity: row.vanity,
    tokenAddress: row.token_address,
    assetId: row.asset_id,
    status: row.status,
    createdBlock: row.created_block,
    createdTxHash: row.created_tx_hash,
    chainCreatedAt: toNullableIsoString(row.chain_created_at),
    vUsd1: row.v_usd1,
    vToken: row.v_token,
    realUsd1: row.real_usd1,
    sold: row.sold,
    holderCount: row.holder_count,
    tradeCount: row.trade_count,
    lastTradeAt: toNullableIsoString(row.last_trade_at),
    fullAt: toNullableIsoString(row.full_at),
    graduatedAt: toNullableIsoString(row.graduated_at),
    poolAddress: row.pool_address,
    graduationTxHash: row.graduation_tx_hash,
    lpTokenId: row.lp_token_id,
    usd1ToPool: row.usd1_to_pool,
    tokensToPool: row.tokens_to_pool,
    graduationFeeUsd1: row.graduation_fee_usd1,
    residualUsd1: row.residual_usd1,
    residualTokens: row.residual_tokens,
    graduationAttempts: row.graduation_attempts,
    graduationNeedsOperator: row.graduation_needs_operator,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    listing: row.listing,
    listingReasonCode: row.listing_reason_code,
    listingReasonText: row.listing_reason_text,
  });
}

const statsRowSchema = z.object({
  volume_24h: rawSchema,
  price_1h_ago: rawSchema.nullable(),
});

function mapListToken(raw: unknown): MemeTokenListRecord {
  const token = mapToken(raw);
  const stats = statsRowSchema.parse(raw);
  return Object.freeze({
    ...token,
    volume24hRaw: stats.volume_24h,
    price1hAgoE18: stats.price_1h_ago,
  });
}

/**
 * Decision 0142: the weekly best trades. `sells` reads the window through
 * `meme_trades_sell_window_idx`; `buys` reads each selling pair's cost
 * basis through `meme_trades_wallet_buy_idx`. The cost of the sold tokens
 * is rounded up (never overstates the gain). A pair without any buy (tokens
 * that arrived by transfer) has no cost basis and is left out. The wallet
 * maps to the earliest active `account_wallets` row (the `accountJoin`
 * rule); the account needs an active public profile and a trade history
 * visible to everyone.
 */
const bestTradesSql = `
  with sells as (
    select tr.wallet, tr.meme_token_id,
      sum(tr.usd1_amount) as sell_usd1,
      sum(tr.token_amount) as sell_tokens,
      max(tr.traded_at) as last_sell_at
    from public.meme_trades as tr
    join public.meme_tokens as t on t.meme_token_id = tr.meme_token_id
    where not tr.removed and not tr.is_buy
      and tr.traded_at > $3::timestamptz and tr.traded_at <= $4::timestamptz
      and t.chain_id = $1 and t.contract_address = $2
      and t.listing = 'listed' and t.status = any($6::text[])
    group by tr.wallet, tr.meme_token_id
  ),
  buys as (
    select b.wallet, b.meme_token_id,
      sum(b.usd1_amount) as buy_usd1,
      sum(b.token_amount) as buy_tokens
    from public.meme_trades as b
    join sells as s on s.wallet = b.wallet and s.meme_token_id = b.meme_token_id
    where not b.removed and b.is_buy and b.traded_at <= $4::timestamptz
    group by b.wallet, b.meme_token_id
  ),
  scored as (
    select s.wallet, s.meme_token_id, s.last_sell_at,
      s.sell_usd1
        - div(s.sell_tokens * b.buy_usd1 + b.buy_tokens - 1, b.buy_tokens)
        as realized
    from sells as s
    join buys as b on b.wallet = s.wallet and b.meme_token_id = s.meme_token_id
    where b.buy_tokens > 0
  )
  select sc.wallet, sc.meme_token_id, t.symbol, t.image_media_id::text as image_media_id,
    acct.public_profile_id::text as public_profile_id, acct.loop_id,
    acct.alias, acct.avatar_ref, sc.realized::text as realized
  from scored as sc
  join public.meme_tokens as t on t.meme_token_id = sc.meme_token_id
  join lateral (
    select p.public_profile_id, u.loop_id, p.alias, p.avatar_ref,
      coalesce(pv.trade_history_visibility, 'everyone') as trade_visibility
    from public.account_wallets as w
    join public.loop_users as u on u.id = w.owner_user_id
    join public.user_profiles as p
      on p.owner_user_id = w.owner_user_id and p.profile_status = 'active'
    left join public.privacy_preferences_v2 as pv on pv.owner_user_id = w.owner_user_id
    where w.address = sc.wallet and w.status = 'active'
    order by w.first_seen_at asc, w.wallet_id asc
    limit 1
  ) as acct on true
  where sc.realized > 0 and acct.trade_visibility = 'everyone'
  order by sc.realized desc, sc.last_sell_at desc, sc.wallet asc, sc.meme_token_id asc
  limit $5
`;

const bestTradeRowSchema = z.object({
  wallet: addressSchema,
  meme_token_id: uuidSchema,
  symbol: z.string(),
  image_media_id: z.string().nullable(),
  public_profile_id: z.string(),
  loop_id: z.string(),
  alias: z.string().nullable(),
  avatar_ref: z.string().nullable(),
  realized: rawSchema,
});

function mapBestTrade(raw: unknown): MemeBestTradeRecord {
  const row = bestTradeRowSchema.parse(raw);
  return Object.freeze({
    wallet: row.wallet,
    memeTokenId: row.meme_token_id,
    symbol: row.symbol,
    imageMediaId: row.image_media_id,
    publicProfileId: row.public_profile_id,
    loopId: row.loop_id,
    alias: row.alias,
    avatarRef: row.avatar_ref,
    realizedRaw: row.realized,
  });
}

const accountColumns = `
  acct.owner_user_id::text as account_owner_user_id,
  acct.public_profile_id::text as account_public_profile_id,
  acct.alias as account_alias,
  acct.avatar_ref as account_avatar_ref,
  acct.trade_visibility as account_trade_visibility
`;

/** The account (if any) whose active-status wallet is `${column}`. */
function accountJoin(column: string): string {
  return `
    left join lateral (
      select w.owner_user_id, p.public_profile_id, p.alias, p.avatar_ref,
        coalesce(pv.trade_history_visibility, 'everyone') as trade_visibility
      from public.account_wallets as w
      left join public.user_profiles as p
        on p.owner_user_id = w.owner_user_id and p.profile_status = 'active'
      left join public.privacy_preferences_v2 as pv
        on pv.owner_user_id = w.owner_user_id
      where w.address = ${column} and w.status = 'active'
      order by w.first_seen_at asc, w.wallet_id asc
      limit 1
    ) as acct on true
  `;
}

const accountRowSchema = z.object({
  account_owner_user_id: z.string().nullable(),
  account_public_profile_id: z.string().nullable(),
  account_alias: z.string().nullable(),
  account_avatar_ref: z.string().nullable(),
  account_trade_visibility: z.enum(["self", "everyone"]).nullable(),
});

function accountOf(raw: unknown): {
  readonly ownerUserId: string | null;
  readonly tradeVisibility: "self" | "everyone";
  readonly account: MemeCreatorProjection | null;
} {
  const row = accountRowSchema.parse(raw);
  return {
    ownerUserId: row.account_owner_user_id,
    // Decision 0162 §D: no privacy row reads as `everyone`.
    tradeVisibility: row.account_trade_visibility ?? "everyone",
    // Only an active public profile is shown; a wallet alone is never one.
    account:
      row.account_public_profile_id === null
        ? null
        : creatorOf(
            row.account_public_profile_id,
            row.account_alias,
            row.account_avatar_ref,
          ),
  };
}

// ---------------------------------------------------------------------------
// Intent projection
// ---------------------------------------------------------------------------

const intentColumns = `
  intent_id, owner_user_id, wallet_id, wallet_address, meme_token_id, kind,
  chain_id, contract_address, token_address,
  usd1_amount_raw::text as usd1_amount_raw, token_amount_raw::text as token_amount_raw,
  expected_out_raw::text as expected_out_raw, min_out_raw::text as min_out_raw,
  fee_raw::text as fee_raw, refund_raw::text as refund_raw, deadline,
  snapshot_block_number::text as snapshot_block_number, snapshot_block_hash,
  calldata, unsigned_transaction, approval, policy, payload_digest, state,
  reason_code, transaction_hash, payload_verified, receipt, expires_at,
  created_at, updated_at
`;

const receiptSchema = z.object({
  status: z.enum(["success", "reverted"]),
  blockNumber: blockSchema,
  blockHash: bytes32Schema,
  gasUsed: rawSchema,
  effectiveGasPrice: rawSchema,
  confirmations: z.number().int(),
  observedAt: z.string(),
});

const intentRowSchema = z.object({
  intent_id: uuidSchema,
  owner_user_id: uuidSchema,
  wallet_id: uuidSchema,
  wallet_address: addressSchema,
  meme_token_id: uuidSchema,
  kind: z.enum(memeIntentKinds),
  chain_id: chainIdSchema,
  contract_address: addressSchema,
  token_address: addressSchema.nullable(),
  usd1_amount_raw: rawSchema,
  token_amount_raw: rawSchema,
  expected_out_raw: rawSchema,
  min_out_raw: rawSchema,
  fee_raw: rawSchema,
  refund_raw: rawSchema,
  deadline: dateSchema,
  snapshot_block_number: blockSchema,
  snapshot_block_hash: bytes32Schema,
  calldata: z.record(z.string(), z.unknown()),
  unsigned_transaction: z.record(z.string(), z.unknown()),
  approval: z.record(z.string(), z.unknown()).nullable(),
  policy: z.record(z.string(), z.unknown()),
  payload_digest: sha256Schema,
  state: z.enum(memeIntentStates),
  reason_code: z.string().nullable(),
  transaction_hash: bytes32Schema.nullable(),
  payload_verified: z.boolean(),
  receipt: receiptSchema.nullable(),
  expires_at: dateSchema,
  created_at: dateSchema,
  updated_at: dateSchema,
});

function mapIntent(raw: unknown): MemeIntentRecord {
  const row = intentRowSchema.parse(raw);
  return Object.freeze({
    intentId: row.intent_id,
    ownerUserId: row.owner_user_id,
    walletId: row.wallet_id,
    walletAddress: row.wallet_address,
    memeTokenId: row.meme_token_id,
    kind: row.kind,
    chainId: row.chain_id,
    contractAddress: row.contract_address,
    tokenAddress: row.token_address,
    usd1AmountRaw: row.usd1_amount_raw,
    tokenAmountRaw: row.token_amount_raw,
    expectedOutRaw: row.expected_out_raw,
    minOutRaw: row.min_out_raw,
    feeRaw: row.fee_raw,
    refundRaw: row.refund_raw,
    deadline: toIsoString(row.deadline),
    snapshotBlockNumber: row.snapshot_block_number,
    snapshotBlockHash: row.snapshot_block_hash,
    calldata: Object.freeze(row.calldata),
    unsignedTransaction: Object.freeze(row.unsigned_transaction),
    approval: row.approval === null ? null : Object.freeze(row.approval),
    policy: Object.freeze(row.policy),
    payloadDigest: row.payload_digest,
    state: row.state,
    reasonCode: row.reason_code,
    transactionHash: row.transaction_hash,
    payloadVerified: row.payload_verified,
    receipt:
      row.receipt === null
        ? null
        : (Object.freeze({ ...row.receipt }) as MemeIntentReceipt),
    expiresAt: toIsoString(row.expires_at),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  });
}

// ---------------------------------------------------------------------------
// Lane projection
// ---------------------------------------------------------------------------

const indexedEventRowSchema = z.object({
  event_name: z.string(),
  block_number: blockSchema,
  log_index: z.number().int(),
  transaction_hash: bytes32Schema,
  payload: z.record(z.string(), z.string()),
  event_at: dateSchema.nullable(),
});

type IndexedEventRow = z.infer<typeof indexedEventRowSchema>;

function sumPayload(
  rows: readonly IndexedEventRow[],
  eventName: string,
  key: string,
): bigint {
  return rows
    .filter((row) => row.event_name === eventName)
    .reduce((sum, row) => sum + BigInt(row.payload[key] ?? "0"), 0n);
}

/**
 * Recomputes one token from its stored, non-removed logs: status,
 * creation, graduation and residual facts, the curve snapshot of the
 * newest trade, counts, and the holder table.
 */
async function reprojectToken(
  client: PoolClient,
  memeTokenId: string,
): Promise<void> {
  const current = await client.query<{ status: MemeTokenStatus }>({
    text: `select status from public.meme_tokens where meme_token_id = $1 for update`,
    values: [memeTokenId],
  });
  const currentStatus = current.rows[0]?.status;
  if (currentStatus === undefined) {
    return;
  }
  const eventResult = await client.query({
    text: `
      select event_name, block_number::text as block_number, log_index,
        transaction_hash, payload, event_at
      from public.meme_indexed_events
      where meme_token_id = $1 and not removed
      order by block_number asc, log_index asc
    `,
    values: [memeTokenId],
  });
  const events = eventResult.rows.map((row) =>
    indexedEventRowSchema.parse(row),
  );
  const created = events.find((row) => row.event_name === "TokenCreated");
  const graduated = events
    .filter((row) => row.event_name === "Graduated")
    .at(-1);
  const full = events.find((row) => row.event_name === "CurveFull");
  const pauseFlip = events
    .filter(
      (row) => row.event_name === "Paused" || row.event_name === "Unpaused",
    )
    .at(-1);
  let status: MemeTokenStatus;
  if (created === undefined) {
    status =
      currentStatus === "draft" || currentStatus === "pending_chain"
        ? currentStatus
        : "pending_chain";
  } else if (graduated !== undefined) {
    status = "graduated";
  } else if (full !== undefined) {
    status = "full";
  } else if (pauseFlip?.event_name === "Paused") {
    status = "paused";
  } else {
    status = "trading";
  }
  const residualEvents = events.filter(
    (row) => row.event_name === "GraduationResidual",
  ).length;
  const residualUsd1 =
    sumPayload(events, "GraduationResidual", "usd1Left") -
    sumPayload(events, "ResidualInjected", "usd1ToPool");
  const residualTokens =
    sumPayload(events, "GraduationResidual", "tokensLeft") -
    sumPayload(events, "ResidualInjected", "tokensToPool");
  const lastTrade = await client.query<{
    v_usd1_after: string;
    v_token_after: string;
    sold_after: string;
  }>({
    text: `
      select v_usd1_after::text as v_usd1_after, v_token_after::text as v_token_after,
        sold_after::text as sold_after
      from public.meme_trades
      where meme_token_id = $1 and not removed
      order by block_number desc, log_index desc
      limit 1
    `,
    values: [memeTokenId],
  });
  const snapshot = lastTrade.rows[0];
  const vUsd1 = snapshot === undefined ? memeV0 : BigInt(snapshot.v_usd1_after);
  const vToken =
    snapshot === undefined ? memeT0 : BigInt(snapshot.v_token_after);
  const sold = snapshot === undefined ? 0n : BigInt(snapshot.sold_after);
  const graduatedAt = graduated?.event_at ?? null;
  await client.query({
    text: `delete from public.meme_holders where meme_token_id = $1`,
    values: [memeTokenId],
  });
  await client.query({
    text: `
      insert into public.meme_holders (meme_token_id, wallet, balance, frozen_at)
      select $1, wallet,
        sum(case when is_buy then token_amount else -token_amount end),
        $2::timestamptz
      from public.meme_trades
      where meme_token_id = $1 and not removed
      group by wallet
      having sum(case when is_buy then token_amount else -token_amount end) > 0
    `,
    values: [memeTokenId, graduatedAt],
  });
  await client.query({
    text: `
      update public.meme_tokens as t set
        status = $2,
        created_block = $3::numeric,
        created_tx_hash = $4,
        chain_created_at = $5::timestamptz,
        v_usd1 = $6::numeric,
        v_token = $7::numeric,
        real_usd1 = $8::numeric,
        sold = $9::numeric,
        full_at = $10::timestamptz,
        graduated_at = $11::timestamptz,
        pool_address = $12,
        graduation_tx_hash = $13,
        lp_token_id = $14::numeric,
        usd1_to_pool = $15::numeric,
        tokens_to_pool = $16::numeric,
        graduation_fee_usd1 = $17::numeric,
        residual_usd1 = $18::numeric,
        residual_tokens = $19::numeric,
        trade_count = stats.trade_count,
        last_trade_at = stats.last_trade_at,
        holder_count = (
          select count(*)::int from public.meme_holders as h
          where h.meme_token_id = $1
        ),
        updated_at = clock_timestamp()
      from (
        select count(*)::int as trade_count, max(traded_at) as last_trade_at
        from public.meme_trades
        where meme_token_id = $1 and not removed
      ) as stats
      where t.meme_token_id = $1
    `,
    values: [
      memeTokenId,
      status,
      created?.block_number ?? null,
      created?.transaction_hash ?? null,
      created?.event_at ?? null,
      vUsd1.toString(10),
      vToken.toString(10),
      (vUsd1 - memeV0).toString(10),
      sold.toString(10),
      full?.event_at ?? null,
      graduatedAt,
      graduated?.payload["pool"] ?? null,
      graduated?.transaction_hash ?? null,
      graduated?.payload["lpTokenId"] ?? null,
      graduated?.payload["usd1ToPool"] ?? null,
      graduated?.payload["tokensToPool"] ?? null,
      graduated?.payload["feeUsd1"] ?? null,
      residualEvents === 0
        ? null
        : (residualUsd1 < 0n ? 0n : residualUsd1).toString(10),
      residualEvents === 0
        ? null
        : (residualTokens < 0n ? 0n : residualTokens).toString(10),
    ],
  });
}

function secondsToIso(seconds: string | null): string | null {
  return seconds === null
    ? null
    : new Date(Number(BigInt(seconds)) * 1000).toISOString();
}

async function findTokenByAddress(
  client: DatabaseClient,
  chainId: string,
  tokenAddress: string,
): Promise<string | null> {
  const result = await client.query<{ meme_token_id: string }>({
    text: `
      select meme_token_id from public.meme_tokens
      where chain_id = $1 and token_address = $2
    `,
    values: [chainId, tokenAddress],
  });
  return result.rows[0]?.meme_token_id ?? null;
}

const graduatingSoldThreshold =
  (memeSaleSupply * BigInt(memeRules.graduatingProgressBps)) / 10_000n;

async function reserveFreeSalt(
  client: DatabaseClient,
  scope: MemeSaltScope,
): Promise<{ salt: string; predicted_address: string } | null> {
  const result = await client.query<{
    salt: string;
    predicted_address: string;
  }>({
    text: `
      select salt, predicted_address from public.meme_salts
      where chain_id = $1 and contract_address = $2 and token_implementation = $3
        and suffix = $4 and status = 'free'
      order by created_at asc, salt asc
      limit 1
      for update skip locked
    `,
    values: [
      scope.chainId,
      addressSchema.parse(scope.contractAddress),
      addressSchema.parse(scope.tokenImplementation),
      scope.suffix,
    ],
  });
  return result.rows[0] ?? null;
}

/**
 * Decision 0104 M2: one live create Intent per draft. Locks the token row;
 * the draft must still be `draft`, and no create Intent of it may be
 * reported or still signable (`prepared` inside its window with a
 * simulation that did not revert).
 */
async function assertDraftCreatable(
  client: DatabaseClient,
  memeTokenId: string,
): Promise<void> {
  const token = await client.query<{ status: string }>({
    text: `select status from public.meme_tokens where meme_token_id = $1 for update`,
    values: [memeTokenId],
  });
  const status = token.rows[0]?.status ?? null;
  if (status !== "draft") {
    throw new MemeTokenNotDraftError(status);
  }
  const live = await client.query<{ intent_id: string }>({
    text: `
      select intent_id from public.meme_intents
      where meme_token_id = $1 and kind = 'create'
        and (
          state = 'broadcast_reported'
          or (
            state = 'prepared' and expires_at > clock_timestamp()
            and coalesce(policy -> 'simulation' ->> 'status', '') <> 'reverted'
          )
        )
      limit 1
    `,
    values: [memeTokenId],
  });
  if (live.rows[0] !== undefined) {
    throw new MemeCreateIntentInFlightError();
  }
}

export function createPostgresMemeRepository(pool: Pool): MemeRepository {
  async function getToken(memeTokenId: string) {
    const result = await pool.query({
      text: `select ${tokenColumns} from ${tokenFrom} where t.meme_token_id = $1`,
      values: [uuidSchema.parse(memeTokenId)],
    });
    return result.rows[0] === undefined ? null : mapToken(result.rows[0]);
  }

  const repository: MemeRepository = {
    async getToken(memeTokenId) {
      try {
        return await getToken(memeTokenId);
      } catch (error) {
        return translate(error);
      }
    },

    async listTokens(input) {
      try {
        const now = new Date(input.now).toISOString();
        const after = input.after;
        const base = [
          input.chainId,
          addressSchema.parse(input.contractAddress),
          now,
          input.limit,
        ];
        let where: string;
        let order: string;
        let values: unknown[];
        switch (input.tab) {
          case "new": {
            where = `t.status = any($5::text[])
              and ($6::timestamptz is null
                or (t.chain_created_at, t.meme_token_id) < ($6::timestamptz, $7::uuid))`;
            order = `t.chain_created_at desc, t.meme_token_id desc`;
            values = [
              ...base,
              [...memeOnChainStatuses],
              after === null ? null : after.value,
              after === null ? null : uuidSchema.parse(after.memeTokenId),
            ];
            break;
          }
          case "graduating": {
            where = `t.status = 'trading' and t.sold >= $5::numeric
              and ($6::numeric is null
                or (t.sold, t.meme_token_id) < ($6::numeric, $7::uuid))`;
            order = `t.sold desc, t.meme_token_id desc`;
            values = [
              ...base,
              graduatingSoldThreshold.toString(10),
              after === null ? null : rawSchema.parse(after.value),
              after === null ? null : uuidSchema.parse(after.memeTokenId),
            ];
            break;
          }
          case "graduated": {
            where = `t.status = 'graduated'
              and ($5::timestamptz is null
                or (t.graduated_at, t.meme_token_id) < ($5::timestamptz, $6::uuid))`;
            order = `t.graduated_at desc, t.meme_token_id desc`;
            values = [
              ...base,
              after === null ? null : after.value,
              after === null ? null : uuidSchema.parse(after.memeTokenId),
            ];
            break;
          }
        }
        const result = await pool.query({
          text: `
            select ${tokenColumns}, vol.volume_24h, ago.price_1h_ago
            from ${tokenFrom}
            ${statsJoin("$3")}
            where t.chain_id = $1 and t.contract_address = $2
              and t.listing = 'listed' and ${where}
            order by ${order}
            limit $4
          `,
          values,
        });
        return Object.freeze(result.rows.map((row) => mapListToken(row)));
      } catch (error) {
        return translate(error);
      }
    },

    async rankHotTokens(input) {
      try {
        const result = await pool.query<{
          meme_token_id: string;
          volume: string;
        }>({
          text: `
            select t.meme_token_id, coalesce(sum(tr.usd1_amount), 0)::text as volume
            from public.meme_tokens as t
            left join public.meme_trades as tr
              on tr.meme_token_id = t.meme_token_id and not tr.removed
              and tr.traded_at > $3::timestamptz
            where t.chain_id = $1 and t.contract_address = $2
              and t.status = any($5::text[])
              and t.listing = 'listed'
            group by t.meme_token_id, t.chain_created_at
            order by coalesce(sum(tr.usd1_amount), 0) desc,
              t.chain_created_at desc, t.meme_token_id desc
            limit $4
          `,
          values: [
            input.chainId,
            addressSchema.parse(input.contractAddress),
            new Date(input.since).toISOString(),
            input.limit,
            [...memeOnChainStatuses],
          ],
        });
        return Object.freeze(
          result.rows.map((row) =>
            Object.freeze({
              memeTokenId: uuidSchema.parse(row.meme_token_id),
              volumeRaw: rawSchema.parse(row.volume),
            }),
          ),
        );
      } catch (error) {
        return translate(error);
      }
    },

    async listTokensByIds(input) {
      try {
        if (input.memeTokenIds.length === 0) {
          return Object.freeze([]);
        }
        const result = await pool.query({
          text: `
            select ${tokenColumns}, vol.volume_24h, ago.price_1h_ago
            from ${tokenFrom}
            ${statsJoin("$2")}
            where t.meme_token_id = any($1::uuid[])
          `,
          values: [
            input.memeTokenIds.map((id) => uuidSchema.parse(id)),
            new Date(input.now).toISOString(),
          ],
        });
        return Object.freeze(result.rows.map((row) => mapListToken(row)));
      } catch (error) {
        return translate(error);
      }
    },

    async rankBestTrades(input) {
      try {
        const result = await pool.query({
          text: bestTradesSql,
          values: [
            input.chainId,
            addressSchema.parse(input.contractAddress),
            new Date(input.since).toISOString(),
            new Date(input.until).toISOString(),
            input.limit,
            [...memeOnChainStatuses],
          ],
        });
        return Object.freeze(result.rows.map((row) => mapBestTrade(row)));
      } catch (error) {
        return translate(error);
      }
    },

    async tokenStats(input) {
      try {
        const result = await pool.query({
          text: `
            select vol.volume_24h, ago.price_1h_ago
            from public.meme_tokens as t
            ${statsJoin("$2")}
            where t.meme_token_id = $1
          `,
          values: [
            uuidSchema.parse(input.memeTokenId),
            new Date(input.now).toISOString(),
          ],
        });
        const row = statsRowSchema.parse(
          result.rows[0] ?? { volume_24h: "0", price_1h_ago: null },
        );
        return Object.freeze({
          volume24hRaw: row.volume_24h,
          price1hAgoE18: row.price_1h_ago,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async listTrades(input) {
      try {
        const after = input.after;
        const result = await pool.query({
          text: `
            select tr.transaction_hash, tr.log_index, tr.block_number::text as block_number,
              tr.wallet, tr.is_buy, tr.usd1_amount::text as usd1_amount,
              tr.token_amount::text as token_amount, tr.fee_usd1::text as fee_usd1,
              tr.price_after_e18::text as price_after_e18, tr.traded_at,
              ${accountColumns}
            from public.meme_trades as tr
            ${accountJoin("tr.wallet")}
            where tr.meme_token_id = $1 and not tr.removed
              and ($3::numeric is null
                or (tr.block_number, tr.log_index) < ($3::numeric, $4::int))
            order by tr.block_number desc, tr.log_index desc
            limit $2
          `,
          values: [
            uuidSchema.parse(input.memeTokenId),
            input.limit,
            after === null ? null : blockSchema.parse(after.blockNumber),
            after === null ? null : after.logIndex,
          ],
        });
        return Object.freeze(
          result.rows.map((raw): MemeTradeRecord => {
            const row = z
              .object({
                transaction_hash: bytes32Schema,
                log_index: z.number().int(),
                block_number: blockSchema,
                wallet: addressSchema,
                is_buy: z.boolean(),
                usd1_amount: rawSchema,
                token_amount: rawSchema,
                fee_usd1: rawSchema,
                price_after_e18: rawSchema,
                traded_at: dateSchema,
              })
              .parse(raw);
            return Object.freeze({
              transactionHash: row.transaction_hash,
              logIndex: row.log_index,
              blockNumber: row.block_number,
              wallet: row.wallet,
              isBuy: row.is_buy,
              usd1Amount: row.usd1_amount,
              tokenAmount: row.token_amount,
              feeUsd1: row.fee_usd1,
              priceAfterE18: row.price_after_e18,
              tradedAt: toIsoString(row.traded_at),
              ...(() => {
                const owner = accountOf(raw);
                return {
                  account: owner.account,
                  accountOwnerUserId: owner.ownerUserId,
                  accountTradeVisibility: owner.tradeVisibility,
                };
              })(),
            });
          }),
        );
      } catch (error) {
        return translate(error);
      }
    },

    async listCandles(input) {
      try {
        const result = await pool.query({
          text: `
            with bucketed as (
              select
                to_timestamp(floor(extract(epoch from traded_at) / $2) * $2) as open_time,
                price_after_e18, usd1_amount, block_number, log_index
              from public.meme_trades
              where meme_token_id = $1 and not removed
                and ($4::timestamptz is null or traded_at <= $4::timestamptz)
            ),
            recent as (
              select distinct open_time from bucketed
              order by open_time desc
              limit $3
            )
            select
              b.open_time,
              (array_agg(b.price_after_e18 order by b.block_number asc, b.log_index asc))[1]::text as open_e18,
              max(b.price_after_e18)::text as high_e18,
              min(b.price_after_e18)::text as low_e18,
              (array_agg(b.price_after_e18 order by b.block_number desc, b.log_index desc))[1]::text as close_e18,
              sum(b.usd1_amount)::text as volume,
              count(*)::int as trade_count
            from bucketed as b
            join recent as r on r.open_time = b.open_time
            group by b.open_time
            order by b.open_time asc
          `,
          values: [
            uuidSchema.parse(input.memeTokenId),
            input.intervalSeconds,
            input.limit,
            input.until,
          ],
        });
        return Object.freeze(
          result.rows.map((raw): MemeCandleRecord => {
            const row = z
              .object({
                open_time: dateSchema,
                open_e18: rawSchema,
                high_e18: rawSchema,
                low_e18: rawSchema,
                close_e18: rawSchema,
                volume: rawSchema,
                trade_count: z.number().int(),
              })
              .parse(raw);
            return Object.freeze({
              openTime: toIsoString(row.open_time),
              openE18: row.open_e18,
              highE18: row.high_e18,
              lowE18: row.low_e18,
              closeE18: row.close_e18,
              volumeUsd1Raw: row.volume,
              tradeCount: row.trade_count,
            });
          }),
        );
      } catch (error) {
        return translate(error);
      }
    },

    async listHolders(input) {
      try {
        const after = input.after;
        const result = await pool.query({
          text: `
            select h.wallet, h.balance::text as balance, h.frozen_at, ${accountColumns}
            from public.meme_holders as h
            ${accountJoin("h.wallet")}
            where h.meme_token_id = $1
              and ($3::numeric is null
                or h.balance < $3::numeric
                or (h.balance = $3::numeric and h.wallet > $4))
            order by h.balance desc, h.wallet asc
            limit $2
          `,
          values: [
            uuidSchema.parse(input.memeTokenId),
            input.limit,
            after === null ? null : rawSchema.parse(after.balance),
            after === null ? null : addressSchema.parse(after.wallet),
          ],
        });
        return Object.freeze(
          result.rows.map((raw): MemeHolderRecord => {
            const row = z
              .object({
                wallet: addressSchema,
                balance: rawSchema,
                frozen_at: dateSchema.nullable(),
              })
              .parse(raw);
            const resolved = accountOf(raw);
            return Object.freeze({
              wallet: row.wallet,
              balance: row.balance,
              frozenAt: toNullableIsoString(row.frozen_at),
              ownerUserId: resolved.ownerUserId,
              account: resolved.account,
            });
          }),
        );
      } catch (error) {
        return translate(error);
      }
    },

    async createDraft(input) {
      try {
        const ownerUserId = uuidSchema.parse(input.ownerUserId);
        const idempotencyKey = uuidV4Schema.parse(input.idempotencyKey);
        const requestSha256 = sha256Schema.parse(input.requestSha256);
        const draft = input.draft;
        return await withV2Transaction(pool, unavailable, async (client) => {
          await lockV2Owner(client, ownerUserId, unavailable);
          const recordId = await claimV2Command(
            client,
            {
              ownerUserId,
              scope: memeCreateIdempotencyScope,
              digestVersion: memeCreateDigestVersion,
              idempotencyKey,
              requestSha256,
            },
            () => new MemeIdempotencyConflictError(),
          );
          const existing = await client.query<{ meme_token_id: string }>({
            text: `select meme_token_id from public.meme_tokens where idempotency_record_id = $1`,
            values: [recordId],
          });
          const existingId = existing.rows[0]?.meme_token_id;
          if (existingId !== undefined) {
            const replay = await client.query({
              text: `select ${tokenColumns} from ${tokenFrom} where t.meme_token_id = $1`,
              values: [existingId],
            });
            return Object.freeze({
              created: false,
              token: mapToken(replay.rows[0]),
            });
          }
          const counted = await client.query<{ created: number }>({
            text: `
              select count(*)::int as created from public.meme_tokens
              where creator_user_id = $1 and created_at > $2::timestamptz
            `,
            values: [
              ownerUserId,
              new Date(input.limitWindowStart).toISOString(),
            ],
          });
          if ((counted.rows[0]?.created ?? 0) >= input.dailyLimit) {
            throw new MemeCreateRateLimitedError(input.dailyLimit);
          }
          if (draft.imageMediaId !== null) {
            const owned = await client.query({
              text: `
                select 1 from public.media_objects
                where media_id = $1 and owner_user_id = $2
              `,
              values: [uuidSchema.parse(draft.imageMediaId), ownerUserId],
            });
            if (owned.rows.length === 0) {
              throw new MemeImageNotOwnedError();
            }
          }
          const vanity = await reserveFreeSalt(client, input.saltScope);
          const salt =
            vanity?.salt ?? bytes32Schema.parse(input.fallbackSalt.salt);
          const predicted =
            vanity?.predicted_address ??
            addressSchema.parse(input.fallbackSalt.predictedAddress);
          await client.query({
            text: `
              insert into public.meme_tokens (
                meme_token_id, chain_id, contract_address, contract_version,
                creator_user_id, name, symbol, description, image_media_id, links,
                metadata_hash, salt, predicted_address, vanity, status,
                idempotency_record_id
              )
              values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14,
                'draft', $15)
            `,
            values: [
              uuidSchema.parse(draft.memeTokenId),
              draft.chainId,
              addressSchema.parse(draft.contractAddress),
              draft.contractVersion,
              ownerUserId,
              draft.name,
              draft.symbol,
              draft.description,
              draft.imageMediaId,
              JSON.stringify(draft.links),
              bytes32Schema.parse(draft.metadataHash),
              salt,
              predicted,
              vanity !== null,
              recordId,
            ],
          });
          if (vanity !== null) {
            await client.query({
              text: `
                update public.meme_salts
                set status = 'reserved', reserved_by_token_id = $2,
                  reserved_at = clock_timestamp()
                where salt = $1
              `,
              values: [vanity.salt, draft.memeTokenId],
            });
          }
          const inserted = await client.query({
            text: `select ${tokenColumns} from ${tokenFrom} where t.meme_token_id = $1`,
            values: [draft.memeTokenId],
          });
          return Object.freeze({
            created: true,
            token: mapToken(inserted.rows[0]),
          });
        });
      } catch (error) {
        return translate(error);
      }
    },

    async replaceDraftSalt(input) {
      try {
        const memeTokenId = uuidSchema.parse(input.memeTokenId);
        const updated = await withV2Transaction(
          pool,
          unavailable,
          async (client) => {
            const row = await client.query<{
              salt: string | null;
              status: string;
            }>({
              text: `
                select salt, status from public.meme_tokens
                where meme_token_id = $1 for update
              `,
              values: [memeTokenId],
            });
            const current = row.rows[0];
            if (
              current === undefined ||
              current.status !== "draft" ||
              current.salt !== input.expectedSalt
            ) {
              return false;
            }
            if (current.salt !== null) {
              await client.query({
                text: `
                  update public.meme_salts
                  set status = 'used', used_at = clock_timestamp()
                  where salt = $1
                `,
                values: [current.salt],
              });
            }
            const vanity = await reserveFreeSalt(client, input.saltScope);
            const salt =
              vanity?.salt ?? bytes32Schema.parse(input.fallbackSalt.salt);
            const predicted =
              vanity?.predicted_address ??
              addressSchema.parse(input.fallbackSalt.predictedAddress);
            await client.query({
              text: `
                update public.meme_tokens set
                  salt = $2, predicted_address = $3, vanity = $4,
                  updated_at = clock_timestamp()
                where meme_token_id = $1
              `,
              values: [memeTokenId, salt, predicted, vanity !== null],
            });
            if (vanity !== null) {
              await client.query({
                text: `
                  update public.meme_salts
                  set status = 'reserved', reserved_by_token_id = $2,
                    reserved_at = clock_timestamp()
                  where salt = $1
                `,
                values: [vanity.salt, memeTokenId],
              });
            }
            return true;
          },
        );
        return updated ? await getToken(memeTokenId) : null;
      } catch (error) {
        return translate(error);
      }
    },

    async touchDraftSalt(memeTokenId) {
      try {
        await pool.query({
          text: `
            update public.meme_salts as s set reserved_at = clock_timestamp()
            from public.meme_tokens as t
            where t.meme_token_id = $1 and s.salt = t.salt
              and s.status = 'reserved' and s.reserved_by_token_id = t.meme_token_id
          `,
          values: [uuidSchema.parse(memeTokenId)],
        });
      } catch (error) {
        return translate(error);
      }
    },

    async createIntent(input) {
      try {
        const ownerUserId = uuidSchema.parse(input.ownerUserId);
        const exclusive =
          input.exclusiveCreate === undefined || input.exclusiveCreate === null
            ? null
            : uuidSchema.parse(input.exclusiveCreate.memeTokenId);
        const claim = await withV2Transaction(
          pool,
          unavailable,
          async (client) => {
            await lockV2Owner(client, ownerUserId, unavailable);
            const recordId = await claimV2Command(
              client,
              {
                ownerUserId,
                scope: memeIntentIdempotencyScope,
                digestVersion: memeIntentDigestVersion,
                idempotencyKey: uuidV4Schema.parse(input.idempotencyKey),
                requestSha256: sha256Schema.parse(input.requestSha256),
              },
              () => new MemeIdempotencyConflictError(),
            );
            const existing = await client.query({
              text: `select ${intentColumns} from public.meme_intents where idempotency_record_id = $1`,
              values: [recordId],
            });
            if (existing.rows[0] === undefined && exclusive !== null) {
              // Refused before any chain read or salt replacement; the
              // rollback releases the key.
              await assertDraftCreatable(client, exclusive);
            }
            return {
              recordId,
              existing:
                existing.rows[0] === undefined
                  ? null
                  : mapIntent(existing.rows[0]),
            };
          },
        );
        if (claim.existing !== null) {
          return Object.freeze({ created: false, intent: claim.existing });
        }
        // Chain reads happen outside any transaction (Decision 0101).
        let built: CreateMemeIntentRecord;
        try {
          built = await input.build();
        } catch (error) {
          throw new CallerCallbackError(error);
        }
        let admission: CanaryExposureAdmission | null;
        try {
          admission = input.canaryAdmission?.(built) ?? null;
        } catch (error) {
          throw new CallerCallbackError(error);
        }
        // Decision 0104 M2: the insert runs under the owner lock; the
        // exclusivity of a create and the daily canary ceiling are
        // re-checked on what is stored now, after the chain reads.
        const inserted = await withV2Transaction(
          pool,
          unavailable,
          async (client) => {
            await lockV2Owner(client, ownerUserId, unavailable);
            const raced = await client.query({
              text: `select ${intentColumns} from public.meme_intents where idempotency_record_id = $1`,
              values: [claim.recordId],
            });
            if (raced.rows[0] !== undefined) {
              return raced;
            }
            if (exclusive !== null) {
              await assertDraftCreatable(client, exclusive);
            }
            if (admission !== null) {
              await admitCanaryExposure(
                client,
                ownerUserId,
                admission,
                (error) => new CallerCallbackError(error),
              );
            }
            return client.query({
              text: `
            insert into public.meme_intents (
              intent_id, owner_user_id, wallet_id, wallet_address, meme_token_id, kind,
              chain_id, contract_address, token_address, usd1_amount_raw,
              token_amount_raw, expected_out_raw, min_out_raw, fee_raw, refund_raw,
              deadline, snapshot_block_number, snapshot_block_hash, calldata,
              unsigned_transaction, approval, policy, payload_digest, state,
              expires_at, idempotency_record_id
            )
            values (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::numeric, $11::numeric,
              $12::numeric, $13::numeric, $14::numeric, $15::numeric, $16::timestamptz,
              $17::numeric, $18, $19::jsonb, $20::jsonb, $21::jsonb, $22::jsonb, $23,
              $24, $25::timestamptz, $26
            )
            on conflict (idempotency_record_id) do nothing
            returning ${intentColumns}
          `,
              values: [
                uuidSchema.parse(built.intentId),
                ownerUserId,
                uuidSchema.parse(built.walletId),
                addressSchema.parse(built.walletAddress),
                uuidSchema.parse(built.memeTokenId),
                built.kind,
                built.chainId,
                addressSchema.parse(built.contractAddress),
                built.tokenAddress === null
                  ? null
                  : addressSchema.parse(built.tokenAddress),
                rawSchema.parse(built.usd1AmountRaw),
                rawSchema.parse(built.tokenAmountRaw),
                rawSchema.parse(built.expectedOutRaw),
                rawSchema.parse(built.minOutRaw),
                rawSchema.parse(built.feeRaw),
                rawSchema.parse(built.refundRaw),
                built.deadline,
                blockSchema.parse(built.snapshotBlockNumber),
                bytes32Schema.parse(built.snapshotBlockHash),
                JSON.stringify(built.calldata),
                JSON.stringify(built.unsignedTransaction),
                built.approval === null ? null : JSON.stringify(built.approval),
                JSON.stringify(built.policy),
                sha256Schema.parse(built.payloadDigest),
                built.state,
                built.expiresAt,
                claim.recordId,
              ],
            });
          },
        );
        const insertedRow = inserted.rows[0] as
          Record<string, unknown> | undefined;
        if (insertedRow !== undefined) {
          const intent = mapIntent(insertedRow);
          return Object.freeze({
            created: intent.intentId === built.intentId,
            intent,
          });
        }
        const winner = await pool.query({
          text: `select ${intentColumns} from public.meme_intents where idempotency_record_id = $1`,
          values: [claim.recordId],
        });
        return Object.freeze({
          created: false,
          intent: mapIntent(winner.rows[0]),
        });
      } catch (error) {
        return translate(error);
      }
    },

    async getIntent(input) {
      try {
        const result = await pool.query({
          text: `
            select ${intentColumns} from public.meme_intents
            where owner_user_id = $1 and intent_id = $2
          `,
          values: [
            uuidSchema.parse(input.ownerUserId),
            uuidSchema.parse(input.intentId),
          ],
        });
        return result.rows[0] === undefined ? null : mapIntent(result.rows[0]);
      } catch (error) {
        return translate(error);
      }
    },

    async reportIntentBroadcast(input) {
      try {
        return await withV2Transaction(pool, unavailable, async (client) => {
          const result = await client.query({
            text: `
              update public.meme_intents set
                state = 'broadcast_reported',
                transaction_hash = $3,
                payload_verified = $4,
                reported_at = clock_timestamp(),
                updated_at = clock_timestamp()
              where owner_user_id = $1 and intent_id = $2
                and state = 'prepared' and transaction_hash is null
              returning ${intentColumns}
            `,
            values: [
              uuidSchema.parse(input.ownerUserId),
              uuidSchema.parse(input.intentId),
              bytes32Schema.parse(input.transactionHash),
              input.payloadVerified,
            ],
          });
          const row: unknown = result.rows[0];
          if (row === undefined) {
            throw new MemeIntentReportConflictError();
          }
          const intent = mapIntent(row);
          if (intent.kind === "create") {
            await client.query({
              text: `
                update public.meme_tokens set status = 'pending_chain',
                  creator_wallet = coalesce(creator_wallet, $2),
                  updated_at = clock_timestamp()
                where meme_token_id = $1 and status = 'draft'
              `,
              values: [intent.memeTokenId, intent.walletAddress],
            });
          }
          return intent;
        });
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error as { code?: unknown }).code === "23505"
        ) {
          return translate(new MemeIntentReportConflictError());
        }
        return translate(error);
      }
    },

    async sumRecentExposureUsd(input) {
      try {
        // Decision 0104 M1: the same three-table window wallet and Launch
        // read, so MEME, Send / Swap, and Launch share one ceiling.
        return await sumCanaryExposureUsd(pool, {
          ownerUserId: uuidSchema.parse(input.ownerUserId),
          since: input.since,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async leaseReconcilableIntents(input) {
      try {
        const result = await pool.query({
          text: `
            update public.meme_intents set
              reconcile_after = clock_timestamp() + ($3::int * interval '1 millisecond')
            where intent_id in (
              select intent_id from public.meme_intents
              where chain_id = $1 and state = 'broadcast_reported'
                and transaction_hash is not null
                and (reconcile_after is null or reconcile_after <= clock_timestamp())
              order by reconcile_after nulls first, intent_id
              limit $2
              for update skip locked
            )
            returning ${intentColumns}
          `,
          values: [input.chainId, input.limit, input.leaseMs],
        });
        return Object.freeze(result.rows.map((row) => mapIntent(row)));
      } catch (error) {
        return translate(error);
      }
    },

    async markIntentPayloadVerified(input) {
      try {
        await pool.query({
          text: `
            update public.meme_intents set payload_verified = true,
              updated_at = clock_timestamp()
            where intent_id = $1 and transaction_hash = $2
          `,
          values: [
            uuidSchema.parse(input.intentId),
            bytes32Schema.parse(input.transactionHash),
          ],
        });
      } catch (error) {
        return translate(error);
      }
    },

    async settleIntent(input) {
      try {
        return await withV2Transaction(pool, unavailable, async (client) => {
          const result = await client.query({
            text: `
              update public.meme_intents set
                state = $3, reason_code = $4, receipt = $5::jsonb,
                updated_at = clock_timestamp()
              where intent_id = $1 and transaction_hash = $2
                and state = 'broadcast_reported'
              returning ${intentColumns}
            `,
            values: [
              uuidSchema.parse(input.intentId),
              bytes32Schema.parse(input.transactionHash),
              input.toState,
              input.reasonCode,
              input.receipt === null ? null : JSON.stringify(input.receipt),
            ],
          });
          const row: unknown = result.rows[0];
          if (row === undefined) {
            return null;
          }
          const intent = mapIntent(row);
          if (intent.kind === "create" && input.toState !== "confirmed") {
            await client.query({
              text: `
                update public.meme_tokens set status = 'draft',
                  updated_at = clock_timestamp()
                where meme_token_id = $1 and status = 'pending_chain'
                  and created_tx_hash is null
              `,
              values: [intent.memeTokenId],
            });
          }
          return intent;
        });
      } catch (error) {
        return translate(error);
      }
    },

    async getCheckpoint(chainId) {
      try {
        const result = await pool.query({
          text: `
            select last_block_number::text as last_block_number, last_block_hash,
              started_from_block_number::text as started_from_block_number, updated_at
            from public.indexer_checkpoints
            where lane = $1 and chain_id = $2
          `,
          values: [memeEventLane, chainId],
        });
        const raw: unknown = result.rows[0];
        if (raw === undefined) {
          return null;
        }
        const row = z
          .object({
            last_block_number: blockSchema,
            last_block_hash: bytes32Schema,
            started_from_block_number: blockSchema,
            updated_at: dateSchema,
          })
          .parse(raw);
        const record: MemeCheckpointRecord = Object.freeze({
          lastBlockNumber: row.last_block_number,
          lastBlockHash: row.last_block_hash,
          startedFromBlockNumber: row.started_from_block_number,
          updatedAt: toIsoString(row.updated_at),
        });
        return record;
      } catch (error) {
        return translate(error);
      }
    },

    async commitSegment(input: CommitMemeSegmentInput) {
      try {
        const contractAddress = addressSchema.parse(input.contractAddress);
        return await withV2Transaction(pool, unavailable, async (client) => {
          const touched = new Set<string>();
          let storedCount = 0;
          let skippedCount = 0;
          let metadataMismatchCount = 0;
          let creatorMismatchCount = 0;
          if (input.rewindFromBlockNumber !== undefined) {
            const from = blockSchema.parse(input.rewindFromBlockNumber);
            const removedTransactions = new Set<string>();
            for (const table of ["meme_indexed_events", "meme_trades"]) {
              const rewound = await client.query<{
                meme_token_id: string;
                transaction_hash: string;
              }>({
                text: `
                  update public.${table}
                  set removed = true, observed_at = clock_timestamp()
                  where chain_id = $1 and block_number >= $2::numeric and not removed
                  returning meme_token_id, transaction_hash
                `,
                values: [input.chainId, from],
              });
              for (const row of rewound.rows) {
                touched.add(row.meme_token_id);
                removedTransactions.add(row.transaction_hash);
              }
            }
            await reopenRewoundIntents(client, {
              chainId: input.chainId,
              fromBlockNumber: from,
              transactionHashes: [...removedTransactions].sort(),
            });
          }
          const byAddress = new Map<string, string | null>();
          const tokenFor = async (address: string): Promise<string | null> => {
            const cached = byAddress.get(address);
            if (cached !== undefined) {
              return cached;
            }
            const found = await findTokenByAddress(
              client,
              input.chainId,
              address,
            );
            byAddress.set(address, found);
            return found;
          };
          for (const event of input.events) {
            if (event.kind === "event" && event.eventName === "TokenCreated") {
              const matched = await matchCreated(client, input, event);
              if (matched.kind === "mismatch") {
                metadataMismatchCount += 1;
                skippedCount += 1;
                continue;
              }
              if (matched.kind === "creator_mismatch") {
                creatorMismatchCount += 1;
                skippedCount += 1;
                continue;
              }
              if (matched.kind === "foreign") {
                skippedCount += 1;
                continue;
              }
              byAddress.set(event.tokenAddress, matched.memeTokenId);
            }
            const memeTokenId = await tokenFor(event.tokenAddress);
            if (memeTokenId === null) {
              skippedCount += 1;
              continue;
            }
            touched.add(memeTokenId);
            storedCount += 1;
            if (event.kind === "trade") {
              await insertTrade(client, input.chainId, memeTokenId, event);
            } else {
              await client.query({
                text: `
                  insert into public.meme_indexed_events (
                    chain_id, transaction_hash, log_index, block_number, block_hash,
                    contract_address, token_address, meme_token_id, event_name,
                    payload, event_at, removed
                  )
                  values ($1, $2, $3, $4::numeric, $5, $6, $7, $8, $9, $10::jsonb,
                    $11::timestamptz, $12)
                  on conflict (chain_id, transaction_hash, log_index) do update set
                    block_number = excluded.block_number,
                    block_hash = excluded.block_hash,
                    contract_address = excluded.contract_address,
                    token_address = excluded.token_address,
                    meme_token_id = excluded.meme_token_id,
                    event_name = excluded.event_name,
                    payload = excluded.payload,
                    event_at = excluded.event_at,
                    removed = excluded.removed,
                    observed_at = clock_timestamp()
                `,
                values: [
                  input.chainId,
                  bytes32Schema.parse(event.transactionHash),
                  event.logIndex,
                  blockSchema.parse(event.blockNumber),
                  bytes32Schema.parse(event.blockHash),
                  contractAddress,
                  addressSchema.parse(event.tokenAddress),
                  memeTokenId,
                  event.eventName,
                  JSON.stringify(event.payload),
                  secondsToIso(event.at),
                  event.removed,
                ],
              });
            }
            if (!event.removed) {
              await confirmIntents(client, event);
            }
          }
          for (const memeTokenId of [...touched].sort()) {
            await reprojectToken(client, memeTokenId);
          }
          await client.query({
            text: `
              insert into public.indexer_checkpoints (
                lane, chain_id, last_block_number, last_block_hash,
                started_from_block_number, reorg_count
              )
              values ($1, $2, $3::numeric, $4, $5::numeric, $6)
              on conflict (lane, chain_id) do update set
                last_block_number = excluded.last_block_number,
                last_block_hash = excluded.last_block_hash,
                reorg_count = public.indexer_checkpoints.reorg_count + $6,
                updated_at = clock_timestamp()
            `,
            values: [
              memeEventLane,
              input.chainId,
              blockSchema.parse(input.checkpoint.lastBlockNumber),
              bytes32Schema.parse(input.checkpoint.lastBlockHash),
              blockSchema.parse(input.checkpoint.startedFromBlockNumber),
              input.rewindFromBlockNumber === undefined ? 0 : 1,
            ],
          });
          return Object.freeze({
            storedCount,
            skippedCount,
            metadataMismatchCount,
            creatorMismatchCount,
            touchedTokenIds: Object.freeze([...touched].sort()),
          });
        });
      } catch (error) {
        return translate(error);
      }
    },

    async countFreeSalts(scope) {
      try {
        const result = await pool.query<{ free: number }>({
          text: `
            select count(*)::int as free from public.meme_salts
            where chain_id = $1 and contract_address = $2
              and token_implementation = $3 and suffix = $4 and status = 'free'
          `,
          values: [
            scope.chainId,
            addressSchema.parse(scope.contractAddress),
            addressSchema.parse(scope.tokenImplementation),
            scope.suffix,
          ],
        });
        return result.rows[0]?.free ?? 0;
      } catch (error) {
        return translate(error);
      }
    },

    async insertSalts(input) {
      try {
        if (input.salts.length === 0) {
          return 0;
        }
        const result = await pool.query({
          text: `
            insert into public.meme_salts (
              salt, chain_id, contract_address, token_implementation,
              predicted_address, suffix
            )
            select s.salt, $1, $2, $3, s.predicted_address, $4
            from unnest($5::text[], $6::text[]) as s(salt, predicted_address)
            where not exists (
              select 1 from public.meme_tokens as t where t.salt = s.salt
            )
            on conflict (salt) do nothing
          `,
          values: [
            input.scope.chainId,
            addressSchema.parse(input.scope.contractAddress),
            addressSchema.parse(input.scope.tokenImplementation),
            input.scope.suffix,
            input.salts.map((item) => bytes32Schema.parse(item.salt)),
            input.salts.map((item) =>
              addressSchema.parse(item.predictedAddress),
            ),
          ],
        });
        return result.rowCount ?? 0;
      } catch (error) {
        return translate(error);
      }
    },

    async releaseStaleSaltReservations(before) {
      try {
        return await withV2Transaction(pool, unavailable, async (client) => {
          // The draft loses the salt (it gets another when it prepares its
          // create Intent); the salt goes back to the pool.
          const released = await client.query<{ salt: string }>({
            text: `
              update public.meme_salts as s set
                status = 'free', reserved_by_token_id = null, reserved_at = null
              from public.meme_tokens as t
              where s.status = 'reserved' and s.reserved_at < $1::timestamptz
                and t.meme_token_id = s.reserved_by_token_id
                and t.status = 'draft'
              returning s.salt
            `,
            values: [new Date(before).toISOString()],
          });
          const salts = released.rows.map((row) => row.salt);
          if (salts.length > 0) {
            await client.query({
              text: `
                update public.meme_tokens set
                  salt = null, predicted_address = null, vanity = false,
                  updated_at = clock_timestamp()
                where salt = any($1::text[]) and status = 'draft'
              `,
              values: [salts],
            });
          }
          return salts.length;
        });
      } catch (error) {
        return translate(error);
      }
    },

    async listGraduationCandidates(input) {
      try {
        const result = await pool.query({
          text: `
            select meme_token_id, token_address, full_at, graduation_attempts
            from public.meme_tokens
            where chain_id = $1 and status = 'full' and token_address is not null
              and full_at is not null and full_at <= $2::timestamptz
              and not graduation_needs_operator
              and (graduation_next_attempt_at is null
                or graduation_next_attempt_at <= $3::timestamptz)
            order by full_at asc, meme_token_id asc
            limit $4
          `,
          values: [
            input.chainId,
            new Date(input.fullBefore).toISOString(),
            new Date(input.now).toISOString(),
            input.limit,
          ],
        });
        return Object.freeze(
          result.rows.map((raw) => {
            const row = z
              .object({
                meme_token_id: uuidSchema,
                token_address: addressSchema,
                full_at: dateSchema,
                graduation_attempts: z.number().int(),
              })
              .parse(raw);
            return Object.freeze({
              memeTokenId: row.meme_token_id,
              tokenAddress: row.token_address,
              fullAt: toIsoString(row.full_at),
              graduationAttempts: row.graduation_attempts,
            });
          }),
        );
      } catch (error) {
        return translate(error);
      }
    },

    async recordGraduationAttempt(input) {
      try {
        await pool.query({
          text: `
            update public.meme_tokens set
              graduation_attempts = graduation_attempts + 1,
              graduation_error = $2,
              graduation_next_attempt_at = $3::timestamptz,
              graduation_needs_operator = $4,
              updated_at = clock_timestamp()
            where meme_token_id = $1
          `,
          values: [
            uuidSchema.parse(input.memeTokenId),
            input.errorCode,
            input.nextAttemptAt,
            input.needsOperator,
          ],
        });
      } catch (error) {
        return translate(error);
      }
    },
  };
  return Object.freeze(repository);
}

/**
 * Matches a `TokenCreated` log to a draft by salt; the metadata hash, name,
 * and symbol must equal the draft's, and the log's `creator` must be the
 * wallet of a create Intent of that draft (Decision 0104 m3: a salt is not
 * bound to its creator on chain, so a front-runner replaying the draft's
 * calldata from another wallet would otherwise take the draft). Returns
 * the token id, `foreign` for a token LOOP did not create, `mismatch`, or
 * `creator_mismatch`.
 */
async function matchCreated(
  client: PoolClient,
  input: CommitMemeSegmentInput,
  event: Extract<MemeLaneEventInput, { kind: "event" }>,
): Promise<
  | { readonly kind: "matched"; readonly memeTokenId: string }
  | { readonly kind: "foreign" }
  | { readonly kind: "mismatch" }
  | { readonly kind: "creator_mismatch" }
> {
  const salt = event.payload["salt"] ?? "";
  const found = await client.query<{
    meme_token_id: string;
    metadata_hash: string;
    name: string;
    symbol: string;
    token_address: string | null;
  }>({
    text: `
      select meme_token_id, metadata_hash, name, symbol, token_address
      from public.meme_tokens
      where chain_id = $1 and contract_address = $2 and salt = $3
      for update
    `,
    values: [input.chainId, addressSchema.parse(input.contractAddress), salt],
  });
  const row = found.rows[0];
  if (row === undefined) {
    return { kind: "foreign" };
  }
  if (
    row.metadata_hash !== event.payload["metadataHash"] ||
    row.name !== event.payload["name"] ||
    row.symbol !== event.payload["symbol"] ||
    (row.token_address !== null && row.token_address !== event.tokenAddress)
  ) {
    return { kind: "mismatch" };
  }
  const creator = (event.payload["creator"] ?? "").toLowerCase();
  const createdBy = await client.query<{ intent_id: string }>({
    text: `
      select intent_id from public.meme_intents
      where meme_token_id = $1 and kind = 'create' and wallet_address = $2
      limit 1
    `,
    values: [row.meme_token_id, creator],
  });
  if (createdBy.rows[0] === undefined) {
    return { kind: "creator_mismatch" };
  }
  const assetId = `${input.chainId}:${event.tokenAddress}`;
  if (!event.removed) {
    // The Asset Registry row: name and symbol come from the TokenCreated
    // log at its block (the chain_call evidence), decimals are the clone's.
    await client.query({
      text: `
        insert into public.assets (
          asset_id, chain_id, address, symbol, name, decimals, status,
          source_kind, source_block_number, source_verified_at
        )
        values ($1, $2, $3, $4, $5, 18, 'pending', 'chain_call', $6::bigint,
          clock_timestamp())
        on conflict (asset_id) do nothing
      `,
      values: [
        assetId,
        input.chainId,
        event.tokenAddress,
        row.symbol,
        row.name,
        event.blockNumber,
      ],
    });
  }
  await client.query({
    text: `
      update public.meme_tokens set
        token_address = $2,
        creator_wallet = $3,
        asset_id = coalesce(asset_id, (select asset_id from public.assets where asset_id = $4)),
        updated_at = clock_timestamp()
      where meme_token_id = $1
    `,
    values: [
      row.meme_token_id,
      event.tokenAddress,
      addressSchema.parse(event.payload["creator"] ?? ""),
      assetId,
    ],
  });
  if (!event.removed) {
    await client.query({
      text: `
        update public.meme_salts set status = 'used', used_at = clock_timestamp()
        where salt = $1 and status <> 'used'
      `,
      values: [salt],
    });
  }
  return { kind: "matched", memeTokenId: row.meme_token_id };
}

async function insertTrade(
  client: PoolClient,
  chainId: string,
  memeTokenId: string,
  event: Extract<MemeLaneEventInput, { kind: "trade" }>,
): Promise<void> {
  await client.query({
    text: `
      insert into public.meme_trades (
        chain_id, transaction_hash, log_index, block_number, block_hash,
        token_address, meme_token_id, wallet, is_buy, usd1_amount, token_amount,
        fee_usd1, v_usd1_after, v_token_after, sold_after, price_after_e18,
        traded_at, removed
      )
      values ($1, $2, $3, $4::numeric, $5, $6, $7, $8, $9, $10::numeric,
        $11::numeric, $12::numeric, $13::numeric, $14::numeric, $15::numeric,
        $16::numeric, $17::timestamptz, $18)
      on conflict (chain_id, transaction_hash, log_index) do update set
        block_number = excluded.block_number,
        block_hash = excluded.block_hash,
        token_address = excluded.token_address,
        meme_token_id = excluded.meme_token_id,
        wallet = excluded.wallet,
        is_buy = excluded.is_buy,
        usd1_amount = excluded.usd1_amount,
        token_amount = excluded.token_amount,
        fee_usd1 = excluded.fee_usd1,
        v_usd1_after = excluded.v_usd1_after,
        v_token_after = excluded.v_token_after,
        sold_after = excluded.sold_after,
        price_after_e18 = excluded.price_after_e18,
        traded_at = excluded.traded_at,
        removed = excluded.removed,
        observed_at = clock_timestamp()
    `,
    values: [
      chainId,
      bytes32Schema.parse(event.transactionHash),
      event.logIndex,
      blockSchema.parse(event.blockNumber),
      bytes32Schema.parse(event.blockHash),
      addressSchema.parse(event.tokenAddress),
      memeTokenId,
      addressSchema.parse(event.wallet),
      event.isBuy,
      rawSchema.parse(event.usd1Amount),
      rawSchema.parse(event.tokenAmount),
      rawSchema.parse(event.feeUsd1),
      rawSchema.parse(event.vUsd1After),
      rawSchema.parse(event.vTokenAfter),
      rawSchema.parse(event.soldAfter),
      rawSchema.parse(event.priceAfterE18),
      secondsToIso(event.at),
      event.removed,
    ],
  });
}

/**
 * Decision 0104 M5: a rewind takes back the evidence of every Intent it
 * confirmed. A `confirmed` Intent whose transaction had a log in the
 * rewound range, or whose receipt block is in it, returns to
 * `broadcast_reported` (receipt cleared, reconcile due now) so the lane's
 * replay or the receipt reconcile confirms it again on the new chain.
 */
async function reopenRewoundIntents(
  client: PoolClient,
  input: {
    readonly chainId: string;
    readonly fromBlockNumber: string;
    readonly transactionHashes: readonly string[];
  },
): Promise<void> {
  await client.query({
    text: `
      update public.meme_intents set
        state = 'broadcast_reported', reason_code = null, receipt = null,
        reconcile_after = null, updated_at = clock_timestamp()
      where chain_id = $1 and state = 'confirmed'
        and transaction_hash is not null
        and (
          transaction_hash = any($2::text[])
          or (
            receipt is not null
            and (receipt ->> 'blockNumber') ~ '^[0-9]{1,19}$'
            and (receipt ->> 'blockNumber')::numeric >= $3::numeric
          )
        )
    `,
    values: [
      input.chainId,
      [...input.transactionHashes],
      input.fromBlockNumber,
    ],
  });
}

/**
 * The lane is evidence: a TokenCreated log confirms the create Intent of
 * its transaction, a Trade log the Intent of its transaction and wallet.
 * An Intent the reconcile part had expired (no receipt seen in time) is
 * confirmed too when its log shows up later.
 */
async function confirmIntents(
  client: PoolClient,
  event: MemeLaneEventInput,
): Promise<void> {
  if (event.kind === "trade") {
    await client.query({
      text: `
        update public.meme_intents set state = 'confirmed', reason_code = null,
          updated_at = clock_timestamp()
        where transaction_hash = $1 and wallet_address = $2
          and state in ('broadcast_reported', 'expired')
      `,
      values: [event.transactionHash, event.wallet],
    });
    return;
  }
  if (event.eventName === "TokenCreated") {
    await client.query({
      text: `
        update public.meme_intents set state = 'confirmed', reason_code = null,
          updated_at = clock_timestamp()
        where transaction_hash = $1 and kind = 'create'
          and state in ('broadcast_reported', 'expired')
      `,
      values: [event.transactionHash],
    });
  }
}

export function createUnavailableMemeRepository(): MemeRepository {
  const fail = (): Promise<never> =>
    Promise.reject(new MemeRepositoryUnavailableError());
  return Object.freeze({
    getToken: fail,
    listTokens: fail,
    rankHotTokens: fail,
    rankBestTrades: fail,
    listTokensByIds: fail,
    tokenStats: fail,
    listTrades: fail,
    listCandles: fail,
    listHolders: fail,
    createDraft: fail,
    replaceDraftSalt: fail,
    touchDraftSalt: fail,
    createIntent: fail,
    getIntent: fail,
    reportIntentBroadcast: fail,
    sumRecentExposureUsd: fail,
    leaseReconcilableIntents: fail,
    markIntentPayloadVerified: fail,
    settleIntent: fail,
    getCheckpoint: fail,
    commitSegment: fail,
    countFreeSalts: fail,
    insertSalts: fail,
    releaseStaleSaltReservations: fail,
    listGraduationCandidates: fail,
    recordGraduationAttempt: fail,
  });
}
