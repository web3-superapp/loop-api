import { describe, expect, it, vi } from "vitest";

import type { NotificationRepository } from "../src/database/notification-repository.js";
import { createDeviceService } from "../src/features/security/device-service.js";
import {
  DeviceSessionCallerInvalidError,
  type DeviceSession,
  type DeviceSessionRepository,
} from "../src/features/session/device-session-repository.js";

const ownerUserId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const callerSessionId = "0b2c1d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
const targetSessionId = "1c3d2e4f-5a6b-4c7d-9e8f-0a1b2c3d4e5f";
const requestId = "4f605172-8d9e-4fa0-8123-3d4e5f607182";
const principal = Object.freeze({
  userId: ownerUserId,
  privyUserId: "did:privy:x",
  streamUserId: "loop_6d12a86e413447e69312c5ef75a30f55",
});
const metadata = Object.freeze({
  clientVersion: "1.0.0",
  contractVersion: "2.0" as const,
  deviceId: "2d4e3f50-6b7c-4d8e-8f90-1b2c3d4e5f60",
  idempotencyKey: "3e5f4061-7c8d-4e9f-9012-2c3d4e5f6071",
  platform: "ios" as const,
  sessionId: callerSessionId,
});
const revoked: DeviceSession = {
  sessionId: targetSessionId,
  ownerUserId,
  deviceId: "5a716283-9eaf-4ab1-9234-4e5f60718293",
  clientPlatform: "android",
  clientVersion: "1.0.0",
  authStrength: "providerAuthenticated",
  policyVersion: "sessionPolicyV1",
  status: "revoked",
  createdAt: "2026-09-09T01:00:00.000Z",
  lastSeenAt: "2026-09-09T01:00:00.000Z",
  revokedAt: "2026-09-09T02:00:00.000Z",
};

function sessionsFake(revoke: DeviceSessionRepository["revoke"]) {
  const repository: DeviceSessionRepository = {
    bootstrapVerifiedPrivyUser: () => Promise.reject(new Error("not used")),
    create: () => Promise.reject(new Error("not used")),
    findById: () => Promise.resolve(null),
    listByOwner: () => Promise.resolve([]),
    revoke,
  };
  return repository;
}

describe("device service", () => {
  it("warns with the session, owner, and request when the security.event write fails", async () => {
    const warn = vi.fn();
    const record = vi.fn<NotificationRepository["record"]>(() =>
      Promise.reject(new Error("feed down")),
    );
    const service = createDeviceService({
      sessions: sessionsFake(() => Promise.resolve(revoked)),
      notifications: { record } as unknown as NotificationRepository,
      logger: { warn },
    });

    const result = await service.revoke({
      principal,
      targetSessionId,
      metadata,
      requestId,
    });

    expect(result).toMatchObject({
      session: { sessionId: targetSessionId, status: "revoked" },
      effect: "auditOnly",
      providerAccessTerminated: false,
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      {
        sessionId: targetSessionId,
        ownerUserId,
        requestId,
        errorName: "Error",
      },
      "Device revoke security.event notification was not recorded",
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ source: "loop_session" }),
    );
  });

  it("maps a revoked or foreign caller session to INVALID_REQUEST", async () => {
    const service = createDeviceService({
      sessions: sessionsFake(() =>
        Promise.reject(new DeviceSessionCallerInvalidError()),
      ),
      notifications: null,
      logger: { warn: vi.fn() },
    });
    await expect(
      service.revoke({ principal, targetSessionId, metadata, requestId }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});

describe("device list current-session projection (preflight F3)", () => {
  const listed: DeviceSession = {
    sessionId: callerSessionId,
    ownerUserId,
    deviceId: "2d4e3f50-6b7c-4d8e-8f90-1b2c3d4e5f60",
    clientPlatform: "ios",
    clientVersion: "1.0.0",
    authStrength: "providerAuthenticated",
    policyVersion: "sessionPolicyV1",
    status: "active",
    createdAt: "2026-09-09T01:00:00.000Z",
    lastSeenAt: "2026-09-09T01:00:00.000Z",
    revokedAt: null,
  };

  function serviceWith(rows: readonly DeviceSession[]) {
    return createDeviceService({
      sessions: {
        ...sessionsFake(() => Promise.reject(new Error("not used"))),
        listByOwner: () => Promise.resolve(rows),
      },
      notifications: null,
      logger: { warn: vi.fn() },
      now: () => new Date("2026-09-09T02:00:00.000Z"),
    });
  }

  it("projects currentSessionId as null when the header names no listed row", async () => {
    const result = await serviceWith([listed, revoked]).list({
      principal,
      metadata: {
        ...metadata,
        sessionId: "11111111-2222-4333-8444-555555555555",
      },
    });
    expect(result.currentSessionId).toBeNull();
    expect(result.devices.some((device) => device.isCurrent)).toBe(false);
    expect(result.devices).toHaveLength(2);
  });

  it("echoes currentSessionId with exactly one isCurrent row when the header names a listed row", async () => {
    const result = await serviceWith([listed, revoked]).list({
      principal,
      metadata,
    });
    expect(result.currentSessionId).toBe(callerSessionId);
    expect(
      result.devices
        .filter((device) => device.isCurrent)
        .map((d) => d.sessionId),
    ).toEqual([callerSessionId]);
  });

  it("keeps currentSessionId null without the header", async () => {
    const result = await serviceWith([listed]).list({
      principal,
      metadata: { ...metadata, sessionId: null },
    });
    expect(result.currentSessionId).toBeNull();
    expect(result.devices.some((device) => device.isCurrent)).toBe(false);
  });
});
