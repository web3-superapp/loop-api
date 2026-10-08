import { deriveStreamUserId } from "../identity/loop-identifiers.js";
import { avatarRefMediaId, mediaAbsoluteUrl } from "../media/media-contract.js";

/**
 * Real identity in Stream (Decision 0095). Every Stream user LOOP writes is
 * `{ id, name, image, custom: { publicProfileId } }`: `name` is the LOOP
 * alias, `image` the absolute URL of an uploaded avatar, and the custom
 * field `publicProfileId` the opaque public identifier that
 * `GET /v2/profiles/{publicProfileId}` reads, so a client can open the
 * public profile from an avatar. A preset or missing avatar and a missing
 * alias are omitted, which Stream reports as no value; `publicProfileId` is
 * omitted unless the account's profile is active. Wallet addresses, LOOP
 * user IDs and LOOP IDs are never put into any field.
 *
 * Stream's server-side user upsert replaces the whole user object, so every
 * server path that upserts users must send this full projection; an
 * `{id}`-only upsert would erase the name and picture.
 */

export interface StreamUserIdentityRecord {
  readonly userId: string;
  readonly alias: string | null;
  readonly avatarRef: string | null;
  /** Public profile ID of an active profile; null otherwise. */
  readonly publicProfileId: string | null;
}

export interface StreamUserIdentityRepository {
  /** Identity facts of the given LOOP users; unknown users are absent. */
  listIdentities(
    userIds: readonly string[],
  ): Promise<readonly StreamUserIdentityRecord[]>;
  /** Activated accounts in `userId` order, for the backfill. */
  listActivatedUserIds(input: {
    readonly afterUserId: string | null;
    readonly limit: number;
  }): Promise<readonly string[]>;
}

export interface StreamUserProjection {
  readonly id: string;
  readonly name?: string;
  readonly image?: string;
  /**
   * Stream custom user data. Chat clients see these keys flattened onto the
   * user object (`extraData`), video clients under `custom`.
   */
  readonly custom?: { readonly publicProfileId: string };
}

export interface StreamUserIdentitySource {
  /** One projection per requested Stream user ID, in request order. */
  resolve(
    streamUserIds: readonly string[],
  ): Promise<readonly StreamUserProjection[]>;
}

export interface StreamUserGateway {
  upsertUsers(input: {
    readonly users: readonly StreamUserProjection[];
    readonly signal: AbortSignal;
  }): Promise<void>;
}

export interface StreamUserSync {
  /** Upserts one account's projection. Never throws; a failure is logged. */
  syncUser(userId: string): Promise<void>;
}

export interface StreamUserSyncLogger {
  warn(context: Record<string, unknown>, message: string): void;
}

const streamUserIdPattern = /^loop_([0-9a-f]{32})$/;

/** Inverse of `deriveStreamUserId`; null for any other shape. */
export function loopUserIdFromStreamUserId(
  streamUserId: string,
): string | null {
  const hex = streamUserIdPattern.exec(streamUserId)?.[1];
  if (hex === undefined) {
    return null;
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function projectStreamUser(
  record: StreamUserIdentityRecord,
  publicBaseUrl: string,
): StreamUserProjection {
  const mediaId = avatarRefMediaId(record.avatarRef);
  return Object.freeze({
    id: deriveStreamUserId(record.userId),
    ...(record.alias === null ? {} : { name: record.alias }),
    ...(mediaId === null
      ? {}
      : { image: mediaAbsoluteUrl(publicBaseUrl, mediaId) }),
    ...(record.publicProfileId === null
      ? {}
      : {
          custom: Object.freeze({ publicProfileId: record.publicProfileId }),
        }),
  });
}

export function createStreamUserIdentitySource(options: {
  readonly repository: StreamUserIdentityRepository;
  readonly publicBaseUrl: string;
}): StreamUserIdentitySource {
  return Object.freeze({
    async resolve(
      streamUserIds: readonly string[],
    ): Promise<readonly StreamUserProjection[]> {
      const userIds = streamUserIds
        .map(loopUserIdFromStreamUserId)
        .filter((value): value is string => value !== null);
      const records =
        userIds.length === 0
          ? []
          : await options.repository.listIdentities(userIds);
      const byStreamUserId = new Map(
        records.map((record) => {
          const projection = projectStreamUser(record, options.publicBaseUrl);
          return [projection.id, projection] as const;
        }),
      );
      return Object.freeze(
        streamUserIds.map(
          (id) => byStreamUserId.get(id) ?? Object.freeze({ id }),
        ),
      );
    },
  });
}

export function createStreamUserSync(options: {
  readonly identities: StreamUserIdentitySource;
  readonly gateway: StreamUserGateway;
  readonly logger?: StreamUserSyncLogger;
  readonly timeoutMs?: number;
}): StreamUserSync {
  const timeoutMs = options.timeoutMs ?? 3_000;
  return Object.freeze({
    async syncUser(userId: string): Promise<void> {
      try {
        const [user] = await options.identities.resolve([
          deriveStreamUserId(userId),
        ]);
        if (user === undefined) {
          return;
        }
        await options.gateway.upsertUsers({
          users: [user],
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        options.logger?.warn(
          { errorName: error instanceof Error ? error.name : "unknown" },
          "LOOP Stream user identity sync failed; the backfill repairs it",
        );
      }
    },
  });
}
