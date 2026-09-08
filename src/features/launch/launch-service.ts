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
  launchChainId,
  launchCommandDigest,
  launchConfigVersion,
  launchCursorRoutes,
  launchEligibilityModes,
  launchGraduationSteps,
  launchProjectDigestParts,
  launchProjectListFilters,
  launchReasonCodes,
  parseLaunchEnum,
  parseLaunchListLimit,
  parseLaunchOpaqueId,
  parseLaunchProjectValues,
  parseReplaceLaunchProjectRequest,
  unavailable,
  unavailableOnChainState,
  type LaunchEligibilityMode,
  type LaunchGraduationStep,
  type LaunchOnChainStateProjection,
  type LaunchProjectListFilter,
  type LaunchProjectProjection,
  type LaunchReviewStatus,
  type LaunchScheduleStatus,
  type LaunchSummaryProjection,
  type UnavailableProjection,
} from "./launch-contract.js";
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
    readonly source: "loop_db";
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
  readonly config: LaunchConfigProjection | null;
  readonly configPending: UnavailableProjection | null;
  readonly rounds: readonly LaunchRoundProjection[];
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

export interface LaunchEligibilityResource {
  readonly launchId: string;
  readonly mode: LaunchEligibilityMode;
  readonly result: {
    readonly tier: null;
    readonly reasonCode: string;
    readonly snapshotBlock: null;
  };
  readonly configVersion: string | null;
  readonly effectiveAt: string | null;
  readonly dependsOnStaking: false;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface LaunchHoldersResource {
  readonly launchId: string;
  readonly holders: UnavailableProjection;
  readonly myPosition: UnavailableProjection;
  readonly walletCap: UnavailableProjection;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface LaunchHistoryResource {
  readonly launchId: string;
  readonly purchaseRecords: readonly never[];
  readonly entitlements: readonly never[];
  readonly refunds: readonly never[];
  readonly source: UnavailableProjection;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface VenueMilestoneProjection {
  readonly venueMilestoneId: string;
  readonly venue: VenueMilestoneRecord["venue"];
  readonly marketType: VenueMilestoneRecord["marketType"];
  readonly state: VenueMilestoneRecord["state"];
  readonly evidence: {
    readonly digest: string | null;
    readonly recordedAt: string | null;
    readonly observedAt: string | null;
    readonly reviewer: string | null;
  };
  readonly version: number;
  readonly updatedAt: string;
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
  readonly source: "loop_db";
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
    input: PrincipalInput & { readonly launchId: string },
  ): Promise<LaunchEligibilityResource>;
  getHolders(input: {
    readonly launchId: string;
  }): Promise<LaunchHoldersResource>;
  getHistory(
    input: PrincipalInput & { readonly launchId: string },
  ): Promise<LaunchHistoryResource>;
  getMilestones(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly projectId: string;
  }): Promise<LaunchMilestonesResource>;
  /** Always CAPABILITY_UNAVAILABLE: no Launch transaction is ever built here. */
  prepareIntent(input: PrincipalInput & { readonly launchId: string }): never;
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
): LaunchSummaryProjection {
  if (record.launch.contractAddress !== null) {
    // The migration pins contract_address to null; a non-null value would
    // mean the schema moved without this projection being revised.
    throw V2ApiError.capabilityUnavailable();
  }
  return Object.freeze({
    launchId: record.launch.launchId,
    projectId: record.launch.projectId,
    name: record.projectName,
    ticker: record.projectTicker,
    chainId: launchChainId,
    contractAddress: null,
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

export function createLaunchService(
  dependencies: LaunchServiceDependencies,
): LaunchService {
  const { repository } = dependencies;
  const now = dependencies.now ?? ((): Date => new Date());

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
        const summaries = launches.map((record) =>
          summaryProjection(record, unavailableOnChainState),
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
            source: "loop_db" as const,
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
        return Object.freeze({
          launch: summaryProjection(catalog, unavailableOnChainState),
          project: Object.freeze({
            projectId: detail.project.projectId,
            name: detail.project.name,
            ticker: detail.project.ticker,
            narrative: detail.project.narrative,
            officialLinks: detail.project.officialLinks,
            materialVersion: detail.project.materialVersion,
          }),
          config: config === null ? null : configProjection(config),
          configPending: pending
            ? unavailable(launchReasonCodes.configPendingConfirmation)
            : null,
          rounds: Object.freeze(detail.rounds.map(roundProjection)),
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
        return Object.freeze({
          launchId: detail.launch.launchId,
          mode,
          // No mode is confirmed for any launch in this step, and eligibility
          // never depends on staking (main-agent ruling).
          result: Object.freeze({
            tier: null,
            reasonCode:
              mode === "unavailable"
                ? launchReasonCodes.tierModePending
                : launchReasonCodes.contractBaselinePending,
            snapshotBlock: null,
          }),
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
        return Object.freeze({
          launchId: detail.launch.launchId,
          holders: unavailable(launchReasonCodes.contractBaselinePending),
          myPosition: unavailable(launchReasonCodes.contractBaselinePending),
          walletCap: unavailable(launchReasonCodes.configPendingConfirmation),
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return translate(error);
      }
    },

    async getHistory(input: Parameters<LaunchService["getHistory"]>[0]) {
      try {
        const detail = await requireLaunch(input.launchId);
        return Object.freeze({
          launchId: detail.launch.launchId,
          purchaseRecords: Object.freeze([]),
          entitlements: Object.freeze([]),
          refunds: Object.freeze([]),
          source: unavailable(launchReasonCodes.contractBaselinePending),
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
          items: Object.freeze(items.map(milestoneProjection)),
          contractVersion: v2ContractVersion,
        });
      } catch (error) {
        return translate(error);
      }
    },

    prepareIntent() {
      // No Launch contract baseline: no payload, no digest, no row. The
      // launch_intents relation exists as structure only (03 §8.2).
      throw V2ApiError.capabilityUnavailable();
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
        return Object.freeze({
          projects: counts.projectsByStatus,
          launches: counts.launchesByScheduleStatus,
          confirmedRoundCount: counts.confirmedRoundCount,
          totalSupply: unavailable(launchReasonCodes.economyUnavailable),
          distributed: unavailable(launchReasonCodes.economyUnavailable),
          ecosystemTax: unavailable(launchReasonCodes.economyUnavailable),
          source: "loop_db" as const,
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
    prepareIntent(): never {
      throw V2ApiError.capabilityUnavailable();
    },
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
