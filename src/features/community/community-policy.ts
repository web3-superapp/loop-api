/**
 * Community governance permission matrix (Decision 0031, main-agent ruling
 * 2026-09-07). It is a pure lookup table: routes, repositories, and tests
 * all read the same values, so a change here is the only way to change who
 * may do what.
 *
 * Roles form one three-tier ladder `owner > admin > member`. The 03 document's
 * "Admin/Moderator" is one tier (`admin`) in this step; custom roles and
 * channels do not exist. An owner can never be downgraded, muted, or banned:
 * ownership changes only through `transferOwnership`.
 */

export const communityRoles = ["owner", "admin", "member"] as const;
export type CommunityRole = (typeof communityRoles)[number];

export const communityMembershipStatuses = [
  "active",
  "muted",
  "banned",
] as const;
export type CommunityMembershipStatus =
  (typeof communityMembershipStatuses)[number];

/** Governance actions that target another member. */
export const communityTargetActions = [
  "assignAdmin",
  "revokeAdmin",
  "transferOwnership",
  "mute",
  "unmute",
  "ban",
  "unban",
] as const;
export type CommunityTargetAction = (typeof communityTargetActions)[number];

/**
 * Actions an actor performs without another member as the target: leaving
 * their own membership, and editing the community profile (owner only, the
 * "edit" right of the ruled matrix, delivered by `PATCH /v2/communities/{id}`).
 */
export const communitySelfActions = [
  "leave",
  "editProfile",
  "resubmitApplication",
] as const;
export type CommunitySelfAction = (typeof communitySelfActions)[number];

export type CommunityAction = CommunityTargetAction | CommunitySelfAction;

const none: readonly CommunityRole[] = Object.freeze([]);
const adminOrMember: readonly CommunityRole[] = Object.freeze([
  "admin",
  "member",
]);
const memberOnly: readonly CommunityRole[] = Object.freeze(["member"]);
const adminOnly: readonly CommunityRole[] = Object.freeze(["admin"]);

/**
 * For each actor role and target action: the target roles the actor may act
 * on. `owner` never appears as a target role, which encodes "owner cannot be
 * downgraded, muted, or banned". The actor and target are always different
 * accounts (self-targeting a governance action is denied before lookup).
 */
export const communityPermissionMatrix: Readonly<
  Record<
    CommunityRole,
    Readonly<Record<CommunityTargetAction, readonly CommunityRole[]>>
  >
> = Object.freeze({
  owner: Object.freeze({
    assignAdmin: memberOnly,
    revokeAdmin: adminOnly,
    transferOwnership: adminOrMember,
    mute: adminOrMember,
    unmute: adminOrMember,
    ban: adminOrMember,
    unban: adminOrMember,
  }),
  admin: Object.freeze({
    assignAdmin: none,
    revokeAdmin: none,
    transferOwnership: none,
    mute: memberOnly,
    unmute: memberOnly,
    ban: memberOnly,
    unban: memberOnly,
  }),
  member: Object.freeze({
    assignAdmin: none,
    revokeAdmin: none,
    transferOwnership: none,
    mute: none,
    unmute: none,
    ban: none,
    unban: none,
  }),
});

/**
 * Self actions per actor role: the owner must transfer before leaving, and
 * only the owner may edit the community profile or resubmit a rejected
 * application (Decision 0073).
 */
export const communitySelfPermissionMatrix: Readonly<
  Record<CommunityRole, Readonly<Record<CommunitySelfAction, boolean>>>
> = Object.freeze({
  owner: Object.freeze({
    leave: false,
    editProfile: true,
    resubmitApplication: true,
  }),
  admin: Object.freeze({
    leave: true,
    editProfile: false,
    resubmitApplication: false,
  }),
  member: Object.freeze({
    leave: true,
    editProfile: false,
    resubmitApplication: false,
  }),
});

export interface CommunityActorMembership {
  readonly role: CommunityRole;
  readonly status: CommunityMembershipStatus;
}

export interface CommunityTargetActionInput {
  /** `null` when the actor is not a member at all. */
  readonly actor: CommunityActorMembership | null;
  readonly action: CommunityTargetAction;
  readonly targetRole: CommunityRole;
  readonly isSelf: boolean;
}

/**
 * A banned actor has no standing; a muted actor keeps governance standing
 * because mute only silences chat (which Stream owns). Self-targeting a
 * governance action is always denied.
 */
export function canPerformTargetAction(
  input: CommunityTargetActionInput,
): boolean {
  if (input.actor === null || input.actor.status === "banned" || input.isSelf) {
    return false;
  }
  return communityPermissionMatrix[input.actor.role][input.action].includes(
    input.targetRole,
  );
}

export function canPerformSelfAction(
  actor: CommunityActorMembership | null,
  action: CommunitySelfAction,
): boolean {
  if (actor === null || actor.status === "banned") {
    return false;
  }
  return communitySelfPermissionMatrix[actor.role][action];
}

