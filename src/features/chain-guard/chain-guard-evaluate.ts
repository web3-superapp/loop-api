import {
  chainGuardIncidentKey,
  chainGuardPolicyLimitedReasons,
  type ChainGuardDetails,
  type ChainGuardEventKind,
  type ChainGuardStateKind,
} from "./chain-guard-contract.js";

/**
 * Decision 0134: the pure judgments of the chain guard, shared by the
 * `chain_guard` lane and `pnpm chain:preflight`. Inputs are chain readings
 * (already taken); nothing here reads a chain or a database.
 */

export const zeroAddress = "0x0000000000000000000000000000000000000000";

const addressPattern = /^0x[0-9a-f]{40}$/u;

export function isChainGuardAddress(value: string): boolean {
  return addressPattern.test(value);
}

export interface ChainGuardWatchedAddress {
  readonly address: string;
  /** Why it is watched, e.g. `instance:<id>:escrow`, `poolRouter`. */
  readonly labels: readonly string[];
}

/** Merges duplicate addresses (one address may carry several roles). */
export function mergeWatchedAddresses(
  entries: readonly { readonly address: string; readonly label: string }[],
): readonly ChainGuardWatchedAddress[] {
  const merged = new Map<string, string[]>();
  for (const entry of entries) {
    const address = entry.address.toLowerCase();
    if (!isChainGuardAddress(address) || address === zeroAddress) continue;
    const labels = merged.get(address) ?? [];
    if (!labels.includes(entry.label)) labels.push(entry.label);
    merged.set(address, labels);
  }
  return [...merged.entries()]
    .map(([address, labels]) => Object.freeze({ address, labels }))
    .sort((left, right) => left.address.localeCompare(right.address));
}

export interface ChainGuardSnapshot {
  /** 56 or 97; an unsupported USD1 read is a finding only on 56. */
  readonly chainReference: number;
  readonly usd1: {
    readonly address: string;
    /** null: `paused()` is not implemented (testnet mock). */
    readonly paused: boolean | null;
    /** EIP-1967 implementation slot; null: not a proxy. */
    readonly implementation: string | null;
  };
  /** `usd1()` of every configured Factory. */
  readonly factoryUsd1: readonly {
    readonly factory: string;
    readonly usd1: string;
  }[];
  /** `frozen(address)`; null: not implemented. */
  readonly frozen: readonly (ChainGuardWatchedAddress & {
    readonly frozen: boolean | null;
  })[];
  readonly poolManagers: readonly {
    readonly address: string;
    readonly protocolFeeController: string;
  }[];
  readonly pools: readonly {
    readonly poolId: string;
    readonly instanceId: string;
    readonly poolManager: string;
    readonly zeroForOnePips: number;
    readonly oneForZeroPips: number;
    /**
     * Decision 0135: the fee controller's `protocolFeeForPool(key)`; null
     * when not read (`policyLimited` says why).
     */
    readonly policy: {
      readonly zeroForOnePips: number;
      readonly oneForZeroPips: number;
    } | null;
    readonly policyLimited: string | null;
  }[];
  readonly balances: readonly (ChainGuardWatchedAddress & {
    readonly wei: bigint;
  })[];
}

export interface ChainGuardPolicy {
  /** CHAIN_GUARD_USD1_IMPLEMENTATION; null: the check is not configured. */
  readonly expectedImplementation: string | null;
  /** CHAIN_GUARD_PROTOCOL_FEE_CONTROLLER; null: not configured. */
  readonly expectedProtocolFeeController: string | null;
  readonly protocolFeeAlertPips: number;
  readonly minBnbWei: bigint;
}

export interface ChainGuardFinding<
  Kind extends ChainGuardStateKind | ChainGuardEventKind = ChainGuardStateKind,
> {
  readonly kind: Kind;
  readonly subject: string;
  readonly details: ChainGuardDetails;
}

