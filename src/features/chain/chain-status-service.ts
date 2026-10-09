import { V2ApiError } from "../../core/http/v2-error.js";
import type { ChainRegistryRepository } from "../../database/chain-registry-repository.js";
import {
  indexerLanes,
  type BscIndexerRepository,
  type IndexerLane,
} from "../../database/bsc-indexer-repository.js";
import type {
  BscEndpointHealth,
  BscReadClient,
  ChainVerificationState,
} from "../../integrations/bsc/rpc-client.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import {
  launchChainReasonCodes,
  type LaunchChainId,
} from "./chain-contract.js";

/**
 * Read freshness surface for the `networks` page (Decision 0033).
 *
 * It reports what the backend actually observed: per-endpoint health behind
 * opaque references, the verified chain ID, and the indexer's own height and
 * lag. Nothing here is inferred; an unreachable endpoint or an indexer that
 * never ran is reported as such instead of as a healthy zero.
 */

export const chainStatusReasonCodes = Object.freeze({
  notConfigured: "BSC_RPC_NOT_CONFIGURED",
  mismatched: "BSC_CHAIN_ID_MISMATCH",
  unreachable: "BSC_RPC_UNREACHABLE",
  verificationPending: "BSC_CHAIN_VERIFICATION_PENDING",
  indexerNotStarted: "BSC_INDEXER_NOT_STARTED",
} as const);

export interface ChainHeadProjection {
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly observedAt: string;
}

export interface IndexerLaneProjection {
  readonly lane: IndexerLane;
  readonly status: "available" | "unavailable";
  readonly reasonCode: string | null;
  readonly lastBlockNumber: string | null;
  readonly lastBlockHash: string | null;
  readonly lagBlocks: number | null;
  readonly reorgCount: number | null;
  readonly updatedAt: string | null;
}

/**
 * The `launch` chain slot (Decision 0038): published only when it differs
 * from the primary slot, and then without an endpoint list — the slot's
 * health is one verification state, one head, and one reason code.
 */
export interface LaunchChainStatusProjection {
  readonly chainId: LaunchChainId;
  readonly chainReference: number;
  readonly verification: ChainVerificationState;
  readonly confirmations: number;
  readonly reorgDepthBlocks: number;
  readonly head: ChainHeadProjection | null;
  readonly reasonCode: string | null;
}

