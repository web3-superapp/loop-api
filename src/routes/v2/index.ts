import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";

import { v2ModuleIds, type AppConfig, type V2ModuleId } from "../../config.js";
import type { V2CursorCodec } from "../../core/http/v2-cursor.js";
import type { AssetRegistryService } from "../../features/chain/asset-registry-service.js";
import type { ChainStatusService } from "../../features/chain/chain-status-service.js";
import type { CommunityService } from "../../features/community/community-service.js";
import type { V2ChatService } from "../../features/communication/v2-chat-service.js";
import type { VoiceRoomService } from "../../features/communication/voice-room-service.js";
import type { V2ProductPolicyRuntime } from "../../features/meta/product-policy.js";
import type { ProfileV2Service } from "../../features/profile/profile-v2-service.js";
import type { V2SessionService } from "../../features/session/session-service.js";
import type { WalletReadService } from "../../features/wallet/wallet-read-service.js";
import type { WatchlistV2Service } from "../../features/watchlist/watchlist-v2-service.js";
import type { MarketReadService } from "../../features/market/market-read-service.js";
import type { AlertV2Service } from "../../features/alerts/alert-v2-service.js";
import type { NotificationService } from "../../features/alerts/notification-service.js";
import type { ApprovalService } from "../../features/wallet-intents/approval-service.js";
import type { SendService } from "../../features/wallet-intents/send-service.js";
import type { SwapService } from "../../features/wallet-intents/swap-service.js";
import type { WalletIntentService } from "../../features/wallet-intents/wallet-intent-service.js";
import type { DeviceService } from "../../features/security/device-service.js";
import type { SecurityService } from "../../features/security/security-service.js";
import type { SettingsService } from "../../features/settings/settings-service.js";
import type { SupportService } from "../../features/support/support-service.js";
import { registerV2ApprovalRoutes } from "./approvals.js";
import { registerV2ChainRoutes } from "./chain.js";
import { registerV2CommunicationRoutes } from "./communication.js";
import { registerV2CommunityRoutes } from "./community.js";
import { registerV2DeviceRoutes } from "./devices.js";
import { registerV2MarketRoutes } from "./market.js";
import { registerV2MetaRoutes } from "./meta.js";
import { registerV2NotificationRoutes } from "./notifications.js";
import { registerV2ProfileRoutes } from "./profile.js";
import { registerV2SearchRoutes } from "./search.js";
import { registerV2SecurityRoutes } from "./security.js";
import { registerV2SessionRoutes } from "./session.js";
import { registerV2SettingsRoutes } from "./settings.js";
import { registerV2SupportRoutes } from "./support.js";
import { registerV2SwapRoutes } from "./swap.js";
import { registerV2WalletRoutes } from "./wallet.js";
import { registerV2WalletIntentRoutes } from "./wallet-intents.js";
import { registerV2WatchlistRoutes } from "./watchlist.js";

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
  readonly chainStatusService: ChainStatusService;
  readonly assetRegistryService: AssetRegistryService;
  readonly walletReadService: WalletReadService;
  readonly watchlistV2Service: WatchlistV2Service;
  readonly marketReadService: MarketReadService;
  readonly alertV2Service: AlertV2Service;
  readonly notificationService: NotificationService;
  readonly chatService: V2ChatService;
  readonly voiceRoomService: VoiceRoomService;
  readonly walletIntentService: WalletIntentService;
  readonly sendService: SendService;
  readonly approvalService: ApprovalService;
  readonly swapService: SwapService;
  readonly deviceService: DeviceService;
  readonly securityService: SecurityService;
  readonly settingsService: SettingsService;
  readonly supportService: SupportService;
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
 * `community` and `search`: 0031; `communication`: 0032; `chain`, `wallet`,
 * and `watchlist`: 0033; `market` and `notifications`: 0034; `swap` and
 * `sendApprovals`: 0035; `security`, `settings`, and `support`: 0037).
 */
export const v2ModuleRegistrars: Readonly<
  Record<V2ModuleId, V2ModuleRegistrar | null>
> = Object.freeze({
  community: registerV2CommunityRoutes,
  communication: registerV2CommunicationRoutes,
  search: registerV2SearchRoutes,
  market: registerV2MarketRoutes,
  chain: registerV2ChainRoutes,
  wallet: registerV2WalletRoutes,
  swap: registerV2SwapRoutes,
  sendApprovals: (app, dependencies): void => {
    registerV2WalletIntentRoutes(app, dependencies);
    registerV2ApprovalRoutes(app, dependencies);
  },
  launch: null,
  mining: null,
  notifications: registerV2NotificationRoutes,
  profile: registerV2ProfileRoutes,
  watchlist: registerV2WatchlistRoutes,
  security: (app, dependencies): void => {
    registerV2DeviceRoutes(app, dependencies);
    registerV2SecurityRoutes(app, dependencies);
  },
  settings: registerV2SettingsRoutes,
  support: registerV2SupportRoutes,
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
