/**
 * Decision 0122: MEME v2 Factory generations. Every instance belongs to the
 * Factory that deployed it, and that Factory's bytecode generation decides
 * which contract surface the instance has:
 *
 * - `v2` — the price-protected buyback (loop-contracts `bf9f170`, BSC
 *   Testnet Factory `0x6A69…D9c0`): `BuybackCompleted` carries
 *   `minMemeOut / referencePrice / spotPrice`, `quoteNextOrder()` returns
 *   `(amountIn, expectedNetOut, minMemeOut)` and may revert while the price
 *   recorder is not ready, `SnapshotRegistry` has no zero-holder opening
 *   (a sale without holders is closed by the publisher, Decision 0120);
 * - `v3` — the current build (loop-contracts S144 Decision 0005): no price
 *   protection, `quoteNextOrder()` returns `(amountIn, executable)`,
 *   `BuybackCompleted(usd1Spent, memeDelivered, successfulAt)`, and
 *   `openPublicWithoutSnapshot()` opens the public round when the sale ended
 *   with `totalMinted() == 0`.
 *
 * The current Factory (`HOOKS_LAUNCH_FACTORY_ADDRESS`) is the generation the
 * generated ABI was built from (`v3`) unless its configured code hash is a
 * known older Factory (`launch2KnownFactoryGenerations`); older Factories are
 * registered read-only through `LAUNCH2_LEGACY_FACTORIES` so their
 * instances keep being indexed. The generation is recorded on the instance
 * when the `launch2_event` lane registers it, so readers never guess it
 * from an address again.
 */

export const launch2FactoryGenerations = Object.freeze(["v2", "v3"] as const);
export type Launch2FactoryGeneration =
  (typeof launch2FactoryGenerations)[number];

/** The generation of `hooks-launch-protocol-abi.generated.ts`. */
export const launch2CurrentGeneration: Launch2FactoryGeneration = "v3";

/**
 * Runtime code hashes of Factories known to be of an older generation (the
 * BSC Testnet manifests in loop-contracts `protocol/deployments/bsc-testnet`:
 * S127 `0x1D02…CBde` and S141 `0x6A69…D9c0`, both price-protected). When
 * `HOOKS_LAUNCH_FACTORY_CODE_HASH` is one of them the configured "current"
 * Factory is that generation, not the build's — so a code upgrade that runs
 * before the deployment switches Factories keeps tagging new instances
 * correctly instead of decoding them with the wrong ABI.
 */
export const launch2KnownFactoryGenerations: Readonly<
  Record<string, Launch2FactoryGeneration>
> = Object.freeze({
  "0xf41730da235e2f4b9e53abfbfdc730ef4714c030cb2b6565c15c12f5d3360541": "v2",
  "0x6669c2af1110ea253af8a2ec26da85d6e83103d5f84220a73535a16b077eacca": "v2",
  "0xf69d4f7256a6152e7e0f11810985cd488482b31efd8ab182b9c1ba468ad74748": "v3",
});

/**
 * The generation of the configured current Factory: the known table by its
 * runtime code hash, else the build's generation.
 */
export function launch2CurrentFactoryGeneration(
  codeHash: string | null | undefined,
): Launch2FactoryGeneration {
  return (
    (codeHash === null || codeHash === undefined
      ? undefined
      : launch2KnownFactoryGenerations[codeHash.toLowerCase()]) ??
    launch2CurrentGeneration
  );
}

export interface Launch2FactoryEntry {
  /** Lower-case Factory address. */
  readonly address: string;
  readonly generation: Launch2FactoryGeneration;
  /** The Factory new deployments go to (`HOOKS_LAUNCH_FACTORY_ADDRESS`). */
  readonly current: boolean;
}

export class Launch2LegacyFactoriesInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Launch2LegacyFactoriesInvalidError";
  }
}

/**
 * `LAUNCH2_LEGACY_FACTORIES`: comma-separated `<generation>:<address>`
 * entries, e.g. `v2:0x6A69…D9c0`. Blank = none. A malformed entry, an
 * unknown generation, or a duplicate address refuses boot.
 */
