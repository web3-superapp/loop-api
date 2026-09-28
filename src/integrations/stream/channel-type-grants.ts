import { StreamClient } from "@stream-io/node-sdk";

/**
 * Decision 0091: the Stream channel-type permission grants that govern
 * message pinning in the official community channel.
 *
 * Every LOOP chat channel — official community, friend group, and direct —
 * is the Stream `messaging` channel type (Decisions 0025 and 0032), so the
 * grants of that one type decide who may pin in all three.
 *
 * This module holds only pure computation plus a narrow client seam. The
 * audit reads (`getChannelType`, `listPermissions`); only the grants script
 * with an explicit `--apply` calls `updateChannelType`.
 */

export const LOOP_CHAT_STREAM_CHANNEL_TYPE = "messaging";

/** Stream channel roles LOOP assigns to community channel members. */
export const STREAM_CHANNEL_MODERATOR_ROLE = "channel_moderator";
export const STREAM_CHANNEL_MEMBER_ROLE = "channel_member";

/** Actions the audit reports. Pin and unpin are the ones this decision changes. */
export const AUDITED_STREAM_ACTIONS = Object.freeze([
  "PinMessage",
  "UnpinMessage",
  "DeleteAnyMessage",
  "UpdateAnyMessage",
] as const);
export type AuditedStreamAction = (typeof AUDITED_STREAM_ACTIONS)[number];

/** Actions whose grants the grants script rewrites. */
export const PIN_STREAM_ACTIONS = Object.freeze([
  "PinMessage",
  "UnpinMessage",
] as const);

/**
 * Roles that must hold pin/unpin after the grants script (main-agent ruling
 * 2026-09-28): the channel moderator (community owner/admin, friend-group
 * creator) and the Stream app `admin`.
 */
export const PIN_REQUIRED_ROLES = Object.freeze([
  "admin",
  STREAM_CHANNEL_MODERATOR_ROLE,
] as const);

/**
 * Roles that lose every pin/unpin variant: the channel member and the app
 * role every LOOP user carries (`user` held `pin-message-owner`). Every
 * other role — `moderator`, `global_admin`, `global_moderator`, … — keeps its
 * pin grants unchanged for a future operator console.
 */
export const PIN_REVOKED_ROLES = Object.freeze([
  STREAM_CHANNEL_MEMBER_ROLE,
  "user",
] as const);

export interface StreamPermissionDescriptor {
  readonly id: string;
  readonly action: string;
  readonly owner: boolean;
  readonly level: string;
}

export interface StreamChannelTypeSnapshot {
  readonly name: string;
  readonly grants: Readonly<Record<string, readonly string[]>>;
  /** Required by `updateChannelType`; carried unchanged. */
  readonly automod: string;
  readonly automodBehavior: string;
  readonly maxMessageLength: number;
}

/**
 * The narrow Stream surface the audit and the grants script need. The two
 * reads are safe against any environment; `updateChannelTypeGrants` writes.
 */
export interface StreamChannelTypeClient {
  readonly getChannelType: (name: string) => Promise<StreamChannelTypeSnapshot>;
  readonly listPermissions: () => Promise<
    readonly StreamPermissionDescriptor[]
  >;
  readonly updateChannelTypeGrants: (
    snapshot: StreamChannelTypeSnapshot,
    grants: Readonly<Record<string, readonly string[]>>,
  ) => Promise<void>;
}

