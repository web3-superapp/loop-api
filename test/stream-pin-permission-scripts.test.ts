import { describe, expect, it, vi } from "vitest";

import {
  backfillCommunityStreamRoles,
  runCommunityStreamRolesBackfill,
  type CreateCommunityStreamRolesBackfillDependencies,
} from "../scripts/community-stream-roles-backfill.js";
import { runStreamChannelTypeAudit } from "../scripts/stream-channel-type-audit.js";
import {
  parseStreamChannelTypeGrantsArguments,
  runStreamChannelTypeGrants,
} from "../scripts/stream-channel-type-grants.js";
import type { SyncedCommunityChannelMemberRole } from "../src/database/community-channel-role-repository.js";
import {
  computePinGrantChanges,
  parseChannelTypeSnapshot,
  type StreamChannelTypeClient,
  type StreamChannelTypeSnapshot,
  type StreamPermissionDescriptor,
} from "../src/integrations/stream/channel-type-grants.js";
import { communityStreamChannelRole } from "../src/features/community/community-policy.js";

const environment = {
  STREAM_API_KEY: "stream_test_api_key",
  STREAM_API_SECRET: "stream_test_api_secret",
  DATABASE_URL: "postgres://loop:loop@127.0.0.1:5433/loop_api_s99b",
};

function writer() {
  let output = "";
  return {
    contents: () => output,
    write(value: string): boolean {
      output += value;
      return true;
    },
  };
}

function permission(
  id: string,
  action: string,
  owner: boolean,
): StreamPermissionDescriptor {
  return { id, action, owner, level: "channel" };
}

/** The permission catalog the Development Stream app reported on 2026-09-28. */
const permissions: readonly StreamPermissionDescriptor[] = [
  permission("pin-message", "PinMessage", false),
  permission("pin-message-any-team", "PinMessage", false),
  permission("pin-message-owner", "PinMessage", true),
  permission("pin-message-owner-any-team", "PinMessage", true),
  permission("delete-message", "DeleteMessage", false),
  permission("delete-message-owner", "DeleteMessage", true),
  permission("update-message", "UpdateMessage", false),
  permission("update-message-owner", "UpdateMessage", true),
  permission("send-message", "CreateMessage", false),
];

/** The `messaging` grants the Development Stream app reported (trimmed). */
function messagingSnapshot(
  grants: Record<string, readonly string[]> = {
    admin: ["pin-message", "delete-message", "update-message"],
    channel_member: ["send-message", "pin-message", "update-message-owner"],
    channel_moderator: ["pin-message", "delete-message", "update-message"],
    global_admin: ["pin-message-any-team"],
    moderator: ["pin-message", "delete-message"],
    user: ["pin-message-owner", "send-message"],
    guest: ["send-message"],
  },
): StreamChannelTypeSnapshot {
  return {
    name: "messaging",
    grants,
    automod: "disabled",
    automodBehavior: "flag",
    maxMessageLength: 5000,
  };
}

function fakeClient(
  snapshots: readonly StreamChannelTypeSnapshot[],
): StreamChannelTypeClient & {
  readonly updateChannelTypeGrants: ReturnType<typeof vi.fn>;
  readonly getChannelType: ReturnType<typeof vi.fn>;
} {
  let read = 0;
  const getChannelType = vi.fn(() => {
    const snapshot = snapshots[Math.min(read, snapshots.length - 1)];
    read += 1;
    return Promise.resolve(snapshot as StreamChannelTypeSnapshot);
  });
  return {
    getChannelType,
    listPermissions: vi.fn(() => Promise.resolve(permissions)),
    updateChannelTypeGrants: vi.fn(() => Promise.resolve()),
  };
}

describe("community role → Stream channel role (Decision 0091)", () => {
  it("maps owner and admin to channel_moderator and member to channel_member", () => {
    expect(communityStreamChannelRole("owner", "active")).toBe(
      "channel_moderator",
    );
    expect(communityStreamChannelRole("admin", "active")).toBe(
      "channel_moderator",
    );
    expect(communityStreamChannelRole("admin", "muted")).toBe(
      "channel_moderator",
    );
    expect(communityStreamChannelRole("member", "active")).toBe(
      "channel_member",
    );
    expect(communityStreamChannelRole("admin", "banned")).toBe(
      "channel_member",
    );
  });
});

