import type { ReconciliationWorkerConfig } from "./config.js";
import type { ControlPlaneRepository } from "./database/control-plane-repository.js";
import type { PerpReconciliationRepository } from "./features/perp/perp-reconciliation-contract.js";
import { createPerpOrderReconciliationHandler } from "./features/perp/perp-order-reconciliation-handler.js";
import {
  createAuthoritativeReaderRegistry,
  type AuthoritativeReaderRegistry,
} from "./features/reconciliation/authoritative-reader.js";
import { createPostgresHyperliquidInfoQuota } from "./integrations/hyperliquid/info-quota.js";
import { createLosslessHyperliquidInfoTransport } from "./integrations/hyperliquid/lossless-info-transport.js";
import { createHyperliquidPerpOrderReconciliationReader } from "./integrations/hyperliquid/perp-order-reconciliation-reader.js";

export interface ReconciliationWorkerReaderDatabase {
  readonly controlPlane: Pick<ControlPlaneRepository, "consumeIssuanceQuota">;
  readonly perpReconciliation: PerpReconciliationRepository;
}

export interface CreateReconciliationWorkerReadersInput {
  readonly config: ReconciliationWorkerConfig;
  readonly database: ReconciliationWorkerReaderDatabase;
}

/**
 * This is the sole production composition point for provider reconciliation.
 * The disabled branch constructs no transport, quota subject, or provider
 * handler. The enabled branch exposes only the reviewed atomic Testnet reader.
 */
export function createReconciliationWorkerReaders(
  input: CreateReconciliationWorkerReadersInput,
): AuthoritativeReaderRegistry {
  const capability = input.config.hyperliquidReconciliationReads;
  if (capability === null) {
    return createAuthoritativeReaderRegistry([]);
  }

  const reader = createHyperliquidPerpOrderReconciliationReader({
    quota: createPostgresHyperliquidInfoQuota({
      repository: input.database.controlPlane,
      quotaHmacSecret: new TextEncoder().encode(capability.quotaHmacSecret),
      policy: capability,
    }),
    transport: createLosslessHyperliquidInfoTransport(),
  });
  const handler = createPerpOrderReconciliationHandler({
    repository: input.database.perpReconciliation,
    reader,
  });

  return createAuthoritativeReaderRegistry([
    ["hyperliquid", { mode: "atomic_domain", run: handler }],
  ]);
}
