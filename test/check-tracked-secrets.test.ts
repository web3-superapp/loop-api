import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  listTrackedFiles,
  scanTrackedFileContents,
  scanTrackedRepository,
} from "../scripts/check-tracked-secrets.js";

const temporaryDirectories: string[] = [];

async function createTemporaryRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "loop-tracked-secrets-"));
  temporaryDirectories.push(directory);
  execFileSync("git", ["init", "--quiet"], { cwd: directory });
  return directory;
}

function highConfidenceTokens(): ReadonlyArray<readonly [string, string]> {
  return [
    ["github-token", ["ghp", "_", "a".repeat(36)].join("")],
    ["github-token", ["github", "_pat_", "a".repeat(82)].join("")],
    ["aws-access-key-id", ["AK", "IA", "A".repeat(16)].join("")],
    ["stripe-live-secret-key", ["sk", "_live_", "a".repeat(24)].join("")],
    ["slack-token", ["xox", "b-", "1".repeat(20)].join("")],
    ["google-api-key", ["AI", "za", "a".repeat(35)].join("")],
  ];
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("tracked secret scanner", () => {
  it("uses Git's tracked file set and ignores an untracked .env.local", async () => {
    const repository = await createTemporaryRepository();
    await writeFile(join(repository, "tracked.txt"), "safe fixture\n");
    await writeFile(
      join(repository, ".env.local"),
      `SECRET=${["ghp", "_", "a".repeat(36)].join("")}\n`,
    );
    execFileSync("git", ["add", "tracked.txt"], { cwd: repository });

    expect(listTrackedFiles(repository)).toEqual(["tracked.txt"]);
    await expect(scanTrackedRepository(repository)).resolves.toEqual([]);
  });

  it.each([
    ".env",
    ".env.local",
    "config/.env.production",
    ".ENV.TEST",
    ".ENV.EXAMPLE",
  ])("rejects a tracked environment file named %s", (path) => {
    expect(scanTrackedFileContents(path, Buffer.from("safe\n"))).toEqual([
      { path, rule: "tracked-environment-file" },
    ]);
  });

  it("allows .env.example while still scanning its contents", () => {
    expect(
      scanTrackedFileContents(
        ".env.example",
        Buffer.from("PLACEHOLDER=value\n"),
      ),
    ).toEqual([]);
  });

  it.each([
    "signing.pem",
    "signing.key",
    "signing.p8",
    "signing.p12",
    "signing.pfx",
  ])("rejects a tracked private-key extension on %s", (path) => {
    expect(scanTrackedFileContents(path, Buffer.from("safe\n"))).toEqual([
      { path, rule: "private-key-file-extension" },
    ]);
  });

  it("detects a PEM private-key header without returning its value", () => {
    const header = ["-----BEGIN", "OPENSSH", "PRIVATE", "KEY-----"].join(" ");

    expect(
      scanTrackedFileContents(
        "fixture.txt",
        Buffer.from(`first line\n${header}\nprivate material\n`),
      ),
    ).toEqual([{ path: "fixture.txt", rule: "pem-private-key", line: 2 }]);
  });

  it.each(highConfidenceTokens())("detects %s", (rule, token) => {
    expect(
      scanTrackedFileContents(
        "fixture.txt",
        Buffer.from(`safe first line\ntoken=${token}\n`),
      ),
    ).toEqual([{ path: "fixture.txt", rule, line: 2 }]);
  });

  it("skips binary content", () => {
    const token = ["ghp", "_", "a".repeat(36)].join("");
    const contents = Buffer.concat([
      Buffer.from([0, 1, 2]),
      Buffer.from(token, "utf8"),
    ]);

    expect(scanTrackedFileContents("fixture.bin", contents)).toEqual([]);
  });

  it("does not flag generic fixture secrets", () => {
    const fixture = [
      "PRIVY_APP_SECRET=secret_test",
      "STREAM_API_SECRET=stream_secret",
      "Authorization: Bearer fixture-token",
      "DATABASE_URL=postgres://user:local-password@localhost/database",
    ].join("\n");

    expect(
      scanTrackedFileContents("test/config.test.ts", Buffer.from(fixture)),
    ).toEqual([]);
  });
});
