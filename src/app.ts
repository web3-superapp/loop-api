import { randomUUID } from "node:crypto";

import helmet from "@fastify/helmet";
import swagger from "@fastify/swagger";
import Fastify, {
  errorCodes as fastifyErrorCodes,
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyServerOptions,
} from "fastify";

import type { AppConfig } from "./config.js";
import { ApiError } from "./core/http/api-error.js";
import {
  registerRequestAbortSignal,
  requestAbortDeadlineMilliseconds,
} from "./core/http/request-abort-signal.js";
import { createV2CursorCodec } from "./core/http/v2-cursor.js";
import { summarizeErrorForLog } from "./core/http/error-log.js";
import {
  isV2RequestPath,
  projectV2Error,
  V2ApiError,
} from "./core/http/v2-error.js";
import {
  createAuthenticationService,
  registerAuthenticationHooks,
} from "./core/http/authentication.js";
import { createPostgresDatabase, type Database } from "./database/database.js";
import { createUnavailableAccountWalletRepository } from "./database/account-wallet-repository.js";
import { createUnavailableBscIndexerRepository } from "./database/bsc-indexer-repository.js";
import { createUnavailableChainRegistryRepository } from "./database/chain-registry-repository.js";
import { createUnavailableWatchlistV2Repository } from "./database/watchlist-v2-repository.js";
import { createUnavailableMarketFactCacheRepository } from "./database/market-fact-cache-repository.js";
import { createUnavailableAlertV2Repository } from "./database/alert-v2-repository.js";
import { createUnavailableNotificationRepository } from "./database/notification-repository.js";
import { createUnavailablePushRepository } from "./features/push/push-repository.js";
import { launchContractEvidenceFrom } from "./features/meta/product-policy.js";
import {
  createPushDispatchService,
  createUnavailablePushDispatchService,
  type PushDispatchService,
} from "./features/push/push-dispatch-service.js";
import {
  createPushTokenService,
  type PushTokenService,
} from "./features/push/push-token-service.js";
import {
  createFcmSender,
  nodeFcmFetch,
  type FcmSender,
} from "./integrations/fcm/fcm-sender.js";
import {
  FirebaseServiceAccountError,
  loadFirebaseServiceAccount,
} from "./integrations/fcm/service-account.js";
import { createUnavailableWalletIntentRepository } from "./database/wallet-intent-repository.js";
import {
  createApprovalService,
  type ApprovalService,
} from "./features/wallet-intents/approval-service.js";
import type { WalletIntentRuntime } from "./features/wallet-intents/intent-preparation.js";
import {
  createSendService,
  type SendService,
} from "./features/wallet-intents/send-service.js";
import {
  createSwapService,
  type SwapService,
} from "./features/wallet-intents/swap-service.js";
import {
  createWalletIntentService,
  type WalletIntentService,
} from "./features/wallet-intents/wallet-intent-service.js";
import {
  createPrivySwapAdapter,
  createUnavailablePrivySwapAdapter,
  type PrivySwapAdapter,
} from "./integrations/privy/swap-adapter.js";
import {
  createMarketFactService,
  type MarketFactService,
} from "./features/market/market-fact-service.js";
import {
  createMarketReadService,
  type MarketReadService,
} from "./features/market/market-read-service.js";
import {
  createAlertV2Service,
  type AlertV2Service,
} from "./features/alerts/alert-v2-service.js";
import {
  createNotificationService,
  type NotificationService,
} from "./features/alerts/notification-service.js";
import { createMarketProviders } from "./integrations/market/provider-factory.js";
import type {
  CandlesProvider,
  MarketPairsProvider,
  SecurityFactsProvider,
  TokenLookupProvider,
} from "./integrations/market/market-data-provider.js";
import {
  createAssetRegistryService,
  type AssetRegistryService,
} from "./features/chain/asset-registry-service.js";
import {
  createChainStatusService,
  type ChainStatusService,
} from "./features/chain/chain-status-service.js";
import {
  bscChainId,
  bscChainReference,
  bscNativeAssetId,
  launchChainReasonCodes,
  launchSlotActionsOpen,
  type LaunchSlotPolicy,
} from "./features/chain/chain-contract.js";
import {
  createWalletReadService,
  measureWalletNetWorth,
  priceReadFailure,
  type WalletReadService,
} from "./features/wallet/wallet-read-service.js";
import {
  createWalletNetWorthHistoryService,
  type WalletNetWorthHistoryService,
} from "./features/wallet/wallet-networth-history.js";
import {
  createWatchlistV2Service,
  type WatchlistV2Service,
} from "./features/watchlist/watchlist-v2-service.js";
import {
  asChainCallClient,
  BscReadUnavailableError,
  createBscReadClient,
  createUnavailableBscReadClient,
  isBscRpcTransportError,
  type BscChainCallClient,
  type BscReadClient,
} from "./integrations/bsc/rpc-client.js";
import {
  createChainVerificationWatch,
  type CreateChainVerificationWatchInput,
} from "./integrations/bsc/chain-verification-watch.js";
import {
  createPrivyBalanceReader,
  createPrivyWalletReader,
  createUnavailablePrivyBalanceReader,
  createUnavailablePrivyWalletReader,
  type PrivyBalanceReader,
  type PrivyWalletReader,
} from "./integrations/privy/wallet-reader.js";
import {
  createAnthropicCommunityAiGateway,
  type CommunityAiGateway,
} from "./integrations/ai/anthropic-adapter.js";
import {
  communityAiDefaultBriefTimeoutMs,
  communityAiDefaultQuota,
} from "./features/community-ai/community-ai-contract.js";
import { createUnavailableCommunityAiRepository } from "./features/community-ai/community-ai-repository.js";
import {
  createCommunityAiService,
  createUnavailableCommunityAiService,
  type CommunityAiService,
} from "./features/community-ai/community-ai-service.js";
import { createUnavailableCommunityRepository } from "./features/community/community-repository.js";
import {
  createCommunityService,
  type CommunityService,
} from "./features/community/community-service.js";
import { createUnavailableAliasDirectoryRepository } from "./database/alias-directory-repository.js";
import { createUnavailableSocialRepository } from "./database/social-repository.js";
import {
  createAlertService,
  type AlertService,
} from "./features/alerts/alert-service.js";
import {
  createChatGroupAliasService,
  type ChatGroupAliasService,
} from "./features/communication/chat-group-alias-service.js";
import {
  createChatChannelService,
  createUnavailableChatChannelService,
  type ChatChannelService,
} from "./features/communication/chat-channel-service.js";
import { createUnavailableChatChannelRepository } from "./features/communication/chat-channel-repository.js";
import { createUnavailableCommunicationRepository } from "./features/communication/communication-repository.js";
import {
  createUnavailableV2ChatService,
  createV2ChatService,
  type V2ChatService,
} from "./features/communication/v2-chat-service.js";
import {
  createUnavailableVoiceRoomService,
  createVoiceRoomService,
  type VoiceRoomService,
} from "./features/communication/voice-room-service.js";
import {
  createStreamCallGateway,
  createUnavailableStreamCallGateway,
  type StreamCallGateway,
} from "./integrations/stream/call-gateway.js";
import {
  createStreamTokenService,
  StreamTokenUnavailableError,
  type StreamTokenService,
} from "./features/communication/stream-token-service.js";
import { createBootstrapService } from "./features/identity/bootstrap-service.js";
import {
  createAliasSearchQuota,
  createUnavailableAliasSearchQuota,
} from "./features/identity/alias-search-quota.js";
import {
  createPublicAliasSearchService,
  type PublicAliasSearchService,
} from "./features/identity/public-alias-search-service.js";
import { createAliasPolicy } from "./features/profile/alias-policy.js";
import {
  createProfileService,
  type ProfileService,
} from "./features/profile/profile-service.js";
import { createUnavailableProfileV2Repository } from "./features/profile/profile-v2-repository.js";
import {
  createProfileV2Service,
  type ProfileV2Service,
} from "./features/profile/profile-v2-service.js";
import { createSocialCursorCodec } from "./features/social/social-cursor.js";
import { createSocialMutationQuota } from "./features/social/social-mutation-quota.js";
import { createUnlistedTokenLookupQuota } from "./features/market/unlisted-token-lookup-quota.js";
import {
  createSocialService,
  createUnavailableSocialService,
  type SocialService,
} from "./features/social/social-service.js";
import {
  createV2SessionService,
  type V2SessionService,
} from "./features/session/session-service.js";
import {
  createUnavailableSpotAgentAuthorizationService,
  type SpotAgentAuthorizationService,
} from "./features/spot/spot-agent-authorization-service.js";
import {
  createUnavailableSpotIntentService,
  type SpotIntentService,
} from "./features/spot/spot-intent-service.js";
import {
  createUnavailableSpotMarketService,
  type SpotMarketService,
} from "./features/spot/spot-market-service.js";
import {
  createUnavailableSpotWalletBindingService,
  type SpotWalletBindingService,
} from "./features/spot/spot-wallet-binding-service.js";
import { createPerpPrivateReadCursorCodec } from "./features/perp/private-read-cursor.js";
import { createPerpPrivateReadService } from "./features/perp/private-read-service.js";
import {
  createAgentAuthorizationService,
  type AgentAuthorizationMutationGate,
} from "./features/perp/agent-authorization-service.js";
import {
  createPerpIntentService,
  type PerpMutationGate,
} from "./features/perp/perp-intent-service.js";
import { createPerpWalletBindingService } from "./features/perp/wallet-binding-service.js";
import { createUnavailableTransferService } from "./features/transfer/transfer-service.js";
import {
  createWatchlistService,
  type WatchlistService,
} from "./features/watchlist/watchlist-service.js";
import { createPerpWalletBindingResolver } from "./features/perp/wallet-binding-resolver.js";
import {
  createUnavailableWalletBindingResolver,
  type WalletBindingResolver,
} from "./features/wallet/wallet-binding-resolver.js";
import { createHyperliquidInfoPrivateReader } from "./integrations/hyperliquid/info-private-reader.js";
import { createPostgresHyperliquidInfoQuota } from "./integrations/hyperliquid/info-quota.js";
import { createLosslessHyperliquidInfoTransport } from "./integrations/hyperliquid/lossless-info-transport.js";
import {
  createUnavailableHyperliquidPrivateReader,
  type HyperliquidPrivateReader,
} from "./integrations/hyperliquid/private-reader.js";
import {
  createUnavailableHyperliquidPerpIntentReviewer,
  type HyperliquidPerpIntentReviewer,
} from "./integrations/hyperliquid/perp-intent-reviewer.js";
import {
  createStreamChannelGateway,
  createStreamCommunityChannelGateway,
  createUnavailableStreamCommunityChannelGateway,
  createUnavailableStreamChannelGateway,
  type StreamChannelGateway,
  type StreamCommunityChannelGateway,
} from "./integrations/stream/channel-gateway.js";
import {
  createStreamGroupMemberGateway,
  createUnavailableStreamGroupMemberGateway,
  type StreamGroupMemberGateway,
} from "./integrations/stream/group-member-gateway.js";
import {
  createStreamTokenIssuer,
  createUnavailableStreamTokenIssuer,
  type StreamTokenIssuer,
} from "./integrations/stream/token-issuer.js";
import {
  createPrivyAccessTokenVerifierWithClient,
  createUnavailablePrivyAccessTokenVerifier,
  type PrivyAccessTokenVerifier,
} from "./integrations/privy/access-token-verifier.js";
import { createPrivyServerClient } from "./integrations/privy/client.js";
import {
  createPrivyUserReader,
  createUnavailablePrivyUserReader,
  type PrivyUserReader,
} from "./integrations/privy/user-reader.js";
import { registerBootstrapRoute } from "./routes/bootstrap.js";
import { registerChatChannelRoutes } from "./routes/chat-channels.js";
import { registerChatGroupRoutes } from "./routes/chat-groups.js";
import { registerDiscoveryRoutes } from "./routes/discovery.js";
import { registerAgentAuthorizationRoutes } from "./routes/agent-authorizations.js";
import { registerAlertRoutes } from "./routes/alerts.js";
import { registerHealthRoutes } from "./routes/health.js";
import {
  registerPublicMemeRoutes,
  type PublicMemeRouteOptions,
} from "./routes/public-meme.js";
import { registerWellKnownRoutes } from "./routes/well-known.js";
import {
  createStreamUserIdentitySource,
  createStreamUserSync,
  type StreamUserGateway,
} from "./features/communication/stream-user-identity.js";
import { createStreamUserGateway } from "./integrations/stream/user-gateway.js";
import {
  createMediaService,
  type MediaService,
} from "./features/media/media-service.js";
import { createUnavailableMediaStorage } from "./features/media/media-storage.js";
import {
  createMediaUploadQuota,
  createUnavailableMediaUploadQuota,
} from "./features/media/media-upload-quota.js";
import {
  createPublicProfileService,
  type PublicProfileService,
} from "./features/profile/public-profile-service.js";
import { createUnavailablePublicProfileRepository } from "./features/profile/public-profile-repository.js";
import { registerPerpPrivateReadRoutes } from "./routes/perp-private-reads.js";
import { registerPerpIntentRoutes } from "./routes/perp-intents.js";
import { registerPerpWalletBindingRoutes } from "./routes/perp-wallet-binding.js";
import { registerProfileRoutes } from "./routes/profile.js";
import { registerStreamTokenRoutes } from "./routes/stream-tokens.js";
import { registerSpotAgentAuthorizationRoutes } from "./routes/spot-agent-authorizations.js";
import { registerSpotIntentRoutes } from "./routes/spot-intents.js";
import { registerSpotMarketDataRoutes } from "./routes/spot-market-data.js";
import { registerSpotWalletBindingRoutes } from "./routes/spot-wallet-binding.js";
import { registerSocialRoutes } from "./routes/social.js";
import { registerTransferRoutes } from "./routes/transfers.js";
import { registerWatchlistRoutes } from "./routes/watchlist.js";
import { registeredV2ModuleIds, registerV2Routes } from "./routes/v2/index.js";
import { registerAdminRoutes } from "./routes/admin/index.js";
import {
  AdminApiError,
  adminSessionCookieName,
  isAdminRequestPath,
  projectAdminError,
} from "./features/admin/admin-contract.js";
import {
  createAdminService,
  type AdminMemePauseRuntime,
} from "./features/admin/admin-service.js";
import { createAdminSettingsReader } from "./features/admin/admin-settings-reader.js";
import { createAdminAccountService } from "./features/admin/admin-accounts.js";
import { createAdminLaunchReviewConsoleService } from "./features/admin/admin-launch-review.js";
import { createHooksLaunchReviewService } from "./features/launch/hooks-launch-review.js";
import { createUnavailableAdminRepository } from "./database/admin-repository.js";
import { createCommunityReviewService } from "./features/community/community-review-service.js";
import {
  createMemePauseSender,
  type MemePauseSender,
} from "./integrations/meme/meme-pause-sender.js";
import { MemeGraduationSenderRefusedError } from "./integrations/meme/meme-graduation-sender.js";
import { createTokenLogoProjector } from "./features/market/token-logo.js";
import { createTokenLogoProxyService } from "./features/market/token-logo-proxy.js";
import {
  createLaunchService,
  createUnavailableLaunchService,
  type LaunchService,
} from "./features/launch/launch-service.js";
import { createHooksLaunchProjectConfigService } from "./features/launch/hooks-launch-project-config.js";
import {
  createHooksLaunchDeploymentService,
  type HooksLaunchFactoryReader,
} from "./features/launch/hooks-launch-deployment.js";
import { createHooksLaunchSubmissionService } from "./features/launch/hooks-launch-submission.js";
import { createHooksLaunchFactoryReader } from "./integrations/launch/hooks-launch-factory-reader.js";
import {
  createLaunchContractAdapter,
  type LaunchContractAdapter,
} from "./integrations/launch/launch-contract-adapter.js";
import { createUnavailableLaunchRepository } from "./features/launch/launch-repository.js";
import {
  createMiningFormulaBaselineProbe,
  createUnavailableMiningFormulaBaselineProbe,
} from "./features/mining/mining-baseline.js";
import { createMiningPowerReader } from "./features/mining/mining-power-reader.js";
import { createCommunityPresenceReader } from "./features/community/community-presence-reader.js";
import {
  createMiningService,
  createUnavailableMiningService,
  type MiningService,
} from "./features/mining/mining-service.js";
import { createUnavailableMiningRepository } from "./features/mining/mining-repository.js";
import { createWalletAccountDirectory } from "./features/profile/wallet-account-directory.js";
import {
  createReferralService,
  createUnavailableReferralService,
  type ReferralService,
} from "./features/referral/referral-service.js";
import { createUnavailableReferralRepository } from "./features/referral/referral-repository.js";
import {
  createDeviceService,
  type DeviceService,
} from "./features/security/device-service.js";
import {
  createSecurityService,
  type SecurityService,
} from "./features/security/security-service.js";
import {
  createSettingsService,
  type SettingsService,
} from "./features/settings/settings-service.js";
import { createUnavailableAccountSettingsRepository } from "./features/settings/account-settings-repository.js";
import {
  createSupportService,
  type SupportService,
} from "./features/support/support-service.js";
import { createUnavailableSupportTicketRepository } from "./features/support/support-ticket-repository.js";
import {
  createMemeService,
  createUnavailableMemeService,
  type MemeService,
} from "./features/meme/meme-service.js";
import type { MemeDexQuote } from "./features/meme/meme-projection.js";
import { memeRules } from "./features/meme/meme-contract.js";
import {
  createLaunch2Service,
  createUnavailableLaunch2Service,
  type Launch2Service,
} from "./features/launch2/launch2-service.js";
import type {
  Launch2Chain,
  Launch2DynamicChain,
  Launch2PoolChain,
} from "./features/launch2/launch2-ports.js";
import { createLaunch2Chain } from "./integrations/launch2/launch2-chain.js";
import { createLaunch2PoolChain } from "./integrations/launch2/launch2-pool-chain.js";
import { createLaunch2DynamicChain } from "./integrations/launch2/launch2-dynamic-chain.js";
import {
  createMiningRewardsService,
  type MiningRewardsService,
} from "./features/mining/hourly-rewards-service.js";
import type { MiningClaimChain } from "./features/mining/hourly-settlement-ports.js";
import { createMiningClaimSigner } from "./features/mining/claim-voucher.js";
import { createMiningSettlementRunner } from "./features/mining/hourly-settlement-runner.js";
import { createAdminMiningSettlementService } from "./features/admin/admin-mining-settlement.js";
import { createAdminChainGuardService } from "./features/admin/admin-chain-guard.js";
import { createAdminLaunch2CampaignService } from "./features/admin/admin-launch2-campaigns.js";
import { createLaunch2CampaignPublicService } from "./features/launch2/launch2-campaigns.js";
import { createChainGuardAlertNotifier } from "./integrations/chain-guard/chain-guard-alerts.js";
import { createChainGuardHoldGate } from "./features/chain-guard/chain-guard-hold.js";
import { createMiningRewardClaimChain } from "./integrations/mining/reward-claim-chain.js";
import { createTestnetFaucetChain } from "./integrations/bsc/testnet-faucet-chain.js";
import type { TestnetFaucetChain } from "./features/testnet-faucet/testnet-faucet-contract.js";
import {
  createTestnetFaucetService,
  type TestnetFaucetService,
} from "./features/testnet-faucet/testnet-faucet-service.js";
import { registerV2TestnetFaucetRoutes } from "./routes/v2/testnet-faucet.js";
import { registerV2SquareRoutes } from "./routes/v2/square.js";
import { createSquareService } from "./features/square/square-service.js";
import { createAdminSquarePostService } from "./features/admin/admin-square-posts.js";
import { createMemePoolPriceReaders } from "./features/meme/meme-pool-price.js";
import {
  createMemeContractAdapter,
  type MemeContractAdapter,
} from "./integrations/meme/meme-contract-adapter.js";

