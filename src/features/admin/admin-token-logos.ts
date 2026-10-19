import type {
  TokenLogoAuditRef,
  TokenLogoCacheRecord,
  TokenLogoCacheRepository,
} from "../../database/token-logo-cache-repository.js";
import {
  normalizeTokenLogo,
  tokenLogoNormalizedContentType,
  type TokenLogoNormalizer,
} from "../market/token-logo-normalize.js";
import {
  sniffTokenLogoContentType,
  tokenLogoEtag,
} from "../market/token-logo-proxy.js";
import {
  tokenLogoProxyPath,
  tokenLogoProxyReadChainIds,
} from "../market/token-logo.js";
import { AdminApiError } from "./admin-contract.js";
import type { AdminWriteContext } from "./admin-service.js";

/**
 * Decision 0161 §3: the console's manual token logo override.
 *
 * - `get` (console.read): the cached row's state, never its bytes.
 * - `override` (console.write): an uploaded PNG / JPEG / WebP / GIF
 *   (≤ 2 MiB, by signature only) is normalised exactly like a fetched
 *   picture (128 x 128 WebP) and stored as `source = manual`; the proxy then
 *   serves it until it is cleared and never refetches or overwrites it.
 * - `clear` (console.write): removes the manual row; the next request or
 *   pre-warm pass fetches the upstream picture again.
 *
 * Each write and its `admin_audit_log` row (`market.logo.override` /
 * `market.logo.override_clear`, target `token_logo`, `<chainId>/<address>`)
 * commit in one transaction; the audit holds the ETag and size, never the
 * bytes.
 */

export const tokenLogoUploadMaximumBytes = 2 * 1024 * 1024;

export const adminTokenLogoReasonCodes = Object.freeze({
  uploadInvalid: "TOKEN_LOGO_UPLOAD_INVALID",
  typeUnsupported: "TOKEN_LOGO_TYPE_UNSUPPORTED",
  tooLarge: "TOKEN_LOGO_TOO_LARGE",
  decodeFailed: "TOKEN_LOGO_DECODE_FAILED",
  notCached: "TOKEN_LOGO_NOT_CACHED",
  overrideNotFound: "TOKEN_LOGO_OVERRIDE_NOT_FOUND",
  cacheUnavailable: "TOKEN_LOGO_CACHE_UNAVAILABLE",
} as const);

export interface AdminTokenLogoResource {
  readonly chainId: string;
  /** Lowercase `0x` address or `native`. */
  readonly address: string;
  readonly status: TokenLogoCacheRecord["status"];
  readonly source: TokenLogoCacheRecord["source"];
  readonly contentType: TokenLogoCacheRecord["contentType"];
  readonly etag: string | null;
  readonly byteLength: number | null;
  readonly fetchedAt: string;
  /** `null` for a manual picture (it never expires). */
  readonly expiresAt: string | null;
  /** The public proxy URL serving this picture. */
  readonly url: string;
}

export interface AdminTokenLogoService {
  get(
    chainId: string,
    address: string,
  ): Promise<{ readonly logo: AdminTokenLogoResource }>;
  override(
    context: AdminWriteContext,
    chainId: string,
    address: string,
    bytes: Buffer,
  ): Promise<{
    readonly logo: AdminTokenLogoResource;
    readonly audit: TokenLogoAuditRef;
  }>;
  clear(
    context: AdminWriteContext,
    chainId: string,
    address: string,
  ): Promise<{ readonly audit: TokenLogoAuditRef }>;
}

export interface CreateAdminTokenLogoServiceInput {
  readonly repository: TokenLogoCacheRepository | null;
  readonly publicBaseUrl: string;
  readonly normalize?: TokenLogoNormalizer;
  readonly now?: () => Date;
}

const addressPattern = /^(0x[0-9a-f]{40}|native)$/;

function invalidUpload(reasonCode: string): AdminApiError {
  return new AdminApiError("VALIDATION_FAILED", {
    reasonCode: adminTokenLogoReasonCodes.uploadInvalid,
    field: "file",
    logoReasonCode: reasonCode,
  });
}

