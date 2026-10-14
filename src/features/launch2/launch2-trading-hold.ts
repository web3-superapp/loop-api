import type { ChainGuardIncidentRecord } from "../chain-guard/chain-guard-contract.js";

/**
 * Decision 0136: the chain guard hold (Decision 0134 §4) as the launch2
 * routes see it. While an unresolved `usd1_paused` or `usd1_address_frozen`
 * incident exists on the launch chain, every launch2 write path (quotes and
 * prepares) is refused and the instance detail carries `tradingHold`. The
 * hold is chain-wide, never per instance.
 */

export const launch2TradingHoldKinds = Object.freeze([
  "usd1_paused",
  "address_frozen",
] as const);

export type Launch2TradingHoldKind = (typeof launch2TradingHoldKinds)[number];

export interface Launch2TradingHold {
  readonly kind: Launch2TradingHoldKind;
  /** `first_seen_at` of the incident. */
  readonly since: string;
}

export const launch2TradingHoldReasonCodes = Object.freeze({
  usd1_paused: "LAUNCH2_USD1_PAUSED",
  address_frozen: "LAUNCH2_ADDRESS_FROZEN",
} as const satisfies Record<Launch2TradingHoldKind, string>);

/**
 * The hold to show: `usd1_paused` before `address_frozen`; within a kind
 * the earliest `first_seen_at`. Null when no hold-kind incident is open.
 */
export function launch2TradingHoldOf(
  incidents: readonly ChainGuardIncidentRecord[],
): Launch2TradingHold | null {
  const earliest = (
    kind: ChainGuardIncidentRecord["kind"],
  ): ChainGuardIncidentRecord | null =>
    incidents
      .filter((incident) => incident.kind === kind)
      .reduce<ChainGuardIncidentRecord | null>(
        (first, incident) =>
          first === null ||
          Date.parse(incident.firstSeenAt) < Date.parse(first.firstSeenAt)
            ? incident
            : first,
        null,
      );
  const paused = earliest("usd1_paused");
  if (paused !== null) {
    return Object.freeze({ kind: "usd1_paused", since: paused.firstSeenAt });
  }
  const frozen = earliest("usd1_address_frozen");
  if (frozen !== null) {
    return Object.freeze({ kind: "address_frozen", since: frozen.firstSeenAt });
  }
  return null;
}
