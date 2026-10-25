/**
 * Decision 0125 (S148, S138 defect D1): a deployed launch2 MEME enters the
 * Asset Registry (`public.assets`) the way `pnpm asset:register` writes a
 * row — `symbol` / `name` / `decimals` read from the token contract at an
 * observed block, `source_kind = chain_call`, status `pending` — as soon as
 * the `launch2_event` lane has indexed the instance's `LaunchDeployed`.
 *
 * In the same transaction the community the project owner named
 * (`launch_projects.community_id`) is bound to the MEME
 * (`communities.bound_asset_key`) when that community is unbound and the
 * instance owner still owns it. The attempt runs once per instance and its
 * outcome is kept on the instance:
 *
 * - `bound`: the community now points at the MEME;
 * - `already_bound`: it already did;
 * - `conflict`: it points at another asset (never overwritten; a reviewer
 *   rejection `community_binding_mismatch` is the remedy), or — Decision
 *   0182, one token, one community — another community that is not
 *   rejected already binds the MEME (`takenByCommunityId`, warned as
 *   `LAUNCH2_COMMUNITY_BOUND_ASSET_TAKEN`);
 * - `not_owner`: the instance owner no longer owns the community;
 * - `community_unavailable`: the community is gone or rejected;
 * - `asset_blocked`: the registry row is `blocked`;
 * - `none`: the project names no community.
 *
 * Every tick re-lists what is still pending, so instances deployed before
 * this decision (and any whose identity read failed) are registered by the
 * next tick without manual SQL. An existing registry row is never changed.
 */

export const launch2CommunityBindingOutcomes = Object.freeze([
  "bound",
  "already_bound",
  "conflict",
  "not_owner",
  "community_unavailable",
  "asset_blocked",
  "none",
] as const);
export type Launch2CommunityBindingOutcome =
  (typeof launch2CommunityBindingOutcomes)[number];

export interface Launch2TokenIdentity {
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  /** The block the three reads were pinned to. */
  readonly blockNumber: bigint;
}

export interface Launch2PendingMemeAsset {
  readonly instanceId: string;
  readonly chainId: string;
  readonly memeAddress: string;
  /** A registry row for `chainId:memeAddress` already exists. */
  readonly assetRegistered: boolean;
}

export interface Launch2MemeAssetRepository {
  /**
   * Instances whose `LaunchDeployed` is indexed and whose MEME has no
   * registry row yet or whose community binding was never attempted.
   */
  listPendingMemeAssets(
    chainId: string,
  ): Promise<readonly Launch2PendingMemeAsset[]>;
  /**
   * One transaction: inserts the registry row when `identity` is given and
   * none exists (`on conflict do nothing`), then makes the one community
   * binding attempt when it was never made.
   */
  registerMemeAsset(input: {
    readonly instanceId: string;
    readonly identity: Launch2TokenIdentity | null;
  }): Promise<{
    readonly assetId: string;
    readonly inserted: boolean;
    readonly communityBinding: Launch2CommunityBindingOutcome | null;
    /**
     * Decision 0182: set only with `conflict` when the MEME is already bound
     * by another (not rejected) community — that community's ID.
     */
    readonly takenByCommunityId?: string;
  }>;
}

export interface Launch2TokenIdentityReader {
  readTokenIdentity(address: string): Promise<Launch2TokenIdentity>;
}

// eslint-disable-next-line no-control-regex
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/u;

function boundedText(value: string, maximum: number): boolean {
  const length = Array.from(value).length;
  return (
    length >= 1 &&
    length <= maximum &&
    value === value.trim() &&
    !controlCharacters.test(value)
  );
}

/** The `public.assets` row constraints, checked before the insert. */
export function isRegistrableTokenIdentity(
  identity: Launch2TokenIdentity,
): boolean {
  return (
    boundedText(identity.symbol, 32) &&
    boundedText(identity.name, 128) &&
    Number.isInteger(identity.decimals) &&
    identity.decimals >= 0 &&
    identity.decimals <= 36 &&
    identity.blockNumber >= 0n
  );
}

export interface Launch2MemeAssetRegistration {
  readonly registered: number;
  readonly bindings: number;
  readonly failed: number;
}

export async function registerPendingLaunch2MemeAssets(input: {
  readonly repository: Launch2MemeAssetRepository;
  readonly reader: Launch2TokenIdentityReader;
  readonly chainId: string;
  readonly onWarning?: (warning: {
    readonly reasonCode: string;
    readonly count: number;
    readonly instanceId?: string;
    readonly communityId?: string;
  }) => void;
}): Promise<Launch2MemeAssetRegistration> {
  const pending = await input.repository.listPendingMemeAssets(input.chainId);
  let registered = 0;
  let bindings = 0;
  let failed = 0;
  for (const asset of pending) {
    let identity: Launch2TokenIdentity | null = null;
    if (!asset.assetRegistered) {
      try {
        identity = await input.reader.readTokenIdentity(asset.memeAddress);
      } catch {
        failed += 1;
        input.onWarning?.({
          reasonCode: "LAUNCH2_ASSET_IDENTITY_UNAVAILABLE",
          count: 1,
          instanceId: asset.instanceId,
        });
        continue;
      }
      if (!isRegistrableTokenIdentity(identity)) {
        failed += 1;
        input.onWarning?.({
          reasonCode: "LAUNCH2_ASSET_IDENTITY_INVALID",
          count: 1,
          instanceId: asset.instanceId,
        });
        continue;
      }
    }
    const outcome = await input.repository.registerMemeAsset({
      instanceId: asset.instanceId,
      identity,
    });
    if (outcome.inserted) registered += 1;
    if (outcome.communityBinding !== null) bindings += 1;
    if (outcome.takenByCommunityId !== undefined) {
      input.onWarning?.({
        reasonCode: "LAUNCH2_COMMUNITY_BOUND_ASSET_TAKEN",
        count: 1,
        instanceId: asset.instanceId,
        communityId: outcome.takenByCommunityId,
      });
    }
  }
  return Object.freeze({ registered, bindings, failed });
}