export interface ChainGuardEvaluation {
  readonly findings: readonly ChainGuardFinding[];
  /** Kinds whose condition was read this tick (only these resolve). */
  readonly evaluatedKinds: readonly ChainGuardStateKind[];
  /** Checks skipped because their expected value is not configured. */
  readonly notConfigured: readonly string[];
  /** Reads the token does not implement (testnet: informational). */
  readonly unsupported: readonly string[];
  /**
   * Decision 0135: incident keys (`kind|subject`) whose condition was not
   * read this tick (a fee policy that reverted / a pool key that does not
   * rebuild): kept open, never resolved by a missing read.
   */
  readonly retained: readonly string[];
  /** Decision 0135: distinct reasons a fee policy was not read. */
  readonly policyLimited: readonly string[];
}

/** `slot0` bits 184..207 → per-direction protocol fee (pips). */
export function decodeProtocolFee(slot0: bigint): {
  readonly zeroForOnePips: number;
  readonly oneForZeroPips: number;
} {
  return decodePackedProtocolFee(Number((slot0 >> 184n) & 0xffffffn));
}

/**
 * A v4 packed protocol fee (uint24: low 12 bits zeroForOne, high 12 bits
 * oneForZero) — slot0's field, `ProtocolFeeUpdated.protocolFee`, and
 * `protocolFeeForPool`'s return value.
 */
export function decodePackedProtocolFee(packed: number): {
  readonly zeroForOnePips: number;
  readonly oneForZeroPips: number;
} {
  const fee = packed & 0xffffff;
  return Object.freeze({
    zeroForOnePips: fee & 0xfff,
    oneForZeroPips: fee >> 12,
  });
}

const decimalPattern = /^(0|[1-9][0-9]{0,8})(?:\.([0-9]{1,18}))?$/u;

/** "0.05" → 5e16 wei; null for anything but a plain non-negative decimal. */
export function parseBnbAmount(value: string): bigint | null {
  const match = decimalPattern.exec(value.trim());
  if (match === null) return null;
  const whole = BigInt(match[1] as string);
  const fraction = (match[2] ?? "").padEnd(18, "0");
  return whole * 10n ** 18n + BigInt(fraction);
}

/** 5e16 wei → "0.05" (no trailing zeros, never a JS number). */
export function formatBnbAmount(wei: bigint): string {
  const negative = wei < 0n;
  const absolute = negative ? -wei : wei;
  const whole = absolute / 10n ** 18n;
  const fraction = (absolute % 10n ** 18n)
    .toString()
    .padStart(18, "0")
    .replace(/0+$/u, "");
  return `${negative ? "-" : ""}${whole.toString()}${fraction === "" ? "" : `.${fraction}`}`;
}

