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

export const openApiOpsArtifactPath = resolve(
  repositoryRoot,
  "openapi/loop-api.ops.json",
);

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
  contractSurface: "v1" | "v2" | "ops",
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
  });
  const app = await buildApp({
    config,
    contractSurface: contractSurface === "ops" ? "runtime" : contractSurface,
    database: createSchemaOnlyDatabase(),
    privyAccessTokenVerifier: createUnavailablePrivyAccessTokenVerifier(),
    logger: false,
  });

  try {
    await app.ready();
    const doc = app.swagger();
    if (contractSurface === "ops") {
      doc.paths = Object.fromEntries(
        Object.entries(doc.paths ?? {}).filter(([path]) =>
          path.startsWith("/ops/api/"),
        ),
      );
      doc.tags = [
        {
          name: "Operations",
          description: "Development operations with scoped server grants",
        },
      ];
      doc.info = { ...doc.info, title: "LOOP Operations API" };
    }
    return await format(JSON.stringify(doc), { parser: "json" });
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

export function renderOpenApiOpsArtifact(): Promise<string> {
  return renderContractSurface("ops");
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

  const [v1Contents, v2Contents, opsContents] = await Promise.all([
    renderOpenApiArtifact(),
    renderOpenApiV2Artifact(),
    renderOpenApiOpsArtifact(),
  ]);

  if (mode === "--write") {
    await Promise.all([
      writeArtifact(openApiArtifactPath, v1Contents),
      writeArtifact(openApiV2ArtifactPath, v2Contents),
      writeArtifact(openApiOpsArtifactPath, opsContents),
    ]);
    process.stdout.write("Generated V1, V2 and Operations OpenAPI artifacts\n");
    return;
  }

  await Promise.all([
    checkArtifact(openApiArtifactPath, v1Contents),
    checkArtifact(openApiV2ArtifactPath, v2Contents),
    checkArtifact(openApiOpsArtifactPath, opsContents),
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
