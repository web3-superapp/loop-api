import { V2ApiError } from "../../core/http/v2-error.js";
import type { ChainRegistryRepository } from "../../database/chain-registry-repository.js";
import type { BscIndexerRepository } from "../../database/bsc-indexer-repository.js";
import type {
  BscEndpointHealth,
  BscReadClient,
  ChainVerificationState,
} from "../../integrations/bsc/rpc-client.js";
import { v2ContractVersion } from "../meta/product-policy.js";

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
  readonly lane: "erc20_transfer";
  readonly status: "available" | "unavailable";
  readonly reasonCode: string | null;
  readonly lastBlockNumber: string | null;
  readonly lastBlockHash: string | null;
  readonly lagBlocks: number | null;
  readonly reorgCount: number | null;
  readonly updatedAt: string | null;
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
  readonly contractVersion: typeof v2ContractVersion;
}

export interface ChainStatusService {
  getStatus(): Promise<ChainStatusResource>;
}

export interface CreateChainStatusServiceInput {
  readonly repository: ChainRegistryRepository;
  readonly indexerRepository: BscIndexerRepository;
  readonly readClient: BscReadClient;
  readonly chainId: string;
  readonly chainName: string;
  readonly chainReference: number;
  readonly nativeAssetId: string;
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
  return Object.freeze({
    async getStatus(): Promise<ChainStatusResource> {
      // Without a configured endpoint there is no chain to report on. The
      // route fails closed rather than publishing an all-null "healthy" shape.
      if (input.readClient.endpointRefs.length === 0) {
        throw V2ApiError.capabilityUnavailable();
      }
      const verification = await input.readClient.verifyChain();
      const reasonCode = rpcReasonCode(verification);
      const endpoints = await input.readClient.probeEndpoints();

      let head: ChainHeadProjection | null = null;
      if (reasonCode === null) {
        try {
          const observed = await input.readClient.getHead();
          head = Object.freeze({
            blockNumber: observed.blockNumber.toString(10),
            blockHash: observed.blockHash,
            observedAt: observed.observedAt,
          });
        } catch {
          head = null;
        }
      }

      const checkpoint = await input.indexerRepository.getCheckpoint(
        "erc20_transfer",
        input.chainId,
      );
      const lane: IndexerLaneProjection =
        checkpoint === null
          ? Object.freeze({
              lane: "erc20_transfer" as const,
              status: "unavailable" as const,
              reasonCode: chainStatusReasonCodes.indexerNotStarted,
              lastBlockNumber: null,
              lastBlockHash: null,
              lagBlocks: null,
              reorgCount: null,
              updatedAt: null,
            })
          : Object.freeze({
              lane: "erc20_transfer" as const,
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

      const [assets, pools] = await Promise.all([
        input.repository.listReadableAssets(input.chainId),
        input.repository.listPools(input.chainId),
      ]);

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
        indexer: Object.freeze([lane]),
        registry: Object.freeze({
          readableAssetCount: assets.length,
          registeredPoolCount: pools.length,
        }),
        contractVersion: v2ContractVersion,
      });
    },
  });
}
