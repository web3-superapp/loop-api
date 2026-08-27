import type { ReconciliationWorkerConfig } from "./config.js";
import type { ControlPlaneRepository } from "./database/control-plane-repository.js";
import type { PerpReconciliationRepository } from "./features/perp/perp-reconciliation-contract.js";
import { createPerpOrderReconciliationHandler } from "./features/perp/perp-order-reconciliation-handler.js";
import {
  createAuthoritativeReaderRegistry,
  type AuthoritativeReaderRegistry,
  type AuthoritativeReaderRegistryRegistration,
} from "./features/reconciliation/authoritative-reader.js";
import type { SpotReconciliationRepository } from "./features/spot/spot-reconciliation-contract.js";
import { createSpotOrderReconciliationHandler } from "./features/spot/spot-order-reconciliation-handler.js";
import { createPostgresHyperliquidInfoQuota } from "./integrations/hyperliquid/info-quota.js";
import { createLosslessHyperliquidInfoTransport } from "./integrations/hyperliquid/lossless-info-transport.js";
import { createHyperliquidPerpOrderReconciliationReader } from "./integrations/hyperliquid/perp-order-reconciliation-reader.js";
import { createHyperliquidSpotInfoTransport } from "./integrations/hyperliquid/spot-info-transport.js";
import { createHyperliquidSpotOrderReconciliationReader } from "./integrations/hyperliquid/spot-order-reconciliation-reader.js";

export interface ReconciliationWorkerReaderDatabase {
  readonly controlPlane: Pick<ControlPlaneRepository, "consumeIssuanceQuota">;
  readonly perpReconciliation: PerpReconciliationRepository;
  readonly spotReconciliation: SpotReconciliationRepository;
}

export interface CreateReconciliationWorkerReadersInput {
  readonly config: ReconciliationWorkerConfig;
  readonly database: ReconciliationWorkerReaderDatabase;
}

interface RuntimeHyperliquidInfoQuotaCapability {
  readonly quotaHmacSecret: string;
  readonly policyVersion: string;
  readonly windowDurationSeconds: number;
  readonly weightCapacity: number;
}

function quotaCapabilitiesConflict(
  left: RuntimeHyperliquidInfoQuotaCapability,
  right: RuntimeHyperliquidInfoQuotaCapability,
): boolean {
  return (
    left.quotaHmacSecret !== right.quotaHmacSecret ||
    left.policyVersion !== right.policyVersion ||
    left.windowDurationSeconds !== right.windowDurationSeconds ||
    left.weightCapacity !== right.weightCapacity
  );
}

/**
 * This is the sole production composition point for provider reconciliation.
 * The disabled branch constructs no transport, quota subject, or provider
 * handler. The enabled branch exposes only the reviewed atomic Testnet reader.
 */
export function createReconciliationWorkerReaders(
  input: CreateReconciliationWorkerReadersInput,
): AuthoritativeReaderRegistry {
  const perpCapability = input.config.hyperliquidReconciliationReads;
  const spotCapability = input.config.hyperliquidSpotReconciliationReads;
  if (perpCapability === null && spotCapability === null) {
    return createAuthoritativeReaderRegistry([]);
  }
  if (
    perpCapability !== null &&
    spotCapability !== null &&
    quotaCapabilitiesConflict(perpCapability, spotCapability)
  ) {
    throw new TypeError(
      "Hyperliquid reconciliation quota capabilities conflict",
    );
  }
  const capability = spotCapability ?? perpCapability;
  if (capability === null) {
    throw new TypeError("Hyperliquid reconciliation capability is missing");
  }

  const quota = createPostgresHyperliquidInfoQuota({
    repository: input.database.controlPlane,
    quotaHmacSecret: new TextEncoder().encode(capability.quotaHmacSecret),
    policy: capability,
  });
  const registrations: AuthoritativeReaderRegistryRegistration[] = [];

  if (perpCapability !== null) {
    const reader = createHyperliquidPerpOrderReconciliationReader({
      quota,
      transport: createLosslessHyperliquidInfoTransport(),
    });
    const handler = createPerpOrderReconciliationHandler({
      repository: input.database.perpReconciliation,
      reader,
    });
    registrations.push([
      "hyperliquid",
      "perp_intent",
      { mode: "atomic_domain", run: handler },
    ]);
  }

  if (spotCapability !== null) {
    const reader = createHyperliquidSpotOrderReconciliationReader({
      quota,
      transport: createHyperliquidSpotInfoTransport(),
    });
    const handler = createSpotOrderReconciliationHandler({
      repository: input.database.spotReconciliation,
      reader,
    });
    registrations.push([
      "hyperliquid",
      "spot_intent",
      { mode: "atomic_domain", run: handler },
    ]);
  }

  return createAuthoritativeReaderRegistry(registrations);
}
