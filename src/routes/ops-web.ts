import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";

/** Public shell only; every data and command request has its own authentication. */
export async function registerOpsWebRoutes(
  app: FastifyInstance,
): Promise<void> {
  const files = [
    {
      routes: ["/ops", "/ops/"],
      file: "index.html",
      type: "text/html; charset=utf-8",
    },
    {
      routes: ["/ops/app.js"],
      file: "app.js",
      type: "text/javascript; charset=utf-8",
    },
    {
      routes: ["/ops/styles.css"],
      file: "styles.css",
      type: "text/css; charset=utf-8",
    },
  ] as const;
  for (const asset of files) {
    const body = await readFile(
      new URL(`../features/ops/web/${asset.file}`, import.meta.url),
    );
    for (const url of asset.routes) {
      app.get(url, { schema: { hide: true } }, (_request, reply) => {
        return reply
          .type(asset.type)
          .header("cache-control", "no-store")
          .header("x-content-type-options", "nosniff")
          .header("referrer-policy", "no-referrer")
          .header(
            "content-security-policy",
            "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
          )
          .send(body);
      });
    }
  }
}
