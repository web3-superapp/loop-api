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
    const publicAliasSearch = document.paths["/v1/discovery/users"]?.["get"];
    const resolveChatGroup =
      document.paths["/v1/chat/groups/resolve"]?.["post"];
    const getCurrentGroupAlias =
      document.paths["/v1/chat/groups/{group_id}/me/alias"]?.["get"];
    const putCurrentGroupAlias =
      document.paths["/v1/chat/groups/{group_id}/me/alias"]?.["put"];
    const searchGroupAliases =
      document.paths["/v1/chat/groups/{group_id}/aliases"]?.["get"];
    const socialAndChatOperations = [
      [
        document.paths["/v1/profile/social-privacy"]?.["get"],
        "getCurrentSocialPrivacy",
      ],
      [
        document.paths["/v1/profile/social-privacy"]?.["put"],
        "replaceCurrentSocialPrivacy",
      ],
      [document.paths["/v1/friends"]?.["get"], "listFriends"],
      [document.paths["/v1/friends/search"]?.["get"], "searchFriendsByAlias"],
      [document.paths["/v1/friend-requests"]?.["post"], "sendFriendRequest"],
      [document.paths["/v1/friend-requests"]?.["get"], "listFriendRequests"],
      [
        document.paths["/v1/friend-requests/{friend_request_id}/decision"]?.[
          "post"
        ],
        "decideFriendRequest",
      ],
      [
        document.paths["/v1/social/operations/{operation_id}"]?.["get"],
        "getSocialOperation",
      ],
      [document.paths["/v1/chat/groups"]?.["post"], "createChatGroup"],
      [
        document.paths["/v1/chat/direct-channels"]?.["post"],
        "getOrCreateDirectChatChannel",
      ],
      [
        document.paths["/v1/chat/operations/{operation_id}"]?.["get"],
        "getChatOperation",
      ],
    ] as const;
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
    const walletBindingOperations = [
      [
        document.paths["/v1/perp/wallet-binding"]?.["get"],
        "getPerpWalletBinding",
      ],
      [
        document.paths["/v1/perp/wallet-binding"]?.["put"],
        "putPerpWalletBinding",
      ],
      [
        document.paths["/v1/perp/wallet-binding"]?.["delete"],
        "deletePerpWalletBinding",
      ],
    ] as const;
    const spotOperations = [
      [
        document.paths["/v1/spot/config"]?.["get"],
        "getSpotConfig",
        ["200", "400", "401", "409", "500", "503"],
      ],
      [
        document.paths["/v1/spot/markets/{market_id}/facts"]?.["get"],
        "getSpotMarketFacts",
        ["200", "400", "401", "404", "409", "500", "503"],
      ],
      [
        document.paths["/v1/spot/balances"]?.["get"],
        "getSpotBalances",
        ["200", "400", "401", "409", "500", "503"],
      ],
      [
        document.paths["/v1/spot/intents"]?.["post"],
        "prepareSpotIntent",
        ["201", "400", "401", "409", "429", "500", "503"],
      ],
      [
        document.paths["/v1/spot/intents/{intent_id}"]?.["get"],
        "getSpotIntent",
        ["200", "400", "401", "404", "409", "500", "503"],
      ],
      [
        document.paths["/v1/spot/intents/{intent_id}/submit"]?.["post"],
        "submitSpotIntent",
        ["200", "400", "401", "404", "409", "500", "503"],
      ],
      [
        document.paths["/v1/spot/wallet-binding"]?.["get"],
        "getSpotWalletBinding",
        ["200", "400", "401", "409", "500", "503"],
      ],
      [
        document.paths["/v1/spot/wallet-binding"]?.["put"],
        "putSpotWalletBinding",
        ["200", "400", "401", "409", "500", "503"],
      ],
      [
        document.paths["/v1/spot/wallet-binding"]?.["delete"],
        "deleteSpotWalletBinding",
        ["200", "400", "401", "409", "500", "503"],
      ],
      [
        document.paths["/v1/spot/agent-authorizations"]?.["post"],
        "issueSpotAgentAuthorization",
        ["201", "400", "401", "409", "500", "503"],
      ],
      [
        document.paths["/v1/spot/agent-authorizations/{authorization_id}"]?.[
          "get"
        ],
        "getSpotAgentAuthorization",
        ["200", "400", "401", "404", "409", "500", "503"],
      ],
      [
        document.paths[
          "/v1/spot/agent-authorizations/{authorization_id}/signatures"
        ]?.["post"],
        "submitSpotAgentAuthorizationSignature",
        ["200", "400", "401", "404", "409", "500", "503"],
      ],
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
      "/v1/chat/direct-channels",
      "/v1/chat/groups",
      "/v1/chat/groups/resolve",
      "/v1/chat/groups/{group_id}/aliases",
      "/v1/chat/groups/{group_id}/me/alias",
      "/v1/chat/operations/{operation_id}",
      "/v1/chat/token",
      "/v1/discovery/users",
      "/v1/friend-requests",
      "/v1/friend-requests/{friend_request_id}/decision",
      "/v1/friends",
      "/v1/friends/search",
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
      "/v1/perp/wallet-binding",
      "/v1/profile",
      "/v1/profile/privacy",
      "/v1/profile/social-privacy",
      "/v1/social/operations/{operation_id}",
      "/v1/spot/agent-authorizations",
      "/v1/spot/agent-authorizations/{authorization_id}",
      "/v1/spot/agent-authorizations/{authorization_id}/signatures",
      "/v1/spot/balances",
      "/v1/spot/config",
      "/v1/spot/intents",
      "/v1/spot/intents/{intent_id}",
      "/v1/spot/intents/{intent_id}/submit",
      "/v1/spot/markets/{market_id}/facts",
      "/v1/spot/wallet-binding",
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
    expect(operationIds).toHaveLength(68);
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

    expect(publicAliasSearch).toMatchObject({
      operationId: "searchDiscoverableUsersByAlias",
      security: [{ privyBearer: [] }],
    });
    expect(publicAliasSearch).not.toHaveProperty("requestBody");
    expect(publicAliasSearch?.parameters?.map(({ name }) => name)).toEqual([
      "alias_prefix",
      "limit",
    ]);
    expect(publicAliasSearch).toHaveProperty(
      "responses.200.content.application/json.schema.properties.items.items.required",
      ["public_profile_id", "profile_code", "alias", "avatar_ref"],
    );
    expect(publicAliasSearch).toHaveProperty(
      "responses.429.content.application/json.schema.properties.code.enum",
      ["search_rate_limited"],
    );

    expect(resolveChatGroup).toMatchObject({
      operationId: "resolveExistingStreamGroup",
      security: [{ privyBearer: [] }],
    });
    expect(resolveChatGroup).toHaveProperty(
      "requestBody.content.application/json.schema.required",
      ["stream_channel_id"],
    );
    expect(resolveChatGroup).toHaveProperty(
      "responses.200.content.application/json.schema.required",
      ["group_id"],
    );

    for (const [operation, operationId] of [
      [getCurrentGroupAlias, "getCurrentGroupAlias"],
      [putCurrentGroupAlias, "putCurrentGroupAlias"],
      [searchGroupAliases, "searchCurrentGroupAliases"],
    ] as const) {
      expect(operation).toMatchObject({
        operationId,
        security: [{ privyBearer: [] }],
      });
      expect(operation).toHaveProperty(
        "responses.200.headers.cache-control.schema.const",
        "no-store",
      );
    }
    expect(getCurrentGroupAlias).not.toHaveProperty("requestBody");
    expect(putCurrentGroupAlias).toHaveProperty(
      "requestBody.content.application/json.schema.required",
      ["alias"],
    );
    expect(searchGroupAliases).not.toHaveProperty("requestBody");
    expect(searchGroupAliases?.parameters?.map(({ name }) => name)).toEqual([
      "alias_prefix",
      "limit",
      "group_id",
    ]);
    expect(searchGroupAliases).toHaveProperty(
      "responses.200.content.application/json.schema.properties.items.items.required",
      ["group_alias_id", "alias"],
    );
    for (const [operation, operationId] of socialAndChatOperations) {
      expect(operation).toMatchObject({
        operationId,
        security: [{ privyBearer: [] }],
      });
      expect(operation).toHaveProperty(
        "responses.200.headers.cache-control.schema.const",
        "no-store",
      );
      const serialized = JSON.stringify(operation);
      for (const forbidden of [
        "owner_user_id",
        "privy_user_id",
        "stream_user_id",
        "wallet_address",
        "api_secret",
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    }
    for (const operation of [
      document.paths["/v1/friend-requests"]?.["post"],
      document.paths["/v1/friend-requests/{friend_request_id}/decision"]?.[
        "post"
      ],
      document.paths["/v1/chat/groups"]?.["post"],
      document.paths["/v1/chat/direct-channels"]?.["post"],
    ]) {
      expect(operation?.parameters?.map(({ name }) => name)).toContain(
        "idempotency-key",
      );
    }
    for (const operation of [
      publicAliasSearch,
      resolveChatGroup,
      getCurrentGroupAlias,
      putCurrentGroupAlias,
      searchGroupAliases,
    ]) {
      const serializedResponses = JSON.stringify(operation?.responses ?? {});
      for (const forbidden of [
        "owner_user_id",
        "privy_user_id",
        "stream_user_id",
        "wallet_address",
        "stream_channel_id",
      ]) {
        expect(serializedResponses).not.toContain(forbidden);
      }
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
      const serializedRequest = JSON.stringify({
        parameters: operation?.parameters ?? [],
        requestBody: operation?.requestBody ?? {},
      });
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

    for (const [operation, operationId] of walletBindingOperations) {
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
      expect(operation).toHaveProperty(
        "responses.200.content.application/json.schema.properties.account_kind.anyOf.0.enum",
        ["master"],
      );
      const serialized = JSON.stringify(operation);
      for (const forbidden of [
        "account_address",
        "wallet_id",
        "privy_user_id",
        "owner_user_id",
        "subaccount",
        "did:privy",
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    }
    const getWalletBinding = walletBindingOperations[0][0];
    const putWalletBinding = walletBindingOperations[1][0];
    const deleteWalletBinding = walletBindingOperations[2][0];
    expect(getWalletBinding).not.toHaveProperty("parameters");
    expect(getWalletBinding).not.toHaveProperty("requestBody");
    expect(putWalletBinding).not.toHaveProperty("parameters");
    expect(putWalletBinding).toHaveProperty(
      "requestBody.content.application/json.schema.required",
      ["expected_binding_version"],
    );
    expect(putWalletBinding).toHaveProperty(
      "requestBody.content.application/json.schema.additionalProperties",
      false,
    );
    expect(deleteWalletBinding).not.toHaveProperty("requestBody");
    expect(
      deleteWalletBinding?.parameters?.map((parameter) => parameter.name),
    ).toEqual(["expected_binding_version"]);

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

    for (const [operation, operationId, statuses] of spotOperations) {
      expect(operation).toMatchObject({
        operationId,
        security: [{ privyBearer: [] }],
      });
      expect(Object.keys(operation?.responses ?? {}).sort()).toEqual(statuses);
      expect(operation).toHaveProperty(
        "responses.503.content.application/json.schema.properties.code.enum",
        ["authentication_unavailable", "spot_unavailable", "request_timeout"],
      );
      const serializedRequest = JSON.stringify(operation?.requestBody ?? {});
      for (const forbidden of [
        "network",
        "provider_url",
        "account_address",
        "wallet_id",
        "owner_user_id",
        "agent_address",
        "nonce",
        "cloid",
        "canonical_action",
        "transport_attempt_id",
      ]) {
        expect(serializedRequest).not.toContain(forbidden);
      }
      const serialized = JSON.stringify(operation);
      for (const forbidden of [
        "mainnet",
        "provider_url",
        "account_address",
        "wallet_id",
        "owner_user_id",
        "canonical_action",
        "transport_attempt_id",
        "signer_ref",
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    }
    for (const [index, [operation]] of spotOperations.entries()) {
      if (index === 9) {
        continue;
      }
      const serializedResponses = JSON.stringify(operation?.responses ?? {});
      for (const forbidden of [
        "provider_url",
        "account_address",
        "wallet_id",
        "owner_user_id",
        "agent_address",
        "nonce",
        "cloid",
        "canonical_action",
        "transport_attempt_id",
        "signer_ref",
        "signable_payload",
        "typed_data",
      ]) {
        expect(serializedResponses).not.toContain(forbidden);
      }
    }
    expect(spotOperations[3][0]).toHaveProperty(
      "parameters.0.name",
      "idempotency-key",
    );
    for (const branch of [0, 1]) {
      expect(spotOperations[3][0]).toHaveProperty(
        `requestBody.content.application/json.schema.oneOf.${branch}.additionalProperties`,
        false,
      );
    }
    expect(spotOperations[9][0]).not.toHaveProperty("requestBody");
    expect(spotOperations[9][0]).toHaveProperty(
      "responses.201.content.application/json.schema.properties.signable_payload.properties.nonce",
      {
        type: "string",
        pattern: "^(?:0|[1-9][0-9]{0,19})$",
        maxLength: 20,
      },
    );
    expect(spotOperations[9][0]).toHaveProperty(
      "responses.201.content.application/json.schema.properties.signable_payload.properties.typed_data.properties.message.properties.nonce",
      {
        type: "integer",
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
      },
    );
    expect(
      JSON.stringify(spotOperations[10][0]?.responses?.["200"] ?? {}),
    ).not.toContain("signable_payload");
    expect(spotOperations[11][0]).toHaveProperty(
      "requestBody.content.application/json.schema.required",
      ["signature"],
    );

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
