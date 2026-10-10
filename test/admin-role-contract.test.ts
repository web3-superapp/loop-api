import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { openApiAdminArtifactPath } from "../scripts/generate-openapi.js";

/**
 * Decision 0109 contract: the committed `openapi/loop-admin.v1.json` names
 * every new operation, requires a UUIDv4 Idempotency-Key on every new
 * write, documents 403 PERMISSION_DENIED on every role-guarded route, and
 * never exposes a signature or password hash field.
 */

interface Operation {
  readonly operationId: string;
  readonly security?: unknown;
  readonly parameters?: readonly {
    readonly in: string;
    readonly name: string;
    readonly required?: boolean;
    readonly schema?: { readonly pattern?: string };
  }[];
  readonly responses: Record<
    string,
    {
      readonly content?: Record<
        string,
        { readonly schema?: Record<string, unknown> }
      >;
    }
  >;
}

async function operations(): Promise<Map<string, Operation>> {
  const document = JSON.parse(
    await readFile(openApiAdminArtifactPath, "utf8"),
  ) as { readonly paths: Record<string, Record<string, Operation>> };
  const result = new Map<string, Operation>();
  for (const [path, methods] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      result.set(`${method.toUpperCase()} ${path}`, operation);
    }
  }
  return result;
}

const writes = [
  "POST /admin/v1/accounts",
  "POST /admin/v1/accounts/{accountId}/disable",
  "POST /admin/v1/accounts/{accountId}/reset-password",
  "POST /admin/v1/accounts/{accountId}/unlock",
  "POST /admin/v1/launch/projects/{projectId}/versions/{version}/approve",
  "POST /admin/v1/launch/projects/{projectId}/testnet-acceptance",
] as const;

const reads = [
  "GET /admin/v1/accounts",
  "GET /admin/v1/launch/projects",
  "GET /admin/v1/launch/projects/{projectId}",
] as const;

describe("Decision 0109 admin artifact", () => {
  it("requires a UUIDv4 Idempotency-Key on every new write", async () => {
    const all = await operations();
    for (const key of writes) {
      const operation = all.get(key);
      expect(operation, key).toBeDefined();
      const header = operation?.parameters?.find(
        (parameter) =>
          parameter.in === "header" && parameter.name === "idempotency-key",
      );
      expect(header?.required, key).toBe(true);
      expect(header?.schema?.pattern, key).toContain("4[0-9a-f]{3}");
    }
  });

  it("documents 403 PERMISSION_DENIED on every role-guarded route", async () => {
    const all = await operations();
    const guarded = [
      ...writes,
      ...reads,
      "GET /admin/v1/overview",
      "GET /admin/v1/audit",
      "PUT /admin/v1/settings/recommended-communities",
      "POST /admin/v1/mining/formula-versions/{configVersion}/approve",
    ];
    for (const key of guarded) {
      const operation = all.get(key);
      expect(operation?.security, key).toEqual([{ adminSession: [] }]);
      const forbidden =
        operation?.responses["403"]?.content?.["application/json"]?.schema;
      const properties = forbidden?.["properties"] as
        Record<string, { enum?: string[] } | undefined> | undefined;
      const codes = properties?.["code"]?.enum ?? [];
      expect(codes, key).toContain("PERMISSION_DENIED");
    }
    // The password change and the session read are open to any session.
    expect(
      all.get("POST /admin/v1/session/password")?.responses["403"],
    ).toBeUndefined();
  });

  it("never publishes a signature or a password hash field", async () => {
    const text = await readFile(openApiAdminArtifactPath, "utf8");
    for (const forbidden of [
      '"signature"',
      '"signedPayload"',
      '"passwordHash"',
      '"password_hash"',
    ]) {
      expect(text).not.toContain(forbidden);
    }
    const all = await operations();
    const detail = JSON.stringify(
      all.get("GET /admin/v1/launch/projects/{projectId}")?.responses["200"],
    );
    for (const field of [
      "predictedMemeAddress",
      "predictedHookAddress",
      "testnetAcceptances",
      "snapshotPublications",
      "buybackAttempts",
      "approval",
    ]) {
      expect(detail).toContain(field);
    }
  });

  it("publishes the role and permission enums on the session", async () => {
    const all = await operations();
    const session = JSON.stringify(
      all.get("GET /admin/v1/session")?.responses["200"],
    );
    for (const value of [
      "platform_admin",
      "reviewer",
      "testnet_acceptor",
      "auditor",
      "launch.approve",
      "testnet.accept",
      "passwordChangeRequired",
    ]) {
      expect(session).toContain(value);
    }
  });
});

describe("Decision 0111 admin artifact", () => {
  it("publishes the unlock route with its body, conflicts, and the lock fields", async () => {
    const all = await operations();
    const unlock = all.get("POST /admin/v1/accounts/{accountId}/unlock");
    expect(unlock?.operationId).toBe("unlockAdminAccount");
    const conflict =
      unlock?.responses["409"]?.content?.["application/json"]?.schema;
    expect(JSON.stringify(conflict)).toContain("ADMIN_CONFLICT");
    expect(Object.keys(unlock?.responses ?? {})).toEqual(
      expect.arrayContaining(["200", "400", "401", "403", "404", "409", "422"]),
    );
    const text = JSON.stringify(unlock);
    expect(text).toContain("reasonCode");
    expect(text).toContain("ADMIN_ACCOUNT_ENVIRONMENT");
    for (const key of [
      "GET /admin/v1/accounts",
      "POST /admin/v1/accounts/{accountId}/unlock",
      "POST /admin/v1/accounts/{accountId}/disable",
    ]) {
      const ok = JSON.stringify(all.get(key)?.responses["200"]);
      expect(ok, key).toContain('"lockedUntil"');
      expect(ok, key).toContain('"locked"');
    }
  });
});
