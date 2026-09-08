import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import {
  assetIdPatternSource,
  blockHashPatternSource,
  evmAddressPatternSource,
  reasonCodePatternSource,
  transactionHashPatternSource,
} from "../features/chain/chain-contract.js";
import {
  openWalletIntentStates,
  simulationStatuses,
  walletIntentKinds,
  walletIntentReasonCodes,
  walletIntentStates,
  type IntentPublicReview,
  type IntentSource,
  type SimulationStatus,
  type WalletIntentKind,
  type WalletIntentState,
} from "../features/wallet-intents/intent-contract.js";

/**
 * Storage for unified wallet intents (Decision 0035). The payload columns are
 * frozen by trigger; this repository only ever changes state, hash, action
 * ID, reason, receipt, and reconciliation columns, and every change appends
 * one `wallet_intent_events` row in the same transaction.
 */

const uuidSchema = z.string().uuid();
const bigintStringSchema = z.string().regex(/^[0-9]+$/);
const validDateSchema = z
  .instanceof(Date)
  .refine((value) => !Number.isNaN(value.getTime()));

const intentRowSchema = z
  .object({
    intent_id: uuidSchema,
    owner_user_id: uuidSchema,
    wallet_id: uuidSchema,
    provider_operation_id: uuidSchema.nullable(),
    kind: z.enum(walletIntentKinds),
    state: z.enum(walletIntentStates),
    chain_id: z.string(),
    canonical_payload: z.record(z.string(), z.unknown()),
    public_review: z.record(z.string(), z.unknown()),
    review_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    policy_config_version: z.string(),
    facts_observed_at: validDateSchema,
    expires_at: validDateSchema,
    simulation_status: z.enum(simulationStatuses),
    transaction_hash: z
      .string()
      .regex(new RegExp(transactionHashPatternSource))
      .nullable(),
    provider_action_id: z.string().nullable(),
    reason_code: z
      .string()
      .regex(new RegExp(reasonCodePatternSource))
      .nullable(),
    receipt: z.record(z.string(), z.unknown()).nullable(),
    reconcile_after: validDateSchema.nullable(),
    reconcile_attempt_count: z.number().int().min(0),
    payload_verified: z.boolean(),
    record_version: bigintStringSchema,
    created_at: validDateSchema,
    updated_at: validDateSchema,
  })
  .strict();

const intentColumns = `
  intent_id,
  owner_user_id,
  wallet_id,
  provider_operation_id,
  kind,
  state,
  chain_id,
  canonical_payload,
  public_review,
  review_sha256,
  policy_config_version,
  facts_observed_at,
  expires_at,
  simulation_status,
  transaction_hash,
  provider_action_id,
  reason_code,
  receipt,
  reconcile_after,
  reconcile_attempt_count,
  payload_verified,
  record_version::text as record_version,
  created_at,
  updated_at
`;

export interface IntentReceipt {
  readonly status: "success" | "reverted";
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly gasUsed: string;
  readonly effectiveGasPrice: string;
  readonly observedAt: string;
}

