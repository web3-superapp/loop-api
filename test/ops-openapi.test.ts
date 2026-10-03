import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import {
  openApiOpsArtifactPath,
  renderOpenApiOpsArtifact,
} from "../scripts/generate-openapi.js";
it("publishes a separate authenticated operations contract", async () => {
  const generated = await renderOpenApiOpsArtifact();
  expect(await readFile(openApiOpsArtifactPath, "utf8")).toBe(generated);
  const document = JSON.parse(generated) as {
    paths: Record<string, Record<string, { security: unknown }>>;
  };
  expect(Object.keys(document.paths).sort()).toEqual([
    "/ops/api/catalog",
    "/ops/api/commands",
    "/ops/api/jobs/{id}",
    "/ops/api/jobs/{id}/run",
    "/ops/api/operations/{id}",
    "/ops/api/resources/{resource}",
    "/ops/api/session",
  ]);
  for (const path of Object.values(document.paths))
    for (const operation of Object.values(path))
      expect(operation.security).toEqual([{ privyBearer: [] }]);
}, 30000);
