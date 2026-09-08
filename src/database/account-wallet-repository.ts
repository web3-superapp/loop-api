import type { Pool } from "pg";
import { z } from "zod";

import {
  evmAddressPatternSource,
  walletKinds,
  type WalletKind,
} from "../features/chain/chain-contract.js";

/**
 * LOOP's own wallet inventory (Decision 0033). Privy remains authoritative for
 * which wallets exist; this table only issues the opaque `wallet_id` the API
 * publishes and remembers which wallet the account selected as active.
 */

const walletRowSchema = z
  .object({
    wallet_id: z.string().uuid(),
    provider_wallet_id: z.string().min(1).max(128).nullable(),
    address: z.string().regex(new RegExp(evmAddressPatternSource)),
    kind: z.enum(walletKinds),
    status: z.enum(["active", "archived"]),
    is_active: z.boolean(),
    first_seen_at: z.date(),
    last_seen_at: z.date(),
  })
  .strict();

export interface AccountWalletRecord {
  readonly walletId: string;
  readonly providerWalletId: string | null;
  readonly address: string;
  readonly kind: WalletKind;
  readonly status: "active" | "archived";
  readonly isActive: boolean;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

export interface ObservedWallet {
  readonly address: string;
  readonly kind: WalletKind;
  readonly providerWalletId: string | null;
}

export interface SyncAccountWalletsInput {
  readonly ownerUserId: string;
  readonly observed: readonly ObservedWallet[];
}

export interface AccountWalletRepository {
  /**
   * Reconciles the wallets Privy reports for the account and returns the
   * complete inventory. Wallets Privy no longer reports are archived, never
   * deleted, so an activity or balance row keeps a resolvable owner.
   */
  sync(input: SyncAccountWalletsInput): Promise<readonly AccountWalletRecord[]>;
  list(ownerUserId: string): Promise<readonly AccountWalletRecord[]>;
  get(
    ownerUserId: string,
    walletId: string,
  ): Promise<AccountWalletRecord | null>;
  /**
   * Compare-and-swap activation. `expectedActiveWalletId` is the wallet the
   * caller believed was active (`null` when it believed none was), so a
   * concurrent switch from another device is a conflict, not a silent
   * overwrite.
   */
  setActive(input: {
    readonly ownerUserId: string;
    readonly walletId: string;
    readonly expectedActiveWalletId: string | null;
  }): Promise<readonly AccountWalletRecord[]>;
  recordBalanceSnapshot(input: {
    readonly walletId: string;
    readonly assetId: string;
    readonly blockNumber: string;
    readonly blockHash: string;
    readonly rawValue: string;
  }): Promise<void>;
}

export class AccountWalletUnavailableError extends Error {
  readonly code = "account_wallet_unavailable";

  constructor() {
    super("The account wallet repository is unavailable");
    this.name = "AccountWalletUnavailableError";
  }
}

export class AccountWalletVersionConflictError extends Error {
  readonly code = "account_wallet_version_conflict";

  constructor() {
    super("The active wallet changed before this request committed");
    this.name = "AccountWalletVersionConflictError";
  }
}

/**
 * Privy reported no wallet at all while LOOP still holds active rows. That is
 * indistinguishable from a Provider outage, so the inventory is left untouched
 * rather than archiving wallets the user still owns.
 */
export class AccountWalletObservationEmptyError extends Error {
  readonly code = "account_wallet_observation_empty";

  constructor() {
    super("The wallet inventory observation was empty");
    this.name = "AccountWalletObservationEmptyError";
  }
}

export class AccountWalletNotFoundError extends Error {
  readonly code = "account_wallet_not_found";

