import type {
  SpotIntentRecord,
  SpotIntentRepository,
} from "../../database/spot-intent-repository.js";
import { parseSpotIntentResource } from "./spot-intent-contract.js";
import {
  SpotIntentExpiredError,
  SpotIntentNotFoundError,
  type SpotIntentWorkflow,
} from "./spot-intent-service.js";
import { SpotUnavailableError } from "./spot-errors.js";

export interface CreateDefaultClosedSpotIntentWorkflowInput {
  readonly repository: SpotIntentRepository;
}

function unavailable(): never {
  throw new SpotUnavailableError();
}

function publicResource(
  record: SpotIntentRecord,
  ownerUserId: string,
  intentId: string,
) {
  try {
    const resource = parseSpotIntentResource(record.resource);
    if (
      record.ownerUserId !== ownerUserId ||
      record.id !== intentId ||
      resource.intent_id !== intentId ||
      resource.state !== record.state ||
      resource.review.review_digest !== record.reviewSha256 ||
      resource.created_at !== record.createdAt ||
      resource.updated_at !== record.updatedAt ||
      JSON.stringify(resource.review) !== JSON.stringify(record.publicReview) ||
      JSON.stringify(resource.result) !== JSON.stringify(record.result)
    ) {
      return unavailable();
    }
    return resource;
  } catch {
    return unavailable();
  }
}

export function createDefaultClosedSpotIntentWorkflow(
  input: CreateDefaultClosedSpotIntentWorkflowInput,
): SpotIntentWorkflow {
  async function findOwned(
    ownerUserId: string,
    intentId: string,
  ): Promise<ReturnType<typeof parseSpotIntentResource>> {
    let record: SpotIntentRecord | null;
    try {
      record = await input.repository.findOwned(ownerUserId, intentId);
    } catch {
      return unavailable();
    }
    if (record === null) {
      throw new SpotIntentNotFoundError();
    }
    return publicResource(record, ownerUserId, intentId);
  }

  return Object.freeze({
    prepare(): Promise<never> {
      return Promise.reject(new SpotUnavailableError());
    },
    async findOwned(
      workflowInput: Parameters<SpotIntentWorkflow["findOwned"]>[0],
    ) {
      return findOwned(workflowInput.ownerUserId, workflowInput.intentId);
    },
    async submit(workflowInput: Parameters<SpotIntentWorkflow["submit"]>[0]) {
      const resource = await findOwned(
        workflowInput.ownerUserId,
        workflowInput.intentId,
      );
      if (resource.state === "expired") {
        throw new SpotIntentExpiredError();
      }
      if (resource.state === "prepared") {
        return unavailable();
      }
      return resource;
    },
  });
}