const localCloudflaredProxyCidrs = ["127.0.0.0/8", "::1/128"];
const defaultContentSecurityPolicy =
  "default-src 'self';base-uri 'self';font-src 'self' https: data:;form-action 'self';frame-ancestors 'self';img-src 'self' data:;object-src 'none';script-src 'self';script-src-attr 'none';style-src 'self' https: 'unsafe-inline';upgrade-insecure-requests";

function applyFrameworkSecurityHeaders(
  reply: FastifyReply,
  requestId: string,
): void {
  const headers = {
    "cache-control": "no-store",
    "content-security-policy": defaultContentSecurityPolicy,
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "origin-agent-cluster": "?1",
    "referrer-policy": "no-referrer",
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "x-content-type-options": "nosniff",
    "x-dns-prefetch-control": "off",
    "x-download-options": "noopen",
    "x-frame-options": "SAMEORIGIN",
    "x-permitted-cross-domain-policies": "none",
    "x-request-id": requestId,
    "x-xss-protection": "0",
  } as const;
  for (const [name, value] of Object.entries(headers)) {
    reply.raw.setHeader(name, value);
  }
}

function sendFrameworkJson(
  reply: FastifyReply,
  statusCode: number,
  payload: unknown,
  contentType = "application/json",
): void {
  const body = JSON.stringify(payload);
  reply.raw.statusCode = statusCode;
  reply.raw.setHeader("content-type", contentType);
  reply.raw.setHeader("content-length", Buffer.byteLength(body));
  reply.raw.end(body);
}

export interface BuildAppOptions {
  readonly config: AppConfig;
  readonly contractSurface?: "runtime" | "v1" | "v2" | "admin" | "public";
  readonly database?: Database;
  /** Decision 0102: test seam for the console's MEME pause signer. */
  readonly memePauseSender?: MemePauseSender | null;
  /** Decision 0102: test seam for the console clock and login throttle. */
  readonly adminNow?: () => Date;
  /** Decision 0108: test seam for the read-only BSC Testnet Hooks Factory. */
  readonly hooksLaunchFactoryReader?: HooksLaunchFactoryReader;
  readonly privyAccessTokenVerifier?: PrivyAccessTokenVerifier;
  readonly privyUserReader?: PrivyUserReader;
  readonly streamTokenIssuer?: StreamTokenIssuer;
  readonly streamGroupMemberGateway?: StreamGroupMemberGateway;
  readonly streamChannelGateway?: StreamChannelGateway;
  readonly publicAliasSearchService?: PublicAliasSearchService;
  readonly chatGroupAliasService?: ChatGroupAliasService;
  readonly socialService?: SocialService;
  readonly chatChannelService?: ChatChannelService;
  readonly perpWalletBindingResolver?: WalletBindingResolver;
  readonly hyperliquidPrivateReader?: HyperliquidPrivateReader;
  readonly hyperliquidPerpIntentReviewer?: HyperliquidPerpIntentReviewer;
  readonly perpMutationGate?: PerpMutationGate;
  readonly agentAuthorizationMutationGate?: AgentAuthorizationMutationGate;
  readonly profileService?: ProfileService;
  readonly profileV2Service?: ProfileV2Service;
  /** Test seams for Decision 0095. */
  readonly mediaService?: MediaService;
  readonly publicProfileService?: PublicProfileService;
  readonly streamUserGateway?: StreamUserGateway;
  readonly communityService?: CommunityService;
  readonly communityAiService?: CommunityAiService;
  readonly communityAiGateway?: CommunityAiGateway;
  readonly chatService?: V2ChatService;
  readonly voiceRoomService?: VoiceRoomService;
  readonly streamCommunityChannelGateway?: StreamCommunityChannelGateway;
  readonly streamCallGateway?: StreamCallGateway;
  readonly watchlistService?: WatchlistService;
  readonly alertService?: AlertService;
  readonly spotMarketService?: SpotMarketService;
  readonly spotIntentService?: SpotIntentService;
  readonly spotWalletBindingService?: SpotWalletBindingService;
  readonly spotAgentAuthorizationService?: SpotAgentAuthorizationService;
  readonly v2SessionService?: V2SessionService;
  /** Test seam: the fetch the token logo proxy sends upstream (Decision 0089). */
  readonly tokenLogoFetch?: typeof fetch;
  /** Test seam: the token logo proxy's upstream timeout (Decision 0089). */
  readonly tokenLogoUpstreamTimeoutMs?: number;
  readonly bscReadClient?: BscReadClient | BscChainCallClient;
  /**
   * Test seam for the launch chain slot's client (Decision 0038). Ignored
   * while `LAUNCH_CHAIN_ID=56`, because the slot then shares the primary
   * client and publishes nothing of its own.
   */
  readonly launchChainReadClient?: BscReadClient;
  /**
   * Test seam for the Launch contract adapter (Decision 0076). Production
   * builds it from `launchContract` on the launch slot's endpoints.
   */
  readonly launchContractAdapter?: LaunchContractAdapter;
  /**
   * Test seam for the chain-verification watch (startup retry policy,
   * projection re-probe throttle, clock, and sleep). Production uses the
   * defaults in `chain-verification-watch.ts`.
   */
  readonly chainVerificationWatch?: Pick<
    CreateChainVerificationWatchInput,
    "retry" | "reprobeThrottleMs" | "monotonicMs" | "sleep"
  >;
  readonly privyWalletReader?: PrivyWalletReader;
  readonly privyBalanceReader?: PrivyBalanceReader;
  readonly chainStatusService?: ChainStatusService;
  readonly assetRegistryService?: AssetRegistryService;
  readonly walletReadService?: WalletReadService;
  /** Decision 0145 test seam; composed from the database otherwise. */
  readonly walletNetWorthHistoryService?: WalletNetWorthHistoryService;
  /** Decision 0145 test seam for the history's clock. */
  readonly walletNetWorthNow?: () => Date;
  readonly watchlistV2Service?: WatchlistV2Service;
  readonly marketPairsProvider?: MarketPairsProvider | null;
  readonly securityFactsProvider?: SecurityFactsProvider | null;
  readonly candlesProvider?: CandlesProvider | null;
  /** Unregistered-address lookup Provider (Decision 0058); `null` disables the GeckoTerminal path. */
  readonly tokenLookupProvider?: TokenLookupProvider | null;
  readonly marketFactService?: MarketFactService;
  readonly marketReadService?: MarketReadService;
  readonly alertV2Service?: AlertV2Service;
  readonly notificationService?: NotificationService;
  /** Test seams for the wallet-intent runtime (Decision 0035). */
  readonly privySwapAdapter?: PrivySwapAdapter;
  readonly walletIntentService?: WalletIntentService;
  readonly sendService?: SendService;
  readonly approvalService?: ApprovalService;
  readonly swapService?: SwapService;
  readonly walletIntentNow?: () => Date;
  /** Test seams for the S7 runtimes (Decision 0036). */
  readonly launchService?: LaunchService;
  readonly miningService?: MiningService;
  readonly referralService?: ReferralService;
  /** Test seams for the MEME launchpad (Decision 0101). */
  readonly memeService?: MemeService;
  readonly memeContractAdapter?: MemeContractAdapter;
  /** Test seams for the MEME v2 read model (Decision 0114). */
  readonly launch2Service?: Launch2Service;
  /** Decision 0147: test seams of the public MEME surface's rate limiter. */
  readonly publicMeme?: {
    readonly nowMs?: () => number;
    readonly ratePerWindow?: number;
    /** S207: per-read time budgets (ms). */
    readonly budgetsMs?: PublicMemeRouteOptions["budgetsMs"];
  };
  readonly launch2Chain?: Launch2Chain | null;
  /** Decision 0124: test seam for the official-pool router reader. */
  readonly launch2PoolChain?: Launch2PoolChain | null;
  /** Decision 0131: test seam for the LoopDynamic (LoopRouter) reader. */
  readonly launch2DynamicChain?: Launch2DynamicChain | null;
  /** Decision 0116 seams: the LoopRewardClaim reader and the rewards service. */
  readonly miningClaimChain?: MiningClaimChain | null;
  readonly miningRewardsService?: MiningRewardsService;
  /** Decision 0128 seams: the faucet operator chain and the faucet service. */
  readonly testnetFaucetChain?: TestnetFaucetChain | null;
  readonly testnetFaucetService?: TestnetFaucetService;
  /** Test seams for the D20 modules (Decision 0037). */
  readonly deviceService?: DeviceService;
  /** Test seam for the push channel (Decision 0067); `null` keeps it closed. */
  readonly fcmSender?: FcmSender | null;
  readonly pushTokenService?: PushTokenService;
  readonly pushDispatchService?: PushDispatchService;
  readonly securityService?: SecurityService;
  readonly settingsService?: SettingsService;
  readonly supportService?: SupportService;
  readonly securityNow?: () => Date;
  readonly logger?: FastifyServerOptions["logger"];
}

function createUnavailableStreamTokenService(): StreamTokenService {
  return Object.freeze({
    issueToken: () => Promise.reject(new StreamTokenUnavailableError()),
  });
}

function classifyRequestError(error: unknown): {
  readonly code: string | undefined;
  readonly hasValidation: boolean;
  readonly statusCode: number | undefined;
} {
  if (typeof error !== "object" || error === null) {
    return { code: undefined, hasValidation: false, statusCode: undefined };
  }

  const code =
    "code" in error && typeof error.code === "string" ? error.code : undefined;
  const statusCode =
    "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode
      : undefined;
  const hasValidation = "validation" in error && error.validation !== undefined;
  return { code, hasValidation, statusCode };
}

function loggerOptions(
  config: AppConfig,
): NonNullable<FastifyServerOptions["logger"]> {
  if (config.nodeEnv === "test" || config.logLevel === "silent") {
    return false;
  }

  return {
    level: config.logLevel,
    redact: {
      censor: "[REDACTED]",
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        'req.headers["x-csrf-token"]',
        'res.headers["set-cookie"]',
        "appSecret",
        "privy.appSecret",
        "config.privy.appSecret",
        "PRIVY_APP_SECRET",
        "apiSecret",
        "stream.apiSecret",
        "config.stream.apiSecret",
        "STREAM_API_SECRET",
        "hmacSecret",
        "streamTokenQuota.hmacSecret",
        "config.streamTokenQuota.hmacSecret",
        "STREAM_TOKEN_QUOTA_HMAC_SECRET",
        "social.cursorHmacSecret",
        "config.social.cursorHmacSecret",
        "SOCIAL_CURSOR_HMAC_SECRET",
        "social.quotaHmacSecret",
        "config.social.quotaHmacSecret",
        "SOCIAL_QUOTA_HMAC_SECRET",
        "perpReadCursor.hmacSecret",
        "config.perpReadCursor.hmacSecret",
        "PERP_READ_CURSOR_HMAC_SECRET",
        "v2Cursor.hmacSecret",
        "config.v2Cursor.hmacSecret",
        "V2_CURSOR_HMAC_SECRET",
        "quotaHmacSecret",
        "hyperliquidPrivateReads.quotaHmacSecret",
        "config.hyperliquidPrivateReads.quotaHmacSecret",
        "HYPERLIQUID_INFO_QUOTA_HMAC_SECRET",
        "req.body.signature",
        "req.body.authorizationSignature",
        "req.body.authorization_signature",
        "req.body.typed_data_json",
        "req.body.typedDataJson",
        "authorization_signature",
        "official_formatter_envelope_bytes_base64",
        "formatted_payload_bytes",
        "wallet_api_payload",
        "signing_request",
        "typed_data_json",
        "typedDataJson",
      ],
    },
    ...(config.nodeEnv === "development"
      ? {
          transport: {
            target: "pino-pretty",
            options: { colorize: true, singleLine: true },
          },
        }
      : {}),
  };
}

