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

export function createCommunityPresenceReader(
  options: CommunityPresenceReaderOptions,
): CommunityPresenceReader {
  const clock = options.clock ?? (() => new Date());
  const budget =
    options.timeoutMilliseconds ?? communityPresenceTimeoutMilliseconds;
  if (!Number.isSafeInteger(budget) || budget <= 0) {
    throw new RangeError("Presence read budget must be a positive integer");
  }

  return Object.freeze({
    async readCommunityPresence(
      channel: CommunityChannelViewerRecord | null,
    ): Promise<CommunityPresenceProjection> {
      const resolved = resolveChannel(channel);
      if (resolved.status === "unavailable") {
        return resolved;
      }
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
            channelId: resolved.streamChannelId,
            signal: controller.signal,
          }),
          deadline,
        ]);
        if (result.status === "bound_exceeded") {
          return unavailable(
            communityUnavailableReasonCodes.presenceMemberBound,
          );
        }
        return Object.freeze({
          status: "available" as const,
          count: result.onlineMemberCount,
          observedAt: clock().toISOString(),
          source: communityPresenceSource,
        });
      } catch (error) {
        if (error instanceof PresenceReadTimeoutError) {
          return unavailable(
            communityUnavailableReasonCodes.presenceReadTimeout,
          );
        }
        if (
          error instanceof StreamChannelGatewayUnavailableError ||
          error instanceof StreamChannelRequestRejectedError ||
          error instanceof StreamChannelProjectionMismatchError
        ) {
          return unavailable(
            communityUnavailableReasonCodes.presenceReadFailed,
          );
        }
        // An abort raised by our own controller after the race settled, or
        // anything the gateway did not classify: still not a number.
        return unavailable(communityUnavailableReasonCodes.presenceReadFailed);
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
