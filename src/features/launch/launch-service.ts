import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import {
  InvalidV2CursorError,
  type V2CursorCodec,
} from "../../core/http/v2-cursor.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import {
  InvalidLaunchRequestError,
  canonicalLaunchFilter,
  launchCommandDigest,
  launchConfigVersion,
  launchCursorRoutes,
  launchEligibilityModes,
  launchGraduationSteps,
  launchProjectDigestParts,
  launchProjectListFilters,
  launchReasonCodes,
  launchReviewReasonText,
  parseLaunchEnum,
  parseLaunchListLimit,
  parseLaunchOpaqueId,
  parseLaunchProjectValues,
  parseReplaceLaunchProjectRequest,
  launchContractReasonCodes,
  unavailable,
  unavailableOnChainState,
  unavailableOnChainStateFor,
  venueMilestoneTracks,
  type LaunchContractReasonCode,
  type LaunchEligibilityMode,
  type LaunchEligibilityTier,
  type LaunchGraduationStep,
  type LaunchOnChainStateAvailable,
  type LaunchOnChainStateProjection,
  type LaunchProjectListFilter,
  type LaunchProjectProjection,
  type LaunchReviewStatus,
  type LaunchScheduleStatus,
  type LaunchSummaryProjection,
  type UnavailableProjection,
} from "./launch-contract.js";
import {
  LaunchContractUnavailableError,
  isZeroBytes32,
  type LaunchContractAdapter,
  type LaunchContractRound,
  type LaunchContractSaleConfig,
} from "../../integrations/launch/launch-contract-adapter.js";
import type { AccountWalletRepository } from "../../database/account-wallet-repository.js";
import type {
  LaunchChainRepository,
  LaunchCheckpointRecord,
  LaunchStateProjectionRecord,
} from "./launch-chain-repository.js";
import {
  decideEligibility,
  launchEligibilityReasonCodes,
  tierForMember,
} from "./launch-eligibility.js";
import {
  prepareLaunchIntent,
  reportLaunchIntentBroadcast,
  type LaunchIntentResource,
  type LaunchIntentRuntime,
} from "./launch-intent-service.js";
import {
  LaunchDataStaleError,
  LaunchIdempotencyConflictError,
  LaunchNotFoundError,
  LaunchRepositoryUnavailableError,
  LaunchVersionConflictError,
  type LaunchCatalogRecord,
  type LaunchConfigRecord,
  type LaunchDetailRecord,
  type LaunchProjectRecord,
  type LaunchRecord,
  type LaunchRepository,
  type LaunchRoundRecord,
  type VenueMilestoneRecord,
} from "./launch-repository.js";

/**
 * Launch read/write service (Decision 0036). It publishes the off-chain
 * catalog and application flow and answers every on-chain question with the
 * four-axis `unavailable` projection. It never composes an Intent, a quote,
 * or a transaction.
 */

export interface LaunchServiceDependencies {
  readonly repository: LaunchRepository;
  readonly cursorCodec: V2CursorCodec | null;
  /**
   * Launch contract adapter (Decision 0076). Absent or unconfigured keeps
   * every on-chain slot byte-identical to Decision 0036.
   */
  readonly contract?: LaunchContractAdapter | null;
  /**
   * Launch chain facts (Decision 0077): the lane checkpoint and projections,
   * allowlist roots, and the Intent namespace. Absent keeps every chain slot
   * on its Decision 0076 reason.
   */
  readonly chain?: LaunchChainRepository | null;
  /** The caller's wallets (active wallet for position and eligibility). */
  readonly wallets?: AccountWalletRepository | null;
  /** Intent prepare runtime; absent keeps the Intent route 503. */
  readonly intentRuntime?: LaunchIntentRuntime | null;
  readonly now?: () => Date;
}

interface PrincipalInput {
  readonly principal: AuthenticatedLoopPrincipal;
}

interface CommandInput extends PrincipalInput {
  readonly idempotencyKey: string;
  readonly requestId: string;
}

