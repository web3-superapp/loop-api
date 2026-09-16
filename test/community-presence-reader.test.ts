import { describe, expect, it, vi } from "vitest";

import type { CommunityChannelViewerRecord } from "../src/features/communication/communication-repository.js";
import {
  createCommunityPresenceReader,
  createUnavailableCommunityPresenceReader,
  communityPresenceNotObserved,
} from "../src/features/community/community-presence-reader.js";
import {
  createUnavailableStreamCommunityChannelGateway,
  StreamChannelGatewayUnavailableError,
  StreamChannelProjectionMismatchError,
  StreamChannelRequestRejectedError,
  type StreamCommunityChannelGateway,
} from "../src/integrations/stream/channel-gateway.js";

const communityId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const streamChannelId = "loop_community_3fa85f6457174562b3fc2c963f66afa6";
const observedAt = "2026-09-16T08:00:00.000Z";

function channel(
  overrides: Partial<{
    readonly provisioned: boolean;
    readonly state: "created" | "failed" | "capacityPending";
  }> = {},
): CommunityChannelViewerRecord {
  return {
    channel: {
      communityId,
      streamChannelId,
      state: overrides.state ?? "created",
      memberCap: 3_000,
      provisioned: overrides.provisioned ?? true,
    },
    viewerMemberState: "synced",
    viewerIsCommunityMember: true,
    currentVoiceRoomId: null,
    currentVoiceRoomProvisioned: false,
  };
}

function gateway(
  read: StreamCommunityChannelGateway["readCommunityChannelPresence"],
): StreamCommunityChannelGateway {
  return {
    ...createUnavailableStreamCommunityChannelGateway(),
    readCommunityChannelPresence: read,
  };
}

function reader(
  read: StreamCommunityChannelGateway["readCommunityChannelPresence"],
  timeoutMilliseconds?: number,
) {
  return createCommunityPresenceReader({
    gateway: gateway(read),
    clock: () => new Date(observedAt),
    ...(timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds }),
  });
}

describe("community presence reader (Decision 0047)", () => {
  it("publishes the connected-member count as an observation with its source", async () => {
    const read = vi.fn(() =>
      Promise.resolve({
        status: "observed" as const,
        channelId: streamChannelId,
        onlineMemberCount: 7,
        memberCount: 120,
      }),
    );
    await expect(
      reader(read).readCommunityPresence(channel()),
    ).resolves.toEqual({
      status: "available",
      count: 7,
      observedAt: "2026-09-16T08:00:00.000Z",
      source: "stream_member_presence",
    });
    expect(read).toHaveBeenCalledWith({
      channelId: streamChannelId,
      signal: expect.any(AbortSignal) as AbortSignal,
    });
  });

  it("keeps a zero only when Stream counted zero", async () => {
    await expect(
      reader(() =>
        Promise.resolve({
          status: "observed" as const,
          channelId: streamChannelId,
          onlineMemberCount: 0,
          memberCount: 2,
        }),
      ).readCommunityPresence(channel()),
    ).resolves.toMatchObject({ status: "available", count: 0 });
  });

  it("names the missing channel before asking Stream", async () => {
    const read = vi.fn();
    const subject = reader(read);
    await expect(subject.readCommunityPresence(null)).resolves.toEqual({
      status: "unavailable",
      reasonCode: "COMMUNICATION_RUNTIME_UNAVAILABLE",
    });
    await expect(
      subject.readCommunityPresence({ ...channel(), channel: null }),
    ).resolves.toEqual({
      status: "unavailable",
      reasonCode: "COMMUNITY_CHANNEL_NOT_PROVISIONED",
    });
    await expect(
      subject.readCommunityPresence(
        channel({ provisioned: false, state: "created" }),
      ),
    ).resolves.toEqual({
      status: "unavailable",
      reasonCode: "COMMUNITY_CHANNEL_NOT_PROVISIONED",
    });
    await expect(
      subject.readCommunityPresence(channel({ state: "failed" })),
    ).resolves.toEqual({
      status: "unavailable",
      reasonCode: "COMMUNITY_CHANNEL_PROVISION_FAILED",
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("reports every Stream failure as a read failure, never as a number", async () => {
    for (const error of [
      new StreamChannelGatewayUnavailableError(),
      new StreamChannelRequestRejectedError(),
      new StreamChannelProjectionMismatchError(),
      new Error("unclassified"),
    ]) {
      await expect(
        reader(() => Promise.reject(error)).readCommunityPresence(channel()),
      ).resolves.toEqual({
        status: "unavailable",
        reasonCode: "STREAM_PRESENCE_READ_FAILED",
      });
    }
  });

  it("reports a channel beyond the paging budget as unavailable", async () => {
    await expect(
      reader(() =>
        Promise.resolve({
          status: "bound_exceeded" as const,
          channelId: streamChannelId,
          memberBound: 500,
        }),
      ).readCommunityPresence(channel()),
    ).resolves.toEqual({
      status: "unavailable",
      reasonCode: "STREAM_PRESENCE_MEMBER_BOUND_EXCEEDED",
    });
  });

  it("gives up at the budget, aborts the provider call, and reports the timeout", async () => {
    let seenSignal: AbortSignal | undefined;
    const subject = reader((input) => {
      seenSignal = input.signal;
      return new Promise(() => undefined);
    }, 20);
    const startedAt = Date.now();
    await expect(subject.readCommunityPresence(channel())).resolves.toEqual({
      status: "unavailable",
      reasonCode: "STREAM_PRESENCE_READ_TIMEOUT",
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(seenSignal?.aborted).toBe(true);
  });

  it("rejects a non-positive budget at construction", () => {
    expect(() => reader(vi.fn(), 0)).toThrow(RangeError);
  });

  it("stays not-connected without a gateway and not-observed on writes", async () => {
    await expect(
      createUnavailableCommunityPresenceReader().readCommunityPresence(
        channel(),
      ),
    ).resolves.toEqual({
      status: "unavailable",
      reasonCode: "STREAM_PRESENCE_NOT_CONNECTED",
    });
    expect(communityPresenceNotObserved).toEqual({
      status: "unavailable",
      reasonCode: "STREAM_PRESENCE_NOT_OBSERVED",
    });
  });
});
