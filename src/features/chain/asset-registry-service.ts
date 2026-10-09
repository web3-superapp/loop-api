import { V2ApiError } from "../../core/http/v2-error.js";
import type {
  AssetRecord,
  ChainRegistryRepository,
} from "../../database/chain-registry-repository.js";
import {
  BscChainMismatchError,
  BscReadUnavailableError,
  type BscReadClient,
} from "../../integrations/bsc/rpc-client.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import {
  assetIdForAddress,
  decomposeAssetId,
  InvalidChainIdentityError,
  isAssetId,
  normalizeEvmAddress,
  type AssetCapabilityValue,
  type AssetStatus,
} from "./chain-contract.js";

/**
 * Asset Registry policy (Decision 0033).
 *
 * `symbol`, `name`, and `decimals` are only ever the values an on-chain
 * `symbol()`/`name()`/`decimals()` call returned, recorded together with the
 * block that was observed. A registry row is evidence of identity, never of
 * price, liquidity, tradability, or safety.
 */

export interface AssetSourceProjection {
  readonly kind: "chain_call" | "chain_native" | "operator_block";
  readonly blockNumber: string | null;
  readonly verifiedAt: string | null;
}

export interface AssetProjection {
  readonly assetId: string;
  readonly chainId: string;
  /**
   * The public token contract address. It is a chain fact the product needs
   * (explorer links, receive/verify flows) and is never an identity key.
   */
  readonly address: string | null;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly status: AssetStatus;
  readonly source: AssetSourceProjection;
  readonly updatedAt: string;
}

export interface AssetCapabilityProjection {
  readonly viewable: boolean;
  /** Always false until the Swap module is delivered (D15). */
  readonly swappable: boolean;
  readonly value: AssetCapabilityValue;
  readonly reasonCode: string | null;
}

export interface AssetResource {
  readonly asset: AssetProjection;
  readonly capability: AssetCapabilityProjection;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface AssetRegistryService {
  getAsset(assetId: unknown): Promise<AssetResource>;
  listReadableAssets(): Promise<readonly AssetRecord[]>;
  /**
   * Dev-only registration path used by `pnpm asset:register`. It performs the
   * on-chain identity read itself so no operator-supplied symbol, name, or
   * decimals value can enter the registry.
   */
  registerFromChain(input: {
    readonly address: string;
    readonly expectVerified: boolean;
  }): Promise<AssetResource>;
}

export interface CreateAssetRegistryServiceInput {
  readonly repository: ChainRegistryRepository;
  readonly readClient: BscReadClient;
  readonly chainId: string;
  /** Verified USD1 address slot; only this address may become `verified`. */
  readonly verifiedUsd1Address: string | null;
}

export const assetRegistryReasonCodes = Object.freeze({
  blocked: "ASSET_BLOCKED",
  chainUnavailable: "BSC_READ_UNAVAILABLE",
  swapDeferred: "SWAP_MODULE_NOT_DELIVERED",
} as const);

function projectAsset(record: AssetRecord): AssetProjection {
  return Object.freeze({
    assetId: record.assetId,
    chainId: record.chainId,
    address: record.address,
    symbol: record.symbol,
    name: record.name,
    decimals: record.decimals,
    status: record.status,
    source: Object.freeze({
      kind: record.sourceKind,
      blockNumber: record.sourceBlockNumber,
      verifiedAt: record.sourceVerifiedAt,
    }),
    updatedAt: record.updatedAt,
  });
}

export function projectAssetCapability(
  record: AssetRecord,
  chainReadable: boolean,
): AssetCapabilityProjection {
  if (record.status === "blocked") {
    return Object.freeze({
      viewable: false,
      swappable: false,
      value: "blocked",
      reasonCode: assetRegistryReasonCodes.blocked,
    });
  }
  if (!chainReadable) {
    return Object.freeze({
      viewable: true,
      swappable: false,
      value: "temporarily_unavailable",
      reasonCode: assetRegistryReasonCodes.chainUnavailable,
    });
  }
  return Object.freeze({
    viewable: true,
    swappable: false,
    value: "viewable",
    reasonCode: assetRegistryReasonCodes.swapDeferred,
  });
}

export function createAssetRegistryService(
  input: CreateAssetRegistryServiceInput,
): AssetRegistryService {
  async function chainReadable(): Promise<boolean> {
    return (await input.readClient.verifyChain()) === "verified";
  }

  async function toResource(record: AssetRecord): Promise<AssetResource> {
    return Object.freeze({
      asset: projectAsset(record),
      capability: projectAssetCapability(record, await chainReadable()),
      contractVersion: v2ContractVersion,
    });
  }

  return Object.freeze({
    async getAsset(assetId: unknown): Promise<AssetResource> {
      if (!isAssetId(assetId)) {
        throw V2ApiError.invalidRequest();
      }
      const decomposed = decomposeAssetId(assetId);
      if (decomposed.chainId !== input.chainId) {
        throw V2ApiError.fromCode("CHAIN_MISMATCH");
      }
      const record = await input.repository.getAsset(assetId);
      if (record === null) {
        throw V2ApiError.notFound();
      }
      return toResource(record);
    },

    listReadableAssets(): Promise<readonly AssetRecord[]> {
      return input.repository.listReadableAssets(input.chainId);
    },

    async registerFromChain(request: {
      readonly address: string;
      readonly expectVerified: boolean;
    }): Promise<AssetResource> {
      let address: string;
      try {
        address = normalizeEvmAddress(request.address);
      } catch (error) {
        if (error instanceof InvalidChainIdentityError) {
          throw V2ApiError.invalidRequest();
        }
        throw error;
      }

      let identity;
      let head;
      try {
        head = await input.readClient.getHead();
        identity = await input.readClient.readTokenIdentity(address);
      } catch (error) {
        if (
          error instanceof BscReadUnavailableError ||
          error instanceof BscChainMismatchError
        ) {
          throw V2ApiError.capabilityUnavailable();
        }
        throw error;
      }

      // `verified` requires both the configured slot and the operator's
      // explicit intent; a configured address alone never earns it.
      const status: AssetStatus =
        request.expectVerified &&
        input.verifiedUsd1Address !== null &&
        input.verifiedUsd1Address === address
          ? "verified"
          : "pending";

      const record = await input.repository.upsertAsset({
        assetId: assetIdForAddress(input.chainId, address),
        chainId: input.chainId,
        address,
        symbol: identity.symbol,
        name: identity.name,
        decimals: identity.decimals,
        status,
        sourceBlockNumber: head.blockNumber.toString(10),
      });
      return toResource(record);
    },
  });
}
