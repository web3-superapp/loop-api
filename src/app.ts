import { randomUUID } from "node:crypto";

import helmet from "@fastify/helmet";
import swagger from "@fastify/swagger";
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyServerOptions,
} from "fastify";

import type { AppConfig } from "./config.js";
import { ApiError } from "./core/http/api-error.js";
import { createV2CursorCodec } from "./core/http/v2-cursor.js";
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
} from "./features/chain/chain-contract.js";
import {
  createWalletReadService,
  type WalletReadService,
} from "./features/wallet/wallet-read-service.js";
import {
  createWatchlistV2Service,
  type WatchlistV2Service,
} from "./features/watchlist/watchlist-v2-service.js";
import {
  createBscReadClient,
  createUnavailableBscReadClient,
  type BscReadClient,
  type ChainVerificationState,
} from "./integrations/bsc/rpc-client.js";
import {
  createPrivyBalanceReader,
  createPrivyWalletReader,
  createUnavailablePrivyBalanceReader,
  createUnavailablePrivyWalletReader,
  type PrivyBalanceReader,
  type PrivyWalletReader,
} from "./integrations/privy/wallet-reader.js";
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
  createUnavailableStreamChannelGateway,
  type StreamChannelGateway,
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
  readonly contractSurface?: "runtime" | "v1" | "v2";
  readonly database?: Database;
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
  readonly communityService?: CommunityService;
  readonly watchlistService?: WatchlistService;
  readonly alertService?: AlertService;
  readonly spotMarketService?: SpotMarketService;
  readonly spotIntentService?: SpotIntentService;
  readonly spotWalletBindingService?: SpotWalletBindingService;
  readonly spotAgentAuthorizationService?: SpotAgentAuthorizationService;
  readonly v2SessionService?: V2SessionService;
  readonly bscReadClient?: BscReadClient;
  readonly privyWalletReader?: PrivyWalletReader;
  readonly privyBalanceReader?: PrivyBalanceReader;
  readonly chainStatusService?: ChainStatusService;
  readonly assetRegistryService?: AssetRegistryService;
  readonly walletReadService?: WalletReadService;
  readonly watchlistV2Service?: WatchlistV2Service;
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

export async function buildApp(
  options: BuildAppOptions,
): Promise<FastifyInstance> {
  const { config } = options;
  const contractSurface = options.contractSurface ?? "runtime";
  const includeV1 = contractSurface !== "v2";
  const includeV2 = contractSurface !== "v1";
  const fastifyOptions: FastifyServerOptions = {
    ajv: {
      customOptions: {
        removeAdditional: false,
      },
    },
    bodyLimit: 1_048_576,
    connectionTimeout: 10_000,
    exposeHeadRoutes: false,
    frameworkErrors(error, request, reply): void {
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
  ] as const;
  const runtimeOpenApiTags = [...v1OpenApiTags, v2OpenApiTags[1]] as const;

  await app.register(swagger, {
    hideUntagged: true,
    openapi: {
      openapi: "3.1.0",
      info: {
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
            : [...runtimeOpenApiTags],
      components: {
        securitySchemes: {
          privyBearer: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
            description: "Current Privy access token",
          },
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
  const authenticationService = createAuthenticationService(
    privyAccessTokenVerifier,
    database.internalUsers,
  );
  const authenticationHooks = registerAuthenticationHooks(
    app,
    authenticationService,
  );
  const bootstrapService = createBootstrapService(database.internalUsers);
  const v2SessionRuntimeAvailable =
    config.v2SessionEnabled && config.privy !== null;
  const v2SessionService =
    options.v2SessionService ??
    createV2SessionService({
      enabled: v2SessionRuntimeAvailable,
      sessions: database.deviceSessions,
    });
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
  const streamChannelGateway =
    options.streamChannelGateway ??
    (config.stream === null
      ? createUnavailableStreamChannelGateway()
      : createStreamChannelGateway(config.stream));
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
  const profileV2Service =
    options.profileV2Service ??
    createProfileV2Service({
      repository: database.profilesV2 ?? createUnavailableProfileV2Repository(),
      aliasPolicy: createAliasPolicy({
        blockedTerms: config.v2AliasBlockedTerms,
      }),
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
  const communityService =
    options.communityService ??
    createCommunityService({
      repository: database.community ?? createUnavailableCommunityRepository(),
      cursorCodec: v2CursorCodec,
      searchQuota: aliasSearchQuota,
      aliasPolicy: createAliasPolicy({
        blockedTerms: config.v2AliasBlockedTerms,
      }),
    });
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

  const registeredModuleIds = registeredV2ModuleIds(config);
  const bscReadClient =
    options.bscReadClient ??
    (config.bscChain === null
      ? createUnavailableBscReadClient()
      : createBscReadClient({ config: config.bscChain }));
  const chainRegistryRepository =
    database.chainRegistry ?? createUnavailableChainRegistryRepository();
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
    });
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
      chainId: bscChainId,
      chainName: "BNB Smart Chain",
      chainReference: bscChainReference,
    });
  const watchlistV2Service =
    options.watchlistV2Service ??
    createWatchlistV2Service({
      repository:
        database.watchlistsV2 ?? createUnavailableWatchlistV2Repository(),
      registry: chainRegistryRepository,
      chainId: bscChainId,
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

  // Chain-ID verification is probed once at startup and refreshed lazily by
  // the read client. A misconfigured endpoint is a loud warning and a closed
  // capability, never a crash and never a silently wrong chain.
  let chainVerification: ChainVerificationState = "unknown";
  if (chainRuntimeAvailable) {
    void bscReadClient
      .verifyChain()
      .then((state) => {
        chainVerification = state;
        if (state !== "verified") {
          app.log.warn(
            { chainId: bscChainId, chainVerification: state },
            "BSC chain verification did not confirm the configured chain",
          );
        }
      })
      .catch(() => {
        chainVerification = "unreachable";
      });
  }

  app.addHook("onClose", async () => {
    await database.close();
  });

  app.addHook("onSend", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  registerHealthRoutes(app, config, database);
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

  if (includeV2) {
    registerV2Routes(app, {
      config,
      runtime: Object.freeze({
        sessionRuntimeAvailable: v2SessionRuntimeAvailable,
        profileRuntimeAvailable: profileV2RuntimeAvailable,
        communityRuntimeAvailable,
        searchRuntimeAvailable,
        bscRpcConfigured,
        chainRuntimeAvailable,
        bscChainVerification: () => chainVerification,
        walletRuntimeAvailable,
        watchlistRuntimeAvailable,
      }),
      authenticatePrivyBearer: authenticationHooks.authenticatePrivyBearer,
      authenticateLoopBearer: authenticationHooks.authenticateLoopBearer,
      sessionService: v2SessionService,
      profileService: profileV2Service,
      communityService,
      chainStatusService,
      assetRegistryService,
      walletReadService,
      watchlistV2Service,
      cursorCodec: v2CursorCodec,
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
    if (isV2RequestPath(request.raw.url)) {
      const projection = projectV2Error(error, request.id);
      request.log.warn(
        {
          requestId: request.id,
          responseCode: projection.response.code,
          statusCode: projection.statusCode,
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
