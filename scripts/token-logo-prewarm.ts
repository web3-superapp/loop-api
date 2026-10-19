import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { loadConfig } from "../src/config.js";
import { createPostgresChainRegistryRepository } from "../src/database/chain-registry-repository.js";
import { createPostgresMarketFactCacheRepository } from "../src/database/market-fact-cache-repository.js";
import { createPostgresTokenLogoCacheRepository } from "../src/database/token-logo-cache-repository.js";
import { createPostgresWatchlistV2Repository } from "../src/database/watchlist-v2-repository.js";
import { bscChainId } from "../src/features/chain/chain-contract.js";
import { createMarketFactService } from "../src/features/market/market-fact-service.js";
import { bscMainstreamTokenLogos } from "../src/features/market/token-logo-mainstream.js";
import { runTokenLogoPrewarmPass } from "../src/features/market/token-logo-prewarm.js";
import { createTokenLogoProxyService } from "../src/features/market/token-logo-proxy.js";
import { createMarketProviders } from "../src/integrations/market/provider-factory.js";

/**
 * `pnpm token-logo:prewarm [--hot-limit N]` (Decision 0161 §2): runs one
 * pass of the worker's `token_logo_prewarm` lane against the configured
 * database — native BNB, the mainstream list, registry and watchlisted BSC
 * assets, and up to N (default `TOKEN_LOGO_PREWARM_HOT_LIMIT`, 0–200)
 * GeckoTerminal top-volume tokens — and prints the outcome counts. For the
 * first fill after a deployment or a manual refresh; the lane does the same
 * every `TOKEN_LOGO_PREWARM_INTERVAL_MS`. Allowed with `NODE_ENV=production`
 * (it only fetches public pictures into a cache). Never prints a secret or
 * a URL.
 */

interface OutputWriter {
  readonly write: (contents: string) => unknown;
}

const usage = "usage: pnpm token-logo:prewarm [--hot-limit N]\n";

export async function runTokenLogoPrewarmScript(options: {
  readonly argv: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly stdout: OutputWriter;
  readonly stderr: OutputWriter;
  readonly fetch?: typeof fetch;
}): Promise<number> {
  let hotLimit: number | null = null;
  const argv = [...options.argv];
  while (argv.length > 0) {
    const flag = argv.shift();
    if (flag === "--hot-limit") {
      const value = argv.shift();
      if (value === undefined || !/^(0|[1-9][0-9]{0,2})$/u.test(value)) {
        options.stderr.write(usage);
        return 1;
      }
      hotLimit = Number(value);
      if (hotLimit > 200) {
        options.stderr.write(usage);
        return 1;
      }
    } else {
      options.stderr.write(usage);
      return 1;
    }
  }
  const environmentHotLimit = Number(
    options.environment["TOKEN_LOGO_PREWARM_HOT_LIMIT"] ?? "200",
  );
  const config = loadConfig(options.environment);
  const pool = new pg.Pool({
    application_name: "loop-api-token-logo-prewarm",
    connectionString: config.databaseUrl,
    max: 4,
  });
  try {
    const cache = createPostgresTokenLogoCacheRepository(pool);
    const facts = createPostgresMarketFactCacheRepository(pool);
    const providers = createMarketProviders(config.market, "worker");
    const started = Date.now();
    const summary = await runTokenLogoPrewarmPass({
      chainId: bscChainId,
      proxy: createTokenLogoProxyService({
        cache,
        facts,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }),
      cache,
      mainstream: bscMainstreamTokenLogos,
      registry: createPostgresChainRegistryRepository(pool),
      watchlist: createPostgresWatchlistV2Repository(pool),
      topPools: providers.topPools,
      hotLimit:
        hotLimit ??
        (Number.isInteger(environmentHotLimit) &&
        environmentHotLimit >= 0 &&
        environmentHotLimit <= 200
          ? environmentHotLimit
          : 200),
      pairs:
        providers.pairs === null
          ? null
          : createMarketFactService({
              config: config.market,
              cache: facts,
              pairsProvider: providers.pairs,
              securityProvider: null,
              candlesProvider: null,
              tokenLookupProvider: null,
            }),
    });
    const outcomes = Object.entries(summary.outcomes)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(" ");
    const origins = Object.entries(summary.byOrigin)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(" ");
    options.stdout.write(
      `token logo prewarm: targets=${String(summary.targetCount)} (${origins}) ${outcomes} hotListed=${String(summary.hotListed)}${summary.hotReasonCode === null ? "" : ` hotReason=${summary.hotReasonCode}`}${summary.pairSeedReasonCode === null ? "" : ` pairSeedReason=${summary.pairSeedReasonCode}`} elapsedMs=${String(Date.now() - started)}\n`,
    );
    return 0;
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  resolve(invokedPath) === fileURLToPath(import.meta.url)
) {
  runTokenLogoPrewarmScript({
    argv: process.argv.slice(2),
    environment: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(
        `token-logo:prewarm failed: ${error instanceof Error ? error.name : "UnknownError"}\n`,
      );
      process.exitCode = 1;
    },
  );
}
