import { describe, expect, it } from "vitest";

import {
  canPerformSelfAction,
  canPerformTargetAction,
  communityMembershipStatuses,
  communityPermissionMatrix,
  communityRoleRank,
  communityRoles,
  communitySelfPermissionMatrix,
  communityTargetActions,
  membershipAfterAction,
  targetStateAllowsAction,
  viewerPermissions,
  type CommunityRole,
  type CommunityTargetAction,
} from "../src/features/community/community-policy.js";

/**
 * The permission matrix is the single source both routes and tests read.
 * Every cell of `role x action x targetRole` is asserted here, so a silent
 * widening of a governance right fails the build.
 */

const active = (role: CommunityRole) => ({ role, status: "active" }) as const;

describe("V2 community permission matrix", () => {
  it("keeps exactly three roles and three statuses", () => {
    expect(communityRoles).toEqual(["owner", "admin", "member"]);
    expect(communityMembershipStatuses).toEqual(["active", "muted", "banned"]);
    expect(communityRoleRank).toEqual({ owner: 0, admin: 1, member: 2 });
  });

  it("evaluates every actor role, action, and target role cell", () => {
    const expected: Readonly<
      Record<
        CommunityRole,
        Readonly<Record<CommunityTargetAction, readonly CommunityRole[]>>
      >
    > = {
      owner: {
        assignAdmin: ["member"],
        revokeAdmin: ["admin"],
        transferOwnership: ["admin", "member"],
        mute: ["admin", "member"],
        unmute: ["admin", "member"],
        ban: ["admin", "member"],
        unban: ["admin", "member"],
      },
      admin: {
        assignAdmin: [],
        revokeAdmin: [],
        transferOwnership: [],
        mute: ["member"],
        unmute: ["member"],
        ban: ["member"],
        unban: ["member"],
      },
      member: {
        assignAdmin: [],
        revokeAdmin: [],
        transferOwnership: [],
        mute: [],
        unmute: [],
        ban: [],
        unban: [],
      },
    };

    for (const actorRole of communityRoles) {
      for (const action of communityTargetActions) {
        for (const targetRole of communityRoles) {
          const allowed = expected[actorRole][action].includes(targetRole);
          expect(
            canPerformTargetAction({
              actor: active(actorRole),
              action,
              targetRole,
              isSelf: false,
            }),
            `${actorRole} ${action} ${targetRole}`,
          ).toBe(allowed);
          expect(
            communityPermissionMatrix[actorRole][action].includes(targetRole),
          ).toBe(allowed);
        }
      }
    }
  });

  it("never allows an owner to be the target of a governance action", () => {
    for (const actorRole of communityRoles) {
      for (const action of communityTargetActions) {
        expect(
          canPerformTargetAction({
            actor: active(actorRole),
            action,
            targetRole: "owner",
            isSelf: false,
          }),
        ).toBe(false);
      }
    }
  });

  it("denies a non-member, a banned actor, and every self-targeted action", () => {
    for (const action of communityTargetActions) {
      expect(
        canPerformTargetAction({
          actor: null,
          action,
          targetRole: "member",
          isSelf: false,
        }),
      ).toBe(false);
      expect(
        canPerformTargetAction({
          actor: { role: "owner", status: "banned" },
          action,
          targetRole: "member",
          isSelf: false,
        }),
      ).toBe(false);
      expect(
        canPerformTargetAction({
          actor: active("owner"),
          action,
          targetRole: "member",
          isSelf: true,
        }),
      ).toBe(false);
    }
  });

  it("keeps a muted actor's governance standing because mute only silences chat", () => {
    expect(
      canPerformTargetAction({
        actor: { role: "admin", status: "muted" },
        action: "mute",
        targetRole: "member",
        isSelf: false,
      }),
    ).toBe(true);
  });

  it("lets admins and members leave but requires the owner to transfer first", () => {
    expect(communitySelfPermissionMatrix.owner.leave).toBe(false);
    expect(canPerformSelfAction(active("owner"), "leave")).toBe(false);
    expect(canPerformSelfAction(active("admin"), "leave")).toBe(true);
    expect(canPerformSelfAction(active("member"), "leave")).toBe(true);
    expect(canPerformSelfAction(null, "leave")).toBe(false);
    expect(
      canPerformSelfAction({ role: "member", status: "banned" }, "leave"),
    ).toBe(false);
  });

  it("derives the member-directory action flags from the same matrix", () => {
    expect(viewerPermissions(active("owner"))).toEqual({
      canInviteAdmin: true,
      canMute: true,
      canBan: true,
    });
    expect(viewerPermissions(active("admin"))).toEqual({
      canInviteAdmin: false,
      canMute: true,
      canBan: true,
    });
    expect(viewerPermissions(active("member"))).toEqual({
      canInviteAdmin: false,
      canMute: false,
      canBan: false,
    });
    expect(viewerPermissions(null)).toEqual({
      canInviteAdmin: false,
      canMute: false,
      canBan: false,
    });
    expect(viewerPermissions({ role: "owner", status: "banned" })).toEqual({
      canInviteAdmin: false,
      canMute: false,
      canBan: false,
    });
  });

  it("maps each action to its next membership state", () => {
    expect(membershipAfterAction("assignAdmin", active("member"))).toEqual({
      role: "admin",
      status: "active",
    });
    expect(membershipAfterAction("revokeAdmin", active("admin"))).toEqual({
      role: "member",
      status: "active",
    });
    expect(membershipAfterAction("transferOwnership", active("admin"))).toEqual(
      { role: "owner", status: "active" },
    );
    expect(membershipAfterAction("mute", active("member"))).toEqual({
      role: "member",
      status: "muted",
    });
    expect(
      membershipAfterAction("unmute", { role: "member", status: "muted" }),
    ).toEqual({ role: "member", status: "active" });
    expect(membershipAfterAction("ban", active("admin"))).toEqual({
      role: "member",
      status: "banned",
    });
    expect(
      membershipAfterAction("unban", { role: "member", status: "banned" }),
    ).toBeNull();
  });

  it("rejects transitions the stored state does not allow", () => {
    expect(targetStateAllowsAction("assignAdmin", active("admin"))).toBe(false);
    expect(targetStateAllowsAction("revokeAdmin", active("member"))).toBe(
      false,
    );
    expect(
      targetStateAllowsAction("mute", { role: "member", status: "muted" }),
    ).toBe(false);
    expect(targetStateAllowsAction("unmute", active("member"))).toBe(false);
    expect(
      targetStateAllowsAction("ban", { role: "member", status: "banned" }),
    ).toBe(false);
    expect(targetStateAllowsAction("unban", active("member"))).toBe(false);
    expect(
      targetStateAllowsAction("transferOwnership", {
        role: "admin",
        status: "muted",
      }),
    ).toBe(false);
  });
});