function markNullableBodiesOptional<T>(document: T): T {
  const paths = (document as { paths?: Record<string, unknown> }).paths;
  if (paths === undefined) {
    return document;
  }
  for (const operations of Object.values(paths)) {
    if (typeof operations !== "object" || operations === null) {
      continue;
    }
    for (const operation of Object.values(operations)) {
      const requestBody = (
        operation as {
          requestBody?: {
            required?: boolean;
            content?: Record<string, { schema?: { anyOf?: unknown[] } }>;
          };
        } | null
      )?.requestBody;
      const anyOf = requestBody?.content?.["application/json"]?.schema?.anyOf;
      if (
        requestBody !== undefined &&
        Array.isArray(anyOf) &&
        anyOf.some(
          (branch) =>
            typeof branch === "object" &&
            branch !== null &&
            (branch as { type?: unknown }).type === "null",
        )
      ) {
        requestBody.required = false;
      }
    }
  }
  return document;
}

export async function buildApp(
  options: BuildAppOptions,
): Promise<FastifyInstance> {
  const { config } = options;
  const contractSurface = options.contractSurface ?? "runtime";
  const includeV1 = contractSurface === "runtime" || contractSurface === "v1";
  const includeV2 = contractSurface === "runtime" || contractSurface === "v2";
  // Decision 0147: the public MEME page read surface has its own artifact
  // (the V1 artifact is frozen byte-for-byte).
  const includePublic =
    contractSurface === "runtime" || contractSurface === "public";
  // Decision 0102: the console mounts only with all three ADMIN_* values.
  const adminMounted =
    (contractSurface === "runtime" || contractSurface === "admin") &&
    config.admin !== null;
  const fastifyOptions: FastifyServerOptions = {
    ajv: {
      customOptions: {
        removeAdditional: false,
      },
    },
    bodyLimit: 1_048_576,
    // Node's socket inactivity timeout (`server.timeout`). It must not be
    // shorter than `handlerTimeout`, `requestTimeout`, and the request abort
    // deadline below: a handler still inside its 15 s budget would otherwise
    // have its socket closed under it at 10 s, and the client would see
    // "other side closed" instead of the sanitized 503 the handler deadline
    // produces (S76b: the Community AI overview died this way on device).
    connectionTimeout: 15_000,
    exposeHeadRoutes: false,
    frameworkErrors(error, request, reply): void {
      if (adminMounted && isAdminRequestPath(request.raw.url)) {
        const projection = projectAdminError(error, request.id);
        applyFrameworkSecurityHeaders(reply, request.id);
        sendFrameworkJson(
          reply,
          projection.statusCode,
          projection.response,
          "application/json; charset=utf-8",
        );
        return;
      }
      if (isV2RequestPath(request.raw.url)) {
        const projection = projectV2Error(error, request.id);
        request.log.warn(
          {
            requestId: request.id,
            responseCode: projection.response.code,
            statusCode: projection.statusCode,
          },
          "Framework request failed",
        );
        applyFrameworkSecurityHeaders(reply, request.id);
        sendFrameworkJson(
          reply,
          projection.statusCode,
          projection.response,
          "application/json; charset=utf-8",
        );
        return;
      }

      if (error.code === "FST_ERR_BAD_URL") {
        sendFrameworkJson(reply, 400, {
          error: "Bad Request",
          code: error.code,
          message: error.message,
          statusCode: 400,
        });
        return;
      }

      if (error.code === "FST_ERR_MAX_PARAM_LENGTH") {
        sendFrameworkJson(reply, 414, {
          error: "Bad Request",
          code: error.code,
          message: error.message,
          statusCode: 414,
        });
        return;
      }

      sendFrameworkJson(reply, 500, {
        error: "Internal Server Error",
        message: "Unexpected error from async constraint",
        statusCode: 500,
      });
    },
    genReqId: () => randomUUID(),
    handlerTimeout: 15_000,
    keepAliveTimeout: 72_000,
    logController: new LogController({ disableRequestLogging: true }),
    logger: options.logger ?? loggerOptions(config),
    requestIdHeader: false,
    requestTimeout: 15_000,
    trustProxy: config.trustProxy ? localCloudflaredProxyCidrs : false,
  };
  const app = Fastify(fastifyOptions);

  // A body-less POST/PUT/DELETE that crosses an HTTP/2 proxy (Cloudflare
  // Tunnel, an ALB) reaches the origin as a chunked stream with neither
  // Content-Type nor Content-Length. Fastify would reject it as an unsupported
  // media type before any route hook runs, which broke every V2 command that
  // deliberately carries no body (session bootstrap, logout, ...). Accept only
  // an EMPTY payload for unknown or missing media types and leave
  // `request.body` undefined so the existing "no body" route checks still
  // apply; a non-empty payload keeps failing exactly as before.
  app.addContentTypeParser(
    "*",
    { parseAs: "buffer" },
    (request, payload: Buffer, done) => {
      if (payload.length === 0) {
        done(null, undefined);
        return;
      }
      done(
        new fastifyErrorCodes.FST_ERR_CTP_INVALID_MEDIA_TYPE(
          request.headers["content-type"] ?? "undefined",
        ),
        undefined,
      );
    },
  );

  // Must be the first onRequest hook: every later hook, handler, and gateway
  // reads the replacement `request.signal` it installs.
  registerRequestAbortSignal(app, requestAbortDeadlineMilliseconds);

  app.addHook("onRequest", (request, _reply, done) => {
    request.log.info(
      {
        requestId: request.id,
        method: request.method,
        route: request.routeOptions.url,
      },
      "Request received",
    );
    done();
  });

  app.addHook("onResponse", (request, reply, done) => {
    request.log.info(
      {
        requestId: request.id,
        method: request.method,
        route: request.routeOptions.url,
        statusCode: reply.statusCode,
        responseTimeMs: reply.elapsedTime,
      },
      "Request completed",
    );
    done();
  });

  const v1OpenApiTags = [
    { name: "health", description: "Process and dependency health" },
    {
      name: "identity",
      description: "Authenticated internal identity bootstrap",
    },
    {
      name: "communication",
      description:
        "Authenticated Stream Chat and Video token issuance plus LOOP group-persona coordination",
    },
    {
      name: "discovery",
      description: "Opt-in public Profile alias discovery",
    },
    {
      name: "social",
      description:
        "Owner-bound social privacy, explicit friend requests, and accepted-friend lists",
    },
    {
      name: "profile",
      description: "Owner-bound Profile and privacy preferences",
    },
    {
      name: "watchlist",
      description: "Owner-bound grouped Watchlist preferences",
    },
    {
      name: "alerts",
      description:
        "Owner-bound inactive alert definitions, preferences, and real history",
    },
    {
      name: "perp",
      description:
        "Authenticated Hyperliquid Testnet Core perpetual interfaces",
    },
    {
      name: "spot",
      description:
        "Authenticated Hyperliquid Testnet Spot interfaces; provider capabilities remain default-closed",
    },
    {
      name: "transfer",
      description:
        "Authenticated Privy same-chain transfer interfaces; capability remains unavailable",
    },
  ] as const;
  const v2OpenApiTags = [
    { name: "health", description: "Process and dependency health" },
    {
      name: "meta",
      description: "Versioned client policy and capability projections",
    },
    {
      name: "identity",
      description: "Privy-authenticated LOOP account and device sessions",
    },
    {
      name: "profile",
      description:
        "Server-assigned LOOP ID, owner-bound profile, preset avatars, and V2 privacy preferences",
    },
    {
      name: "chain",
      description:
        "BSC read freshness and the on-chain-verified Asset Registry; every fact carries the block it was observed at",
    },
    {
      name: "wallet",
      description:
        "Read-only Privy wallet inventory, snapshot balances, indexed activity, and receive details",
    },
    {
      name: "watchlist",
      description:
        "Owner-bound grouped V2 Watchlist keyed by canonical asset IDs",
    },
    {
      name: "market",
      description:
        "Provider and indexer market facts with source, fetch time, TTL, and quality on every value",
    },
    {
      name: "notifications",
      description:
        "V2 price alerts, the context notification feed, and ten-category preferences; push delivery stays unavailable",
    },
    {
      name: "wallet-intents",
      description:
        "Immutable send/approve/revoke intents with server-built unsigned transactions, device broadcast reports, and one status surface for every funds action",
    },
    {
      name: "swap",
      description:
        "Privy Swap quote, immutable swap intent, and single-attempt execute with the device authorization signature; evidence pending",
    },
    {
      name: "approvals",
      description:
        "ERC-20 allowance inventory from indexed Approval events with live allowance() reads",
    },
  ] as const;
  const publicOpenApiTags = [
    { name: "health", description: "Process and dependency health" },
    {
      name: "public",
      description:
        "Decision 0147: unauthenticated, cross-origin read-only MEME page facts (no wallet, user, or viewer field)",
    },
  ] as const;
  const runtimeOpenApiTags = [
    ...v1OpenApiTags,
    v2OpenApiTags[1],
    publicOpenApiTags[1],
  ] as const;

  const adminOpenApiTags = [
    { name: "admin-session", description: "Operator login and logout" },
    { name: "admin-overview", description: "Console landing figures" },
    {
      name: "admin-settings",
      description:
        "Recommended communities and intel promotion cards (database first, constant fallback)",
    },
    {
      name: "admin-communities",
      description: "Community application review",
    },
    { name: "admin-mining", description: "Mining formula versions" },
    { name: "admin-meme", description: "MEME listing and curve pause" },
    {
      name: "admin-chain-guard",
      description:
        "Chain guard incidents (Decision 0134): USD1 pause / freeze / upgrade, v4 protocol fee, signer balances",
    },
    { name: "admin-audit", description: "Append-only console audit log" },
    {
      name: "admin-accounts",
      description:
        "Console accounts and roles (Decision 0109): platform_admin, reviewer, testnet_acceptor, auditor",
    },
    {
      name: "admin-launch",
      description:
        "Hooks launch review (Decision 0109): stage list, detail, reviewer approval, testnet acceptance",
    },
  ] as const;

  await app.register(swagger, {
    hideUntagged: true,
    // @fastify/swagger marks every request body required. A body schema
    // that admits `null` is the optional-body contract (Decision 0098), so
    // that operation's requestBody is published as not required.
    transformObject: (document) =>
      "openapiObject" in document
        ? markNullableBodiesOptional(document.openapiObject)
        : document.swaggerObject,
    openapi: {
      openapi: "3.1.0",
      info:
        contractSurface === "admin"
          ? {
              title: "LOOP Admin API",
              description:
                "Operator console management surface (Decisions 0102, 0109). Mounted only when ADMIN_USERNAME, ADMIN_PASSWORD_HASH, and ADMIN_SESSION_SECRET are configured; every route except POST /admin/v1/session needs the loop_admin_session cookie. Decision 0109: individual accounts with one role each (platform_admin, reviewer, testnet_acceptor, auditor); every protected route checks the role's permission server-side (403 PERMISSION_DENIED); the ADMIN_USERNAME bootstrap administrator is a platform_admin and cannot approve or accept.",
              version: config.serviceVersion,
            }
          : contractSurface === "public"
            ? {
                title: "LOOP Public API",
                description:
                  "Decision 0147: unauthenticated, cross-origin, read-only facts for the public MEME web page. No Bearer token, no contract headers; Access-Control-Allow-Origin: * and Cache-Control: public, max-age=15 on a 200; per-IP rate limit; failures are { code, reasonCode }.",
                version: config.serviceVersion,
              }
            : {
                title: "LOOP API",
                description:
                  "Private Backend-for-Frontend for LOOP. Provider routes fail closed until configured and verified.",
                version: config.serviceVersion,
              },
      servers: [{ url: config.publicBaseUrl.replace(/\/$/, "") }],
      tags:
        contractSurface === "v1"
          ? [...v1OpenApiTags]
          : contractSurface === "v2"
            ? [...v2OpenApiTags]
            : contractSurface === "admin"
              ? [...adminOpenApiTags]
              : contractSurface === "public"
                ? [...publicOpenApiTags]
                : [...runtimeOpenApiTags],
      components: {
        securitySchemes: {
          ...(contractSurface === "admin" || contractSurface === "public"
            ? {}
            : {
                privyBearer: {
                  type: "http",
                  scheme: "bearer",
                  bearerFormat: "JWT",
                  description: "Current Privy access token",
                },
              }),
          ...(contractSurface === "admin" || contractSurface === "runtime"
            ? {
                adminSession: {
                  type: "apiKey",
                  in: "cookie",
                  name: adminSessionCookieName,
                  description:
                    "Signed operator session cookie from POST /admin/v1/session (HttpOnly, SameSite=Strict, 12 hours)",
                },
              }
            : {}),
        },
      },
    },
  });

  await app.register(helmet);

  const privyServerClient =
    config.privy === null ? null : createPrivyServerClient(config.privy);
  const privyAccessTokenVerifier =
    options.privyAccessTokenVerifier ??
    (config.privy === null || privyServerClient === null
      ? createUnavailablePrivyAccessTokenVerifier()
      : createPrivyAccessTokenVerifierWithClient(
          config.privy,
          privyServerClient,
        ));
  const privyUserReader =
    options.privyUserReader ??
    (privyServerClient === null
      ? createUnavailablePrivyUserReader()
      : createPrivyUserReader(privyServerClient.users()));
  const database = options.database ?? createPostgresDatabase(config, app.log);
  // Decision 0102: operator overrides read "database first, constant second".
  const adminSettingsReader = createAdminSettingsReader({
    repository: database.admin ?? null,
    logger: app.log,
    imageHosts: config.intelPromotionImageHosts,
  });
  const authenticationService = createAuthenticationService(
    privyAccessTokenVerifier,
    database.internalUsers,
    { deviceSessions: database.deviceSessions },
  );
  const authenticationHooks = registerAuthenticationHooks(
    app,
    authenticationService,
  );
  const bootstrapService = createBootstrapService(database.internalUsers);
  const registeredModuleIds = registeredV2ModuleIds(config);
  // Decision 0089: every published logo URL is this API's own proxy route,
  // which the `market` module registers. Without it nothing is published.
  const tokenLogos = createTokenLogoProjector({
    publicBaseUrl: registeredModuleIds.includes("market")
      ? config.publicBaseUrl
      : null,
    urlMode: config.tokenLogoUrlMode,
  });
  const v2SessionRuntimeAvailable =
    config.v2SessionEnabled && config.privy !== null;
  const streamTokenIssuer =
    options.streamTokenIssuer ??
    (config.stream === null || config.streamTokenQuota === null
      ? createUnavailableStreamTokenIssuer()
      : createStreamTokenIssuer(config.stream));
  const streamTokenService =
    config.streamTokenQuota === null
      ? createUnavailableStreamTokenService()
      : createStreamTokenService({
          issuer: streamTokenIssuer,
          quota: database.controlPlane,
          quotaHmacSecret: new TextEncoder().encode(
            config.streamTokenQuota.hmacSecret,
          ),
          policy: {
            policyVersion: config.streamTokenQuota.policyVersion,
            quotaByProduct: {
              chat: {
                user: {
                  capacity: config.streamTokenQuota.userCapacity,
                  windowDurationSeconds:
                    config.streamTokenQuota.windowDurationSeconds,
                },
                ip: {
                  capacity: config.streamTokenQuota.ipCapacity,
                  windowDurationSeconds:
                    config.streamTokenQuota.windowDurationSeconds,
                },
              },
              video: {
                user: {
                  capacity: config.streamTokenQuota.userCapacity,
                  windowDurationSeconds:
                    config.streamTokenQuota.windowDurationSeconds,
                },
                ip: {
                  capacity: config.streamTokenQuota.ipCapacity,
                  windowDurationSeconds:
                    config.streamTokenQuota.windowDurationSeconds,
                },
              },
            },
          },
        });
  const aliasDirectory =
    database.aliasDirectory ?? createUnavailableAliasDirectoryRepository();
  const aliasSearchQuota =
    config.streamTokenQuota === null
      ? createUnavailableAliasSearchQuota()
      : createAliasSearchQuota({
          repository: database.controlPlane,
          hmacSecret: new TextEncoder().encode(
            config.streamTokenQuota.hmacSecret,
          ),
        });
  const publicAliasSearchService =
    options.publicAliasSearchService ??
    createPublicAliasSearchService({
      repository: aliasDirectory,
      quota: aliasSearchQuota,
    });
  const streamGroupMemberGateway =
    options.streamGroupMemberGateway ??
    (config.stream === null
      ? createUnavailableStreamGroupMemberGateway()
      : createStreamGroupMemberGateway(config.stream));
  const chatGroupAliasService =
    options.chatGroupAliasService ??
    createChatGroupAliasService({
      repository: aliasDirectory,
      gateway: streamGroupMemberGateway,
      quota: aliasSearchQuota,
    });
  const socialRepository =
    database.social ?? createUnavailableSocialRepository();
  const socialService =
    options.socialService ??
    (config.social === null
      ? createUnavailableSocialService()
      : createSocialService({
          repository: socialRepository,
          searchQuota: aliasSearchQuota,
          mutationQuota: createSocialMutationQuota({
            repository: database.controlPlane,
            hmacSecret: new TextEncoder().encode(config.social.quotaHmacSecret),
          }),
          cursorCodec: createSocialCursorCodec({
            secret: new TextEncoder().encode(config.social.cursorHmacSecret),
            ttlSeconds: config.social.cursorTtlSeconds,
          }),
        }));
  // Decision 0095: every server-side Stream user upsert carries the real
  // `{id, name, image}` read from PostgreSQL, because Stream replaces the
  // whole user on upsert.
  const streamUserIdentitySource =
    database.streamUserIdentities === undefined
      ? null
      : createStreamUserIdentitySource({
          repository: database.streamUserIdentities,
          publicBaseUrl: config.publicBaseUrl,
        });
  const streamGatewayIdentity = { identities: streamUserIdentitySource };
  const streamUserGateway =
    options.streamUserGateway ??
    (config.stream === null ? null : createStreamUserGateway(config.stream));
  const streamUserSync =
    streamUserIdentitySource === null || streamUserGateway === null
      ? null
      : createStreamUserSync({
          identities: streamUserIdentitySource,
          gateway: streamUserGateway,
          logger: app.log,
        });
  const streamChannelGateway =
    options.streamChannelGateway ??
    (config.stream === null
      ? createUnavailableStreamChannelGateway()
      : createStreamChannelGateway(config.stream, streamGatewayIdentity));
  const chatChannelService =
    options.chatChannelService ??
    (database.chatChannels === undefined ||
    (config.stream === null && options.streamChannelGateway === undefined)
      ? createUnavailableChatChannelService()
      : createChatChannelService({
          repository:
            database.chatChannels ?? createUnavailableChatChannelRepository(),
          gateway: streamChannelGateway,
        }));
  const walletBindingResolver =
    options.perpWalletBindingResolver ??
    (config.privy === null
      ? createUnavailableWalletBindingResolver()
      : createPerpWalletBindingResolver({
          repository: database.perpWalletBindings,
          userReader: privyUserReader,
        }));
  const perpWalletBindingService = createPerpWalletBindingService({
    repository: database.perpWalletBindings,
    userReader: privyUserReader,
  });
  const hyperliquidPrivateReader =
    options.hyperliquidPrivateReader ??
    (config.hyperliquidPrivateReads === null
      ? createUnavailableHyperliquidPrivateReader()
      : createHyperliquidInfoPrivateReader({
          quota: createPostgresHyperliquidInfoQuota({
            repository: database.controlPlane,
            quotaHmacSecret: new TextEncoder().encode(
              config.hyperliquidPrivateReads.quotaHmacSecret,
            ),
            policy: config.hyperliquidPrivateReads,
          }),
          transport: createLosslessHyperliquidInfoTransport(),
        }));
  const perpPrivateReadCursorCodec =
    config.perpReadCursor === null
      ? null
      : createPerpPrivateReadCursorCodec({
          secret: new TextEncoder().encode(config.perpReadCursor.hmacSecret),
          ttlSeconds: config.perpReadCursor.ttlSeconds,
        });
  const perpPrivateReadService = createPerpPrivateReadService({
    bindingResolver: walletBindingResolver,
    cursorCodec: perpPrivateReadCursorCodec,
    reader: hyperliquidPrivateReader,
  });
  const perpIntentService = createPerpIntentService({
    repository: database.perpIntents,
    bindingResolver: walletBindingResolver,
    reviewer:
      options.hyperliquidPerpIntentReviewer ??
      createUnavailableHyperliquidPerpIntentReviewer(),
    ...(options.perpMutationGate === undefined
      ? {}
      : { mutationGate: options.perpMutationGate }),
  });
  const agentAuthorizationService = createAgentAuthorizationService({
    repository: database.agentAuthorizations,
    ...(options.agentAuthorizationMutationGate === undefined
      ? {}
      : { mutationGate: options.agentAuthorizationMutationGate }),
  });
  const transferService = createUnavailableTransferService();
  const profileService =
    options.profileService ?? createProfileService(database.profiles);
  const profileV2RuntimeAvailable =
    registeredV2ModuleIds(config).includes("profile") &&
    (options.profileV2Service !== undefined ||
      database.profilesV2 !== undefined);
  // Decision 0095: uploaded media behind the MediaStorage port, rate
  // limited with the alias-search HMAC secret; without either it fails
  // closed and `avatarUpload` stays unavailable.
  const mediaStorageComposed = database.media !== undefined;
  const mediaService =
    options.mediaService ??
    createMediaService({
      storage: database.media ?? createUnavailableMediaStorage(),
      quota:
        config.streamTokenQuota === null
          ? createUnavailableMediaUploadQuota()
          : createMediaUploadQuota({
              repository: database.controlPlane,
              hmacSecret: new TextEncoder().encode(
                config.streamTokenQuota.hmacSecret,
              ),
            }),
    });
  const avatarUploadRuntimeAvailable =
    profileV2RuntimeAvailable &&
    (options.mediaService !== undefined ||
      (mediaStorageComposed && config.streamTokenQuota !== null));
  const profileV2Service =
    options.profileV2Service ??
    createProfileV2Service({
      repository: database.profilesV2 ?? createUnavailableProfileV2Repository(),
      aliasPolicy: createAliasPolicy({
        blockedTerms: config.v2AliasBlockedTerms,
      }),
      media:
        options.mediaService !== undefined || mediaStorageComposed
          ? mediaService
          : null,
      streamUsers: streamUserSync,
    });
  const v2CursorCodec =
    config.v2Cursor === null
      ? null
      : createV2CursorCodec({
          secret: new TextEncoder().encode(config.v2Cursor.hmacSecret),
          ttlSeconds: config.v2Cursor.ttlSeconds,
        });
  const communityRepositoryComposed =
    options.communityService !== undefined || database.community !== undefined;
  const communityRuntimeAvailable =
    registeredV2ModuleIds(config).includes("community") &&
    communityRepositoryComposed &&
    v2CursorCodec !== null;
  const searchRuntimeAvailable =
    registeredV2ModuleIds(config).includes("search") &&
    communityRepositoryComposed &&
    v2CursorCodec !== null &&
    config.streamTokenQuota !== null;
  const streamCommunityChannelGateway =
    options.streamCommunityChannelGateway ??
    (config.stream === null
      ? createUnavailableStreamCommunityChannelGateway()
      : createStreamCommunityChannelGateway(
          config.stream,
          streamGatewayIdentity,
        ));
  // Decision 0047: the presence reader exists only when a Stream gateway
  // that can answer exists; otherwise `onlineCount` and the capability
  // report STREAM_PRESENCE_NOT_CONNECTED rather than a zero.
  const communityPresenceReaderComposed =
    config.stream !== null ||
    options.streamCommunityChannelGateway !== undefined;
  const chainRegistryRepository =
    database.chainRegistry ?? createUnavailableChainRegistryRepository();
  const communityService =
    options.communityService ??
    createCommunityService({
      repository: database.community ?? createUnavailableCommunityRepository(),
      tokenLogos,
      communicationRepository: database.communication ?? null,
      // Decision 0071: `search?domain=assets` reads the composed Asset
      // Registry; without one the domain stays unavailable.
      assetRegistry:
        database.chainRegistry === undefined
          ? null
          : {
              listReadableAssets: () =>
                chainRegistryRepository.listReadableAssets(bscChainId),
            },
      presence: communityPresenceReaderComposed
        ? createCommunityPresenceReader({
            gateway: streamCommunityChannelGateway,
          })
        : null,
      // Decision 0043: community, member, and connection Mining Power read
      // the latest snapshot through the mining repository when the module
      // is registered; otherwise they stay unavailable.
      miningPower:
        registeredV2ModuleIds(config).includes("mining") &&
        database.mining !== undefined
          ? createMiningPowerReader({ repository: database.mining })
          : null,
      cursorCodec: v2CursorCodec,
      searchQuota: aliasSearchQuota,
      aliasPolicy: createAliasPolicy({
        blockedTerms: config.v2AliasBlockedTerms,
      }),
      realIdentity: config.communityChatRealIdentity,
    });
  const streamCallGateway =
    options.streamCallGateway ??
    (config.stream === null
      ? createUnavailableStreamCallGateway()
      : createStreamCallGateway(config.stream, streamGatewayIdentity));
  const communicationRepositoryComposed =
    options.chatService !== undefined ||
    options.voiceRoomService !== undefined ||
    database.communication !== undefined;
  const communicationRuntimeAvailable =
    registeredV2ModuleIds(config).includes("communication") &&
    communicationRepositoryComposed &&
    communityRuntimeAvailable &&
    (config.stream !== null ||
      options.streamCallGateway !== undefined ||
      options.streamCommunityChannelGateway !== undefined);
  const communityPresenceRuntimeAvailable =
    communityPresenceReaderComposed && communicationRuntimeAvailable;
  const communicationRepository =
    database.communication ?? createUnavailableCommunicationRepository();
  const chatService =
    options.chatService ??
    (communicationRuntimeAvailable
      ? createV2ChatService({
          chatChannelService,
          streamTokenService,
          repository: communicationRepository,
          channelGateway: streamCommunityChannelGateway,
          cursorCodec: v2CursorCodec,
          logger: app.log,
        })
      : createUnavailableV2ChatService());
  const securityNow = options.securityNow ?? ((): Date => new Date());

  // Push channel (Decision 0067). The Firebase credential is a file path; a
  // missing or unusable file is not fatal, it only keeps the capability
  // deferred. The credential is never logged, and the log line below names
  // the reason code only.
  const fcmSender = ((): FcmSender | null => {
    if (options.fcmSender !== undefined) {
      return options.fcmSender;
    }
    if (config.push === null) {
      return null;
    }
    try {
      return createFcmSender({
        account: loadFirebaseServiceAccount(config.push.serviceAccountJsonPath),
        fetch: nodeFcmFetch,
      });
    } catch (error) {
      app.log.warn(
        {
          reasonCode:
            error instanceof FirebaseServiceAccountError
              ? error.reasonCode
              : "PUSH_CREDENTIAL_FILE_UNREADABLE",
        },
        "LOOP push channel stays deferred: the Firebase service account is unusable",
      );
      return null;
    }
  })();
  const pushRepositoryComposed =
    options.pushTokenService !== undefined ||
    options.pushDispatchService !== undefined ||
    database.push !== undefined;
  const pushDispatchService =
    options.pushDispatchService ??
    (fcmSender === null
      ? createUnavailablePushDispatchService()
      : createPushDispatchService({
          repository: database.push ?? createUnavailablePushRepository(),
          sender: fcmSender,
          logger: app.log,
        }));
  /**
   * `pushNotifications` is available only when a credential, a repository and
   * the notifications module all exist. Anything missing leaves it
   * unavailable with `PUSH_RUNTIME_DEFERRED`; nothing here half-opens it.
   */
  const pushRuntimeAvailable =
    registeredModuleIds.includes("notifications") &&
    pushRepositoryComposed &&
    (options.pushDispatchService !== undefined || fcmSender !== null);
  const pushTokenService =
    options.pushTokenService ??
    createPushTokenService({
      repository: database.push ?? createUnavailablePushRepository(),
      deliveryRuntimeAvailable: pushRuntimeAvailable,
      now: securityNow,
    });

  // Composed after the push channel so a bootstrap can raise the Decision
  // 0067 `security_event` for a device this account has not signed in from
  // before.
  const v2SessionService =
    options.v2SessionService ??
    createV2SessionService({
      enabled: v2SessionRuntimeAvailable,
      sessions: database.deviceSessions,
      notifications: database.notifications ?? null,
      push: pushDispatchService,
      logger: app.log,
    });
  const voiceRoomService =
    options.voiceRoomService ??
    (communicationRuntimeAvailable
      ? createVoiceRoomService({
          repository: communicationRepository,
          callGateway: streamCallGateway,
          cursorCodec: v2CursorCodec,
          push: pushDispatchService,
          logger: app.log,
        })
      : createUnavailableVoiceRoomService());
  const watchlistService =
    options.watchlistService ??
    createWatchlistService({ repository: database.watchlists });
  const alertService =
    options.alertService ?? createAlertService({ repository: database.alerts });
  const spotMarketService =
    options.spotMarketService ?? createUnavailableSpotMarketService();
  const spotIntentService =
    options.spotIntentService ?? createUnavailableSpotIntentService();
  const spotWalletBindingService =
    options.spotWalletBindingService ??
    createUnavailableSpotWalletBindingService();
  const spotAgentAuthorizationService =
    options.spotAgentAuthorizationService ??
    createUnavailableSpotAgentAuthorizationService();

  const bscReadClient =
    options.bscReadClient ??
    (config.bscChain === null
      ? createUnavailableBscReadClient({
          confirmations: config.bscConfirmations,
          reorgDepthBlocks: config.bscReorgDepthBlocks,
        })
      : createBscReadClient({ config: config.bscChain }));
  // The launch chain slot (Decision 0038): a second read client only when
  // the slot names a different chain than primary. Without endpoints it is
  // the unavailable client with the slot's own reason code, never a crash.
  const launchChainReadClient: BscReadClient | null = config.launchChain
    .sharedWithPrimary
    ? null
    : (options.launchChainReadClient ??
      (config.launchChain.rpcUrls.length === 0
        ? createUnavailableBscReadClient({
            chainId: config.launchChain.chainId,
            chainReference: config.launchChain.chainReference,
            confirmations: config.launchChain.confirmations,
            reorgDepthBlocks: config.launchChain.reorgDepthBlocks,
            reasonCode: launchChainReasonCodes.notConfigured,
          })
        : createBscReadClient({ config: config.launchChain })));
  const bscIndexerRepository =
    database.bscIndexer ?? createUnavailableBscIndexerRepository();
  const accountWalletRepository =
    database.accountWallets ?? createUnavailableAccountWalletRepository();
  const privyWalletReader =
    options.privyWalletReader ??
    (privyServerClient === null
      ? createUnavailablePrivyWalletReader()
      : createPrivyWalletReader(privyServerClient.users()));
  const privyBalanceReader =
    options.privyBalanceReader ??
    (privyServerClient === null
      ? createUnavailablePrivyBalanceReader()
      : createPrivyBalanceReader(privyServerClient.wallets().balance));
  const assetRegistryService =
    options.assetRegistryService ??
    createAssetRegistryService({
      repository: chainRegistryRepository,
      readClient: bscReadClient,
      chainId: bscChainId,
      verifiedUsd1Address: config.bscChain?.usd1TokenAddress ?? null,
    });
  const chainStatusService =
    options.chainStatusService ??
    createChainStatusService({
      repository: chainRegistryRepository,
      indexerRepository: bscIndexerRepository,
      readClient: bscReadClient,
      chainId: bscChainId,
      chainName: "BNB Smart Chain",
      chainReference: bscChainReference,
      nativeAssetId: bscNativeAssetId,
      launchReadClient: launchChainReadClient,
    });
  const watchlistV2Service =
    options.watchlistV2Service ??
    createWatchlistV2Service({
      repository:
        database.watchlistsV2 ?? createUnavailableWatchlistV2Repository(),
      registry: chainRegistryRepository,
      chainId: bscChainId,
      tokenLogos,
    });
  const bscRpcConfigured = bscReadClient.endpointRefs.length > 0;
  const chainRuntimeAvailable =
    registeredModuleIds.includes("chain") &&
    bscRpcConfigured &&
    (options.chainStatusService !== undefined ||
      database.chainRegistry !== undefined);
  const walletRuntimeAvailable =
    registeredModuleIds.includes("wallet") &&
    (options.walletReadService !== undefined ||
      (config.privy !== null &&
        database.accountWallets !== undefined &&
        v2CursorCodec !== null));
  const watchlistRuntimeAvailable =
    registeredModuleIds.includes("watchlist") &&
    (options.watchlistV2Service !== undefined ||
      (database.watchlistsV2 !== undefined &&
        database.chainRegistry !== undefined));

  // Market Providers (Decision 0034). Each is `null` when disabled or
  // uncredentialed; the fact service then publishes its facts as unavailable.
  const providers = createMarketProviders(config.market, "api");
  const marketPairsProvider =
    options.marketPairsProvider === undefined
      ? providers.pairs
      : options.marketPairsProvider;
  const securityFactsProvider =
    options.securityFactsProvider === undefined
      ? providers.security
      : options.securityFactsProvider;
  const candlesProvider =
    options.candlesProvider === undefined
      ? providers.candles
      : options.candlesProvider;
  const marketFactCacheRepository =
    database.marketFacts ?? createUnavailableMarketFactCacheRepository();
  const tokenLookupProvider =
    options.tokenLookupProvider === undefined
      ? providers.tokenLookup
      : options.tokenLookupProvider;
  const marketFactService =
    options.marketFactService ??
    createMarketFactService({
      config: config.market,
      cache: marketFactCacheRepository,
      pairsProvider: marketPairsProvider,
      securityProvider: securityFactsProvider,
      candlesProvider,
      tokenLookupProvider,
      // Decision 0127: a GET never fails because a cache row was not stored.
      onCacheWriteFailure: (error, record) => {
        app.log.warn(
          {
            factKind: record.factKind,
            source: record.source,
            ...summarizeErrorForLog(error),
          },
          "Market fact cache write failed; serving the observed fact",
        );
      },
    });
  // Unregistered-address lookup quota (Decision 0058): the alias-search
  // secret keys the HMAC subjects; without it the lookup fails closed.
  const unlistedTokenLookupQuota =
    config.streamTokenQuota === null
      ? null
      : createUnlistedTokenLookupQuota({
          repository: database.controlPlane,
          hmacSecret: new TextEncoder().encode(
            config.streamTokenQuota.hmacSecret,
          ),
        });
  const marketRuntimeAvailable =
    registeredModuleIds.includes("market") &&
    (options.marketReadService !== undefined ||
      (database.chainRegistry !== undefined &&
        database.marketFacts !== undefined &&
        database.bscIndexer !== undefined &&
        v2CursorCodec !== null));
  const walletReadService =
    options.walletReadService ??
    createWalletReadService({
      repository: accountWalletRepository,
      indexerRepository: bscIndexerRepository,
      assetRegistry: assetRegistryService,
      readClient: bscReadClient,
      walletReader: privyWalletReader,
      balanceReader: privyBalanceReader,
      cursorCodec: v2CursorCodec,
      marketFacts:
        options.marketFactService !== undefined
          ? marketFactService
          : marketRuntimeAvailable
            ? marketFactService
            : null,
      gasReserveRawWei: BigInt(config.walletGasReserve.rawWei),
      chainId: bscChainId,
      chainName: "BNB Smart Chain",
      chainReference: bscChainReference,
      launchChainReadClient,
      launchUsd1:
        config.launchContract === null
          ? null
          : Object.freeze({
              usd1Address: config.launchContract.usd1Address,
              spender: config.launchContract.address,
            }),
      logger: app.log,
      tokenLogos,
    });
  // Decision 0145: net worth history. `current` is valued live with the
  // balances valuation (same registry, read client, and price facts).
  const netWorthMarketFacts =
    options.marketFactService !== undefined || marketRuntimeAvailable
      ? marketFactService
      : null;
  const walletNetWorthHistoryService =
    options.walletNetWorthHistoryService ??
    createWalletNetWorthHistoryService({
      wallets: accountWalletRepository,
      snapshots: database.walletNetWorthSnapshots ?? null,
      measure:
        netWorthMarketFacts === null
          ? null
          : async (wallet, signal) => {
              const assets = await assetRegistryService.listReadableAssets();
              const prices = await netWorthMarketFacts
                .readAssetPrices(assets, { signal })
                .catch((): typeof priceReadFailure => priceReadFailure);
              return measureWalletNetWorth({
                readClient: bscReadClient,
                address: wallet.address,
                assets,
                prices,
              });
            },
      fiatRates: database.fiatFxRates ?? null,
      ...(options.walletNetWorthNow === undefined
        ? {}
        : { now: options.walletNetWorthNow }),
    });
  // MEME curve adapter (Decision 0101), built before the market service so
  // `category=meme` and the MEME rows share one slot0 reader (Decision 0103).
  const memeContractAdapter =
    options.memeContractAdapter ??
    createMemeContractAdapter({
      contract: config.meme.contract,
      ...(config.meme.unconfiguredReason === null
        ? {}
        : { unconfiguredReason: config.meme.unconfiguredReason }),
      chain: config.launchChain,
      verifyChain: () => (launchChainReadClient ?? bscReadClient).verifyChain(),
      logger: app.log,
    });
  const readPoolsMany =
    memeContractAdapter.readPoolSqrtPriceX96Many?.bind(memeContractAdapter);
  const memePoolPriceReaders = createMemePoolPriceReaders({
    usd1Address: () => config.meme.contract?.usd1Address ?? null,
    readSqrtPriceX96: (pool) => memeContractAdapter.readPoolSqrtPriceX96(pool),
    ...(readPoolsMany === undefined
      ? {}
      : { readSqrtPriceX96Many: readPoolsMany }),
    cacheMs: memeRules.chainReadCacheMs,
    now: options.walletIntentNow ?? ((): Date => new Date()),
  });
  const memePoolPriceReader = memePoolPriceReaders.read;
  const marketReadService =
    options.marketReadService ??
    createMarketReadService({
      registry: chainRegistryRepository,
      facts: marketFactService,
      cache: marketFactCacheRepository,
      indexerRepository: bscIndexerRepository,
      watchlist: database.watchlistsV2 ?? null,
      categories: database.marketCategories ?? null,
      memePoolPrices: Object.freeze({
        chainId: config.launchChain.chainId,
        read: memePoolPriceReader,
        readMany: memePoolPriceReaders.readMany,
      }),
      wallets: database.accountWallets ?? null,
      readClient: bscReadClient,
      cursorCodec: v2CursorCodec,
      lookupQuota: unlistedTokenLookupQuota,
      chainId: bscChainId,
      staleGraceSeconds: config.market.staleGraceSeconds,
      tokenLogos,
    });
  const publicProfileService =
    options.publicProfileService ??
    createPublicProfileService({
      repository:
        database.publicProfiles ?? createUnavailablePublicProfileRepository(),
      walletReadService: walletRuntimeAvailable ? walletReadService : null,
      assets: chainRegistryRepository,
      cursorCodec: v2CursorCodec,
      chainId: bscChainId,
      usd1Address: config.bscChain?.usd1TokenAddress?.toLowerCase() ?? null,
      recommendedCommunityIds: config.recommendedCommunityIds,
      recommendedCommunityIdsOverride: () =>
        adminSettingsReader.recommendedCommunityIds(),
    });
  const tokenLogoProxyService = createTokenLogoProxyService({
    cache: database.tokenLogoCache ?? null,
    facts: database.marketFacts ?? null,
    ...(options.tokenLogoFetch === undefined
      ? {}
      : { fetch: options.tokenLogoFetch }),
    ...(options.tokenLogoUpstreamTimeoutMs === undefined
      ? {}
      : { upstreamTimeoutMs: options.tokenLogoUpstreamTimeoutMs }),
    logger: app.log,
  });
  const alertV2Service =
    options.alertV2Service ??
    createAlertV2Service({
      repository: database.alertsV2 ?? createUnavailableAlertV2Repository(),
      registry: chainRegistryRepository,
      facts:
        options.marketFactService !== undefined || marketRuntimeAvailable
          ? marketFactService
          : null,
      cursorCodec: v2CursorCodec,
      chainId: bscChainId,
      pushRuntimeAvailable,
    });
  const notificationService =
    options.notificationService ??
    createNotificationService({
      repository:
        database.notifications ?? createUnavailableNotificationRepository(),
      cursorCodec: v2CursorCodec,
      pushRuntimeAvailable,
    });
  const priceAlertsRuntimeAvailable =
    registeredModuleIds.includes("notifications") &&
    (options.alertV2Service !== undefined ||
      (database.alertsV2 !== undefined &&
        database.chainRegistry !== undefined &&
        v2CursorCodec !== null));
  const notificationsFeedRuntimeAvailable =
    registeredModuleIds.includes("notifications") &&
    (options.notificationService !== undefined ||
      (database.notifications !== undefined && v2CursorCodec !== null));

  // Wallet intents (Decision 0035). The runtime is composed whenever its
  // repositories exist; whether a write is admitted is decided per request
  // by BSC_WRITES_ENABLED, the canary allowlist, and live chain verification.
  const walletIntentRepositoryComposed =
    options.walletIntentService !== undefined ||
    options.sendService !== undefined ||
    options.approvalService !== undefined ||
    options.swapService !== undefined ||
    (database.walletIntents !== undefined &&
      database.accountWallets !== undefined &&
      database.chainRegistry !== undefined &&
      database.bscIndexer !== undefined);
  const walletIntentModuleEnabled =
    registeredModuleIds.includes("sendApprovals") ||
    registeredModuleIds.includes("swap");
  const walletIntentRuntimeAvailable =
    walletIntentModuleEnabled && walletIntentRepositoryComposed;
  const privySwapAdapter =
    options.privySwapAdapter ??
    (privyServerClient === null
      ? createUnavailablePrivySwapAdapter()
      : createPrivySwapAdapter(privyServerClient.wallets()));
  const privySwapRuntimeAvailable =
    options.privySwapAdapter !== undefined || config.privy !== null;
  const walletIntentRuntime: WalletIntentRuntime = Object.freeze({
    config: Object.freeze({
      bscWrites: config.bscWrites,
      privyAppId: config.privy?.appId ?? null,
      gasReserveRawWei: BigInt(config.walletGasReserve.rawWei),
    }),
    repository:
      database.walletIntents ?? createUnavailableWalletIntentRepository(),
    wallets: accountWalletRepository,
    registry: chainRegistryRepository,
    indexer: bscIndexerRepository,
    readClient: asChainCallClient(bscReadClient),
    // Decision 0077: USD1 approve/revoke towards the Launch contract runs on
    // the launch slot when it is a separate chain and the contract is set.
    launchSlot:
      launchChainReadClient === null || config.launchContract === null
        ? null
        : Object.freeze({
            chainId: launchChainReadClient.chainId,
            readClient: asChainCallClient(launchChainReadClient),
            contractAddress: config.launchContract.address,
            usd1Address: config.launchContract.usd1Address,
          }),
    controlPlane: database.controlPlane,
    marketFacts:
      options.marketFactService !== undefined || marketRuntimeAvailable
        ? marketFactService
        : null,
    swapAdapter: privySwapAdapter,
    cursorCodec: v2CursorCodec,
    now: options.walletIntentNow ?? ((): Date => new Date()),
    createUuid: randomUUID,
  });
  const walletIntentService =
    options.walletIntentService ??
    createWalletIntentService(walletIntentRuntime);
  const sendService =
    options.sendService ?? createSendService(walletIntentRuntime);
  const approvalService =
    options.approvalService ?? createApprovalService(walletIntentRuntime);
  const swapService =
    options.swapService ?? createSwapService({ runtime: walletIntentRuntime });

  // Launch, mining, and referral (Decision 0036): PostgreSQL-backed
  // catalog, formula versions, and relationship graph. The contract and
  // formula baselines stay pending; that is reported through the capability
  // evidence, not by pretending the runtime is missing.
  const launchRuntimeAvailable =
    registeredModuleIds.includes("launch") &&
    (options.launchService !== undefined ||
      (database.launch !== undefined && v2CursorCodec !== null));
  // Decision 0076: the Launch contract adapter reads through its own viem
  // client on the launch slot's endpoints and reuses that slot's chain-ID
  // verification. Unconfigured, it is unavailable(BASELINE_PENDING) and no
  // response changes.
  const launchContractAdapter =
    options.launchContractAdapter ??
    createLaunchContractAdapter({
      contract: config.launchContract,
      chain: config.launchChain,
      verifyChain: () => (launchChainReadClient ?? bscReadClient).verifyChain(),
      snapshotCacheTtlMs: config.launchSnapshotCacheTtlMs,
      logger: app.log,
    });
  const launchService =
    options.launchService ??
    (launchRuntimeAvailable
      ? createLaunchService({
          repository: database.launch ?? createUnavailableLaunchRepository(),
          cursorCodec: v2CursorCodec,
          contract: launchContractAdapter,
          chain: database.launchChain ?? null,
          wallets: database.accountWallets ?? null,
          graduatedListEnabled: config.launchGraduatedListEnabled,
          // Decision 0077: the Intent prepare reads the launch slot and
          // walks the Decision 0065 canary; BSC_WRITES_ENABLED stays the
          // only switch.
          intentRuntime:
            database.launchChain === undefined ||
            database.accountWallets === undefined
              ? null
              : Object.freeze({
                  writes: config.bscWrites,
                  readClient: asChainCallClient(
                    launchChainReadClient ?? bscReadClient,
                  ),
                  wallets: database.accountWallets,
                  walletIntentExposureUsd: (input: {
                    readonly ownerUserId: string;
                    readonly since: string;
                  }) =>
                    walletIntentRuntime.repository.sumRecentExposureUsd(input),
                  now: options.walletIntentNow ?? ((): Date => new Date()),
                  createUuid: randomUUID,
                }),
        })
      : createUnavailableLaunchService());
  if (launchRuntimeAvailable && launchContractAdapter.contract !== null) {
    void launchContractAdapter.verifyAtStartup();
  }
  // Decision 0108: Hooks launch config / signing / deployment tasks. Off by
  // default (HOOKS_LAUNCH_ENABLED); the Factory reader exists only on the
  // BSC Testnet launch slot (or 56 with the Decision 0150 ack) with a
  // configured Factory + code hash. Missing pieces leave the services
  // fail-closed (CAPABILITY_UNAVAILABLE).
  const hooksLaunchEnabled = config.hooksLaunch.enabled;
  // Decision 0150: the launch slot as the action paths see it — BSC Testnet
  // unchanged; chain 56 only with LAUNCH_MAINNET_ACK (else every Hooks /
  // launch2 path below stays closed exactly as before).
  const launchSlot: LaunchSlotPolicy = Object.freeze({
    chainReference: config.launchChain.chainReference,
    mainnetAcknowledged: config.launchChain.mainnetAcknowledged,
  });
  const launchSlotOpen = launchSlotActionsOpen(launchSlot);
  if (launchSlot.mainnetAcknowledged) {
    // One loud line per boot; no secret, no endpoint.
    app.log.warn(
      {
        reasonCode: "LAUNCH_MAINNET_ACKNOWLEDGED",
        launchChainId: config.launchChain.chainId,
      },
      "LAUNCH_MAINNET_ACKNOWLEDGED: the launch slot is BSC Mainnet with real funds (Decision 0150)",
    );
  }
  // Decision 0132 (supersedes the 0131 fail-closed stub):
  // HOOKS_LAUNCH_HOOK_KIND=loopDynamic saves, reviews and prepares / accepts
  // signatures for the LoopDynamic Factory (LAUNCH2_DYNAMIC_FACTORY_*,
  // template read and verified on chain); without that pair the reader is
  // null and every one of them stays 503 HOOKS_LAUNCH_FACTORY_UNAVAILABLE —
  // never the OfficialTax Factory.
  const hooksTargetFactory =
    config.hooksLaunch.hookKind === "loopDynamic"
      ? config.hooksLaunch.dynamicFactory
      : config.hooksLaunch.factoryAddress !== null &&
          config.hooksLaunch.factoryCodeHash !== null
        ? {
            address: config.hooksLaunch.factoryAddress,
            codeHash: config.hooksLaunch.factoryCodeHash,
          }
        : null;
  const injectedHooksFactoryReader =
    options.hooksLaunchFactoryReader === undefined
      ? undefined
      : // A reader of another Hook kind than configured is never used.
        (options.hooksLaunchFactoryReader.hookKind ?? "officialTax") ===
          config.hooksLaunch.hookKind
        ? options.hooksLaunchFactoryReader
        : null;
  const hooksFactoryReader: HooksLaunchFactoryReader | null =
    !hooksLaunchEnabled
      ? null
      : injectedHooksFactoryReader !== undefined
        ? injectedHooksFactoryReader
        : hooksTargetFactory !== null &&
            launchSlotOpen &&
            config.launchChain.rpcUrls.length > 0
          ? createHooksLaunchFactoryReader({
              factoryAddress: hooksTargetFactory.address,
              expectedRuntimeCodeHash: hooksTargetFactory.codeHash,
              rpcUrls: config.launchChain.rpcUrls,
              chainReference: config.launchChain.chainReference,
              ...(config.hooksLaunch.hookKind === "loopDynamic"
                ? { hookKind: "loopDynamic" as const }
                : {}),
            })
          : null;
  const hooksLaunchProjectConfigService = hooksLaunchEnabled
    ? createHooksLaunchProjectConfigService({
        repository: database.hooksLaunchProjectConfigs ?? null,
        factory: hooksFactoryReader,
        // Decision 0117: HOOKS_LAUNCH_MIN_SALE_LEAD_SECONDS (default 86,400).
        minimumLeadSeconds: config.hooksLaunch.minimumSaleLeadSeconds,
        // Decision 0122: LAUNCH2_BUYBACK_RECIPIENT (null fails saves closed).
        fixedBuybackRecipient: config.hooksLaunch.fixedBuybackRecipient,
      })
    : undefined;
  const hooksLaunchDeploymentService = hooksLaunchEnabled
    ? createHooksLaunchDeploymentService({
        configs: database.hooksLaunchProjectConfigs ?? null,
        wallets: database.accountWallets ?? null,
        reader: hooksFactoryReader,
        signatureLifetimeSeconds: 900,
        maxSaltAttempts: 1_000_000,
        fixedBuybackRecipient: config.hooksLaunch.fixedBuybackRecipient,
        launchSlot,
      })
    : undefined;
  const hooksLaunchSubmissionService = hooksLaunchEnabled
    ? createHooksLaunchSubmissionService({
        configs: database.hooksLaunchProjectConfigs ?? null,
        wallets: database.accountWallets ?? null,
        reader: hooksFactoryReader,
        repository: database.hooksLaunchSubmissions ?? null,
        fixedBuybackRecipient: config.hooksLaunch.fixedBuybackRecipient,
        launchSlot,
      })
    : undefined;
  const miningRuntimeAvailable =
    registeredModuleIds.includes("mining") &&
    (options.miningService !== undefined || database.mining !== undefined);
  const miningService =
    options.miningService ??
    (miningRuntimeAvailable
      ? createMiningService({
          repository: database.mining ?? createUnavailableMiningRepository(),
          registry: chainRegistryRepository,
          tokenLogos,
          cursorCodec: v2CursorCodec,
        })
      : createUnavailableMiningService());
  // Decision 0043: the `communityMining` capability reads the formula fact
  // per request; without a mining repository the probe reports unavailable.
  const miningFormulaBaseline =
    miningRuntimeAvailable && database.mining !== undefined
      ? createMiningFormulaBaselineProbe(database.mining)
      : createUnavailableMiningFormulaBaselineProbe();
  const referralRuntimeAvailable =
    registeredModuleIds.includes("referral") &&
    (options.referralService !== undefined || database.referral !== undefined);
  const referralService =
    options.referralService ??
    (referralRuntimeAvailable
      ? createReferralService({
          repository:
            database.referral ?? createUnavailableReferralRepository(),
          publicBaseUrl: config.publicBaseUrl,
          cursorCodec: v2CursorCodec,
        })
      : createUnavailableReferralService());
  // MEME curve launchpad (Decision 0101): the lane's PostgreSQL projection
  // plus block-pinned reads of the curve on the launch slot. Without the
  // four MEME_* keys and LAUNCH_USD1_ADDRESS every route is 503.
  const memeRuntimeAvailable =
    registeredModuleIds.includes("meme") &&
    (options.memeService !== undefined ||
      (database.meme !== undefined && v2CursorCodec !== null));
  const memeService =
    options.memeService ??
    (memeRuntimeAvailable && database.meme !== undefined
      ? createMemeService({
          config: config.meme,
          repository: database.meme,
          contract: memeContractAdapter,
          cursorCodec: v2CursorCodec,
          wallets: database.accountWallets ?? null,
          readClient: asChainCallClient(launchChainReadClient ?? bscReadClient),
          writes: config.bscWrites,
          publicBaseUrl: config.publicBaseUrl,
          // Graduated rows read DexScreener like `category=meme` (56 only).
          dexQuotes: async (_chainId, addresses) => {
            const facts = await marketFactService.readAssetPrices(
              addresses.map((address) => ({ address, status: "pending" })),
            );
            const quotes = new Map<
              string,
              MemeDexQuote | { readonly reasonCode: string }
            >();
            addresses.forEach((address, index) => {
              const fact = facts[index];
              const price = fact?.pair?.priceUsd ?? null;
              quotes.set(
                address,
                fact === undefined ||
                  price === null ||
                  fact.fact.fetchedAt === null
                  ? {
                      reasonCode:
                        fact?.fact.reasonCode ?? "MEME_DEX_QUOTE_UNAVAILABLE",
                    }
                  : {
                      priceUsd: price,
                      marketCapUsd: fact.pair?.marketCap ?? null,
                      observedAt: fact.fact.fetchedAt,
                    },
              );
            });
            return quotes;
          },
          poolPrices: memePoolPriceReader,
          logger: app.log,
          now: options.walletIntentNow ?? ((): Date => new Date()),
        })
      : createUnavailableMemeService());
  if (memeRuntimeAvailable && memeContractAdapter.contract !== null) {
    void memeContractAdapter.verifyAtStartup();
  }
  // MEME v2 read model (Decision 0114): the launch2_event projection plus
  // block-pinned reads of the curve / NFT on the BSC Testnet launch slot.
  // Decision 0133: launch2 is configured with the OfficialTax Factory
  // (HOOKS_LAUNCH_FACTORY_ADDRESS) **or** the LoopDynamic one
  // (LAUNCH2_DYNAMIC_FACTORY_*); only with neither is it
  // LAUNCH2_FACTORY_NOT_CONFIGURED. Anything missing keeps every
  // /v2/launch2/* route 503 with the reason.
  const launch2Registered = registeredModuleIds.includes("launch2");
  const launch2UnavailableReason: string | null =
    config.hooksLaunch.factoryAddress === null &&
    config.hooksLaunch.dynamicFactory === null
      ? "LAUNCH2_FACTORY_NOT_CONFIGURED"
      : options.launch2Chain === undefined &&
          (!launchSlotOpen || config.launchChain.rpcUrls.length === 0)
        ? "LAUNCH2_CHAIN_NOT_CONFIGURED"
        : database.launch2 === undefined
          ? "LAUNCH2_REPOSITORY_UNAVAILABLE"
          : v2CursorCodec === null
            ? "LAUNCH2_RUNTIME_UNAVAILABLE"
            : null;
  const launch2Chain: Launch2Chain | null =
    options.launch2Chain !== undefined
      ? options.launch2Chain
      : launch2Registered && launch2UnavailableReason === null
        ? createLaunch2Chain({
            rpcUrls: config.launchChain.rpcUrls,
            expectedChainId: config.launchChain.chainReference,
          })
        : null;
  // Decision 0124: the official-pool router reader exists only with the
  // router address + code hash and the launch slot endpoints; its code hash
  // is checked at startup (logged) and before every pool quote / prepare.
  const launch2PoolChain: Launch2PoolChain | null =
    options.launch2PoolChain !== undefined
      ? options.launch2PoolChain
      : launch2Registered &&
          launch2UnavailableReason === null &&
          config.launch2.poolRouter !== null &&
          launchSlotOpen &&
          config.launchChain.rpcUrls.length > 0
        ? createLaunch2PoolChain({
            rpcUrls: config.launchChain.rpcUrls,
            chainReference: config.launchChain.chainReference,
            router: config.launch2.poolRouter.address,
            expectedRuntimeCodeHash: config.launch2.poolRouter.codeHash,
          })
        : null;
  if (launch2PoolChain !== null && options.launch2PoolChain === undefined) {
    void launch2PoolChain
      .verifyRouter()
      .then((check) => {
        if (check.status === "ok") {
          app.log.info(
            { capabilityId: "launch2", router: launch2PoolChain.router },
            "launch2 official-pool router code hash verified",
          );
        } else {
          app.log.warn(
            {
              capabilityId: "launch2",
              router: launch2PoolChain.router,
              reasonCode: check.reasonCode,
            },
            "launch2 official-pool router is unavailable at startup",
          );
        }
      })
      .catch(() => {
        app.log.warn(
          {
            capabilityId: "launch2",
            reasonCode: "LAUNCH2_CHAIN_READ_FAILED",
          },
          "launch2 official-pool router check failed at startup",
        );
      });
  }
  // Decision 0131: the LoopDynamic reader exists only with the LoopRouter
  // pair on the BSC Testnet launch slot (default off).
  const launch2DynamicChain: Launch2DynamicChain | null =
    options.launch2DynamicChain !== undefined
      ? options.launch2DynamicChain
      : launch2Registered &&
          launch2UnavailableReason === null &&
          config.launch2.dynamicRouter !== null &&
          launchSlotOpen &&
          config.launchChain.rpcUrls.length > 0
        ? createLaunch2DynamicChain({
            rpcUrls: config.launchChain.rpcUrls,
            chainReference: config.launchChain.chainReference,
            router: config.launch2.dynamicRouter.address,
            expectedRuntimeCodeHash: config.launch2.dynamicRouter.codeHash,
            legacyRuntimeCodeHashes:
              config.launch2.dynamicLegacyRouterCodeHashes,
          })
        : null;
  const launch2Service =
    options.launch2Service ??
    (launch2Registered
      ? createLaunch2Service({
          repository: database.launch2 ?? null,
          chain: launch2Chain,
          readClient: asChainCallClient(launchChainReadClient ?? bscReadClient),
          wallets: database.accountWallets ?? null,
          writes: config.bscWrites,
          cursorCodec: v2CursorCodec,
          chainId: config.launchChain.chainId,
          // Decision 0150: chain 56 signs only with LAUNCH_MAINNET_ACK.
          mainnetAcknowledged: config.launchChain.mainnetAcknowledged,
          unavailableReason: launch2UnavailableReason,
          quoteTtlSeconds: config.launch2.quoteTtlSeconds,
          defaultSlippageBps: config.launch2.defaultSlippageBps,
          tradeDeadlineSeconds: config.launch2.tradeDeadlineSeconds,
          poolChain: launch2PoolChain,
          dynamicChain: launch2DynamicChain,
          dynamicRouterRegistry: config.launch2.dynamicRouterRegistry,
          // Decision 0153: an instance's router comes from its own Factory,
          // which must be one of these.
          dynamicFactories: {
            current: config.hooksLaunch.dynamicFactory?.address ?? null,
            legacy: config.launch2.dynamicLegacyFactories,
          },
          // Decision 0136: the chain guard hold refuses launch2 writes.
          chainGuardHolds:
            config.chainGuardEnabled === true &&
            database.chainGuard !== undefined
              ? createChainGuardHoldGate(
                  database.chainGuard,
                  config.launchChain.chainId,
                )
              : null,
          logger: app.log,
          now: options.walletIntentNow ?? ((): Date => new Date()),
          // Decision 0162: trader wallet → account (batched, 30 s cache).
          accounts:
            database.walletAccounts === undefined
              ? null
              : createWalletAccountDirectory({
                  lookup: database.walletAccounts,
                  onLookupError: (error) => {
                    app.log.warn(
                      {
                        err: error,
                        reasonCode: "WALLET_ACCOUNT_LOOKUP_FAILED",
                      },
                      "wallet account lookup failed; traders stay bare wallets",
                    );
                  },
                }),
        })
      : createUnavailableLaunch2Service());
  // Decision 0116: hourly settlement rewards and claims under the `mining`
  // module. The claim chain reader exists only with the LoopRewardClaim
  // address and launch slot endpoints; the voucher signer only with its key.
  const miningClaimChain: MiningClaimChain | null =
    options.miningClaimChain !== undefined
      ? options.miningClaimChain
      : registeredModuleIds.includes("mining") &&
          config.miningSettlement.claimContractAddress !== null &&
          config.launchChain.rpcUrls.length > 0
        ? createMiningRewardClaimChain({
            rpcUrls: config.launchChain.rpcUrls,
            chainReference: config.launchChain.chainReference,
          })
        : null;
  // Decision 0128: the testnet faucet. The operator chain exists only when
  // the faucet is enabled on the BSC Testnet slot with a key and endpoints;
  // the service reports every missing piece as the capability reason.
  const testnetFaucetChain =
    options.testnetFaucetChain !== undefined
      ? options.testnetFaucetChain
      : composeTestnetFaucetChain(config);
  // S169: a faucet that signs with the MEME pause key (no own key) while
  // the console's pause signer is composed here keeps
  // TESTNET_FAUCET_OPERATOR_RESERVE_BNB on the account, so a pause always
  // has gas.
  // Composed lazily and once: the console mount below reuses it.
  let composedMemePause: AdminMemePauseRuntime | null = null;
  const adminMemePause = (): AdminMemePauseRuntime => {
    composedMemePause ??= composeAdminMemePause(
      config,
      options.memePauseSender,
    );
    return composedMemePause;
  };
  const faucetSharesPauseKey =
    config.testnetFaucet.enabled &&
    config.testnetFaucet.operatorKeySource === "meme" &&
    config.admin !== null &&
    adminMemePause().status === "available";
  if (faucetSharesPauseKey) {
    app.log.warn(
      {
        event: "testnet_faucet.operator_shared_with_meme_pause",
        reserveBnb: config.testnetFaucet.operatorReserveBnb,
      },
      "Testnet faucet signs with MEME_OPERATOR_PRIVATE_KEY, the MEME pause key; keeping TESTNET_FAUCET_OPERATOR_RESERVE_BNB for pause gas",
    );
  }
  const testnetFaucetService =
    options.testnetFaucetService ??
    createTestnetFaucetService({
      config: config.testnetFaucet,
      launchChainId: config.launchChain.chainId,
      rpcConfigured:
        config.launchChain.rpcUrls.length > 0 ||
        (options.testnetFaucetChain !== undefined &&
          options.testnetFaucetChain !== null),
      repository: database.testnetFaucet ?? null,
      wallets: database.accountWallets ?? null,
      chain: testnetFaucetChain,
      logger: app.log,
      now: options.walletIntentNow ?? ((): Date => new Date()),
      operatorReserveWei: faucetSharesPauseKey
        ? BigInt(config.testnetFaucet.operatorReserveWei)
        : 0n,
    });
  const miningRewardsService =
    options.miningRewardsService ??
    createMiningRewardsService({
      repository: database.miningSettlement ?? null,
      chain: miningClaimChain,
      callClient: asChainCallClient(launchChainReadClient ?? bscReadClient),
      wallets: database.accountWallets ?? null,
      signer:
        config.miningSettlement.signerPrivateKey === null
          ? null
          : createMiningClaimSigner(config.miningSettlement.signerPrivateKey),
      contractAddress: config.miningSettlement.claimContractAddress,
      chainId: config.launchChain.chainId,
      // Decision 0150: chain 56 claims only with LAUNCH_MAINNET_ACK.
      mainnetAcknowledged: config.launchChain.mainnetAcknowledged,
      writesEnabled: config.bscWrites !== null,
      usdtAddress: config.miningSettlement.usdtAddress,
      confirmations: config.miningSettlement.claimConfirmations,
      cursorCodec: v2CursorCodec,
      now: options.walletIntentNow ?? ((): Date => new Date()),
    });
  // Community AI (Decision 0066). The capability opens on one fact: a
  // Provider API key (COMMUNITY_AI_API_KEY, falling back to
  // ANTHROPIC_API_KEY). Without it the composed service is the closed one,
  // every AI route answers CAPABILITY_UNAVAILABLE, and the capability stays
  // `deferred` - no fixture answer exists anywhere in this module. The
  // endpoint is COMMUNITY_AI_BASE_URL: Anthropic or an Anthropic-compatible
  // gateway; the key and the origin never reach a log or a response.
  const communityAiGateway =
    options.communityAiGateway ??
    (config.communityAi === null
      ? null
      : createAnthropicCommunityAiGateway({
          apiKey: config.communityAi.apiKey,
          baseUrl: config.communityAi.baseUrl,
          model: config.communityAi.model,
          timeoutMs: config.communityAi.timeoutMs,
          maximumOutputTokens: config.communityAi.maximumOutputTokens,
          logger: app.log,
        }));
  const communityAiRepository =
    database.communityAi ?? createUnavailableCommunityAiRepository();
  const communityAiRuntimeAvailable =
    registeredModuleIds.includes("community") &&
    communityRuntimeAvailable &&
    (options.communityAiService !== undefined ||
      (communityAiGateway !== null && database.communityAi !== undefined));
  const communityAiService =
    options.communityAiService ??
    (communityAiRuntimeAvailable && communityAiGateway !== null
      ? createCommunityAiService({
          gateway: communityAiGateway,
          repository: communityAiRepository,
          readers: {
            communityService,
            marketReadService: registeredModuleIds.includes("market")
              ? marketReadService
              : null,
            miningService: miningRuntimeAvailable ? miningService : null,
            voiceRoomService: communicationRuntimeAvailable
              ? voiceRoomService
              : null,
            communicationRepository: communicationRuntimeAvailable
              ? communicationRepository
              : null,
            channelGateway: communicationRuntimeAvailable
              ? streamCommunityChannelGateway
              : null,
            repository: communityAiRepository,
          },
          userRateLimitPerMinute:
            config.communityAi?.userRateLimitPerMinute ??
            communityAiDefaultQuota.userRateLimitPerMinute,
          communityDailyLimit:
            config.communityAi?.communityDailyLimit ??
            communityAiDefaultQuota.communityDailyLimit,
          briefCacheSeconds:
            config.communityAi?.briefCacheSeconds ??
            communityAiDefaultQuota.briefCacheSeconds,
          briefTimeoutMs:
            config.communityAi?.briefTimeoutMs ??
            communityAiDefaultBriefTimeoutMs,
          logger: app.log,
        })
      : createUnavailableCommunityAiService());

  // D20 (Decision 0037): security reuses the device-session projection and
  // composes the approvals summary only when that module is registered;
  // settings and support have their own repositories.
  const securityRuntimeAvailable =
    registeredModuleIds.includes("security") &&
    (options.deviceService !== undefined ||
      options.securityService !== undefined ||
      v2SessionRuntimeAvailable);
  const settingsRuntimeAvailable =
    registeredModuleIds.includes("settings") &&
    (options.settingsService !== undefined ||
      database.accountSettings !== undefined);
  const supportRuntimeAvailable =
    registeredModuleIds.includes("support") &&
    (options.supportService !== undefined ||
      (database.supportTickets !== undefined && v2CursorCodec !== null));
  const deviceService =
    options.deviceService ??
    createDeviceService({
      sessions: database.deviceSessions,
      notifications: database.notifications ?? null,
      push: pushDispatchService,
      logger: app.log,
      now: securityNow,
    });
  const securityService =
    options.securityService ??
    createSecurityService({
      sessions: database.deviceSessions,
      wallets: database.accountWallets ?? null,
      approvals: registeredModuleIds.includes("sendApprovals")
        ? approvalService
        : null,
      approvalsRuntimeAvailable: walletIntentRuntimeAvailable,
      notifications: database.notifications ?? null,
      // Decision 0129 §4: passkey is available only while an association
      // file is published (Decision 0063).
      passkeyRelyingPartyConfigured:
        config.passkeyRelyingParty.android !== null ||
        config.passkeyRelyingParty.ios !== null,
      now: securityNow,
    });
  const settingsService =
    options.settingsService ??
    createSettingsService({
      repository:
        database.accountSettings ??
        createUnavailableAccountSettingsRepository(),
    });
  const supportService =
    options.supportService ??
    createSupportService({
      repository:
        database.supportTickets ?? createUnavailableSupportTicketRepository(),
      cursorCodec: v2CursorCodec,
    });

  // Chain-ID verification is probed at startup and, while the outcome is
  // `unreachable`/`unknown`, retried with exponential backoff; the read
  // client owns the state. The capability projection reads it synchronously
  // per request and itself schedules a throttled background re-probe when it
  // observes a non-terminal state, so a cold start whose first probe failed
  // heals within seconds without any client action (preflight 2026-09-16,
  // 03 §4.5d). A misconfigured endpoint (`mismatched`) is a loud warning and
  // a closed capability, never retried, never a crash, never a wrong chain.
  const bscChainVerificationWatch = createChainVerificationWatch({
    client: bscReadClient,
    chainSlot: "primary",
    logger: app.log,
    ...(options.chainVerificationWatch ?? {}),
  });
  if (chainRuntimeAvailable) {
    void bscChainVerificationWatch.verifyAtStartup();
  }
  // Same discipline for the launch chain slot (Decision 0038).
  const launchChainVerificationWatch =
    launchChainReadClient === null ||
    launchChainReadClient.endpointRefs.length === 0
      ? null
      : createChainVerificationWatch({
          client: launchChainReadClient,
          chainSlot: "launch",
          logger: app.log,
          ...(options.chainVerificationWatch ?? {}),
        });
  if (launchChainVerificationWatch !== null) {
    void launchChainVerificationWatch.verifyAtStartup();
  }
  // Decision 0039: the operator confirmed the audio-room `user` role evidence
  // in configuration. Log the reference once so a deployment that publishes
  // `voiceRooms.evidence.status = "confirmed"` is traceable; it is an archive
  // label, never a credential.
  if (config.streamAudioRoomUserRoleEvidenceRef !== null) {
    app.log.info(
      {
        capabilityId: "voiceRooms",
        evidenceReference: config.streamAudioRoomUserRoleEvidenceRef,
      },
      "Audio room user-role evidence confirmed by operator configuration",
    );
  }

  app.addHook("onClose", async () => {
    bscChainVerificationWatch.stop();
    launchChainVerificationWatch?.stop();
    await database.close();
  });

  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  registerHealthRoutes(app, config, database);
  // Passkey relying-party discovery (Decision 0063). Registered on every
  // contract surface: the platform credential managers fetch these files from
  // the API origin itself, and they are neither a V1 nor a V2 business route.
  registerWellKnownRoutes(app, config);
  if (includePublic) {
    // Decision 0147: the public MEME page read surface (no auth, CORS `*`),
    // outside `/v2`; its own artifact `openapi/loop-public.v1.json`.
    registerPublicMemeRoutes(app, {
      service: launch2Service,
      ...(options.publicMeme?.nowMs === undefined
        ? {}
        : { nowMs: options.publicMeme.nowMs }),
      ratePerWindow:
        options.publicMeme?.ratePerWindow ?? config.publicRateLimit.perMinute,
      trustProxy: config.trustProxy,
      clientIpHeaders: config.publicRateLimit.clientIpHeaders,
      ...(options.publicMeme?.budgetsMs === undefined
        ? {}
        : { budgetsMs: options.publicMeme.budgetsMs }),
    });
  }
  if (includeV1) {
    registerBootstrapRoute(
      app,
      authenticationHooks.authenticatePrivyBearer,
      bootstrapService,
    );
    registerStreamTokenRoutes(
      app,
      authenticationHooks.authenticateLoopBearer,
      streamTokenService,
    );
    registerDiscoveryRoutes(
      app,
      authenticationHooks.authenticateLoopBearer,
      publicAliasSearchService,
    );
    registerChatGroupRoutes(
      app,
      authenticationHooks.authenticateLoopBearer,
      chatGroupAliasService,
    );
    registerSocialRoutes(
      app,
      authenticationHooks.authenticateLoopBearer,
      socialService,
    );
    registerChatChannelRoutes(
      app,
      authenticationHooks.authenticateLoopBearer,
      chatChannelService,
    );
    registerProfileRoutes(
      app,
      authenticationHooks.authenticateLoopBearer,
      profileService,
    );
    registerWatchlistRoutes(
      app,
      authenticationHooks.authenticateLoopBearer,
      watchlistService,
    );
    registerAlertRoutes(
      app,
      authenticationHooks.authenticateLoopBearer,
      alertService,
    );
    registerSpotMarketDataRoutes(
      app,
      authenticationHooks.authenticateLoopBearer,
      spotMarketService,
    );
    registerSpotIntentRoutes(
      app,
      authenticationHooks.authenticateLoopBearer,
      spotIntentService,
    );
    registerSpotWalletBindingRoutes(
      app,
      authenticationHooks.authenticateLoopBearer,
      spotWalletBindingService,
    );
    registerSpotAgentAuthorizationRoutes(
      app,
      authenticationHooks.authenticateLoopBearer,
      spotAgentAuthorizationService,
    );
    registerPerpWalletBindingRoutes(
      app,
      authenticationHooks.authenticateLoopBearer,
      perpWalletBindingService,
    );
    registerPerpPrivateReadRoutes(
      app,
      authenticationHooks.authenticateLoopBearer,
      perpPrivateReadService,
    );
    registerPerpIntentRoutes(
      app,
      authenticationHooks.authenticateLoopBearer,
      perpIntentService,
    );
    registerAgentAuthorizationRoutes(
      app,
      authenticationHooks.authenticateLoopBearer,
      agentAuthorizationService,
    );
    registerTransferRoutes(
      app,
      authenticationHooks.authenticateLoopBearer,
      transferService,
    );
  }

  // Decision 0143: the square timeline (database + cursor codec only).
  const squareService = createSquareService({
    repository: database.squareFeed ?? null,
    cursorCodec: v2CursorCodec,
    publicBaseUrl: config.publicBaseUrl,
    ...(options.walletIntentNow === undefined
      ? {}
      : { now: options.walletIntentNow }),
  });

  if (includeV2) {
    registerV2Routes(app, {
      config,
      runtime: Object.freeze({
        sessionRuntimeAvailable: v2SessionRuntimeAvailable,
        profileRuntimeAvailable: profileV2RuntimeAvailable,
        avatarUploadRuntimeAvailable,
        communityRuntimeAvailable,
        searchRuntimeAvailable,
        bscRpcConfigured,
        chainRuntimeAvailable,
        bscChainVerification: () => bscChainVerificationWatch.current(),
        walletRuntimeAvailable,
        watchlistRuntimeAvailable,
        marketRuntimeAvailable,
        priceAlertsRuntimeAvailable,
        notificationsFeedRuntimeAvailable,
        communicationRuntimeAvailable,
        communityPresenceRuntimeAvailable,
        walletIntentRuntimeAvailable,
        bscWritesEnabled: config.bscWrites !== null,
        privySwapRuntimeAvailable,
        launchRuntimeAvailable,
        launchChainId: config.launchChain.chainId,
        launchContractEvidence: launchContractEvidenceFrom(
          launchContractAdapter,
        ),
        miningRuntimeAvailable,
        miningFormulaBaseline,
        referralRuntimeAvailable,
        securityRuntimeAvailable,
        settingsRuntimeAvailable,
        supportRuntimeAvailable,
        communityAiRuntimeAvailable,
        pushRuntimeAvailable,
        memeRuntimeAvailable,
        squareFeedAvailable: squareService.available,
        testnetFaucetState: () => ({
          reasonCode: testnetFaucetService.unavailableReason(),
        }),
        launch2State: () => ({
          reasonCode:
            options.launch2Service !== undefined
              ? null
              : launch2UnavailableReason,
        }),
        memeContractState: () => {
          const state = memeContractAdapter.currentAvailability();
          return {
            configured: memeContractAdapter.contract !== null,
            reasonCode: state.status === "available" ? null : state.reasonCode,
          };
        },
      }),
      authenticatePrivyBearer: authenticationHooks.authenticatePrivyBearer,
      authenticateLoopBearer: authenticationHooks.authenticateLoopBearer,
      sessionService: v2SessionService,
      profileService: profileV2Service,
      mediaService,
      publicProfileService,
      communityService,
      communityAiService,
      chainStatusService,
      assetRegistryService,
      walletReadService,
      walletNetWorthHistoryService,
      watchlistV2Service,
      marketReadService,
      tokenLogoProxyService,
      alertV2Service,
      notificationService,
      chatService,
      voiceRoomService,
      walletIntentService,
      sendService,
      approvalService,
      swapService,
      launchService,
      ...(hooksLaunchProjectConfigService === undefined
        ? {}
        : { hooksLaunchProjectConfigService }),
      ...(hooksLaunchDeploymentService === undefined
        ? {}
        : { hooksLaunchDeploymentService }),
      ...(hooksLaunchSubmissionService === undefined
        ? {}
        : { hooksLaunchSubmissionService }),
      miningService,
      miningRewardsService,
      referralService,
      memeService,
      launch2Service,
      // Decision 0140: launch desk campaigns, independent of the Factory
      // configuration (database only).
      launch2CampaignService: createLaunch2CampaignPublicService({
        repository: database.launch2Campaigns ?? null,
        publicBaseUrl: config.publicBaseUrl,
        now: options.walletIntentNow ?? ((): Date => new Date()),
      }),
      deviceService,
      pushTokenService,
      securityService,
      settingsService,
      supportService,
      adminSettings: adminSettingsReader,
      cursorCodec: v2CursorCodec,
    });
    registerV2TestnetFaucetRoutes(
      app,
      authenticationHooks.authenticateLoopBearer,
      testnetFaucetService,
    );
    registerV2SquareRoutes(
      app,
      authenticationHooks.authenticateLoopBearer,
      squareService,
    );
  }

  const adminConfig = adminMounted ? config.admin : null;
  if (adminConfig !== null) {
    const adminRepository =
      database.admin ?? createUnavailableAdminRepository();
    registerAdminRoutes(app, {
      // Decision 0143: square timeline posts (console-written system posts).
      squarePosts: createAdminSquarePostService({
        repository: database.squareFeed ?? null,
        ...(options.adminNow === undefined ? {} : { now: options.adminNow }),
      }),
      // Decision 0140: launch desk campaigns (console-written).
      launch2Campaigns: createAdminLaunch2CampaignService({
        repository: database.launch2Campaigns ?? null,
        publicBaseUrl: config.publicBaseUrl,
        ...(options.adminNow === undefined ? {} : { now: options.adminNow }),
      }),
      // Decision 0134: chain guard incidents of the launch chain.
      chainGuard: createAdminChainGuardService({
        repository: database.chainGuard ?? null,
        chainId: config.launchChain.chainId,
        // Decision 0135: a manual resolve is announced on the optional
        // webhook / Telegram outlets (none configured: null).
        alerts: createChainGuardAlertNotifier({
          config: config.chainGuardAlerts,
          onFailure: (event) => {
            app.log.warn(
              {
                reasonCode: event.reasonCode,
                chainGuardAlertOutlet: event.outlet,
                host: event.host,
                ...(event.status === null ? {} : { statusCode: event.status }),
                ...(event.errorClass === null
                  ? {}
                  : { errorClass: event.errorClass }),
              },
              "LOOP chain guard alert was not delivered",
            );
          },
        }),
      }),
      // Decision 0116: hourly settlement parameters, epochs, funding.
      miningSettlement: createAdminMiningSettlementService({
        repository: database.miningSettlement ?? null,
        runner:
          database.miningSettlement === undefined
            ? null
            : createMiningSettlementRunner({
                repository: database.miningSettlement,
                chainId: config.launchChain.chainId,
                indexerGraceSeconds:
                  config.miningSettlement.indexerGraceSeconds,
                now: options.walletIntentNow ?? ((): Date => new Date()),
              }),
        chain: miningClaimChain,
        contractAddress: config.miningSettlement.claimContractAddress,
        testTrigger: config.miningSettlement.testTrigger,
        now: options.walletIntentNow ?? ((): Date => new Date()),
      }),
      // Decision 0109: individual accounts with fixed roles; without a
      // database only the ADMIN_USERNAME bootstrap administrator exists.
      accounts: createAdminAccountService({
        repository: database.adminAccounts ?? null,
        bootstrapUsername: adminConfig.username,
        sessionSecret: adminConfig.sessionSecret,
      }),
      launchReview: createAdminLaunchReviewConsoleService({
        repository: database.adminLaunchReview ?? null,
        deploymentChainId: config.launchChain.chainReference,
        deploymentMainnetAcknowledged: config.launchChain.mainnetAcknowledged,
        review: createHooksLaunchReviewService({
          repository: database.hooksLaunchReview ?? null,
          factory: hooksFactoryReader,
          fixedBuybackRecipient: config.hooksLaunch.fixedBuybackRecipient,
        }),
        audit: adminRepository,
        sessionSecret: adminConfig.sessionSecret,
        logger: app.log,
      }),
      service: createAdminService({
        username: adminConfig.username,
        passwordHash: adminConfig.passwordHash,
        sessionSecret: adminConfig.sessionSecret,
        repository: adminRepository,
        accounts: database.adminAccounts ?? null,
        // Decision 0110: shared login lock buckets (in-process without a
        // database, where only the bootstrap administrator exists).
        loginAttempts: database.adminLoginAttempts ?? null,
        loginPolicy: adminConfig.loginPolicy,
        settingsReader: adminSettingsReader,
        environmentRecommendedCommunityIds: config.recommendedCommunityIds,
        promotionImageHosts: config.intelPromotionImageHosts,
        communityReview:
          database.community === undefined
            ? null
            : createCommunityReviewService({
                repository: database.community,
                notifications: database.notifications ?? null,
                push: pushRuntimeAvailable ? pushDispatchService : null,
                logger: app.log,
              }),
        memePause: adminMemePause(),
        production: config.nodeEnv === "production",
        logger: app.log,
        ...(options.adminNow === undefined ? {} : { now: options.adminNow }),
      }),
      cookieSecure: adminConfig.cookieSecure,
    });
  }

  if (config.apiDocsEnabled) {
    app.get(
      "/openapi.json",
      {
        schema: {
          hide: true,
        },
      },
      async (_request, reply) => {
        reply.header("cache-control", "no-store");
        return app.swagger();
      },
    );
  }

  app.setNotFoundHandler(async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (adminMounted && isAdminRequestPath(request.raw.url)) {
      const projection = projectAdminError(
        new AdminApiError("NOT_FOUND"),
        request.id,
      );
      return reply.code(projection.statusCode).send(projection.response);
    }
    if (isV2RequestPath(request.raw.url)) {
      const projection = projectV2Error(V2ApiError.notFound(), request.id);
      return reply.code(projection.statusCode).send(projection.response);
    }

    return reply.code(404).send({
      code: "not_found",
      message: "The requested resource does not exist.",
      request_id: request.id,
    });
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (adminMounted && isAdminRequestPath(request.raw.url)) {
      const projection = projectAdminError(error, request.id);
      if (projection.response.code === "INTERNAL_ERROR") {
        request.log.error(
          { requestId: request.id, ...summarizeErrorForLog(error) },
          "Unhandled error in admin request",
        );
      } else {
        request.log.warn(
          {
            requestId: request.id,
            responseCode: projection.response.code,
            statusCode: projection.statusCode,
          },
          "Admin request failed",
        );
      }
      reply.header("cache-control", "no-store");
      const retryAfter = projection.response.detailsSafe?.["retryAfterSeconds"];
      if (
        (projection.response.code === "ADMIN_LOGIN_LOCKED" ||
          projection.response.code === "ADMIN_LOGIN_BUSY") &&
        typeof retryAfter === "number"
      ) {
        reply.header("retry-after", String(retryAfter));
      }
      return reply.code(projection.statusCode).send(projection.response);
    }
    if (isV2RequestPath(request.raw.url)) {
      const projection = projectV2Error(
        chainReadUnavailableFor(request.method, error) ??
          databaseUnavailableFor(request.method, error) ??
          error,
        request.id,
      );
      const failure = classifyRequestError(error);
      if (projection.response.code === "INTERNAL_ERROR") {
        // Decision 0082: the cause of an internal error is logged once, at
        // error level, redacted; nothing of it reaches the response body.
        request.log.error(
          { requestId: request.id, ...summarizeErrorForLog(error) },
          "Unhandled error in V2 request",
        );
      }
      const validationIssues = (error as { validation?: unknown }).validation;
      const validationPaths = Array.isArray(validationIssues)
        ? validationIssues.map((issue: unknown) => {
            if (typeof issue !== "object" || issue === null) {
              return "unknown";
            }
            const record = issue as {
              instancePath?: unknown;
              keyword?: unknown;
            };
            const instancePath =
              typeof record.instancePath === "string"
                ? record.instancePath
                : "";
            const keyword =
              typeof record.keyword === "string" ? record.keyword : "";
            return `${instancePath} ${keyword}`.trim();
          })
        : undefined;
      request.log.warn(
        {
          requestId: request.id,
          responseCode: projection.response.code,
          statusCode: projection.statusCode,
          // Operator diagnostics only: the Fastify/ApiError code plus the
          // schema paths of a validation failure. Neither carries header or
          // body values, and nothing here reaches the response envelope.
          ...(failure.code === undefined ? {} : { errorCode: failure.code }),
          ...(typeof failure.code === "string" &&
          failure.code.startsWith("FST_ERR_CTP_")
            ? {
                requestContentType: request.headers["content-type"] ?? null,
                requestContentLength: request.headers["content-length"] ?? null,
              }
            : {}),
          ...(validationPaths === undefined
            ? {}
            : {
                validationContext: (error as { validationContext?: unknown })
                  .validationContext,
                validationPaths,
              }),
        },
        "Request failed",
      );
      reply.header("cache-control", "no-store");
      if (projection.includeBearerChallenge) {
        reply.header("www-authenticate", 'Bearer realm="loop-api"');
      }
      return reply.code(projection.statusCode).send(projection.response);
    }

    const details = classifyRequestError(error);
    const apiError = error instanceof ApiError ? error : undefined;
    const isHandlerTimeout = details.code === "FST_ERR_HANDLER_TIMEOUT";
    const isClientError =
      details.statusCode !== undefined &&
      details.statusCode >= 400 &&
      details.statusCode < 500;
    const isRequestInputError =
      details.hasValidation ||
      details.statusCode === 400 ||
      details.statusCode === 413 ||
      details.statusCode === 415;
    const statusCode = apiError
      ? apiError.statusCode
      : isHandlerTimeout
        ? 503
        : isRequestInputError
          ? 400
          : isClientError
            ? details.statusCode
            : 500;
    const code = apiError
      ? apiError.code
      : isHandlerTimeout
        ? "request_timeout"
        : isRequestInputError
          ? "invalid_request"
          : "internal_error";
    const message = apiError
      ? apiError.safeMessage
      : isHandlerTimeout
        ? "The request timed out."
        : code === "invalid_request"
          ? "The request is invalid."
          : "The request could not be completed.";

    request.log.warn(
      {
        requestId: request.id,
        responseCode: code,
        statusCode,
      },
      "Request failed",
    );

    reply.header("cache-control", "no-store");
    if (apiError?.includeBearerChallenge === true) {
      reply.header("www-authenticate", 'Bearer realm="loop-api"');
    }
    return reply.code(statusCode).send({
      code,
      message,
      request_id: request.id,
    });
  });

  return app;
}

