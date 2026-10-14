import { randomUUID } from "node:crypto";

import { waitFor, type PeriodicLane } from "../../bsc-meme-indexer-worker.js";
import {
  chainGuardDefaults,
  chainGuardEventIncidentTtlSeconds,
  chainGuardEventKinds,
  chainGuardIncidentKey,
  chainGuardLane,
  chainGuardReasonCodes,
  type ChainGuardIncidentRecord,
  type ChainGuardRepository,
} from "./chain-guard-contract.js";
import {
  ChainGuardUsd1NotConfiguredError,
  collectChainGuardSnapshot,
  type ChainGuardChain,
  type ChainGuardTargets,
} from "./chain-guard-collect.js";
import {
  chainGuardLogFindings,
  evaluateChainGuardSnapshot,
  type ChainGuardLog,
  type ChainGuardPolicy,
} from "./chain-guard-evaluate.js";

/**
 * Decision 0134: the `chain_guard` lane (CHAIN_GUARD_ENABLED, default off).
 * One tick every CHAIN_GUARD_INTERVAL_SECONDS:
 *
 * 1. reads the watch set (every registered launch2 instance's NftEscrow /
 *    ProjectNFT / CurveEngine / two adapters / BuybackExecutor, the
 *    Factories' PoolManager / tax receivers / routers / keepers, the
 *    OfficialPoolRouter, the configured signer accounts);
 * 2. reads USD1 / ProxyAdmin logs since the cursor (≤ 2,000 blocks per
 *    query, ≤ 5 queries per tick, `confirmations` behind the head);
 * 3. reads `paused()`, `frozen()` of each watched address, the EIP-1967
 *    implementation, `protocolFeeController()`, each graduated pool's
 *    protocol fee, the signer accounts' BNB balance;
 * 4. opens / touches an incident per finding (logged at error level with
 *    `CHAIN_GUARD_<KIND>` once, when opened) and resolves the ones whose
 *    condition is gone (event incidents after 24 h).
 *
 * Without a USD1 address or on the wrong chain the tick is `unavailable`
 * (logged once) and nothing is written; existing incidents stay open.
 */

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export interface ChainGuardIncidentEvent {
  readonly change: "opened" | "resolved";
  readonly incident: ChainGuardIncidentRecord;
}

export interface ChainGuardLaneOptions {
  readonly repository: ChainGuardRepository;
  readonly chain: ChainGuardChain;
  readonly targets: ChainGuardTargets;
  readonly policy: ChainGuardPolicy;
  readonly confirmations: number;
  readonly intervalSeconds: number;
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly maxLogRange?: bigint;
  readonly maxLogRangesPerTick?: number;
  readonly onIncident?: (event: ChainGuardIncidentEvent) => void;
  /** Once per distinct reason (unavailable / checks not configured). */
  readonly onNotice?: (event: {
    readonly reasonCode: string;
    readonly detail: string | null;
  }) => void;
  readonly onInfrastructureBackoff?: (event: {
    readonly lane: string;
    readonly consecutiveFailureCount: number;
    readonly retryDelayMs: number;
    readonly errorClass: string;
  }) => void;
}

