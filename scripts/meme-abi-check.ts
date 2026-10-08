/**
 * `pnpm meme:abi-check <abi.json>` (Decision 0101): compares a delivered
 * LoopMemeCurve ABI (a bare ABI array or a Hardhat/Foundry artifact) with
 * the v1 reference `src/integrations/meme/meme-abi.v1.json`. Prints one
 * ✓/✗ line per item; exits 1 on any ✗ or unreadable input. Reads local
 * files only; no network, no environment.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkMemeCurveAbi,
  extractAbi,
  formatAbiCheckReport,
} from "../src/integrations/meme/meme-abi-check.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const referencePath = path.join(
  repositoryRoot,
  "src/integrations/meme/meme-abi.v1.json",
);

const candidatePath = process.argv[2];
if (candidatePath === undefined || process.argv.length > 3) {
  process.stderr.write("usage: pnpm meme:abi-check <abi.json>\n");
  process.exit(1);
}

let candidate;
let reference;
try {
  reference = extractAbi(JSON.parse(readFileSync(referencePath, "utf8")));
  candidate = extractAbi(
    JSON.parse(readFileSync(path.resolve(candidatePath), "utf8")),
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`meme:abi-check refused: ${message}\n`);
  process.exit(1);
}

const report = checkMemeCurveAbi(reference, candidate);
process.stdout.write(formatAbiCheckReport(report));
process.exit(report.passed ? 0 : 1);
