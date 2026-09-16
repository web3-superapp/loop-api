import { vi } from "vitest";

import { loadConfig } from "../src/config.js";
import { createUnavailableAlertRepository } from "../src/database/alert-repository.js";
import { createUnavailableAgentAuthorizationRepository } from "../src/database/agent-authorization-repository.js";
import { createUnavailableControlPlaneRepository } from "../src/database/control-plane-repository.js";
import type { Database } from "../src/database/database.js";
import { createUnavailablePerpIntentRepository } from "../src/database/perp-intent-repository.js";
import { createUnavailablePerpWalletBindingRepository } from "../src/database/perp-wallet-binding-repository.js";
import { createUnavailableProfileRepository } from "../src/database/profile-repository.js";
import { createUnavailableWatchlistRepository } from "../src/database/watchlist-repository.js";
import type { InternalUserRepository } from "../src/features/identity/internal-user-repository.js";
import { createUnavailableDeviceSessionRepository } from "../src/features/session/device-session-repository.js";
import type { PrivyAccessTokenVerifier } from "../src/integrations/privy/access-token-verifier.js";

/** Shared S7 route-test scaffolding (launch, mining, referral). */

export const s7AccountId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
export const s7ValidToken = "header.payload.signature";
export const s7CursorSecret = "0123456789abcdef0123456789abcdef";
export const s7RequestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function s7IdempotencyKey(suffix = "a"): string {
  return `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${suffix}`;
}

export function s7TestConfig(overrides: Readonly<Record<string, string>> = {}) {
  return loadConfig({
    NODE_ENV: "test",
    API_DOCS_ENABLED: "false",
    LOG_LEVEL: "silent",
    V2_MODULES_ENABLED: "launch,mining,referral",
    V2_CURSOR_HMAC_SECRET: s7CursorSecret,
    PRIVY_APP_ID: "app_test",
    PRIVY_APP_SECRET: "secret_test",
    DATABASE_URL:
      "postgres://loop_api:local-password@127.0.0.1:5432/loop_api_test",
    ...overrides,
  });
}

export function s7CommonHeaders(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${s7ValidToken}`,
    "x-loop-client-version": "1.2.3",
    "x-loop-contract-version": "2.0",
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete headers[name];
    } else {
      headers[name] = value;
    }
  }
  return headers;
}

export function s7CommandHeaders(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  return s7CommonHeaders({
    "idempotency-key": s7IdempotencyKey(),
    ...overrides,
  });
}

export function s7Database(
  extra: Pick<Database, "launch" | "mining" | "referral" | "chainRegistry">,
): Database {
  return {
    alerts: createUnavailableAlertRepository(),
    agentAuthorizations: createUnavailableAgentAuthorizationRepository(),
    controlPlane: createUnavailableControlPlaneRepository(),
    deviceSessions: createUnavailableDeviceSessionRepository(),
    perpWalletBindings: createUnavailablePerpWalletBindingRepository(),
    perpIntents: createUnavailablePerpIntentRepository(),
    profiles: createUnavailableProfileRepository(),
    watchlists: createUnavailableWatchlistRepository(),
    internalUsers: {
      findByPrivyUserId: vi.fn<InternalUserRepository["findByPrivyUserId"]>(
        () => Promise.resolve({ id: s7AccountId }),
      ),
      getOrCreateByPrivyUserId: vi.fn<
        InternalUserRepository["getOrCreateByPrivyUserId"]
      >(() => Promise.resolve({ id: s7AccountId })),
    },
    ping: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    ...extra,
  };
}

export function s7PrivyVerifier(): PrivyAccessTokenVerifier {
  return {
    verifyAccessToken: vi.fn(() =>
      Promise.resolve({ privyUserId: "did:privy:verified-user" }),
    ),
  };
}

/** Reads a method mock without an unbound member access (lint rule). */
export function calls<T extends object, K extends keyof T>(
  target: T,
  key: K,
): T[K] {
  const value: unknown = Reflect.get(target, key);
  return value as T[K];
}
