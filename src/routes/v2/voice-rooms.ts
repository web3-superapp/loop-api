import type {
  FastifyInstance,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from "fastify";

import { requireAuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { emptyQueryStringSchema } from "../../core/http/schemas.js";
import { parseV2CommandMetadata } from "../../features/community/community-contract.js";
import type { VoiceRoomService } from "../../features/communication/voice-room-service.js";
import {
  assertNoBodyOrQueryV2,
  assertNoBodyV2,
  v2CommandHeadersSchema,
  v2CommonHeadersSchema,
  validateCommandHeaders,
  validateCommonHeaders,
} from "./community-schemas.js";
import {
  communicationCommandErrors,
  communicationReadErrors,
  communityIdParamsSchema,
  handRaiseQueueResourceSchema,
  voiceRoomCurrentResourceSchema,
  voiceRoomIdParamsSchema,
  voiceRoomMemberListQuerySchema,
  voiceRoomMemberListResourceSchema,
  voiceRoomResourceSchema,
  voiceRoomSpeakerParamsSchema,
} from "./communication-schemas.js";

/**
 * V2 community voice rooms (Decision 0032). Only the host may invite or
 * remove speakers, mute everyone, or end a room; a muted speaker may clear
 * its own mute intent (Decision 0053). A listener joins the queue by raising
 * a hand; the queue order lives in PostgreSQL. Every write on an `ended`
 * room is DATA_STALE.
 */

interface CommunityParams {
  readonly communityId: string;
}

interface VoiceRoomParams {
  readonly voiceRoomId: string;
}

interface SpeakerParams extends VoiceRoomParams {
  readonly publicProfileId: string;
}

function commandMetadata(request: FastifyRequest): {
  readonly idempotencyKey: string;
  readonly requestId: string;
} {
  return {
    idempotencyKey: parseV2CommandMetadata(request.raw.rawHeaders)
      .idempotencyKey,
    requestId: request.id,
  };
}

export function registerV2VoiceRoomRoutes(
  app: FastifyInstance,
  authenticateLoopBearer: preHandlerAsyncHookHandler,
  service: VoiceRoomService,
): void {
  app.post(
    "/v2/communities/:communityId/voice-rooms",
    {
      schema: {
        operationId: "createV2CommunityVoiceRoom",
        summary: "Open a community voice room",
        description:
          "Owner or admin only. The room record and its host are committed first; the Stream `audio_room` call is then created once with backstage enabled. An unconfirmed provider result leaves the room `reconciling` and it cannot be joined.",
        tags: ["communication"],
        security: [{ privyBearer: [] }],
        headers: v2CommandHeadersSchema,
        params: communityIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: {
          201: voiceRoomResourceSchema,
          ...communicationCommandErrors,
        },
      },
      onRequest: validateCommandHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as CommunityParams;
      const resource = await service.createRoom({
        principal: requireAuthenticatedLoopPrincipal(request),
        communityId: params.communityId,
        signal: request.signal,
        ...commandMetadata(request),
      });
      reply.header("cache-control", "no-store");
      return reply.code(201).send(resource);
    },
  );

  app.get(
    "/v2/communities/:communityId/voice-rooms/current",
    {
      schema: {
        operationId: "getV2CommunityCurrentVoiceRoom",
        summary: "Get the community's live voice room",
        description:
          "Returns null with a machine reason code when no room is live. The observed participant count is a read-only Stream projection carrying its own observedAt; it is never a LOOP-maintained counter.",
        tags: ["communication"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: communityIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: {
          200: voiceRoomCurrentResourceSchema,
          ...communicationReadErrors,
        },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as CommunityParams;
      const resource = await service.getCurrentRoom({
        principal: requireAuthenticatedLoopPrincipal(request),
        communityId: params.communityId,
        signal: request.signal,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/voice-rooms/:voiceRoomId",
    {
      schema: {
        operationId: "getV2VoiceRoom",
        summary: "Get one voice room",
        tags: ["communication"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: voiceRoomIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: {
          200: voiceRoomResourceSchema,
          ...communicationReadErrors,
        },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as VoiceRoomParams;
      const resource = await service.getRoom({
        principal: requireAuthenticatedLoopPrincipal(request),
        voiceRoomId: params.voiceRoomId,
        signal: request.signal,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/voice-rooms/:voiceRoomId/hand-raises",
    {
      schema: {
        operationId: "listV2VoiceRoomHandRaises",
        summary: "List the pending hand-raise queue in order",
        description:
          "The queue order is a PostgreSQL sequence allocated under the room row lock, so concurrent raises keep a stable total order.",
        tags: ["communication"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: voiceRoomIdParamsSchema,
        querystring: emptyQueryStringSchema,
        response: {
          200: handRaiseQueueResourceSchema,
          ...communicationReadErrors,
        },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyOrQueryV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as VoiceRoomParams;
      const resource = await service.listHandRaises({
        principal: requireAuthenticatedLoopPrincipal(request),
        voiceRoomId: params.voiceRoomId,
        signal: request.signal,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  app.get(
    "/v2/voice-rooms/:voiceRoomId/members",
    {
      schema: {
        operationId: "listV2VoiceRoomMembers",
        summary: "List the speaker or listener roster",
        description:
          "The LOOP `joined` members of one role view in join order (Decision 0052). It is the authorization roster, not presence: Stream session participants are never mixed in, and 'people in the room now' stays `participants.observed.participantCount` on the room resource. Names follow the leaderboard display rule (anonymous mode alone decides what others see). Each row carries `commands`, the viewer's executable row commands: the host's invite/remove/mute/unmute, and for a non-host only `unmute_self` on its own muted speaker row (Decision 0053). `limit` and `cursor` are mutually exclusive.",
        tags: ["communication"],
        security: [{ privyBearer: [] }],
        headers: v2CommonHeadersSchema,
        params: voiceRoomIdParamsSchema,
        querystring: voiceRoomMemberListQuerySchema,
        response: {
          200: voiceRoomMemberListResourceSchema,
          ...communicationReadErrors,
        },
      },
      onRequest: validateCommonHeaders,
      preValidation: assertNoBodyV2,
      preHandler: authenticateLoopBearer,
    },
    async (request, reply) => {
      const params = request.params as VoiceRoomParams;
      const query = request.query as {
        readonly role?: unknown;
        readonly cursor?: unknown;
        readonly limit?: unknown;
      };
      const resource = await service.listMembers({
        principal: requireAuthenticatedLoopPrincipal(request),
        voiceRoomId: params.voiceRoomId,
        role: query.role,
        cursor: query.cursor,
        limit: query.limit,
        signal: request.signal,
      });
      reply.header("cache-control", "no-store");
      return reply.code(200).send(resource);
    },
  );

  const simpleCommands = [
    [
      "post",
      "join",
      "joinV2VoiceRoom",
      "Join a voice room as a listener",
      "Idempotent: an account that is already a member keeps its current role and the response reports that role. Only a provisioned, live room can be joined.",
      "join",
    ],
    [
      "post",
      "leave",
      "leaveV2VoiceRoom",
      "Leave a voice room",
      "The host cannot leave; it ends the room instead. Leaving cancels any pending hand raise.",
      "leave",
    ],
    [
      "post",
      "hand-raise",
      "raiseV2VoiceRoomHand",
      "Raise a hand to request the microphone",
      "Only a joined listener may raise a hand, and only one raise may be pending per account. A second raise while one is pending is DATA_STALE.",
      "raiseHand",
    ],
    [
      "delete",
      "hand-raise",
      "cancelV2VoiceRoomHandRaise",
      "Cancel a pending hand raise",
      "Cancelling when nothing is pending is DATA_STALE.",
      "cancelHandRaise",
    ],
    [
      "post",
      "mute-all",
      "muteAllV2VoiceRoomSpeakers",
      "Mute every participant",
      "Host only. The LOOP audit row commits first, then one Stream muteUsers call is attempted; the response reports whether it was confirmed.",
      "muteAll",
    ],
    [
      "post",
      "end",
      "endV2VoiceRoom",
      "End the voice room",
      "Host only. LOOP owns the room lifecycle, so the room becomes `ended` and every later write is DATA_STALE even when the single Stream endCall attempt is unconfirmed.",
      "endRoom",
    ],
  ] as const;

  for (const [
    method,
    path,
    operationId,
    summary,
    description,
    action,
  ] of simpleCommands) {
    const register =
      method === "post" ? app.post.bind(app) : app.delete.bind(app);
    register(
      `/v2/voice-rooms/:voiceRoomId/${path}`,
      {
        schema: {
          operationId,
          summary,
          description,
          tags: ["communication"],
          security: [{ privyBearer: [] }],
          headers: v2CommandHeadersSchema,
          params: voiceRoomIdParamsSchema,
          querystring: emptyQueryStringSchema,
          response: {
            200: voiceRoomResourceSchema,
            ...communicationCommandErrors,
          },
        },
        onRequest: validateCommandHeaders,
        preValidation: assertNoBodyOrQueryV2,
        preHandler: authenticateLoopBearer,
      },
      async (request, reply) => {
        const params = request.params as VoiceRoomParams;
        const resource = await service[action]({
          principal: requireAuthenticatedLoopPrincipal(request),
          voiceRoomId: params.voiceRoomId,
          signal: request.signal,
          ...commandMetadata(request),
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(resource);
      },
    );
  }

  const speakerCommands = [
    [
      "post",
      "",
      "inviteV2VoiceRoomSpeaker",
      "Invite a listener to speak",
      "Host only. The LOOP role commits first, then Stream is granted send-audio for that member in one attempt. The roster's `invite_speaker` command.",
      "inviteSpeaker",
    ],
    [
      "delete",
      "",
      "removeV2VoiceRoomSpeaker",
      "Move a speaker back to listener",
      "Host only. Stream's send-audio permission is revoked in the same single attempt. The roster's `remove_speaker` command; it clears the mute intent.",
      "removeSpeaker",
    ],
    [
      "post",
      "/mute",
      "muteV2VoiceRoomSpeaker",
      "Mute one speaker",
      "Host only; the roster's `mute` command (Decision 0052). The LOOP mute intent commits first (a listener or an already muted speaker is DATA_STALE), then one Stream muteUsers call for that member is attempted. Stream stays authoritative for the live microphone; the intent clears on the next role transition or through DELETE .../mute.",
      "muteSpeaker",
    ],
    [
      "delete",
      "/mute",
      "unmuteV2VoiceRoomSpeaker",
      "Clear one speaker's mute intent",
      "The muted speaker itself or the host (Decision 0053); the roster's `unmute_self` / `unmute` command and the only row command open to a non-host. Anyone else is PERMISSION_DENIED. The target must be a joined, muted speaker (otherwise DATA_STALE). It clears the LOOP mute intent and writes the audit only: no Stream call is made, because Stream does not let anyone open another member's microphone; the speaker's own device opens it. `providerSync` is therefore always confirmed.",
      "unmuteSpeaker",
    ],
  ] as const;

  for (const [
    method,
    suffix,
    operationId,
    summary,
    description,
    action,
  ] of speakerCommands) {
    const register =
      method === "post" ? app.post.bind(app) : app.delete.bind(app);
    register(
      `/v2/voice-rooms/:voiceRoomId/speakers/:publicProfileId${suffix}`,
      {
        schema: {
          operationId,
          summary,
          description,
          tags: ["communication"],
          security: [{ privyBearer: [] }],
          headers: v2CommandHeadersSchema,
          params: voiceRoomSpeakerParamsSchema,
          querystring: emptyQueryStringSchema,
          response: {
            200: voiceRoomResourceSchema,
            ...communicationCommandErrors,
          },
        },
        onRequest: validateCommandHeaders,
        preValidation: assertNoBodyOrQueryV2,
        preHandler: authenticateLoopBearer,
      },
      async (request, reply) => {
        const params = request.params as SpeakerParams;
        const resource = await service[action]({
          principal: requireAuthenticatedLoopPrincipal(request),
          voiceRoomId: params.voiceRoomId,
          targetPublicProfileId: params.publicProfileId,
          signal: request.signal,
          ...commandMetadata(request),
        });
        reply.header("cache-control", "no-store");
        return reply.code(200).send(resource);
      },
    );
  }
}
