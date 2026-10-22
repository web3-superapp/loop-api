import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import {
  createFilebaseRpcPinner,
  IpfsPinUnavailableError,
} from "../src/features/media/ipfs-pinner.js";

/** Decision 0173: the Filebase IPFS RPC pinner. */

const cid = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const token = "test-token-not-a-secret";

function pinnerWith(fetchImpl: typeof fetch) {
  return createFilebaseRpcPinner({
    rpcEndpoint: "https://rpc.example.test/",
    rpcToken: token,
    gatewayBaseUrl: "https://gateway.example.test/ipfs/",
    fetch: fetchImpl,
  });
}

describe("Filebase RPC pinner (Decision 0173)", () => {
  it("posts one multipart `file` with the bearer token and returns the Hash", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ Name: "a.webp", Hash: cid, Size: "3" })),
      ),
    );
    const pinner = pinnerWith(fetchImpl);
    expect(pinner.gatewayBaseUrl).toBe("https://gateway.example.test/ipfs");
    await expect(
      pinner.pin({ bytes: Buffer.from("abc"), fileName: "a.webp" }),
    ).resolves.toBe(cid);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://rpc.example.test/api/v0/add");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ authorization: `Bearer ${token}` });
    const form = init?.body as FormData;
    const file = form.get("file") as File;
    expect(file.name).toBe("a.webp");
    expect(Buffer.from(await file.arrayBuffer()).toString()).toBe("abc");
  });

  it("fails closed on HTTP errors, malformed answers and network errors, never echoing the token", async () => {
    const cases: [() => Promise<Response>, string][] = [
      () => Promise.resolve(new Response("nope", { status: 401 })),
      () => Promise.resolve(new Response("not json")),
      () => Promise.resolve(new Response(JSON.stringify({ Hash: "x" }))),
      () => Promise.reject(new TypeError("fetch failed")),
    ].map((f, index) => [f, String(index)]);
    for (const [impl, label] of cases) {
      const error = await pinnerWith(vi.fn<typeof fetch>(impl))
        .pin({ bytes: Buffer.from("abc"), fileName: "a.webp" })
        .catch((caught: unknown) => caught);
      expect(error, label).toBeInstanceOf(IpfsPinUnavailableError);
      expect(String((error as Error).message)).not.toContain(token);
    }
  });
});

// Opt-in live check against Filebase: runs only when the Filebase RPC
// variables are in the environment (never in CI); prints nothing secret.
const liveEndpoint = process.env["FILEBASE_RPC_ENDPOINT"];
const liveToken = process.env["FILEBASE_RPC_TOKEN"];
describe.skipIf(
  liveEndpoint === undefined ||
    liveEndpoint === "" ||
    liveToken === undefined ||
    liveToken === "",
)("Filebase RPC pinner live (Decision 0173, opt-in)", () => {
  it("pins a small WebP and the gateway serves it", async () => {
    const gateway =
      process.env["IPFS_GATEWAY_BASE_URL"] ?? "https://ipfs.filebase.io/ipfs";
    const bytes = await sharp({
      create: { width: 64, height: 64, channels: 3, background: "#c6f432" },
    })
      .webp()
      .toBuffer();
    const pinner = createFilebaseRpcPinner({
      rpcEndpoint: liveEndpoint ?? "",
      rpcToken: liveToken ?? "",
      gatewayBaseUrl: gateway,
    });
    const pinned = await pinner.pin({ bytes, fileName: "s274-live.webp" });
    expect(pinned).toMatch(/^(Qm|b)/);
    const served = await fetch(`${pinner.gatewayBaseUrl}/${pinned}`, {
      signal: AbortSignal.timeout(30_000),
    });
    expect(served.status).toBe(200);
    expect(Buffer.from(await served.arrayBuffer()).equals(bytes)).toBe(true);
  }, 60_000);
});
