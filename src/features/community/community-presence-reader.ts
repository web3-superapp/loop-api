import {
  StreamChannelGatewayUnavailableError,
  StreamChannelProjectionMismatchError,
  StreamChannelRequestRejectedError,
  type StreamCommunityChannelGateway,
} from "../../integrations/stream/channel-gateway.js";
import { communicationUnavailableReasonCodes } from "../communication/communication-contract.js";
import type { CommunityChannelViewerRecord } from "../communication/communication-repository.js";
import {
  communityUnavailableReasonCodes,
  unavailable,
  type UnavailableProjection,
} from "./community-contract.js";

/**
 * The community "online" number (Decision 0047). It is an observation of
 * Stream, never a stored fact: the count of the official channel's members
 * whose Stream user holds a live connection at `observedAt`. `source` names
 * exactly what was measured so a client never mistakes it for "watching
 * this channel" or "active recently".
 */
export const communityPresenceSource = "stream_member_presence" as const;

/** The default budget matches the Stream provider timeout used elsewhere. */
export const communityPresenceTimeoutMilliseconds = 3_000;

/**
 * How long one Stream observation of a channel is reused (Decision 0088).
 * Past half of it a read is still answered from the observation and Stream is
 * asked again beside it; nothing older than the window is ever served, and
 * `observedAt` stays the time Stream was actually read.
 */
export const communityPresenceCacheTtlMilliseconds = 30_000;

/** Bound on remembered channels; going over it drops expired entries first. */
const presenceCacheMaxEntries = 2_000;

export interface AvailableCommunityPresenceProjection {
  readonly status: "available";
  readonly count: number;
  readonly observedAt: string;
  readonly source: typeof communityPresenceSource;
}

export type CommunityPresenceProjection =
  AvailableCommunityPresenceProjection | UnavailableProjection;

export interface CommunityPresenceReader {
  /**
   * Reads presence for the community whose channel record is given. The
   * record decides whether there is a channel to ask about; the gateway
   * decides the number. Never throws: every failure is an `unavailable`
   * projection with the reason, so the detail page's other fields are
   * unaffected.
   */
  readCommunityPresence(
    channel: CommunityChannelViewerRecord | null,
  ): Promise<CommunityPresenceProjection>;
}

export interface CommunityPresenceReaderOptions {
  readonly gateway: StreamCommunityChannelGateway;
  readonly clock?: () => Date;
  readonly timeoutMilliseconds?: number;
  /** Overrides `communityPresenceCacheTtlMilliseconds`; zero disables reuse. */
  readonly cacheTtlMilliseconds?: number;
}

const presenceNotConnected = unavailable(
  communityUnavailableReasonCodes.presence,
);

/** The projection every write path returns: nothing was observed there. */
export const communityPresenceNotObserved: UnavailableProjection = unavailable(
  communityUnavailableReasonCodes.presenceNotObserved,
);

export function createUnavailableCommunityPresenceReader(): CommunityPresenceReader {
  return Object.freeze({
    readCommunityPresence: () => Promise.resolve(presenceNotConnected),
  });
}

class PresenceReadTimeoutError extends Error {
  constructor() {
    super("The community presence read exceeded its budget");
    this.name = "PresenceReadTimeoutError";
  }
}

type ChannelResolution =
  | Readonly<{ status: "ready"; streamChannelId: string }>
  | UnavailableProjection;

/**
 * The channel record decides whether there is anything to ask Stream. The
 * order mirrors the chat projection: no record at all (the communication
 * runtime is not composed or could not answer), no channel yet, a channel
 * that failed to provision, then a channel worth reading.
 */
function resolveChannel(
  channel: CommunityChannelViewerRecord | null,
): ChannelResolution {
  if (channel === null) {
    return unavailable(communicationUnavailableReasonCodes.chatRuntime);
  }
  if (channel.channel === null || !channel.channel.provisioned) {
    return unavailable(
      communicationUnavailableReasonCodes.channelNotProvisioned,
    );
  }
  if (channel.channel.state === "failed") {
    return unavailable(communicationUnavailableReasonCodes.channelFailed);
  }
  return Object.freeze({
    status: "ready" as const,
    streamChannelId: channel.channel.streamChannelId,
  });
}

interface PresenceObservation {
  readonly projection: CommunityPresenceProjection;
  /** When the Stream read was started; the reuse window counts from here. */
  readonly requestedAtMs: number;
}

