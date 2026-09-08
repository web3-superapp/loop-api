import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import {
  InvalidV2CursorError,
  type V2CursorCodec,
} from "../../core/http/v2-cursor.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import { isOpaqueId } from "../../core/ids/opaque-id.js";
import {
  AccountWalletNotFoundError,
  AccountWalletObservationEmptyError,
  AccountWalletVersionConflictError,
  type AccountWalletRecord,
  type AccountWalletRepository,
} from "../../database/account-wallet-repository.js";
import type { BscIndexerRepository } from "../../database/bsc-indexer-repository.js";
import type { AssetRecord } from "../../database/chain-registry-repository.js";
import {
  BscChainMismatchError,
  BscReadUnavailableError,
  type BscBalanceReadResult,
  type BscReadClient,
} from "../../integrations/bsc/rpc-client.js";
import type {
  PrivyBalanceReader,
  PrivyWalletReader,
} from "../../integrations/privy/wallet-reader.js";
import type { AssetRegistryService } from "../chain/asset-registry-service.js";
import {
  bscNativeDecimals,
  eip681Uri,
  formatDecimalAmount,
  subtractFloorZero,
  type WalletKind,
} from "../chain/chain-contract.js";
import { v2ContractVersion } from "../meta/product-policy.js";

/**
 * Read-only wallet projections for D12 (Decision 0033).
 *
 * The RPC read is the authoritative balance source. Privy's own balance view
 * is a cross-check only: a mismatch is reported as `disputed` and a failed
 * cross-check as `unavailable`, and neither ever changes the published RPC
 * value. Nothing is served from a cached snapshot when the chain is
 * unreadable: the capability fails closed instead.
 */

export const walletGasReserveConfigVersion = "walletGasReserveV1" as const;

export const walletReasonCodes = Object.freeze({
  chainUnavailable: "BSC_READ_UNAVAILABLE",
  indexerNotStarted: "BSC_INDEXER_NOT_STARTED",
  nativeTransfersUnsupported: "NATIVE_TRANSFER_SCAN_NOT_SUPPORTED",
  priceProviderMissing: "MARKET_PRICE_PROVIDER_NOT_CONFIGURED",
  privyWalletIdMissing: "PRIVY_WALLET_ID_UNAVAILABLE",
  privyAssetMappingMissing: "PRIVY_ASSET_MAPPING_UNAVAILABLE",
  privyCrossCheckFailed: "PRIVY_BALANCE_CROSS_CHECK_FAILED",
  privyScaleMismatch: "PRIVY_BALANCE_SCALE_MISMATCH",
  privyBlockUnaligned: "PRIVY_BALANCE_BLOCK_UNALIGNED",
  balanceCallFailed: "BSC_BALANCE_CALL_FAILED",
} as const);

export const walletActivityLimits = Object.freeze({
  default: 25,
  maximum: 50,
} as const);

const activityCursorRoute = "walletActivity";

export interface UnavailableProjection {
  readonly status: "unavailable";
  readonly reasonCode: string;
}