  constructor() {
    super("The wallet does not belong to this account");
    this.name = "AccountWalletNotFoundError";
  }
}

const walletColumns = `
  wallet_id,
  provider_wallet_id,
  address,
  kind,
  status,
  is_active,
  first_seen_at,
  last_seen_at
`;

function mapWallet(row: unknown): AccountWalletRecord {
  const parsed = walletRowSchema.parse(row);
  return Object.freeze({
    walletId: parsed.wallet_id,
    providerWalletId: parsed.provider_wallet_id,
    address: parsed.address,
    kind: parsed.kind,
    status: parsed.status,
    isActive: parsed.is_active,
    firstSeenAt: parsed.first_seen_at.toISOString(),
    lastSeenAt: parsed.last_seen_at.toISOString(),
  });
}

const listSql = `
  select ${walletColumns}
  from public.account_wallets
  where owner_user_id = $1
  order by (status = 'active') desc, kind asc, first_seen_at asc, wallet_id asc
`;

export function createPostgresAccountWalletRepository(
  pool: Pool,
): AccountWalletRepository {
  return Object.freeze({
    async sync(
      input: SyncAccountWalletsInput,
    ): Promise<readonly AccountWalletRecord[]> {
      const client = await pool.connect();
      let inTransaction = false;
      try {
        await client.query("begin");
        inTransaction = true;

        if (input.observed.length === 0) {
          const active = await client.query<Record<string, unknown>>({
            text: `
              select 1
              from public.account_wallets
              where owner_user_id = $1 and status = 'active'
              limit 1
            `,
            values: [input.ownerUserId],
          });
          if (active.rows.length > 0) {
            throw new AccountWalletObservationEmptyError();
          }
        }

        for (const wallet of input.observed) {
          await client.query<Record<string, unknown>>({
            text: `
              insert into public.account_wallets (
                owner_user_id, provider_wallet_id, address, kind
              )
              values ($1, $2, $3, $4)
              on conflict (owner_user_id, chain_type, address) do update set
                provider_wallet_id = coalesce(
                  excluded.provider_wallet_id,
                  public.account_wallets.provider_wallet_id
                ),
                kind = excluded.kind,
                status = 'active',
                last_seen_at = clock_timestamp(),
                updated_at = clock_timestamp()
            `,
            values: [
              input.ownerUserId,
              wallet.providerWalletId,
              wallet.address,
              wallet.kind,
            ],
          });
        }

        const observedAddresses = input.observed.map(
          (wallet) => wallet.address,
        );
        await client.query<Record<string, unknown>>({
          text: `
            update public.account_wallets
            set status = 'archived',
                is_active = false,
                updated_at = clock_timestamp()
            where owner_user_id = $1
              and not (address = any($2::text[]))
              and status = 'active'
          `,
          values: [input.ownerUserId, observedAddresses],
        });

        // Exactly one active wallet: when nothing is selected yet (or the
        // selected wallet disappeared) the earliest still-active wallet wins.
        await client.query<Record<string, unknown>>({
          text: `
            update public.account_wallets
            set is_active = true, updated_at = clock_timestamp()
            where wallet_id = (
              select wallet_id
              from public.account_wallets
              where owner_user_id = $1 and status = 'active'
              order by kind asc, first_seen_at asc, wallet_id asc
              limit 1
            )
              and not exists (
                select 1
                from public.account_wallets as active
                where active.owner_user_id = $1 and active.is_active
              )
          `,
          values: [input.ownerUserId],
        });

        const result = await client.query<Record<string, unknown>>({
          text: listSql,
          values: [input.ownerUserId],
        });
        await client.query("commit");
        inTransaction = false;
        return Object.freeze(result.rows.map(mapWallet));
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
    },

    async list(ownerUserId: string): Promise<readonly AccountWalletRecord[]> {
      const result = await pool.query<Record<string, unknown>>({
        text: listSql,
        values: [ownerUserId],
      });
      return Object.freeze(result.rows.map(mapWallet));
    },

    async get(
      ownerUserId: string,
      walletId: string,
    ): Promise<AccountWalletRecord | null> {
      const result = await pool.query<Record<string, unknown>>({
        text: `
          select ${walletColumns}
          from public.account_wallets
          where owner_user_id = $1 and wallet_id = $2
          limit 1
        `,
        values: [ownerUserId, walletId],
      });
      const row = result.rows[0];
      return row === undefined ? null : mapWallet(row);
    },

    async setActive(input: {
      readonly ownerUserId: string;
      readonly walletId: string;
      readonly expectedActiveWalletId: string | null;
    }): Promise<readonly AccountWalletRecord[]> {
      const client = await pool.connect();
      let inTransaction = false;
      try {
        await client.query("begin");
        inTransaction = true;

        const owned = await client.query<{
          wallet_id: string;
          is_active: boolean;
          status: string;
        }>({
          text: `
            select wallet_id, is_active, status
            from public.account_wallets
            where owner_user_id = $1
            order by wallet_id asc
            for update
          `,
          values: [input.ownerUserId],
        });
        const target = owned.rows.find(
          (row) => row.wallet_id === input.walletId,
        );
        if (target === undefined || target.status !== "active") {
          throw new AccountWalletNotFoundError();
        }
        const currentActive =
          owned.rows.find((row) => row.is_active)?.wallet_id ?? null;
        if (currentActive !== input.expectedActiveWalletId) {
          throw new AccountWalletVersionConflictError();
        }

        await client.query<Record<string, unknown>>({
          text: `
            update public.account_wallets
            set is_active = false, updated_at = clock_timestamp()
            where owner_user_id = $1 and is_active and wallet_id <> $2
          `,
          values: [input.ownerUserId, input.walletId],
        });
        await client.query<Record<string, unknown>>({
          text: `
            update public.account_wallets
            set is_active = true, updated_at = clock_timestamp()
            where owner_user_id = $1 and wallet_id = $2
          `,
          values: [input.ownerUserId, input.walletId],
        });

        const result = await client.query<Record<string, unknown>>({
          text: listSql,
          values: [input.ownerUserId],
        });
        await client.query("commit");
        inTransaction = false;
        return Object.freeze(result.rows.map(mapWallet));
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
    },

    async recordBalanceSnapshot(input: {
      readonly walletId: string;
      readonly assetId: string;
      readonly blockNumber: string;
      readonly blockHash: string;
      readonly rawValue: string;
    }): Promise<void> {
      await pool.query<Record<string, unknown>>({
        text: `
          insert into public.wallet_balance_snapshots (
            wallet_id, asset_id, block_number, block_hash, raw_value
          )
          values ($1, $2, $3::numeric, $4, $5::numeric)
          on conflict (wallet_id, asset_id, block_number) do update set
            raw_value = excluded.raw_value,
            block_hash = excluded.block_hash,
            observed_at = clock_timestamp()
        `,
        values: [
          input.walletId,
          input.assetId,
          input.blockNumber,
          input.blockHash,
          input.rawValue,
        ],
      });
    },
  });
}

function unavailable(): Promise<never> {
  return Promise.reject(new AccountWalletUnavailableError());
}

export function createUnavailableAccountWalletRepository(): AccountWalletRepository {
  return Object.freeze({
    sync: unavailable,
    list: unavailable,
    get: unavailable,
    setActive: unavailable,
    recordBalanceSnapshot: unavailable,
  });
}