/**
 * Decision 0128: the faucet operator chain, composed only when the faucet is
 * enabled on the BSC Testnet slot with an operator key and endpoints. The
 * key never reaches a log.
 */
function composeTestnetFaucetChain(
  config: AppConfig,
): TestnetFaucetChain | null {
  const faucet = config.testnetFaucet;
  if (
    !faucet.enabled ||
    faucet.operatorPrivateKey === null ||
    config.launchChain.rpcUrls.length === 0
  ) {
    return null;
  }
  try {
    return createTestnetFaucetChain({
      privateKey: faucet.operatorPrivateKey,
      chainReference: config.launchChain.chainReference,
      rpcUrls: config.launchChain.rpcUrls,
    });
  } catch {
    return null;
  }
}

/**
 * Decision 0102/0105: the console's pause/unpause signer, composed only when
 * the operator key (MEME_OPERATOR_PRIVATE_KEY), the MEME contract, the
 * testnet slot, and an RPC are all present; otherwise the reason the
 * buttons are grey.
 */
function composeAdminMemePause(
  config: AppConfig,
  override: MemePauseSender | null | undefined,
): AdminMemePauseRuntime {
  if (override !== undefined) {
    return override === null
      ? { status: "unavailable", reasonCode: "MEME_OPERATOR_KEY_MISSING" }
      : { status: "available", sender: override };
  }
  if (config.memeOperator === null) {
    return { status: "unavailable", reasonCode: "MEME_OPERATOR_KEY_MISSING" };
  }
  if (config.meme.contract === null) {
    return {
      status: "unavailable",
      reasonCode:
        config.meme.unconfiguredReason ?? "MEME_CONTRACT_NOT_CONFIGURED",
    };
  }
  try {
    return {
      status: "available",
      sender: createMemePauseSender({
        privateKey: config.memeOperator.privateKey,
        curveAddress: config.meme.contract.address,
        chainReference: config.launchChain.chainReference,
        rpcUrls: config.launchChain.rpcUrls,
      }),
    };
  } catch (error) {
    return {
      status: "unavailable",
      reasonCode:
        error instanceof MemeGraduationSenderRefusedError
          ? error.reasonCode
          : "MEME_PAUSE_SENDER_UNAVAILABLE",
    };
  }
}

