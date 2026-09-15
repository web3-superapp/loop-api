import type {
  CommunityWeightStatus,
  MiningFormulaDocument,
  MiningFormulaStatus,
  MiningPriceGuardRule,
  MiningWeightRangeDocument,
} from "./mining-contract.js";
import type {
  MiningBalanceInput,
  MiningCommunityWeightInput,
  MiningSnapshotPower,
} from "./mining-snapshot.js";

/**
 * Mining persistence boundary (Decisions 0036 and 0043). Formula versions,
 * community weights, snapshots, and the reward ledger structure. Only the
 * snapshot lane and the operator scripts write here; every route is a read.
 */

export interface MiningFormulaRecord {
  readonly configVersion: string;
  readonly formula: MiningFormulaDocument;
  readonly weightRange: MiningWeightRangeDocument;
  readonly priceGuardRules: readonly MiningPriceGuardRule[];
  readonly status: MiningFormulaStatus;
  readonly effectiveAt: string | null;
  readonly approvedAt: string | null;
  readonly createdAt: string;
}

export interface CommunityWeightRecord {
  readonly communityId: string;
  readonly communityName: string;
  readonly boundAssetId: string | null;
  readonly status: CommunityWeightStatus;
  readonly weight: string | null;
  readonly configVersion: string | null;
  readonly reviewedAt: string | null;
}

export interface MiningSnapshotRecord {
  readonly snapshotId: string;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly formulaVersion: string;
  readonly priceVersion: string;
  readonly totalPower: string;
  readonly accountCount: number;
  readonly computedAt: string;
}

export interface CreateMiningFormulaVersionInput {
  readonly configVersion: string;
  readonly formula: MiningFormulaDocument;
  readonly weightRange: MiningWeightRangeDocument;
  readonly priceGuardRules: readonly MiningPriceGuardRule[];
  readonly requestId: string;
}

export interface SetCommunityWeightInput {
  readonly communityId: string;
  readonly weight: string;
  readonly configVersion: string;
  readonly requestId: string;
}

/** One account's standing in a snapshot. */
export interface MiningAccountStandingRecord {
  readonly totalPower: string;
  /** `rank()` over accounts with positive power; null while the power is zero. */
  readonly position: number | null;
  /** Accounts with positive power in the snapshot. */
  readonly participantCount: number;
}

export interface MiningRankedAccountRecord {
  readonly ownerUserId: string;
  readonly totalPower: string;
  readonly position: number;
  readonly publicProfileId: string | null;
  readonly alias: string | null;
  readonly discoverable: boolean;
  readonly anonymousMode: boolean;
}

/**
 * A community's standing: the power of its non-banned members on its bound
 * asset under the snapshot, which already carries the community weight.
 */
export interface MiningCommunityStandingRecord {
  readonly communityId: string;
  readonly communityName: string;
  readonly boundAssetId: string;
  readonly weight: string;
  readonly power: string;
  /** Members with positive power on the bound asset. */
  readonly participantCount: number;
  /** `rank()` over communities with positive power; null while zero. */
  readonly position: number | null;
}

export interface MiningMemberPowerRecord {
  readonly publicProfileId: string;
  readonly ownerUserId: string;
  /** Null when the account has no row in the snapshot. */
  readonly totalPower: string | null;
  /** `privacy_preferences_v2.mining_power_visibility = 'everyone'`. */
  readonly visibleToOthers: boolean;
}

export interface WriteMiningSnapshotInput {
  readonly snapshotId: string;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly formulaVersion: string;
  readonly priceVersion: string;
  readonly totalPower: string;
  readonly powers: readonly MiningSnapshotPower[];
}

