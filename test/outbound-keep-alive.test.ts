import {
  createServer,
  type AddressInfo,
  type Server as NetServer,
  type Socket,
} from "node:net";

import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterEach, describe, expect, it } from "vitest";

import {
  configureOutboundKeepAlive,
  outboundKeepAliveTimeoutMs,
} from "../src/core/http/outbound-keep-alive.js";

/**
 * Decision 0088: the global `fetch` dispatcher keeps an idle Provider
 * connection for the configured time instead of undici's 4 s default.
 */

/**
 * A minimal HTTP/1.1 server that keeps connections open and, like the RPC
 * endpoints measured for this decision, sends no `Keep-Alive: timeout=`
 * hint (Node's own HTTP server would, and undici prefers the hint).
 */
async function server(): Promise<{
  readonly url: string;
  readonly connections: () => number;
  readonly close: () => Promise<void>;
}> {
  let connections = 0;
  const sockets = new Set<Socket>();
  const instance: NetServer = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (chunk: Buffer) => {
      if (chunk.includes("\r\n\r\n")) {
        socket.write(
          "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nok",
        );
      }
    });
  });
  await new Promise<void>((resolve) => {
    instance.listen(0, "127.0.0.1", resolve);
  });
  const { port } = instance.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/`,
    connections: () => connections,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        instance.close(() => {
          resolve();
        });
      }),
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("outbound keep-alive (Decision 0088)", () => {
  const original = getGlobalDispatcher();
  afterEach(() => {
    setGlobalDispatcher(original);
  });

  it("defaults to a 60 s idle lifetime", () => {
    expect(outboundKeepAliveTimeoutMs).toBe(60_000);
    expect(() => configureOutboundKeepAlive({ keepAliveTimeoutMs: 0 })).toThrow(
      RangeError,
    );
  });

  it("reuses one connection across an idle gap shorter than the keep-alive, and reconnects after it", async () => {
    const target = await server();
    try {
      const long = configureOutboundKeepAlive({ keepAliveTimeoutMs: 5_000 });
      await (await fetch(target.url)).text();
      await sleep(600);
      await (await fetch(target.url)).text();
      expect(target.connections()).toBe(1);
      await long.close();

      const short = configureOutboundKeepAlive({ keepAliveTimeoutMs: 200 });
      await (await fetch(target.url)).text();
      await sleep(600);
      await (await fetch(target.url)).text();
      // A new pool (one connection) and then a reconnect after the idle gap.
      expect(target.connections()).toBe(3);
      await short.close();
    } finally {
      await target.close();
    }
  });
});
