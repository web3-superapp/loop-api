import { isIpfsCid } from "./media-contract.js";

/**
 * Decision 0173: pins a project NFT picture to IPFS. Filebase implements it
 * through its IPFS RPC API (`POST <FILEBASE_RPC_ENDPOINT>/api/v0/add`,
 * multipart `file`, `Authorization: Bearer <FILEBASE_RPC_TOKEN>`), which
 * stores the object in the token's bucket and answers
 * `{"Name","Hash","Size"}`. The token never leaves this module: it is not
 * logged, not put in an error message, and not returned.
 */
export interface IpfsPinner {
  /** The public gateway the returned CID is served from. */
  readonly gatewayBaseUrl: string;
  /** Pins the bytes; resolves to the CID. Fails with IpfsPinUnavailableError. */
  pin(input: {
    readonly bytes: Buffer;
    readonly fileName: string;
  }): Promise<string>;
}

export class IpfsPinUnavailableError extends Error {
  readonly code = "ipfs_pin_unavailable";

  constructor(readonly reason: "timeout" | "http" | "malformed" | "network") {
    super(`IPFS pin unavailable (${reason})`);
    this.name = "IpfsPinUnavailableError";
  }
}

export const filebasePinTimeoutMs = 10_000;

export function createFilebaseRpcPinner(options: {
  readonly rpcEndpoint: string;
  readonly rpcToken: string;
  readonly gatewayBaseUrl: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}): IpfsPinner {
  const doFetch = options.fetch ?? fetch;
  const endpoint = `${options.rpcEndpoint.replace(/\/+$/u, "")}/api/v0/add`;
  const timeoutMs = options.timeoutMs ?? filebasePinTimeoutMs;
  return Object.freeze({
    gatewayBaseUrl: options.gatewayBaseUrl.replace(/\/+$/u, ""),
    async pin(input: {
      readonly bytes: Buffer;
      readonly fileName: string;
    }): Promise<string> {
      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array(input.bytes)], { type: "image/webp" }),
        input.fileName,
      );
      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${options.rpcToken}` },
          body: form,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new IpfsPinUnavailableError(
          error instanceof Error &&
            (error.name === "TimeoutError" || error.name === "AbortError")
            ? "timeout"
            : "network",
        );
      }
      if (!response.ok) {
        // Drain without reading the body into an error (it may echo input).
        await response.body?.cancel().catch(() => undefined);
        throw new IpfsPinUnavailableError("http");
      }
      let body: unknown;
      try {
        body = JSON.parse(await response.text());
      } catch {
        throw new IpfsPinUnavailableError("malformed");
      }
      const hash =
        typeof body === "object" && body !== null && "Hash" in body
          ? (body as { readonly Hash: unknown }).Hash
          : undefined;
      if (!isIpfsCid(hash)) {
        throw new IpfsPinUnavailableError("malformed");
      }
      return hash;
    },
  });
}
