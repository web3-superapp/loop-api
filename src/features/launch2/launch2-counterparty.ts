import { V2ApiError } from "../../core/http/v2-error.js";
import { launch2ReasonCodes } from "./launch2-contract.js";
import type { Launch2InstanceRecord } from "./launch2-ports.js";

/**
 * Decision 0117: the MEME v2 (`launch2`) counterparty trust boundary.
 *
 * A launch2 prepare may only point the user's wallet at contracts of the
 * activated instance it was asked about: the 11 module addresses that
 * `launch2_instances` registered for it, plus the USD1 that instance is
 * bound to. The registry row is trusted because it is written only from a
 * Hooks deployment task in status `activated` — the executor (Decision
 * 0112) reached that status after the receipt was confirmed, the
 * `LaunchDeployed` event decoded, and all 28 module checks (Factory runtime
 * code hash, module wiring, immutable USD1 / launchId / sale window) passed
 * — and the `launch2_event` lane then saw `LaunchActivated` for the same
 * launchId (`activatedAt`). The instance's USD1 is `CurveEngine.usd1()` read
 * from that verified curve at the prepare's block; the executor checked it
 * equals the Factory's USD1.
 *
 * This replaces the static `BSC_WRITE_CANARY_RECIPIENT_ALLOWLIST` for
 * launch2 only (every new instance would otherwise need a manual env edit).
 * The canary asset allowlist (USD1 must be in BSC_WRITE_CANARY_ASSETS) and
 * the per-intent / daily ceilings are unchanged.
 */

const addressPattern = /^0x[0-9a-f]{40}$/u;

/**
 * The instance's trusted counterparties, or null when the instance is not
 * an activated, unheld registry row (nothing is trusted then).
 */
export function launch2TrustedCounterparties(
  record: Launch2InstanceRecord,
  usd1: string,
): ReadonlySet<string> | null {
  if (record.activatedAt === null || record.holdReason !== null) return null;
  const a = record.addresses;
  const registered: readonly string[] = [
    a.meme,
    a.hook,
    a.nft,
    a.curve,
    a.gate,
    a.escrow,
    a.snapshots,
    a.graduationAdapter,
    a.buybackAdapter,
    a.priceRecorder,
    a.buybackExecutor,
  ];
  const trusted = new Set<string>();
  for (const address of [...registered, usd1]) {
    const lower = address.toLowerCase();
    if (addressPattern.test(lower)) trusted.add(lower);
  }
  return trusted;
}

/**
 * 403 POLICY_BLOCKED / LAUNCH2_COUNTERPARTY_NOT_INSTANCE unless every target
 * (the transaction `to`, the approve token, the approve spender) is one of
 * the activated instance's registered contracts or its USD1.
 */
export function requireLaunch2Counterparties(input: {
  readonly record: Launch2InstanceRecord;
  readonly usd1: string;
  readonly targets: readonly string[];
}): void {
  const trusted = launch2TrustedCounterparties(input.record, input.usd1);
  if (
    trusted === null ||
    input.targets.length === 0 ||
    !input.targets.every((target) => trusted.has(target.toLowerCase()))
  ) {
    throw V2ApiError.fromCode("POLICY_BLOCKED", {
      reasonCode: launch2ReasonCodes.counterpartyNotInstance,
    });
  }
}
