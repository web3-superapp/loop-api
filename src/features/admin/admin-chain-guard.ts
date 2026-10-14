import {
  chainGuardHoldKinds,
  chainGuardReasonCodes,
  type ChainGuardRepository,
} from "../chain-guard/chain-guard-contract.js";
import { AdminApiError } from "./admin-contract.js";

/**
 * Decision 0134: the console's read of the chain guard — the unresolved
 * incidents of the launch chain, newest sighting first, and whether the
 * signing lanes are held. Without the repository: 503
 * CAPABILITY_UNAVAILABLE (`CHAIN_GUARD_REPOSITORY_UNAVAILABLE`), never an
 * empty "all clear".
 */

export const adminChainGuardIncidentLimit = 200;

export interface AdminChainGuardIncidentResource {
  readonly incidentId: string;
  readonly kind: string;
  readonly subject: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly hold: boolean;
}

export interface AdminChainGuardResource {
  readonly chainId: string;
  readonly holdActive: boolean;
  readonly holdKinds: readonly string[];
  readonly items: readonly AdminChainGuardIncidentResource[];
  readonly generatedAt: string;
}

export interface AdminChainGuardService {
  listIncidents(): Promise<AdminChainGuardResource>;
}

export function createAdminChainGuardService(input: {
  readonly repository: Pick<ChainGuardRepository, "listUnresolved"> | null;
  readonly chainId: string;
  readonly now?: () => Date;
}): AdminChainGuardService {
  const now = input.now ?? ((): Date => new Date());
  return Object.freeze({
    async listIncidents(): Promise<AdminChainGuardResource> {
      if (input.repository === null) {
        throw new AdminApiError("CAPABILITY_UNAVAILABLE", {
          reasonCode: chainGuardReasonCodes.repositoryUnavailable,
        });
      }
      let incidents;
      try {
        incidents = await input.repository.listUnresolved({
          chainId: input.chainId,
          limit: adminChainGuardIncidentLimit,
        });
      } catch {
        throw new AdminApiError("CAPABILITY_UNAVAILABLE", {
          reasonCode: chainGuardReasonCodes.repositoryUnavailable,
        });
      }
      const items = incidents.map((incident) =>
        Object.freeze({
          incidentId: incident.incidentId,
          kind: incident.kind,
          subject: incident.subject,
          details: incident.details,
          firstSeenAt: incident.firstSeenAt,
          lastSeenAt: incident.lastSeenAt,
          hold: chainGuardHoldKinds.includes(incident.kind),
        }),
      );
      return Object.freeze({
        chainId: input.chainId,
        holdActive: items.some((item) => item.hold),
        holdKinds: chainGuardHoldKinds,
        items,
        generatedAt: now().toISOString(),
      });
    },
  });
}
