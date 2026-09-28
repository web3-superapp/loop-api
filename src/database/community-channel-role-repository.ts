import type { Pool } from "pg";
import { z } from "zod";

import {
  communityMembershipStatuses,
  communityRoles,
  communityStreamChannelRole,
  type CommunityStreamChannelRole,
} from "../features/community/community-policy.js";
import { deriveStreamUserId } from "../features/identity/loop-identifiers.js";

/**
 * Decision 0091 backfill source: every member Stream already accepted into a
 * provisioned official channel (`synced`), with the channel role its current
 * community membership calls for. Read-only.
 */
export interface SyncedCommunityChannelMemberRole {
  readonly communityId: string;
  readonly ownerUserId: string;
  readonly streamChannelId: string;
  readonly channelCreatedByStreamUserId: string;
  readonly memberStreamUserId: string;
  readonly desiredChannelRole: CommunityStreamChannelRole;
}

export interface CommunityChannelRoleRepository {
  listSyncedMemberRoles(input: {
    readonly limit: number;
    readonly after: {
      readonly communityId: string;
      readonly ownerUserId: string;
    } | null;
  }): Promise<readonly SyncedCommunityChannelMemberRole[]>;
}

const uuidSchema = z.string().uuid();
const limitSchema = z.number().int().min(1).max(100);
const streamCommunityChannelIdSchema = z
  .string()
  .regex(/^loop_community_[0-9a-f]{32}$/);

export function createPostgresCommunityChannelRoleRepository(
  pool: Pool,
): CommunityChannelRoleRepository {
  return Object.freeze({
    async listSyncedMemberRoles(input: {
      readonly limit: number;
      readonly after: {
        readonly communityId: string;
        readonly ownerUserId: string;
      } | null;
    }): Promise<readonly SyncedCommunityChannelMemberRole[]> {
      const limit = limitSchema.parse(input.limit);
      const afterCommunityId =
        input.after === null ? null : uuidSchema.parse(input.after.communityId);
      const afterOwnerUserId =
        input.after === null ? null : uuidSchema.parse(input.after.ownerUserId);
      const result = await pool.query<Record<string, unknown>>({
        text: `
          select
            member.community_id,
            member.owner_user_id,
            channel.stream_channel_id,
            channel.created_by_user_id,
            membership.role,
            membership.status
          from public.community_channel_members as member
          join public.community_channels as channel
            on channel.community_id = member.community_id
            and channel.provisioned_at is not null
            and channel.state <> 'failed'
          join public.community_memberships as membership
            on membership.community_id = member.community_id
            and membership.owner_user_id = member.owner_user_id
          where member.state = 'synced'
            and membership.status <> 'banned'
            and (
              $2::uuid is null
              or (member.community_id, member.owner_user_id)
                > ($2::uuid, $3::uuid)
            )
          order by member.community_id asc, member.owner_user_id asc
          limit $1
        `,
        values: [limit, afterCommunityId, afterOwnerUserId],
      });
      return Object.freeze(
        result.rows.map((row) => {
          const ownerUserId = uuidSchema.parse(row["owner_user_id"]);
          return Object.freeze({
            communityId: uuidSchema.parse(row["community_id"]),
            ownerUserId,
            streamChannelId: streamCommunityChannelIdSchema.parse(
              row["stream_channel_id"],
            ),
            channelCreatedByStreamUserId: deriveStreamUserId(
              uuidSchema.parse(row["created_by_user_id"]),
            ),
            memberStreamUserId: deriveStreamUserId(ownerUserId),
            desiredChannelRole: communityStreamChannelRole(
              z.enum(communityRoles).parse(row["role"]),
              z.enum(communityMembershipStatuses).parse(row["status"]),
            ),
          });
        }),
      );
    },
  });
}
