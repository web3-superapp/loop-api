import { execFileSync } from "node:child_process";
import { lstat, readFile, readlink } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const privateKeyExtensions = new Set([".key", ".p8", ".p12", ".pem", ".pfx"]);

const contentRules = [
  {
    rule: "pem-private-key",
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/,
  },
  {
    rule: "github-token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82})\b/,
  },
  {
    rule: "aws-access-key-id",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  },
  {
    rule: "stripe-live-secret-key",
    pattern: /\bsk_live_[A-Za-z0-9]{24,}\b/,
  },
  {
    rule: "slack-token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  },
  {
    rule: "google-api-key",
    pattern: /\bAIza[A-Za-z0-9_-]{35}\b/,
  },
] as const;

export type TrackedSecretRule =
  | "tracked-environment-file"
  | "private-key-file-extension"
  | (typeof contentRules)[number]["rule"];

export interface TrackedSecretFinding {
  readonly path: string;
  readonly rule: TrackedSecretRule;
  readonly line?: number;
}

function isTrackedEnvironmentFile(path: string): boolean {
  const filename = basename(path);
  const normalizedFilename = filename.toLowerCase();
  return (
    filename !== ".env.example" &&
    (normalizedFilename === ".env" || normalizedFilename.startsWith(".env."))
  );
}

function scanTrackedPath(path: string): TrackedSecretFinding[] {
  const findings: TrackedSecretFinding[] = [];

  if (isTrackedEnvironmentFile(path)) {
    findings.push({ path, rule: "tracked-environment-file" });
  }

  if (privateKeyExtensions.has(extname(path).toLowerCase())) {
    findings.push({ path, rule: "private-key-file-extension" });
  }

  return findings;
}

function isBinary(contents: Buffer): boolean {
  return contents.includes(0);
}

function lineAt(text: string, index: number): number {
  let line = 1;

  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) {
      line += 1;
    }
  }

  return line;
}

export function scanTrackedFileContents(
  path: string,
  contents: Buffer,
): TrackedSecretFinding[] {
  const findings = scanTrackedPath(path);

  if (findings.length > 0 || isBinary(contents)) {
    return findings;
  }

  const text = contents.toString("utf8");

  for (const contentRule of contentRules) {
    const match = contentRule.pattern.exec(text);

    if (match !== null) {
      findings.push({
        path,
        rule: contentRule.rule,
        line: lineAt(text, match.index),
      });
    }
  }

  return findings;
}

export function listTrackedFiles(root: string): string[] {
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--recurse-submodules"],
    {
      cwd: root,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    },
  );

  return output
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0);
}

function resolveTrackedPath(root: string, path: string): string {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(absoluteRoot, path);
  const relativePath = relative(absoluteRoot, absolutePath);

  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    throw new Error(
      `Git returned an unsafe tracked path: ${JSON.stringify(path)}`,
    );
  }

  return absolutePath;
}

async function readTrackedFile(
  root: string,
  path: string,
): Promise<Buffer | null> {
  const absolutePath = resolveTrackedPath(root, path);
  const statistics = await lstat(absolutePath);

  if (statistics.isSymbolicLink()) {
    return Buffer.from(await readlink(absolutePath), "utf8");
  }

  if (!statistics.isFile()) {
    return null;
  }

  return readFile(absolutePath);
}

export async function scanTrackedFiles(
  root: string,
  trackedPaths: readonly string[],
): Promise<TrackedSecretFinding[]> {
  const findings: TrackedSecretFinding[] = [];

  for (const path of trackedPaths) {
    const pathFindings = scanTrackedPath(path);

    if (pathFindings.length > 0) {
      findings.push(...pathFindings);
      continue;
    }

    const contents = await readTrackedFile(root, path);

    if (contents !== null) {
      findings.push(...scanTrackedFileContents(path, contents));
    }
  }

  return findings;
}

export async function scanTrackedRepository(
  root: string,
): Promise<TrackedSecretFinding[]> {
  return scanTrackedFiles(root, listTrackedFiles(root));
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) {
    throw new Error("The tracked secret scanner does not accept arguments");
  }

  const findings = await scanTrackedRepository(repositoryRoot);

  if (findings.length === 0) {
    process.stdout.write("Tracked secret scan passed\n");
    return;
  }

  process.stderr.write(
    `Tracked secret scan failed with ${findings.length} finding(s):\n`,
  );

  for (const finding of findings) {
    const location =
      finding.line === undefined
        ? finding.path
        : `${finding.path}:${finding.line}`;
    process.stderr.write(`- ${location}: ${finding.rule}\n`);
  }

  process.exitCode = 1;
}

const directEntryPoint = process.argv[1];

if (
  directEntryPoint !== undefined &&
  resolve(directEntryPoint) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
