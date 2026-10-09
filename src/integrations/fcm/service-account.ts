import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";

import { z } from "zod";

/**
 * Firebase service-account credential loading (Decision 0067).
 *
 * The credential is a file path, never an environment value: the private key
 * must not appear in a process listing, a log line, or a config projection.
 * Nothing here returns the key to a caller that is not the FCM sender, and no
 * failure message repeats file content.
 */

const serviceAccountSchema = z
  .object({
    type: z.literal("service_account"),
    project_id: z.string().min(1).max(255),
    private_key_id: z.string().min(1).max(255).optional(),
    private_key: z.string().min(1),
    client_email: z.string().email(),
    token_uri: z.string().url().optional(),
  })
  .loose();

export interface FirebaseServiceAccount {
  readonly projectId: string;
  readonly clientEmail: string;
  readonly privateKeyPem: string;
  readonly tokenUri: string;
}

export const googleOauthTokenUri = "https://oauth2.googleapis.com/token";

export type FirebaseServiceAccountLoadFailure =
  | "PUSH_CREDENTIAL_FILE_UNREADABLE"
  | "PUSH_CREDENTIAL_FILE_MALFORMED"
  | "PUSH_CREDENTIAL_FILE_INVALID";

export class FirebaseServiceAccountError extends Error {
  constructor(readonly reasonCode: FirebaseServiceAccountLoadFailure) {
    super(`Firebase service account unusable: ${reasonCode}`);
    this.name = "FirebaseServiceAccountError";
  }
}

export function parseFirebaseServiceAccount(
  contents: string,
): FirebaseServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new FirebaseServiceAccountError("PUSH_CREDENTIAL_FILE_MALFORMED");
  }
  const account = serviceAccountSchema.safeParse(parsed);
  if (!account.success) {
    throw new FirebaseServiceAccountError("PUSH_CREDENTIAL_FILE_INVALID");
  }
  const privateKeyPem = account.data.private_key.replaceAll("\\n", "\n");
  // Parse the PEM once here rather than matching its header: a key that
  // node:crypto refuses is unusable, and the failure surfaces at startup
  // instead of at the first push. The parsed key is discarded; the signer
  // reads the PEM.
  try {
    createPrivateKey(privateKeyPem);
  } catch {
    throw new FirebaseServiceAccountError("PUSH_CREDENTIAL_FILE_INVALID");
  }
  return Object.freeze({
    projectId: account.data.project_id,
    clientEmail: account.data.client_email,
    privateKeyPem,
    tokenUri: account.data.token_uri ?? googleOauthTokenUri,
  });
}

/**
 * Reads and validates the credential once, at composition time. A missing or
 * unusable file is not an error the process dies on: the push capability
 * stays deferred and everything else keeps running.
 */
export function loadFirebaseServiceAccount(
  path: string,
  readFile: (target: string) => string = (target) =>
    readFileSync(target, "utf8"),
): FirebaseServiceAccount {
  let contents: string;
  try {
    contents = readFile(path);
  } catch {
    throw new FirebaseServiceAccountError("PUSH_CREDENTIAL_FILE_UNREADABLE");
  }
  return parseFirebaseServiceAccount(contents);
}