export interface LaunchProjectResource {
  readonly project: LaunchProjectProjection;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface LaunchProjectListResource {
  readonly items: readonly LaunchProjectProjection[];
  readonly nextCursor: string | null;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface LaunchOverviewResource {
  readonly segments: {
    readonly live: readonly LaunchSummaryProjection[];
    readonly upcoming: readonly LaunchSummaryProjection[];
    /** Approved but not yet scheduled: its own segment, never "upcoming". */
    readonly awaitingSchedule: readonly LaunchSummaryProjection[];
    readonly ended: readonly LaunchSummaryProjection[];
  };
  readonly graduated: UnavailableProjection;
  readonly myEligibility: UnavailableProjection;
  readonly staking: UnavailableProjection;
  readonly catalog: {
    readonly configVersion: typeof launchConfigVersion;
    /** Where the catalog comes from: LOOP's own registry (Decision 0049). */
    readonly source: "loop";
    readonly observedAt: string;
  };
  readonly contractVersion: typeof v2ContractVersion;
}

export interface LaunchConfigProjection {
  readonly configVersion: string;
  readonly status: LaunchConfigRecord["status"];
  readonly effectiveAt: string | null;
  readonly slots: {
    readonly walletRoundCap:
      | UnavailableProjection
      | { readonly status: "confirmed"; readonly value: string };
    readonly walletProjectCap:
      | UnavailableProjection
      | { readonly status: "confirmed"; readonly value: string };
    readonly feeBps:
      | UnavailableProjection
      | { readonly status: "confirmed"; readonly value: string };
    readonly softCap:
      | UnavailableProjection
      | { readonly status: "confirmed"; readonly value: string };
    readonly hardCap:
      | UnavailableProjection
      | { readonly status: "confirmed"; readonly value: string };
    readonly tge:
      | UnavailableProjection
      | { readonly status: "confirmed"; readonly value: string };
    readonly vesting:
      | UnavailableProjection
      | { readonly status: "confirmed"; readonly value: string };
    readonly tierModeV1:
      | UnavailableProjection
      | { readonly status: "confirmed"; readonly value: string };
  };
}

/**
 * One round read from `getRounds` (Decision 0076). `roundIndex` is the
 * contract's `roundId` (uint16); `roundId` stays LOOP's opaque round ID, or
 * null when no `launch_rounds` row carries that index.
 */
export interface LaunchChainRoundProjection {
  readonly status: "available";
  readonly roundId: string | null;
  readonly roundIndex: number;
  readonly startAt: string;
  readonly endAt: string;
  readonly priceUsd1PerToken: string;
  readonly roundCapUsd1: string;
  readonly walletRoundCapUsd1: string;
  readonly allowlistRoot: string;
  readonly raisedUsd1: string;
}

/** `getSaleConfig` at the same block as the four axes (Decision 0076). */
export interface LaunchChainConfigProjection {
  readonly status: "available";
  readonly projectToken: string;
  readonly usd1: string;
  readonly softCapUsd1: string;
  readonly hardCapUsd1: string;
  readonly walletProjectCapUsd1: string;
  readonly minPurchaseUsd1: string;
  readonly protocolFeeBps: number;
  readonly liquidityBps: number;
  readonly tgeBps: number;
  readonly cliffSeconds: number;
  readonly vestingSeconds: number;
  readonly poolFeeTier: number;
  readonly lpLockSeconds: number;
  readonly configVersion: string;
}

export interface LaunchRoundProjection {
  readonly roundId: string;
  readonly roundIndex: number;
  readonly configVersion: string;
  readonly status: LaunchRoundRecord["status"];
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly priceUsd1: string | null;
  readonly eligibilityTier: LaunchRoundRecord["eligibilityTier"];
  readonly walletRoundCapRaw: string | null;
}

export interface LaunchDetailResource {
  readonly launch: LaunchSummaryProjection;
  readonly project: {
    readonly projectId: string;
    readonly name: string;
    readonly ticker: string;
    readonly narrative: string | null;
    readonly officialLinks: LaunchProjectProjection["officialLinks"];
    readonly materialVersion: number;
  };
  readonly config: LaunchConfigProjection | LaunchChainConfigProjection | null;
  readonly configPending: UnavailableProjection | null;
  readonly rounds: readonly (
    LaunchRoundProjection | LaunchChainRoundProjection
  )[];
  readonly graduation: {
    readonly steps: readonly {
      readonly step: LaunchGraduationStep;
      readonly status: "pending";
    }[];
    readonly poolEvidence: UnavailableProjection;
  };
  readonly market: UnavailableProjection;
  readonly holders: UnavailableProjection;
  readonly contractVersion: typeof v2ContractVersion;
}

export type LaunchEligibilityResult =
  | {
      readonly tier: null;
      readonly reasonCode: string;
      readonly snapshotBlock: null;
    }
  | {
      readonly status: "available";
      readonly tier: LaunchEligibilityTier | null;
      readonly reasonCode: string | null;
      readonly snapshotBlock: string;
      readonly roundIndex: number;
      readonly allowlistRoot: string;
      readonly eligibilityProof: readonly string[];
    };

export interface LaunchEligibilityResource {
  readonly launchId: string;
  readonly mode: LaunchEligibilityMode;
  readonly result: LaunchEligibilityResult;
  readonly configVersion: string | null;
  readonly effectiveAt: string | null;
  readonly dependsOnStaking: false;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface LaunchHoldersResource {
  readonly launchId: string;
  readonly holders:
    | UnavailableProjection
    | {
        readonly status: "available";
        readonly holderCount: number;
        readonly indexedBlockNumber: string;
      };
  readonly myPosition: UnavailableProjection | Record<string, unknown>;
  readonly walletCap: UnavailableProjection | Record<string, unknown>;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface LaunchHistoryResource {
  readonly launchId: string;
  readonly purchaseRecords: readonly unknown[];
  readonly entitlements: readonly unknown[];
  readonly refunds: readonly unknown[];
  readonly source:
    | UnavailableProjection
    | {
        readonly status: "available";
        readonly indexedBlockNumber: string;
        readonly indexedBlockHash: string;
      };
  readonly contractVersion: typeof v2ContractVersion;
}

export interface VenueMilestoneProjection {
  /** `null` for an implicit `PREPARING` row (no stored record yet). */
  readonly venueMilestoneId: string | null;
  readonly venue: VenueMilestoneRecord["venue"];
  readonly marketType: VenueMilestoneRecord["marketType"];
  readonly state: VenueMilestoneRecord["state"];
  readonly evidence: {
    readonly digest: string | null;
    readonly recordedAt: string | null;
    readonly observedAt: string | null;
    readonly reviewer: string | null;
  };
  /** 0 for an implicit `PREPARING` row. */
  readonly version: number;
  /** `null` for an implicit `PREPARING` row. */
  readonly updatedAt: string | null;
}

export interface LaunchMilestonesResource {
  readonly projectId: string;
  readonly items: readonly VenueMilestoneProjection[];
  readonly contractVersion: typeof v2ContractVersion;
}

export interface LaunchStakeResource {
  readonly stake: UnavailableProjection;
  readonly executable: false;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface LaunchEconomyResource {
  readonly projects: Readonly<Record<LaunchReviewStatus, number>>;
  readonly launches: Readonly<Record<LaunchScheduleStatus, number>>;
  readonly confirmedRoundCount: number;
  readonly totalSupply: UnavailableProjection;
  readonly distributed: UnavailableProjection;
  readonly ecosystemTax: UnavailableProjection;
  /**
   * Provable on-chain counts from the `launch_event` lane (Decision 0077);
   * present only while a Launch contract is configured.
   */
  readonly onChain?:
    | UnavailableProjection
    | {
        readonly status: "available";
        readonly registeredSaleCount: number;
        readonly totalRaisedUsd1: string;
        readonly lockedLpCount: number;
        readonly source: "loop_indexer";
        readonly indexedBlockNumber: string;
        readonly indexedBlockHash: string;
      };
  /** Where the counts come from: LOOP's own ledger (Decision 0049). */
  readonly source: "loop";
  readonly observedAt: string;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface LaunchService {
  getOverview(): Promise<LaunchOverviewResource>;
  listProjects(
    input: PrincipalInput & {
      readonly status?: unknown;
      readonly cursor?: unknown;
      readonly limit?: unknown;
    },
  ): Promise<LaunchProjectListResource>;
  createProject(
    input: CommandInput & { readonly body: unknown },
  ): Promise<LaunchProjectResource>;
  getProject(
    input: PrincipalInput & { readonly projectId: string },
  ): Promise<LaunchProjectResource>;
  replaceProject(
    input: PrincipalInput & {
      readonly projectId: string;
      readonly body: unknown;
      readonly requestId: string;
    },
  ): Promise<LaunchProjectResource>;
  submitProject(
    input: CommandInput & { readonly projectId: string },
  ): Promise<LaunchProjectResource>;
  getLaunch(input: {
    readonly launchId: string;
  }): Promise<LaunchDetailResource>;
  getEligibility(
    input: PrincipalInput & {
      readonly launchId: string;
      readonly roundIndex?: unknown;
    },
  ): Promise<LaunchEligibilityResource>;
  getHolders(
    input: PrincipalInput & { readonly launchId: string },
  ): Promise<LaunchHoldersResource>;
  getHistory(
    input: PrincipalInput & { readonly launchId: string },
  ): Promise<LaunchHistoryResource>;
  getMilestones(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly projectId: string;
  }): Promise<LaunchMilestonesResource>;
  /**
   * Launch purchase Intent prepare (Decision 0077). CAPABILITY_UNAVAILABLE,
   * byte for byte as before, while BSC_WRITES_ENABLED is off or the contract
   * keys are blank.
   */
  prepareIntent(
    input: CommandInput & {
      readonly launchId: string;
      readonly body: unknown;
    },
  ): Promise<{
    readonly created: boolean;
    readonly resource: LaunchIntentResource;
  }>;
  /** Device broadcast report of a prepared Intent (Decision 0077). */
  reportIntent(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly launchId: string;
    readonly launchIntentId: string;
    readonly body: unknown;
  }): Promise<LaunchIntentResource>;
  getStake(): LaunchStakeResource;
  getEconomy(): Promise<LaunchEconomyResource>;
}

function translate(error: unknown): never {
  if (error instanceof V2ApiError) {
    throw error;
  }
  if (error instanceof InvalidLaunchRequestError) {
    throw V2ApiError.invalidRequest();
  }
  if (error instanceof InvalidV2CursorError) {
    throw V2ApiError.invalidRequest();
  }
  if (error instanceof LaunchNotFoundError) {
    throw V2ApiError.notFound();
  }
  if (error instanceof LaunchVersionConflictError) {
    throw V2ApiError.versionConflict();
  }
  if (error instanceof LaunchDataStaleError) {
    throw V2ApiError.fromCode("DATA_STALE");
  }
  if (error instanceof LaunchIdempotencyConflictError) {
    throw V2ApiError.idempotencyConflict();
  }
  if (error instanceof LaunchRepositoryUnavailableError) {
    throw V2ApiError.capabilityUnavailable();
  }
  throw error;
}

/**
 * Public projection. A non-owner only sees an approved project and never its
 * review trail or compare-and-swap version (those are the applicant's).
 */
function projectProjection(
  record: LaunchProjectRecord,
  viewer: "owner" | "public" = "owner",
): LaunchProjectProjection {
  const owner = viewer === "owner";
  return Object.freeze({
    projectId: record.projectId,
    name: record.name,
    ticker: record.ticker,
    narrative: record.narrative,
    officialLinks: record.officialLinks,
    materialVersion: record.materialVersion,
    reviewStatus: record.reviewStatus,
    reviewReasonCode: owner ? record.reviewReasonCode : null,
    reviewReasonText: owner
      ? launchReviewReasonText(record.reviewStatus, record.reviewReasonCode)
      : null,
    kyb: Object.freeze({
      status: "unavailable" as const,
      state: record.kybStatus,
      reasonCode: launchReasonCodes.kybProviderNotSelected,
    }),
    attachments: unavailable(launchReasonCodes.attachmentStorageNotSelected),
    submittedAt: owner ? record.submittedAt : null,
    reviewedAt: owner ? record.reviewedAt : null,
    launchId: record.launchId,
    version: owner ? record.version : null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    configVersion: launchConfigVersion,
  });
}

function summaryProjection(
  record: LaunchCatalogRecord,
  onChainState: LaunchOnChainStateProjection,
  contractAddress: string | null,
): LaunchSummaryProjection {
  return Object.freeze({
    launchId: record.launch.launchId,
    projectId: record.launch.projectId,
    name: record.projectName,
    ticker: record.projectTicker,
    chainId: record.launch.chainId,
    contractAddress,
    configDigest: record.launch.configDigest,
    scheduleStatus: record.launch.scheduleStatus,
    onChainState,
    configVersion: record.confirmedConfigVersion,
    createdAt: record.launch.createdAt,
  });
}

function configSlot(
  config: LaunchConfigRecord,
  key: keyof LaunchConfigProjection["slots"],
):
  | UnavailableProjection
  | { readonly status: "confirmed"; readonly value: string } {
  const value = config.parameters[key];
  if (
    config.status === "confirmed" &&
    typeof value === "string" &&
    value !== ""
  ) {
    return Object.freeze({ status: "confirmed" as const, value });
  }
  return unavailable(launchReasonCodes.configPendingConfirmation);
}

function configProjection(config: LaunchConfigRecord): LaunchConfigProjection {
  return Object.freeze({
    configVersion: config.configVersion,
    status: config.status,
    effectiveAt: config.effectiveAt,
    slots: Object.freeze({
      walletRoundCap: configSlot(config, "walletRoundCap"),
      walletProjectCap: configSlot(config, "walletProjectCap"),
      feeBps: configSlot(config, "feeBps"),
      softCap: configSlot(config, "softCap"),
      hardCap: configSlot(config, "hardCap"),
      tge: configSlot(config, "tge"),
      vesting: configSlot(config, "vesting"),
      tierModeV1: configSlot(config, "tierModeV1"),
    }),
  });
}

function roundProjection(round: LaunchRoundRecord): LaunchRoundProjection {
  return Object.freeze({
    roundId: round.roundId,
    roundIndex: round.roundIndex,
    configVersion: round.configVersion,
    status: round.status,
    startsAt: round.startsAt,
    endsAt: round.endsAt,
    priceUsd1: round.priceUsd1,
    eligibilityTier: round.eligibilityTier,
    walletRoundCapRaw: round.walletRoundCapRaw,
  });
}

function milestoneProjection(
  record: VenueMilestoneRecord,
): VenueMilestoneProjection {
  return Object.freeze({
    venueMilestoneId: record.venueMilestoneId,
    venue: record.venue,
    marketType: record.marketType,
    state: record.state,
    evidence: Object.freeze({
      digest: record.evidenceDigest,
      recordedAt: record.evidenceRecordedAt,
      observedAt: record.evidenceObservedAt,
      reviewer: record.reviewer,
    }),
    version: record.version,
    updatedAt: record.updatedAt,
  });
}

/**
 * Every 03 §8.4 track, stored rows first (newest update first, as the
 * repository orders them) and an implicit `PREPARING` row for each track
 * that has no record yet (S7 finding 2). Nothing is written.
 */
function milestoneRows(
  records: readonly VenueMilestoneRecord[],
): readonly VenueMilestoneProjection[] {
  const stored = records.map(milestoneProjection);
  const implicit = venueMilestoneTracks
    .filter(
      (track) =>
        !records.some(
          (record) =>
            record.venue === track.venue &&
            record.marketType === track.marketType,
        ),
    )
    .map((track): VenueMilestoneProjection =>
      Object.freeze({
        venueMilestoneId: null,
        venue: track.venue,
        marketType: track.marketType,
        state: "PREPARING",
        evidence: Object.freeze({
          digest: null,
          recordedAt: null,
          observedAt: null,
          reviewer: null,
        }),
        version: 0,
        updatedAt: null,
      }),
    );
  return Object.freeze([...stored, ...implicit]);
}

/** The confirmed config, or the newest pending one when nothing is confirmed. */
function selectConfig(detail: LaunchDetailRecord): {
  readonly config: LaunchConfigRecord | null;
  readonly pending: boolean;
} {
  const confirmed = detail.configs.find(
    (config) => config.status === "confirmed",
  );
  if (confirmed !== undefined) {
    return { config: confirmed, pending: false };
  }
  return { config: detail.configs[0] ?? null, pending: true };
}

function eligibilityMode(
  config: LaunchConfigRecord | null,
): LaunchEligibilityMode {
  if (config === null || config.status !== "confirmed") {
    return "unavailable";
  }
  const mode = config.parameters["tierModeV1"];
  return typeof mode === "string" &&
    launchEligibilityModes.includes(mode as LaunchEligibilityMode) &&
    mode !== "unavailable"
    ? (mode as LaunchEligibilityMode)
    : "unavailable";
}

function parseRoundIndexQuery(value: unknown): number | null {
  if (value === undefined) {
    return null;
  }
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^(0|[1-9][0-9]{0,4})$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw V2ApiError.invalidRequest();
  }
  return parsed;
}

/** Largest unix second `Date` can represent (year 275760). */
const maximumUnixSeconds = 8_640_000_000_000n;

function unixSecondsToIso(seconds: bigint): string {
  if (seconds < 0n || seconds > maximumUnixSeconds) {
    throw new LaunchContractUnavailableError(
      launchContractReasonCodes.readInvalid,
    );
  }
  return new Date(Number(seconds) * 1_000).toISOString();
}

function chainRoundProjection(
  round: LaunchContractRound,
  offChainRounds: readonly LaunchRoundRecord[],
): LaunchChainRoundProjection {
  const match = offChainRounds.find(
    (candidate) => candidate.roundIndex === round.roundId,
  );
  return Object.freeze({
    status: "available" as const,
    roundId: match?.roundId ?? null,
    roundIndex: round.roundId,
    startAt: unixSecondsToIso(round.startAt),
    endAt: unixSecondsToIso(round.endAt),
    priceUsd1PerToken: round.priceUsd1PerToken.toString(),
    roundCapUsd1: round.roundCapUsd1.toString(),
    walletRoundCapUsd1: round.walletRoundCapUsd1.toString(),
    allowlistRoot: round.allowlistRoot,
    raisedUsd1: round.raisedUsd1.toString(),
  });
}

function chainConfigProjection(
  config: LaunchContractSaleConfig,
): LaunchChainConfigProjection {
  return Object.freeze({
    status: "available" as const,
    projectToken: config.projectToken,
    usd1: config.usd1,
    softCapUsd1: config.softCapUsd1.toString(),
    hardCapUsd1: config.hardCapUsd1.toString(),
    walletProjectCapUsd1: config.walletProjectCapUsd1.toString(),
    minPurchaseUsd1: config.minPurchaseUsd1.toString(),
    protocolFeeBps: config.protocolFeeBps,
    liquidityBps: config.liquidityBps,
    tgeBps: config.tgeBps,
    cliffSeconds: config.cliffSeconds,
    vestingSeconds: config.vestingSeconds,
    poolFeeTier: config.poolFeeTier,
    lpLockSeconds: config.lpLockSeconds,
    configVersion: config.configVersion,
  });
}

type ChainReadOutcome =
  | {
      readonly status: "available";
      readonly onChainState: LaunchOnChainStateAvailable;
      readonly rounds: readonly LaunchChainRoundProjection[];
      readonly config: LaunchChainConfigProjection;
    }
  | {
      readonly status: "unavailable";
      readonly reasonCode: LaunchContractReasonCode;
    };

export function createLaunchService(
  dependencies: LaunchServiceDependencies,
): LaunchService {
  const { repository } = dependencies;
  const contract = dependencies.contract ?? null;
  const chain = dependencies.chain ?? null;
  const wallets = dependencies.wallets ?? null;
  const intentRuntime = dependencies.intentRuntime ?? null;
  const now = dependencies.now ?? ((): Date => new Date());

  /** The lane checkpoint of the launch chain, or null (never throws). */
  async function readCheckpoint(): Promise<LaunchCheckpointRecord | null> {
    if (chain === null || contract === null || contract.contract === null) {
      return null;
    }
    try {
      return await chain.getCheckpoint(contract.chainId);
    } catch {
      return null;
    }
  }

  async function activeWallet(
    principal: AuthenticatedLoopPrincipal,
  ): Promise<{ readonly walletId: string; readonly address: string } | null> {
    if (wallets === null) {
      return null;
    }
    const list = await wallets.list(principal.userId);
    return (
      list.find((wallet) => wallet.isActive && wallet.status === "active") ??
      null
    );
  }

  /** Why the chain cannot be read for this launch, or null (probes). */
  async function chainReason(
    launch: LaunchRecord,
  ): Promise<LaunchContractReasonCode | null> {
    const refused = registryReason(launch);
    if (contract === null || refused !== null) {
      return refused ?? launchContractReasonCodes.baselinePending;
    }
    const state = await contract.availability();
    return state.status === "unavailable" ? state.reasonCode : null;
  }

  /**
   * Why this launch's sale cannot be read, from configuration and the
   * registry alone; null when the adapter may be asked.
   */
  function registryReason(
    launch: LaunchRecord,
  ): LaunchContractReasonCode | null {
    const configured = contract?.contract ?? null;
    if (configured === null) {
      return launchContractReasonCodes.baselinePending;
    }
    if (launch.saleId === null) {
      return launchContractReasonCodes.saleNotRegistered;
    }
    if (
      launch.contractAddress !== configured.address ||
      launch.contractVersion !== configured.version
    ) {
      return launchContractReasonCodes.saleContractMismatch;
    }
    return null;
  }

  /** The address is published only for a registered sale on a verified contract. */
  function publishedContractAddress(launch: LaunchRecord): string | null {
    if (
      contract === null ||
      registryReason(launch) !== null ||
      contract.currentAvailability().status !== "available"
    ) {
      return null;
    }
    return launch.contractAddress;
  }

  /**
   * Lists never read the chain (200 launches would be 600 calls); the S83b
   * event lane projects the axes into `launches`. Until then a list says why.
   */
  function listOnChainState(
    launch: LaunchRecord,
    checkpoint: LaunchCheckpointRecord | null,
    projections: ReadonlyMap<string, LaunchStateProjectionRecord>,
  ): LaunchOnChainStateProjection {
    if (contract === null) {
      return unavailableOnChainState;
    }
    const state = contract.currentAvailability();
    if (state.status === "unavailable") {
      return unavailableOnChainStateFor(state.reasonCode);
    }
    const refused = registryReason(launch);
    if (refused !== null) {
      return unavailableOnChainStateFor(refused);
    }
    // Decision 0077: lists read the lane's projection, never the chain.
    if (checkpoint === null) {
      return unavailableOnChainStateFor(
        launchContractReasonCodes.onChainStateNotIndexed,
      );
    }
    const projection = projections.get(launch.launchId);
    if (projection === undefined) {
      return unavailableOnChainStateFor(
        launchContractReasonCodes.onChainStateNotProjected,
      );
    }
    return Object.freeze({
      saleState: projection.saleState,
      entitlementState: projection.entitlementState,
      liquidityState: projection.liquidityState,
      operationalState: projection.operationalState,
      stateTupleDigest: projection.stateTupleDigest,
      snapshotBlockNumber: projection.snapshotBlockNumber,
      snapshotBlockHash: projection.snapshotBlockHash,
      configVersion: projection.configVersion,
      source: "chain" as const,
      reasonCode: null,
    });
  }

  /**
   * Four axes, rounds, and configuration at one block (Decision 0076). Every
   * failure is a reason code; nothing is defaulted or inferred.
   */
  async function readChain(
    detail: LaunchDetailRecord,
  ): Promise<ChainReadOutcome> {
    const refused = registryReason(detail.launch);
    if (contract === null || refused !== null) {
      return {
        status: "unavailable",
        reasonCode: refused ?? launchContractReasonCodes.baselinePending,
      };
    }
    const state = await contract.availability();
    if (state.status === "unavailable") {
      return { status: "unavailable", reasonCode: state.reasonCode };
    }
    const saleId = BigInt(detail.launch.saleId as string);
    try {
      const snapshot = await contract.takeSnapshot();
      const [tuple, rounds, config] = await Promise.all([
        contract.getState(saleId, snapshot),
        contract.getRounds(saleId, snapshot),
        contract.getSaleConfig(saleId, snapshot),
      ]);
      await contract.confirmSnapshot(snapshot);
      if (isZeroBytes32(tuple.value.configVersion)) {
        return {
          status: "unavailable",
          reasonCode: launchContractReasonCodes.saleNotFound,
        };
      }
      if (
        tuple.value.configVersion !== config.value.configVersion ||
        (detail.launch.configVersionOnchain !== null &&
          detail.launch.configVersionOnchain !== tuple.value.configVersion)
      ) {
        return {
          status: "unavailable",
          reasonCode: launchContractReasonCodes.configVersionMismatch,
        };
      }
      if (config.value.usd1 !== contract.contract?.usd1Address) {
        return {
          status: "unavailable",
          reasonCode: launchContractReasonCodes.usd1AddressMismatch,
        };
      }
      return {
        status: "available",
        onChainState: Object.freeze({
          saleState: tuple.value.saleState,
          entitlementState: tuple.value.entitlementState,
          liquidityState: tuple.value.liquidityState,
          operationalState: tuple.value.operationalState,
          stateTupleDigest: tuple.value.stateTupleDigest,
          snapshotBlockNumber: snapshot.blockNumber.toString(),
          snapshotBlockHash: snapshot.blockHash,
          configVersion: tuple.value.configVersion,
          source: "chain" as const,
          reasonCode: null,
        }),
        rounds: Object.freeze(
          rounds.value.map((round) =>
            chainRoundProjection(round, detail.rounds),
          ),
        ),
        config: chainConfigProjection(config.value),
      };
    } catch (error) {
      if (error instanceof LaunchContractUnavailableError) {
        return { status: "unavailable", reasonCode: error.reasonCode };
      }
      return {
        status: "unavailable",
        reasonCode: launchContractReasonCodes.readFailed,
      };
    }
  }

  async function economyOnChain(): Promise<NonNullable<
    LaunchEconomyResource["onChain"]
  > | null> {
    const configured = contract?.contract ?? null;
    if (contract === null || configured === null) {
      return null;
    }
    const checkpoint = await readCheckpoint();
    if (checkpoint === null || chain === null) {
      return unavailable(launchContractReasonCodes.onChainStateNotIndexed);
    }
    const counts = await chain.getEconomyChain({
      chainId: contract.chainId,
      contractAddress: configured.address,
      contractVersion: configured.version,
    });
    return Object.freeze({
      status: "available" as const,
      registeredSaleCount: counts.registeredSaleCount,
      totalRaisedUsd1: counts.totalRaisedUsd1,
      lockedLpCount: counts.lockedLpCount,
      source: "loop_indexer" as const,
      indexedBlockNumber: checkpoint.lastBlockNumber,
      indexedBlockHash: checkpoint.lastBlockHash,
    });
  }

  /**
   * `getPosition` and the wallet caps at one snapshot (06 §4.2): the caller's
   * active wallet, `getSaleConfig`, `getRounds`, and `getRoundPosition` per
   * round. Any failure is the named reason on both blocks.
   */
  async function readPosition(
    detail: LaunchDetailRecord,
    principal: AuthenticatedLoopPrincipal,
  ): Promise<{
    readonly myPosition: UnavailableProjection | Record<string, unknown>;
    readonly walletCap: UnavailableProjection | Record<string, unknown>;
  }> {
    const wallet = await activeWallet(principal);
    if (wallet === null || contract === null) {
      const missing = unavailable(launchContractReasonCodes.walletNotFound);
      return { myPosition: missing, walletCap: missing };
    }
    const saleId = BigInt(detail.launch.saleId as string);
    try {
      const snapshot = await contract.takeSnapshot();
      const [state, config, rounds, position] = await Promise.all([
        contract.getState(saleId, snapshot),
        contract.getSaleConfig(saleId, snapshot),
        contract.getRounds(saleId, snapshot),
        contract.getPosition({ saleId, wallet: wallet.address }, snapshot),
      ]);
      const perRound = await Promise.all(
        rounds.value.map((round) =>
          contract.getRoundPosition(
            { saleId, roundId: round.roundId, wallet: wallet.address },
            snapshot,
          ),
        ),
      );
      await contract.confirmSnapshot(snapshot);
      if (isZeroBytes32(state.value.configVersion)) {
        const missing = unavailable(launchContractReasonCodes.saleNotFound);
        return { myPosition: missing, walletCap: missing };
      }
      const block = {
        snapshotBlockNumber: snapshot.blockNumber.toString(),
        snapshotBlockHash: snapshot.blockHash,
      };
      return {
        myPosition: Object.freeze({
          status: "available" as const,
          walletId: wallet.walletId,
          cumulativeUsd1: position.value.cumulativeUsd1.toString(),
          purchasedTokens: position.value.purchasedTokens.toString(),
          entitledTokens: position.value.entitledTokens.toString(),
          claimableTokens: position.value.claimableTokens.toString(),
          claimedTokens: position.value.claimedTokens.toString(),
          refundableUsd1: position.value.refundableUsd1.toString(),
          refundedUsd1: position.value.refundedUsd1.toString(),
          ...block,
        }),
        walletCap: Object.freeze({
          status: "available" as const,
          walletProjectCapUsd1: config.value.walletProjectCapUsd1.toString(),
          rounds: Object.freeze(
            rounds.value.map((round, index) =>
              Object.freeze({
                roundIndex: round.roundId,
                walletRoundCapUsd1: round.walletRoundCapUsd1.toString(),
                cumulativeUsd1: (perRound[index]?.value ?? 0n).toString(),
              }),
            ),
          ),
          ...block,
        }),
      };
    } catch (error) {
      const reason =
        error instanceof LaunchContractUnavailableError
          ? error.reasonCode
          : launchContractReasonCodes.readFailed;
      return {
        myPosition: unavailable(reason),
        walletCap: unavailable(reason),
      };
    }
  }

  /**
   * One round's eligibility for the caller's active wallet (Decision 0077):
   * the chain's `allowlistRoot` at one snapshot selects the stored set.
   */
  async function evaluateEligibility(
    detail: LaunchDetailRecord,
    mode: Exclude<LaunchEligibilityMode, "unavailable">,
    principal: AuthenticatedLoopPrincipal,
    requestedRound: number | null,
  ): Promise<LaunchEligibilityResult> {
    const refusedResult = (reasonCode: string): LaunchEligibilityResult =>
      Object.freeze({ tier: null, reasonCode, snapshotBlock: null });
    const reason = await chainReason(detail.launch);
    if (reason !== null || contract === null) {
      return refusedResult(reason ?? launchContractReasonCodes.baselinePending);
    }
    const wallet = await activeWallet(principal);
    if (wallet === null) {
      return refusedResult(launchContractReasonCodes.walletNotFound);
    }
    const saleId = BigInt(detail.launch.saleId as string);
    const snapshot = await contract.takeSnapshot();
    const rounds = await contract.getRounds(saleId, snapshot);
    await contract.confirmSnapshot(snapshot);
    const nowSeconds = BigInt(Math.floor(now().getTime() / 1000));
    const round =
      requestedRound !== null
        ? rounds.value.find((item) => item.roundId === requestedRound)
        : (rounds.value.find(
            (item) => item.startAt <= nowSeconds && nowSeconds < item.endAt,
          ) ??
          rounds.value.find((item) => item.startAt > nowSeconds) ??
          rounds.value.at(-1));
    if (round === undefined) {
      return refusedResult(launchEligibilityReasonCodes.roundNotFound);
    }
    const roots =
      chain === null
        ? []
        : await chain.listAllowlistRoots(detail.launch.launchId, round.roundId);
    const decision = decideEligibility({
      chainRoot: round.allowlistRoot,
      roots,
      mode,
      walletAddress: wallet.address,
    });
    const offChainRound = detail.rounds.find(
      (item) => item.roundIndex === round.roundId,
    );
    const roundTier = offChainRound?.eligibilityTier ?? null;
    switch (decision.status) {
      case "refused": {
        return refusedResult(decision.reasonCode);
      }
      case "open": {
        return Object.freeze({
          status: "available" as const,
          tier: roundTier ?? ("public" as const),
          reasonCode: null,
          snapshotBlock: snapshot.blockNumber.toString(),
          roundIndex: round.roundId,
          allowlistRoot: round.allowlistRoot,
          eligibilityProof: Object.freeze([]),
        });
      }
      case "member": {
        return Object.freeze({
          status: "available" as const,
          tier: tierForMember(mode, roundTier),
          reasonCode: null,
          snapshotBlock: decision.root.snapshotBlock,
          roundIndex: round.roundId,
          allowlistRoot: round.allowlistRoot,
          eligibilityProof: decision.proof,
        });
      }
      case "not_member": {
        return Object.freeze({
          status: "available" as const,
          tier: null,
          reasonCode: launchEligibilityReasonCodes.walletNotEligible,
          snapshotBlock: decision.root.snapshotBlock,
          roundIndex: round.roundId,
          allowlistRoot: round.allowlistRoot,
          eligibilityProof: Object.freeze([]),
        });
      }
    }
  }

  function requireCursorCodec(): V2CursorCodec {
    if (dependencies.cursorCodec === null) {
      throw V2ApiError.capabilityUnavailable();
    }
    return dependencies.cursorCodec;
  }

  async function requireVisibleProject(
    principal: AuthenticatedLoopPrincipal,
    projectId: string,
  ): Promise<LaunchProjectRecord> {
    const project = await repository.getProject(parseLaunchOpaqueId(projectId));
    if (
      project === null ||
      (project.ownerUserId !== principal.userId &&
        project.reviewStatus !== "approved")
    ) {
      throw V2ApiError.notFound();
    }
    return project;
  }

  async function requireLaunch(launchId: string): Promise<LaunchDetailRecord> {
    const detail = await repository.getLaunch(parseLaunchOpaqueId(launchId));
    if (detail === null) {
      throw V2ApiError.notFound();
    }
    return detail;
  }

  return Object.freeze({
    async getOverview() {
      try {
        const launches = await repository.listLaunches();
        const checkpoint = await readCheckpoint();
        let projections: ReadonlyMap<string, LaunchStateProjectionRecord> =
          new Map();
        if (checkpoint !== null && chain !== null) {
          try {
            projections = await chain.listStateProjections(
              launches.map((record) => record.launch.launchId),
            );
          } catch {
            projections = new Map();
          }
        }
        const summaries = launches.map((record) =>
          summaryProjection(
            record,
            listOnChainState(record.launch, checkpoint, projections),
            publishedContractAddress(record.launch),
          ),
        );
        return Object.freeze({
          segments: Object.freeze({
            live: Object.freeze(
              summaries.filter((launch) => launch.scheduleStatus === "live"),
            ),
            upcoming: Object.freeze(
              summaries.filter(
                (launch) => launch.scheduleStatus === "scheduled",
              ),
            ),
            awaitingSchedule: Object.freeze(
              summaries.filter(
                (launch) => launch.scheduleStatus === "unscheduled",
              ),
            ),
            ended: Object.freeze(
              summaries.filter((launch) => launch.scheduleStatus === "ended"),
            ),
          }),
          // "Graduated" is a projection of the liquidity axis, which has no
          // contract baseline; it is never derived from scheduleStatus.
          graduated: unavailable(launchReasonCodes.contractBaselinePending),
          myEligibility: unavailable(launchReasonCodes.tierModePending),
          staking: unavailable(launchReasonCodes.stakingContractPending),
          catalog: Object.freeze({
            configVersion: launchConfigVersion,
            source: "loop" as const,
            observedAt: now().toISOString(),
          }),
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async listProjects(input: Parameters<LaunchService["listProjects"]>[0]) {
      try {
        const codec = requireCursorCodec();
        const status = parseLaunchEnum<LaunchProjectListFilter>(
          input.status,
          launchProjectListFilters,
          "all",
        );
        const filter = canonicalLaunchFilter({ status });
        let limit: number;
        let after: {
          readonly createdAt: string;
          readonly projectId: string;
        } | null = null;
        if (input.cursor !== undefined) {
          if (input.limit !== undefined || typeof input.cursor !== "string") {
            throw V2ApiError.invalidRequest();
          }
          const decoded = codec.decode({
            ownerId: input.principal.userId,
            route: launchCursorRoutes.projects,
            filter,
            cursor: input.cursor,
          });
          const createdAt = decoded["createdAt"];
          const projectId = decoded["projectId"];
          const pageSize = decoded["limit"];
          if (
            typeof createdAt !== "string" ||
            typeof projectId !== "string" ||
            typeof pageSize !== "number"
          ) {
            throw V2ApiError.invalidRequest();
          }
          after = { createdAt, projectId: parseLaunchOpaqueId(projectId) };
          limit = parseLaunchListLimit(pageSize);
        } else {
          limit = parseLaunchListLimit(input.limit);
        }
        const rows = await repository.listProjects({
          ownerUserId: input.principal.userId,
          status: status === "all" ? null : status,
          limit: limit + 1,
          after,
        });
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        const nextCursor =
          rows.length > limit && last !== undefined
            ? codec.encode({
                ownerId: input.principal.userId,
                route: launchCursorRoutes.projects,
                filter,
                continuation: {
                  createdAt: last.createdAt,
                  projectId: last.projectId,
                  limit,
                },
              })
            : null;
        return Object.freeze({
          items: Object.freeze(page.map((record) => projectProjection(record))),
          nextCursor,
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async createProject(input: Parameters<LaunchService["createProject"]>[0]) {
      try {
        const values = parseLaunchProjectValues(input.body);
        const record = await repository.createProject({
          ownerUserId: input.principal.userId,
          idempotencyKey: input.idempotencyKey,
          requestSha256: launchCommandDigest(
            "createProject",
            launchProjectDigestParts(values),
          ),
          requestId: input.requestId,
          values,
        });
        return Object.freeze({
          project: projectProjection(record),
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async getProject(input: Parameters<LaunchService["getProject"]>[0]) {
      try {
        const record = await requireVisibleProject(
          input.principal,
          input.projectId,
        );
        return Object.freeze({
          project: projectProjection(
            record,
            record.ownerUserId === input.principal.userId ? "owner" : "public",
          ),
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async replaceProject(
      input: Parameters<LaunchService["replaceProject"]>[0],
    ) {
      try {
        const request = parseReplaceLaunchProjectRequest(input.body);
        const record = await repository.replaceProject({
          ownerUserId: input.principal.userId,
          projectId: parseLaunchOpaqueId(input.projectId),
          expectedVersion: request.expectedVersion,
          values: request.project,
          requestId: input.requestId,
        });
        return Object.freeze({
          project: projectProjection(record),
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async submitProject(input: Parameters<LaunchService["submitProject"]>[0]) {
      try {
        const projectId = parseLaunchOpaqueId(input.projectId);
        const record = await repository.submitProject({
          ownerUserId: input.principal.userId,
          projectId,
          idempotencyKey: input.idempotencyKey,
          requestSha256: launchCommandDigest("submitProject", [projectId]),
          requestId: input.requestId,
        });
        return Object.freeze({
          project: projectProjection(record),
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async getLaunch(input: Parameters<LaunchService["getLaunch"]>[0]) {
      try {
        const detail = await requireLaunch(input.launchId);
        const { config, pending } = selectConfig(detail);
        const catalog: LaunchCatalogRecord = {
          launch: detail.launch,
          projectName: detail.project.name,
          projectTicker: detail.project.ticker,
          confirmedConfigVersion:
            config !== null && !pending ? config.configVersion : null,
        };
        const chain = await readChain(detail);
        const onChainState: LaunchOnChainStateProjection =
          chain.status === "available"
            ? chain.onChainState
            : unavailableOnChainStateFor(chain.reasonCode);
        return Object.freeze({
          launch: summaryProjection(
            catalog,
            onChainState,
            publishedContractAddress(detail.launch),
          ),
          project: Object.freeze({
            projectId: detail.project.projectId,
            name: detail.project.name,
            ticker: detail.project.ticker,
            narrative: detail.project.narrative,
            officialLinks: detail.project.officialLinks,
            materialVersion: detail.project.materialVersion,
          }),
          // A chain read replaces the off-chain slots with the contract's own
          // values; otherwise both stay exactly as in Decision 0036.
          config:
            chain.status === "available"
              ? chain.config
              : config === null
                ? null
                : configProjection(config),
          configPending:
            chain.status !== "available" && pending
              ? unavailable(launchReasonCodes.configPendingConfirmation)
              : null,
          rounds:
            chain.status === "available"
              ? chain.rounds
              : Object.freeze(detail.rounds.map(roundProjection)),
          graduation: Object.freeze({
            steps: Object.freeze(
              launchGraduationSteps.map((step) =>
                Object.freeze({ step, status: "pending" as const }),
              ),
            ),
            // A pool evidence row needs a project asset address, which needs
            // the contract; contractAddress is null in this step.
            poolEvidence: unavailable(
              launchReasonCodes.poolEvidenceUnavailable,
            ),
          }),
          market: unavailable(launchReasonCodes.contractBaselinePending),
          holders: unavailable(launchReasonCodes.contractBaselinePending),
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async getEligibility(
      input: Parameters<LaunchService["getEligibility"]>[0],
    ) {
      try {
        const detail = await requireLaunch(input.launchId);
        const { config, pending } = selectConfig(detail);
        const mode = eligibilityMode(pending ? null : config);
        const requestedRound = parseRoundIndexQuery(input.roundIndex);
        const refusedResult = (reasonCode: string): LaunchEligibilityResult =>
          Object.freeze({ tier: null, reasonCode, snapshotBlock: null });
        let result: LaunchEligibilityResult;
        if (mode === "unavailable") {
          result = refusedResult(launchReasonCodes.tierModePending);
        } else if (contract === null || contract.contract === null) {
          // Unchanged Decision 0036 bytes while no contract is configured.
          result = refusedResult(launchReasonCodes.contractBaselinePending);
        } else {
          result = await evaluateEligibility(
            detail,
            mode,
            input.principal,
            requestedRound,
          ).catch((error: unknown) => {
            if (error instanceof LaunchContractUnavailableError) {
              return refusedResult(error.reasonCode);
            }
            throw error;
          });
        }
        return Object.freeze({
          launchId: detail.launch.launchId,
          mode,
          // Eligibility never depends on staking (main-agent ruling).
          result,
          configVersion: config?.configVersion ?? null,
          effectiveAt: config?.effectiveAt ?? null,
          dependsOnStaking: false as const,
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async getHolders(input: Parameters<LaunchService["getHolders"]>[0]) {
      try {
        const detail = await requireLaunch(input.launchId);
        if (contract === null || contract.contract === null) {
          return Object.freeze({
            launchId: detail.launch.launchId,
            holders: unavailable(launchReasonCodes.contractBaselinePending),
            myPosition: unavailable(launchReasonCodes.contractBaselinePending),
            walletCap: unavailable(launchReasonCodes.configPendingConfirmation),
            contractVersion: v2ContractVersion,
          });
        }
        const reason = await chainReason(detail.launch);
        if (reason !== null) {
          return Object.freeze({
            launchId: detail.launch.launchId,
            holders: unavailable(reason),
            myPosition: unavailable(reason),
            walletCap: unavailable(reason),
            contractVersion: v2ContractVersion,
          });
        }
        const checkpoint = await readCheckpoint();
        const holders =
          checkpoint === null || chain === null
            ? unavailable(launchContractReasonCodes.onChainStateNotIndexed)
            : Object.freeze({
                status: "available" as const,
                holderCount: await chain.countHolders(detail.launch.launchId),
                indexedBlockNumber: checkpoint.lastBlockNumber,
              });
        const position = await readPosition(detail, input.principal);
        return Object.freeze({
          launchId: detail.launch.launchId,
          holders,
          myPosition: position.myPosition,
          walletCap: position.walletCap,
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async getHistory(input: Parameters<LaunchService["getHistory"]>[0]) {
      try {
        const detail = await requireLaunch(input.launchId);
        const empty = (reasonCode: string): LaunchHistoryResource =>
          Object.freeze({
            launchId: detail.launch.launchId,
            purchaseRecords: Object.freeze([]),
            entitlements: Object.freeze([]),
            refunds: Object.freeze([]),
            source: unavailable(reasonCode),
            contractVersion: v2ContractVersion,
          });
        if (contract === null || contract.contract === null) {
          return empty(launchReasonCodes.contractBaselinePending);
        }
        // The history is the lane's index; it needs the registry, not a
        // reachable endpoint (a read of LOOP's own rows).
        const refused = registryReason(detail.launch);
        if (refused !== null) {
          return empty(refused);
        }
        const checkpoint = await readCheckpoint();
        if (checkpoint === null || chain === null) {
          return empty(launchContractReasonCodes.onChainStateNotIndexed);
        }
        const records = await chain.listHistory({
          launchId: detail.launch.launchId,
          ownerUserId: input.principal.userId,
          limit: 500,
        });
        return Object.freeze({
          launchId: detail.launch.launchId,
          purchaseRecords: records.purchaseRecords,
          entitlements: records.entitlements,
          refunds: records.refunds,
          source: Object.freeze({
            status: "available" as const,
            indexedBlockNumber: checkpoint.lastBlockNumber,
            indexedBlockHash: checkpoint.lastBlockHash,
          }),
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async getMilestones(input: Parameters<LaunchService["getMilestones"]>[0]) {
      try {
        const project = await requireVisibleProject(
          input.principal,
          input.projectId,
        );
        const items = await repository.listMilestones(project.projectId);
        return Object.freeze({
          projectId: project.projectId,
          items: milestoneRows(items),
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async prepareIntent(input: Parameters<LaunchService["prepareIntent"]>[0]) {
      if (
        intentRuntime === null ||
        chain === null ||
        contract === null ||
        contract.contract === null ||
        intentRuntime.writes === null
      ) {
        // Unchanged bytes: no switch, no contract, no Intent.
        throw V2ApiError.capabilityUnavailable();
      }
      try {
        return await prepareLaunchIntent(
          {
            repository,
            chain,
            contract,
            runtime: intentRuntime,
            registryReason: (detail) => registryReason(detail.launch),
            eligibilityMode: (detail) => {
              const selected = selectConfig(detail);
              return eligibilityMode(selected.pending ? null : selected.config);
            },
          },
          {
            principal: input.principal,
            launchId: parseLaunchOpaqueId(input.launchId),
            body: input.body,
            idempotencyKey: input.idempotencyKey,
          },
        );
      } catch (error) {
        return translate(error);
      }
    },

    async reportIntent(input: Parameters<LaunchService["reportIntent"]>[0]) {
      if (intentRuntime === null || chain === null || contract === null) {
        throw V2ApiError.capabilityUnavailable();
      }
      try {
        return await reportLaunchIntentBroadcast(
          { chain, contract, runtime: intentRuntime },
          {
            principal: input.principal,
            launchId: parseLaunchOpaqueId(input.launchId),
            launchIntentId: parseLaunchOpaqueId(input.launchIntentId),
            body: input.body,
          },
        );
      } catch (error) {
        return translate(error);
      }
    },

    getStake() {
      return Object.freeze({
        stake: unavailable(launchReasonCodes.stakingContractPending),
        executable: false as const,
        contractVersion: v2ContractVersion,
      });
    },

    async getEconomy() {
      try {
        const counts = await repository.getEconomyCounts();
        const onChain = await economyOnChain();
        return Object.freeze({
          projects: counts.projectsByStatus,
          launches: counts.launchesByScheduleStatus,
          confirmedRoundCount: counts.confirmedRoundCount,
          totalSupply: unavailable(launchReasonCodes.economyUnavailable),
          distributed: unavailable(launchReasonCodes.economyUnavailable),
          ecosystemTax: unavailable(launchReasonCodes.economyUnavailable),
          ...(onChain === null ? {} : { onChain }),
          source: "loop" as const,
          observedAt: counts.observedAt,
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return translate(error);
      }
    },
  });
}

export function createUnavailableLaunchService(): LaunchService {
  const unavailableService = () =>
    Promise.reject(V2ApiError.capabilityUnavailable());
  return Object.freeze({
    getOverview: unavailableService,
    listProjects: unavailableService,
    createProject: unavailableService,
    getProject: unavailableService,
    replaceProject: unavailableService,
    submitProject: unavailableService,
    getLaunch: unavailableService,
    getEligibility: unavailableService,
    getHolders: unavailableService,
    getHistory: unavailableService,
    getMilestones: unavailableService,
    prepareIntent: unavailableService,
    reportIntent: unavailableService,
    getStake() {
      return Object.freeze({
        stake: unavailable(launchReasonCodes.stakingContractPending),
        executable: false as const,
        contractVersion: v2ContractVersion,
      });
    },
    getEconomy: unavailableService,
  });
}
