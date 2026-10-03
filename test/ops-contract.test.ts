import { describe, expect, it } from "vitest";
import { opsCommandSchema, opsHash } from "../src/features/ops/ops-contract.js";

describe("operations command boundary", () => {
  it("hashes key order canonically without conflating values", () => {
    expect(opsHash({ a: "1", b: [2] })).toBe(opsHash({ b: [2], a: "1" }));
    expect(opsHash({ a: "1" })).not.toBe(opsHash({ a: 1 }));
  });
  it("rejects supplied actors and unsupported execution actions", () => {
    expect(
      opsCommandSchema.safeParse({ action: "transfer", actor: "admin" })
        .success,
    ).toBe(false);
    expect(
      opsCommandSchema.safeParse({
        action: "support.answer",
        operationId: "b51b0ade-16dc-4c1e-9dd3-2f387a076591",
        target: "b51b0ade-16dc-4c1e-9dd3-2f387a076590",
        reason: "处理",
        payload: { status: "answered", note: "已处理" },
        actor: "admin",
      }).success,
    ).toBe(false);
  });
});
