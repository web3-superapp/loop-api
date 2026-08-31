import { describe, expect, it } from "vitest";

import {
  digestCreateChatGroupRequest,
  digestCreateDirectChannelRequest,
  isTerminalChatOperationStatus,
  parseChatIdempotencyKey,
  parseChatOperationId,
  parseCreateChatGroupRequest,
  parseCreateDirectChannelRequest,
} from "../src/features/communication/chat-channel-contract.js";

const firstProfileId = "11111111-1111-4111-8111-111111111111";
const secondProfileId = "22222222-2222-4222-8222-222222222222";
const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("Chat channel contract", () => {
  it("parses a bounded group command and trims only its display name", () => {
    expect(
      parseCreateChatGroupRequest({
        name: "  Weekend traders  ",
        friend_public_profile_ids: [firstProfileId, secondProfileId],
      }),
    ).toEqual({
      name: "Weekend traders",
      friend_public_profile_ids: [firstProfileId, secondProfileId],
    });
  });

  it("rejects duplicate, undersized, oversized, unsafe, and additional group input", () => {
    const valid = {
      name: "Loop",
      friend_public_profile_ids: [firstProfileId, secondProfileId],
    };
    expect(() =>
      parseCreateChatGroupRequest({
        ...valid,
        friend_public_profile_ids: [firstProfileId, firstProfileId],
      }),
    ).toThrow();
    expect(() =>
      parseCreateChatGroupRequest({
        ...valid,
        friend_public_profile_ids: [firstProfileId],
      }),
    ).toThrow();
    expect(() =>
      parseCreateChatGroupRequest({
        ...valid,
        friend_public_profile_ids: Array.from(
          { length: 30 },
          (_, index) =>
            `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
        ),
      }),
    ).toThrow();
    expect(() =>
      parseCreateChatGroupRequest({ ...valid, name: "unsafe\nname" }),
    ).toThrow();
    expect(() =>
      parseCreateChatGroupRequest({ ...valid, unexpected: true }),
    ).toThrow();
  });

  it("parses only the explicit public target of a direct-channel command", () => {
    expect(
      parseCreateDirectChannelRequest({
        target_public_profile_id: firstProfileId,
      }),
    ).toEqual({ target_public_profile_id: firstProfileId });
    expect(() =>
      parseCreateDirectChannelRequest({
        target_public_profile_id: firstProfileId,
        stream_user_id: "loop_forbidden",
      }),
    ).toThrow();
  });

  it("accepts exactly one raw canonical lowercase UUIDv4 Idempotency-Key", () => {
    expect(
      parseChatIdempotencyKey([
        "authorization",
        "Bearer token",
        "Idempotency-Key",
        operationId,
      ]),
    ).toBe(operationId);

    for (const rawHeaders of [
      [],
      ["idempotency-key", operationId, "Idempotency-Key", operationId],
      ["idempotency-key", ` ${operationId}`],
      ["idempotency-key", operationId.toUpperCase()],
      ["idempotency-key", "aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa"],
      ["idempotency-key"],
    ]) {
      expect(() => parseChatIdempotencyKey(rawHeaders)).toThrow();
    }
  });

  it("binds group idempotency to kind, trimmed name, and an unordered friend set", () => {
    const forward = parseCreateChatGroupRequest({
      name: "Desk",
      friend_public_profile_ids: [firstProfileId, secondProfileId],
    });
    const reverse = parseCreateChatGroupRequest({
      name: "Desk",
      friend_public_profile_ids: [secondProfileId, firstProfileId],
    });
    expect(digestCreateChatGroupRequest(forward)).toBe(
      digestCreateChatGroupRequest(reverse),
    );
    expect(
      digestCreateChatGroupRequest({ ...forward, name: "Other desk" }),
    ).not.toBe(digestCreateChatGroupRequest(forward));
    expect(
      digestCreateDirectChannelRequest({
        target_public_profile_id: firstProfileId,
      }),
    ).not.toBe(digestCreateChatGroupRequest(forward));
  });

  it("accepts only canonical UUIDv4 operation locators", () => {
    expect(parseChatOperationId(operationId)).toBe(operationId);
    expect(() =>
      parseChatOperationId("aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa"),
    ).toThrow();
    expect(() => parseChatOperationId(operationId.toUpperCase())).toThrow();
  });

  it("treats success, failure, and operator intervention as terminal", () => {
    expect(isTerminalChatOperationStatus("pending")).toBe(false);
    expect(isTerminalChatOperationStatus("submitting")).toBe(false);
    expect(isTerminalChatOperationStatus("reconciling")).toBe(false);
    expect(isTerminalChatOperationStatus("succeeded")).toBe(true);
    expect(isTerminalChatOperationStatus("failed")).toBe(true);
    expect(isTerminalChatOperationStatus("operator_required")).toBe(true);
  });
});
