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
  memberRowActions,
  membershipAfterAction,
  targetStateAllowsAction,
  viewerPermissions,
  type CommunityActorMembership,
  type CommunityMembershipStatus,
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

  it("gives only the owner the community profile edit right", () => {
    expect(communitySelfPermissionMatrix.owner.editProfile).toBe(true);
    expect(communitySelfPermissionMatrix.admin.editProfile).toBe(false);
    expect(communitySelfPermissionMatrix.member.editProfile).toBe(false);
    expect(canPerformSelfAction(active("owner"), "editProfile")).toBe(true);
    expect(canPerformSelfAction(active("admin"), "editProfile")).toBe(false);
    expect(canPerformSelfAction(active("member"), "editProfile")).toBe(false);
    expect(canPerformSelfAction(null, "editProfile")).toBe(false);
    expect(
      canPerformSelfAction({ role: "owner", status: "banned" }, "editProfile"),
    ).toBe(false);
  });

  it("gives only the owner the right to resubmit a rejected application (Decision 0072)", () => {
    expect(communitySelfPermissionMatrix.owner.resubmitApplication).toBe(true);
    expect(communitySelfPermissionMatrix.admin.resubmitApplication).toBe(false);
    expect(communitySelfPermissionMatrix.member.resubmitApplication).toBe(
      false,
    );
    expect(canPerformSelfAction(active("owner"), "resubmitApplication")).toBe(
      true,
    );
    expect(canPerformSelfAction(active("admin"), "resubmitApplication")).toBe(
      false,
    );
    expect(canPerformSelfAction(null, "resubmitApplication")).toBe(false);
    expect(
      canPerformSelfAction(
        { role: "owner", status: "banned" },
        "resubmitApplication",
      ),
    ).toBe(false);
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
    // An unban restores an active member instead of removing the row, so the
    // membership (and its join date) survives a ban.
    expect(
      membershipAfterAction("unban", { role: "member", status: "banned" }),
    ).toEqual({ role: "member", status: "active" });
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

/**
 * Row actions are the client-facing half of the same matrix. The table below
 * is written out by hand rather than derived from `communityPermissionMatrix`,
 * so widening a matrix cell (or a state precondition) fails here instead of
 * silently reaching a member row.
 *
 * The `admin` actor against an `admin` target is the cell that regressed in
 * the app: the observer-level `canMute`/`canBan` flags said "true" because
 * they carry no target, and the member screen offered a mute and a ban the
 * matrix had always denied, so the command always came back PERMISSION_DENIED.
 */
describe("V2 community member-row actions", () => {
  /** `[actor role, target status, expected actions keyed by target role]`. */
  const rows: readonly (readonly [
    CommunityRole,
    CommunityMembershipStatus,
    Readonly<Record<CommunityRole, readonly CommunityTargetAction[]>>,
  ])[] = [
    [
      "owner",
      "active",
      {
        owner: [],
        admin: ["revokeAdmin", "transferOwnership", "mute", "ban"],
        member: ["assignAdmin", "transferOwnership", "mute", "ban"],
      },
    ],
    [
      "owner",
      "muted",
      {
        owner: [],
        admin: ["revokeAdmin", "unmute", "ban"],
        member: ["assignAdmin", "unmute", "ban"],
      },
    ],
    ["owner", "banned", { owner: [], admin: ["unban"], member: ["unban"] }],
    ["admin", "active", { owner: [], admin: [], member: ["mute", "ban"] }],
    ["admin", "muted", { owner: [], admin: [], member: ["unmute", "ban"] }],
    ["admin", "banned", { owner: [], admin: [], member: ["unban"] }],
    ["member", "active", { owner: [], admin: [], member: [] }],
    ["member", "muted", { owner: [], admin: [], member: [] }],
    ["member", "banned", { owner: [], admin: [], member: [] }],
  ];

  const row = (
    actor: CommunityActorMembership | null,
    targetRole: CommunityRole,
    targetStatus: CommunityMembershipStatus,
    overrides: { isSelf?: boolean; isAddressable?: boolean } = {},
  ): readonly CommunityTargetAction[] =>
    memberRowActions({
      actor,
      target: { role: targetRole, status: targetStatus },
      isSelf: overrides.isSelf ?? false,
      isAddressable: overrides.isAddressable ?? true,
    });

  it("publishes exactly the commands the matrix and the stored state allow, cell by cell", () => {
    // Every actor role x target status pair is written down once, so the
    // table cannot quietly stop covering a cell.
    expect(rows.length).toBe(
      communityRoles.length * communityMembershipStatuses.length,
    );
    for (const [actorRole, targetStatus, expected] of rows) {
      for (const targetRole of communityRoles) {
        expect(
          row(active(actorRole), targetRole, targetStatus),
          `${actorRole} -> ${targetRole}/${targetStatus}`,
        ).toEqual(expected[targetRole]);
      }
    }
  });

  it("never offers an admin a mute or a ban against another admin", () => {
    for (const status of communityMembershipStatuses) {
      const actions = row(active("admin"), "admin", status);
      expect(actions, `admin -> admin/${status}`).not.toContain("mute");
      expect(actions, `admin -> admin/${status}`).not.toContain("ban");
    }
    // The whole cell is empty in every state, not merely free of mute and
    // ban: an admin has no governance right at all over another admin, so
    // even the restore of a banned admin row stays with the owner.
    for (const status of communityMembershipStatuses) {
      expect(row(active("admin"), "admin", status), status).toEqual([]);
    }
  });

  it("gives a banned row exactly one command, and only to a viewer who may ban", () => {
    for (const targetRole of ["admin", "member"] as const) {
      expect(row(active("owner"), targetRole, "banned")).toEqual(["unban"]);
    }
    expect(row(active("admin"), "member", "banned")).toEqual(["unban"]);
    expect(row(active("member"), "member", "banned")).toEqual([]);
    expect(row(null, "member", "banned")).toEqual([]);
  });

  it("never offers a command against the owner's row", () => {
    for (const actorRole of communityRoles) {
      for (const status of communityMembershipStatuses) {
        expect(
          row(active(actorRole), "owner", status),
          `${actorRole} -> owner/${status}`,
        ).toEqual([]);
      }
    }
  });

  it("offers nothing to a non-member, a banned actor, or on the viewer's own row", () => {
    for (const targetRole of communityRoles) {
      for (const status of communityMembershipStatuses) {
        expect(row(null, targetRole, status)).toEqual([]);
        expect(
          row({ role: "owner", status: "banned" }, targetRole, status),
        ).toEqual([]);
        expect(
          row(active("owner"), targetRole, status, { isSelf: true }),
        ).toEqual([]);
      }
    }
  });

  it("offers nothing on a row no command can address", () => {
    expect(
      row(active("owner"), "member", "active", { isAddressable: false }),
    ).toEqual([]);
    expect(
      row(active("admin"), "member", "active", { isAddressable: false }),
    ).toEqual([]);
  });

  it("keeps a muted viewer's governance standing, as the matrix does", () => {
    expect(row({ role: "admin", status: "muted" }, "member", "active")).toEqual(
      ["mute", "ban"],
    );
  });

  it("keeps the declared action order so the published list is deterministic", () => {
    const actions = row(active("owner"), "member", "active");
    const order = actions.map((action) =>
      communityTargetActions.indexOf(action),
    );
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });

  it("publishes only commands the write path would authorize", () => {
    for (const actorRole of communityRoles) {
      for (const targetRole of communityRoles) {
        for (const targetStatus of communityMembershipStatuses) {
          const actor = active(actorRole);
          const target = { role: targetRole, status: targetStatus } as const;
          const published = row(actor, targetRole, targetStatus);
          for (const action of communityTargetActions) {
            const authorized =
              canPerformTargetAction({
                actor,
                action,
                targetRole,
                isSelf: false,
              }) && targetStateAllowsAction(action, target);
            expect(
              published.includes(action),
              `${actorRole} ${action} ${targetRole}/${targetStatus}`,
            ).toBe(authorized);
          }
        }
      }
    }
  });
});
