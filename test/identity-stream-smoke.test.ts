import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  createIdentityStreamSmokeTransport,
  IdentityStreamSmokeError,
  readAccessTokenFromStdin,
  runIdentityStreamSmoke,
  verifyIdentityStream,
  type IdentityStreamSmokeTransport,
} from "../scripts/identity-stream-smoke.js";

const accessToken = "header.payload.signature";
const loopUserId = "6d12a86e-4134-47e6-9312-c5ef75a30f55";
const streamUserId = "loop_6d12a86e413447e69312c5ef75a30f55";
const apiKey = "development_stream_api_key";
const issuedAt = 1_788_000_000;
const privyLeak = `privy:${accessToken}`;
const streamLeak = "issued-stream-token-must-not-be-printed";

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function streamToken(
  userId = streamUserId,
  iat = issuedAt,
  exp = issuedAt + 3_600,
  signature = Buffer.alloc(32, 0x73),
): string {
  return `${encodeJson({ alg: "HS256", typ: "JWT" })}.${encodeJson({
    user_id: userId,
    iat,
    exp,
  })}.${Buffer.from(signature).toString("base64url")}`;
}

function bootstrapResponse() {
  return {
    user: { id: loopUserId },
    stream_user_id: streamUserId,
  };
}

function tokenResponse(overrides: Record<string, unknown> = {}) {
  return {
    api_key: apiKey,
    token: streamToken(),
    expires_at: new Date((issuedAt + 3_600) * 1_000).toISOString(),
    user: { id: streamUserId },
    ...overrides,
  };
}

function successfulTransport() {
  return vi.fn<IdentityStreamSmokeTransport>((input) => {
    if (input.endpoint === "bootstrap") {
      return Promise.resolve(bootstrapResponse());
    }

    return Promise.resolve(tokenResponse());
  });
}

function outputWriter(): {
  readonly contents: () => string;
  readonly write: (value: string) => boolean;
} {
  let output = "";
  return {
    contents: () => output,
    write(value): boolean {
      output += value;
      return true;
    },
  };
}

