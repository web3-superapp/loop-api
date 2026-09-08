import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";

import { v2ModuleIds, type AppConfig, type V2ModuleId } from "../../config.js";
import type { V2CursorCodec } from "../../core/http/v2-cursor.js";
import type { CommunityService } from "../../features/community/community-service.js";
import type { V2ProductPolicyRuntime } from "../../features/meta/product-policy.js";
import type { ProfileV2Service } from "../../features/profile/profile-v2-service.js";
import type { V2SessionService } from "../../features/session/session-service.js";
import { registerV2CommunityRoutes } from "./community.js";
import { registerV2MetaRoutes } from "./meta.js";
import { registerV2ProfileRoutes } from "./profile.js";
import { registerV2SearchRoutes } from "./search.js";
import { registerV2SessionRoutes } from "./session.js";

/**
 * Dependencies shared by every V2 route module. Module registrars receive the
 * same object so they cannot compose their own authentication or cursor
 * boundary.
 */
export interface V2RouteDependencies {
  readonly config: AppConfig;
  readonly runtime: V2ProductPolicyRuntime;
  readonly authenticatePrivyBearer: preHandlerAsyncHookHandler;
  readonly authenticateLoopBearer: preHandlerAsyncHookHandler;
  readonly sessionService: V2SessionService;
  readonly profileService: ProfileV2Service;
  readonly communityService: CommunityService;
  readonly cursorCodec: V2CursorCodec | null;
}

export type V2ModuleRegistrar = (
  app: FastifyInstance,
  dependencies: V2RouteDependencies,
) => void;

/**
 * Route registrars per module ID. A `null` entry means the module has no
 * delivered runtime yet: enabling it in V2_MODULES_ENABLED registers no route
 * and its capability reports MODULE_RUNTIME_NOT_REGISTERED. Each delivered
 * module replaces its entry in its own numbered decision (`profile`: 0030;
 * `community` and `search`: 0031).
 */
export const v2ModuleRegistrars: Readonly<
  Record<V2ModuleId, V2ModuleRegistrar | null>
> = Object.freeze({
  community: registerV2CommunityRoutes,
  search: registerV2SearchRoutes,
  market: null,
  wallet: null,
  swap: null,
  sendApprovals: null,
  launch: null,
  mining: null,
  notifications: null,
  profile: registerV2ProfileRoutes,
});

export function registeredV2ModuleIds(
  config: AppConfig,
): readonly V2ModuleId[] {
  return v2ModuleIds.filter(
    (moduleId) =>
      config.v2ModulesEnabled.has(moduleId) &&
      v2ModuleRegistrars[moduleId] !== null,
  );
}

/**
 * The single V2 registration point. `buildApp` calls it once; meta and
 * session are always registered, module routes only when the module is both
 * enabled by configuration and has a delivered registrar.
 */
export function registerV2Routes(
  app: FastifyInstance,
  dependencies: V2RouteDependencies,
): void {
  registerV2MetaRoutes(app, dependencies.config, dependencies.runtime);
  registerV2SessionRoutes(
    app,
    dependencies.authenticatePrivyBearer,
    dependencies.authenticateLoopBearer,
    dependencies.sessionService,
  );
  for (const moduleId of registeredV2ModuleIds(dependencies.config)) {
    const register = v2ModuleRegistrars[moduleId];
    if (register !== null) {
      register(app, dependencies);
    }
  }
}