export function evaluateChainGuardSnapshot(
  snapshot: ChainGuardSnapshot,
  policy: ChainGuardPolicy,
): ChainGuardEvaluation {
  const findings: ChainGuardFinding[] = [];
  const evaluated = new Set<ChainGuardStateKind>([
    "usd1_paused",
    "usd1_address_frozen",
    "usd1_address_mismatch",
    "usd1_read_unsupported",
    "pool_protocol_fee_nonzero",
    "pool_protocol_fee_high",
    "account_balance_low",
    "pool_protocol_fee_policy_nonzero",
    "pool_protocol_fee_policy_high",
  ]);
  const notConfigured: string[] = [];
  const retained: string[] = [];
  const policyLimited = new Set<string>();
  const unsupported: string[] = [];
  const usd1 = snapshot.usd1.address;
  const mainnet = snapshot.chainReference === 56;

  if (snapshot.usd1.paused === true) {
    findings.push({
      kind: "usd1_paused",
      subject: usd1,
      details: { source: "state" },
    });
  } else if (snapshot.usd1.paused === null) {
    unsupported.push("usd1.paused");
  }

  let frozenUnsupported = 0;
  for (const entry of snapshot.frozen) {
    if (entry.frozen === true) {
      findings.push({
        kind: "usd1_address_frozen",
        subject: entry.address,
        details: { source: "state", labels: entry.labels },
      });
    } else if (entry.frozen === null) {
      frozenUnsupported += 1;
    }
  }
  if (frozenUnsupported > 0) unsupported.push("usd1.frozen");
  if (mainnet && unsupported.length > 0) {
    findings.push({
      kind: "usd1_read_unsupported",
      subject: usd1,
      details: { reads: [...unsupported] },
    });
  }

  if (policy.expectedImplementation === null) {
    notConfigured.push("usd1.implementation");
  } else {
    evaluated.add("usd1_implementation_changed");
    if (snapshot.usd1.implementation !== policy.expectedImplementation) {
      findings.push({
        kind: "usd1_implementation_changed",
        subject: usd1,
        details: {
          expected: policy.expectedImplementation,
          observed: snapshot.usd1.implementation,
        },
      });
    }
  }

  for (const entry of snapshot.factoryUsd1) {
    if (entry.usd1 !== usd1) {
      findings.push({
        kind: "usd1_address_mismatch",
        subject: entry.factory,
        details: { configured: usd1, factoryUsd1: entry.usd1 },
      });
    }
  }

  if (policy.expectedProtocolFeeController === null) {
    notConfigured.push("poolManager.protocolFeeController");
  } else {
    evaluated.add("protocol_fee_controller_changed");
    for (const manager of snapshot.poolManagers) {
      if (
        manager.protocolFeeController !== policy.expectedProtocolFeeController
      ) {
        findings.push({
          kind: "protocol_fee_controller_changed",
          subject: manager.address,
          details: {
            expected: policy.expectedProtocolFeeController,
            observed: manager.protocolFeeController,
          },
        });
      }
    }
  }

  for (const pool of snapshot.pools) {
    const highest = Math.max(pool.zeroForOnePips, pool.oneForZeroPips);
    if (highest === 0) continue;
    const details = {
      instanceId: pool.instanceId,
      poolManager: pool.poolManager,
      zeroForOnePips: pool.zeroForOnePips,
      oneForZeroPips: pool.oneForZeroPips,
      alertPips: policy.protocolFeeAlertPips,
    };
    findings.push({
      kind: "pool_protocol_fee_nonzero",
      subject: pool.poolId,
      details,
    });
    if (highest >= policy.protocolFeeAlertPips) {
      findings.push({
        kind: "pool_protocol_fee_high",
        subject: pool.poolId,
        details,
      });
    }
  }

  // Decision 0135: the fee policy ahead of slot0. A controller at the zero
  // address has no policy (nothing to warn about, open ones resolve); a
  // policy that could not be read keeps whatever is open for that pool.
  for (const pool of snapshot.pools) {
    if (pool.policyLimited !== null) policyLimited.add(pool.policyLimited);
    if (pool.policy === null) {
      if (
        pool.policyLimited !== null &&
        pool.policyLimited !== chainGuardPolicyLimitedReasons.controllerUnset
      ) {
        retained.push(
          chainGuardIncidentKey(
            "pool_protocol_fee_policy_nonzero",
            pool.poolId,
          ),
          chainGuardIncidentKey("pool_protocol_fee_policy_high", pool.poolId),
        );
      }
      continue;
    }
    const current = Math.max(pool.zeroForOnePips, pool.oneForZeroPips);
    const planned = Math.max(
      pool.policy.zeroForOnePips,
      pool.policy.oneForZeroPips,
    );
    const details = {
      instanceId: pool.instanceId,
      poolManager: pool.poolManager,
      policyZeroForOnePips: pool.policy.zeroForOnePips,
      policyOneForZeroPips: pool.policy.oneForZeroPips,
      zeroForOnePips: pool.zeroForOnePips,
      oneForZeroPips: pool.oneForZeroPips,
      alertPips: policy.protocolFeeAlertPips,
    };
    if (planned > 0 && current === 0) {
      findings.push({
        kind: "pool_protocol_fee_policy_nonzero",
        subject: pool.poolId,
        details,
      });
    }
    if (
      planned >= policy.protocolFeeAlertPips &&
      current < policy.protocolFeeAlertPips
    ) {
      findings.push({
        kind: "pool_protocol_fee_policy_high",
        subject: pool.poolId,
        details,
      });
    }
  }

  for (const balance of snapshot.balances) {
    if (balance.wei < policy.minBnbWei) {
      findings.push({
        kind: "account_balance_low",
        subject: balance.address,
        details: {
          labels: balance.labels,
          balanceBnb: formatBnbAmount(balance.wei),
          minimumBnb: formatBnbAmount(policy.minBnbWei),
        },
      });
    }
  }

  return Object.freeze({
    findings: Object.freeze(dedupeFindings(findings)),
    evaluatedKinds: Object.freeze([...evaluated]),
    notConfigured: Object.freeze(notConfigured),
    unsupported: Object.freeze(unsupported),
    retained: Object.freeze([...new Set(retained)]),
    policyLimited: Object.freeze([...policyLimited].sort()),
  });
}