export function createChainGuardLane(
  options: ChainGuardLaneOptions,
): PeriodicLane {
  const now = options.now ?? ((): Date => new Date());
  const createId = options.createId ?? randomUUID;
  const maxRange = options.maxLogRange ?? chainGuardDefaults.maxLogRange;
  const maxRanges =
    options.maxLogRangesPerTick ?? chainGuardDefaults.maxLogRangesPerTick;
  const { repository, chain, targets } = options;
  let lastNotice: string | null = null;

  function notice(reasonCode: string, detail: string | null): void {
    const key = `${reasonCode}:${detail ?? ""}`;
    if (key === lastNotice) return;
    lastNotice = key;
    options.onNotice?.({ reasonCode, detail });
  }

  async function readLogs(
    usd1: string,
    proxyAdmin: string | null,
  ): Promise<{ logs: ChainGuardLog[]; cursor: bigint | null }> {
    const head = await chain.head();
    const safe = head - BigInt(options.confirmations);
    if (safe < 0n) return { logs: [], cursor: null };
    const stored = await repository.getCursor(targets.chainId);
    let from =
      stored === null
        ? safe - chainGuardDefaults.initialLogLookbackBlocks + 1n
        : stored + 1n;
    if (from < 0n) from = 0n;
    const logs: ChainGuardLog[] = [];
    let cursor: bigint | null = null;
    for (let index = 0; index < maxRanges && from <= safe; index += 1) {
      const to = from + maxRange - 1n < safe ? from + maxRange - 1n : safe;
      logs.push(
        ...(await chain.getLogs({
          usd1,
          proxyAdmin,
          fromBlock: from,
          toBlock: to,
        })),
      );
      cursor = to;
      from = to + 1n;
    }
    return { logs, cursor };
  }

  async function tick(): Promise<Record<string, unknown>> {
    const chainReference = await chain.chainId();
    if (chainReference !== targets.chainReference) {
      notice(chainGuardReasonCodes.chainMismatch, String(chainReference));
      return {
        kind: "unavailable",
        reasonCode: chainGuardReasonCodes.chainMismatch,
      };
    }
    const instances = await repository.listWatchInstances(targets.chainId);
    let collected;
    try {
      collected = await collectChainGuardSnapshot({
        chain,
        targets,
        instances,
      });
    } catch (error) {
      if (error instanceof ChainGuardUsd1NotConfiguredError) {
        notice(chainGuardReasonCodes.usd1NotConfigured, null);
        return {
          kind: "unavailable",
          reasonCode: chainGuardReasonCodes.usd1NotConfigured,
        };
      }
      throw error;
    }
    const { logs, cursor } = await readLogs(
      collected.usd1,
      collected.proxyAdmin,
    );
    const fromLogs = chainGuardLogFindings({
      logs,
      usd1: collected.usd1,
      proxyAdmin: collected.proxyAdmin,
      watched: new Set(collected.watched.map((entry) => entry.address)),
    });
    const evaluation = evaluateChainGuardSnapshot(
      collected.snapshot,
      options.policy,
    );
    if (evaluation.notConfigured.length > 0) {
      notice(
        chainGuardReasonCodes.checkNotConfigured,
        evaluation.notConfigured.join(","),
      );
    }
    const at = now();
    let opened = 0;
    for (const finding of [
      ...fromLogs.state,
      ...fromLogs.events,
      ...evaluation.findings,
    ]) {
      const result = await repository.openOrTouch({
        incidentId: createId(),
        chainId: targets.chainId,
        kind: finding.kind,
        subject: finding.subject,
        details: finding.details,
        now: at,
      });
      if (result.opened) {
        opened += 1;
        options.onIncident?.({ change: "opened", incident: result.incident });
      }
    }
    const resolved = await repository.resolve({
      chainId: targets.chainId,
      kinds: [...evaluation.evaluatedKinds, ...chainGuardEventKinds],
      keep: evaluation.findings.map((finding) =>
        chainGuardIncidentKey(finding.kind, finding.subject),
      ),
      eventsSeenBefore: new Date(
        at.getTime() - chainGuardEventIncidentTtlSeconds * 1000,
      ),
      now: at,
    });
    for (const incident of resolved) {
      options.onIncident?.({ change: "resolved", incident });
    }
    if (cursor !== null) {
      await repository.setCursor({
        chainId: targets.chainId,
        blockNumber: cursor,
        now: at,
      });
    }
    return {
      kind: "checked",
      watchedCount: collected.watched.length,
      poolCount: collected.snapshot.pools.length,
      logCount: logs.length,
      findingCount: evaluation.findings.length + fromLogs.events.length,
      openedCount: opened,
      resolvedCount: resolved.length,
      unsupported: evaluation.unsupported,
    };
  }

  return Object.freeze({
    lane: chainGuardLane,
    runOnce: () => tick(),
    async run(signal: AbortSignal): Promise<void> {
      let failures = 0;
      while (!isAborted(signal)) {
        try {
          await tick();
          failures = 0;
          await waitFor(options.intervalSeconds * 1000, signal);
        } catch (error) {
          if (isAborted(signal)) break;
          failures += 1;
          const delay = Math.min(1_000 * 2 ** (failures - 1), 60_000);
          options.onInfrastructureBackoff?.({
            lane: chainGuardLane,
            consecutiveFailureCount: failures,
            retryDelayMs: delay,
            errorClass: error instanceof Error ? error.name : "UnknownError",
          });
          await waitFor(delay, signal);
        }
      }
    },
  });
}
