import { describe, expect, it } from "vitest";

import {
  digestPriceAlertCreate,
  InvalidAlertContractError,
  parseAlertIdempotencyKey,
  parseNotificationPreferencesResource,
  parsePriceAlertDefinition,
  parsePriceAlertResource,
  parseReplaceNotificationPreferencesRequest,
  parseReplacePriceAlertRequest,
} from "../src/features/alerts/alert-contract.js";

const alertId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const definition = {
  asset_key: "BTC",
  condition: "above",
  threshold_decimal: "64000.00",
  expires_at: "2026-08-26T01:00:00+01:00",
} as const;

const preferences = [
  { event_type: "support_update", enabled: true },
  { event_type: "security_notice", enabled: false },
  { event_type: "price_alert_triggered", enabled: true },
  { event_type: "provider_activity_projected", enabled: false },
] as const;

describe("Alert contracts", () => {
  it("normalizes expiry before computing the versioned create digest", () => {
    const parsed = parsePriceAlertDefinition(definition);
    expect(parsed).toEqual({
      ...definition,
      expires_at: "2026-08-26T00:00:00.000Z",
    });
    expect(digestPriceAlertCreate(definition)).toBe(
      digestPriceAlertCreate({
        ...definition,
        expires_at: "2026-08-26T00:00:00.000Z",
      }),
    );
    expect(digestPriceAlertCreate(definition)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["numeric threshold", { ...definition, threshold_decimal: 64_000 }],
    ["exponent threshold", { ...definition, threshold_decimal: "6.4e4" }],
    ["leading zero", { ...definition, threshold_decimal: "064000" }],
    ["negative threshold", { ...definition, threshold_decimal: "-1" }],
    ["lowercase asset", { ...definition, asset_key: "btc" }],
    ["unknown condition", { ...definition, condition: "crosses" }],
    ["invalid expiry", { ...definition, expires_at: "tomorrow" }],
    ["provider authority", { ...definition, source: "hyperliquid" }],
    ["owner authority", { ...definition, owner_user_id: alertId }],
    ["Firebase target", { ...definition, firebase_token: "secret" }],
  ])("rejects a strict definition with %s", (_name, value) => {
    expect(() => parsePriceAlertDefinition(value)).toThrow(
      InvalidAlertContractError,
    );
  });

  it("requires a full replacement with a positive expected version", () => {
    expect(
      parseReplacePriceAlertRequest({
        ...definition,
        expected_version: 2,
      }),
    ).toMatchObject({ expected_version: 2 });
    expect(() =>
      parseReplacePriceAlertRequest({
        ...definition,
        expected_version: 0,
      }),
    ).toThrow(InvalidAlertContractError);
    expect(() =>
      parseReplacePriceAlertRequest({ ...definition, expected_version: 1.5 }),
    ).toThrow(InvalidAlertContractError);
  });

  it("accepts exactly one lowercase UUID Idempotency-Key", () => {
    expect(parseAlertIdempotencyKey(["Idempotency-Key", alertId])).toBe(
      alertId,
    );
    expect(() => parseAlertIdempotencyKey([])).toThrow(
      InvalidAlertContractError,
    );
    expect(() =>
      parseAlertIdempotencyKey(["idempotency-key", alertId.toUpperCase()]),
    ).toThrow(InvalidAlertContractError);
    expect(() =>
      parseAlertIdempotencyKey([
        "idempotency-key",
        alertId,
        "Idempotency-Key",
        alertId,
      ]),
    ).toThrow(InvalidAlertContractError);
  });

  it("requires and canonically orders the complete fixed preference set", () => {
    const parsed = parseReplaceNotificationPreferencesRequest({
      expected_version: 0,
      preferences,
    });
    expect(parsed.preferences).toEqual([
      { event_type: "price_alert_triggered", enabled: true },
      { event_type: "provider_activity_projected", enabled: false },
      { event_type: "security_notice", enabled: false },
      { event_type: "support_update", enabled: true },
    ]);
    expect(() =>
      parseReplaceNotificationPreferencesRequest({
        expected_version: 0,
        preferences: preferences.slice(0, 3),
      }),
    ).toThrow(InvalidAlertContractError);
    expect(() =>
      parseReplaceNotificationPreferencesRequest({
        expected_version: 0,
        preferences: [
          preferences[0],
          preferences[0],
          preferences[1],
          preferences[2],
        ],
      }),
    ).toThrow(InvalidAlertContractError);
  });

  it("keeps resource capability claims closed and output shapes strict", () => {
    const resource = {
      alert_id: alertId,
      asset_key: "BTC",
      condition: "above",
      threshold_decimal: "64000.00",
      expires_at: null,
      state: "inactive",
      evaluation: { state: "unavailable" },
      delivery: { state: "unavailable" },
      version: 1,
      created_at: "2026-08-25T00:00:00.000Z",
      updated_at: "2026-08-25T00:00:00.000Z",
    } as const;
    expect(parsePriceAlertResource(resource)).toEqual(resource);
    expect(() =>
      parsePriceAlertResource({
        ...resource,
        evaluation: { state: "active" },
      }),
    ).toThrow(InvalidAlertContractError);
    expect(() =>
      parsePriceAlertResource({ ...resource, provider: "hl" }),
    ).toThrow(InvalidAlertContractError);

    expect(
      parseNotificationPreferencesResource({
        version: 1,
        preferences,
        delivery: { state: "unavailable" },
      }).delivery,
    ).toEqual({ state: "unavailable" });
  });
});
