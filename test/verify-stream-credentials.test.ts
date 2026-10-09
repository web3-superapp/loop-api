import { describe, expect, it, vi } from "vitest";

import {
  runStreamCredentialVerification,
  StreamCredentialVerificationError,
  verifyStreamCredentials,
  type CreateStreamCredentialProbe,
} from "../scripts/verify-stream-credentials.js";

const apiKey = "development_stream_api_key";
const apiSecret = "development_stream_api_secret";

function configuredEnvironment(): NodeJS.ProcessEnv {
  return {
    STREAM_API_KEY: apiKey,
    STREAM_API_SECRET: apiSecret,
  };
}

function successfulProbe(): CreateStreamCredentialProbe {
  return vi.fn(() => ({
    getApp: vi.fn(() =>
      Promise.resolve({
        app: Object.freeze({}),
        metadata: Object.freeze({ responseCode: 200 }),
      }),
    ),
  }));
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

describe("Stream credential verification", () => {
  it("uses one read-only App lookup and returns no provider data", async () => {
    const createProbe = successfulProbe();

    await expect(
      verifyStreamCredentials(configuredEnvironment(), createProbe),
    ).resolves.toBeUndefined();
    expect(createProbe).toHaveBeenCalledOnce();
    expect(createProbe).toHaveBeenCalledWith({ apiKey, apiSecret });
  });

  it.each([
    ["both absent", {}, "stream_credentials_unconfigured"],
    [
      "key absent",
      { STREAM_API_SECRET: apiSecret },
      "stream_credentials_incomplete",
    ],
    [
      "secret absent",
      { STREAM_API_KEY: apiKey },
      "stream_credentials_incomplete",
    ],
    [
      "blank pair",
      { STREAM_API_KEY: "  ", STREAM_API_SECRET: "\t" },
      "stream_credentials_unconfigured",
    ],
  ] as const)("rejects %s before provider work", async (_name, env, code) => {
    const createProbe = successfulProbe();

    await expect(verifyStreamCredentials(env, createProbe)).rejects.toEqual(
      new StreamCredentialVerificationError(code),
    );
    expect(createProbe).not.toHaveBeenCalled();
  });

  it("maps provider errors and unexpected responses to one safe code", async () => {
    const providerFailure = vi.fn<CreateStreamCredentialProbe>(() => ({
      getApp: () =>
        Promise.reject(new Error(`provider rejected ${apiKey}:${apiSecret}`)),
    }));
    const unexpectedResponse = vi.fn<CreateStreamCredentialProbe>(() => ({
      getApp: () =>
        Promise.resolve({
          app: null,
          metadata: { responseCode: 200 },
        }),
    }));

    await expect(
      verifyStreamCredentials(configuredEnvironment(), providerFailure),
    ).rejects.toHaveProperty("code", "stream_credentials_rejected");
    await expect(
      verifyStreamCredentials(configuredEnvironment(), unexpectedResponse),
    ).rejects.toHaveProperty("code", "stream_credentials_rejected");
  });

  it("prints only a stable pass line on success", async () => {
    const stdout = outputWriter();
    const stderr = outputWriter();

    await expect(
      runStreamCredentialVerification({
        argv: ["node", "verify-stream-credentials.ts"],
        environment: configuredEnvironment(),
        stdout,
        stderr,
        createProbe: successfulProbe(),
      }),
    ).resolves.toBe(0);
    expect(stdout.contents()).toBe("Stream credential verification passed\n");
    expect(stderr.contents()).toBe("");
    expect(stdout.contents()).not.toContain(apiKey);
    expect(stdout.contents()).not.toContain(apiSecret);
  });

  it("prints only a stable code when the provider error contains credentials", async () => {
    const stdout = outputWriter();
    const stderr = outputWriter();
    const createProbe = vi.fn<CreateStreamCredentialProbe>(() => ({
      getApp: () =>
        Promise.reject(new Error(`provider rejected ${apiKey}:${apiSecret}`)),
    }));

    await expect(
      runStreamCredentialVerification({
        argv: ["node", "verify-stream-credentials.ts"],
        environment: configuredEnvironment(),
        stdout,
        stderr,
        createProbe,
      }),
    ).resolves.toBe(1);
    expect(stdout.contents()).toBe("");
    expect(stderr.contents()).toBe(
      "Stream credential verification failed (stream_credentials_rejected)\n",
    );
    expect(stderr.contents()).not.toContain(apiKey);
    expect(stderr.contents()).not.toContain(apiSecret);
  });

  it("rejects arguments without loading credentials or contacting Stream", async () => {
    const stdout = outputWriter();
    const stderr = outputWriter();
    const createProbe = successfulProbe();

    await expect(
      runStreamCredentialVerification({
        argv: ["node", "verify-stream-credentials.ts", apiSecret],
        environment: configuredEnvironment(),
        stdout,
        stderr,
        createProbe,
      }),
    ).resolves.toBe(1);
    expect(createProbe).not.toHaveBeenCalled();
    expect(stdout.contents()).toBe("");
    expect(stderr.contents()).toBe(
      "Stream credential verification failed (stream_verification_arguments_invalid)\n",
    );
    expect(stderr.contents()).not.toContain(apiSecret);
  });
});
