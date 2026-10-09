import type { CanaryExposureAdmission } from "../features/wallet-intents/intent-contract.js";
import type { DatabaseClient } from "./v2-command-support.js";

/**
 * One rolling canary window per account (Decisions 0065, 0077, 0101, 0104):
 * the USD value sealed into `policy.valueUsd` of every wallet, Launch, and
 * MEME Intent created at or after `since` that may still move funds. Wallet
 * Send / Swap / approvals, Launch purchases, and MEME create / buy / sell all
 * read this one sum, so a ceiling spent in one module is spent in all.
 *
 * Window boundary: `created_at >= since` in every table (Decision 0104 n3).
 */

/**
 * Wallet and Launch states that may already have moved, or may still move,
 * funds. `reverted` is included: the chain executed the transaction.
 */
export const canaryExposureStates = Object.freeze([
  "awaiting_signature",
  "submitted",
  "confirmed",
  "reverted",
  "unknown",
]);

const exposureSql = `
  select coalesce(sum(value_usd), 0)::text as total
  from (
    select (canonical_payload -> 'policy' ->> 'valueUsd')::numeric as value_usd
    from public.wallet_intents
    where owner_user_id = $1
      and created_at >= $2::timestamptz
      and state = any($3::text[])
    union all
    select (policy ->> 'valueUsd')::numeric
    from public.launch_intents
    where owner_user_id = $1
      and created_at >= $2::timestamptz
      and state = any($3::text[])
      and policy ? 'valueUsd'
    union all
    -- MEME (Decision 0101): reported and confirmed Intents, and prepared
    -- ones whose signing window is still open.
    select (policy ->> 'valueUsd')::numeric
    from public.meme_intents
    where owner_user_id = $1
      and created_at >= $2::timestamptz
      and (
        state in ('broadcast_reported', 'confirmed')
        or (state = 'prepared' and expires_at > clock_timestamp())
      )
      and policy ? 'valueUsd'
  ) as exposure
`;

export async function sumCanaryExposureUsd(
  client: DatabaseClient,
  input: { readonly ownerUserId: string; readonly since: string },
): Promise<string> {
  const result = await client.query<{ total: string }>({
    text: exposureSql,
    values: [
      input.ownerUserId,
      new Date(input.since).toISOString(),
      [...canaryExposureStates],
    ],
  });
  return result.rows[0]?.total ?? "0";
}

/**
 * Recomputes the spent total inside the caller's transaction (which must
 * already hold the owner lock) and lets `admission.admit` refuse. The
 * refusal is the caller's error and is rethrown through `wrap` so the
 * repository's own error translation leaves it untouched.
 */
export async function admitCanaryExposure(
  client: DatabaseClient,
  ownerUserId: string,
  admission: CanaryExposureAdmission,
  wrap: (error: unknown) => Error = (error) =>
    error instanceof Error ? error : new Error(String(error)),
): Promise<void> {
  const spentUsd = await sumCanaryExposureUsd(client, {
    ownerUserId,
    since: admission.since,
  });
  try {
    admission.admit(spentUsd);
  } catch (error) {
    throw wrap(error);
  }
}