describe("pin grant diff", () => {
  it("removes every pin variant from non-moderator roles and keeps admin and channel_moderator", () => {
    const changes = computePinGrantChanges(messagingSnapshot(), permissions);

    expect(changes).toEqual([
      {
        role: "channel_member",
        added: [],
        removed: ["pin-message"],
        next: ["send-message", "update-message-owner"],
      },
      {
        role: "global_admin",
        added: [],
        removed: ["pin-message-any-team"],
        next: [],
      },
      {
        role: "moderator",
        added: [],
        removed: ["pin-message"],
        next: ["delete-message"],
      },
      {
        role: "user",
        added: [],
        removed: ["pin-message-owner"],
        next: ["send-message"],
      },
    ]);
  });

  it("grants the plain pin permission to an allowed role that has none", () => {
    const changes = computePinGrantChanges(
      messagingSnapshot({
        admin: ["delete-message"],
        channel_member: ["send-message"],
      }),
      permissions,
    );
    expect(changes).toEqual([
      {
        role: "admin",
        added: ["pin-message"],
        removed: [],
        next: ["delete-message", "pin-message"],
      },
      {
        role: "channel_moderator",
        added: ["pin-message"],
        removed: [],
        next: ["pin-message"],
      },
    ]);
  });

  it("is empty once the grants already match", () => {
    expect(
      computePinGrantChanges(
        messagingSnapshot({
          admin: ["pin-message"],
          channel_moderator: ["pin-message"],
          channel_member: ["send-message"],
        }),
        permissions,
      ),
    ).toEqual([]);
  });

  it("refuses a response it does not understand", () => {
    expect(() => parseChannelTypeSnapshot({ name: "messaging" })).toThrow();
    expect(() =>
      computePinGrantChanges(messagingSnapshot(), [
        permission("send-message", "CreateMessage", false),
      ]),
    ).toThrow();
  });
});

describe("pnpm stream:channel-type-grants", () => {
  it("defaults to a dry run that prints the diff and writes nothing", async () => {
    const client = fakeClient([messagingSnapshot()]);
    const stdout = writer();
    const stderr = writer();

    await expect(
      runStreamChannelTypeGrants({
        argv: ["node", "script"],
        environment,
        stdout,
        stderr,
        createClient: () => client,
      }),
    ).resolves.toBe(0);

    expect(client.updateChannelTypeGrants).not.toHaveBeenCalled();
    expect(stdout.contents()).toBe(
      [
        "Stream channel type messaging: pin/unpin grant diff",
        "  channel_member",
        "    - pin-message",
        "  global_admin",
        "    - pin-message-any-team",
        "  moderator",
        "    - pin-message",
        "  user",
        "    - pin-message-owner",
        "Dry run: nothing written; rerun with --apply",
        "",
      ].join("\n"),
    );
    expect(stdout.contents()).not.toContain(environment.STREAM_API_SECRET);
    expect(stderr.contents()).toBe("");
  });

  it("applies only the changed roles and re-reads to confirm", async () => {
    const converged = messagingSnapshot({
      admin: ["pin-message", "delete-message", "update-message"],
      channel_member: ["send-message", "update-message-owner"],
      channel_moderator: ["pin-message", "delete-message", "update-message"],
      global_admin: [],
      moderator: ["delete-message"],
      user: ["send-message"],
      guest: ["send-message"],
    });
    const client = fakeClient([messagingSnapshot(), converged]);
    const stdout = writer();

    await expect(
      runStreamChannelTypeGrants({
        argv: ["node", "script", "--apply"],
        environment,
        stdout,
        stderr: writer(),
        createClient: () => client,
      }),
    ).resolves.toBe(0);

    expect(client.updateChannelTypeGrants).toHaveBeenCalledTimes(1);
    expect(client.updateChannelTypeGrants).toHaveBeenCalledWith(
      messagingSnapshot(),
      {
        channel_member: ["send-message", "update-message-owner"],
        global_admin: [],
        moderator: ["delete-message"],
        user: ["send-message"],
      },
    );
    expect(stdout.contents()).toContain("Applied: 4 role(s) updated");
  });

  it("fails when the write changed grants other than pinning", async () => {
    const collateral = messagingSnapshot({
      admin: ["pin-message", "delete-message", "update-message"],
      channel_member: [],
      channel_moderator: ["pin-message", "delete-message", "update-message"],
      global_admin: [],
      moderator: ["delete-message"],
      user: ["send-message"],
      guest: ["send-message"],
    });
    const client = fakeClient([messagingSnapshot(), collateral]);
    const stderr = writer();
    await expect(
      runStreamChannelTypeGrants({
        argv: ["node", "script", "--apply"],
        environment,
        stdout: writer(),
        stderr,
        createClient: () => client,
      }),
    ).resolves.toBe(1);
    expect(stderr.contents()).toContain(
      "Grants outside pin/unpin changed for: channel_member",
    );
    expect(stderr.contents()).toContain(
      "stream_channel_type_grants_collateral_change",
    );
  });

  it("fails when the re-read still differs", async () => {
    const client = fakeClient([messagingSnapshot()]);
    const stderr = writer();
    await expect(
      runStreamChannelTypeGrants({
        argv: ["node", "script", "--apply"],
        environment,
        stdout: writer(),
        stderr,
        createClient: () => client,
      }),
    ).resolves.toBe(1);
    expect(stderr.contents()).toContain(
      "stream_channel_type_grants_not_converged",
    );
  });

  it("refuses bad arguments and missing credentials before any Stream call", async () => {
    expect(
      parseStreamChannelTypeGrantsArguments(["n", "s", "--apply", "--dry-run"]),
    ).toBeNull();
    expect(
      parseStreamChannelTypeGrantsArguments(["n", "s", "--channel-type", "A!"]),
    ).toBeNull();
    expect(
      parseStreamChannelTypeGrantsArguments([
        "n",
        "s",
        "--channel-type",
        "livestream",
      ]),
    ).toEqual({ mode: "dry-run", channelType: "livestream" });
    const createClient = vi.fn();
    const stderr = writer();
    await expect(
      runStreamChannelTypeGrants({
        argv: ["node", "script", "--apply"],
        environment: {},
        stdout: writer(),
        stderr,
        createClient,
      }),
    ).resolves.toBe(1);
    expect(createClient).not.toHaveBeenCalled();
    expect(stderr.contents()).toContain(
      "stream_channel_type_grants_stream_unconfigured",
    );
  });
});