export function parseLaunch2LegacyFactories(
  value: string | undefined,
): readonly {
  readonly address: string;
  readonly generation: Launch2FactoryGeneration;
}[] {
  const raw = value?.trim() ?? "";
  if (raw === "") return Object.freeze([]);
  const seen = new Set<string>();
  const entries = raw.split(",").map((part) => {
    const match = /^(v[0-9]+):(0x[0-9a-fA-F]{40})$/u.exec(part.trim());
    if (match === null) {
      throw new Launch2LegacyFactoriesInvalidError(
        "each entry must be <generation>:<0x-prefixed 20-byte address>",
      );
    }
    const generation = match[1] as string;
    if (
      !(launch2FactoryGenerations as readonly string[]).includes(generation)
    ) {
      throw new Launch2LegacyFactoriesInvalidError(
        `unknown Factory generation ${generation} (known: ${launch2FactoryGenerations.join(", ")})`,
      );
    }
    const address = (match[2] as string).toLowerCase();
    if (seen.has(address)) {
      throw new Launch2LegacyFactoriesInvalidError(
        "a Factory address is listed twice",
      );
    }
    seen.add(address);
    return Object.freeze({
      address,
      generation: generation as Launch2FactoryGeneration,
    });
  });
  return Object.freeze(entries);
}

/**
 * The Factories the lane indexes: the current one first, then the legacy
 * ones. A legacy entry equal to the current Factory refuses (it would give
 * one address two generations).
 */
export function launch2FactoryEntries(input: {
  readonly current: string;
  /** HOOKS_LAUNCH_FACTORY_CODE_HASH; selects a known older generation. */
  readonly currentCodeHash?: string | null;
  readonly legacy: readonly {
    readonly address: string;
    readonly generation: Launch2FactoryGeneration;
  }[];
  /**
   * Decision 0131: `LAUNCH2_DYNAMIC_FACTORY_ADDRESS`, the LoopDynamic
   * Factory (current module generation; its instances have no Hook at
   * deployment). Indexed after the others; must differ from all of them.
   */
  readonly dynamic?: string | null;
}): readonly Launch2FactoryEntry[] {
  const current = input.current.toLowerCase();
  if (input.legacy.some((entry) => entry.address.toLowerCase() === current)) {
    throw new Launch2LegacyFactoriesInvalidError(
      "LAUNCH2_LEGACY_FACTORIES must not list HOOKS_LAUNCH_FACTORY_ADDRESS",
    );
  }
  const dynamic = input.dynamic?.toLowerCase() ?? null;
  if (
    dynamic !== null &&
    (dynamic === current ||
      input.legacy.some((entry) => entry.address.toLowerCase() === dynamic))
  ) {
    throw new Launch2LegacyFactoriesInvalidError(
      "LAUNCH2_DYNAMIC_FACTORY_ADDRESS must differ from HOOKS_LAUNCH_FACTORY_ADDRESS and LAUNCH2_LEGACY_FACTORIES",
    );
  }
  return Object.freeze([
    Object.freeze({
      address: current,
      generation: launch2CurrentFactoryGeneration(input.currentCodeHash),
      current: true,
    }),
    ...input.legacy.map((entry) =>
      Object.freeze({
        address: entry.address.toLowerCase(),
        generation: entry.generation,
        current: false,
      }),
    ),
    ...(dynamic === null
      ? []
      : [
          Object.freeze({
            address: dynamic,
            generation: launch2CurrentGeneration,
            current: false,
          }),
        ]),
  ]);
}

/** v2 instances have the price-protected buyback and no zero-holder opening. */
export function launch2HasPriceProtection(
  generation: Launch2FactoryGeneration,
): boolean {
  return generation === "v2";
}

export function launch2CanOpenWithoutHolders(
  generation: Launch2FactoryGeneration,
): boolean {
  return generation !== "v2";
}