export interface WalletIntentRecord {
  readonly intentId: string;
  readonly ownerUserId: string;
  readonly walletId: string;
  readonly providerOperationId: string | null;
  readonly kind: WalletIntentKind;
  readonly state: WalletIntentState;
  readonly chainId: string;
  readonly canonicalPayload: IntentSource;
  readonly publicReview: IntentPublicReview;
  readonly reviewSha256: string;
  readonly policyConfigVersion: string;
  readonly factsObservedAt: string;
  readonly expiresAt: string;
  readonly simulationStatus: SimulationStatus;
  readonly transactionHash: string | null;
  readonly providerActionId: string | null;
  readonly reasonCode: string | null;
  readonly receipt: IntentReceipt | null;
  readonly reconcileAfter: string | null;
  readonly reconcileAttemptCount: number;
  /** True once the broadcast transaction was compared with the payload and matched. */
  readonly payloadVerified: boolean;
  readonly recordVersion: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateWalletIntentInput {
  readonly intentId: string;
  readonly ownerUserId: string;
  readonly walletId: string;
  readonly providerOperationId: string | null;
  readonly kind: WalletIntentKind;
  readonly state: "prepared" | "awaiting_signature";
  readonly chainId: string;
  readonly canonicalPayload: IntentSource;
  readonly publicReview: IntentPublicReview;
  readonly reviewSha256: string;
  readonly policyConfigVersion: string;
  readonly factsObservedAt: string;
  readonly expiresAt: string;
  readonly simulationStatus: SimulationStatus;
  readonly requestId: string;
}

export interface TransitionWalletIntentInput {
  readonly ownerUserId: string;
  readonly intentId: string;
  readonly expectedVersion: string;
  readonly fromStates: readonly WalletIntentState[];
  readonly toState: WalletIntentState;
  readonly eventType: string;
  readonly actorType: "api" | "worker";
  readonly requestId: string;
  readonly reasonCode?: string | null;
  readonly transactionHash?: string | null;
  readonly providerActionId?: string | null;
  readonly receipt?: IntentReceipt | null;
  readonly reconcileAfter?: string | null;
  readonly payloadVerified?: boolean;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface StoredSwapQuote {
  readonly quoteId: string;
  readonly ownerUserId: string;
  readonly walletId: string;
  readonly snapshot: Readonly<Record<string, unknown>>;
  readonly expiresAt: string;
  readonly consumedByIntentId: string | null;
}

export interface RecordWalletIntentEventInput {
  readonly ownerUserId: string;
  readonly intentId: string;
  readonly eventType: string;
  readonly actorType: "api" | "worker";
  readonly requestId: string;
  readonly reasonCode?: string | null;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ListWalletIntentsInput {
  readonly ownerUserId: string;
  readonly limit: number;
  readonly before?: {
    readonly createdAt: string;
    readonly intentId: string;
  };
}

export interface WalletIntentPage {
  readonly items: readonly WalletIntentRecord[];
  readonly hasMore: boolean;
}

export interface ApprovalObservationInput {
  readonly walletId: string;
  readonly assetId: string;
  readonly spenderAddress: string;
  readonly rawValue: string;
  readonly blockNumber: string;
  readonly blockHash: string;
}

export interface WalletIntentRepository {
  /**
   * Inserts the intent and, in the same transaction, expires every other
   * open intent of the same wallet: the new intent carries newer facts (a
   * nonce, a balance, a quote), so the older review is no longer what the
   * chain would see.
   */
  create(input: CreateWalletIntentInput): Promise<WalletIntentRecord>;
  get(
    ownerUserId: string,
    intentId: string,
  ): Promise<WalletIntentRecord | null>;
  findByOperationId(
    ownerUserId: string,
    operationId: string,
  ): Promise<WalletIntentRecord | null>;
  list(input: ListWalletIntentsInput): Promise<WalletIntentPage>;
  transition(input: TransitionWalletIntentInput): Promise<WalletIntentRecord>;
  recordEvent(input: RecordWalletIntentEventInput): Promise<void>;
  /** Moves elapsed open intents to `expired`; returns how many changed. */
  expireElapsed(input: {
    readonly requestId: string;
    readonly limit: number;
  }): Promise<number>;
  /**
   * Leases `submitted`/`unknown` intents whose `reconcile_after` has passed
   * by pushing `reconcile_after` forward; a crashed worker's lease simply
   * lapses.
   */
  leaseReconcilable(input: {
    readonly limit: number;
    readonly leaseMs: number;
  }): Promise<readonly WalletIntentRecord[]>;
  recordApprovalObservation(input: ApprovalObservationInput): Promise<void>;
  storeSwapQuote(input: {
    readonly quoteId: string;
    readonly ownerUserId: string;
    readonly walletId: string;
    readonly snapshot: Readonly<Record<string, unknown>>;
    readonly expiresAt: string;
  }): Promise<void>;
  /** Reads an owner's quote without consuming it. */
  getSwapQuote(
    ownerUserId: string,
    quoteId: string,
  ): Promise<StoredSwapQuote | null>;
  /**
   * Binds the quote to one intent. Returns null when the quote is unknown,
   * belongs to another owner, or was already consumed: a quote is spent once.
   */
  consumeSwapQuote(input: {
    readonly ownerUserId: string;
    readonly quoteId: string;
    readonly intentId: string;
  }): Promise<StoredSwapQuote | null>;
}

export class WalletIntentUnavailableError extends Error {
  readonly code = "wallet_intent_unavailable";

  constructor() {
    super("The wallet intent repository is unavailable");
    this.name = "WalletIntentUnavailableError";
  }
}

export class WalletIntentStateConflictError extends Error {
  readonly code = "wallet_intent_state_conflict";

