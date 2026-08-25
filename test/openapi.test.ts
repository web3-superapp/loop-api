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
        readonly parameters?: readonly { readonly name?: string }[];
        readonly requestBody?: unknown;
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
    const personalizationOperations = [
      [document.paths["/v1/profile"]?.["get"], "getCurrentProfile"],
      [document.paths["/v1/profile"]?.["put"], "replaceCurrentProfile"],
      [
        document.paths["/v1/profile/privacy"]?.["get"],
        "getCurrentPrivacyPreferences",
      ],
      [
        document.paths["/v1/profile/privacy"]?.["put"],
        "replaceCurrentPrivacyPreferences",
      ],
      [document.paths["/v1/watchlist"]?.["get"], "getWatchlist"],
      [document.paths["/v1/watchlist"]?.["put"], "replaceWatchlist"],
    ] as const;
    const alertOperations = [
      [document.paths["/v1/alerts"]?.["get"], "listAlerts", "200"],
      [document.paths["/v1/alerts"]?.["post"], "createAlert", "200"],
      [document.paths["/v1/alerts/{alert_id}"]?.["get"], "getAlert", "200"],
      [document.paths["/v1/alerts/{alert_id}"]?.["put"], "replaceAlert", "200"],
      [
        document.paths["/v1/alerts/{alert_id}"]?.["delete"],
        "deleteAlert",
        "204",
      ],
      [
        document.paths["/v1/alerts/history"]?.["get"],
        "listAlertHistory",
        "200",
      ],
      [
        document.paths["/v1/notification-preferences"]?.["get"],
        "getNotificationPreferences",
        "200",
      ],
      [
        document.paths["/v1/notification-preferences"]?.["put"],
        "replaceNotificationPreferences",
        "200",
      ],
    ] as const;
    const preparePerpIntent = document.paths["/v1/perp/intents"]?.["post"];
    const getPerpIntent =
      document.paths["/v1/perp/intents/{intent_id}"]?.["get"];
    const submitPerpIntent =
      document.paths["/v1/perp/intents/{intent_id}/submit"]?.["post"];
    const issueAgentAuthorization =
      document.paths["/v1/perp/agent-authorizations"]?.["post"];
    const getAgentAuthorization =
      document.paths["/v1/perp/agent-authorizations/{authorization_id}"]?.[
        "get"
      ];
    const submitAgentAuthorizationSignature =
      document.paths[
        "/v1/perp/agent-authorizations/{authorization_id}/signatures"
      ]?.["post"];
    const transferOperations = [
      [
        document.paths["/v1/transfer/assets"]?.["get"],
        "listTransferAssets",
        false,
      ],
      [
        document.paths["/v1/transfer/recipient-preflight"]?.["post"],
        "runTransferRecipientPreflight",
        true,
      ],
      [
        document.paths["/v1/transfer/reviews"]?.["post"],
        "prepareTransferReview",
        true,
      ],
      [
        document.paths["/v1/transfer/authorize"]?.["post"],
        "authorizeTransfer",
        true,
      ],
      [
        document.paths["/v1/transfer/current-result"]?.["get"],
        "getCurrentTransferResult",
        false,
      ],
      [
        document.paths["/v1/transfer/reconciliation"]?.["get"],
        "getTransferReconciliation",
        false,
      ],
    ] as const;
    const perpReads = [
      [document.paths["/v1/perp/config"]?.["get"], "getPerpConfig"],
      [document.paths["/v1/perp/account"]?.["get"], "getPerpAccount"],
      [document.paths["/v1/perp/positions"]?.["get"], "listPerpPositions"],
      [document.paths["/v1/perp/orders"]?.["get"], "listPerpOrders"],
      [document.paths["/v1/perp/fills"]?.["get"], "listPerpFills"],
      [document.paths["/v1/perp/funding"]?.["get"], "listPerpFunding"],
    ] as const;

    expect(document.openapi).toBe("3.1.0");
    expect(document.servers).toEqual([
      { url: "https://api-dev.quant-dinger.cc" },
    ]);
    expect(paths).toEqual([
      "/health/live",
      "/health/ready",
      "/v1/alerts",
      "/v1/alerts/history",
      "/v1/alerts/{alert_id}",
      "/v1/bootstrap",
      "/v1/chat/token",
      "/v1/notification-preferences",
      "/v1/perp/account",
      "/v1/perp/agent-authorizations",
      "/v1/perp/agent-authorizations/{authorization_id}",
      "/v1/perp/agent-authorizations/{authorization_id}/signatures",
      "/v1/perp/config",
      "/v1/perp/fills",
      "/v1/perp/funding",
      "/v1/perp/intents",
      "/v1/perp/intents/{intent_id}",
      "/v1/perp/intents/{intent_id}/submit",
      "/v1/perp/orders",
      "/v1/perp/positions",
      "/v1/profile",
      "/v1/profile/privacy",
      "/v1/transfer/assets",
      "/v1/transfer/authorize",
      "/v1/transfer/current-result",
      "/v1/transfer/recipient-preflight",
      "/v1/transfer/reconciliation",
      "/v1/transfer/reviews",
      "/v1/video/token",
      "/v1/watchlist",
    ]);
    expect(operationIds.every((operationId) => operationId !== undefined)).toBe(
      true,
    );
    expect(operationIds).toHaveLength(37);
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

    for (const [operation, operationId] of personalizationOperations) {
      expect(operation).toMatchObject({
        operationId,
        security: [{ privyBearer: [] }],
      });
      for (const status of ["200", "400", "401", "409", "500", "503"]) {
        expect(operation?.responses).toHaveProperty(status);
      }
      expect(operation).toHaveProperty(
        "responses.200.headers.cache-control.schema.const",
        "no-store",
      );
      const serialized = JSON.stringify(operation);
      for (const forbidden of [
        "owner_user_id",
        "privy_user_id",
        "wallet_address",
        "provider_url",
        "firebase_token",
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    }

    expect(document.paths["/v1/profile"]?.["put"]).toHaveProperty(
      "requestBody.content.application/json.schema.properties.profile.properties.alias.anyOf.0.minLength",
      1,
    );
    expect(document.paths["/v1/profile"]?.["put"]).toHaveProperty(
      "requestBody.content.application/json.schema.properties.profile.properties.alias.anyOf.0.pattern",
    );
    expect(document.paths["/v1/watchlist"]?.["put"]).toHaveProperty(
      "requestBody.content.application/json.schema.properties.groups.description",
      "Complete snapshot with at most 20 groups and at most 100 items in aggregate across all groups.",
    );
    expect(document.paths["/v1/watchlist"]?.["get"]).toHaveProperty(
      "responses.200.content.application/json.schema.properties.groups.description",
      "Committed snapshot with at most 20 groups and at most 100 items in aggregate across all groups.",
    );

    for (const [operation, operationId, successStatus] of alertOperations) {
      expect(operation).toMatchObject({
        operationId,
        security: [{ privyBearer: [] }],
      });
      for (const status of ["400", "401", "409", "500", "503"]) {
        expect(operation?.responses).toHaveProperty(status);
      }
      expect(operation?.responses).toHaveProperty(successStatus);
      expect(operation).toHaveProperty(
        `responses.${successStatus}.headers.cache-control.schema.const`,
        "no-store",
      );
      const serializedRequest = JSON.stringify(operation?.requestBody ?? {});
      for (const forbidden of [
        "owner_user_id",
        "privy_user_id",
        "wallet_address",
        "provider_url",
        "source_fact",
        "firebase_token",
        "delivery_target",
        "scheduler",
      ]) {
        expect(serializedRequest).not.toContain(forbidden);
      }
    }

    expect(document.paths["/v1/alerts"]?.["post"]).toHaveProperty(
      "parameters.0.name",
      "idempotency-key",
    );
    expect(document.paths["/v1/alerts"]?.["post"]).toHaveProperty(
      "responses.409.content.application/json.schema.properties.code.enum",
      [
        "bootstrap_required",
        "idempotency_conflict",
        "idempotency_resource_deleted",
      ],
    );
    expect(document.paths["/v1/alerts"]?.["get"]).not.toHaveProperty(
      "responses.200.content.application/json.schema.properties.items.items.headers",
    );
    expect(
      document.paths["/v1/alerts/{alert_id}"]?.["get"]?.responses,
    ).toHaveProperty("404");
    expect(
      document.paths["/v1/alerts/{alert_id}"]?.["put"]?.responses,
    ).toHaveProperty("404");
    expect(
      document.paths["/v1/alerts/{alert_id}"]?.["delete"]?.responses,
    ).not.toHaveProperty("404");

    for (const [operation, operationId] of perpReads) {
      expect(operation).toMatchObject({
        operationId,
        security: [{ privyBearer: [] }],
      });
      expect(operation).not.toHaveProperty("requestBody");
      for (const status of ["200", "400", "401", "409", "500", "503"]) {
        expect(operation?.responses).toHaveProperty(status);
      }
      expect(operation).toHaveProperty(
        "responses.409.content.application/json.schema.properties.code.enum",
        ["bootstrap_required", "wallet_binding_required"],
      );
      expect(operation).toHaveProperty(
        "responses.503.content.application/json.schema.properties.code.enum",
        ["authentication_unavailable", "perp_unavailable", "request_timeout"],
      );
      const serialized = JSON.stringify(operation);
      expect(serialized).not.toContain("accountAddress");
      expect(serialized).not.toContain("account_address");
      expect(serialized).not.toContain("wallet_address");
      expect(serialized).not.toContain("agent_address");
      expect(serialized).not.toContain("mainnet");
    }

    expect(perpReads[0][0]).not.toHaveProperty("parameters");
    expect(perpReads[1][0]).not.toHaveProperty("parameters");
    for (const [operation] of perpReads.slice(2)) {
      expect(operation?.parameters?.map((parameter) => parameter.name)).toEqual(
        ["limit", "cursor"],
      );
    }

    for (const [operation, operationId, statuses] of [
      [
        preparePerpIntent,
        "preparePerpIntent",
        ["200", "400", "401", "409", "429", "500", "503"],
      ],
      [
        getPerpIntent,
        "getPerpIntent",
        ["200", "400", "401", "404", "409", "500", "503"],
      ],
      [
        submitPerpIntent,
        "submitPerpIntent",
        ["200", "400", "401", "403", "404", "409", "500", "503"],
      ],
    ] as const) {
      expect(operation).toMatchObject({
        operationId,
        security: [{ privyBearer: [] }],
      });
      for (const status of statuses) {
        expect(operation?.responses).toHaveProperty(status);
      }
      const serialized = JSON.stringify(operation);
      expect(serialized).not.toContain("account_address");
      expect(serialized).not.toContain("wallet_address");
      expect(serialized).not.toContain("agent_address");
      expect(serialized).not.toContain("signature");
      expect(serialized).not.toContain("nonce");
      expect(serialized).not.toContain("mainnet");
    }

    for (const [operation, operationId, statuses] of [
      [
        issueAgentAuthorization,
        "issueAgentAuthorization",
        ["400", "401", "403", "409", "500", "503"],
      ],
      [
        getAgentAuthorization,
        "getAgentAuthorization",
        ["200", "400", "401", "404", "409", "500", "503"],
      ],
      [
        submitAgentAuthorizationSignature,
        "submitAgentAuthorizationSignature",
        ["200", "400", "401", "403", "404", "409", "500", "503"],
      ],
    ] as const) {
      expect(operation).toMatchObject({
        operationId,
        security: [{ privyBearer: [] }],
      });
      for (const status of statuses) {
        expect(operation?.responses).toHaveProperty(status);
      }
      const serializedRequest = JSON.stringify(operation?.requestBody ?? {});
      expect(serializedRequest).not.toContain("typed_data_json");
      expect(serializedRequest).not.toContain("typedDataJson");
      expect(serializedRequest).not.toContain("nonce");
      expect(serializedRequest).not.toContain("mainnet");
      expect(serializedRequest).not.toContain("provider_url");
    }
    expect(issueAgentAuthorization).not.toHaveProperty("requestBody");
    expect(issueAgentAuthorization?.responses).not.toHaveProperty("200");
    expect(getAgentAuthorization).not.toHaveProperty("requestBody");
    expect(submitAgentAuthorizationSignature).toHaveProperty("requestBody");

    for (const [operation, operationId, hasRequestBody] of transferOperations) {
      expect(operation).toMatchObject({
        operationId,
        security: [{ privyBearer: [] }],
      });
      expect(Object.keys(operation?.responses ?? {}).sort()).toEqual([
        "400",
        "401",
        "409",
        "500",
        "503",
      ]);
      expect(operation?.responses).not.toHaveProperty("200");
      expect(operation).toHaveProperty(
        "responses.503.content.application/json.schema.properties.code.enum",
        [
          "authentication_unavailable",
          "transfer_unavailable",
          "request_timeout",
        ],
      );
      if (hasRequestBody) {
        expect(operation).toHaveProperty("requestBody");
      } else {
        expect(operation).not.toHaveProperty("requestBody");
      }
      const serializedRequest = JSON.stringify(operation?.requestBody ?? {});
      for (const forbidden of [
        "owner_user_id",
        "wallet_id",
        "wallet_epoch",
        "action_id",
        "submission_record_id",
        "nonce",
        "idempotency_key",
        "provider_url",
      ]) {
        expect(serializedRequest).not.toContain(forbidden);
      }
    }

    const prepareTransferReview = transferOperations[2][0];
    expect(prepareTransferReview).toHaveProperty(
      "requestBody.content.application/json.schema.properties.amount_decimal.type",
      "string",
    );
    const authorizeTransfer = transferOperations[3][0];
    expect(authorizeTransfer).toHaveProperty(
      "requestBody.content.application/json.schema.oneOf.1.properties.authorization_signature.type",
      "string",
    );
    expect(authorizeTransfer).toHaveProperty(
      "requestBody.content.application/json.schema.oneOf.1.properties.official_formatter_envelope_sha256.pattern",
      "^[0-9a-f]{64}$",
    );
  });
});
