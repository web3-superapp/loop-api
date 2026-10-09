import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  parsePrepareTransferReviewRequest,
  parseRecipientPreflightRequest,
  parseTransferAuthorizationRequest,
  TRANSFER_FORBIDDEN_CLIENT_KEYS,
} from "../src/features/transfer/transfer-contract.js";
import {
  createUnavailableTransferService,
  TransferUnavailableError,
} from "../src/features/transfer/transfer-service.js";

describe("Transfer request contract", () => {
  it("keeps the recursive denylist equal to the reviewed BFF contract", async () => {
    const authority = JSON.parse(
      await readFile(
        new URL(
          "../contracts/privy-transfer/bff-contract.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      readonly operations: readonly {
        readonly forbidden_client_keys: readonly string[];
      }[];
    };
    const reviewedKeys = [
      ...new Set(
        authority.operations.flatMap(({ forbidden_client_keys: keys }) => keys),
      ),
    ].sort();

    expect([...TRANSFER_FORBIDDEN_CLIENT_KEYS].sort()).toEqual(reviewedKeys);
  });

  it("accepts the two exact recipient-preflight variants without guessing unresolved value shapes", () => {
    const resolve = parseRecipientPreflightRequest({
      command: "resolve",
      asset_selection_id: { contract: "pending" },
      recipient_input: ["unresolved"],
    });
    const acknowledge = parseRecipientPreflightRequest({
      command: "acknowledge",
      preflight_handle: null,
      acknowledgement_kind: "history_unknown",
    });

    expect(resolve).toEqual({
      command: "resolve",
      asset_selection_id: { contract: "pending" },
      recipient_input: ["unresolved"],
    });
    expect(acknowledge).toEqual({
      command: "acknowledge",
      preflight_handle: null,
      acknowledgement_kind: "history_unknown",
    });
    expect(Object.isFrozen(resolve)).toBe(true);
    expect(Object.isFrozen(acknowledge)).toBe(true);
  });

  it.each([
    {},
    { command: "resolve", asset_selection_id: "asset" },
    {
      command: "resolve",
      asset_selection_id: "asset",
      recipient_input: "recipient",
      owner_user_id: "forbidden",
    },
    {
      command: "acknowledge",
      preflight_handle: "handle",
      acknowledgement_kind: "unsupported",
    },
    {
      command: "submit_signature",
      prepared_review_handle: "handle",
      authorization_signature: "signature",
      official_formatter_envelope_sha256: "a".repeat(64),
    },
  ])("rejects a non-contract recipient-preflight body %#", (body) => {
    expect(() => parseRecipientPreflightRequest(body)).toThrow();
  });

  it("keeps the review handle unresolved while requiring a positive decimal string", () => {
    const request = parsePrepareTransferReviewRequest({
      preflight_handle: 42,
      amount_decimal: "1.2500",
    });

    expect(request).toEqual({
      preflight_handle: 42,
      amount_decimal: "1.2500",
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(() =>
      parsePrepareTransferReviewRequest({
        preflight_handle: "handle",
        amount_decimal: "1.0",
        wallet_id: "forbidden",
      }),
    ).toThrow();
  });

  it.each([0, 1, "0", "-1", "01.0", "1e3", {}, "1".repeat(129)])(
    "rejects a non-canonical transfer amount %#",
    (amountDecimal) => {
      expect(() =>
        parsePrepareTransferReviewRequest({
          preflight_handle: "handle",
          amount_decimal: amountDecimal,
        }),
      ).toThrow();
    },
  );

  it.each([
    {
      command: "resolve",
      asset_selection_id: "asset",
      recipient_input: undefined,
    },
    {
      command: "resolve",
      asset_selection_id: "asset",
      recipient_input: { nested: { wallet_id: "forbidden" } },
    },
    {
      command: "acknowledge",
      preflight_handle: { idempotency_key: "forbidden" },
      acknowledgement_kind: "first_recipient",
    },
  ])("rejects unsafe unresolved JSON authority %#", (body) => {
    expect(() => parseRecipientPreflightRequest(body)).toThrow();
  });

  it("accepts the two exact authorization variants and a canonical lowercase SHA-256 digest", () => {
    const issue = parseTransferAuthorizationRequest({
      command: "issue_payload",
      prepared_review_handle: { unresolved: true },
    });
    const submit = parseTransferAuthorizationRequest({
      command: "submit_signature",
      prepared_review_handle: null,
      authorization_signature: "opaque-signature",
      official_formatter_envelope_sha256: "a".repeat(64),
    });

    expect(issue.command).toBe("issue_payload");
    expect(submit.command).toBe("submit_signature");
    expect(Object.isFrozen(issue)).toBe(true);
    expect(Object.isFrozen(submit)).toBe(true);
  });

  it.each([
    {
      command: "issue_payload",
    },
    {
      command: "submit_signature",
      prepared_review_handle: "handle",
      authorization_signature: "",
      official_formatter_envelope_sha256: "a".repeat(64),
    },
    {
      command: "submit_signature",
      prepared_review_handle: "handle",
      authorization_signature: ["not-a-string"],
      official_formatter_envelope_sha256: "a".repeat(64),
    },
    {
      command: "submit_signature",
      prepared_review_handle: "handle",
      authorization_signature: "signature",
      official_formatter_envelope_sha256: "A".repeat(64),
    },
    {
      command: "submit_signature",
      prepared_review_handle: "handle",
      authorization_signature: "signature",
      official_formatter_envelope_sha256: "a".repeat(63),
    },
    {
      command: "submit_signature",
      prepared_review_handle: "handle",
      authorization_signature: "signature",
      official_formatter_envelope_sha256: "a".repeat(64),
      idempotency_key: "forbidden",
    },
  ])("rejects a non-contract authorization body %#", (body) => {
    expect(() => parseTransferAuthorizationRequest(body)).toThrow();
  });
});

describe("Unavailable transfer service", () => {
  const service = createUnavailableTransferService();
  const context = Object.freeze({
    principal: Object.freeze({
      userId: "6d12a86e-4134-47e6-9312-c5ef75a30f55",
      privyUserId: "did:privy:transfer-service-user",
      streamUserId: "loop_6d12a86e413447e69312c5ef75a30f55",
    }),
    requestId: "17f57f3c-a593-43c2-b416-0809a056a4ef",
    signal: new AbortController().signal,
  });

  it.each([
    () => service.listAssets(context),
    () =>
      service.recipientPreflight({
        ...context,
        body: parseRecipientPreflightRequest({
          command: "resolve",
          asset_selection_id: null,
          recipient_input: null,
        }),
      }),
    () =>
      service.prepareReview({
        ...context,
        body: parsePrepareTransferReviewRequest({
          preflight_handle: null,
          amount_decimal: "1.25",
        }),
      }),
    () =>
      service.authorize({
        ...context,
        body: parseTransferAuthorizationRequest({
          command: "issue_payload",
          prepared_review_handle: null,
        }),
      }),
    () => service.readCurrentResult(context),
    () => service.readReconciliation(context),
  ])("fails closed without composing a capability %#", async (operation) => {
    await expect(operation()).rejects.toBeInstanceOf(TransferUnavailableError);
  });
});