export function createCommunityPresenceReader(
  options: CommunityPresenceReaderOptions,
): CommunityPresenceReader {
  const clock = options.clock ?? (() => new Date());
  const budget =
    options.timeoutMilliseconds ?? communityPresenceTimeoutMilliseconds;
  if (!Number.isSafeInteger(budget) || budget <= 0) {
    throw new RangeError("Presence read budget must be a positive integer");
  }
  const cacheTtl =
    options.cacheTtlMilliseconds ?? communityPresenceCacheTtlMilliseconds;
  if (!Number.isSafeInteger(cacheTtl) || cacheTtl < 0) {
    throw new RangeError("Presence cache TTL must be a non-negative integer");
  }
  const observations = new Map<string, PresenceObservation>();
  /** One Stream read per channel at a time; concurrent readers share it. */
  const inFlight = new Map<string, Promise<CommunityPresenceProjection>>();

  function remember(
    streamChannelId: string,
    observation: PresenceObservation,
  ): void {
    if (cacheTtl === 0) {
      return;
    }
    observations.set(streamChannelId, observation);
    if (observations.size <= presenceCacheMaxEntries) {
      return;
    }
    const nowMs = clock().getTime();
    for (const [key, entry] of observations) {
      if (nowMs - entry.requestedAtMs >= cacheTtl) {
        observations.delete(key);
      }
    }
    if (observations.size > presenceCacheMaxEntries) {
      observations.clear();
    }
  }

  /**
   * One bounded Stream read. Only an observation (a count, or the member
   * bound) is remembered; a timeout or a failure is returned to the callers
   * that shared it and the next read asks Stream again.
   */
  function observe(
    streamChannelId: string,
  ): Promise<CommunityPresenceProjection> {
    const pending = inFlight.get(streamChannelId);
    if (pending !== undefined) {
      return pending;
    }
    const tracked = (async (): Promise<CommunityPresenceProjection> => {
      const requestedAtMs = clock().getTime();
      const projection = await readOnce(streamChannelId);
      if (
        projection.status === "available" ||
        projection.reasonCode ===
          communityUnavailableReasonCodes.presenceMemberBound
      ) {
        remember(streamChannelId, { projection, requestedAtMs });
      }
      return projection;
    })().finally(() => {
      if (inFlight.get(streamChannelId) === tracked) {
        inFlight.delete(streamChannelId);
      }
    });
    inFlight.set(streamChannelId, tracked);
    return tracked;
  }

  async function readOnce(
    streamChannelId: string,
  ): Promise<CommunityPresenceProjection> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new PresenceReadTimeoutError());
      }, budget);
    });
    try {
      const result = await Promise.race([
        options.gateway.readCommunityChannelPresence({
          channelId: streamChannelId,
          signal: controller.signal,
        }),
        deadline,
      ]);
      if (result.status === "bound_exceeded") {
        return unavailable(communityUnavailableReasonCodes.presenceMemberBound);
      }
      return Object.freeze({
        status: "available" as const,
        count: result.onlineMemberCount,
        observedAt: clock().toISOString(),
        source: communityPresenceSource,
      });
    } catch (error) {
      if (error instanceof PresenceReadTimeoutError) {
        return unavailable(communityUnavailableReasonCodes.presenceReadTimeout);
      }
      if (
        error instanceof StreamChannelGatewayUnavailableError ||
        error instanceof StreamChannelRequestRejectedError ||
        error instanceof StreamChannelProjectionMismatchError
      ) {
        return unavailable(communityUnavailableReasonCodes.presenceReadFailed);
      }
      // An abort raised by our own controller after the race settled, or
      // anything the gateway did not classify: still not a number.
      return unavailable(communityUnavailableReasonCodes.presenceReadFailed);
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    async readCommunityPresence(
      channel: CommunityChannelViewerRecord | null,
    ): Promise<CommunityPresenceProjection> {
      const resolved = resolveChannel(channel);
      if (resolved.status === "unavailable") {
        return resolved;
      }
      const cached = observations.get(resolved.streamChannelId);
      if (cached !== undefined) {
        const ageMs = clock().getTime() - cached.requestedAtMs;
        if (ageMs >= 0 && ageMs < cacheTtl) {
          // Past half the window the observation is still served and Stream
          // is read again beside this call, so a busy community page never
          // waits for Stream while every answer stays inside the window.
          if (ageMs >= cacheTtl / 2) {
            observe(resolved.streamChannelId).catch(() => undefined);
          }
          return cached.projection;
        }
        observations.delete(resolved.streamChannelId);
      }
      return observe(resolved.streamChannelId);
    },
  });
}
