import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from "fastify";

/**
 * Per-request cancellation for handlers and provider gateways.
 *
 * Fastify derives `request.signal` from an `AbortController` that is aborted by
 * `request.raw.on("close")` (`fastify/lib/request.js` and, when
 * `handlerTimeout` is configured, `fastify/lib/route.js`). On Node 24 an
 * `IncomingMessage` emits `close` as soon as the request body has been fully
 * read, not when the client goes away, so every request that carries a body had
 * an already-aborted signal before its handler ran. Handlers that pass the
 * signal to a provider gateway (or call `throwIfAborted()`) therefore failed
 * with a spurious `AbortError`. `app.inject()` never reproduced it because the
 * injected request is not a real socket.
 *
 * This hook installs an own `signal` property on the request object that
 * shadows the framework getter, so `request.signal` keeps its documented
 * meaning and no route has to opt in. The replacement aborts on exactly two
 * events:
 *
 * 1. the client really disconnected — the response stream closed before the
 *    response was written (`reply.raw` closed while `writableEnded` is false);
 * 2. the total per-request deadline elapsed.
 *
 * Reading the request body never aborts it.
 */
export const requestAbortDeadlineMilliseconds = 15_000;

export function registerRequestAbortSignal(
  app: FastifyInstance,
  deadlineMilliseconds: number = requestAbortDeadlineMilliseconds,
): void {
  app.addHook(
    "onRequest",
    (
      request: FastifyRequest,
      reply: FastifyReply,
      done: HookHandlerDoneFunction,
    ): void => {
      const disconnect = new AbortController();
      reply.raw.on("close", () => {
        if (!reply.raw.writableEnded) {
          disconnect.abort();
        }
      });
      // `AbortSignal.timeout` uses an unref'd timer, so a pending deadline
      // never keeps the process alive on shutdown.
      const signal = AbortSignal.any([
        disconnect.signal,
        AbortSignal.timeout(deadlineMilliseconds),
      ]);
      Object.defineProperty(request, "signal", {
        configurable: true,
        enumerable: false,
        get: (): AbortSignal => signal,
      });
      done();
    },
  );
}
