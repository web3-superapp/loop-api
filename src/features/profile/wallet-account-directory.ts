/**
 * Decision 0162: wallet address → LOOP account projection for trade feeds
 * (`launch2` curve trades, official-pool trades, launchpad activity).
 *
 * The rule is the one MEME trades use (Decision 0101 `accountJoin`): the
 * address maps to the earliest active `account_wallets` row, and only an
 * account with an active public profile is shown. On top of it, the owner's
 * `trade_history_visibility` (missing row = `everyone`, like every other
 * public trade read) hides the account from everyone but the owner.
 *
 * Lookups are batched (one query per response, never one per row) and
 * cached per address for a short TTL, negative answers included. A failed
 * lookup degrades to `null` (show the wallet) and is never cached: the
 * account is an enrichment, never a fact the feed depends on.
 */

export interface WalletAccountRecord {
  /** Lower-case 0x address. */
  readonly address: string;
  readonly ownerUserId: string;
  /** Null when the owner has no active public profile. */
  readonly publicProfileId: string | null;
  readonly alias: string | null;
  readonly avatarRef: string | null;
  readonly tradeVisibility: "self" | "everyone";
}

/** Same wire shape as the MEME trade `account` (Decision 0101). */
export interface TraderAccountProjection {
  readonly publicProfileId: string;
  readonly displayName: string | null;
  readonly avatarRef: string | null;
}

export interface WalletAccountLookup {
  /** One row per address that maps to an account; unknown addresses are absent. */
  findByAddresses(
    addresses: readonly string[],
  ): Promise<readonly WalletAccountRecord[]>;
}

export interface WalletAccountDirectory {
  /**
   * Resolves every address (case-insensitive) to the projection the viewer
   * may see, or null. The map is keyed by lower-case address.
   */
  resolve(
    addresses: readonly string[],
    viewerUserId: string | null,
  ): Promise<ReadonlyMap<string, TraderAccountProjection | null>>;
}

export const walletAccountCacheTtlMs = 30_000;
export const walletAccountCacheMaxEntries = 5_000;
/** Upper bound of addresses per lookup query. */
export const walletAccountLookupBatchSize = 200;

const addressPattern = /^0x[0-9a-f]{40}$/;

export function projectTraderAccount(
  record: WalletAccountRecord | null,
  viewerUserId: string | null,
): TraderAccountProjection | null {
  if (record === null || record.publicProfileId === null) {
    return null;
  }
  if (
    record.tradeVisibility !== "everyone" &&
    record.ownerUserId !== viewerUserId
  ) {
    return null;
  }
  return Object.freeze({
    publicProfileId: record.publicProfileId,
    displayName: record.alias,
    avatarRef: record.avatarRef,
  });
}

export function createWalletAccountDirectory(dependencies: {
  readonly lookup: WalletAccountLookup;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
  readonly onLookupError?: (error: unknown) => void;
}): WalletAccountDirectory {
  const ttlMs = dependencies.ttlMs ?? walletAccountCacheTtlMs;
  const maxEntries = dependencies.maxEntries ?? walletAccountCacheMaxEntries;
  const now = dependencies.now ?? Date.now;
  const cache = new Map<
    string,
    { readonly at: number; readonly record: WalletAccountRecord | null }
  >();

  function remember(address: string, record: WalletAccountRecord | null) {
    if (cache.size >= maxEntries) {
      // Insertion order: drop the oldest entry.
      const oldest = cache.keys().next();
      if (oldest.done !== true) cache.delete(oldest.value);
    }
    cache.set(address, { at: now(), record });
  }

  return Object.freeze({
    async resolve(addresses: readonly string[], viewerUserId: string | null) {
      const result = new Map<string, TraderAccountProjection | null>();
      const wanted = new Set<string>();
      for (const raw of addresses) {
        const address = raw.toLowerCase();
        if (!addressPattern.test(address)) continue;
        wanted.add(address);
      }
      const records = new Map<string, WalletAccountRecord | null>();
      const missing: string[] = [];
      const at = now();
      for (const address of wanted) {
        const hit = cache.get(address);
        if (hit !== undefined && at - hit.at < ttlMs) {
          records.set(address, hit.record);
        } else {
          missing.push(address);
        }
      }
      for (
        let start = 0;
        start < missing.length;
        start += walletAccountLookupBatchSize
      ) {
        const batch = missing.slice(
          start,
          start + walletAccountLookupBatchSize,
        );
        try {
          const found = await dependencies.lookup.findByAddresses(batch);
          const byAddress = new Map(
            found.map((row) => [row.address.toLowerCase(), row]),
          );
          for (const address of batch) {
            const record = byAddress.get(address) ?? null;
            records.set(address, record);
            remember(address, record);
          }
        } catch (error) {
          dependencies.onLookupError?.(error);
          for (const address of batch) records.set(address, null);
        }
      }
      for (const address of wanted) {
        result.set(
          address,
          projectTraderAccount(records.get(address) ?? null, viewerUserId),
        );
      }
      return result;
    },
  });
}

/** Without a database every trader stays a bare wallet. */
export function createEmptyWalletAccountDirectory(): WalletAccountDirectory {
  return Object.freeze({
    resolve(addresses: readonly string[]) {
      return Promise.resolve(
        new Map(
          addresses.map((address) => [
            address.toLowerCase(),
            null as TraderAccountProjection | null,
          ]),
        ),
      );
    },
  });
}
