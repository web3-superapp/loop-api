import { generateKeyPairSync, randomUUID, verify } from "node:crypto";

import {
  formatRequestForAuthorizationSignature,
  generateAuthorizationSignature,
} from "@privy-io/node";
import { describe, expect, it, vi } from "vitest";

import { createSwapService } from "../src/features/wallet-intents/swap-service.js";
import {
  createPrivySwapAdapter,
  swapActionTransactionHash,
  type PrivySwapClient,
  type PrivySwapRequestParams,
} from "../src/integrations/privy/swap-adapter.js";
import {
  principal,
  runtimeFake,
  swapAdapterFake,
  usdtAssetId,
  walletId,
  wbnbAssetId,
} from "./wallet-intent-fakes.js";

/**
 * Decision 0198: the authorizationPayload LOOP hands the device is the exact
 * request Privy verifies. The test signs the payload the way Privy's own SDK
 * does (RFC 8785 canonical JSON, P-256 / SHA-256, base64 DER), lets the real
 * adapter send it through a recording SDK surface, rebuilds the signature
 * input from what was actually sent (URL + body + privy-* headers), and
 * verifies the device signature against it. No network call is made.
 */

const signal = new AbortController().signal;
const privyBaseUrl = "https://api.privy.io";

function recordingClient() {
  const quoteFake = swapAdapterFake({
    quote: { estimatedOutputAmount: "6650000000000000" },
  });
  const sent: { walletId: string; params: PrivySwapRequestParams }[] = [];
  const client: PrivySwapClient = {
    swap: {
      quote: () => Promise.reject(new Error("quote is served by the fake")),
      execute: vi.fn((wallet: string, params: PrivySwapRequestParams) => {
        sent.push({ walletId: wallet, params });
        return Promise.resolve({
          id: "act_conformance",
          status: "pending",
          steps: [],
        });
      }),
    },
    actions: {
      get: () => Promise.reject(new Error("not used")),
    },
  };
  return { quoteFake, client, sent };
}

describe("Privy Swap authorization payload conformance (Decision 0198)", () => {
  it("is byte-for-byte the request the adapter sends", async () => {
    const clock = { value: Date.parse("2026-11-04T00:00:00.000Z") };
    const { quoteFake, client, sent } = recordingClient();
    const realAdapter = createPrivySwapAdapter(client, {
      now: () => new Date(clock.value),
    });
    const fixture = runtimeFake({
      swapAdapter: {
        quote: (request) => quoteFake.adapter.quote(request),
        execute: (request) => realAdapter.execute(request),
        getAction: (input) => realAdapter.getAction(input),
      },
      privySwapExecution: { enabled: true, maxUsd: "200" },
      now: () => new Date(clock.value),
    });
    const swap = createSwapService({ runtime: fixture.runtime });
    const quoted = await swap.quote({
      principal,
      body: {
        walletId,
        sourceAssetId: usdtAssetId,
        destinationAssetId: wbnbAssetId,
        amount: "4",
      },
      signal,
    });
    const prepared = await swap.prepare({
      principal,
      idempotencyKey: randomUUID(),
      body: { walletId, quoteId: quoted.quote.quoteId },
      signal,
    });
    const payload = prepared.resource.authorizationPayload;
    if (payload === null) {
      throw new Error("missing authorization payload");
    }

    // The device: sign the payload object exactly as issued.
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const pkcs8 = privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64");
    const signature = generateAuthorizationSignature({
      authorizationPrivateKey: pkcs8,
      input: structuredClone(payload),
    });

    await swap.execute({
      principal,
      intentId: prepared.resource.intentId,
      body: { authorizationSignature: signature },
      signal,
    });
    expect(sent).toHaveLength(1);
    const request = sent[0];
    if (request === undefined) {
      throw new Error("nothing sent");
    }
    // What the SDK resource puts on the wire: header fields split off, the
    // remainder is the JSON body, the path is /v1/wallets/{id}/swap.
    const {
      "privy-authorization-signature": sentSignature,
      "privy-idempotency-key": sentIdempotencyKey,
      "privy-request-expiry": sentExpiry,
      ...sentBody
    } = request.params;
    expect(sentSignature).toBe(signature);
    const verifierInput = formatRequestForAuthorizationSignature({
      version: 1,
      method: "POST",
      url: `${privyBaseUrl}/v1/wallets/${request.walletId}/swap`,
      body: JSON.parse(JSON.stringify(sentBody)) as unknown,
      headers: {
        "privy-app-id": "app_test",
        ...(sentIdempotencyKey === undefined
          ? {}
          : { "privy-idempotency-key": sentIdempotencyKey }),
        ...(sentExpiry === undefined
          ? {}
          : { "privy-request-expiry": sentExpiry }),
      },
    });
    expect(
      verify(
        "sha256",
        verifierInput,
        { key: publicKey, dsaEncoding: "der" },
        Buffer.from(signature, "base64"),
      ),
    ).toBe(true);
    expect(sentIdempotencyKey).toBe(prepared.resource.intentId);
    expect(sentExpiry).toBe(String(Date.parse(prepared.resource.expiresAt)));
  });

  it("tracks the last hashed step of an action", () => {
    const approve = `0x${"a".repeat(64)}`;
    const swapHash = `0x${"b".repeat(64)}`;
    expect(swapActionTransactionHash({ steps: [] })).toBeNull();
    expect(
      swapActionTransactionHash({
        steps: [
          { status: "confirmed", transactionHash: approve },
          { status: "pending", transactionHash: swapHash },
          { status: "preparing", transactionHash: null },
        ],
      }),
    ).toBe(swapHash);
  });
});
