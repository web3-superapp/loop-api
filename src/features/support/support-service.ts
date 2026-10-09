import type { AuthenticatedLoopPrincipal } from "../../core/http/authentication.js";
import {
  InvalidV2CursorError,
  type V2CursorCodec,
} from "../../core/http/v2-cursor.js";
import { V2ApiError } from "../../core/http/v2-error.js";
import { v2ContractVersion } from "../meta/product-policy.js";
import {
  isSupportTicketCategory,
  normalizeSupportText,
  supportReasonCodes,
  supportResponsePolicy,
  supportTicketCreateDigest,
  supportTicketListLimits,
  SupportTextInvalidError,
  type SupportTicketCategory,
  type SupportTicketEventType,
  type SupportTicketStatus,
} from "./support-contract.js";
import {
  SupportTicketIdempotencyConflictError,
  SupportTicketRateLimitedError,
  SupportTicketRepositoryUnavailableError,
  type SupportTicketRecord,
  type SupportTicketRepository,
} from "./support-ticket-repository.js";

export interface SupportTicketEventProjection {
  readonly eventVersion: number;
  readonly eventType: SupportTicketEventType;
  readonly actor: "user" | "operator";
  readonly note: string | null;
  readonly occurredAt: string;
}

export interface SupportTicketProjection {
  readonly ticketId: string;
  readonly category: SupportTicketCategory;
  readonly body: string;
  readonly status: SupportTicketStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastEventAt: string;
  readonly events: readonly SupportTicketEventProjection[];
}

export interface SupportTicketEnvelope {
  readonly ticket: SupportTicketProjection;
  readonly attachments: {
    readonly status: "unavailable";
    readonly reasonCode: typeof supportReasonCodes.attachmentsUnavailable;
  };
  readonly policy: typeof supportResponsePolicy;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface SupportTicketListResource {
  readonly items: readonly SupportTicketProjection[];
  readonly nextCursor: string | null;
  readonly attachments: SupportTicketEnvelope["attachments"];
  readonly policy: typeof supportResponsePolicy;
  readonly contractVersion: typeof v2ContractVersion;
}

export interface SupportService {
  create(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly idempotencyKey: string;
    readonly requestId: string;
    readonly body: unknown;
  }): Promise<{
    readonly created: boolean;
    readonly resource: SupportTicketEnvelope;
  }>;
  list(input: {
    readonly principal: AuthenticatedLoopPrincipal;
    readonly cursor: unknown;
    readonly limit: unknown;
  }): Promise<SupportTicketListResource>;
}

const listCursorRoute = "supportTickets";
const listCursorFilter = "all";

const attachments = Object.freeze({
  status: "unavailable" as const,
  reasonCode: supportReasonCodes.attachmentsUnavailable,
});

function project(record: SupportTicketRecord): SupportTicketProjection {
  return Object.freeze({
    ticketId: record.ticketId,
    category: record.category,
    body: record.body,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastEventAt: record.lastEventAt,
    events: record.events,
  });
}

function parseCreateBody(body: unknown): {
  readonly category: SupportTicketCategory;
  readonly body: string;
} {
  if (typeof body !== "object" || body === null) {
    throw V2ApiError.invalidRequest();
  }
  const { category, body: text } = body as Record<string, unknown>;
  if (!isSupportTicketCategory(category)) {
    throw V2ApiError.invalidRequest();
  }
  try {
    return Object.freeze({ category, body: normalizeSupportText(text) });
  } catch (error) {
    if (error instanceof SupportTextInvalidError) {
      throw error.reason === "length"
        ? V2ApiError.fromCode("VALIDATION_FAILED")
        : V2ApiError.invalidRequest();
    }
    throw error;
  }
}

function translate(error: unknown): never {
  if (error instanceof SupportTicketIdempotencyConflictError) {
    throw V2ApiError.idempotencyConflict();
  }
  if (error instanceof SupportTicketRateLimitedError) {
    throw V2ApiError.rateLimited();
  }
  if (error instanceof SupportTicketRepositoryUnavailableError) {
    throw V2ApiError.capabilityUnavailable();
  }
  throw error;
}

export function createSupportService(input: {
  readonly repository: SupportTicketRepository;
  readonly cursorCodec: V2CursorCodec | null;
}): SupportService {
  function envelope(record: SupportTicketRecord): SupportTicketEnvelope {
    return Object.freeze({
      ticket: project(record),
      attachments,
      policy: supportResponsePolicy,
      contractVersion: v2ContractVersion,
    });
  }

  const service: SupportService = {
    async create({ principal, idempotencyKey, requestId, body }) {
      const parsed = parseCreateBody(body);
      try {
        const result = await input.repository.create({
          ownerUserId: principal.userId,
          idempotencyKey,
          requestSha256: supportTicketCreateDigest(parsed),
          requestId,
          category: parsed.category,
          body: parsed.body,
        });
        return Object.freeze({
          created: result.created,
          resource: envelope(result.ticket),
        });
      } catch (error) {
        return translate(error);
      }
    },

    async list({ principal, cursor, limit }) {
      const codec = input.cursorCodec;
      if (codec === null) {
        throw V2ApiError.capabilityUnavailable();
      }
      if (cursor !== undefined && limit !== undefined) {
        throw V2ApiError.invalidRequest();
      }
      let pageSize: number = supportTicketListLimits.default;
      let before:
        { readonly createdAt: string; readonly ticketId: string } | undefined;
      if (typeof cursor === "string") {
        let continuation;
        try {
          continuation = codec.decode({
            ownerId: principal.userId,
            route: listCursorRoute,
            filter: listCursorFilter,
            cursor,
          });
        } catch (error) {
          if (error instanceof InvalidV2CursorError) {
            throw V2ApiError.invalidRequest();
          }
          throw error;
        }
        const createdAt = continuation["createdAt"];
        const ticketId = continuation["ticketId"];
        const size = continuation["limit"];
        if (
          typeof createdAt !== "string" ||
          typeof ticketId !== "string" ||
          typeof size !== "number"
        ) {
          throw V2ApiError.invalidRequest();
        }
        before = { createdAt, ticketId };
        pageSize = size;
      } else if (limit !== undefined) {
        if (
          typeof limit !== "number" ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > supportTicketListLimits.maximum
        ) {
          throw V2ApiError.invalidRequest();
        }
        pageSize = limit;
      } else if (cursor !== undefined) {
        throw V2ApiError.invalidRequest();
      }
      let page;
      try {
        page = await input.repository.list({
          ownerUserId: principal.userId,
          limit: pageSize,
          ...(before === undefined ? {} : { before }),
        });
      } catch (error) {
        return translate(error);
      }
      const last = page.items.at(-1);
      return Object.freeze({
        items: Object.freeze(page.items.map(project)),
        nextCursor:
          page.hasMore && last !== undefined
            ? codec.encode({
                ownerId: principal.userId,
                route: listCursorRoute,
                filter: listCursorFilter,
                continuation: {
                  createdAt: last.createdAtCursor,
                  ticketId: last.ticketId,
                  limit: pageSize,
                },
              })
            : null,
        attachments,
        policy: supportResponsePolicy,
        contractVersion: v2ContractVersion,
      });
    },
  };
  return Object.freeze(service);
}
