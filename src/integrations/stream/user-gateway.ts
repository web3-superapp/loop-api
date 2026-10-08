import { StreamClient } from "@stream-io/node-sdk";

import type { StreamConfig } from "../../config.js";
import type {
  StreamUserGateway,
  StreamUserProjection,
} from "../../features/communication/stream-user-identity.js";

/**
 * Stream user upsert (Decision 0095). Sends the full `{id, name, image, custom}`
 * projection; Stream replaces the stored user with it.
 */

const streamProviderTimeoutMilliseconds = 3_000;
const maximumUsersPerUpsert = 100;
const streamUserIdPattern = /^loop_[a-z0-9_-]{8,58}$/;

export class StreamUserGatewayUnavailableError extends Error {
  constructor() {
    super("The Stream user gateway is unavailable");
    this.name = "StreamUserGatewayUnavailableError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createUnavailableStreamUserGateway(): StreamUserGateway {
  return Object.freeze({
    upsertUsers: (): Promise<never> =>
      Promise.reject(new StreamUserGatewayUnavailableError()),
  });
}

export function createStreamUserGateway(
  config: StreamConfig | null,
): StreamUserGateway {
  if (config === null) {
    return createUnavailableStreamUserGateway();
  }
  const client = new StreamClient(config.apiKey, config.apiSecret, {
    timeout: streamProviderTimeoutMilliseconds,
  });
  return Object.freeze({
    async upsertUsers(input: {
      readonly users: readonly StreamUserProjection[];
      readonly signal: AbortSignal;
    }): Promise<void> {
      if (
        input.users.length === 0 ||
        input.users.length > maximumUsersPerUpsert ||
        !input.users.every((user) => streamUserIdPattern.test(user.id))
      ) {
        throw new StreamUserGatewayUnavailableError();
      }
      input.signal.throwIfAborted();
      let response: unknown;
      try {
        response = await client.upsertUsers(
          input.users.map((user) => ({ ...user })),
        );
      } catch {
        throw new StreamUserGatewayUnavailableError();
      }
      input.signal.throwIfAborted();
      if (!isRecord(response) || !isRecord(response["users"])) {
        throw new StreamUserGatewayUnavailableError();
      }
      const users = response["users"];
      if (!input.users.every((user) => isRecord(users[user.id]))) {
        throw new StreamUserGatewayUnavailableError();
      }
    },
  });
}