/**
 * Last line of defence for read routes (Decision 0082): a chain read that
 * was not classified by its feature — a `BscReadUnavailableError`, or a viem
 * timeout/HTTP/socket failure — is the capability being unavailable, never
 * an internal error. Write routes keep their own classification.
 */
/**
 * Decision 0127: a GET whose PostgreSQL work failed because the database is
 * read-only (SQLSTATE 25006, e.g. a hot standby or
 * `default_transaction_read_only`) or unreachable / shutting down (class 08,
 * 57P01–57P03, 53300) is an availability condition, never an internal
 * error. Writes keep their own mapping.
 */
function databaseUnavailableFor(
  method: string,
  error: unknown,
): V2ApiError | null {
  if (method !== "GET" && method !== "HEAD") {
    return null;
  }
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[0-9A-Z]{5}$/.test(error.code)
      ? error.code
      : null;
  if (code === null) {
    return null;
  }
  if (code === "25006") {
    return V2ApiError.fromCode("CAPABILITY_UNAVAILABLE", {
      reasonCode: "DATABASE_READ_ONLY",
    });
  }
  if (
    code.startsWith("08") ||
    code === "57P01" ||
    code === "57P02" ||
    code === "57P03" ||
    code === "53300"
  ) {
    return V2ApiError.fromCode("CAPABILITY_UNAVAILABLE", {
      reasonCode: "DATABASE_UNAVAILABLE",
    });
  }
  return null;
}

function chainReadUnavailableFor(
  method: string,
  error: unknown,
): V2ApiError | null {
  if (method !== "GET" && method !== "HEAD") {
    return null;
  }
  if (error instanceof BscReadUnavailableError) {
    return V2ApiError.fromCode("CAPABILITY_UNAVAILABLE", {
      reasonCode: error.reasonCode,
    });
  }
  if (isBscRpcTransportError(error)) {
    return V2ApiError.fromCode("CAPABILITY_UNAVAILABLE", {
      reasonCode: "BSC_RPC_UNREACHABLE",
    });
  }
  return null;
}
