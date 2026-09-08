import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import type { AccountWalletRepository } from "../../database/account-wallet-repository.js";
import type { NotificationRepository } from "../../database/notification-repository.js";
import type { NotificationProjection } from "../alerts/notification-service.js";
import { mandatoryNotificationCategory } from "../alerts/notification-contract.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import type { DeviceSessionRepository } from "../session/device-session-repository.js";
import type { ApprovalService } from "../wallet-intents/approval-service.js";
import {
  deviceListLimit,
  deviceRiskPolicy,
  recentSecurityEventLimit,
  securityCapabilityEvidenceReasonCodes,
  securityCapabilityGuideKeys,
  securityCapabilityIds,
  securityReasonCodes,
  type SecurityCapabilityId,
} from "./security-contract.js";

/**
 * Security centre projections (Decision 0037): the six Privy-side security
 * methods (all unavailable with pending evidence) and the account summary the
 * `security` page renders. No score is computed; every block is a fact from
 * an existing module or an explicit `unavailable` with its reason.
 */

export interface SecurityCapabilityProjection {
  readonly capabilityId: SecurityCapabilityId;
  readonly status: "unavailable";
  readonly reasonCode: string;
  readonly evidence: {
    readonly status: "pending";
    readonly reasonCode: string;
  };
  readonly guideKey: string;
}

export interface SecurityCapabilitiesResource {
  readonly items: readonly SecurityCapabilityProjection[];
  readonly contractVersion: typeof v2ContractVersion;
}

export interface UnavailableBlock {
  readonly status: "unavailable";
  readonly reasonCode: string;
}

export interface SecurityDevicesBlock {
  readonly status: "available";
  readonly deviceCount: number;
  readonly activeSessionCount: number;
  readonly newSessions24h: number;
  readonly highRiskNewDevice: boolean;
  readonly policy: typeof deviceRiskPolicy;
}

export interface SecurityApprovalsBlock {
  readonly status: "available";
  readonly walletId: string;
  readonly activeCount: number;
  readonly unlimitedCount: number;
  readonly freshness: {
    readonly indexerBlockNumber: string;
    readonly headBlockNumber: string;
    readonly observedAt: string;
  };
}

export interface SecurityEventsBlock {
  readonly status: "available";
  readonly items: readonly NotificationProjection[];
}

