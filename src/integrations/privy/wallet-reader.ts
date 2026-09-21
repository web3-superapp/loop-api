import { z } from "zod";

import {
  anyCaseEvmAddressPatternSource,
  type WalletKind,
} from "../../features/chain/chain-contract.js";
import type { PrivyUsersLookupClient } from "./user-reader.js";

/**
 * Read-only projection of the wallets Privy reports for one authenticated
 * user (Decision 0033).
 *
 * Privy is authoritative for wallet existence. LOOP reads the linked accounts
 * of the *authenticated* Privy subject only: a client never selects the wallet
 * owner. Addresses are normalised to lowercase here so no other layer compares
 * mixed-case strings.
 */

const walletAccountSchema = z.object({
  type: z.literal("wallet"),
  chain_type: z.literal("ethereum"),
  address: z.string().regex(new RegExp(anyCaseEvmAddressPatternSource)),
  id: z.string().min(1).max(128).nullish(),
  connector_type: z.string().nullish(),
  wallet_client_type: z.string().nullish(),
  wallet_client: z.string().nullish(),
});

const userSchema = z.object({
  linked_accounts: z.array(z.unknown()),
});

/** Just enough to decide whether an account claims to be an EVM wallet. */
const walletAccountShapeSchema = z.object({
  type: z.literal("wallet"),
  chain_type: z.literal("ethereum"),
});

export interface PrivyWalletAccount {
  readonly address: string;
  readonly kind: WalletKind;
  readonly providerWalletId: string | null;
}

export interface PrivyWalletReader {
  listEthereumWallets(input: {
    readonly privyUserId: string;
    readonly signal: AbortSignal;
  }): Promise<readonly PrivyWalletAccount[]>;
}

export class PrivyWalletLookupUnavailableError extends Error {
  readonly code = "privy_wallet_lookup_unavailable";

  constructor() {
    super("The Privy wallet inventory lookup is unavailable");
    this.name = "PrivyWalletLookupUnavailableError";
  }
}

/**
 * A wallet is embedded when Privy says it manages the key material. Anything
 * else is an external wallet the user connected; it never gets a provider
 * wallet ID and can never be used for a server-initiated signature.
 */
function classify(account: z.output<typeof walletAccountSchema>): WalletKind {
  return account.connector_type === "embedded" ||
    account.wallet_client_type === "privy" ||
    account.wallet_client === "privy"
    ? "embedded"
    : "external";
}

export function parsePrivyEthereumWallets(
  user: unknown,
): readonly PrivyWalletAccount[] {
  const parsedUser = userSchema.safeParse(user);
  if (!parsedUser.success) {
    throw new PrivyWalletLookupUnavailableError();
  }
  const wallets: PrivyWalletAccount[] = [];
  const seen = new Set<string>();
  for (const rawAccount of parsedUser.data.linked_accounts) {
    if (!walletAccountShapeSchema.safeParse(rawAccount).success) {
      continue;
    }
    const parsed = walletAccountSchema.safeParse(rawAccount);
    if (!parsed.success) {
      // The account says it is an Ethereum wallet but does not match the
      // contract. Skipping it would silently hide a wallet the user owns, so
      // the whole inventory fails closed instead.
      throw new PrivyWalletLookupUnavailableError();
    }
    const address = parsed.data.address.toLowerCase();
    if (seen.has(address)) {
      continue;
    }
    seen.add(address);
    const kind = classify(parsed.data);
    const providerWalletId = parsed.data.id ?? null;
    if (kind === "embedded" && providerWalletId === null) {
      // An embedded wallet without a Privy wallet ID cannot be addressed for
      // any later Provider call; it is reported as external rather than
      // claiming a capability LOOP cannot exercise.
      wallets.push(
        Object.freeze({ address, kind: "external", providerWalletId: null }),
      );
      continue;
    }
    wallets.push(Object.freeze({ address, kind, providerWalletId }));
  }
  return Object.freeze(wallets);
}

export function createPrivyWalletReader(
  users: PrivyUsersLookupClient,
): PrivyWalletReader {
  return Object.freeze({
    async listEthereumWallets(input: {
      readonly privyUserId: string;
      readonly signal: AbortSignal;
    }): Promise<readonly PrivyWalletAccount[]> {
      const user = await users._get(input.privyUserId, {
        signal: input.signal,
        timeout: 4_000,
        maxRetries: 0,
      });
      return parsePrivyEthereumWallets(user);
    },
  });
}

export function createUnavailablePrivyWalletReader(): PrivyWalletReader {
  return Object.freeze({
    listEthereumWallets(): Promise<never> {
      return Promise.reject(new PrivyWalletLookupUnavailableError());
    },
  });
}

/**
 * Optional cross-check source. Privy's own balance view is compared against
 * the authoritative RPC read; a mismatch or a failure is reported as
 * `disputed`/`unavailable` and never changes the RPC result.
 */
export interface PrivyBalanceReader {
  readBscBalances(input: {
    readonly providerWalletId: string;
    readonly signal: AbortSignal;
  }): Promise<readonly PrivyBalanceObservation[]>;
}

export interface PrivyBalanceObservation {
  readonly asset: string;
  readonly rawValue: string;
  readonly decimals: number;
}

export interface PrivyBalanceClient {
  get(
    walletId: string,
    query: {
      readonly chain: "bsc";
      /**
       * Privy answers a balance query only when it names both a chain and an
       * asset; a chain alone is rejected as `invalid_data`. The cross-check
       * compares the native coin, so it asks for that one asset by name.
       */
      readonly asset: "bnb";
      readonly include_archived: false;
    },
    options: {
      readonly signal: AbortSignal;
      readonly timeout: 4_000;
      readonly maxRetries: 0;
    },
  ): Promise<unknown>;
}

const balanceResponseSchema = z.object({
  balances: z.array(
    z.object({
      asset: z.string().min(1).max(64),
      chain: z.string(),
      raw_value: z.string().regex(/^[0-9]+$/),
      raw_value_decimals: z.number().int().min(0).max(36),
    }),
  ),
});

export function createPrivyBalanceReader(
  balance: PrivyBalanceClient,
): PrivyBalanceReader {
  return Object.freeze({
    async readBscBalances(input: {
      readonly providerWalletId: string;
      readonly signal: AbortSignal;
    }): Promise<readonly PrivyBalanceObservation[]> {
      const response = await balance.get(
        input.providerWalletId,
        { chain: "bsc", asset: "bnb", include_archived: false },
        { signal: input.signal, timeout: 4_000, maxRetries: 0 },
      );
      const parsed = balanceResponseSchema.safeParse(response);
      if (!parsed.success) {
        throw new PrivyWalletLookupUnavailableError();
      }
      return Object.freeze(
        parsed.data.balances
          .filter((entry) => entry.chain === "bsc")
          .map((entry) =>
            Object.freeze({
              asset: entry.asset.toLowerCase(),
              rawValue: entry.raw_value,
              decimals: entry.raw_value_decimals,
            }),
          ),
      );
    },
  });
}

export function createUnavailablePrivyBalanceReader(): PrivyBalanceReader {
  return Object.freeze({
    readBscBalances(): Promise<never> {
      return Promise.reject(new PrivyWalletLookupUnavailableError());
    },
  });
}
