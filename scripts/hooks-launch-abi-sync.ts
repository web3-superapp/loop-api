/**
 * `pnpm hooks:abi-sync [--check] [--protocol <dir>] [--out <forgeOutDir>]
 *   [--source-commit <sha>]`
 * (Decision 0112): copies the ABI items the Hooks deployment executor uses
 * out of the loop-contracts Foundry build (`protocol/out/<C>.sol/<C>.json`)
 * into `src/integrations/launch/hooks-launch-protocol-abi.generated.ts`.
 * The ABI is never hand-written: `--check` fails when the committed file
 * differs from what the current build would produce. Reads local files
 * only; no network, no environment secrets.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  hooksLaunchAbiSelection,
  renderHooksLaunchAbiModule,
  selectHooksLaunchAbi,
} from "./hooks-launch-abi-selection.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const targetPath = path.join(
  repositoryRoot,
  "src/integrations/launch/hooks-launch-protocol-abi.generated.ts",
);

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function locateProtocol(): string {
  const explicit = argument("--protocol") ?? process.env["LOOP_PROTOCOL_DIR"];
  const candidates =
    explicit === undefined
      ? [
          path.resolve(repositoryRoot, "../loop-contracts/protocol"),
          path.resolve(repositoryRoot, "../../loop-contracts/protocol"),
        ]
      : [path.resolve(explicit)];
  const found = candidates.find((candidate) =>
    existsSync(path.join(candidate, "foundry.toml")),
  );
  if (found === undefined) {
    throw new Error(
      `loop-contracts protocol package not found (tried ${candidates.join(", ")})`,
    );
  }
  return found;
}

try {
  const protocolDir = locateProtocol();
  const outDir = path.resolve(
    argument("--out") ?? path.join(protocolDir, "out"),
  );
  // Decision 0131: a build exported with `git archive` (no git metadata)
  // names its commit explicitly.
  let sourceCommit = argument("--source-commit") ?? "unknown";
  if (!/^(unknown|[0-9a-f]{7,40})$/u.test(sourceCommit)) {
    throw new Error("--source-commit must be a hex commit id");
  }
  if (sourceCommit === "unknown") {
    try {
      sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: protocolDir,
        encoding: "utf8",
      }).trim();
    } catch {
      // A tarball checkout has no git metadata; the ABI content is still checked.
    }
  }
  const artifacts: Record<string, unknown> = {};
  for (const contract of Object.keys(hooksLaunchAbiSelection)) {
    const file = path.join(outDir, `${contract}.sol`, `${contract}.json`);
    artifacts[contract] = JSON.parse(readFileSync(file, "utf8"));
  }
  const selected = selectHooksLaunchAbi(artifacts);
  if (process.argv.includes("--check")) {
    const committed =
      (await import("../src/integrations/launch/hooks-launch-protocol-abi.generated.js")) as Record<
        string,
        unknown
      >;
    const mismatched = Object.entries(selected).filter(([contract, abi]) => {
      const name = `${contract.charAt(0).toLowerCase()}${contract.slice(1)}Abi`;
      return JSON.stringify(committed[name]) !== JSON.stringify(abi);
    });
    if (mismatched.length > 0) {
      process.stderr.write(
        `hooks:abi-sync --check: ${mismatched.map(([c]) => c).join(", ")} differ from the Foundry build; run pnpm hooks:abi-sync && pnpm format\n`,
      );
      process.exit(1);
    }
    process.stdout.write(
      "hooks:abi-sync --check: ABI matches the Foundry build\n",
    );
  } else {
    writeFileSync(
      targetPath,
      renderHooksLaunchAbiModule(selected, sourceCommit),
    );
    process.stdout.write(
      `hooks:abi-sync wrote ${path.relative(repositoryRoot, targetPath)} from ${sourceCommit}\n`,
    );
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`hooks:abi-sync refused: ${message}\n`);
  process.exit(1);
}
