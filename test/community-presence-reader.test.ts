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
    viewerPersona: null,
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

  describe("observation reuse (Decision 0088)", () => {
    function counting(counts: number[]) {
      let call = 0;
      return vi.fn(() => {
        const count = counts[Math.min(call, counts.length - 1)] ?? 0;
        call += 1;
        return Promise.resolve({
          status: "observed" as const,
          channelId: streamChannelId,
          onlineMemberCount: count,
          memberCount: 50,
        });
      });
    }
    function timedReader(
      read: StreamCommunityChannelGateway["readCommunityChannelPresence"],
      clockMs: { value: number },
      cacheTtlMilliseconds?: number,
    ) {
      return createCommunityPresenceReader({
        gateway: gateway(read),
        clock: () => new Date(clockMs.value),
        ...(cacheTtlMilliseconds === undefined ? {} : { cacheTtlMilliseconds }),
      });
    }
    const start = Date.parse(observedAt);

    it("serves one Stream observation for 30 s, refreshing beside it past 15 s", async () => {
      const read = counting([3, 4, 5]);
      const clockMs = { value: start };
      const subject = timedReader(read, clockMs);

      const first = await subject.readCommunityPresence(channel());
      expect(first).toMatchObject({ count: 3, observedAt });
      clockMs.value = start + 14_999;
      await expect(subject.readCommunityPresence(channel())).resolves.toBe(
        first,
      );
      expect(read).toHaveBeenCalledTimes(1);

      // Past half the window: still the first observation, and one read beside.
      clockMs.value = start + 15_000;
      await expect(subject.readCommunityPresence(channel())).resolves.toBe(
        first,
      );
      await Promise.resolve();
      expect(read).toHaveBeenCalledTimes(2);
      await new Promise((resolve) => setTimeout(resolve, 0));
      // The refreshed observation carries the time Stream was read.
      await expect(
        subject.readCommunityPresence(channel()),
      ).resolves.toMatchObject({
        count: 4,
        observedAt: new Date(start + 15_000).toISOString(),
      });
    });

    it("never serves an observation at or past the window", async () => {
      const read = counting([3, 9]);
      const clockMs = { value: start };
      const subject = timedReader(read, clockMs);
      await subject.readCommunityPresence(channel());
      clockMs.value = start + 30_000;
      await expect(
        subject.readCommunityPresence(channel()),
      ).resolves.toMatchObject({
        count: 9,
        observedAt: new Date(start + 30_000).toISOString(),
      });
      expect(read).toHaveBeenCalledTimes(2);
    });

    it("shares one Stream read between concurrent readers", async () => {
      let resolveRead: (() => void) | undefined;
      const read = vi.fn(
        () =>
          new Promise<{
            readonly status: "observed";
            readonly channelId: string;
            readonly onlineMemberCount: number;
            readonly memberCount: number;
          }>((resolve) => {
            resolveRead = () => {
              resolve({
                status: "observed",
                channelId: streamChannelId,
                onlineMemberCount: 6,
                memberCount: 8,
              });
            };
          }),
      );
      const subject = timedReader(read, { value: start });
      const both = Promise.all([
        subject.readCommunityPresence(channel()),
        subject.readCommunityPresence(channel()),
      ]);
      resolveRead?.();
      const [left, right] = await both;
      expect(left).toBe(right);
      expect(read).toHaveBeenCalledTimes(1);
    });

    it("never remembers a failure or a timeout", async () => {
      const read = vi
        .fn<StreamCommunityChannelGateway["readCommunityChannelPresence"]>()
        .mockRejectedValueOnce(new StreamChannelGatewayUnavailableError())
        .mockResolvedValueOnce({
          status: "observed",
          channelId: streamChannelId,
          onlineMemberCount: 2,
          memberCount: 3,
        });
      const subject = timedReader(read, { value: start });
      await expect(subject.readCommunityPresence(channel())).resolves.toEqual({
        status: "unavailable",
        reasonCode: "STREAM_PRESENCE_READ_FAILED",
      });
      await expect(
        subject.readCommunityPresence(channel()),
      ).resolves.toMatchObject({ status: "available", count: 2 });
      expect(read).toHaveBeenCalledTimes(2);
    });

    it("remembers the member bound as the observation it is", async () => {
      const read = vi.fn(() =>
        Promise.resolve({
          status: "bound_exceeded" as const,
          channelId: streamChannelId,
          memberBound: 500,
        }),
      );
      const subject = timedReader(read, { value: start });
      await subject.readCommunityPresence(channel());
      await expect(subject.readCommunityPresence(channel())).resolves.toEqual({
        status: "unavailable",
        reasonCode: "STREAM_PRESENCE_MEMBER_BOUND_EXCEEDED",
      });
      expect(read).toHaveBeenCalledTimes(1);
    });

    it("reads Stream every time with a zero TTL and refuses a negative one", async () => {
      const read = counting([1, 2]);
      const subject = timedReader(read, { value: start }, 0);
      await subject.readCommunityPresence(channel());
      await expect(
        subject.readCommunityPresence(channel()),
      ).resolves.toMatchObject({ count: 2 });
      expect(read).toHaveBeenCalledTimes(2);
      expect(() => timedReader(read, { value: start }, -1)).toThrow(RangeError);
    });
  });
});
