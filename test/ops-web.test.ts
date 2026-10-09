import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerOpsWebRoutes } from "../src/routes/ops-web.js";

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function server() {
  const app = Fastify();
  apps.push(app);
  await registerOpsWebRoutes(app);
  return app;
}
describe("operations web shell", () => {
  it("serves the explicit shell and external assets with restrictive browser headers", async () => {
    const app = await server();
    for (const [url, type] of [
      ["/ops", "text/html"],
      ["/ops/", "text/html"],
      ["/ops?preview=1", "text/html"],
      ["/ops/app.js", "text/javascript"],
      ["/ops/styles.css", "text/css"],
    ] as const) {
      const response = await app.inject({ url });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain(type);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["content-security-policy"]).toContain(
        "frame-ancestors 'none'",
      );
      expect(response.headers["content-security-policy"]).not.toContain(
        "unsafe-inline",
      );
    }
  });
  it("does not turn filenames into a filesystem or API fallback", async () => {
    const app = await server();
    for (const url of [
      "/ops/ops-contract.ts",
      "/ops/.env",
      "/ops/%2e%2e/config.ts",
      "/ops/..%2f..%2fpackage.json",
      "/ops/api/session",
      "/ops/arbitrary.js",
    ] as const) {
      expect((await app.inject({ url })).statusCode).toBe(404);
    }
  });
  it("keeps authentication out of the public shell and uses external code only", async () => {
    const app = await server();
    const response = await app.inject({ url: "/ops" });
    expect(response.body).toContain('src="/ops/app.js"');
    expect(response.body).toContain('href="/ops/styles.css"');
    expect(response.body).not.toMatch(/<script(?![^>]*src=)[^>]*>/);
    expect(response.body).not.toMatch(/\son(?:click|load|submit)=/);
    expect(response.body).not.toContain("Bearer");
  });
});