  constructor() {
    super("The wallet intent cannot make the requested transition");
    this.name = "WalletIntentStateConflictError";
  }
}

const receiptSchema = z
  .object({
    status: z.enum(["success", "reverted"]),
    blockNumber: bigintStringSchema,
    blockHash: z.string().regex(new RegExp(blockHashPatternSource)),
    gasUsed: bigintStringSchema,
    effectiveGasPrice: bigintStringSchema,
    observedAt: z.string(),
  })
  .strict();

function mapIntent(row: unknown): WalletIntentRecord {
  const parsed = intentRowSchema.parse(row);
  return Object.freeze({
    intentId: parsed.intent_id,
    ownerUserId: parsed.owner_user_id,
    walletId: parsed.wallet_id,
    providerOperationId: parsed.provider_operation_id,
    kind: parsed.kind,
    state: parsed.state,
    chainId: parsed.chain_id,
    canonicalPayload: parsed.canonical_payload as unknown as IntentSource,
    publicReview: parsed.public_review as unknown as IntentPublicReview,
    reviewSha256: parsed.review_sha256,
    policyConfigVersion: parsed.policy_config_version,
    factsObservedAt: parsed.facts_observed_at.toISOString(),
    expiresAt: parsed.expires_at.toISOString(),
    simulationStatus: parsed.simulation_status,
    transactionHash: parsed.transaction_hash,
    providerActionId: parsed.provider_action_id,
    reasonCode: parsed.reason_code,
    receipt:
      parsed.receipt === null ? null : receiptSchema.parse(parsed.receipt),
    reconcileAfter: parsed.reconcile_after?.toISOString() ?? null,
    reconcileAttemptCount: parsed.reconcile_attempt_count,
    payloadVerified: parsed.payload_verified,
    recordVersion: parsed.record_version,
    createdAt: parsed.created_at.toISOString(),
    updatedAt: parsed.updated_at.toISOString(),
  });
}

async function appendEvent(
  client: Pick<PoolClient, "query">,
  input: {
    readonly intentId: string;
    readonly ownerUserId: string;
    readonly eventType: string;
    readonly fromState: WalletIntentState | null;
    readonly toState: WalletIntentState;
    readonly reasonCode: string | null;
    readonly requestId: string;
    readonly actorType: "api" | "worker";
    readonly details: Readonly<
      Record<string, string | number | boolean | null>
    >;
  },
): Promise<void> {
  await client.query({
    text: `
      insert into public.wallet_intent_events (
        intent_id, owner_user_id, event_type, from_state, to_state,
        reason_code, request_id, actor_type, details
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
    `,
    values: [
      input.intentId,
      input.ownerUserId,
      input.eventType,
      input.fromState,
      input.toState,
      input.reasonCode,
      input.requestId,
      input.actorType,
      JSON.stringify(input.details),
    ],
  });
}

async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query("begin");
    inTransaction = true;
    const result = await operation(client);
    await client.query("commit");
    inTransaction = false;
    return result;
  } catch (error) {
    if (inTransaction) {
      try {
        await client.query("rollback");
      } catch {
        // The original failure stays authoritative.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

const swapQuoteRowSchema = z
  .object({
    quote_id: uuidSchema,
    owner_user_id: uuidSchema,
    wallet_id: uuidSchema,
    snapshot: z.record(z.string(), z.unknown()),
    expires_at: validDateSchema,
    consumed_by_intent_id: uuidSchema.nullable(),
  })
  .strict();

const swapQuoteColumns = `
  quote_id, owner_user_id, wallet_id, snapshot, expires_at, consumed_by_intent_id
`;

function mapSwapQuote(row: unknown): StoredSwapQuote {
  const parsed = swapQuoteRowSchema.parse(row);
  return Object.freeze({
    quoteId: parsed.quote_id,
    ownerUserId: parsed.owner_user_id,
    walletId: parsed.wallet_id,
    snapshot: Object.freeze({ ...parsed.snapshot }),
    expiresAt: parsed.expires_at.toISOString(),
    consumedByIntentId: parsed.consumed_by_intent_id,
  });
}

function unavailable(): Promise<never> {
  return Promise.reject(new WalletIntentUnavailableError());
}

export function createUnavailableWalletIntentRepository(): WalletIntentRepository {
  return Object.freeze({
    create: unavailable,
    get: unavailable,
    findByOperationId: unavailable,
    list: unavailable,
    transition: unavailable,
    recordEvent: unavailable,
    expireElapsed: unavailable,
    leaseReconcilable: unavailable,
    recordApprovalObservation: unavailable,
    storeSwapQuote: unavailable,
    getSwapQuote: unavailable,
    consumeSwapQuote: unavailable,
  });
}

export function createPostgresWalletIntentRepository(
  pool: Pool,
): WalletIntentRepository {
  return Object.freeze({
    async create(input: CreateWalletIntentInput): Promise<WalletIntentRecord> {
      return withTransaction(pool, async (client) => {
        const superseded = await client.query<Record<string, unknown>>({
          text: `
            update public.wallet_intents
            set
              state = 'expired',
              reason_code = $3,
              record_version = record_version + 1,
              updated_at = clock_timestamp()
            where wallet_id = $1
              and owner_user_id = $2
              and state = any($4::text[])
            returning intent_id, owner_user_id
          `,
          values: [
            input.walletId,
            input.ownerUserId,
            walletIntentReasonCodes.superseded,
            [...openWalletIntentStates],
          ],
        });
        for (const row of superseded.rows) {
          await appendEvent(client, {
            intentId: uuidSchema.parse(row["intent_id"]),
            ownerUserId: uuidSchema.parse(row["owner_user_id"]),
            eventType: "intent_superseded",
            fromState: null,
            toState: "expired",
            reasonCode: walletIntentReasonCodes.superseded,
            requestId: input.requestId,
            actorType: "api",
            details: { supersededBy: input.intentId },
          });
        }
        const inserted = await client.query<Record<string, unknown>>({
          text: `
            insert into public.wallet_intents (
              intent_id, owner_user_id, wallet_id, provider_operation_id, kind,
              state, chain_id, canonical_payload, public_review, review_sha256,
              policy_config_version, facts_observed_at, expires_at,
              simulation_status
            )
            values (
              $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11,
              $12::timestamptz, $13::timestamptz, $14
            )
            returning ${intentColumns}
          `,
          values: [
            input.intentId,
            input.ownerUserId,
            input.walletId,
            input.providerOperationId,
            input.kind,
            input.state,
            input.chainId,
            JSON.stringify(input.canonicalPayload),
            JSON.stringify(input.publicReview),
            input.reviewSha256,
            input.policyConfigVersion,
            input.factsObservedAt,
            input.expiresAt,
            input.simulationStatus,
          ],
        });
        const record = mapIntent(inserted.rows[0]);
        await appendEvent(client, {
          intentId: record.intentId,
          ownerUserId: record.ownerUserId,
          eventType: "intent_prepared",
          fromState: null,
          toState: record.state,
          reasonCode:
            record.simulationStatus === "passed"
              ? null
              : record.simulationStatus === "reverted"
                ? walletIntentReasonCodes.simulationReverted
                : walletIntentReasonCodes.simulationUnavailable,
          requestId: input.requestId,
          actorType: "api",
          details: {
            kind: record.kind,
            reviewSha256: record.reviewSha256,
            simulation: record.simulationStatus,
          },
        });
        return record;
      });
    },

    async get(
      ownerUserId: string,
      intentId: string,
    ): Promise<WalletIntentRecord | null> {
      const result = await pool.query<Record<string, unknown>>({
        text: `
          select ${intentColumns}
          from public.wallet_intents
          where owner_user_id = $1 and intent_id = $2
          limit 1
        `,
        values: [ownerUserId, intentId],
      });
      const row = result.rows[0];
      return row === undefined ? null : mapIntent(row);
    },

    async findByOperationId(
      ownerUserId: string,
      operationId: string,
    ): Promise<WalletIntentRecord | null> {
      const result = await pool.query<Record<string, unknown>>({
        text: `
          select ${intentColumns}
          from public.wallet_intents
          where owner_user_id = $1 and provider_operation_id = $2
          limit 1
        `,
        values: [ownerUserId, operationId],
      });
      const row = result.rows[0];
      return row === undefined ? null : mapIntent(row);
    },

    async list(input: ListWalletIntentsInput): Promise<WalletIntentPage> {
      const result = await pool.query<Record<string, unknown>>({
        text: `
          select ${intentColumns}
          from public.wallet_intents
          where owner_user_id = $1
            and (
              $2::timestamptz is null
              or created_at < $2::timestamptz
              or (created_at = $2::timestamptz and intent_id < $3::uuid)
            )
          order by created_at desc, intent_id desc
          limit $4
        `,
        values: [
          input.ownerUserId,
          input.before?.createdAt ?? null,
          input.before?.intentId ?? null,
          input.limit + 1,
        ],
      });
      const rows = result.rows.map(mapIntent);
      return Object.freeze({
        items: Object.freeze(rows.slice(0, input.limit)),
        hasMore: rows.length > input.limit,
      });
    },

    async transition(
      input: TransitionWalletIntentInput,
    ): Promise<WalletIntentRecord> {
      return withTransaction(pool, async (client) => {
        const current = await client.query<Record<string, unknown>>({
          text: `
            select state
            from public.wallet_intents
            where owner_user_id = $1 and intent_id = $2
            for update
          `,
          values: [input.ownerUserId, input.intentId],
        });
        const fromState = current.rows[0]?.["state"];
        const result = await client.query<Record<string, unknown>>({
          text: `
            update public.wallet_intents
            set
              state = $4,
              reason_code = case when $5::boolean then $6 else reason_code end,
              transaction_hash =
                case when $7::boolean then $8 else transaction_hash end,
              provider_action_id =
                case when $9::boolean then $10 else provider_action_id end,
              receipt = case when $11::boolean then $12::jsonb else receipt end,
              reconcile_after =
                case when $13::boolean then $14::timestamptz else reconcile_after end,
              payload_verified =
                case when $16::boolean then $17::boolean else payload_verified end,
              record_version = record_version + 1,
              updated_at = clock_timestamp()
            where owner_user_id = $1
              and intent_id = $2
              and record_version = $3::bigint
              and state = any($15::text[])
            returning ${intentColumns}
          `,
          values: [
            input.ownerUserId,
            input.intentId,
            input.expectedVersion,
            input.toState,
            input.reasonCode !== undefined,
            input.reasonCode ?? null,
            input.transactionHash !== undefined,
            input.transactionHash ?? null,
            input.providerActionId !== undefined,
            input.providerActionId ?? null,
            input.receipt !== undefined,
            input.receipt === undefined || input.receipt === null
              ? null
              : JSON.stringify(input.receipt),
            input.reconcileAfter !== undefined,
            input.reconcileAfter ?? null,
            [...input.fromStates],
            input.payloadVerified !== undefined,
            input.payloadVerified ?? false,
          ],
        });
        const row = result.rows[0];
        if (row === undefined) {
          throw new WalletIntentStateConflictError();
        }
        const record = mapIntent(row);
        await appendEvent(client, {
          intentId: record.intentId,
          ownerUserId: record.ownerUserId,
          eventType: input.eventType,
          fromState: z.enum(walletIntentStates).parse(fromState),
          toState: record.state,
          reasonCode: input.reasonCode ?? null,
          requestId: input.requestId,
          actorType: input.actorType,
          details: input.details ?? {},
        });
        return record;
      });
    },

    async recordEvent(input: RecordWalletIntentEventInput): Promise<void> {
      const current = await pool.query<Record<string, unknown>>({
        text: `
          select state from public.wallet_intents
          where owner_user_id = $1 and intent_id = $2
        `,
        values: [input.ownerUserId, input.intentId],
      });
      const state = z
        .enum(walletIntentStates)
        .parse(current.rows[0]?.["state"]);
      await appendEvent(pool, {
        intentId: input.intentId,
        ownerUserId: input.ownerUserId,
        eventType: input.eventType,
        fromState: state,
        toState: state,
        reasonCode: input.reasonCode ?? null,
        requestId: input.requestId,
        actorType: input.actorType,
        details: input.details ?? {},
      });
    },

    async expireElapsed(input: {
      readonly requestId: string;
      readonly limit: number;
    }): Promise<number> {
      return withTransaction(pool, async (client) => {
        const result = await client.query<Record<string, unknown>>({
          text: `
            with due as (
              select intent_id
              from public.wallet_intents
              where state = any($1::text[])
                and expires_at <= clock_timestamp()
              order by expires_at
              for update skip locked
              limit $2
            )
            update public.wallet_intents as intent
            set
              state = 'expired',
              reason_code = $3,
              record_version = intent.record_version + 1,
              updated_at = clock_timestamp()
            from due
            where intent.intent_id = due.intent_id
            returning intent.intent_id, intent.owner_user_id
          `,
          values: [
            [...openWalletIntentStates],
            input.limit,
            walletIntentReasonCodes.expired,
          ],
        });
        for (const row of result.rows) {
          await appendEvent(client, {
            intentId: uuidSchema.parse(row["intent_id"]),
            ownerUserId: uuidSchema.parse(row["owner_user_id"]),
            eventType: "intent_expired",
            fromState: null,
            toState: "expired",
            reasonCode: walletIntentReasonCodes.expired,
            requestId: input.requestId,
            actorType: "worker",
            details: {},
          });
        }
        return result.rows.length;
      });
    },

    async leaseReconcilable(input: {
      readonly limit: number;
      readonly leaseMs: number;
    }): Promise<readonly WalletIntentRecord[]> {
      const result = await pool.query<Record<string, unknown>>({
        text: `
          with due as (
            select intent_id as due_intent_id
            from public.wallet_intents
            where state in ('submitted', 'unknown')
              and (reconcile_after is null or reconcile_after <= clock_timestamp())
            order by reconcile_after nulls first, created_at
            for update skip locked
            limit $1
          )
          update public.wallet_intents as intent
          set
            reconcile_after = clock_timestamp()
              + ($2::integer * interval '1 millisecond'),
            reconcile_attempt_count = intent.reconcile_attempt_count + 1,
            record_version = intent.record_version + 1,
            updated_at = clock_timestamp()
          from due
          where intent.intent_id = due.due_intent_id
          returning ${intentColumns}
        `,
        values: [input.limit, input.leaseMs],
      });
      return Object.freeze(result.rows.map(mapIntent));
    },

    async recordApprovalObservation(
      input: ApprovalObservationInput,
    ): Promise<void> {
      z.object({
        walletId: uuidSchema,
        assetId: z.string().regex(new RegExp(assetIdPatternSource)),
        spenderAddress: z.string().regex(new RegExp(evmAddressPatternSource)),
        rawValue: bigintStringSchema,
        blockNumber: bigintStringSchema,
        blockHash: z.string().regex(new RegExp(blockHashPatternSource)),
      })
        .strict()
        .parse(input);
      await pool.query({
        text: `
          insert into public.approval_observations (
            wallet_id, asset_id, spender_address, raw_value, block_number, block_hash
          )
          values ($1, $2, $3, $4::numeric, $5::numeric, $6)
        `,
        values: [
          input.walletId,
          input.assetId,
          input.spenderAddress,
          input.rawValue,
          input.blockNumber,
          input.blockHash,
        ],
      });
    },

    async storeSwapQuote(input: {
      readonly quoteId: string;
      readonly ownerUserId: string;
      readonly walletId: string;
      readonly snapshot: Readonly<Record<string, unknown>>;
      readonly expiresAt: string;
    }): Promise<void> {
      await pool.query({
        text: `
          insert into public.swap_quotes (
            quote_id, owner_user_id, wallet_id, snapshot, expires_at
          )
          values ($1, $2, $3, $4::jsonb, $5::timestamptz)
        `,
        values: [
          input.quoteId,
          input.ownerUserId,
          input.walletId,
          JSON.stringify(input.snapshot),
          input.expiresAt,
        ],
      });
    },

    async getSwapQuote(
      ownerUserId: string,
      quoteId: string,
    ): Promise<StoredSwapQuote | null> {
      const result = await pool.query<Record<string, unknown>>({
        text: `
          select ${swapQuoteColumns}
          from public.swap_quotes
          where owner_user_id = $1 and quote_id = $2
          limit 1
        `,
        values: [ownerUserId, quoteId],
      });
      const row = result.rows[0];
      return row === undefined ? null : mapSwapQuote(row);
    },

    async consumeSwapQuote(input: {
      readonly ownerUserId: string;
      readonly quoteId: string;
      readonly intentId: string;
    }): Promise<StoredSwapQuote | null> {
      const result = await pool.query<Record<string, unknown>>({
        text: `
          update public.swap_quotes
          set consumed_by_intent_id = $3
          where owner_user_id = $1
            and quote_id = $2
            and consumed_by_intent_id is null
            and expires_at > clock_timestamp()
          returning ${swapQuoteColumns}
        `,
        values: [input.ownerUserId, input.quoteId, input.intentId],
      });
      const row = result.rows[0];
      return row === undefined ? null : mapSwapQuote(row);
    },
  });
}
