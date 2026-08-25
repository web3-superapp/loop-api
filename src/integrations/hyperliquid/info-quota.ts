import { createHmac, createSecretKey } from "node:crypto";

import type { ControlPlaneRepository } from "../../database/control-plane-repository.js";
import type { HyperliquidInfoQuota } from "./info-private-reader.js";

const hmacDomain = "loop.hyperliquid.info.quota.v1\0global";
const minimumHmacSecretBytes = 32;
const maximumHmacSecretBytes = 4_096;

export const HYPERLIQUID_INFO_QUOTA_CAPABILITY = "hyperliquid_info";

export type HyperliquidInfoQuotaRepository = Pick<
  ControlPlaneRepository,
  "consumeIssuanceQuota"
>;

export interface HyperliquidInfoQuotaPolicy {
  readonly policyVersion: string;
  readonly windowDurationSeconds: number;
  readonly weightCapacity: number;
}

export interface CreatePostgresHyperliquidInfoQuotaInput {
  readonly repository: HyperliquidInfoQuotaRepository;
  readonly quotaHmacSecret: Uint8Array;
  readonly policy: HyperliquidInfoQuotaPolicy;
}

function validatePolicy(policy: HyperliquidInfoQuotaPolicy): void {
  if (
    policy.policyVersion !== "hyperliquid_info_v1" ||
    policy.windowDurationSeconds !== 60 ||
    !Number.isInteger(policy.weightCapacity) ||
    policy.weightCapacity < 1 ||
    policy.weightCapacity > 100_000
  ) {
    throw new TypeError("Hyperliquid Info quota policy is invalid");
  }
}

function deriveGlobalSubjectHmac(secret: Uint8Array): string {
  if (
    !(secret instanceof Uint8Array) ||
    secret.byteLength < minimumHmacSecretBytes ||
    secret.byteLength > maximumHmacSecretBytes
  ) {
    throw new TypeError("Hyperliquid Info quota HMAC secret is invalid");
  }

  const secretCopy = Uint8Array.from(secret);
  try {
    return createHmac("sha256", createSecretKey(secretCopy))
      .update(hmacDomain, "utf8")
      .digest("hex");
  } finally {
    secretCopy.fill(0);
  }
}

export function createPostgresHyperliquidInfoQuota(
  input: CreatePostgresHyperliquidInfoQuotaInput,
): HyperliquidInfoQuota {
  validatePolicy(input.policy);
  const globalSubjectHmac = deriveGlobalSubjectHmac(input.quotaHmacSecret);
  const policy = Object.freeze({ ...input.policy });

  return Object.freeze({
    async reserveWeight(cost: number, signal: AbortSignal) {
      if (!Number.isInteger(cost) || cost < 1 || cost > 100_000) {
        throw new TypeError("Hyperliquid Info quota cost is invalid");
      }

      signal.throwIfAborted();
      await input.repository.consumeIssuanceQuota({
        capability: HYPERLIQUID_INFO_QUOTA_CAPABILITY,
        policyVersion: policy.policyVersion,
        cost,
        buckets: [
          {
            subjectKind: "global",
            subjectHmac: globalSubjectHmac,
            windowDurationSeconds: policy.windowDurationSeconds,
            capacity: policy.weightCapacity,
          },
        ],
      });
      signal.throwIfAborted();
    },
  });
}
