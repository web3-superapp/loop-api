import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  hooksLaunchFixedEconomics,
  hooksLaunchTemplateHash,
  hooksLaunchTemplateVersion,
} from "../src/features/launch/hooks-launch-config.js";

/**
 * Decision 0108: the committed OpenAPI artifact is the frontend contract for
 * the six Hooks launch routes. This pins operation IDs, header rules, the
 * error-code families, and the string-only amount rule.
 */

interface Operation {
  readonly operationId: string;
  readonly security: readonly Record<string, unknown>[];
  readonly parameters: readonly {
    readonly in: string;
    readonly name: string;
    readonly required?: boolean;
  }[];
  readonly responses: Record<
    string,
    {
      readonly content?: {
        readonly "application/json": {
          readonly schema: {
            readonly properties?: Record<string, unknown>;
          };
        };
      };
    }
  >;
}

const document = JSON.parse(
  readFileSync(new URL("../openapi/loop-api.v2.json", import.meta.url), "utf8"),
) as { readonly paths: Record<string, Record<string, Operation>> };

const base = "/v2/launch/projects/{projectId}";

function operation(path: string, method: string): Operation {
  const found = document.paths[path]?.[method];
  if (found === undefined) throw new Error(`${method} ${path} missing`);
  return found;
}

function errorCodes(op: Operation, status: string): readonly string[] {
  const schema = op.responses[status]?.content?.["application/json"].schema;
  const code = schema?.properties?.["code"] as
    { readonly enum?: readonly string[] } | undefined;
  return code?.enum ?? [];
}

function headerNames(op: Operation): readonly string[] {
  return op.parameters
    .filter((parameter) => parameter.in === "header" && parameter.required)
    .map((parameter) => parameter.name)
    .sort();
}

const routes = [
  ["get", `${base}/hooks-config`, "getV2HooksLaunchProjectConfig", false],
  ["put", `${base}/hooks-config`, "saveV2HooksLaunchProjectConfig", false],
  [
    "get",
    `${base}/hooks-config/signing-request`,
    "getV2HooksLaunchSigningRequest",
    false,
  ],
  ["post", `${base}/hooks-deployments`, "submitV2HooksLaunchDeployment", true],
  [
    "get",
    `${base}/hooks-deployments/{jobId}`,
    "getV2HooksLaunchDeployment",
    false,
  ],
  [
    "delete",
    `${base}/hooks-deployments/{jobId}`,
    "cancelV2HooksLaunchDeployment",
    true,
  ],
] as const;

describe("Hooks launch OpenAPI contract (Decision 0108)", () => {
  it.each(routes)(
    "%s %s is Privy-authenticated with the V2 header rule",
    (method, path, operationId, idempotent) => {
      const op = operation(path, method);
      expect(op.operationId).toBe(operationId);
      expect(op.security).toEqual([{ privyBearer: [] }]);
      expect(headerNames(op)).toEqual(
        idempotent
          ? [
              "idempotency-key",
              "x-loop-client-version",
              "x-loop-contract-version",
            ]
          : ["x-loop-client-version", "x-loop-contract-version"],
      );
      expect(errorCodes(op, "503")).toContain("CAPABILITY_UNAVAILABLE");
      expect(errorCodes(op, "401")).toEqual(["AUTH_REQUIRED", "AUTH_INVALID"]);
      expect(errorCodes(op, "404")).toEqual(["NOT_FOUND"]);
    },
  );

  it("declares the submission error families the route can return", () => {
    const op = operation(`${base}/hooks-deployments`, "post");
    expect(errorCodes(op, "403")).toContain("POLICY_BLOCKED");
    expect(errorCodes(op, "409")).toEqual(
      expect.arrayContaining(["IDEMPOTENCY_CONFLICT", "VERSION_CONFLICT"]),
    );
    expect(errorCodes(op, "400")).toEqual(["INVALID_REQUEST"]);
  });

  it("publishes the Decision 0112 executor state on every task response", () => {
    for (const [path, method] of [
      [`${base}/hooks-deployments`, "post"],
      [`${base}/hooks-deployments/{jobId}`, "get"],
      [`${base}/hooks-deployments/{jobId}`, "delete"],
    ] as const) {
      const schema = operation(path, method).responses["200"]?.content?.[
        "application/json"
      ].schema as {
        readonly required: readonly string[];
        readonly properties: Record<
          string,
          {
            readonly enum?: readonly string[];
            readonly items?: {
              readonly properties: Record<string, { readonly anyOf?: unknown }>;
            };
          }
        >;
      };
      expect(schema.required).toEqual(
        expect.arrayContaining([
          "status",
          "txHash",
          "confirmations",
          "addresses",
          "events",
          "failure",
        ]),
      );
      expect(schema.properties["status"]?.enum).toEqual([
        "awaiting_executor",
        "claimed",
        "broadcast",
        "confirmed",
        "verified",
        "activated",
        "failed",
        "reorged",
        "cancelled",
      ]);
      // Block numbers travel as decimal strings, never JS numbers.
      expect(
        JSON.stringify(
          schema.properties["events"]?.items?.properties["blockNumber"],
        ),
      ).toContain('"type":"string"');
      expect(Object.keys(schema.properties)).not.toEqual(
        expect.arrayContaining(["rawTx"]),
      );
      expect(Object.keys(schema.properties)).not.toContain("signature");
    }
    const cancel = operation(`${base}/hooks-deployments/{jobId}`, "delete");
    expect(errorCodes(cancel, "409")).toContain("VERSION_CONFLICT");
  });

  it("publishes every fixed-economics amount as a decimal string", () => {
    const resource = operation(`${base}/hooks-config`, "put").responses["200"]
      ?.content?.["application/json"].schema as {
      readonly properties: {
        readonly config: {
          readonly properties: {
            readonly fixedEconomics: {
              readonly properties: Record<string, { readonly type: string }>;
              readonly required: readonly string[];
            };
          };
        };
      };
    };
    const economics = resource.properties.config.properties.fixedEconomics;
    expect([...economics.required].sort()).toEqual(
      Object.keys(hooksLaunchFixedEconomics).sort(),
    );
    for (const [key, value] of Object.entries(hooksLaunchFixedEconomics)) {
      const expected = typeof value === "string" ? "string" : "integer";
      expect(economics.properties[key]?.type, key).toBe(expected);
      if (key.endsWith("Raw")) expect(typeof value, key).toBe("string");
    }
  });

  it("pins the hooks_launch_v1 template identity", () => {
    expect(hooksLaunchTemplateVersion).toBe("hooks_launch_v1");
    expect(hooksLaunchTemplateHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hooksLaunchFixedEconomics).toMatchObject({
      chainId: "56",
      memeTotalSupplyRaw: "1000000000000000000000000000",
      curveSaleSupplyRaw: "800000000000000000000000000",
      initialLiquiditySupplyRaw: "200000000000000000000000000",
      graduationReserveUsd1Raw: "133333332000000000000000",
      perAddressLifetimeBuyCapRaw: "5000000000000000000000000",
      curveBuyTaxBps: 1_000,
      officialPoolBuyTaxBps: 200,
      lpFee: 2_500,
      tickSpacing: 60,
    });
  });
});
