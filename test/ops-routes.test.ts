import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerOpsRoutes } from "../src/routes/ops.js";
import {
  OpsError,
  type OpsRepository,
} from "../src/features/ops/ops-contract.js";
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});
function app(enabled = true, authenticated = true) {
  const server = Fastify({
    ajv: { customOptions: { removeAdditional: false } },
  });
  apps.push(server);
  server.decorateRequest("authenticatedLoopPrincipal", null);
  const repository = {
    session: vi.fn(() => Promise.resolve({ label: "Ops" })),
    list: vi.fn(() => Promise.resolve({ items: [] })),
    execute: vi.fn(() => Promise.resolve({ result: {} })),
    operation: vi.fn(() => Promise.resolve({ result: {} })),
    job: vi.fn(() => Promise.resolve({})),
    runJob: vi.fn(() => Promise.resolve({})),
  } satisfies OpsRepository;
  registerOpsRoutes(server, {
    enabled,
    repository,
    authenticate: (req) => {
      if (!authenticated) throw new OpsError("AUTHENTICATION_REQUIRED", 401);
      req.authenticatedLoopPrincipal = {
        userId: "75c20914-52af-457a-a406-2326faeb2a6c",
        privyUserId: "did:privy:test",
        streamUserId: "loop_test",
      };
      return Promise.resolve();
    },
  });
  return { server, repository };
}
describe("ops routes", () => {
  it("requires authenticated identity on every read and write", async () => {
    const { server, repository } = app(true, false);
    for (const url of [
      "/ops/api/session",
      "/ops/api/catalog",
      "/ops/api/resources/mining",
      "/ops/api/operations/75c20914-52af-457a-a406-2326faeb2a6c",
    ])
      expect((await server.inject({ url })).statusCode).toBe(401);
    expect(repository.session).not.toHaveBeenCalled();
  });
  it("disables production entry", async () => {
    const { server } = app(false);
    expect((await server.inject({ url: "/ops/api/session" })).statusCode).toBe(
      503,
    );
  });
  it("rejects unknown commands and additional identity fields", async () => {
    const { server, repository } = app();
    const response = await server.inject({
      method: "POST",
      url: "/ops/api/commands",
      payload: {
        action: "support.answer",
        operationId: "75c20914-52af-457a-a406-2326faeb2a6c",
        target: "75c20914-52af-457a-a406-2326faeb2a6c",
        reason: "回复",
        payload: { status: "answered", note: "答复" },
        actor: "admin",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(repository.execute).not.toHaveBeenCalled();
  });
  it("passes server-derived identity and never caches sensitive reads", async () => {
    const { server, repository } = app();
    const response = await server.inject({ url: "/ops/api/resources/mining" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(repository.list).toHaveBeenCalledWith(
      "75c20914-52af-457a-a406-2326faeb2a6c",
      "mining",
      undefined,
      {},
    );
  });
});