export interface CommunityViewerPermissions {
  readonly canInviteAdmin: boolean;
  readonly canMute: boolean;
  readonly canBan: boolean;
}

/**
 * Viewer-level governance standing, derived from the matrix.
 *
 * These flags answer "does this viewer hold this right anywhere in this
 * community" and nothing more: they carry no target role and no target state,
 * so they gate viewer-level affordances only (the `role=banned` governance
 * view, and whether the directory shows a governance affordance at all).
 * Per-row command visibility is `memberRowActions`; deriving a row action
 * from these booleans loses the target dimension and offers commands the
 * matrix denies.
 */
export function viewerPermissions(
  actor: CommunityActorMembership | null,
): CommunityViewerPermissions {
  const can = (action: CommunityTargetAction): boolean =>
    actor !== null &&
    actor.status !== "banned" &&
    communityPermissionMatrix[actor.role][action].length > 0;
  return Object.freeze({
    canInviteAdmin: can("assignAdmin"),
    canMute: can("mute"),
    canBan: can("ban"),
  });
}

export interface CommunityMemberRowActionsInput {
  /** The viewer's own membership, or `null` when they never joined. */
  readonly actor: CommunityActorMembership | null;
  /** The membership the row describes. */
  readonly target: CommunityActorMembership;
  /** The row is the viewer's own membership. */
  readonly isSelf: boolean;
  /**
   * The row carries a public profile ID. A membership without one cannot be
   * named by `/v2/communities/{id}/members/{publicProfileId}/...`, so no
   * command can reach it.
   */
  readonly isAddressable: boolean;
}

const noActions: readonly CommunityTargetAction[] = Object.freeze([]);

/**
 * The governance commands this viewer may actually run against this row.
 *
 * It is the same pair of predicates the write path evaluates, in the same
 * order: `canPerformTargetAction` (the actor x action x target matrix) and
 * then `targetStateAllowsAction` (the stored state precondition). A command
 * can therefore only be offered when the matching write would be authorized
 * on the state this very response projects, and a matrix cell can never be
 * widened for the client without being widened for the write as well.
 *
 * This replaces the observer-level `canMute`/`canBan` booleans as the source
 * of row-action visibility: those flags dropped the target dimension, so an
 * admin looking at another admin was offered a mute and a ban the matrix had
 * always denied.
 *
 * The result keeps `communityTargetActions` declaration order, so the list is
 * deterministic for a given actor, target, and state.
 */
export function memberRowActions(
  input: CommunityMemberRowActionsInput,
): readonly CommunityTargetAction[] {
  if (!input.isAddressable) {
    return noActions;
  }
  return Object.freeze(
    communityTargetActions.filter(
      (action) =>
        canPerformTargetAction({
          actor: input.actor,
          action,
          targetRole: input.target.role,
          isSelf: input.isSelf,
        }) && targetStateAllowsAction(action, input.target),
    ),
  );
}

/**
 * Role listing order for the member directory: owner first, then admins,
 * then members; inside a group the earliest join comes first.
 */
export const communityRoleRank: Readonly<Record<CommunityRole, number>> =
  Object.freeze({ owner: 0, admin: 1, member: 2 });

/**
 * Membership after each action. Every governance action keeps the membership
 * row: an unban restores the account as an active member (S3 integration,
 * FINDING-2 — deleting the row made an unban silently mean "removed from the
 * community", and the join date was lost with it). Leaving the community is
 * the only path that removes a membership, and it is a self action.
 */
export function membershipAfterAction(
  action: CommunityTargetAction,
  current: CommunityActorMembership,
): CommunityActorMembership {
  switch (action) {
    case "assignAdmin":
      return { role: "admin", status: current.status };
    case "revokeAdmin":
      return { role: "member", status: current.status };
    case "transferOwnership":
      return { role: "owner", status: "active" };
    case "mute":
      return { role: current.role, status: "muted" };
    case "unmute":
      return { role: current.role, status: "active" };
    case "ban":
      return { role: "member", status: "banned" };
    case "unban":
      return { role: "member", status: "active" };
  }
}

/**
 * State preconditions for an action on the target's current membership.
 * A false result is `DATA_STALE`: the caller must refresh before deciding
 * again.
 */
export function targetStateAllowsAction(
  action: CommunityTargetAction,
  current: CommunityActorMembership,
): boolean {
  switch (action) {
    case "assignAdmin":
      return current.role === "member" && current.status !== "banned";
    case "revokeAdmin":
      return current.role === "admin" && current.status !== "banned";
    case "transferOwnership":
      return current.status === "active";
    case "mute":
      return current.status === "active";
    case "unmute":
      return current.status === "muted";
    case "ban":
      return current.status !== "banned";
    case "unban":
      return current.status === "banned";
  }
}
