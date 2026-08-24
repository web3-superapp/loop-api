# Open-source attribution register

This register covers the direct runtime and verification dependencies introduced
by the Node backend foundation. The exact transitive graph and integrity hashes
are recorded in `pnpm-lock.yaml`.

| Package            | Version | Purpose                            | License    |
| ------------------ | ------: | ---------------------------------- | ---------- |
| Fastify            |  5.12.1 | HTTP server and route lifecycle    | MIT        |
| `@fastify/swagger` |   9.8.1 | OpenAPI 3.1 generation             | MIT        |
| `@fastify/helmet`  |  13.1.1 | HTTP security headers              | MIT        |
| `pg`               |  8.23.0 | PostgreSQL driver and pooling      | MIT        |
| Zod                |   4.4.3 | Fail-closed environment validation | MIT        |
| `node-pg-migrate`  |   9.0.0 | PostgreSQL schema migrations       | MIT        |
| Vitest             |  4.1.11 | Behavior and contract tests        | MIT        |
| TypeScript         |   6.0.3 | Static typing and compilation      | Apache-2.0 |
| ESLint             |  10.9.0 | Static analysis                    | MIT        |
| Prettier           |   3.9.6 | Deterministic source formatting    | MIT        |
| `tsx`              | 4.23.12 | Local TypeScript execution/watch   | MIT        |

This file does not cover Provider SDKs because none are installed by the
foundation slice. Provider SDK attribution and commercial-license review must be
added in the same change that introduces each SDK.
