import type { ChainGuardCollected } from "./chain-guard-collect.js";
import {
  formatBnbAmount,
  type ChainGuardPolicy,
} from "./chain-guard-evaluate.js";

/**
 * Decision 0134: the verdict of `pnpm chain:preflight` (docs/24 §7.1.4 3):
 * USD1 not paused, none of our addresses frozen, the implementation still
 * the pinned one, every Factory on the same USD1, no protocol fee at or
 * above the alert threshold, every signer account above the BNB floor.
 *
 * Every finding fails except a nonzero protocol fee below the threshold
 * (a warning). On BSC Mainnet an unpinned implementation and a USD1 read
 * the token does not implement also fail; on the testnet (mock token) they
 * are warnings, so the command runs there.
 */

export type ChainPreflightStatus = "ok" | "warn" | "fail";

export interface ChainPreflightRow {
  readonly check: string;
  readonly subject: string;
  readonly observed: string;
  readonly status: ChainPreflightStatus;
}

export interface ChainPreflightReport {
  readonly rows: readonly ChainPreflightRow[];
  readonly failures: number;
  readonly warnings: number;
}

function status(failed: boolean, warned = false): ChainPreflightStatus {
  return failed ? "fail" : warned ? "warn" : "ok";
}

export function chainPreflightReport(input: {
  readonly collected: ChainGuardCollected;
  readonly policy: ChainGuardPolicy;
}): ChainPreflightReport {
  const { collected, policy } = input;
  const snapshot = collected.snapshot;
  const mainnet = snapshot.chainReference === 56;
  const rows: ChainPreflightRow[] = [];
  const unsupportedStatus: ChainPreflightStatus = mainnet ? "fail" : "warn";

  rows.push({
    check: "usd1.paused",
    subject: collected.usd1,
    observed:
      snapshot.usd1.paused === null
        ? "unsupported"
        : String(snapshot.usd1.paused),
    status:
      snapshot.usd1.paused === null
        ? unsupportedStatus
        : status(snapshot.usd1.paused),
  });

  const implementation = snapshot.usd1.implementation ?? "none (not a proxy)";
  if (policy.expectedImplementation === null) {
    rows.push({
      check: "usd1.implementation",
      subject: collected.usd1,
      observed: `${implementation}; CHAIN_GUARD_USD1_IMPLEMENTATION not set`,
      status: mainnet ? "fail" : "warn",
    });
  } else {
    rows.push({
      check: "usd1.implementation",
      subject: collected.usd1,
      observed: `${implementation} (expected ${policy.expectedImplementation})`,
      status: status(
        snapshot.usd1.implementation !== policy.expectedImplementation,
      ),
    });
  }
  rows.push({
    check: "usd1.proxyAdmin",
    subject: collected.usd1,
    observed: collected.proxyAdmin ?? "none",
    status: "ok",
  });

  for (const entry of snapshot.factoryUsd1) {
    rows.push({
      check: "factory.usd1",
      subject: entry.factory,
      observed: entry.usd1,
      status: status(entry.usd1 !== collected.usd1),
    });
  }

  for (const entry of snapshot.frozen) {
    rows.push({
      check: "usd1.frozen",
      subject: `${entry.address} [${entry.labels.join(", ")}]`,
      observed: entry.frozen === null ? "unsupported" : String(entry.frozen),
      status: entry.frozen === null ? unsupportedStatus : status(entry.frozen),
    });
  }

  for (const manager of snapshot.poolManagers) {
    const expected = policy.expectedProtocolFeeController;
    rows.push({
      check: "poolManager.protocolFeeController",
      subject: manager.address,
      observed:
        expected === null
          ? `${manager.protocolFeeController}; CHAIN_GUARD_PROTOCOL_FEE_CONTROLLER not set`
          : `${manager.protocolFeeController} (expected ${expected})`,
      status:
        expected === null
          ? "warn"
          : status(manager.protocolFeeController !== expected),
    });
  }

  for (const pool of snapshot.pools) {
    const highest = Math.max(pool.zeroForOnePips, pool.oneForZeroPips);
    rows.push({
      check: "pool.protocolFee",
      subject: `${pool.poolId} [instance ${pool.instanceId}]`,
      observed: `${pool.zeroForOnePips}/${pool.oneForZeroPips} pips (alert ≥ ${policy.protocolFeeAlertPips})`,
      status: status(highest >= policy.protocolFeeAlertPips, highest > 0),
    });
  }

  for (const balance of snapshot.balances) {
    rows.push({
      check: "account.bnb",
      subject: `${balance.address} [${balance.labels.join(", ")}]`,
      observed: `${formatBnbAmount(balance.wei)} BNB (min ${formatBnbAmount(policy.minBnbWei)})`,
      status: status(balance.wei < policy.minBnbWei),
    });
  }

  // The rows mirror evaluateChainGuardSnapshot's findings check by check;
  // the counts come from the rows so the table and the exit code agree.
  return Object.freeze({
    rows: Object.freeze(rows),
    failures: rows.filter((row) => row.status === "fail").length,
    warnings: rows.filter((row) => row.status === "warn").length,
  });
}

export function formatChainPreflightReport(
  report: ChainPreflightReport,
): string {
  const label = { ok: "OK  ", warn: "WARN", fail: "FAIL" } as const;
  const lines = report.rows.map(
    (row) =>
      `${label[row.status]}  ${row.check.padEnd(34)} ${row.subject}\n      → ${row.observed}`,
  );
  lines.push(
    `\n${report.failures} failed, ${report.warnings} warning(s), ${report.rows.length} checks`,
  );
  return `${lines.join("\n")}\n`;
}
