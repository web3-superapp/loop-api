import type { ChainGuardAlertNotifier } from "../../integrations/chain-guard/chain-guard-alerts.js";
import {
  chainGuardHoldKinds,
  chainGuardReasonCodes,
  chainGuardStateKinds,
  type ChainGuardIncidentRecord,
  type ChainGuardRepository,
} from "../chain-guard/chain-guard-contract.js";
import { AdminApiError } from "./admin-contract.js";
import type { AdminWriteContext } from "./admin-service.js";

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

/** Decision 0135: the incident as a manual resolve returns it. */
export interface AdminChainGuardResolvedResource {
  readonly incident: AdminChainGuardIncidentResource & {
    readonly resolvedAt: string;
    readonly resolution: "auto" | "manual";
    readonly resolvedBy: string | null;
    readonly resolutionNote: string | null;
    /**
     * A condition kind (paused / frozen / mismatch / fee / balance …): if
     * the fact still holds, the lane's next tick opens a new incident.
     */
    readonly reopensIfStillTrue: boolean;
  };
  readonly audit: {
    readonly auditId: string;
    readonly seq: number;
    readonly at: string;
  };
}

export interface AdminChainGuardService {
  listIncidents(): Promise<AdminChainGuardResource>;
  /**
   * Decision 0135: closes one unresolved incident by hand (console.write),
   * with a note and an `admin_audit_log` row. 404 unknown, 409 already
   * resolved, 422 bad note, 503 without the repository.
   */
  resolveIncident(
    context: AdminWriteContext,
    incidentId: string,
    body: unknown,
  ): Promise<AdminChainGuardResolvedResource>;
}

export const adminChainGuardNoteMaxLength = 500;
/** Control / format / separator characters; a tab or line break is allowed. */
const forbiddenNoteCharacters = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const incidentIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function isStateKind(kind: string): boolean {
  return (chainGuardStateKinds as readonly string[]).includes(kind);
}

function incidentItem(
  incident: ChainGuardIncidentRecord,
): AdminChainGuardIncidentResource {
  return Object.freeze({
    incidentId: incident.incidentId,
    kind: incident.kind,
    subject: incident.subject,
    details: incident.details,
    firstSeenAt: incident.firstSeenAt,
    lastSeenAt: incident.lastSeenAt,
    hold: chainGuardHoldKinds.includes(incident.kind),
  });
}

export function createAdminChainGuardService(input: {
  readonly repository: Pick<
    ChainGuardRepository,
    "listUnresolved" | "resolveManually"
  > | null;
  readonly chainId: string;
  readonly now?: () => Date;
  /** Decision 0135: the optional alert outlets (manual resolves). */
  readonly alerts?: ChainGuardAlertNotifier | null;
}): AdminChainGuardService {
  const now = input.now ?? ((): Date => new Date());
  const unavailable = (): AdminApiError =>
    new AdminApiError("CAPABILITY_UNAVAILABLE", {
      reasonCode: chainGuardReasonCodes.repositoryUnavailable,
    });
  return Object.freeze({
    async resolveIncident(
      context: AdminWriteContext,
      incidentId: string,
      body: unknown,
    ): Promise<AdminChainGuardResolvedResource> {
      if (input.repository === null) throw unavailable();
      if (!incidentIdPattern.test(incidentId)) {
        throw new AdminApiError("NOT_FOUND", {
          reasonCode: chainGuardReasonCodes.incidentNotFound,
        });
      }
      const raw =
        typeof body === "object" && body !== null && !Array.isArray(body)
          ? (body as Record<string, unknown>)["note"]
          : undefined;
      const note = typeof raw === "string" ? raw.trim() : "";
      if (
        note.length === 0 ||
        note.length > adminChainGuardNoteMaxLength ||
        forbiddenNoteCharacters.test(note.replace(/[\t\n]/gu, ""))
      ) {
        throw new AdminApiError("VALIDATION_FAILED", {
          reasonCode: chainGuardReasonCodes.noteInvalid,
          field: "note",
        });
      }
      let result;
      try {
        result = await input.repository.resolveManually({
          chainId: input.chainId,
          incidentId,
          note,
          now: now(),
          audit: {
            actor: context.session.actor,
            actorAccountId: context.session.accountId,
            requestId: context.requestId,
          },
        });
      } catch {
        throw unavailable();
      }
      if (result.status === "not_found") {
        throw new AdminApiError("NOT_FOUND", {
          reasonCode: chainGuardReasonCodes.incidentNotFound,
        });
      }
      if (result.status === "already_resolved") {
        throw new AdminApiError("ADMIN_CONFLICT", {
          reasonCode: chainGuardReasonCodes.incidentAlreadyResolved,
        });
      }
      const incident = result.incident;
      void input.alerts?.notify({
        type: "incident_resolved",
        chainId: incident.chainId,
        incidentId: incident.incidentId,
        kind: incident.kind,
        subject: incident.subject,
        details: incident.details,
        resolution: "manual",
        at: incident.resolvedAt ?? now().toISOString(),
      });
      return Object.freeze({
        incident: Object.freeze({
          ...incidentItem(incident),
          resolvedAt: incident.resolvedAt ?? now().toISOString(),
          resolution: incident.resolution ?? "manual",
          resolvedBy: incident.resolvedBy,
          resolutionNote: incident.resolutionNote,
          reopensIfStillTrue: isStateKind(incident.kind),
        }),
        audit: Object.freeze({ ...result.audit }),
      });
    },

    async listIncidents(): Promise<AdminChainGuardResource> {
      if (input.repository === null) throw unavailable();
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
      const items = incidents.map(incidentItem);
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
