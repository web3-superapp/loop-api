import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  openApiArtifactPath,
  renderOpenApiArtifact,
} from "../scripts/generate-openapi.js";

interface OpenApiDocument {
  readonly openapi: string;
  readonly servers: readonly { readonly url: string }[];
  readonly paths: Record<
    string,
    Record<
      string,
      {
        readonly operationId?: string;
        readonly security?: readonly Record<string, readonly unknown[]>[];
        readonly responses?: Record<string, unknown>;
      }
    >
  >;
}

describe("committed OpenAPI artifact", () => {
  it("exactly matches deterministic runtime schema generation", async () => {
    const [first, second, committed] = await Promise.all([
      renderOpenApiArtifact(),
      renderOpenApiArtifact(),
      readFile(openApiArtifactPath, "utf8"),
    ]);

    expect(first).toBe(second);
    expect(committed).toBe(first);
  });

  it("contains only the implemented canonical route surface", async () => {
    const document = JSON.parse(
      await readFile(openApiArtifactPath, "utf8"),
    ) as OpenApiDocument;
    const paths = Object.keys(document.paths).sort();
    const operations = Object.values(document.paths).flatMap((path) =>
      Object.values(path),
    );
    const operationIds = operations.map((operation) => operation.operationId);
    const bootstrap = document.paths["/v1/bootstrap"]?.["post"];
    const chatToken = document.paths["/v1/chat/token"]?.["post"];
    const videoToken = document.paths["/v1/video/token"]?.["post"];

    expect(document.openapi).toBe("3.1.0");
    expect(document.servers).toEqual([
      { url: "https://api-dev.quant-dinger.cc" },
    ]);
    expect(paths).toEqual([
      "/health/live",
      "/health/ready",
      "/v1/bootstrap",
      "/v1/chat/token",
      "/v1/video/token",
    ]);
    expect(operationIds.every((operationId) => operationId !== undefined)).toBe(
      true,
    );
    expect(new Set(operationIds).size).toBe(operationIds.length);
    expect(bootstrap).toMatchObject({
      operationId: "bootstrapCurrentUser",
      security: [{ privyBearer: [] }],
    });
    expect(bootstrap).not.toHaveProperty("parameters");
    expect(bootstrap?.responses).toHaveProperty("200");
    expect(bootstrap?.responses).toHaveProperty("400");
    expect(bootstrap?.responses).toHaveProperty("401");
    expect(bootstrap?.responses).toHaveProperty("503");
    expect(bootstrap?.responses).toHaveProperty("500");
    expect(paths).not.toContain("/openapi.json");
    expect(paths.some((path) => path.includes("payment"))).toBe(false);
    expect(paths.some((path) => path.includes("mainnet"))).toBe(false);
    expect(paths.some((path) => path.includes("withdraw"))).toBe(false);
    expect(bootstrap).toHaveProperty(
      "responses.503.content.application/json.schema.properties.code.enum",
      ["authentication_unavailable", "request_timeout"],
    );

    for (const [operation, operationId] of [
      [chatToken, "issueStreamChatToken"],
      [videoToken, "issueStreamVideoToken"],
    ] as const) {
      expect(operation).toMatchObject({
        operationId,
        security: [{ privyBearer: [] }],
      });
      expect(operation).not.toHaveProperty("parameters");
      expect(operation).not.toHaveProperty("requestBody");
      for (const status of ["200", "400", "401", "409", "429", "500", "503"]) {
        expect(operation?.responses).toHaveProperty(status);
      }
      expect(operation).toHaveProperty(
        "responses.429.content.application/json.schema.properties.code.enum",
        ["rate_limit_exceeded"],
      );
      expect(operation).toHaveProperty(
        "responses.503.content.application/json.schema.properties.code.enum",
        ["authentication_unavailable", "stream_unavailable", "request_timeout"],
      );
    }
  });
});
