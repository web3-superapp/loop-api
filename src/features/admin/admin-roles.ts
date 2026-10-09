import type { HooksLaunchOpsPermission } from "../launch/hooks-launch-review.js";

/**
 * Decision 0109: operator console roles and the permissions derived from
 * them. A role is fixed when the account is created; permissions are never
 * stored per account, so the table below is the whole policy.
 *
 * Separation of duties (LOOP-整体方案 §7): editing, approving, and executing
 * are different people. The platform administrator manages the console and
 * accounts but holds neither `launch.approve` nor `testnet.accept`; only a
 * reviewer approves and only a testnet acceptor accepts, each bound to one
 * LOOP user whose `ops_grants` the Hooks review service checks again.
 *
 * Decision 0110: the mining formula follows the same split. The platform
 * administrator drafts, submits, and withdraws a formula version
 * (`console.write`); only a reviewer approves it (`formula.approve`), and
 * the approval is refused when the reviewer is the draft's author.
 */

export const adminRoles = Object.freeze([
  "platform_admin",
  "reviewer",
  "testnet_acceptor",
  "auditor",
] as const);
export type AdminRole = (typeof adminRoles)[number];

export const adminPermissions = Object.freeze([
  "console.read",
  "console.write",
  "accounts.read",
  "accounts.manage",
  "audit.read",
  "launch.read",
  "launch.approve",
  "testnet.read",
  "testnet.accept",
  "formula.approve",
] as const);
export type AdminPermission = (typeof adminPermissions)[number];

const rolePermissions: Readonly<Record<AdminRole, readonly AdminPermission[]>> =
  Object.freeze({
    platform_admin: Object.freeze([
      "console.read",
      "console.write",
      "accounts.read",
      "accounts.manage",
      "audit.read",
      "launch.read",
      "testnet.read",
    ] as const),
    reviewer: Object.freeze([
      "launch.read",
      "launch.approve",
      "formula.approve",
      "audit.read",
    ] as const),
    testnet_acceptor: Object.freeze([
      "launch.read",
      "testnet.read",
      "testnet.accept",
      "audit.read",
    ] as const),
    auditor: Object.freeze([
      "console.read",
      "accounts.read",
      "audit.read",
      "launch.read",
      "testnet.read",
    ] as const),
  });

/** Roles that must be bound to a LOOP user (an `ops_operators` row). */
export const adminOperatorRoles: ReadonlySet<AdminRole> = new Set([
  "reviewer",
  "testnet_acceptor",
]);

/** The `ops_grants` a bound role derives (Decision 0108 permission names). */
const roleOpsGrants: Readonly<
  Record<"reviewer" | "testnet_acceptor", readonly HooksLaunchOpsPermission[]>
> = Object.freeze({
  reviewer: Object.freeze([
    "launch.read",
    "launch.approve",
    "audit.read",
  ] as const),
  testnet_acceptor: Object.freeze([
    "launch.read",
    "testnet.read",
    "testnet.accept",
    "audit.read",
  ] as const),
});

export function isAdminRole(value: unknown): value is AdminRole {
  return (
    typeof value === "string" &&
    (adminRoles as readonly string[]).includes(value)
  );
}

/** Sorted permission list of a role (what `GET /session` publishes). */
export function adminRolePermissions(
  role: AdminRole,
): readonly AdminPermission[] {
  return Object.freeze([...rolePermissions[role]].sort());
}

export function adminRoleHasPermission(
  role: AdminRole,
  permission: AdminPermission,
): boolean {
  return rolePermissions[role].includes(permission);
}

export interface AdminOpsGrant {
  readonly permission: HooksLaunchOpsPermission;
  readonly scope: string;
}

/**
 * The exact `ops_grants` rows a bound role holds. `projectIds` null = every
 * project (`*`); otherwise each project permission is scoped to each listed
 * project, and `audit.read` (not project-scopable) stays `*`.
 */
export function adminRoleOpsGrants(
  role: AdminRole,
  projectIds: readonly string[] | null,
): readonly AdminOpsGrant[] {
  if (role !== "reviewer" && role !== "testnet_acceptor") {
    return Object.freeze([]);
  }
  const grants: AdminOpsGrant[] = [];
  for (const permission of roleOpsGrants[role]) {
    if (permission === "audit.read" || projectIds === null) {
      grants.push({ permission, scope: "*" });
      continue;
    }
    for (const projectId of projectIds) {
      grants.push({ permission, scope: projectId });
    }
  }
  return Object.freeze(
    grants.sort((left, right) =>
      left.permission === right.permission
        ? left.scope < right.scope
          ? -1
          : left.scope > right.scope
            ? 1
            : 0
        : left.permission < right.permission
          ? -1
          : 1,
    ),
  );
}
