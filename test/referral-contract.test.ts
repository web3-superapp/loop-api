import { describe, expect, it } from "vitest";

import {
  InvalidInviteCodeError,
  generateInviteCode,
  inviteCodeCheckSymbol,
  isInviteCode,
  normalizeInviteCode,
  parseInviteCode,
} from "../src/features/referral/invite-code.js";
import {
  InvalidReferralRequestError,
  ReferralCycleError,
  ReferralSelfInviteError,
  claimWindow,
  initialValidationStatus,
  materializeReferralEdges,
  parseReferralClaimRequest,
  referralMaximumDepth,
} from "../src/features/referral/referral-contract.js";

const a = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const b = "1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d";
const c = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const d = "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f";
const e = "7d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5f6";
const f = "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
const g = "d64786bb-408d-415d-8a69-6277d56c921b";

describe("invite code", () => {
  it("generates LOOP- plus four Crockford symbols and a valid check symbol", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      const code = generateInviteCode();
      expect(code).toMatch(/^LOOP-[0-9A-HJKMNP-TV-Z]{5}$/);
      expect(isInviteCode(code)).toBe(true);
      seen.add(code);
    }
    // Random, not sequential: 200 draws over a ~1M space collide rarely.
    expect(seen.size).toBeGreaterThan(190);
  });

  it("detects any single-symbol corruption through the check symbol", () => {
    const data = "7HJK";
    const code = `LOOP-${data}${inviteCodeCheckSymbol(data)}`;
    expect(isInviteCode(code)).toBe(true);
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    for (let position = 5; position < 9; position += 1) {
      for (const symbol of alphabet) {
        if (symbol === code.charAt(position)) {
          continue;
        }
        const corrupted = `${code.slice(0, position)}${symbol}${code.slice(position + 1)}`;
        expect(isInviteCode(corrupted), corrupted).toBe(false);
      }
    }
  });

  it("normalises user input (case, Crockford aliases, missing prefix) and rejects garbage", () => {
    const data = "7HJK";
    const code = `LOOP-${data}${inviteCodeCheckSymbol(data)}`;
    expect(parseInviteCode(code.toLowerCase())).toBe(code);
    expect(parseInviteCode(` ${code.slice(5)} `)).toBe(code);
    expect(normalizeInviteCode("loop-7hjk" + code.slice(-1))).toBe(code);
    expect(parseInviteCode(code.replace("7", "7").replace("J", "J"))).toBe(
      code,
    );
    for (const bad of [
      "",
      "LOOP-",
      "LOOP-7HJK",
      "LOOP-7HJKMX",
      "LOOP-7HJU0",
      42,
      null,
    ]) {
      expect(() => parseInviteCode(bad)).toThrow(InvalidInviteCodeError);
    }
    expect(() => parseReferralClaimRequest({ inviteCode: "nope" })).toThrow(
      InvalidReferralRequestError,
    );
    expect(() =>
      parseReferralClaimRequest({ inviteCode: code, extra: 1 }),
    ).toThrow(InvalidReferralRequestError);
  });
});

describe("claim window", () => {
  it("is open for seven days after activation and closed afterwards", () => {
    const activatedAt = "2026-09-01T00:00:00.000Z";
    expect(
      claimWindow(activatedAt, new Date("2026-09-07T23:59:59.000Z")),
    ).toEqual({
      status: "open",
      activatedAt,
      closesAt: "2026-09-08T00:00:00.000Z",
    });
    expect(
      claimWindow(activatedAt, new Date("2026-09-08T00:00:00.000Z")).status,
    ).toBe("closed");
    expect(claimWindow(null, new Date())).toEqual({
      status: "unavailable",
      reasonCode: "PROFILE_ACTIVATION_REQUIRED",
    });
  });

  it("derives the initial validation status from activation and wallet binding", () => {
    expect(
      initialValidationStatus({ activated: false, hasWallet: false }),
    ).toBe("pending_activation");
    expect(initialValidationStatus({ activated: true, hasWallet: false })).toBe(
      "pending_wallet",
    );
    expect(initialValidationStatus({ activated: true, hasWallet: true })).toBe(
      "pending_mining",
    );
  });
});

describe("referral edge materialisation", () => {
  it("rejects a self-invite and a cycle", () => {
    expect(() =>
      materializeReferralEdges({
        inviteeUserId: a,
        inviterUserId: a,
        inviterAncestors: [],
      }),
    ).toThrow(ReferralSelfInviteError);
    // b was invited by a; a now tries to claim b's code → a is b's ancestor.
    expect(() =>
      materializeReferralEdges({
        inviteeUserId: a,
        inviterUserId: b,
        inviterAncestors: [a],
      }),
    ).toThrow(ReferralCycleError);
    expect(() =>
      materializeReferralEdges({
        inviteeUserId: a,
        inviterUserId: b,
        inviterAncestors: [c, a],
      }),
    ).toThrow(ReferralCycleError);
  });

  it("materialises depth 1..5 and never deeper", () => {
    const edges = materializeReferralEdges({
      inviteeUserId: g,
      inviterUserId: f,
      inviterAncestors: [e, d, c, b, a],
    });
    expect(edges).toEqual([
      { inviterUserId: f, depth: 1 },
      { inviterUserId: e, depth: 2 },
      { inviterUserId: d, depth: 3 },
      { inviterUserId: c, depth: 4 },
      { inviterUserId: b, depth: 5 },
    ]);
    expect(edges).toHaveLength(referralMaximumDepth);
    expect(edges.map((edge) => edge.inviterUserId)).not.toContain(a);
  });
});
