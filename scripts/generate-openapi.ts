import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { format } from "prettier";

import { buildApp } from "../src/app.js";
import { loadConfig, v2ModuleIds } from "../src/config.js";
import { createUnavailableAlertRepository } from "../src/database/alert-repository.js";
import { createUnavailableAgentAuthorizationRepository } from "../src/database/agent-authorization-repository.js";
import { createUnavailableControlPlaneRepository } from "../src/database/control-plane-repository.js";
import type { Database } from "../src/database/database.js";
import { createUnavailablePerpIntentRepository } from "../src/database/perp-intent-repository.js";
import { createUnavailablePerpWalletBindingRepository } from "../src/database/perp-wallet-binding-repository.js";
import { createUnavailableProfileRepository } from "../src/database/profile-repository.js";
import { createUnavailableWatchlistRepository } from "../src/database/watchlist-repository.js";
import { createUnavailableDeviceSessionRepository } from "../src/features/session/device-session-repository.js";
import { createUnavailablePrivyAccessTokenVerifier } from "../src/integrations/privy/access-token-verifier.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const openApiArtifactPath = resolve(
  repositoryRoot,
  "openapi/loop-api.v1.json",
);
export const openApiV2ArtifactPath = resolve(
  repositoryRoot,
  "openapi/loop-api.v2.json",
);
/**
 * Decision 0147: the public MEME page read surface (`/public/v1/*`), outside
 * the frozen V1 artifact and the V2 artifact.
 */
export const openApiPublicArtifactPath = resolve(
  repositoryRoot,
  "openapi/loop-public.v1.json",
);
/**
 * Decision 0179: the website's registration surface (`/v2/web/*`), outside
 * the App's V2 artifact.
 */
export const openApiWebArtifactPath = resolve(
  repositoryRoot,
  "openapi/loop-web.v2.json",
);
/** Decision 0102: the operator console surface, never part of the V2 artifact. */
export const openApiAdminArtifactPath = resolve(
  repositoryRoot,
  "openapi/loop-admin.v1.json",
);

/**
 * Schema-only console credentials: a well-formed but meaningless argon2id
 * PHC string and secret, so the generator can mount `/admin/v1/*`. Nothing
 * here can log anybody in; the generator never serves a request.
 */
const schemaOnlyAdminEnvironment = Object.freeze({
  ADMIN_USERNAME: "schema-only",
  ADMIN_PASSWORD_HASH:
    "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  ADMIN_SESSION_SECRET: "schema-only-admin-session-secret-not-a-credential",
});

function schemaOnlyDependencyInvoked(): never {
  throw new Error("Schema-only dependency invoked");
}

function createSchemaOnlyDatabase(): Database {
  return {
    alerts: createUnavailableAlertRepository(),
    agentAuthorizations: createUnavailableAgentAuthorizationRepository(),
    controlPlane: createUnavailableControlPlaneRepository(),
    perpWalletBindings: createUnavailablePerpWalletBindingRepository(),
    perpIntents: createUnavailablePerpIntentRepository(),
    deviceSessions: createUnavailableDeviceSessionRepository(),
    profiles: createUnavailableProfileRepository(),
    watchlists: createUnavailableWatchlistRepository(),
    internalUsers: {
      findByPrivyUserId: schemaOnlyDependencyInvoked,
      getOrCreateByPrivyUserId: schemaOnlyDependencyInvoked,
    },
    ping: schemaOnlyDependencyInvoked,
    close: () => Promise.resolve(),
  };
}

async function renderContractSurface(
  contractSurface: "v1" | "v2" | "admin" | "public" | "web",
): Promise<string> {
  const config = loadConfig({
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: "3000",
    PUBLIC_BASE_URL: "https://api-dev.quant-dinger.cc",
    API_DOCS_ENABLED: "false",
    TRUST_PROXY: "false",
    LOG_LEVEL: "silent",
    // Every module ID is enabled so each delivered registrar contributes its
    // routes to the V2 artifact; modules without a registrar add nothing.
    V2_MODULES_ENABLED: v2ModuleIds.join(","),
    DATABASE_URL: "postgres://schema_only@127.0.0.1:5432/loop_api_schema",
    ...(contractSurface === "admin" ? schemaOnlyAdminEnvironment : {}),
  });
  const app = await buildApp({
    config,
    contractSurface,
    database: createSchemaOnlyDatabase(),
    privyAccessTokenVerifier: createUnavailablePrivyAccessTokenVerifier(),
    logger: false,
  });

  try {
    await app.ready();
    return await format(JSON.stringify(app.swagger()), { parser: "json" });
  } finally {
    await app.close();
  }
}

export function renderOpenApiArtifact(): Promise<string> {
  return renderContractSurface("v1");
}

export function renderOpenApiV2Artifact(): Promise<string> {
  return renderContractSurface("v2");
}

export function renderOpenApiAdminArtifact(): Promise<string> {
  return renderContractSurface("admin");
}

export function renderOpenApiPublicArtifact(): Promise<string> {
  return renderContractSurface("public");
}

export function renderOpenApiWebArtifact(): Promise<string> {
  return renderContractSurface("web");
}

async function writeArtifact(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporaryPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function checkArtifact(path: string, contents: string): Promise<void> {
  let committed: string;

  try {
    committed = await readFile(path, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      throw new Error(
        `OpenAPI artifact ${path} is missing. Run pnpm openapi:generate.`,
        { cause: error },
      );
    }

    throw error;
  }

  if (committed !== contents) {
    throw new Error(
      `OpenAPI artifact ${path} is stale. Run pnpm openapi:generate and commit the result.`,
    );
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];

  if (mode !== "--write" && mode !== "--check") {
    throw new Error("Expected exactly one argument: --write or --check");
  }

  if (process.argv.length !== 3) {
    throw new Error("Unexpected OpenAPI generator arguments");
  }

  const [v1Contents, v2Contents, adminContents, publicContents, webContents] =
    await Promise.all([
      renderOpenApiArtifact(),
      renderOpenApiV2Artifact(),
      renderOpenApiAdminArtifact(),
      renderOpenApiPublicArtifact(),
      renderOpenApiWebArtifact(),
    ]);

  if (mode === "--write") {
    await Promise.all([
      writeArtifact(openApiArtifactPath, v1Contents),
      writeArtifact(openApiV2ArtifactPath, v2Contents),
      writeArtifact(openApiAdminArtifactPath, adminContents),
      writeArtifact(openApiPublicArtifactPath, publicContents),
      writeArtifact(openApiWebArtifactPath, webContents),
    ]);
    process.stdout.write(
      "Generated openapi/loop-api.v1.json, openapi/loop-api.v2.json, openapi/loop-admin.v1.json, openapi/loop-public.v1.json, and openapi/loop-web.v2.json\n",
    );
    return;
  }

  await Promise.all([
    checkArtifact(openApiArtifactPath, v1Contents),
    checkArtifact(openApiV2ArtifactPath, v2Contents),
    checkArtifact(openApiAdminArtifactPath, adminContents),
    checkArtifact(openApiPublicArtifactPath, publicContents),
    checkArtifact(openApiWebArtifactPath, webContents),
  ]);
  process.stdout.write("OpenAPI artifacts are current\n");
}

const directEntryPoint = process.argv[1];

if (
  directEntryPoint !== undefined &&
  resolve(directEntryPoint) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
