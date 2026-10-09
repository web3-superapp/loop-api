import type {
  SupportTicketActor,
  SupportTicketCategory,
  SupportTicketEventType,
  SupportTicketStatus,
} from "./support-contract.js";

export interface SupportTicketEventRecord {
  readonly eventVersion: number;
  readonly eventType: SupportTicketEventType;
  readonly actor: SupportTicketActor;
  readonly note: string | null;
  readonly occurredAt: string;
}

export interface SupportTicketRecord {
  readonly ticketId: string;
  readonly ownerUserId: string;
  readonly category: SupportTicketCategory;
  readonly body: string;
  readonly status: SupportTicketStatus;
  readonly createdAt: string;
  /** Microsecond-precise `createdAt` for keyset cursors; never projected. */
  readonly createdAtCursor: string;
  readonly updatedAt: string;
  readonly lastEventAt: string;
  readonly events: readonly SupportTicketEventRecord[];
}

export interface CreateSupportTicketInput {
  readonly ownerUserId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly requestId: string;
  readonly category: SupportTicketCategory;
  readonly body: string;
}

export interface CreateSupportTicketResult {
  readonly created: boolean;
  readonly ticket: SupportTicketRecord;
}

export interface ListSupportTicketsInput {
  readonly ownerUserId: string;
  readonly limit: number;
  readonly before?: {
    readonly createdAt: string;
    readonly ticketId: string;
  };
}

export interface SupportTicketPage {
  readonly items: readonly SupportTicketRecord[];
  readonly hasMore: boolean;
}

export interface AdvanceSupportTicketInput {
  readonly ticketId: string;
  readonly eventType: "answered" | "closed";
  readonly note: string | null;
  readonly requestId: string;
}

export interface SupportTicketRepository {
  create(input: CreateSupportTicketInput): Promise<CreateSupportTicketResult>;
  list(input: ListSupportTicketsInput): Promise<SupportTicketPage>;
  /**
   * Operator-only status advance (Dev script). `open → answered`,
   * `open|answered → closed`; any other transition is a state error.
   */
  advance(input: AdvanceSupportTicketInput): Promise<SupportTicketRecord>;
}

export class SupportTicketIdempotencyConflictError extends Error {
  constructor() {
    super("The support ticket idempotency key conflicts with another request");
    this.name = "SupportTicketIdempotencyConflictError";
  }
}

export class SupportTicketRateLimitedError extends Error {
  constructor() {
    super("The support ticket creation quota is exhausted");
    this.name = "SupportTicketRateLimitedError";
  }
}

export class SupportTicketNotFoundError extends Error {
  constructor() {
    super("The support ticket does not exist");
    this.name = "SupportTicketNotFoundError";
  }
}

export class SupportTicketStateError extends Error {
  constructor() {
    super("The support ticket cannot move to the requested status");
    this.name = "SupportTicketStateError";
  }
}

export class SupportTicketRepositoryUnavailableError extends Error {
  constructor() {
    super("The support ticket repository is unavailable");
    this.name = "SupportTicketRepositoryUnavailableError";
  }
}

function unavailable(): Promise<never> {
  return Promise.reject(new SupportTicketRepositoryUnavailableError());
}

export function createUnavailableSupportTicketRepository(): SupportTicketRepository {
  return Object.freeze({
    create: unavailable,
    list: unavailable,
    advance: unavailable,
  });
}
