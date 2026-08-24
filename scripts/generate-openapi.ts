import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { format } from "prettier";

import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createUnavailableControlPlaneRepository } from "../src/database/control-plane-repository.js";
import type { Database } from "../src/database/database.js";
import { createUnavailablePerpIntentRepository } from "../src/database/perp-intent-repository.js";
import { createUnavailablePrivyAccessTokenVerifier } from "../src/integrations/privy/access-token-verifier.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const openApiArtifactPath = resolve(
  repositoryRoot,
  "openapi/loop-api.v1.json",
);

function schemaOnlyDependencyInvoked(): never {
  throw new Error("Schema-only dependency invoked");
}

function createSchemaOnlyDatabase(): Database {
  return {
    controlPlane: createUnavailableControlPlaneRepository(),
    perpIntents: createUnavailablePerpIntentRepository(),
    internalUsers: {
      findByPrivyUserId: schemaOnlyDependencyInvoked,
      getOrCreateByPrivyUserId: schemaOnlyDependencyInvoked,
    },
    ping: schemaOnlyDependencyInvoked,
    close: () => Promise.resolve(),
  };
}

export async function renderOpenApiArtifact(): Promise<string> {
  const config = loadConfig({
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: "3000",
    PUBLIC_BASE_URL: "https://api-dev.quant-dinger.cc",
    API_DOCS_ENABLED: "false",
    TRUST_PROXY: "false",
    LOG_LEVEL: "silent",
    DATABASE_URL: "postgres://schema_only@127.0.0.1:5432/loop_api_schema",
  });
  const app = await buildApp({
    config,
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

async function writeArtifact(contents: string): Promise<void> {
  await mkdir(dirname(openApiArtifactPath), { recursive: true });
  const temporaryPath = `${openApiArtifactPath}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporaryPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, openApiArtifactPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function checkArtifact(contents: string): Promise<void> {
  let committed: string;

  try {
    committed = await readFile(openApiArtifactPath, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      throw new Error(
        "OpenAPI artifact is missing. Run pnpm openapi:generate.",
        { cause: error },
      );
    }

    throw error;
  }

  if (committed !== contents) {
    throw new Error(
      "OpenAPI artifact is stale. Run pnpm openapi:generate and commit the result.",
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

  const contents = await renderOpenApiArtifact();

  if (mode === "--write") {
    await writeArtifact(contents);
    process.stdout.write("Generated openapi/loop-api.v1.json\n");
    return;
  }

  await checkArtifact(contents);
  process.stdout.write("OpenAPI artifact is current\n");
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