export interface WalletProjection {
  readonly walletId: string;
  readonly provider: "privy";
  /**
   * The wallet's public chain address. It is a public on-chain fact the
   * wallet screens need; it is never an account or authorization key, and the
   * server never accepts it as one.
   */
  readonly address: string;
  readonly kind: WalletKind;
  readonly status: "active" | "archived";
  readonly isActive: boolean;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

export interface WalletListResource {
  readonly wallets: readonly WalletProjection[];
  readonly activeWalletId: string | null;
  readonly source: {
    readonly provider: "privy";
    readonly observedAt: string;
  };
  readonly contractVersion: typeof v2ContractVersion;
}

export interface WalletBalanceAmounts {
  readonly status: "available";
  readonly rawValue: string;
  readonly displayBalance: string;
  readonly availableBalance: string;
  readonly spendableBalance: string;
  readonly gasReserve: string;
}

export type WalletCrossCheckStatus =
  "matched" | "unaligned" | "disputed" | "unavailable";

/**
 * One row per readable registry asset, always. When the chain call for a
 * single asset failed, the row keeps its identity and reports the amounts as
 * unavailable rather than disappearing, so the client can tell "no balance
 * data" apart from "not in this wallet".
 */
export interface WalletBalanceProjection {
  readonly assetId: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly address: string | null;
  readonly balance: WalletBalanceAmounts | UnavailableProjection;
  readonly pending:
    | {
        readonly status: "available";
        readonly rawValue: string;
        readonly displayValue: string;
      }
    | UnavailableProjection;
  readonly valuation: UnavailableProjection;
  readonly crossCheck: {
    readonly source: "privy";
    readonly status: WalletCrossCheckStatus;
    readonly reasonCode: string | null;
    /**
     * Block distance between the two observations, or null when the source
     * does not report the block it read. A difference that cannot be aligned
     * to one block is `unaligned`, never `disputed`.
     */
    readonly blockDelta: number | null;
  };
}

export interface WalletBalancesResource {
  readonly walletId: string;
  readonly snapshot: {
    readonly blockNumber: string;
    readonly blockHash: string;
    readonly observedAt: string;
    readonly confirmations: number;
  };
  readonly gasReservePolicy: {
    readonly configVersion: typeof walletGasReserveConfigVersion;
    readonly nativeReserveRaw: string;
    readonly nativeReserve: string;
  };
  readonly balances: readonly WalletBalanceProjection[];
  readonly netWorth: UnavailableProjection;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface WalletActivityItem {
  readonly assetId: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly direction: "in" | "out" | "self";
  readonly counterpartyAddress: string;
  readonly rawValue: string;
  readonly displayValue: string;
  readonly transactionHash: string;
  readonly logIndex: number;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly confirmations: number | null;
  readonly status: "confirmed" | "pending" | "reorged";
  readonly observedAt: string;
}

export interface WalletActivityResource {
  readonly walletId: string;
  readonly items: readonly WalletActivityItem[];
  readonly nextCursor: string | null;
  readonly freshness: {
    readonly indexerBlockNumber: string;
    readonly headBlockNumber: string | null;
    readonly lagBlocks: number | null;
    readonly observedAt: string;
  };
  readonly nativeTransfers: UnavailableProjection;
  readonly crossChain: UnavailableProjection;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface WalletReceiveResource {
  readonly walletId: string;
  readonly networks: readonly {
    readonly chainId: string;
    readonly name: string;
    readonly address: string;
    readonly uri: string;
    readonly warningKey: string;
  }[];
  readonly contractVersion: typeof v2ContractVersion;
}

export interface WalletReadService {
  listWallets(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly signal: AbortSignal;
  }): Promise<WalletListResource>;
  setActiveWallet(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly body: unknown;
  }): Promise<WalletListResource>;
  getBalances(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly walletId: string;
    readonly signal: AbortSignal;
  }): Promise<WalletBalancesResource>;
  getActivity(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly walletId: string;
    readonly cursor?: unknown;
    readonly limit?: unknown;
  }): Promise<WalletActivityResource>;
  getReceive(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly walletId: string;
  }): Promise<WalletReceiveResource>;
}

export interface CreateWalletReadServiceInput {
  readonly repository: AccountWalletRepository;
  readonly indexerRepository: BscIndexerRepository;
  readonly assetRegistry: AssetRegistryService;
  readonly readClient: BscReadClient;
  readonly walletReader: PrivyWalletReader;
  readonly balanceReader: PrivyBalanceReader;
  readonly cursorCodec: V2CursorCodec | null;
  /** Native reserve in wei, from WALLET_GAS_RESERVE_BNB. */
  readonly gasReserveRawWei: bigint;
  readonly chainId: string;
  readonly chainName: string;
  readonly chainReference: number;
  readonly now?: () => Date;
}

function projectWallet(record: AccountWalletRecord): WalletProjection {
  return Object.freeze({
    walletId: record.walletId,
    provider: "privy" as const,
    address: record.address,
    kind: record.kind,
    status: record.status,
    isActive: record.isActive,
    firstSeenAt: record.firstSeenAt,
    lastSeenAt: record.lastSeenAt,
  });
}

function projectWalletList(
  records: readonly AccountWalletRecord[],
  observedAt: string,
): WalletListResource {
  return Object.freeze({
    wallets: Object.freeze(records.map(projectWallet)),
    activeWalletId: records.find((record) => record.isActive)?.walletId ?? null,
    source: Object.freeze({ provider: "privy" as const, observedAt }),
    contractVersion: v2ContractVersion,
  });
}

