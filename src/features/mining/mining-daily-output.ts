import { formatRational } from "../market/market-contract.js";
import { isUnsignedDecimalString } from "./mining-contract.js";

/**
 * Pure share-of-network-power estimate (Decision 0043,
 * `mining.rules.dailyOutput.shareOfNetworkPower`):
 *
 * `estimatedToday = budget × accountPower ÷ networkPower`
 *
 * Exact rational arithmetic on decimal strings, truncated (never rounded
 * up) to `fractionDigits`. A zero network power has no share: the caller
 * publishes `MINING_NETWORK_POWER_ZERO` instead of a number. The result is
 * an estimate of a placeholder budget; it is never a claimable amount.
 */

export const miningDailyOutputFractionDigits = 6;

function scaled(value: string): {
  readonly digits: bigint;
  readonly scale: number;
} {
  if (!isUnsignedDecimalString(value)) {
    throw new Error("Invalid unsigned decimal");
  }
  const [whole = "0", fraction = ""] = value.split(".");
  return { digits: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

export function estimateDailyOutputShare(input: {
  readonly budget: string;
  readonly accountPower: string;
  readonly networkPower: string;
  readonly fractionDigits?: number;
}): string | null {
  const budget = scaled(input.budget);
  const account = scaled(input.accountPower);
  const network = scaled(input.networkPower);
  if (network.digits === 0n) {
    return null;
  }
  // budget × account ÷ network with every operand as an integer over 10^scale:
  // (b/10^sb) × (a/10^sa) ÷ (n/10^sn) = b·a·10^sn ÷ (n·10^(sb+sa)).
  const numerator =
    budget.digits * account.digits * 10n ** BigInt(network.scale);
  const denominator =
    network.digits * 10n ** BigInt(budget.scale + account.scale);
  return formatRational(
    numerator,
    denominator,
    input.fractionDigits ?? miningDailyOutputFractionDigits,
  );
}