export interface ChainStatusResource {
  readonly chain: {
    readonly chainId: string;
    readonly name: string;
    readonly reference: number;
    readonly nativeAssetId: string;
    readonly confirmations: number;
    readonly reorgDepthBlocks: number;
  };
  readonly rpc: {
    readonly status: "available" | "unavailable";
    readonly reasonCode: string | null;
    readonly verification: ChainVerificationState;
    readonly head: ChainHeadProjection | null;
    readonly endpoints: readonly BscEndpointHealth[];
  };
  readonly indexer: readonly IndexerLaneProjection[];
  readonly registry: {
    readonly readableAssetCount: number;
    readonly registeredPoolCount: number;
  };
  /**
   * Absent while the launch slot equals the primary slot (Decision 0038):
   * a client that predates the slot must see a byte-identical document.
   */
  readonly launchChain?: LaunchChainStatusProjection;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface ChainStatusService {
  getStatus(): Promise<ChainStatusResource>;
}

/**
 * How long one chain verification and one endpoint probe are reused by this
 * route (Decision 0088). Past half of it the probe is still served and run
 * again beside the call. The per-endpoint `observedAt` stays the time the
 * probe ran; the head is never reused.
 */
export const chainStatusObservationTtlMs = 60_000;

export interface CreateChainStatusServiceInput {
  /** Overrides `chainStatusObservationTtlMs`; zero disables the reuse. */
  readonly observationTtlMs?: number;
  /** Clock for the reuse window; defaults to `Date.now`. */
  readonly nowMs?: () => number;
  readonly repository: ChainRegistryRepository;
  readonly indexerRepository: BscIndexerRepository;
  readonly readClient: BscReadClient;
  readonly chainId: string;
  readonly chainName: string;
  readonly chainReference: number;
  readonly nativeAssetId: string;
  /** The launch slot's own client, or `null` when it is shared with primary. */
  readonly launchReadClient: BscReadClient | null;
}

function launchChainReasonCode(
  verification: ChainVerificationState,
): string | null {
  switch (verification) {
    case "verified": {
      return null;
    }
    case "mismatched": {
      return launchChainReasonCodes.mismatched;
    }
    case "unreachable": {
      return launchChainReasonCodes.unreachable;
    }
    case "unknown": {
      return launchChainReasonCodes.verificationPending;
    }
  }
}

async function projectLaunchChain(
  client: BscReadClient | null,
  verify: (client: BscReadClient) => Promise<ChainVerificationState>,
): Promise<LaunchChainStatusProjection | null> {
  if (client === null) {
    return null;
  }
  const identity = Object.freeze({
    chainId: client.chainId,
    chainReference: client.chainReference,
    confirmations: client.confirmations,
    reorgDepthBlocks: client.reorgDepthBlocks,
  });
  if (client.endpointRefs.length === 0) {
    return Object.freeze({
      ...identity,
      verification: "unknown" as const,
      head: null,
      reasonCode: launchChainReasonCodes.notConfigured,
    });
  }
  const verification = await verify(client);
  const reasonCode = launchChainReasonCode(verification);
  const head = reasonCode === null ? await readHeadProjection(client) : null;
  return Object.freeze({ ...identity, verification, head, reasonCode });
}

/** The live head, or `null` when the read fails; never a cached value. */
async function readHeadProjection(
  client: BscReadClient,
): Promise<ChainHeadProjection | null> {
  try {
    const observed = await client.getHead();
    return Object.freeze({
      blockNumber: observed.blockNumber.toString(10),
      blockHash: observed.blockHash,
      observedAt: observed.observedAt,
    });
  } catch {
    return null;
  }
}

interface TimedObservation<T> {
  readonly value: T;
  /** When the read was started; the reuse window counts from here. */
  readonly startedAtMs: number;
}

/**
 * One reusable observation (Decision 0088): concurrent callers share the
 * read in flight; a completed read is served for `ttlMs` from when it
 * started, and past half of it a fresh read is started beside the caller.
 * A read that rejects is never remembered.
 */
function reusableObservation<T>(
  read: () => Promise<T>,
  ttlMs: number,
  nowMs: () => number,
  refreshBeside: boolean,
): () => Promise<T> {
  let remembered: TimedObservation<T> | null = null;
  let inFlight: Promise<T> | null = null;
  const start = (): Promise<T> => {
    if (inFlight !== null) {
      return inFlight;
    }
    const startedAtMs = nowMs();
    const pending = read()
      .then((value) => {
        if (ttlMs > 0) {
          remembered = { value, startedAtMs };
        }
        return value;
      })
      .finally(() => {
        if (inFlight === pending) {
          inFlight = null;
        }
      });
    inFlight = pending;
    return pending;
  };
  return (): Promise<T> => {
    const current = remembered;
    if (current !== null) {
      const ageMs = nowMs() - current.startedAtMs;
      if (ageMs >= 0 && ageMs < ttlMs) {
        if (refreshBeside && ageMs >= ttlMs / 2) {
          start().catch(() => undefined);
        }
        return Promise.resolve(current.value);
      }
      remembered = null;
    }
    return start();
  };
}

function rpcReasonCode(verification: ChainVerificationState): string | null {
  switch (verification) {
    case "verified": {
      return null;
    }
    case "mismatched": {
      return chainStatusReasonCodes.mismatched;
    }
    case "unreachable": {
      return chainStatusReasonCodes.unreachable;
    }
    case "unknown": {
      return chainStatusReasonCodes.verificationPending;
    }
  }
}

export function createChainStatusService(
  input: CreateChainStatusServiceInput,
): ChainStatusService {
  const ttlMs = input.observationTtlMs ?? chainStatusObservationTtlMs;
  const nowMs = input.nowMs ?? ((): number => Date.now());
  const verifications = new Map<
    BscReadClient,
    () => Promise<ChainVerificationState>
  >();
  /**
   * The client already caches a verified or mismatched state for good; an
   * unreachable or pending one is asked again at most once per window by
   * this route, and a recovery observed by any other read is reported at
   * once through `currentVerification()`.
   */
  const verificationOf = (
    client: BscReadClient,
  ): Promise<ChainVerificationState> => {
    const current = client.currentVerification();
    if (current === "verified" || current === "mismatched") {
      return Promise.resolve(current);
    }
    let observe = verifications.get(client);
    if (observe === undefined) {
      observe = reusableObservation(
        () => client.verifyChain(),
        ttlMs,
        nowMs,
        false,
      );
      verifications.set(client, observe);
    }
    return observe();
  };
  const probeEndpoints = reusableObservation(
    () => input.readClient.probeEndpoints(),
    ttlMs,
    nowMs,
    true,
  );

  return Object.freeze({
    async getStatus(): Promise<ChainStatusResource> {
      // Without a configured endpoint there is no chain to report on. The
      // route fails closed rather than publishing an all-null "healthy" shape.
      if (input.readClient.endpointRefs.length === 0) {
        throw V2ApiError.capabilityUnavailable();
      }
      // Decision 0088: every leg below is independent except the head, which
      // waits only for the verification. They run together; the page costs
      // one head round trip (plus one probe when the window has lapsed)
      // instead of five sequential RPC stages.
      const verificationPending = verificationOf(input.readClient);
      const headPending = verificationPending.then((verification) =>
        rpcReasonCode(verification) === null
          ? readHeadProjection(input.readClient)
          : null,
      );
      const [
        verification,
        endpoints,
        head,
        checkpoints,
        assets,
        pools,
        launchChain,
      ] = await Promise.all([
        verificationPending,
        probeEndpoints(),
        headPending,
        Promise.all(
          indexerLanes.map((laneName) =>
            input.indexerRepository.getCheckpoint(laneName, input.chainId),
          ),
        ),
        input.repository.listReadableAssets(input.chainId),
        input.repository.listPools(input.chainId),
        projectLaunchChain(input.launchReadClient, verificationOf),
      ]);
      const reasonCode = rpcReasonCode(verification);

      const lanes: IndexerLaneProjection[] = indexerLanes.map(
        (laneName, index) => {
          const checkpoint = checkpoints[index] ?? null;
          return checkpoint === null
            ? Object.freeze({
                lane: laneName,
                status: "unavailable" as const,
                reasonCode: chainStatusReasonCodes.indexerNotStarted,
                lastBlockNumber: null,
                lastBlockHash: null,
                lagBlocks: null,
                reorgCount: null,
                updatedAt: null,
              })
            : Object.freeze({
                lane: laneName,
                status: "available" as const,
                reasonCode: null,
                lastBlockNumber: checkpoint.lastBlockNumber,
                lastBlockHash: checkpoint.lastBlockHash,
                lagBlocks:
                  head === null
                    ? null
                    : Number(
                        BigInt(head.blockNumber) -
                          BigInt(checkpoint.lastBlockNumber),
                      ),
                reorgCount: checkpoint.reorgCount,
                updatedAt: checkpoint.updatedAt,
              });
        },
      );

      return Object.freeze({
        chain: Object.freeze({
          chainId: input.chainId,
          name: input.chainName,
          reference: input.chainReference,
          nativeAssetId: input.nativeAssetId,
          confirmations: input.readClient.confirmations,
          reorgDepthBlocks: input.readClient.reorgDepthBlocks,
        }),
        rpc: Object.freeze({
          status:
            reasonCode === null
              ? ("available" as const)
              : ("unavailable" as const),
          reasonCode,
          verification,
          head,
          endpoints,
        }),
        indexer: Object.freeze(lanes),
        registry: Object.freeze({
          readableAssetCount: assets.length,
          registeredPoolCount: pools.length,
        }),
        ...(launchChain === null ? {} : { launchChain }),
        contractVersion: v2ContractVersion,
      });
    },
  });
}