export interface MiningRepository {
  getApprovedFormula(): Promise<MiningFormulaRecord | null>;
  listFormulaVersions(): Promise<readonly MiningFormulaRecord[]>;
  /** Operator path: approves one version and retires any other approved one. */
  approveFormula(input: {
    readonly configVersion: string;
    readonly requestId: string;
  }): Promise<MiningFormulaRecord>;
  getCommunityWeight(
    communityId: string,
  ): Promise<CommunityWeightRecord | null>;
  /**
   * Every community with a bound asset, with its weight status under exactly
   * this formula version: a weight reviewed under another version reads as
   * `pending_review` here, so it never enters a snapshot of this one.
   */
  listCommunityWeightInputs(
    configVersion: string,
  ): Promise<readonly MiningCommunityWeightInput[]>;
  getLatestSnapshot(): Promise<MiningSnapshotRecord | null>;
  writeSnapshot(input: WriteMiningSnapshotInput): Promise<MiningSnapshotRecord>;
  /** Latest observed balance per active wallet and readable asset. */
  listBalanceInputs(): Promise<readonly MiningBalanceInput[]>;
  /** Operator path (Decision 0043): inserts a new `pending_approval` version. */
  createFormulaVersion(
    input: CreateMiningFormulaVersionInput,
  ): Promise<MiningFormulaRecord>;
  /**
   * Operator path (Decision 0043): records an approved community weight under
   * a version, inside that version's community range. Refuses a community
   * without a bound asset and a second community on the same asset.
   */
  setCommunityWeight(
    input: SetCommunityWeightInput,
  ): Promise<CommunityWeightRecord>;
  listAccountPowers(input: {
    readonly snapshotId: string;
    readonly ownerUserId: string;
  }): Promise<readonly MiningSnapshotPower[]>;
  getAccountStanding(input: {
    readonly snapshotId: string;
    readonly ownerUserId: string;
  }): Promise<MiningAccountStandingRecord | null>;
  listAccountRanking(input: {
    readonly snapshotId: string;
    readonly limit: number;
  }): Promise<readonly MiningRankedAccountRecord[]>;
  listCommunityRanking(input: {
    readonly snapshotId: string;
    readonly configVersion: string;
    readonly limit: number;
  }): Promise<readonly MiningCommunityStandingRecord[]>;
  /** Null when the community has no bound asset or no approved weight under the version. */
  getCommunityStanding(input: {
    readonly snapshotId: string;
    readonly configVersion: string;
    readonly communityId: string;
  }): Promise<MiningCommunityStandingRecord | null>;
  listMemberPowers(input: {
    readonly snapshotId: string;
    readonly publicProfileIds: readonly string[];
  }): Promise<readonly MiningMemberPowerRecord[]>;
  /** Assets the account's active wallets have any observed balance row for. */
  listAccountBalanceAssetIds(ownerUserId: string): Promise<readonly string[]>;
}

export class MiningRepositoryUnavailableError extends Error {
  readonly code = "mining_repository_unavailable";

  constructor() {
    super("The mining repository is unavailable");
    this.name = "MiningRepositoryUnavailableError";
  }
}

export class MiningFormulaNotFoundError extends Error {
  readonly code = "mining_formula_not_found";

  constructor() {
    super("The mining formula version does not exist");
    this.name = "MiningFormulaNotFoundError";
  }
}

export class MiningFormulaStateError extends Error {
  readonly code = "mining_formula_state_invalid";

  constructor() {
    super("The mining formula version cannot be approved from its state");
    this.name = "MiningFormulaStateError";
  }
}

export class MiningFormulaExistsError extends Error {
  readonly code = "mining_formula_exists";

  constructor() {
    super("The mining formula version already exists");
    this.name = "MiningFormulaExistsError";
  }
}

export class MiningCommunityNotFoundError extends Error {
  readonly code = "mining_community_not_found";

  constructor() {
    super("The community does not exist");
    this.name = "MiningCommunityNotFoundError";
  }
}

export class MiningCommunityAssetNotBoundError extends Error {
  readonly code = "mining_community_asset_not_bound";

  constructor() {
    super("The community has no bound asset to weight");
    this.name = "MiningCommunityAssetNotBoundError";
  }
}

export class MiningWeightOutOfRangeError extends Error {
  readonly code = "mining_weight_out_of_range";

  constructor() {
    super("The community weight is outside the version's range");
    this.name = "MiningWeightOutOfRangeError";
  }
}

export class MiningCommunityWeightConflictError extends Error {
  readonly code = "mining_community_weight_conflict";

  constructor() {
    super("Another community already carries an approved weight on this asset");
    this.name = "MiningCommunityWeightConflictError";
  }
}

export function createUnavailableMiningRepository(): MiningRepository {
  const unavailable = () =>
    Promise.reject(new MiningRepositoryUnavailableError());
  return Object.freeze({
    getApprovedFormula: unavailable,
    listFormulaVersions: unavailable,
    approveFormula: unavailable,
    getCommunityWeight: unavailable,
    listCommunityWeightInputs: unavailable,
    getLatestSnapshot: unavailable,
    writeSnapshot: unavailable,
    listBalanceInputs: unavailable,
    createFormulaVersion: unavailable,
    setCommunityWeight: unavailable,
    listAccountPowers: unavailable,
    getAccountStanding: unavailable,
    listAccountRanking: unavailable,
    listCommunityRanking: unavailable,
    getCommunityStanding: unavailable,
    listMemberPowers: unavailable,
    listAccountBalanceAssetIds: unavailable,
  });
}
