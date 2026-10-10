import { describe, expect, it } from "vitest";

import { V2ApiError } from "../src/core/http/v2-error.js";
import {
  launch2TrustedCounterparties,
  requireLaunch2Counterparties,
} from "../src/features/launch2/launch2-counterparty.js";
import { instanceFixture } from "./helpers/launch2-fakes.js";

/**
 * Decision 0117: launch2 prepares trust the activated instance's registry
 * row (11 modules) plus its curve-bound USD1 — not the static env
 * counterparty allowlist.
 */

const usd1 = "0x3a1200000000000000000000000000000000abcd";
const stranger = "0x9999999999999999999999999999999999999999";

function refusal(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

function expectRefused(run: () => void): void {
  const error = refusal(run);
  expect(error).toBeInstanceOf(V2ApiError);
  expect(error).toMatchObject({
    code: "POLICY_BLOCKED",
    detailsSafe: { reasonCode: "LAUNCH2_COUNTERPARTY_NOT_INSTANCE" },
  });
}

describe("launch2 counterparty trust (Decision 0117)", () => {
  it("admits every registered module and the instance USD1, case-insensitively", () => {
    const record = instanceFixture();
    const trusted = launch2TrustedCounterparties(record, usd1);
    expect(trusted).not.toBeNull();
    expect(trusted?.size).toBe(12);
    for (const target of [
      record.addresses.nft,
      record.addresses.curve,
      record.addresses.meme,
      usd1,
    ]) {
      expect(() =>
        requireLaunch2Counterparties({
          record,
          usd1,
          targets: [target.toUpperCase().replace("0X", "0x")],
        }),
      ).not.toThrow();
    }
    // NFT mint: the NFT plus its USD1 approve; curve sell: curve + MEME.
    expect(() =>
      requireLaunch2Counterparties({
        record,
        usd1,
        targets: [record.addresses.nft, usd1],
      }),
    ).not.toThrow();
    expect(() =>
      requireLaunch2Counterparties({
        record,
        usd1,
        targets: [record.addresses.curve, record.addresses.meme],
      }),
    ).not.toThrow();
  });

  it("refuses an address that is not the instance's, even next to trusted ones", () => {
    const record = instanceFixture();
    expectRefused(() =>
      requireLaunch2Counterparties({ record, usd1, targets: [stranger] }),
    );
    expectRefused(() =>
      requireLaunch2Counterparties({
        record,
        usd1,
        targets: [record.addresses.curve, stranger],
      }),
    );
    // Another instance's curve is not this instance's counterparty.
    const other = instanceFixture({
      addresses: { ...record.addresses, curve: stranger },
    });
    expectRefused(() =>
      requireLaunch2Counterparties({
        record,
        usd1,
        targets: [other.addresses.curve],
      }),
    );
    expectRefused(() =>
      requireLaunch2Counterparties({ record, usd1, targets: [] }),
    );
  });

  it("trusts nothing on an instance that is not activated or is held", () => {
    const pending = instanceFixture({ activatedAt: null });
    expect(launch2TrustedCounterparties(pending, usd1)).toBeNull();
    expectRefused(() =>
      requireLaunch2Counterparties({
        record: pending,
        usd1,
        targets: [pending.addresses.nft],
      }),
    );
    const held = instanceFixture({
      holdReason: "LAUNCH2_DEPLOYED_EVENT_MISMATCH",
    });
    expectRefused(() =>
      requireLaunch2Counterparties({
        record: held,
        usd1,
        targets: [held.addresses.curve],
      }),
    );
  });
});