describe("Privy-to-Stream credential smoke", () => {
  it("verifies two stable bootstraps before Chat and Video without returning credentials", async () => {
    const transport = successfulTransport();

    await expect(
      verifyIdentityStream({
        accessToken,
        baseUrl: "https://api-dev.quant-dinger.cc",
        transport,
      }),
    ).resolves.toBeUndefined();

    expect(transport).toHaveBeenCalledTimes(4);
    expect(transport.mock.calls.map(([input]) => input.endpoint)).toEqual([
      "bootstrap",
      "bootstrap",
      "chat",
      "video",
    ]);
    expect(transport.mock.calls.map(([input]) => input.url)).toEqual([
      "https://api-dev.quant-dinger.cc/v1/bootstrap",
      "https://api-dev.quant-dinger.cc/v1/bootstrap",
      "https://api-dev.quant-dinger.cc/v1/chat/token",
      "https://api-dev.quant-dinger.cc/v1/video/token",
    ]);
    for (const [input] of transport.mock.calls) {
      expect(input.accessToken).toBe(accessToken);
    }
  });

  it("rejects unstable bootstrap identity before requesting Stream tokens", async () => {
    const transport = vi
      .fn<IdentityStreamSmokeTransport>()
      .mockResolvedValueOnce(bootstrapResponse())
      .mockResolvedValueOnce({
        user: { id: "be3c1224-25ba-4fa8-94d7-4b215589c12d" },
        stream_user_id: "loop_be3c122425ba4fa894d74b215589c12d",
      });

    await expect(
      verifyIdentityStream({
        accessToken,
        baseUrl: "https://api-dev.quant-dinger.cc/",
        transport,
      }),
    ).rejects.toEqual(
      new IdentityStreamSmokeError("bootstrap_identity_unstable"),
    );
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "foreign Stream user",
      tokenResponse({ user: { id: "loop_foreign_user" } }),
      "stream_token_response_invalid",
    ],
    [
      "non-one-hour token",
      tokenResponse({
        token: streamToken(streamUserId, issuedAt, issuedAt + 60),
      }),
      "stream_token_response_invalid",
    ],
    [
      "mismatched expires_at",
      tokenResponse({
        expires_at: new Date((issuedAt + 3_599) * 1_000).toISOString(),
      }),
      "stream_token_response_invalid",
    ],
    [
      "wrong-length HS256 signature",
      tokenResponse({
        token: streamToken(
          streamUserId,
          issuedAt,
          issuedAt + 3_600,
          Buffer.from([0]),
        ),
      }),
      "stream_token_response_invalid",
    ],
  ] as const)("rejects a %s", async (_name, invalidResponse, code) => {
    const transport = vi
      .fn<IdentityStreamSmokeTransport>()
      .mockResolvedValueOnce(bootstrapResponse())
      .mockResolvedValueOnce(bootstrapResponse())
      .mockResolvedValueOnce(invalidResponse);

    await expect(
      verifyIdentityStream({
        accessToken,
        baseUrl: "https://api-dev.quant-dinger.cc",
        transport,
      }),
    ).rejects.toHaveProperty("code", code);
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it("requires Chat and Video to return the same Stream API key", async () => {
    const transport = vi
      .fn<IdentityStreamSmokeTransport>()
      .mockResolvedValueOnce(bootstrapResponse())
      .mockResolvedValueOnce(bootstrapResponse())
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(tokenResponse({ api_key: "another_stream_app" }));

    await expect(
      verifyIdentityStream({
        accessToken,
        baseUrl: "https://api-dev.quant-dinger.cc",
        transport,
      }),
    ).rejects.toEqual(new IdentityStreamSmokeError("stream_api_key_mismatch"));
  });

  it.each([
    "http://api-dev.quant-dinger.cc",
    "http://localhost:3000",
    "https://127.0.0.1:3000",
    "https://api-dev.quant-dinger.cc:8443",
    "https://example.com",
    "https://user:password@api-dev.quant-dinger.cc",
    "https://api-dev.quant-dinger.cc/base/",
    "https://api-dev.quant-dinger.cc/?token=forbidden",
  ])(
    "rejects unsafe target %s before reading response data",
    async (baseUrl) => {
      const transport = successfulTransport();

      await expect(
        verifyIdentityStream({ accessToken, baseUrl, transport }),
      ).rejects.toEqual(new IdentityStreamSmokeError("smoke_base_url_invalid"));
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it.each([
    "",
    "not-a-jwt",
    " header.payload.signature",
    "header.payload.signature\nextra",
    `${"a".repeat(8_193)}.payload.signature`,
  ])("rejects invalid token input before network work", async (token) => {
    const transport = successfulTransport();

    await expect(
      verifyIdentityStream({
        accessToken: token,
        baseUrl: "https://api-dev.quant-dinger.cc",
        transport,
      }),
    ).rejects.toEqual(new IdentityStreamSmokeError("token_input_invalid"));
    expect(transport).not.toHaveBeenCalled();
  });

  it("accepts the exact Authorization header token budget and rejects one byte more", async () => {
    const exactToken = `a.${"b".repeat(8_181)}.c`;
    const oversizedToken = `a.${"b".repeat(8_182)}.c`;
    expect(exactToken).toHaveLength(8_185);
    expect(oversizedToken).toHaveLength(8_186);

    await expect(
      verifyIdentityStream({
        accessToken: exactToken,
        baseUrl: "https://api-dev.quant-dinger.cc",
        transport: successfulTransport(),
      }),
    ).resolves.toBeUndefined();
    const transport = successfulTransport();
    await expect(
      verifyIdentityStream({
        accessToken: oversizedToken,
        baseUrl: "https://api-dev.quant-dinger.cc",
        transport,
      }),
    ).rejects.toEqual(new IdentityStreamSmokeError("token_input_invalid"));
    expect(transport).not.toHaveBeenCalled();
  });

  it("sends Bearer only to the fixed URL with redirects disabled and bounded JSON", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify(bootstrapResponse()), {
          status: 200,
          headers: {
            "cache-control": "no-store",
            "content-type": "application/json; charset=utf-8",
          },
        }),
      ),
    );
    const transport = createIdentityStreamSmokeTransport(fetchImplementation);

    await expect(
      transport({
        endpoint: "bootstrap",
        url: "https://api-dev.quant-dinger.cc/v1/bootstrap",
        accessToken,
      }),
    ).resolves.toEqual(bootstrapResponse());
    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [url, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(url).toBe("https://api-dev.quant-dinger.cc/v1/bootstrap");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      headers: {
        accept: "application/json",
        "accept-encoding": "identity",
        authorization: `Bearer ${accessToken}`,
      },
    });
    const headers = init?.headers as Record<string, string>;
    expect(headers["x-loop-smoke-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    "https://attacker.example/v1/bootstrap",
    "https://user:password@api-dev.quant-dinger.cc/v1/bootstrap",
    "https://api-dev.quant-dinger.cc/v1/chat/token",
    "https://api-dev.quant-dinger.cc/v1/bootstrap?token=forbidden",
  ])(
    "keeps the injected transport on the same URL allowlist for %s",
    async (url) => {
      const fetchImplementation = vi.fn<typeof fetch>();
      const transport = createIdentityStreamSmokeTransport(fetchImplementation);

      await expect(
        transport({ endpoint: "bootstrap", url, accessToken }),
      ).rejects.toEqual(new IdentityStreamSmokeError("smoke_base_url_invalid"));
      expect(fetchImplementation).not.toHaveBeenCalled();
    },
  );

  it("does not surface an HTTP body or transport error containing credentials", async () => {
    const httpFetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ privyLeak, streamLeak }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const throwingTransport = vi.fn<IdentityStreamSmokeTransport>(() =>
      Promise.reject(new Error(`${privyLeak}:${streamLeak}`)),
    );

    await expect(
      createIdentityStreamSmokeTransport(httpFetch)({
        endpoint: "bootstrap",
        url: "https://api-dev.quant-dinger.cc/v1/bootstrap",
        accessToken,
      }),
    ).rejects.toEqual(new IdentityStreamSmokeError("bootstrap_http_error"));

    const stdout = outputWriter();
    const stderr = outputWriter();
    await expect(
      runIdentityStreamSmoke({
        argv: ["node", "identity-stream-smoke.ts"],
        environment: {
          PUBLIC_BASE_URL: "https://api-dev.quant-dinger.cc",
        },
        stdout,
        stderr,
        readAccessToken: () => Promise.resolve(accessToken),
        transport: throwingTransport,
      }),
    ).resolves.toBe(1);
    expect(stdout.contents()).toBe("");
    expect(stderr.contents()).toBe(
      "Identity/Stream credential smoke failed (smoke_request_failed)\n",
    );
    expect(`${stdout.contents()}${stderr.contents()}`).not.toContain(
      accessToken,
    );
    expect(`${stdout.contents()}${stderr.contents()}`).not.toContain(
      streamLeak,
    );
  });

  it("uses a direct private HTTP client that never follows redirects", async () => {
    const paths: string[] = [];
    const authorizationValues: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      paths.push(request.url ?? "");
      authorizationValues.push(request.headers.authorization);
      response.writeHead(302, {
        location: "/attacker",
        "content-type": "application/json",
      });
      response.end(JSON.stringify({ privyLeak, streamLeak }));
    });
    await new Promise<void>((resolvePromise) => {
      server.listen(0, "127.0.0.1", resolvePromise);
    });

    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Expected an ephemeral TCP listener");
      }
      await expect(
        createIdentityStreamSmokeTransport()({
          endpoint: "bootstrap",
          url: `http://127.0.0.1:${address.port}/v1/bootstrap`,
          accessToken,
        }),
      ).rejects.toEqual(new IdentityStreamSmokeError("bootstrap_http_error"));
      expect(paths).toEqual(["/v1/bootstrap"]);
      expect(authorizationValues).toEqual([`Bearer ${accessToken}`]);
    } finally {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => {
          if (error === undefined) {
            resolvePromise();
          } else {
            rejectPromise(error);
          }
        });
      });
    }
  });

  it("runs the production direct transport in strict order with a fresh UUID per request", async () => {
    const paths: string[] = [];
    const requestIds: string[] = [];
    const authorizationValues: Array<string | undefined> = [];
    const methods: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      paths.push(request.url ?? "");
      requestIds.push(String(request.headers["x-loop-smoke-request-id"]));
      authorizationValues.push(request.headers.authorization);
      methods.push(request.method);
      const responseBody =
        request.url === "/v1/bootstrap" ? bootstrapResponse() : tokenResponse();
      response.writeHead(200, {
        "cache-control": "private, no-store",
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(responseBody));
    });
    await new Promise<void>((resolvePromise) => {
      server.listen(0, "127.0.0.1", resolvePromise);
    });

    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Expected an ephemeral TCP listener");
      }
      await expect(
        verifyIdentityStream({
          accessToken,
          baseUrl: `http://127.0.0.1:${address.port}`,
        }),
      ).resolves.toBeUndefined();
      expect(paths).toEqual([
        "/v1/bootstrap",
        "/v1/bootstrap",
        "/v1/chat/token",
        "/v1/video/token",
      ]);
      expect(new Set(requestIds).size).toBe(4);
      for (const requestId of requestIds) {
        expect(requestId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
      }
      expect(authorizationValues).toEqual(
        Array.from({ length: 4 }, () => `Bearer ${accessToken}`),
      );
      expect(methods).toEqual(Array.from({ length: 4 }, () => "POST"));
    } finally {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => {
          if (error === undefined) {
            resolvePromise();
          } else {
            rejectPromise(error);
          }
        });
      });
    }
  });

  it("rejects oversized success bodies without exposing their contents", async () => {
    const oversizedSecret = `secret-${"x".repeat(33_000)}`;
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ value: oversizedSecret }), {
          status: 200,
          headers: {
            "cache-control": "no-store",
            "content-type": "application/json",
          },
        }),
      ),
    );

    await expect(
      createIdentityStreamSmokeTransport(fetchImplementation)({
        endpoint: "bootstrap",
        url: "https://api-dev.quant-dinger.cc/v1/bootstrap",
        accessToken,
      }),
    ).rejects.toEqual(
      new IdentityStreamSmokeError("bootstrap_response_invalid"),
    );
  });

  it("accepts a JSON body at exactly 32 KiB and still rejects the next byte", async () => {
    const prefix = '{"value":"';
    const suffix = '"}';
    const exactBody = `${prefix}${"x".repeat(
      32 * 1_024 - prefix.length - suffix.length,
    )}${suffix}`;
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(exactBody, {
          status: 200,
          headers: {
            "cache-control": "no-store",
            "content-type": "application/json",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(`${exactBody} `, {
          status: 200,
          headers: {
            "cache-control": "no-store",
            "content-type": "application/json",
          },
        }),
      );
    const transport = createIdentityStreamSmokeTransport(fetchImplementation);

    await expect(
      transport({
        endpoint: "bootstrap",
        url: "https://api-dev.quant-dinger.cc/v1/bootstrap",
        accessToken,
      }),
    ).resolves.toHaveProperty("value");
    await expect(
      transport({
        endpoint: "bootstrap",
        url: "https://api-dev.quant-dinger.cc/v1/bootstrap",
        accessToken,
      }),
    ).rejects.toEqual(
      new IdentityStreamSmokeError("bootstrap_response_invalid"),
    );
  });

  it("enforces the 32 KiB stream cap in the production direct transport", async () => {
    const prefix = '{"value":"';
    const suffix = '"}';
    const exactBody = `${prefix}${"x".repeat(
      32 * 1_024 - prefix.length - suffix.length,
    )}${suffix}`;
    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount += 1;
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "application/json",
      });
      response.write(requestCount === 1 ? exactBody : `${exactBody} `);
      response.end();
    });
    await new Promise<void>((resolvePromise) => {
      server.listen(0, "127.0.0.1", resolvePromise);
    });

    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Expected an ephemeral TCP listener");
      }
      const transport = createIdentityStreamSmokeTransport();
      const url = `http://127.0.0.1:${address.port}/v1/bootstrap`;
      await expect(
        transport({ endpoint: "bootstrap", url, accessToken }),
      ).resolves.toHaveProperty("value");
      await expect(
        transport({ endpoint: "bootstrap", url, accessToken }),
      ).rejects.toEqual(
        new IdentityStreamSmokeError("bootstrap_response_invalid"),
      );
    } finally {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => {
          if (error === undefined) {
            resolvePromise();
          } else {
            rejectPromise(error);
          }
        });
      });
    }
  });

  it("rejects encoded success bodies in the injected transport", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify(bootstrapResponse()), {
          status: 200,
          headers: {
            "cache-control": "no-store",
            "content-encoding": "gzip",
            "content-type": "application/json",
          },
        }),
      ),
    );

    await expect(
      createIdentityStreamSmokeTransport(fetchImplementation)({
        endpoint: "bootstrap",
        url: "https://api-dev.quant-dinger.cc/v1/bootstrap",
        accessToken,
      }),
    ).rejects.toEqual(
      new IdentityStreamSmokeError("bootstrap_response_invalid"),
    );
  });

  it("prints only one fixed pass line", async () => {
    const stdout = outputWriter();
    const stderr = outputWriter();

    await expect(
      runIdentityStreamSmoke({
        argv: ["node", "identity-stream-smoke.ts"],
        environment: {
          PUBLIC_BASE_URL: "https://api-dev.quant-dinger.cc",
        },
        stdout,
        stderr,
        readAccessToken: () => Promise.resolve(accessToken),
        transport: successfulTransport(),
      }),
    ).resolves.toBe(0);
    expect(stdout.contents()).toBe("Identity/Stream credential smoke passed\n");
    expect(stderr.contents()).toBe("");
    expect(stdout.contents()).not.toContain(loopUserId);
    expect(stdout.contents()).not.toContain(streamUserId);
    expect(stdout.contents()).not.toContain(apiKey);
    expect(stdout.contents()).not.toContain(accessToken);
  });

  it("rejects arguments before reading or printing an accidentally supplied token", async () => {
    const stdout = outputWriter();
    const stderr = outputWriter();
    const readAccessToken = vi.fn(() => Promise.resolve(accessToken));
    const transport = successfulTransport();

    await expect(
      runIdentityStreamSmoke({
        argv: ["node", "identity-stream-smoke.ts", privyLeak],
        environment: {
          PUBLIC_BASE_URL: "https://api-dev.quant-dinger.cc",
        },
        stdout,
        stderr,
        readAccessToken,
        transport,
      }),
    ).resolves.toBe(1);
    expect(readAccessToken).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(stderr.contents()).toBe(
      "Identity/Stream credential smoke failed (smoke_arguments_invalid)\n",
    );
    expect(stderr.contents()).not.toContain(privyLeak);
  });

  it("rejects an unsafe base URL before reading a token", async () => {
    const stdout = outputWriter();
    const stderr = outputWriter();
    const readAccessToken = vi.fn(() => Promise.resolve(accessToken));

    await expect(
      runIdentityStreamSmoke({
        argv: ["node", "identity-stream-smoke.ts"],
        environment: { PUBLIC_BASE_URL: "https://attacker.example" },
        stdout,
        stderr,
        readAccessToken,
      }),
    ).resolves.toBe(1);
    expect(readAccessToken).not.toHaveBeenCalled();
    expect(stdout.contents()).toBe("");
    expect(stderr.contents()).toBe(
      "Identity/Stream credential smoke failed (smoke_base_url_invalid)\n",
    );
  });

  it.each([
    ["NODE_DEBUG", "http"],
    ["NODE_DEBUG", "*"],
    ["NODE_DEBUG", "stream"],
    ["NODE_TLS_REJECT_UNAUTHORIZED", "0"],
  ])(
    "rejects unsafe runtime environment %s before reading a token",
    async (name, value) => {
      const stdout = outputWriter();
      const stderr = outputWriter();
      const readAccessToken = vi.fn(() => Promise.resolve(accessToken));

      await expect(
        runIdentityStreamSmoke({
          argv: ["node", "identity-stream-smoke.ts"],
          environment: {
            PUBLIC_BASE_URL: "https://api-dev.quant-dinger.cc",
            [name]: value,
          },
          stdout,
          stderr,
          readAccessToken,
        }),
      ).resolves.toBe(1);
      expect(readAccessToken).not.toHaveBeenCalled();
      expect(stdout.contents()).toBe("");
      expect(stderr.contents()).toBe(
        "Identity/Stream credential smoke failed (smoke_runtime_unsafe)\n",
      );
    },
  );

  it.each([
    ["EOF", accessToken],
    ["LF", `${accessToken}\n`],
    ["CRLF", `${accessToken}\r\n`],
  ])("reads one piped token terminated by %s", async (_name, contents) => {
    const input = Readable.from([contents]) as unknown as NodeJS.ReadStream;
    await expect(readAccessTokenFromStdin(input)).resolves.toBe(accessToken);
  });

  it.each([
    `${accessToken}\n\n`,
    `${accessToken}\nsecond.line.token`,
    `${accessToken} `,
    ` ${accessToken}`,
    `${accessToken}\0`,
  ])(
    "rejects malformed piped input without normalizing it",
    async (contents) => {
      const input = Readable.from([contents]) as unknown as NodeJS.ReadStream;
      await expect(readAccessTokenFromStdin(input)).rejects.toEqual(
        new IdentityStreamSmokeError("token_input_invalid"),
      );
    },
  );

  it("hides interactive input and restores terminal mode after success", async () => {
    class FakeTerminal extends EventEmitter {
      readonly isTTY = true;
      isRaw = false;
      readonly rawModes: boolean[] = [];
      pauseCalls = 0;
      resumeCalls = 0;

      setRawMode(mode: boolean): this {
        this.isRaw = mode;
        this.rawModes.push(mode);
        return this;
      }

      pause(): this {
        this.pauseCalls += 1;
        return this;
      }

      resume(): this {
        this.resumeCalls += 1;
        return this;
      }
    }

    const terminal = new FakeTerminal();
    const prompt = outputWriter();
    const signals = new EventEmitter();
    const tokenPromise = readAccessTokenFromStdin(
      terminal as unknown as NodeJS.ReadStream,
      prompt,
      signals,
    );
    terminal.emit("data", Buffer.from(`${accessToken}\r`, "utf8"));

    await expect(tokenPromise).resolves.toBe(accessToken);
    expect(terminal.rawModes).toEqual([true, false]);
    expect(terminal.resumeCalls).toBe(1);
    expect(terminal.pauseCalls).toBe(1);
    expect(prompt.contents()).toBe("Privy access token (hidden): \n");
    expect(prompt.contents()).not.toContain(accessToken);
  });

  it.each([
    ["Ctrl-C", Buffer.from([3]), "token_input_cancelled"],
    ["invalid byte", Buffer.from([0]), "token_input_invalid"],
  ] as const)(
    "restores terminal mode after %s",
    async (_name, bytes, expectedCode) => {
      class FakeTerminal extends EventEmitter {
        readonly isTTY = true;
        isRaw = false;
        readonly rawModes: boolean[] = [];

        setRawMode(mode: boolean): this {
          this.isRaw = mode;
          this.rawModes.push(mode);
          return this;
        }

        pause(): this {
          return this;
        }

        resume(): this {
          return this;
        }
      }

      const terminal = new FakeTerminal();
      const prompt = outputWriter();
      const signals = new EventEmitter();
      const tokenPromise = readAccessTokenFromStdin(
        terminal as unknown as NodeJS.ReadStream,
        prompt,
        signals,
      );
      terminal.emit("data", bytes);

      await expect(tokenPromise).rejects.toHaveProperty("code", expectedCode);
      expect(terminal.rawModes).toEqual([true, false]);
      expect(prompt.contents()).toBe("Privy access token (hidden): \n");
    },
  );

  it("restores terminal mode when interactive setup fails after raw mode", async () => {
    class FailingTerminal extends EventEmitter {
      readonly isTTY = true;
      isRaw = false;
      readonly rawModes: boolean[] = [];

      setRawMode(mode: boolean): this {
        this.isRaw = mode;
        this.rawModes.push(mode);
        return this;
      }

      pause(): this {
        return this;
      }

      resume(): this {
        throw new Error(`${privyLeak}:${streamLeak}`);
      }
    }

    const terminal = new FailingTerminal();
    const prompt = outputWriter();
    const signals = new EventEmitter();
    await expect(
      readAccessTokenFromStdin(
        terminal as unknown as NodeJS.ReadStream,
        prompt,
        signals,
      ),
    ).rejects.toEqual(new IdentityStreamSmokeError("token_input_failed"));
    expect(terminal.rawModes).toEqual([true, false]);
    expect(prompt.contents()).toBe("Privy access token (hidden): \n");
    expect(prompt.contents()).not.toContain(privyLeak);
  });

  it.each([
    ["terminal close", "close"],
    ["SIGHUP", "SIGHUP"],
    ["SIGINT", "SIGINT"],
    ["SIGTERM", "SIGTERM"],
  ] as const)("restores terminal mode after %s", async (_name, event) => {
    class FakeTerminal extends EventEmitter {
      readonly isTTY = true;
      isRaw = false;
      readonly rawModes: boolean[] = [];

      setRawMode(mode: boolean): this {
        this.isRaw = mode;
        this.rawModes.push(mode);
        return this;
      }

      pause(): this {
        return this;
      }

      resume(): this {
        return this;
      }
    }

    const terminal = new FakeTerminal();
    const signals = new EventEmitter();
    const prompt = outputWriter();
    const tokenPromise = readAccessTokenFromStdin(
      terminal as unknown as NodeJS.ReadStream,
      prompt,
      signals,
    );
    if (event === "close") {
      terminal.emit(event);
    } else {
      signals.emit(event);
    }

    await expect(tokenPromise).rejects.toEqual(
      new IdentityStreamSmokeError("token_input_cancelled"),
    );
    expect(terminal.rawModes).toEqual([true, false]);
    expect(prompt.contents()).toBe("Privy access token (hidden): \n");
    expect(signals.listenerCount("SIGHUP")).toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("rejects additional bytes after an interactive line terminator", async () => {
    class FakeTerminal extends EventEmitter {
      readonly isTTY = true;
      isRaw = false;
      readonly rawModes: boolean[] = [];

      setRawMode(mode: boolean): this {
        this.isRaw = mode;
        this.rawModes.push(mode);
        return this;
      }

      pause(): this {
        return this;
      }

      resume(): this {
        return this;
      }
    }

    const terminal = new FakeTerminal();
    const signals = new EventEmitter();
    const prompt = outputWriter();
    const tokenPromise = readAccessTokenFromStdin(
      terminal as unknown as NodeJS.ReadStream,
      prompt,
      signals,
    );
    terminal.emit("data", Buffer.from(`${accessToken}\rsecond.token.value`));

    await expect(tokenPromise).rejects.toEqual(
      new IdentityStreamSmokeError("token_input_invalid"),
    );
    expect(terminal.rawModes).toEqual([true, false]);
    expect(prompt.contents()).not.toContain(accessToken);
  });
});
