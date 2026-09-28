import { Agent, setGlobalDispatcher } from "undici";

/**
 * Outbound connection reuse for every Provider read made with `fetch`
 * (Decision 0088): viem's JSON-RPC transport (BSC primary and launch slots),
 * the Privy SDK, DexScreener, GeckoTerminal and GoPlus.
 *
 * Node's built-in `fetch` drops an idle connection after 4 s (undici's
 * default `keepAliveTimeout`). A wallet or community page opened more than
 * 4 s after the last Provider call therefore paid a new TCP + TLS handshake
 * per Provider before its first byte: measured 2026-09-28 from the
 * development host, `eth_blockNumber` took 160–230 ms on a reused connection
 * and 540–740 ms after 5–10 s idle; with a 60 s keep-alive the same call
 * after 5, 10 and 30 s idle stayed at 156–228 ms.
 *
 * Only the idle lifetime of a pooled connection changes. Request timeouts,
 * retries, and every Provider's own budget are untouched, and a connection
 * the server closes earlier is dropped and re-opened as before. The undici
 * package is pinned to the version Node 24.19 bundles (7.29.0), so this is the
 * same `Agent` Node would otherwise create, with one option set.
 */
export const outboundKeepAliveTimeoutMs = 60_000;

/** Upper bound on a server's own `Keep-Alive: timeout=` hint. */
export const outboundKeepAliveMaxTimeoutMs = 600_000;

export function configureOutboundKeepAlive(
  options: {
    readonly keepAliveTimeoutMs?: number;
  } = {},
): Agent {
  const keepAliveTimeout =
    options.keepAliveTimeoutMs ?? outboundKeepAliveTimeoutMs;
  if (!Number.isSafeInteger(keepAliveTimeout) || keepAliveTimeout <= 0) {
    throw new RangeError("keepAliveTimeoutMs must be a positive integer");
  }
  const agent = new Agent({
    keepAliveTimeout,
    keepAliveMaxTimeout: Math.max(
      keepAliveTimeout,
      outboundKeepAliveMaxTimeoutMs,
    ),
  });
  setGlobalDispatcher(agent);
  return agent;
}
