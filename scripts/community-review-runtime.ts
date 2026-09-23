import pg from "pg";

import { createPostgresCommunityRepository } from "../src/database/community-repository.js";
import { createPostgresNotificationRepository } from "../src/database/notification-repository.js";
import { createPostgresPushRepository } from "../src/database/push-repository.js";
import {
  createCommunityReviewService,
  type CommunityReviewService,
} from "../src/features/community/community-review-service.js";
import { createPushDispatchService } from "../src/features/push/push-dispatch-service.js";
import {
  createFcmSender,
  nodeFcmFetch,
  type FcmSender,
} from "../src/integrations/fcm/fcm-sender.js";
import {
  FirebaseServiceAccountError,
  loadFirebaseServiceAccount,
} from "../src/integrations/fcm/service-account.js";

/**
 * Shared composition for the two Dev-only review scripts (Decision 0072).
 *
 * One pool, the community repository, the notification repository, and —
 * only when `FIREBASE_SERVICE_ACCOUNT_JSON_PATH` names a usable file — the
 * FCM sender behind the push dispatch service. Without the credential the
 * push is composed as absent and the script says so; it is never faked.
 */

export interface CommunityReviewRuntime {
  readonly service: CommunityReviewService;
  /** Null (with the reason) when no push sender could be composed. */
  readonly pushReasonCode: string | null;
  readonly close: () => Promise<void>;
}

export type CreateCommunityReviewRuntime = (input: {
  readonly databaseUrl: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly stderr: { readonly write: (contents: string) => unknown };
}) => CommunityReviewRuntime;

function composeFcmSender(
  environment: NodeJS.ProcessEnv,
): { readonly sender: FcmSender } | { readonly reasonCode: string } {
  const path = environment["FIREBASE_SERVICE_ACCOUNT_JSON_PATH"]?.trim();
  if (path === undefined || path === "") {
    return { reasonCode: "PUSH_RUNTIME_DEFERRED" };
  }
  try {
    return {
      sender: createFcmSender({
        account: loadFirebaseServiceAccount(path),
        fetch: nodeFcmFetch,
      }),
    };
  } catch (error) {
    return {
      reasonCode:
        error instanceof FirebaseServiceAccountError
          ? error.reasonCode
          : "PUSH_CREDENTIAL_FILE_UNREADABLE",
    };
  }
}

export const createCommunityReviewRuntime: CreateCommunityReviewRuntime = (
  input,
) => {
  const pool = new pg.Pool({
    application_name: "loop-api-community-review",
    connectionString: input.databaseUrl,
    max: 2,
  });
  const logger = {
    warn(context: Record<string, unknown>, message: string): void {
      input.stderr.write(`${message} ${JSON.stringify(context)}\n`);
    },
  };
  const fcm = composeFcmSender(input.environment);
  const push =
    "sender" in fcm
      ? createPushDispatchService({
          repository: createPostgresPushRepository(pool),
          sender: fcm.sender,
          logger,
        })
      : null;
  return {
    service: createCommunityReviewService({
      repository: createPostgresCommunityRepository(pool),
      notifications: createPostgresNotificationRepository(pool),
      push,
      logger,
    }),
    pushReasonCode: "sender" in fcm ? null : fcm.reasonCode,
    close: () => pool.end(),
  };
};
