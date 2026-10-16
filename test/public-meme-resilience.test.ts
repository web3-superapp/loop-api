import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { V2ApiError } from "../src/core/http/v2-error.js";
import type { Launch2Service } from "../src/features/launch2/launch2-service.js";
import {
  publicReadBudgetsMs,
  registerPublicMemeRoutes,
  type PublicMemeRouteOptions,
} from "../src/routes/public-meme.js";

/**
 * S207 (Decision 0147 revision): the public MEME reads under real traffic —
 * the framework handler timeout that produced the dev 500 + "Reply was
 * already sent", single-flight per URL, the per-read time budget (503
 * PUBLIC_UPSTREAM_TIMEOUT), no double send, no write after disconnect.
 */

const instanceId = "2f0d01fa-76fe-4395-9ce8-60799e74453b";
const detailUrl = `/public/v1/meme/${instanceId}`;
const listUrl = "/public/v1/meme";
const listBody = (n: number) => ({
  items: [],
  generatedAt: new Date(Date.UTC(2026, 9, 16, 13, 0, n)).toISOString(),
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

type Read = (input: { readonly signal?: AbortSignal }) => Promise<unknown>;

function fakeService(read: Read): {
  readonly service: Launch2Service;
  readonly calls: { signal?: AbortSignal }[];
} {
  const calls: { signal?: AbortSignal }[] = [];
  const wrapped = (input: { readonly signal?: AbortSignal }) => {
    calls.push(input);
    return read(input);
  };
  return {
    service: {
      getPublicMeme: wrapped,
      listPublicMemes: wrapped,
      listPublicMemeCandles: wrapped,
    } as unknown as Launch2Service,
    calls,
  };
}

describe("public MEME reads under real traffic (S207)", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function createApp(
    service: Launch2Service,
    options: {
      readonly handlerTimeout?: number;
      readonly budgetsMs?: PublicMemeRouteOptions["budgetsMs"];
    } = {},
  ) {
    const logs: Record<string, unknown>[] = [];
    const sends: string[] = [];
    const app = Fastify({
      ...(options.handlerTimeout === undefined
        ? {}
        : { handlerTimeout: options.handlerTimeout }),
      logger: {
        level: "info",
        stream: {
          write: (line: string) => {
            logs.push(JSON.parse(line) as Record<string, unknown>);
          },
        },
      },
    });
    app.addHook("onSend", async (request, reply, payload) => {
      sends.push(`${request.id}:${reply.statusCode}`);
      return payload;
    });
    registerPublicMemeRoutes(app, {
      service,
      ...(options.budgetsMs === undefined
        ? {}
        : { budgetsMs: options.budgetsMs }),
    });
    await app.ready();
    apps.push(app);
    return { app, logs, sends };
  }

  const get = (app: FastifyInstance, url = detailUrl) =>
    app.inject({ method: "GET", url });

  it("keeps the budgets well inside the 15 s handler timeout", () => {
    expect(publicReadBudgetsMs).toEqual({
      detail: 8_000,
      list: 10_000,
      candles: 5_000,
    });
  });

  it("root cause: Fastify's handler timeout reaches the error handler first (FST_ERR_HANDLER_TIMEOUT) — now a 503, never a second send", async () => {
    // The dev 500: the Hook read outlived `handlerTimeout` (15 s), Fastify
    // sent FST_ERR_HANDLER_TIMEOUT (a FastifyError, statusCode 503)
    // through the scope's error handler, which projected it to 500; the
    // handler then resolved and sent again → "Reply was already sent".
    const gate = deferred<unknown>();
    const { service } = fakeService(() => gate.promise);
    const { app, logs, sends } = await createApp(service, {
      handlerTimeout: 60,
      budgetsMs: { detail: 10_000 },
    });
    const response = await get(app);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      code: "CAPABILITY_UNAVAILABLE",
      reasonCode: "PUBLIC_UPSTREAM_TIMEOUT",
    });
    expect(response.headers["access-control-allow-origin"]).toBe("*");
    expect(response.headers["cache-control"]).toBe("no-store");
    const unavailable = logs.find(
      (line) => line["msg"] === "Public read unavailable",
    );
    expect(unavailable).toMatchObject({
      errorCode: "FST_ERR_HANDLER_TIMEOUT",
      reasonCode: "PUBLIC_UPSTREAM_TIMEOUT",
    });
    // The handler finishes after the framework answered: no second send.
    gate.resolve({ late: true });
    await wait(30);
    expect(sends).toHaveLength(1);
    expect(
      logs.some((line) =>
        String(line["msg"]).includes("Reply was already sent"),
      ),
    ).toBe(false);
  });

  it("logs the error code and a sanitized message of an unhandled error", async () => {
    const { service } = fakeService(() =>
      Promise.reject(
        Object.assign(new Error("boom at https://rpc.example/key/abc"), {
          code: "E_BOOM",
        }),
      ),
    );
    const { app, logs } = await createApp(service);
    const response = await get(app);
    expect(response.statusCode).toBe(500);
    expect(
      logs.find((line) => line["msg"] === "Unhandled error in public request"),
    ).toMatchObject({
      errorClass: "Error",
      errorCode: "E_BOOM",
      errorMessage: "boom at <url>",
    });
  });

  it("single-flight: N concurrent reads of one URL call the service once", async () => {
    const gate = deferred<unknown>();
    const { service, calls } = fakeService(() => gate.promise);
    const { app } = await createApp(service);
    const pending = Array.from({ length: 6 }, () => get(app, listUrl));
    await wait(20);
    gate.resolve(listBody(1));
    const responses = await Promise.all(pending);
    expect(calls).toHaveLength(1);
    for (const response of responses) {
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(listBody(1));
    }
    // Then the 5 s memo.
    expect((await get(app, listUrl)).statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    // Another URL is its own flight.
    await get(app, `${listUrl}?stage=curve`);
    expect(calls).toHaveLength(2);
  });

  it("shares one failure with every waiter and does not memo it", async () => {
    const gate = deferred<unknown>();
    const { service, calls } = fakeService(() => gate.promise);
    const { app, logs } = await createApp(service);
    const pending = Array.from({ length: 4 }, () => get(app));
    await wait(20);
    gate.reject(
      V2ApiError.fromCode("CAPABILITY_UNAVAILABLE", {
        reasonCode: "LAUNCH2_CHAIN_READ_FAILED",
      }),
    );
    const responses = await Promise.all(pending);
    expect(calls).toHaveLength(1);
    for (const response of responses) {
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        code: "CAPABILITY_UNAVAILABLE",
        reasonCode: "LAUNCH2_CHAIN_READ_FAILED",
      });
    }
    expect(
      logs.filter(
        (line) =>
          line["msg"] === "Public read unavailable" &&
          line["reasonCode"] === "LAUNCH2_CHAIN_READ_FAILED",
      ),
    ).toHaveLength(4);
    // A failure is not cached: the next request reads again.
    await get(app);
    expect(calls).toHaveLength(2);
  });

  it("answers 503 PUBLIC_UPSTREAM_TIMEOUT at the budget, aborts the read's signal, and never piles a second read on", async () => {
    const gate = deferred<unknown>();
    const { service, calls } = fakeService(() => gate.promise);
    const { app } = await createApp(service, {
      budgetsMs: { list: 50 },
    });
    const started = Date.now();
    const response = await get(app, listUrl);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      code: "CAPABILITY_UNAVAILABLE",
      reasonCode: "PUBLIC_UPSTREAM_TIMEOUT",
    });
    expect(calls[0]?.signal?.aborted).toBe(true);
    // The timed-out read is still running: a new request joins it (same
    // 503) instead of a second upstream call.
    expect((await get(app, listUrl)).json()).toMatchObject({
      reasonCode: "PUBLIC_UPSTREAM_TIMEOUT",
    });
    expect(calls).toHaveLength(1);
    // Its late success fills the memo.
    gate.resolve(listBody(2));
    await wait(10);
    const after = await get(app, listUrl);
    expect(after.statusCode).toBe(200);
    expect(after.json()).toEqual(listBody(2));
    expect(calls).toHaveLength(1);
  });

  it("uses the list and candles budgets for those reads", async () => {
    const { service } = fakeService(() => new Promise(() => undefined));
    const { app } = await createApp(service, {
      budgetsMs: { list: 30, candles: 30, detail: 60_000 },
    });
    for (const url of [listUrl, `${detailUrl}/candles`]) {
      const response = await get(app, url);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        reasonCode: "PUBLIC_UPSTREAM_TIMEOUT",
      });
    }
  });

  it("does not write once the client has disconnected", async () => {
    const gate = deferred<unknown>();
    const { service, calls } = fakeService(() => gate.promise);
    const { app, logs, sends } = await createApp(service);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const client = httpRequest({
      host: "127.0.0.1",
      port,
      path: listUrl,
      method: "GET",
    });
    client.on("error", () => undefined);
    client.end();
    await wait(50);
    expect(calls).toHaveLength(1);
    client.destroy();
    await wait(50);
    gate.resolve(listBody(3));
    await wait(50);
    expect(sends).toHaveLength(0);
    expect(
      logs.some(
        (line) =>
          String(line["msg"]).includes("Reply was already sent") ||
          line["level"] === 50,
      ),
    ).toBe(false);
  });
});