export class StreamChannelTypeResponseError extends Error {
  constructor() {
    super("Stream channel type response was not understood");
    this.name = "StreamChannelTypeResponseError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseGrants(value: unknown): Record<string, readonly string[]> {
  if (!isRecord(value)) {
    throw new StreamChannelTypeResponseError();
  }
  const grants: Record<string, readonly string[]> = {};
  for (const [role, ids] of Object.entries(value)) {
    if (
      !Array.isArray(ids) ||
      !(ids as unknown[]).every((id) => typeof id === "string")
    ) {
      throw new StreamChannelTypeResponseError();
    }
    grants[role] = Object.freeze([...(ids as string[])]);
  }
  return grants;
}

export function parseChannelTypeSnapshot(
  value: unknown,
): StreamChannelTypeSnapshot {
  if (
    !isRecord(value) ||
    typeof value["name"] !== "string" ||
    typeof value["automod"] !== "string" ||
    typeof value["automod_behavior"] !== "string" ||
    typeof value["max_message_length"] !== "number"
  ) {
    throw new StreamChannelTypeResponseError();
  }
  return Object.freeze({
    name: value["name"],
    grants: Object.freeze(parseGrants(value["grants"])),
    automod: value["automod"],
    automodBehavior: value["automod_behavior"],
    maxMessageLength: value["max_message_length"],
  });
}

export function parsePermissionList(
  value: unknown,
): readonly StreamPermissionDescriptor[] {
  if (!isRecord(value) || !Array.isArray(value["permissions"])) {
    throw new StreamChannelTypeResponseError();
  }
  return Object.freeze(
    (value["permissions"] as unknown[]).map((permission) => {
      if (
        !isRecord(permission) ||
        typeof permission["id"] !== "string" ||
        typeof permission["action"] !== "string" ||
        typeof permission["owner"] !== "boolean" ||
        typeof permission["level"] !== "string"
      ) {
        throw new StreamChannelTypeResponseError();
      }
      return Object.freeze({
        id: permission["id"],
        action: permission["action"],
        owner: permission["owner"],
        level: permission["level"],
      });
    }),
  );
}

export function createStreamChannelTypeClient(credentials: {
  readonly apiKey: string;
  readonly apiSecret: string;
}): StreamChannelTypeClient {
  const client = new StreamClient(credentials.apiKey, credentials.apiSecret, {
    timeout: 10_000,
  });
  return Object.freeze({
    async getChannelType(name: string): Promise<StreamChannelTypeSnapshot> {
      return parseChannelTypeSnapshot(
        await client.chat.getChannelType({ name }),
      );
    },
    async listPermissions(): Promise<readonly StreamPermissionDescriptor[]> {
      return parsePermissionList(await client.listPermissions());
    },
    async updateChannelTypeGrants(
      snapshot: StreamChannelTypeSnapshot,
      grants: Readonly<Record<string, readonly string[]>>,
    ): Promise<void> {
      await client.chat.updateChannelType({
        name: snapshot.name,
        automod: snapshot.automod as "disabled" | "simple" | "AI",
        automod_behavior: snapshot.automodBehavior as
          "flag" | "block" | "shadow_block",
        max_message_length: snapshot.maxMessageLength,
        grants: Object.fromEntries(
          Object.entries(grants).map(([role, ids]) => [role, [...ids]]),
        ),
      });
    },
  });
}

/**
 * Stream names the "any message" variants of update/delete by the
 * non-owner permission of the `UpdateMessage`/`DeleteMessage` action. The
 * audit resolves each audited action to the permission IDs that implement it.
 */
export function permissionIdsForAction(
  action: AuditedStreamAction,
  permissions: readonly StreamPermissionDescriptor[],
): readonly string[] {
  const matches = permissions.filter((permission) => {
    switch (action) {
      case "PinMessage":
      case "UnpinMessage":
        return permission.action === action;
      case "DeleteAnyMessage":
        return (
          permission.action === "DeleteAnyMessage" ||
          (permission.action === "DeleteMessage" && !permission.owner)
        );
      case "UpdateAnyMessage":
        return (
          permission.action === "UpdateAnyMessage" ||
          (permission.action === "UpdateMessage" && !permission.owner)
        );
    }
    return false;
  });
  return Object.freeze(matches.map((permission) => permission.id).sort());
}

export interface ChannelTypeActionAudit {
  readonly action: AuditedStreamAction;
  readonly permissionIds: readonly string[];
  /** Role → the subset of `permissionIds` granted to it, only non-empty roles. */
  readonly grantedRoles: Readonly<Record<string, readonly string[]>>;
}

export interface ChannelTypeAudit {
  readonly channelType: string;
  readonly roles: readonly string[];
  readonly actions: readonly ChannelTypeActionAudit[];
}

export function auditChannelType(
  snapshot: StreamChannelTypeSnapshot,
  permissions: readonly StreamPermissionDescriptor[],
): ChannelTypeAudit {
  const roles = Object.keys(snapshot.grants).sort();
  return Object.freeze({
    channelType: snapshot.name,
    roles: Object.freeze(roles),
    actions: Object.freeze(
      AUDITED_STREAM_ACTIONS.map((action) => {
        const permissionIds = permissionIdsForAction(action, permissions);
        const wanted = new Set(permissionIds);
        const grantedRoles: Record<string, readonly string[]> = {};
        for (const role of roles) {
          const granted = (snapshot.grants[role] ?? [])
            .filter((id) => wanted.has(id))
            .sort();
          if (granted.length > 0) {
            grantedRoles[role] = Object.freeze(granted);
          }
        }
        return Object.freeze({
          action,
          permissionIds,
          grantedRoles: Object.freeze(grantedRoles),
        });
      }),
    ),
  });
}

export function formatChannelTypeAudit(audit: ChannelTypeAudit): string {
  const lines = [
    `Stream channel type: ${audit.channelType}`,
    `Roles with grants: ${audit.roles.join(", ") || "(none)"}`,
  ];
  for (const action of audit.actions) {
    lines.push(
      `${action.action} (permission ids: ${action.permissionIds.join(", ") || "none found"})`,
    );
    const entries = Object.entries(action.grantedRoles);
    if (entries.length === 0) {
      lines.push("  granted to: (no role)");
    }
    for (const [role, ids] of entries) {
      lines.push(`  ${role}: ${ids.join(", ")}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export interface RoleGrantChange {
  readonly role: string;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  /** The complete grant list for the role after the change. */
  readonly next: readonly string[];
}

/**
 * Pin/unpin grants after Decision 0091 (ruling 2026-09-28): every variant
 * (owner, any message, any team) of `PinMessage`/`UnpinMessage` is removed
 * from `PIN_REVOKED_ROLES`; each of `PIN_REQUIRED_ROLES` keeps (or, when it
 * has none, gets) a non-owner pin permission. Every other role, and every
 * other permission of every role, is left exactly as it was. Stream
 * publishes no separate `UnpinMessage` permission today — unpinning is
 * governed by the same `pin-message` grant — but one that appears later is
 * covered by the same rule.
 *
 * Only roles that change are returned; `updateChannelType` receives exactly
 * those roles with their complete next list, so untouched roles are never
 * sent.
 */
export function computePinGrantChanges(
  snapshot: StreamChannelTypeSnapshot,
  permissions: readonly StreamPermissionDescriptor[],
): readonly RoleGrantChange[] {
  const pinIds = pinPermissionIds(permissions);
  // A required role needs one non-owner ("any message") pin permission.
  // Stream also publishes `*-any-team` variants for multi-tenant apps; LOOP
  // uses no teams, so the plain one is preferred and added only when the
  // role holds no non-owner pin permission at all.
  const anyMessagePin = permissions
    .filter(
      (permission) =>
        permission.action === "PinMessage" &&
        !permission.owner &&
        permission.level === "channel",
    )
    .map((permission) => permission.id)
    .sort(
      (left, right) =>
        Number(left.endsWith("-any-team")) -
          Number(right.endsWith("-any-team")) || left.localeCompare(right),
    );
  const anyMessagePinIds = new Set(anyMessagePin);
  const preferredPinId = anyMessagePin[0];
  if (preferredPinId === undefined) {
    throw new StreamChannelTypeResponseError();
  }
  const required = new Set<string>(PIN_REQUIRED_ROLES);
  const revoked = new Set<string>(PIN_REVOKED_ROLES);
  const roles = [...new Set([...required, ...revoked])].sort();
  const changes: RoleGrantChange[] = [];
  for (const role of roles) {
    const current = snapshot.grants[role] ?? [];
    let next: string[];
    if (required.has(role)) {
      next = current.some((id) => anyMessagePinIds.has(id))
        ? [...current]
        : [...current, preferredPinId];
    } else {
      next = current.filter((id) => !pinIds.has(id));
    }
    const added = next.filter((id) => !current.includes(id)).sort();
    const removed = current.filter((id) => !next.includes(id)).sort();
    if (added.length > 0 || removed.length > 0) {
      changes.push(
        Object.freeze({
          role,
          added: Object.freeze(added),
          removed: Object.freeze(removed),
          next: Object.freeze(next),
        }),
      );
    }
  }
  return Object.freeze(changes);
}

function pinPermissionIds(
  permissions: readonly StreamPermissionDescriptor[],
): ReadonlySet<string> {
  return new Set(
    permissions
      .filter((permission) =>
        (PIN_STREAM_ACTIONS as readonly string[]).includes(permission.action),
      )
      .map((permission) => permission.id),
  );
}

export function formatPinGrantChanges(
  channelType: string,
  changes: readonly RoleGrantChange[],
): string {
  if (changes.length === 0) {
    return `Stream channel type ${channelType}: pin/unpin grants already match Decision 0091; nothing to change\n`;
  }
  const lines = [`Stream channel type ${channelType}: pin/unpin grant diff`];
  for (const change of changes) {
    lines.push(`  ${change.role}`);
    for (const id of change.added) {
      lines.push(`    + ${id}`);
    }
    for (const id of change.removed) {
      lines.push(`    - ${id}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Roles whose grants after `--apply` differ from what the write intended:
 * `before` with exactly `changes` applied. Any other difference — a non-pin
 * grant of any role, or the pin grant of a role the rule leaves alone
 * (`moderator`, `global_*`) — is collateral (Stream replaces the whole list
 * of every role it is sent, so this proves nothing else moved).
 */
export function rolesWithCollateralGrantChanges(
  before: StreamChannelTypeSnapshot,
  after: StreamChannelTypeSnapshot,
  changes: readonly RoleGrantChange[],
): readonly string[] {
  const intended = new Map<string, readonly string[]>(
    Object.entries(before.grants),
  );
  for (const change of changes) {
    intended.set(change.role, change.next);
  }
  const normalized = (ids: readonly string[] | undefined): string =>
    [...new Set(ids ?? [])].sort().join(",");
  const roles = new Set([...intended.keys(), ...Object.keys(after.grants)]);
  return Object.freeze(
    [...roles]
      .filter(
        (role) =>
          normalized(intended.get(role)) !== normalized(after.grants[role]),
      )
      .sort(),
  );
}
