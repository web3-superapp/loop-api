import {
  chainGuardReasonCodes,
  type ChainGuardIncidentRecord,
  type ChainGuardRepository,
} from "./chain-guard-contract.js";

/**
 * Decision 0134: the read-only query the signing lanes
 * (`launch2_buyback_keeper`, `hooks_launch_executor`,
 * `launch2_dynamic_poke`) ask at the start of every tick. While an
 * unresolved USD1 pause or freeze of one of our addresses exists, the tick
 * does nothing and returns `CHAIN_GUARD_HOLD`; nothing else in those lanes
 * changes. A failing query throws, so the lane backs off instead of acting
 * unguarded.
 */
export interface ChainGuardHoldGate {
  holds(): Promise<readonly ChainGuardIncidentRecord[]>;
}

export function createChainGuardHoldGate(
  repository: Pick<ChainGuardRepository, "listHolds">,
  chainId: string,
): ChainGuardHoldGate {
  return Object.freeze({
    holds: () => repository.listHolds(chainId),
  });
}

export interface ChainGuardHoldTransition {
  readonly lane: string;
  readonly held: boolean;
  readonly reasonCode: string;
  readonly holds: readonly {
    readonly incidentId: string;
    readonly kind: string;
    readonly subject: string;
  }[];
}

export type ChainGuardHoldCheck = () => Promise<Readonly<
  Record<string, unknown>
> | null>;

/**
 * The per-lane check: null = go on with the tick; otherwise the tick result
 * to return. A transition (held ↔ released) is reported once.
 */
export function createChainGuardHoldCheck(
  lane: string,
  gate: ChainGuardHoldGate | undefined,
  onTransition?: (event: ChainGuardHoldTransition) => void,
): ChainGuardHoldCheck {
  let held = false;
  return async () => {
    if (gate === undefined) return null;
    const holds = await gate.holds();
    if (holds.length === 0) {
      if (held) {
        held = false;
        onTransition?.({
          lane,
          held: false,
          reasonCode: chainGuardReasonCodes.holdReleased,
          holds: [],
        });
      }
      return null;
    }
    if (!held) {
      held = true;
      onTransition?.({
        lane,
        held: true,
        reasonCode: chainGuardReasonCodes.hold,
        holds: holds.map((hold) => ({
          incidentId: hold.incidentId,
          kind: hold.kind,
          subject: hold.subject,
        })),
      });
    }
    return Object.freeze({
      kind: "held",
      reasonCode: chainGuardReasonCodes.hold,
      holdCount: holds.length,
    });
  };
}