export interface SecuritySummaryResource {
  readonly devices: SecurityDevicesBlock | UnavailableBlock;
  readonly approvals: SecurityApprovalsBlock | UnavailableBlock;
  readonly notifications: {
    readonly securityEvents: {
      readonly category: typeof mandatoryNotificationCategory;
      readonly enabled: true;
      readonly locked: true;
    };
  };
  readonly recentSecurityEvents: SecurityEventsBlock | UnavailableBlock;
  readonly observedAt: string;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface SecurityService {
  listCapabilities(): SecurityCapabilitiesResource;
  getSummary(input: {
    readonly principal: AuthenticatedLoopPrincipal;
  }): Promise<SecuritySummaryResource>;
}

export interface CreateSecurityServiceInput {
  readonly sessions: DeviceSessionRepository;
  /** `null` when the wallet inventory is not composed. */
  readonly wallets: AccountWalletRepository | null;
  /** `null` when the `sendApprovals` module is not registered. */
  readonly approvals: ApprovalService | null;
  /** The wallet-intent runtime (repositories, RPC, indexer) is composed. */
  readonly approvalsRuntimeAvailable: boolean;
  /** `null` when the notification repository is not composed. */
  readonly notifications: NotificationRepository | null;
  readonly now?: () => Date;
}

const capabilities: SecurityCapabilitiesResource = Object.freeze({
  items: Object.freeze(
    securityCapabilityIds.map((capabilityId) =>
      Object.freeze({
        capabilityId,
        status: "unavailable" as const,
        reasonCode: securityCapabilityEvidenceReasonCodes[capabilityId],
        evidence: Object.freeze({
          status: "pending" as const,
          reasonCode: securityCapabilityEvidenceReasonCodes[capabilityId],
        }),
        guideKey: securityCapabilityGuideKeys[capabilityId],
      }),
    ),
  ),
  contractVersion: v2ContractVersion,
});

function unavailable(reasonCode: string): UnavailableBlock {
  return Object.freeze({ status: "unavailable", reasonCode });
}

function projectNotification(record: {
  readonly notificationId: string;
  readonly type: NotificationProjection["type"];
  readonly entityRef: string;
  readonly contextRoute: string;
  readonly contextParams: Readonly<Record<string, string>>;
  readonly payload: Readonly<Record<string, string | null>>;
  readonly source: string | null;
  readonly observedAt: string | null;
  readonly readAt: string | null;
  readonly createdAt: string;
}): NotificationProjection {
  return Object.freeze({
    notificationId: record.notificationId,
    type: record.type,
    entityRef: record.entityRef,
    contextRoute: record.contextRoute,
    contextParams: record.contextParams,
    payload: record.payload,
    source: record.source,
    observedAt: record.observedAt,
    readAt: record.readAt,
    createdAt: record.createdAt,
  });
}

export function createSecurityService(
  input: CreateSecurityServiceInput,
): SecurityService {
  const now = input.now ?? ((): Date => new Date());

  async function devicesBlock(
    principal: AuthenticatedLoopPrincipal,
    observedAt: Date,
  ): Promise<SecurityDevicesBlock | UnavailableBlock> {
    let sessions;
    try {
      sessions = await input.sessions.listByOwner(
        principal.userId,
        deviceListLimit,
      );
    } catch {
      return unavailable(securityReasonCodes.deviceSessionsUnavailable);
    }
    const active = sessions.filter((session) => session.status === "active");
    const windowStart =
      observedAt.getTime() - deviceRiskPolicy.windowHours * 3_600_000;
    const newSessions24h = sessions.filter(
      (session) => Date.parse(session.createdAt) >= windowStart,
    ).length;
    return Object.freeze({
      status: "available",
      deviceCount: new Set(active.map((session) => session.deviceId)).size,
      activeSessionCount: active.length,
      newSessions24h,
      highRiskNewDevice: newSessions24h >= deviceRiskPolicy.newSessionThreshold,
      policy: deviceRiskPolicy,
    });
  }

  async function approvalsBlock(
    principal: AuthenticatedLoopPrincipal,
  ): Promise<SecurityApprovalsBlock | UnavailableBlock> {
    if (input.approvals === null) {
      return unavailable(securityReasonCodes.approvalsDeferred);
    }
    if (!input.approvalsRuntimeAvailable) {
      return unavailable(securityReasonCodes.approvalsRuntimeUnavailable);
    }
    if (input.wallets === null) {
      return unavailable(securityReasonCodes.walletRuntimeUnavailable);
    }
    let active;
    try {
      active = (await input.wallets.list(principal.userId)).find(
        (wallet) => wallet.isActive && wallet.status === "active",
      );
    } catch {
      return unavailable(securityReasonCodes.walletRuntimeUnavailable);
    }
    if (active === undefined) {
      return unavailable(securityReasonCodes.walletNotSelected);
    }
    try {
      const inventory = await input.approvals.list({
        principal,
        walletId: active.walletId,
      });
      return Object.freeze({
        status: "available",
        walletId: inventory.walletId,
        activeCount: inventory.summary.activeCount,
        unlimitedCount: inventory.summary.unlimitedCount,
        freshness: inventory.freshness,
      });
    } catch (error) {
      // A missing RPC, indexer, or write switch closes only this block; the
      // error code is the reason so the page can explain it.
      // Any other failure closes the block too: a summary never turns a
      // read failure into a server error or a zero.
      return unavailable(
        error instanceof V2ApiError ? error.code : "CAPABILITY_UNAVAILABLE",
      );
    }
  }

  async function eventsBlock(
    principal: AuthenticatedLoopPrincipal,
  ): Promise<SecurityEventsBlock | UnavailableBlock> {
    if (input.notifications === null) {
      return unavailable(securityReasonCodes.notificationsUnavailable);
    }
    try {
      const records = await input.notifications.listRecentByType({
        ownerUserId: principal.userId,
        type: mandatoryNotificationCategory,
        limit: recentSecurityEventLimit,
      });
      return Object.freeze({
        status: "available",
        items: Object.freeze(records.map(projectNotification)),
      });
    } catch {
      return unavailable(securityReasonCodes.notificationsUnavailable);
    }
  }

  const service: SecurityService = {
    listCapabilities: () => capabilities,

    async getSummary({ principal }) {
      const observedAt = now();
      const [devices, approvals, recentSecurityEvents] = await Promise.all([
        devicesBlock(principal, observedAt),
        approvalsBlock(principal),
        eventsBlock(principal),
      ]);
      return Object.freeze({
        devices,
        approvals,
        notifications: Object.freeze({
          securityEvents: Object.freeze({
            category: mandatoryNotificationCategory,
            enabled: true as const,
            locked: true as const,
          }),
        }),
        recentSecurityEvents,
        observedAt: observedAt.toISOString(),
        contractVersion: v2ContractVersion,
      });
    },
  };
  return Object.freeze(service);
}
