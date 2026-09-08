/**
 * Open-source attribution summary published by `GET /v2/meta/about`
 * (Decision 0037). The rows mirror the register table in
 * `docs/open-source-attribution.md` by name, purpose, and license (versions
 * are recorded in `pnpm-lock.yaml` and are not published);
 * `test/v2-meta-about.test.ts` parses that document and fails when the names
 * or licenses drift, so the runtime never reads the repository file (the
 * Docker runtime image does not ship `docs/`).
 */

export interface OpenSourceAttributionEntry {
  readonly name: string;
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
      purpose: "HTTP server and route lifecycle",
      license: "MIT",
    },
    {
      name: "@fastify/swagger",
      purpose: "OpenAPI 3.1 generation",
      license: "MIT",
    },
    {
      name: "@fastify/helmet",
      purpose: "HTTP security headers",
      license: "MIT",
    },
    {
      name: "@privy-io/node",
      purpose: "Privy token and user/wallet reads",
      license: "Apache-2.0",
    },
    {
      name: "@stream-io/node-sdk",
      purpose: "Stream Chat/Video user-token signing",
      license: "Proprietary Stream SCLA",
    },
    {
      name: "pg",
      purpose: "PostgreSQL driver and pooling",
      license: "MIT",
    },
    {
      name: "Zod",
      purpose: "Fail-closed environment validation",
      license: "MIT",
    },
    {
      name: "node-pg-migrate",
      purpose: "PostgreSQL schema migrations",
      license: "MIT",
    },
    {
      name: "Vitest",
      purpose: "Behavior and contract tests",
      license: "MIT",
    },
    {
      name: "TypeScript",
      purpose: "Static typing and compilation",
      license: "Apache-2.0",
    },
    {
      name: "ESLint",
      purpose: "Static analysis",
      license: "MIT",
    },
    {
      name: "Prettier",
      purpose: "Deterministic source formatting",
      license: "MIT",
    },
    {
      name: "tsx",
      purpose: "Local TypeScript execution/watch",
      license: "MIT",
    },
    {
      name: "lossless-json",
      purpose: "Lossless provider JSON numbers",
      license: "MIT",
    },
    {
      name: "Hyperliquid Python SDK",
      purpose: "Offline signing-conformance oracle only",
      license: "MIT",
    },
    {
      name: "@nktkas/hyperliquid",
      purpose: "Low-level Spot L1 canonicalize/sign only",
      license: "MIT",
    },
    {
      name: "viem",
      purpose: "EIP-712 signature recovery",
      license: "MIT",
    },
  ]);
