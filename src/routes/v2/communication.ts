import type { FastifyInstance } from "fastify";

import { registerV2ChatRoutes } from "./chat.js";
import type { V2RouteDependencies } from "./index.js";
import { registerV2VoiceRoomRoutes } from "./voice-rooms.js";

/**
 * `communication` module registrar (Decision 0032): the V2 chat wrapper and
 * community voice rooms. A module not listed in `V2_MODULES_ENABLED`
 * registers no route and every path is the V2 NOT_FOUND envelope.
 */
export function registerV2CommunicationRoutes(
  app: FastifyInstance,
  dependencies: V2RouteDependencies,
): void {
  registerV2ChatRoutes(
    app,
    dependencies.authenticateLoopBearer,
    dependencies.chatService,
  );
  registerV2VoiceRoomRoutes(
    app,
    dependencies.authenticateLoopBearer,
    dependencies.voiceRoomService,
  );
}