function dedupeFindings<
  T extends { readonly kind: string; readonly subject: string },
>(findings: readonly T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const finding of findings) {
    const key = chainGuardIncidentKey(finding.kind, finding.subject);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(finding);
  }
  return result;
}

/** A decoded USD1 / ProxyAdmin / PoolManager log (lower-case addresses, decimal amounts). */
export interface ChainGuardLog {
  readonly name:
    | "Paused"
    | "Unpaused"
    | "Freeze"
    | "Unfreeze"
    | "FrozenAccountDrained"
    | "FrozenFundsReallocated"
    | "Upgraded"
    | "AdminChanged"
    | "OwnershipTransferred"
    /** Decision 0135: PoolManager (v4 `IProtocolFees`). */
    | "ProtocolFeeUpdated"
    | "ProtocolFeeControllerUpdated";
  readonly address: string;
  readonly blockNumber: string;
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly args: Readonly<Record<string, string>>;
}

export interface ChainGuardLogFindings {
  /** Paused / Freeze sightings, opened before the state read resolves them. */
  readonly state: readonly ChainGuardFinding[];
  readonly events: readonly ChainGuardFinding<ChainGuardEventKind>[];
}

/**
 * Maps logs to incidents. Freeze / drain / reallocate count only for a
 * watched address; Upgraded / AdminChanged / owner changes always count.
 */
