import { describe, expect, it, vi } from "vitest";

import {
  allocateLoopId,
  generateLoopId,
  InvalidLoopIdError,
  isLoopId,
  LoopIdAllocationExhaustedError,
  loopIdPatternSource,
  maximumLoopIdAllocationAttempts,
  parseLoopId,
} from "../src/features/identity/loop-id.js";

describe("LOOP ID generation and validation", () => {
  it("generates LOOP- plus eight Crockford Base32 characters without I, L, O, or U", () => {
    const pattern = new RegExp(loopIdPatternSource);
    const generated = new Set<string>();
    for (let index = 0; index < 500; index += 1) {
      const loopId = generateLoopId();
      expect(loopId).toMatch(pattern);
      expect(loopId).toHaveLength(13);
      expect(loopId.slice(5)).not.toMatch(/[ILOU]/);
      expect(loopId).not.toMatch(/[a-z]/);
      generated.add(loopId);
    }
    expect(generated.size).toBe(500);
  });

  it("uses the whole alphabet across many samples", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 2_000; index += 1) {
      for (const character of generateLoopId().slice(5)) {
        seen.add(character);
      }
    }
    expect([...seen].sort().join("")).toBe("0123456789ABCDEFGHJKMNPQRSTVWXYZ");
  });

  it.each([
    "LOOP-0123456789",
    "loop-abcdefgh",
    "LOOP-ABCDEFGI",
    "LOOP-ABCDEFGL",
    "LOOP-ABCDEFGO",
    "LOOP-ABCDEFGU",
    "LOOP-ABCDEFG",
    " LOOP-ABCDEFGH",
    "",
    42,
    null,
  ])("rejects %j as a LOOP ID", (value) => {
    expect(isLoopId(value)).toBe(false);
    expect(() => parseLoopId(value)).toThrow(InvalidLoopIdError);
  });

  it("accepts canonical values", () => {
    expect(parseLoopId("LOOP-0123ABCZ")).toBe("LOOP-0123ABCZ");
    expect(isLoopId("LOOP-7HJKMNPQ")).toBe(true);
  });

  it("retries fresh candidates on unique conflicts and stops after the bound", async () => {
    const candidates = ["LOOP-AAAAAAAA", "LOOP-BBBBBBBB", "LOOP-CCCCCCCC"];
    const generate = vi.fn(() => candidates.shift() ?? "LOOP-ZZZZZZZZ");
    const attempt = vi.fn((candidate: string) =>
      Promise.resolve(
        candidate === "LOOP-CCCCCCCC"
          ? ({ status: "allocated", value: candidate } as const)
          : ({ status: "conflict" } as const),
      ),
    );

    await expect(allocateLoopId({ attempt, generate })).resolves.toBe(
      "LOOP-CCCCCCCC",
    );
    expect(attempt).toHaveBeenCalledTimes(3);

    const alwaysConflict = vi.fn(() =>
      Promise.resolve({ status: "conflict" } as const),
    );
    await expect(
      allocateLoopId({ attempt: alwaysConflict }),
    ).rejects.toBeInstanceOf(LoopIdAllocationExhaustedError);
    expect(alwaysConflict).toHaveBeenCalledTimes(
      maximumLoopIdAllocationAttempts,
    );
  });

  it("refuses a generator that produces a non-canonical candidate", async () => {
    await expect(
      allocateLoopId({
        attempt: () => Promise.resolve({ status: "conflict" }),
        generate: () => "LOOP-abcdefgh",
      }),
    ).rejects.toBeInstanceOf(InvalidLoopIdError);
  });
});
