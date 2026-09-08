/**
 * Open-source attribution summary published by `GET /v2/meta/about`
 * (Decision 0037). The rows mirror the register table in
 * `docs/open-source-attribution.md`; `test/v2-meta-about.test.ts` parses that
 * document and fails when the two drift, so the runtime never reads the
 * repository file (the Docker runtime image does not ship `docs/`).
 */

export interface OpenSourceAttributionEntry {
  readonly name: string;
  readonly version: string;
  readonly purpose: string;
  readonly license: string;
}

export const openSourceAttributionSource =
  "docs/open-source-attribution.md" as const;

export const openSourceAttributionSummary =
  "This register covers the direct runtime and verification dependencies introduced by the Node backend foundation. The exact transitive graph and integrity hashes are recorded in `pnpm-lock.yaml`." as const;

export const openSourceAttributionEntries: readonly OpenSourceAttributionEntry[] =
  Object.freeze([
    {
      name: "Fastify",
      version: "5.12.1",
      purpose: "HTTP server and route lifecycle",
      license: "MIT",
    },
    {
      name: "@fastify/swagger",
      version: "9.8.1",
      purpose: "OpenAPI 3.1 generation",
      license: "MIT",
    },
    {
      name: "@fastify/helmet",
      version: "13.1.1",
      purpose: "HTTP security headers",
      license: "MIT",
    },
    {
      name: "@privy-io/node",
      version: "0.29.0",
      purpose: "Privy token and user/wallet reads",
      license: "Apache-2.0",
    },
    {
      name: "@stream-io/node-sdk",
      version: "0.7.63",
      purpose: "Stream Chat/Video user-token signing",
      license: "Proprietary Stream SCLA",
    },
    {
      name: "pg",
      version: "8.23.0",
      purpose: "PostgreSQL driver and pooling",
      license: "MIT",
    },
    {
      name: "Zod",
      version: "4.4.3",
      purpose: "Fail-closed environment validation",
      license: "MIT",
    },
    {
      name: "node-pg-migrate",
      version: "9.0.0",
      purpose: "PostgreSQL schema migrations",
      license: "MIT",
    },
    {
      name: "Vitest",
      version: "4.1.11",
      purpose: "Behavior and contract tests",
      license: "MIT",
    },
    {
      name: "TypeScript",
      version: "6.0.3",
      purpose: "Static typing and compilation",
      license: "Apache-2.0",
    },
    {
      name: "ESLint",
      version: "10.9.0",
      purpose: "Static analysis",
      license: "MIT",
    },
    {
      name: "Prettier",
      version: "3.9.6",
      purpose: "Deterministic source formatting",
      license: "MIT",
    },
    {
      name: "tsx",
      version: "4.23.12",
      purpose: "Local TypeScript execution/watch",
      license: "MIT",
    },
    {
      name: "lossless-json",
      version: "4.3.1",
      purpose: "Lossless provider JSON numbers",
      license: "MIT",
    },
    {
      name: "Hyperliquid Python SDK",
      version: "0.24.0",
      purpose: "Offline signing-conformance oracle only",
      license: "MIT",
    },
    {
      name: "@nktkas/hyperliquid",
      version: "0.33.3",
      purpose: "Low-level Spot L1 canonicalize/sign only",
      license: "MIT",
    },
    {
      name: "viem",
      version: "2.44.2",
      purpose: "EIP-712 signature recovery",
      license: "MIT",
    },
  ]);