describe("pnpm stream:channel-type-audit", () => {
  it("prints which roles hold pin, delete-any, and update-any using read-only calls", async () => {
    const client = fakeClient([messagingSnapshot()]);
    const stdout = writer();

    await expect(
      runStreamChannelTypeAudit({
        argv: ["node", "script"],
        environment,
        stdout,
        stderr: writer(),
        createClient: () => client,
      }),
    ).resolves.toBe(0);

    expect(client.getChannelType).toHaveBeenCalledWith("messaging");
    expect(client.updateChannelTypeGrants).not.toHaveBeenCalled();
    expect(stdout.contents()).toBe(
      [
        "Stream channel type: messaging",
        "Roles with grants: admin, channel_member, channel_moderator, global_admin, guest, moderator, user",
        "PinMessage (permission ids: pin-message, pin-message-any-team, pin-message-owner, pin-message-owner-any-team)",
        "  admin: pin-message",
        "  channel_member: pin-message",
        "  channel_moderator: pin-message",
        "  global_admin: pin-message-any-team",
        "  moderator: pin-message",
        "  user: pin-message-owner",
        "UnpinMessage (permission ids: none found)",
        "  granted to: (no role)",
        "DeleteAnyMessage (permission ids: delete-message)",
        "  admin: delete-message",
        "  channel_moderator: delete-message",
        "  moderator: delete-message",
        "UpdateAnyMessage (permission ids: update-message)",
        "  admin: update-message",
        "  channel_moderator: update-message",
        "",
      ].join("\n"),
    );
  });

  it("refuses without credentials", async () => {
    const stderr = writer();
    await expect(
      runStreamChannelTypeAudit({
        argv: ["node", "script"],
        environment: {},
        stdout: writer(),
        stderr,
      }),
    ).resolves.toBe(1);
    expect(stderr.contents()).toContain(
      "stream_channel_type_audit_stream_unconfigured",
    );
  });
});

