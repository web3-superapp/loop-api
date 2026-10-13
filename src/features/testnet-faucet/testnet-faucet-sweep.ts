import {
  testnetFaucetReasonCodes as reasons,
  type TestnetFaucetRepository,
  type TestnetFaucetTransactionLookup,
} from "./testnet-faucet-contract.js";

/**
 * S169 (Decision 0128 §9): the worker's `testnet_faucet_pending_sweep`
 * lane. A grant still `pending` after `pendingTimeoutSeconds` was left by
 * a crashed API process or a failed final write. It is closed from the
 * chain, read-only:
 *
 * - no tBNB hash stored → `failed` (nothing was broadcast);
 * - the node knows the tBNB hash → `unknown` (funds did or may have
 *   moved; the cooldown counts, as for a live `unknown`);
 * - the node does not know it → `failed`.
 *
 * Every sweep `failed` carries `TESTNET_FAUCET_PENDING_EXPIRED`, which the
 * failed-retry cooldown ignores. A lookup that fails leaves the grant for
 * the next pass. Nothing here signs.
 */

export const testnetFaucetPendingSweepLane = "testnet_faucet_pending_sweep";
const batchSize = 50;

export type TestnetFaucetSweepEvent =
  | {
      readonly kind: "resolved";
      readonly grantId: string;
      readonly address: string;
      readonly status: "unknown" | "failed";
      readonly bnbTransactionHash: string | null;
    }
  | {
      readonly kind: "lookup_failed";
      readonly grantId: string;
      readonly bnbTransactionHash: string;
      readonly errorClass: string;
    };

export interface TestnetFaucetSweepResult {
  readonly scanned: number;
  readonly unknown: number;
  readonly failed: number;
  readonly skipped: number;
}

export interface TestnetFaucetPendingSweep {
  runOnce(signal?: AbortSignal): Promise<TestnetFaucetSweepResult>;
}

export function createTestnetFaucetPendingSweep(options: {
  readonly repository: Pick<
    TestnetFaucetRepository,
    "listStalePending" | "resolveStalePending"
  >;
  readonly lookup: TestnetFaucetTransactionLookup;
  readonly pendingTimeoutSeconds: number;
  readonly now?: () => Date;
  readonly onEvent?: (event: TestnetFaucetSweepEvent) => void;
}): TestnetFaucetPendingSweep {
  const now = options.now ?? ((): Date => new Date());
  return Object.freeze({
    async runOnce(signal?: AbortSignal): Promise<TestnetFaucetSweepResult> {
      const at = now();
      const stale = await options.repository.listStalePending(
        new Date(at.getTime() - options.pendingTimeoutSeconds * 1_000),
        batchSize,
      );
      let unknown = 0;
      let failed = 0;
      let skipped = 0;
      for (const grant of stale) {
        if (signal?.aborted === true) break;
        let status: "unknown" | "failed" = "failed";
        const hash = grant.bnbTransactionHash;
        if (hash !== null) {
          try {
            status =
              (await options.lookup.lookup(hash)) === "found"
                ? "unknown"
                : "failed";
          } catch (error) {
            skipped += 1;
            options.onEvent?.({
              kind: "lookup_failed",
              grantId: grant.grantId,
              bnbTransactionHash: hash,
              errorClass: error instanceof Error ? error.name : "UnknownError",
            });
            continue;
          }
        }
        const closed = await options.repository.resolveStalePending({
          grantId: grant.grantId,
          status,
          failureReasonCode:
            status === "unknown"
              ? reasons.submissionUnknown
              : reasons.pendingExpired,
          now: now(),
        });
        if (!closed) {
          skipped += 1;
          continue;
        }
        if (status === "unknown") unknown += 1;
        else failed += 1;
        options.onEvent?.({
          kind: "resolved",
          grantId: grant.grantId,
          address: grant.address,
          status,
          bnbTransactionHash: hash,
        });
      }
      return Object.freeze({ scanned: stale.length, unknown, failed, skipped });
    },
  });
}
