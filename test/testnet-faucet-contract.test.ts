import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { v2CapabilityIds } from "../src/features/meta/product-policy.js";
import { testnetFaucetReasonCodes } from "../src/features/testnet-faucet/testnet-faucet-contract.js";
import { openApiV2ArtifactPath } from "../scripts/generate-openapi.js";

/**
 * Decision 0128 contract test against the committed V2 artifact: the two
 * operations, their security, headers, status codes, and the frozen field
 * names S156-mobile builds against.
 */

interface Operation {
  readonly operationId?: string;
  readonly security?: readonly Record<string, readonly unknown[]>[];
  readonly parameters?: readonly {
    readonly name?: string;
    readonly in?: string;
    readonly required?: boolean;
  }[];
  readonly requestBody?: {
    readonly required?: boolean;
    readonly content?: Record<string, { readonly schema?: Schema }>;
  };
  readonly responses?: Record<
    string,
    { readonly content?: Record<string, { readonly schema?: Schema }> }
  >;
}

interface Schema {
  readonly required?: readonly string[];
  readonly properties?: Record<string, Schema>;
  readonly additionalProperties?: boolean;
}

async function operations() {
  const document = JSON.parse(
    await readFile(openApiV2ArtifactPath, "utf8"),
  ) as {
    readonly paths: Record<string, Record<string, Operation>>;
  };
  const path = document.paths["/v2/testnet/faucet"];
  return { get: path?.["get"], post: path?.["post"] };
}

function schemaOf(operation: Operation | undefined, status: string): Schema {
  return operation?.responses?.[status]?.content?.["application/json"]
    ?.schema as Schema;
}

describe("testnet faucet OpenAPI contract (Decision 0128)", () => {
  it("publishes GET with a required walletId and the status resource", async () => {
    const { get } = await operations();
    expect(get?.operationId).toBe("getV2TestnetFaucet");
    expect(get?.security).toEqual([{ privyBearer: [] }]);
    expect(
      get?.parameters?.find((parameter) => parameter.name === "walletId"),
    ).toMatchObject({ in: "query", required: true });
    expect(Object.keys(get?.responses ?? {}).sort()).toEqual(
      ["200", "400", "401", "403", "409", "500", "503"].sort(),
    );
    const resource = schemaOf(get, "200");
    expect([...(resource.required ?? [])].sort()).toEqual(
      [
        "walletId",
        "address",
        "bnbAmount",
        "usd1Amount",
        "cooldownSeconds",
        "available",
        "nextAvailableAt",
        "lastGrant",
      ].sort(),
    );
    expect(resource.additionalProperties).toBe(false);
  });

  it("publishes POST with Idempotency-Key, {walletId}, 201, 429, and 502", async () => {
    const { post } = await operations();
    expect(post?.operationId).toBe("claimV2TestnetFaucet");
    expect(post?.security).toEqual([{ privyBearer: [] }]);
    const headers = (post?.parameters ?? [])
      .filter((parameter) => parameter.in === "header")
      .map((parameter) => parameter.name?.toLowerCase());
    expect(headers).toEqual(
      expect.arrayContaining(["idempotency-key", "x-loop-contract-version"]),
    );
    expect(
      post?.requestBody?.content?.["application/json"]?.schema?.required,
    ).toEqual(["walletId"]);
    expect(Object.keys(post?.responses ?? {}).sort()).toEqual(
      ["201", "400", "401", "403", "409", "429", "500", "502", "503"].sort(),
    );
    const resource = schemaOf(post, "201");
    expect([...(resource.required ?? [])].sort()).toEqual(
      [
        "walletId",
        "address",
        "bnb",
        "usd1",
        "grantedAt",
        "nextAvailableAt",
      ].sort(),
    );
    expect(resource.properties?.["bnb"]?.required).toEqual([
      "amount",
      "transactionHash",
    ]);
    expect(resource.properties?.["usd1"]?.required).toEqual([
      "amount",
      "transactionHash",
    ]);
  });

  it("lists testnetFaucet after launch2 (Decision 0143 appends squareFeed) and freezes the reason codes", () => {
    expect(v2CapabilityIds.at(-2)).toBe("testnetFaucet");
    expect(v2CapabilityIds.at(-1)).toBe("squareFeed");
    expect(Object.values(testnetFaucetReasonCodes)).toEqual(
      expect.arrayContaining([
        "TESTNET_FAUCET_DISABLED",
        "TESTNET_FAUCET_WRONG_CHAIN",
        "TESTNET_FAUCET_OPERATOR_NOT_CONFIGURED",
        "TESTNET_FAUCET_COOLDOWN",
        "TESTNET_FAUCET_OPERATOR_LOW",
        "TESTNET_FAUCET_WALLET_NOT_OWNED",
        "TESTNET_FAUCET_PARTIAL",
      ]),
    );
  });
});
