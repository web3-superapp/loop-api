import { describe, expect, it, vi } from "vitest";

import {
  createAuthoritativeReaderRegistry,
  type AuthoritativeResultReader,
} from "../src/features/reconciliation/authoritative-reader.js";

describe("authoritative reader tuple registry", () => {
  it("allows one provider domain to own distinct operation handlers", () => {
    const perpReader = vi.fn<AuthoritativeResultReader>();
    const spotReader = vi.fn<AuthoritativeResultReader>();
    const registry = createAuthoritativeReaderRegistry([
      ["hyperliquid", "perp_intent", perpReader],
      ["hyperliquid", "spot_intent", spotReader],
    ]);

    const perpHandler = registry.find("hyperliquid", "perp_intent");
    const spotHandler = registry.find("hyperliquid", "spot_intent");
    expect(perpHandler?.mode).toBe("generic_control_plane");
    expect(
      perpHandler?.mode === "generic_control_plane"
        ? perpHandler.read
        : undefined,
    ).toBe(perpReader);
    expect(spotHandler?.mode).toBe("generic_control_plane");
    expect(
      spotHandler?.mode === "generic_control_plane"
        ? spotHandler.read
        : undefined,
    ).toBe(spotReader);
    expect(registry.find("hyperliquid", "future_intent")).toBeUndefined();
  });

  it("rejects a duplicate provider-domain and operation-kind tuple", () => {
    const reader = vi.fn<AuthoritativeResultReader>();

    expect(() =>
      createAuthoritativeReaderRegistry([
        ["hyperliquid", "spot_intent", reader],
        ["hyperliquid", "spot_intent", reader],
      ]),
    ).toThrow("Authoritative reader registration is duplicated");
  });

  it.each([
    ["invalid domain", "Hyperliquid", "spot_intent", "domain"],
    ["invalid operation kind", "hyperliquid", "spot:intent", "operation kind"],
  ])("rejects an %s", (_label, domain, operationKind, message) => {
    expect(() =>
      createAuthoritativeReaderRegistry([
        [domain, operationKind, vi.fn<AuthoritativeResultReader>()],
      ]),
    ).toThrow(message);
  });
});