export function createAdminTokenLogoService(
  input: CreateAdminTokenLogoServiceInput,
): AdminTokenLogoService {
  const normalize = input.normalize ?? normalizeTokenLogo;
  const now = input.now ?? ((): Date => new Date());
  const base = input.publicBaseUrl.replace(/\/+$/, "");

  const unavailable = (): AdminApiError =>
    new AdminApiError("CAPABILITY_UNAVAILABLE", {
      reasonCode: adminTokenLogoReasonCodes.cacheUnavailable,
    });

  function key(
    chainId: string,
    rawAddress: string,
  ): { chainId: string; address: string } {
    const address = rawAddress.toLowerCase();
    if (
      !(tokenLogoProxyReadChainIds as readonly string[]).includes(chainId) ||
      !addressPattern.test(address)
    ) {
      throw new AdminApiError("INVALID_REQUEST");
    }
    return { chainId, address };
  }

  async function guarded<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AdminApiError) throw error;
      throw unavailable();
    }
  }

  function resource(record: TokenLogoCacheRecord): AdminTokenLogoResource {
    return Object.freeze({
      chainId: record.chainId,
      address: record.address,
      status: record.status,
      source: record.source,
      contentType: record.contentType,
      etag: record.etag,
      byteLength: record.bytes === null ? null : record.bytes.length,
      fetchedAt: record.fetchedAt,
      expiresAt: record.source === "manual" ? null : record.expiresAt,
      url: `${base}${tokenLogoProxyPath(
        record.chainId,
        record.address === "native" ? null : record.address,
      )}`,
    });
  }

  function repository(): TokenLogoCacheRepository {
    if (input.repository === null) throw unavailable();
    return input.repository;
  }

  return Object.freeze({
    async get(chainId: string, rawAddress: string) {
      const target = key(chainId, rawAddress);
      const store = repository();
      const record = await guarded(() =>
        store.get(target.chainId, target.address),
      );
      if (record === null) {
        throw new AdminApiError("NOT_FOUND", {
          reasonCode: adminTokenLogoReasonCodes.notCached,
        });
      }
      return Object.freeze({ logo: resource(record) });
    },

    async override(
      context: AdminWriteContext,
      chainId: string,
      rawAddress: string,
      bytes: Buffer,
    ) {
      const target = key(chainId, rawAddress);
      const store = repository();
      const putManual = store.putManual?.bind(store);
      if (putManual === undefined) throw unavailable();
      if (bytes.length > tokenLogoUploadMaximumBytes) {
        throw invalidUpload(adminTokenLogoReasonCodes.tooLarge);
      }
      const sniffed = sniffTokenLogoContentType(bytes);
      if (sniffed === null) {
        throw invalidUpload(adminTokenLogoReasonCodes.typeUnsupported);
      }
      const normalized = await normalize(bytes);
      if (normalized === null) {
        throw invalidUpload(adminTokenLogoReasonCodes.decodeFailed);
      }
      const written = await guarded(() =>
        putManual(
          {
            chainId: target.chainId,
            address: target.address,
            bytes: normalized,
            contentType: tokenLogoNormalizedContentType,
            etag: tokenLogoEtag(normalized),
            at: now().toISOString(),
          },
          {
            actor: context.session.actor,
            actorAccountId: context.session.accountId,
            requestId: context.requestId,
          },
        ),
      );
      return Object.freeze({
        logo: resource(written.record),
        audit: Object.freeze({ ...written.audit }),
      });
    },

    async clear(
      context: AdminWriteContext,
      chainId: string,
      rawAddress: string,
    ) {
      const target = key(chainId, rawAddress);
      const store = repository();
      const clearManual = store.clearManual?.bind(store);
      if (clearManual === undefined) throw unavailable();
      const cleared = await guarded(() =>
        clearManual(target.chainId, target.address, {
          actor: context.session.actor,
          actorAccountId: context.session.accountId,
          requestId: context.requestId,
        }),
      );
      if (cleared === null) {
        throw new AdminApiError("NOT_FOUND", {
          reasonCode: adminTokenLogoReasonCodes.overrideNotFound,
        });
      }
      return Object.freeze({ audit: Object.freeze({ ...cleared.audit }) });
    },
  });
}