describe("pnpm community:stream-roles-backfill", () => {
  const communityId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
  const channelId = `loop_community_${communityId.replaceAll("-", "")}`;
  const ownerStream = "loop_6d12a86e413447e69312c5ef75a30f55";
  const adminStream = "loop_f7bf09f6017146b99acd5ad494f211bd";
  const memberStream = "loop_00000000000040008000000000000000";
  const goneStream = "loop_44444444444444448444444444444444";

  function row(
    memberStreamUserId: string,
    desiredChannelRole: "channel_moderator" | "channel_member",
  ): SyncedCommunityChannelMemberRole {
    return {
      communityId,
      ownerUserId: `${memberStreamUserId.slice(5, 13)}-0000-4000-8000-000000000000`,
      streamChannelId: channelId,
      channelCreatedByStreamUserId: ownerStream,
      memberStreamUserId,
      desiredChannelRole,
    };
  }

  function dependencies(): {
    readonly create: CreateCommunityStreamRolesBackfillDependencies;
    readonly readMemberChannelRoles: ReturnType<typeof vi.fn>;
    readonly assignMemberChannelRoles: ReturnType<typeof vi.fn>;
    readonly close: ReturnType<typeof vi.fn>;
  } {
    const rows = [
      row(ownerStream, "channel_moderator"),
      row(adminStream, "channel_moderator"),
      row(memberStream, "channel_member"),
      row(goneStream, "channel_member"),
    ];
    const readMemberChannelRoles = vi.fn(() =>
      Promise.resolve([
        { streamUserId: ownerStream, channelRole: "channel_member" },
        { streamUserId: adminStream, channelRole: "channel_moderator" },
        { streamUserId: memberStream, channelRole: null },
      ]),
    );
    const assignMemberChannelRoles = vi.fn(() => Promise.resolve());
    const close = vi.fn(() => Promise.resolve());
    let served = false;
    return {
      create: () => ({
        members: {
          listSyncedMemberRoles: vi.fn(() => {
            if (served) {
              return Promise.resolve([]);
            }
            served = true;
            return Promise.resolve(rows);
          }),
        },
        gateway: { readMemberChannelRoles, assignMemberChannelRoles },
        close,
        pause: () => Promise.resolve(),
      }),
      readMemberChannelRoles,
      assignMemberChannelRoles,
      close,
    };
  }

  it("dry-runs by default: reads Stream, prints the differences, writes nothing", async () => {
    const deps = dependencies();
    const stdout = writer();

    await expect(
      runCommunityStreamRolesBackfill({
        argv: ["node", "script"],
        environment,
        stdout,
        stderr: writer(),
        createDependencies: deps.create,
      }),
    ).resolves.toBe(0);

    expect(deps.readMemberChannelRoles).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId,
        streamUserIds: [ownerStream, adminStream, memberStream, goneStream],
      }),
    );
    expect(deps.assignMemberChannelRoles).not.toHaveBeenCalled();
    expect(deps.close).toHaveBeenCalledOnce();
    expect(stdout.contents()).toBe(
      [
        `would assign community=${communityId} member=${ownerStream} channel_member -> channel_moderator`,
        `would assign community=${communityId} member=${memberStream} (none) -> channel_member`,
        "Dry run: examined 4 synced members, 1 already match, 2 differ, 1 not in the Stream channel (left to the sync lane), 0 written",
        "Nothing written; rerun with --apply",
        "",
      ].join("\n"),
    );
  });

  it("with --apply assigns exactly the differing members, acting as the channel creator", async () => {
    const deps = dependencies();
    const result = await backfillCommunityStreamRoles(
      {
        mode: "apply",
        databaseUrl: environment.DATABASE_URL,
        stream: { apiKey: "k", apiSecret: "s" },
        maximum: 100,
      },
      deps.create,
    );

    expect(result.applied).toBe(2);
    expect(deps.assignMemberChannelRoles).toHaveBeenCalledTimes(1);
    expect(deps.assignMemberChannelRoles).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId,
        actingStreamUserId: ownerStream,
        assignments: [
          { streamUserId: ownerStream, channelRole: "channel_moderator" },
          { streamUserId: memberStream, channelRole: "channel_member" },
        ],
      }),
    );
  });

  it("refuses bad arguments or missing configuration", async () => {
    for (const [argv, env, code] of [
      [["node", "s", "--apply", "--apply"], environment, "arguments_invalid"],
      [["node", "s", "--max", "0"], environment, "arguments_invalid"],
      [
        ["node", "s"],
        { ...environment, DATABASE_URL: "" },
        "database_unconfigured",
      ],
      [
        ["node", "s"],
        { DATABASE_URL: environment.DATABASE_URL },
        "stream_unconfigured",
      ],
    ] as const) {
      const stderr = writer();
      await expect(
        runCommunityStreamRolesBackfill({
          argv,
          environment: env,
          stdout: writer(),
          stderr,
        }),
      ).resolves.toBe(1);
      expect(stderr.contents()).toContain(
        `community_stream_roles_backfill_${code}`,
      );
    }
  });
});