function unavailable(reasonCode: string): UnavailableProjection {
  return Object.freeze({ status: "unavailable" as const, reasonCode });
}

function chainUnavailable(error: unknown): never {
  if (
    error instanceof BscReadUnavailableError ||
    error instanceof BscChainMismatchError
  ) {
    throw V2ApiError.capabilityUnavailable();
  }
  throw error as Error;
}

export function createWalletReadService(
  input: CreateWalletReadServiceInput,
): WalletReadService {
  const now = input.now ?? ((): Date => new Date());

  async function requireWallet(
    principal: AuthenticatedLoopPrincipal,
    walletId: string,
  ): Promise<AccountWalletRecord> {
    if (!isOpaqueId(walletId)) {
      throw V2ApiError.invalidRequest();
    }
    const record = await input.repository.get(principal.userId, walletId);
    if (record === null) {
      throw V2ApiError.notFound();
    }
    return record;
  }

  /**
   * Cross-check the authoritative RPC value against Privy's own view. Only the
   * native asset can be matched today: Privy reports named assets, not token
   * contract addresses, so a token match would be a guess.
   */
  /**
   * Rescales an observation to the registry asset's decimals. A source that
   * reports more precision than the asset has is only comparable when the
   * extra digits are zero; otherwise the comparison is refused instead of
   * rounded.
   */
  function rescaleObservation(
    rawValue: string,
    fromDecimals: number,
    toDecimals: number,
  ): bigint | null {
    const value = BigInt(rawValue);
    if (fromDecimals === toDecimals) {
      return value;
    }
    if (fromDecimals < toDecimals) {
      return value * 10n ** BigInt(toDecimals - fromDecimals);
    }
    const divisor = 10n ** BigInt(fromDecimals - toDecimals);
    return value % divisor === 0n ? value / divisor : null;
  }

  async function crossCheckNative(
    wallet: AccountWalletRecord,
    nativeRaw: bigint | null,
    nativeDecimals: number,
    signal: AbortSignal,
  ): Promise<{
    readonly status: WalletCrossCheckStatus;
    readonly reasonCode: string | null;
    readonly blockDelta: number | null;
  }> {
    const unavailableCrossCheck = (
      reasonCode: string,
    ): {
      readonly status: WalletCrossCheckStatus;
      readonly reasonCode: string | null;
      readonly blockDelta: number | null;
    } =>
      Object.freeze({
        status: "unavailable" as const,
        reasonCode,
        blockDelta: null,
      });

    if (wallet.providerWalletId === null) {
      return unavailableCrossCheck(walletReasonCodes.privyWalletIdMissing);
    }
    if (nativeRaw === null) {
      return unavailableCrossCheck(walletReasonCodes.balanceCallFailed);
    }
    try {
      const observations = await input.balanceReader.readBscBalances({
        providerWalletId: wallet.providerWalletId,
        signal,
      });
      const native = observations.find(
        (observation) => observation.asset === "bnb",
      );
      if (native === undefined) {
        return unavailableCrossCheck(
          walletReasonCodes.privyAssetMappingMissing,
        );
      }
      const rescaled = rescaleObservation(
        native.rawValue,
        native.decimals,
        nativeDecimals,
      );
      if (rescaled === null) {
        return unavailableCrossCheck(walletReasonCodes.privyScaleMismatch);
      }
      if (rescaled === nativeRaw) {
        return Object.freeze({
          status: "matched" as const,
          reasonCode: null,
          blockDelta: null,
        });
      }
      // Privy does not report the block it read, so a difference cannot be
      // attributed to a real disagreement rather than to a later block.
      return Object.freeze({
        status: "unaligned" as const,
        reasonCode: walletReasonCodes.privyBlockUnaligned,
        blockDelta: null,
      });
    } catch {
      return unavailableCrossCheck(walletReasonCodes.privyCrossCheckFailed);
    }
  }

  return Object.freeze({
    async listWallets({
      principal,
      signal,
    }: {
      readonly principal: AuthenticatedLoopPrincipal;
      readonly signal: AbortSignal;
    }): Promise<WalletListResource> {
      let observed;
      try {
        observed = await input.walletReader.listEthereumWallets({
          privyUserId: principal.privyUserId,
          signal,
        });
      } catch {
        throw V2ApiError.fromCode("PROVIDER_DISCONNECTED");
      }
      let records;
      try {
        records = await input.repository.sync({
          ownerUserId: principal.userId,
          observed,
        });
      } catch (error) {
        if (error instanceof AccountWalletObservationEmptyError) {
          throw V2ApiError.fromCode("PROVIDER_DISCONNECTED");
        }
        throw error;
      }
      return projectWalletList(records, now().toISOString());
    },

    async setActiveWallet({
      principal,
      body,
    }: {
      readonly principal: AuthenticatedLoopPrincipal;
      readonly body: unknown;
    }): Promise<WalletListResource> {
      if (typeof body !== "object" || body === null) {
        throw V2ApiError.invalidRequest();
      }
      const request = body as {
        readonly walletId?: unknown;
        readonly expectedActiveWalletId?: unknown;
      };
      const walletId = request.walletId;
      const expected = request.expectedActiveWalletId;
      if (
        !isOpaqueId(walletId) ||
        !(expected === null || isOpaqueId(expected))
      ) {
        throw V2ApiError.invalidRequest();
      }
      try {
        const records = await input.repository.setActive({
          ownerUserId: principal.userId,
          walletId,
          expectedActiveWalletId: expected,
        });
        return projectWalletList(records, now().toISOString());
      } catch (error) {
        if (error instanceof AccountWalletNotFoundError) {
          throw V2ApiError.notFound();
        }
        if (error instanceof AccountWalletVersionConflictError) {
          throw V2ApiError.versionConflict();
        }
        throw error;
      }
    },

    async getBalances({
      principal,
      walletId,
      signal,
    }: {
      readonly principal: AuthenticatedLoopPrincipal;
      readonly walletId: string;
      readonly signal: AbortSignal;
    }): Promise<WalletBalancesResource> {
      const wallet = await requireWallet(principal, walletId);
      const assets = await input.assetRegistry.listReadableAssets();

      let read: BscBalanceReadResult;
      try {
        read = await input.readClient.readBalances(
          wallet.address,
          assets.map((asset) => ({
            assetId: asset.assetId,
            address: asset.address,
          })),
        );
      } catch (error) {
        return chainUnavailable(error);
      }

      const confirmedThrough = subtractFloorZero(
        read.head.blockNumber,
        BigInt(input.readClient.confirmations),
      );
      const checkpoint = await input.indexerRepository.getCheckpoint(
        "erc20_transfer",
        input.chainId,
      );
      const pendingTotals =
        checkpoint === null
          ? null
          : await input.indexerRepository.sumPendingIncoming({
              chainId: input.chainId,
              address: wallet.address,
              assetIds: assets.map((asset) => asset.assetId),
              confirmedThroughBlockNumber: confirmedThrough.toString(10),
            });

      const nativeAsset = assets.find((asset) => asset.address === null);
      const nativeRaw =
        nativeAsset === undefined
          ? null
          : (read.balances.find(
              (balance) => balance.assetId === nativeAsset.assetId,
            )?.rawValue ?? null);
      const crossCheck = await crossCheckNative(
        wallet,
        nativeRaw,
        nativeAsset?.decimals ?? bscNativeDecimals,
        signal,
      );

      const balances: WalletBalanceProjection[] = [];
      for (const asset of assets) {
        const observed = read.balances.find(
          (balance) => balance.assetId === asset.assetId,
        );
        const rawValue = observed?.rawValue ?? null;
        const isNative = asset.address === null;
        const gasReserve = isNative ? input.gasReserveRawWei : 0n;
        const pendingRaw = pendingTotals?.find(
          (total) => total.assetId === asset.assetId,
        );

        let balance: WalletBalanceAmounts | UnavailableProjection;
        if (rawValue === null) {
          balance = unavailable(
            observed?.reasonCode ?? walletReasonCodes.balanceCallFailed,
          );
        } else {
          await recordSnapshot(asset, rawValue);
          balance = Object.freeze({
            status: "available" as const,
            rawValue: rawValue.toString(10),
            displayBalance: formatDecimalAmount(rawValue, asset.decimals),
            // Nothing locks a balance in this step, so available equals
            // display. Spendable additionally holds back the native gas
            // reserve, which is configured in wei.
            availableBalance: formatDecimalAmount(rawValue, asset.decimals),
            spendableBalance: formatDecimalAmount(
              subtractFloorZero(rawValue, gasReserve),
              asset.decimals,
            ),
            gasReserve: formatDecimalAmount(gasReserve, bscNativeDecimals),
          });
        }

        balances.push(
          Object.freeze({
            assetId: asset.assetId,
            symbol: asset.symbol,
            name: asset.name,
            decimals: asset.decimals,
            address: asset.address,
            balance,
            pending:
              pendingTotals === null
                ? unavailable(walletReasonCodes.indexerNotStarted)
                : Object.freeze({
                    status: "available" as const,
                    rawValue: pendingRaw?.rawValue ?? "0",
                    displayValue: formatDecimalAmount(
                      BigInt(pendingRaw?.rawValue ?? "0"),
                      asset.decimals,
                    ),
                  }),
            valuation: unavailable(walletReasonCodes.priceProviderMissing),
            crossCheck: Object.freeze({
              source: "privy" as const,
              status: isNative ? crossCheck.status : ("unavailable" as const),
              reasonCode: isNative
                ? crossCheck.reasonCode
                : walletReasonCodes.privyAssetMappingMissing,
              blockDelta: isNative ? crossCheck.blockDelta : null,
            }),
          }),
        );
      }

      return Object.freeze({
        walletId: wallet.walletId,
        snapshot: Object.freeze({
          blockNumber: read.head.blockNumber.toString(10),
          blockHash: read.head.blockHash,
          observedAt: read.head.observedAt,
          confirmations: input.readClient.confirmations,
        }),
        gasReservePolicy: Object.freeze({
          configVersion: walletGasReserveConfigVersion,
          nativeReserveRaw: input.gasReserveRawWei.toString(10),
          nativeReserve: formatDecimalAmount(
            input.gasReserveRawWei,
            bscNativeDecimals,
          ),
        }),
        balances: Object.freeze(balances),
        netWorth: unavailable(walletReasonCodes.priceProviderMissing),
        contractVersion: v2ContractVersion,
      });

      async function recordSnapshot(
        asset: AssetRecord,
        rawValue: bigint,
      ): Promise<void> {
        try {
          await input.repository.recordBalanceSnapshot({
            walletId: wallet.walletId,
            assetId: asset.assetId,
            blockNumber: read.head.blockNumber.toString(10),
            blockHash: read.head.blockHash,
            rawValue: rawValue.toString(10),
          });
        } catch {
          // The snapshot is an audit trail. Failing to persist it never
          // changes the observed on-chain fact returned to the caller.
        }
      }
    },

    async getActivity({
      principal,
      walletId,
      cursor,
      limit,
    }: {
      readonly principal: AuthenticatedLoopPrincipal;
      readonly walletId: string;
      readonly cursor?: unknown;
      readonly limit?: unknown;
    }): Promise<WalletActivityResource> {
      const wallet = await requireWallet(principal, walletId);
      const codec = input.cursorCodec;
      if (codec === null) {
        throw V2ApiError.capabilityUnavailable();
      }
      if (cursor !== undefined && limit !== undefined) {
        throw V2ApiError.invalidRequest();
      }
      const checkpoint = await input.indexerRepository.getCheckpoint(
        "erc20_transfer",
        input.chainId,
      );
      if (checkpoint === null) {
        throw V2ApiError.fromCode("INDEXING_DELAYED");
      }

      const filter = `wallet=${wallet.walletId}`;
      let pageSize: number = walletActivityLimits.default;
      let beforeBlockNumber: string | undefined;
      let beforeLogIndex: number | undefined;
      if (typeof cursor === "string") {
        let continuation;
        try {
          continuation = codec.decode({
            ownerId: principal.userId,
            route: activityCursorRoute,
            filter,
            cursor,
          });
        } catch (error) {
          if (error instanceof InvalidV2CursorError) {
            throw V2ApiError.invalidRequest();
          }
          throw error;
        }
        const block = continuation["block"];
        const log = continuation["log"];
        const size = continuation["limit"];
        if (
          typeof block !== "string" ||
          typeof log !== "number" ||
          typeof size !== "number"
        ) {
          throw V2ApiError.invalidRequest();
        }
        beforeBlockNumber = block;
        beforeLogIndex = log;
        pageSize = size;
      } else if (typeof limit === "number") {
        if (
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > walletActivityLimits.maximum
        ) {
          throw V2ApiError.invalidRequest();
        }
        pageSize = limit;
      }

      const assets = await input.assetRegistry.listReadableAssets();
      const page = await input.indexerRepository.listWalletTransfers({
        chainId: input.chainId,
        address: wallet.address,
        assetIds: assets.map((asset) => asset.assetId),
        limit: pageSize,
        ...(beforeBlockNumber === undefined ? {} : { beforeBlockNumber }),
        ...(beforeLogIndex === undefined ? {} : { beforeLogIndex }),
      });

      let headBlockNumber: bigint | null = null;
      try {
        headBlockNumber = (await input.readClient.getHead()).blockNumber;
      } catch {
        headBlockNumber = null;
      }
      const indexerBlock = BigInt(checkpoint.lastBlockNumber);
      const confirmations = input.readClient.confirmations;

      const items = page.items.map((transfer): WalletActivityItem => {
        const asset = assets.find(
          (candidate) => candidate.assetId === transfer.assetId,
        );
        const decimals = asset?.decimals ?? 0;
        const blockNumber = BigInt(transfer.blockNumber);
        const observedConfirmations =
          headBlockNumber === null
            ? null
            : Number(subtractFloorZero(headBlockNumber + 1n, blockNumber));
        const direction =
          transfer.fromAddress === wallet.address &&
          transfer.toAddress === wallet.address
            ? ("self" as const)
            : transfer.toAddress === wallet.address
              ? ("in" as const)
              : ("out" as const);
        return Object.freeze({
          assetId: transfer.assetId,
          symbol: asset?.symbol ?? "",
          decimals,
          direction,
          counterpartyAddress:
            direction === "in" ? transfer.fromAddress : transfer.toAddress,
          rawValue: transfer.rawValue,
          displayValue: formatDecimalAmount(
            BigInt(transfer.rawValue),
            decimals,
          ),
          transactionHash: transfer.transactionHash,
          logIndex: transfer.logIndex,
          blockNumber: transfer.blockNumber,
          blockHash: transfer.blockHash,
          confirmations: observedConfirmations,
          status: transfer.removed
            ? ("reorged" as const)
            : observedConfirmations !== null &&
                observedConfirmations >= confirmations
              ? ("confirmed" as const)
              : ("pending" as const),
          observedAt: transfer.observedAt,
        });
      });

      const last = page.items.at(-1);
      const nextCursor =
        page.hasMore && last !== undefined
          ? codec.encode({
              ownerId: principal.userId,
              route: activityCursorRoute,
              filter,
              continuation: {
                block: last.blockNumber,
                log: last.logIndex,
                limit: pageSize,
              },
            })
          : null;

      return Object.freeze({
        walletId: wallet.walletId,
        items: Object.freeze(items),
        nextCursor,
        freshness: Object.freeze({
          indexerBlockNumber: checkpoint.lastBlockNumber,
          headBlockNumber:
            headBlockNumber === null ? null : headBlockNumber.toString(10),
          lagBlocks:
            headBlockNumber === null
              ? null
              : Number(subtractFloorZero(headBlockNumber, indexerBlock)),
          observedAt: now().toISOString(),
        }),
        nativeTransfers: unavailable(
          walletReasonCodes.nativeTransfersUnsupported,
        ),
        crossChain: unavailable("CROSS_CHAIN_ACTIVITY_NOT_SUPPORTED"),
        contractVersion: v2ContractVersion,
      });
    },

    async getReceive({
      principal,
      walletId,
    }: {
      readonly principal: AuthenticatedLoopPrincipal;
      readonly walletId: string;
    }): Promise<WalletReceiveResource> {
      const wallet = await requireWallet(principal, walletId);
      return Object.freeze({
        walletId: wallet.walletId,
        // Only the chains LOOP actually supports are listed. An unsupported
        // network is not shown as an unavailable placeholder; it is absent.
        networks: Object.freeze([
          Object.freeze({
            chainId: input.chainId,
            name: input.chainName,
            address: wallet.address,
            uri: eip681Uri(wallet.address, input.chainReference),
            warningKey: "wallet.receive.bscOnly",
          }),
        ]),
        contractVersion: v2ContractVersion,
      });
    },
  });
}
