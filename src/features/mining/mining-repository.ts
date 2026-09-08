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
 * Mining persistence boundary (Decision 0036). Formula versions, community
 * weights, snapshots, and the reward ledger structure. Only the snapshot lane
 * and the operator scripts write here; every route is a read.
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
  /** Weights reviewed under exactly this formula version. */
  listCommunityWeightInputs(
    configVersion: string,
  ): Promise<readonly MiningCommunityWeightInput[]>;
  getLatestSnapshot(): Promise<MiningSnapshotRecord | null>;
  writeSnapshot(input: WriteMiningSnapshotInput): Promise<MiningSnapshotRecord>;
  /** Latest observed balance per active wallet and readable asset. */
  listBalanceInputs(): Promise<readonly MiningBalanceInput[]>;
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
  });
}
