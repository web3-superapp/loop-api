import { createSign } from "node:crypto";

import { z } from "zod";

import {
  pushEventDictionary,
  pushReasonCodes,
  type PushPayload,
  type PushPlatform,
} from "../../features/push/push-contract.js";
import type { FirebaseServiceAccount } from "./service-account.js";

/**
 * FCM HTTP v1 sender (Decision 0067).
 *
 * Both platforms go through FCM: Android natively, iOS through the APNs key
 * uploaded to the same Firebase project. LOOP therefore holds one credential
 * and never talks to APNs directly.
 *
 * The access token is a service-account JWT exchanged for an OAuth2 bearer
 * (RFC 7523), signed here with `node:crypto` so no Google SDK, and no new
 * dependency, enters the runtime. The token is cached until shortly before it
 * expires; a refresh failure is a transient outcome, never a silent success.
 *
 * The message body carries the pointer payload as `data` plus localization
 * keys for the visible text. No server-authored string, amount, address, or
 * code is ever put on the wire.
 */

export const fcmScope = "https://www.googleapis.com/auth/firebase.messaging";
export const fcmSendBaseUrl = "https://fcm.googleapis.com/v1/projects";
const accessTokenSkewSeconds = 60;
const defaultTimeoutMs = 8_000;

export type FcmFetch = (
  input: string,
  init: {
    readonly method: "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly signal: AbortSignal;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}>;

export type FcmSendOutcome =
  | { readonly outcome: "sent"; readonly providerMessageRef: string | null }
  /** The device is gone: the token row must be retired. */
  | { readonly outcome: "invalidToken"; readonly reasonCode: string }
  /** Credentials rejected: the capability, not the token, is the problem. */
  | { readonly outcome: "unauthorized"; readonly reasonCode: string }
  | { readonly outcome: "transient"; readonly reasonCode: string };

export interface FcmSender {
  readonly projectId: string;
  send(input: {
    readonly token: string;
    readonly platform: PushPlatform;
    readonly payload: PushPayload;
    readonly signal?: AbortSignal;
  }): Promise<FcmSendOutcome>;
}

const accessTokenSchema = z
  .object({
    access_token: z.string().min(1),
    expires_in: z.number().int().positive(),
  })
  .loose();

const errorBodySchema = z
  .object({
    error: z
      .object({
        status: z.string().optional(),
        details: z
          .array(z.object({ errorCode: z.string().optional() }).loose())
          .optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

const sendResponseSchema = z
  .object({ name: z.string().min(1).max(200).optional() })
  .loose();

function base64Url(value: Buffer | string): string {
  return (typeof value === "string" ? Buffer.from(value, "utf8") : value)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** RS256 service-account assertion, RFC 7523 §2.1. */
export function createServiceAccountAssertion(input: {
  readonly account: FirebaseServiceAccount;
  readonly issuedAtSeconds: number;
  readonly lifetimeSeconds?: number;
}): string {
  const lifetime = input.lifetimeSeconds ?? 3_600;
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(
    JSON.stringify({
      iss: input.account.clientEmail,
      scope: fcmScope,
      aud: input.account.tokenUri,
      iat: input.issuedAtSeconds,
      exp: input.issuedAtSeconds + lifetime,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  signer.end();
  return `${header}.${claims}.${base64Url(
    signer.sign(input.account.privateKeyPem),
  )}`;
}

/**
 * Data-only keys plus localization keys. `data` values are strings by FCM
 * contract; the four keys are the closed payload set of Decision 0067.
 */
export function createFcmMessage(input: {
  readonly token: string;
  readonly payload: PushPayload;
}): Record<string, unknown> {
  const definition = pushEventDictionary[input.payload.type];
  return {
    message: {
      token: input.token,
      data: {
        type: input.payload.type,
        entityRef: input.payload.entityRef,
        contextRoute: input.payload.contextRoute,
        eventVersion: input.payload.eventVersion,
      },
      android: {
        priority: definition.mandatory ? "high" : "normal",
        notification: {
          title_loc_key: definition.titleLocKey,
          body_loc_key: definition.bodyLocKey,
        },
      },
      apns: {
        headers: {
          "apns-priority": definition.mandatory ? "10" : "5",
        },
        payload: {
          aps: {
            alert: {
              "title-loc-key": definition.titleLocKey,
              "loc-key": definition.bodyLocKey,
            },
            sound: "default",
          },
        },
      },
    },
  };
}

/** Provider verdict mapping; anything unrecognised stays transient. */
export function classifyFcmFailure(
  status: number,
  body: string,
): FcmSendOutcome {
  let errorCode: string | undefined;
  let errorStatus: string | undefined;
  try {
    const parsed = errorBodySchema.safeParse(JSON.parse(body));
    if (parsed.success) {
      errorStatus = parsed.data.error?.status;
      errorCode = parsed.data.error?.details?.find(
        (detail) => detail.errorCode !== undefined,
      )?.errorCode;
    }
  } catch {
    errorCode = undefined;
  }
  if (
    status === 404 ||
    errorCode === "UNREGISTERED" ||
    errorStatus === "NOT_FOUND"
  ) {
    return Object.freeze({
      outcome: "invalidToken" as const,
      reasonCode: pushReasonCodes.tokenUnregistered,
    });
  }
  if (status === 400 || errorStatus === "INVALID_ARGUMENT") {
    // FCM answers INVALID_ARGUMENT for a malformed registration token; the
    // message body is built by LOOP and validated before the call, so the
    // token is the only field a device can make invalid.
    return Object.freeze({
      outcome: "invalidToken" as const,
      reasonCode: pushReasonCodes.providerRejected,
    });
  }
  if (status === 401 || status === 403) {
    return Object.freeze({
      outcome: "unauthorized" as const,
      reasonCode: pushReasonCodes.providerUnauthorized,
    });
  }
  return Object.freeze({
    outcome: "transient" as const,
    reasonCode: pushReasonCodes.providerUnreachable,
  });
}

function combineSignals(
  timeoutMs: number,
  external: AbortSignal | undefined,
): { readonly signal: AbortSignal; readonly done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  const done = (): void => {
    clearTimeout(timer);
  };
  if (external !== undefined) {
    if (external.aborted) {
      controller.abort();
    } else {
      external.addEventListener(
        "abort",
        () => {
          controller.abort();
        },
        { once: true },
      );
    }
  }
  return { signal: controller.signal, done };
}

export interface CreateFcmSenderInput {
  readonly account: FirebaseServiceAccount;
  readonly fetch: FcmFetch;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

export function createFcmSender(input: CreateFcmSenderInput): FcmSender {
  const now = input.now ?? ((): Date => new Date());
  const timeoutMs = input.timeoutMs ?? defaultTimeoutMs;
  let cached: { readonly token: string; readonly expiresAtMs: number } | null =
    null;

  async function accessToken(
    signal: AbortSignal | undefined,
  ): Promise<string | null> {
    const currentMs = now().getTime();
    if (cached !== null && cached.expiresAtMs > currentMs) {
      return cached.token;
    }
    const assertion = createServiceAccountAssertion({
      account: input.account,
      issuedAtSeconds: Math.floor(currentMs / 1_000),
    });
    const combined = combineSignals(timeoutMs, signal);
    let response;
    try {
      response = await input.fetch(input.account.tokenUri, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }).toString(),
        signal: combined.signal,
      });
    } catch {
      return null;
    } finally {
      combined.done();
    }
    if (!response.ok) {
      return null;
    }
    let parsed;
    try {
      parsed = accessTokenSchema.safeParse(JSON.parse(await response.text()));
    } catch {
      return null;
    }
    if (!parsed.success) {
      return null;
    }
    cached = Object.freeze({
      token: parsed.data.access_token,
      expiresAtMs:
        currentMs + (parsed.data.expires_in - accessTokenSkewSeconds) * 1_000,
    });
    return cached.token;
  }

  const sender: FcmSender = {
    projectId: input.account.projectId,
    async send({ token, payload, signal }) {
      const bearer = await accessToken(signal);
      if (bearer === null) {
        return Object.freeze({
          outcome: "unauthorized" as const,
          reasonCode: pushReasonCodes.providerUnauthorized,
        });
      }
      const combined = combineSignals(timeoutMs, signal);
      let response;
      try {
        response = await input.fetch(
          `${fcmSendBaseUrl}/${input.account.projectId}/messages:send`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${bearer}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(createFcmMessage({ token, payload })),
            signal: combined.signal,
          },
        );
      } catch {
        return Object.freeze({
          outcome: "transient" as const,
          reasonCode: pushReasonCodes.providerUnreachable,
        });
      } finally {
        combined.done();
      }
      const body = await response.text();
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          // Force a refresh on the next attempt rather than reusing a
          // bearer the Provider has already refused.
          cached = null;
        }
        return classifyFcmFailure(response.status, body);
      }
      let providerMessageRef: string | null;
      try {
        const parsed = sendResponseSchema.safeParse(JSON.parse(body));
        providerMessageRef = parsed.success ? (parsed.data.name ?? null) : null;
      } catch {
        providerMessageRef = null;
      }
      return Object.freeze({ outcome: "sent" as const, providerMessageRef });
    },
  };
  return Object.freeze(sender);
}

export const nodeFcmFetch: FcmFetch = (url, init) =>
  fetch(url, {
    method: init.method,
    headers: { ...init.headers },
    body: init.body,
    signal: init.signal,
  });