export function chainGuardLogFindings(input: {
  readonly logs: readonly ChainGuardLog[];
  readonly usd1: string;
  readonly proxyAdmin: string | null;
  readonly watched: ReadonlySet<string>;
  /** Decision 0135: the PoolManagers whose fee logs count. */
  readonly poolManagers?: ReadonlySet<string>;
  /** Decision 0135: our graduated pools (pool id → instance id). */
  readonly graduatedPools?: ReadonlyMap<string, string>;
  /** Decision 0135: thresholds for the fee / controller logs. */
  readonly policy?: Pick<
    ChainGuardPolicy,
    "protocolFeeAlertPips" | "expectedProtocolFeeController"
  >;
}): ChainGuardLogFindings {
  const poolManagers = input.poolManagers ?? new Set<string>();
  const graduatedPools = input.graduatedPools ?? new Map<string, string>();
  const state: ChainGuardFinding[] = [];
  const events: ChainGuardFinding<ChainGuardEventKind>[] = [];
  for (const log of input.logs) {
    const at = {
      source: "event",
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
    };
    const fromUsd1 = log.address === input.usd1;
    const args = log.args;
    switch (log.name) {
      case "Paused":
        if (fromUsd1) {
          state.push({ kind: "usd1_paused", subject: input.usd1, details: at });
        }
        break;
      case "Freeze":
        if (fromUsd1 && input.watched.has(args["account"] ?? "")) {
          state.push({
            kind: "usd1_address_frozen",
            subject: args["account"] as string,
            details: at,
          });
        }
        break;
      case "FrozenAccountDrained":
        if (fromUsd1 && input.watched.has(args["account"] ?? "")) {
          events.push({
            kind: "usd1_frozen_funds_drained",
            subject: args["account"] as string,
            details: { ...at, amountRaw: args["amount"] ?? null },
          });
        }
        break;
      case "FrozenFundsReallocated":
        if (fromUsd1 && input.watched.has(args["from"] ?? "")) {
          events.push({
            kind: "usd1_frozen_funds_reallocated",
            subject: args["from"] as string,
            details: {
              ...at,
              to: args["to"] ?? null,
              amountRaw: args["amount"] ?? null,
            },
          });
        }
        break;
      case "Upgraded":
        if (fromUsd1 && args["implementation"] !== undefined) {
          events.push({
            kind: "usd1_upgraded",
            subject: args["implementation"],
            details: at,
          });
        }
        break;
      case "AdminChanged":
        if (fromUsd1 && args["newAdmin"] !== undefined) {
          events.push({
            kind: "usd1_proxy_admin_changed",
            subject: args["newAdmin"],
            details: { ...at, previousAdmin: args["previousAdmin"] ?? null },
          });
        }
        break;
      case "OwnershipTransferred":
        if (args["newOwner"] === undefined) break;
        if (fromUsd1) {
          events.push({
            kind: "usd1_owner_transferred",
            subject: args["newOwner"],
            details: { ...at, previousOwner: args["previousOwner"] ?? null },
          });
        } else if (log.address === input.proxyAdmin) {
          events.push({
            kind: "usd1_proxy_admin_ownership_transferred",
            subject: args["newOwner"],
            details: {
              ...at,
              proxyAdmin: log.address,
              previousOwner: args["previousOwner"] ?? null,
            },
          });
        }
        break;
      case "ProtocolFeeUpdated": {
        // Decision 0135: only our graduated pools, only a known PoolManager.
        const poolId = args["id"] ?? "";
        const instanceId = graduatedPools.get(poolId);
        if (
          !poolManagers.has(log.address) ||
          instanceId === undefined ||
          input.policy === undefined
        ) {
          break;
        }
        const fee = decodePackedProtocolFee(Number(args["protocolFee"] ?? "0"));
        const highest = Math.max(fee.zeroForOnePips, fee.oneForZeroPips);
        if (highest === 0) break;
        const details = {
          ...at,
          instanceId,
          poolManager: log.address,
          zeroForOnePips: fee.zeroForOnePips,
          oneForZeroPips: fee.oneForZeroPips,
          alertPips: input.policy.protocolFeeAlertPips,
        };
        state.push({
          kind: "pool_protocol_fee_nonzero",
          subject: poolId,
          details,
        });
        if (highest >= input.policy.protocolFeeAlertPips) {
          state.push({
            kind: "pool_protocol_fee_high",
            subject: poolId,
            details,
          });
        }
        break;
      }
      case "ProtocolFeeControllerUpdated": {
        const expected = input.policy?.expectedProtocolFeeController ?? null;
        const observed = args["protocolFeeController"];
        if (
          !poolManagers.has(log.address) ||
          expected === null ||
          observed === undefined ||
          observed === expected
        ) {
          break;
        }
        state.push({
          kind: "protocol_fee_controller_changed",
          subject: log.address,
          details: { ...at, expected, observed },
        });
        break;
      }
      case "Unpaused":
      case "Unfreeze":
        // Cleared conditions are resolved by the state read.
        break;
    }
  }
  return Object.freeze({
    state: Object.freeze(dedupeFindings(state)),
    events: Object.freeze(dedupeFindings(events)),
  });
}
