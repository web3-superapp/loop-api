import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { loadConfig, type AppConfig } from "../src/config.js";
import { createPostgresLaunchChainRepository } from "../src/database/launch-chain-repository.js";
import { createPostgresLaunchRepository } from "../src/database/launch-repository.js";
import {
  launchAllowlistModes,
  type LaunchAllowlistMode,
  type LaunchChainRepository,
} from "../src/features/launch/launch-chain-repository.js";
import {
  evaluateAllowlistMembers,
  LaunchEligibilityInputError,
  launchEligibilityReasonCodes,
} from "../src/features/launch/launch-eligibility.js";
import {
  buildLaunchMerkleTree,
  InvalidAllowlistAddressError,
  normalizeAllowlistAddress,
} from "../src/features/launch/launch-merkle.js";
import type { LaunchRepository } from "../src/features/launch/launch-repository.js";
import {
  createBscReadClient,
  createUnavailableBscReadClient,
} from "../src/integrations/bsc/rpc-client.js";
import { createLaunchContractAdapter } from "../src/integrations/launch/launch-contract-adapter.js";

/**
 * Operator path for Launch allowlists (Decision 0077):
 *
 *   pnpm launch:allowlist import <file.csv> --launch <launchId> --round <n> [--source <tag>]
 *   pnpm launch:allowlist compute --launch <launchId> --round <n> --snapshot-block <n> [--confirm]
 *
 * `import` stores operator addresses for `tierModeV1 = whitelist` (one
 * address per line; a header line `address` and blank lines are ignored; any
 * other malformed line refuses the whole file). `compute` evaluates the
 * launch's confirmed `tierModeV1` at the snapshot block, builds the Merkle
 * tree (leaf keccak256(abi.encodePacked(address)), sorted pairs) and prints
 * the root; with `--confirm` it appends the root and member set to
 * `launch_round_allowlist_roots`. LOOP never writes the root on chain: the
 * operator writes it into the round's `allowlistRoot`. Refused under
 * NODE_ENV=production.
 */

export type LaunchAllowlistErrorCode =
  | "launch_allowlist_arguments_invalid"
  | "launch_allowlist_file_invalid"
  | "launch_allowlist_configuration_invalid"
  | "launch_allowlist_contract_unconfigured"
  | "launch_allowlist_forbidden_in_production"
  | "launch_allowlist_failed";

export class LaunchAllowlistError extends Error {
  constructor(
    /** A LaunchAllowlistErrorCode or a Decision 0077 reason code. */
    readonly code: string,
    readonly detail: string | null = null,
  ) {
    super("Launch allowlist command refused");
    this.name = "LaunchAllowlistError";
  }
}

const opaqueIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const roundPattern = /^(0|[1-9][0-9]{0,4})$/;
const blockPattern = /^(0|[1-9][0-9]{0,18})$/;
const sourcePattern = /^[a-z][a-z0-9_.:-]{0,63}$/;

export type LaunchAllowlistCommand =
  | {
      readonly kind: "import";
      readonly file: string;
      readonly launchId: string;
      readonly roundIndex: number;
      readonly source: string;
    }
  | {
      readonly kind: "compute";
      readonly launchId: string;
      readonly roundIndex: number;
      readonly snapshotBlock: bigint;
      readonly confirm: boolean;
    };

export function parseLaunchAllowlistArguments(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
): LaunchAllowlistCommand {
  if (environment["NODE_ENV"]?.trim() === "production") {
    throw new LaunchAllowlistError("launch_allowlist_forbidden_in_production");
  }
  const [kind, ...rest] = argv.slice(2);
  const flags = new Map<string, string>();
  const positional: string[] = [];
  let confirm = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] as string;
    if (arg === "--confirm") {
      confirm = true;
    } else if (arg.startsWith("--")) {
      const value = rest[index + 1];
      if (value === undefined || flags.has(arg)) {
        throw new LaunchAllowlistError("launch_allowlist_arguments_invalid");
      }
      flags.set(arg, value);
      index += 1;
    } else {
      positional.push(arg);
    }
  }
  const launchId = flags.get("--launch");
  const round = flags.get("--round");
  if (
    launchId === undefined ||
    !opaqueIdPattern.test(launchId) ||
    round === undefined ||
    !roundPattern.test(round) ||
    Number(round) > 65_535
  ) {
    throw new LaunchAllowlistError("launch_allowlist_arguments_invalid");
  }
  if (kind === "import") {
    const source = flags.get("--source") ?? "operator_csv";
    const allowed = new Set(["--launch", "--round", "--source"]);
    if (
      positional.length !== 1 ||
      confirm ||
      !sourcePattern.test(source) ||
      [...flags.keys()].some((key) => !allowed.has(key))
    ) {
      throw new LaunchAllowlistError("launch_allowlist_arguments_invalid");
    }
    return Object.freeze({
      kind: "import",
      file: positional[0] as string,
      launchId,
      roundIndex: Number(round),
      source,
    });
  }
  if (kind === "compute") {
    const block = flags.get("--snapshot-block");
    const allowed = new Set(["--launch", "--round", "--snapshot-block"]);
    if (
      positional.length !== 0 ||
      block === undefined ||
      !blockPattern.test(block) ||
      [...flags.keys()].some((key) => !allowed.has(key))
    ) {
      throw new LaunchAllowlistError("launch_allowlist_arguments_invalid");
    }
    return Object.freeze({
      kind: "compute",
      launchId,
      roundIndex: Number(round),
      snapshotBlock: BigInt(block),
      confirm,
    });
  }
  throw new LaunchAllowlistError("launch_allowlist_arguments_invalid");
}

/** Parses the CSV body; returns lowercase addresses or refuses the file. */
export function parseAllowlistCsv(contents: string): readonly string[] {
  const addresses: string[] = [];
  const lines = contents.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = (raw.split(",")[0] ?? "").trim();
    if (line === "" || (index === 0 && line.toLowerCase() === "address")) {
      continue;
    }
    try {
      addresses.push(normalizeAllowlistAddress(line));
    } catch (error) {
      if (error instanceof InvalidAllowlistAddressError) {
        throw new LaunchAllowlistError(
          "launch_allowlist_file_invalid",
          `line ${String(index + 1)}`,
        );
      }
      throw error;
    }
  }
  if (addresses.length === 0) {
    throw new LaunchAllowlistError(launchEligibilityReasonCodes.allowlistEmpty);
  }
  return Object.freeze([...new Set(addresses)]);
}

export interface ComputeDependencies {
  readonly launches: Pick<LaunchRepository, "getLaunch">;
  readonly chain: LaunchChainRepository;
  readonly readBlock: (blockNumber: bigint) => Promise<{
    readonly blockHash: string;
    readonly timestamp: bigint;
  }>;
}

export async function computeAllowlistRoot(
  command: Extract<LaunchAllowlistCommand, { kind: "compute" }>,
  deps: ComputeDependencies,
): Promise<{
  readonly root: string;
  readonly leafCount: number;
  readonly mode: LaunchAllowlistMode;
  readonly written: boolean;
}> {
  const detail = await deps.launches.getLaunch(command.launchId);
  if (detail === null) {
    throw new LaunchAllowlistError("LAUNCH_NOT_FOUND");
  }
  const confirmed = detail.configs.find(
    (config) => config.status === "confirmed",
  );
  const mode = confirmed?.parameters["tierModeV1"];
  if (
    typeof mode !== "string" ||
    !launchAllowlistModes.includes(mode as LaunchAllowlistMode)
  ) {
    throw new LaunchAllowlistError("TIER_MODE_PENDING");
  }
  const communityId = confirmed?.parameters["eligibilityCommunityId"];
  const block = await deps.readBlock(command.snapshotBlock);
  const members = await evaluateAllowlistMembers({
    repository: deps.chain,
    mode: mode as LaunchAllowlistMode,
    launchId: command.launchId,
    roundIndex: command.roundIndex,
    snapshotTime: new Date(Number(block.timestamp) * 1000).toISOString(),
    communityId:
      typeof communityId === "string" && opaqueIdPattern.test(communityId)
        ? communityId
        : null,
  }).catch((error: unknown) => {
    if (error instanceof LaunchEligibilityInputError) {
      throw new LaunchAllowlistError(error.reasonCode);
    }
    throw error;
  });
  if (members.length === 0) {
    throw new LaunchAllowlistError(launchEligibilityReasonCodes.allowlistEmpty);
  }
  const tree = buildLaunchMerkleTree(members);
  if (command.confirm) {
    await deps.chain.insertAllowlistRoot({
      launchId: command.launchId,
      roundIndex: command.roundIndex,
      snapshotBlock: command.snapshotBlock.toString(10),
      snapshotBlockHash: block.blockHash,
      root: tree.root,
      mode: mode as LaunchAllowlistMode,
      members: tree.members,
    });
  }
  return Object.freeze({
    root: tree.root,
    leafCount: tree.leafCount,
    mode: mode as LaunchAllowlistMode,
    written: command.confirm,
  });
}

interface OutputWriter {
  readonly write: (contents: string) => unknown;
}

async function defaultRun(
  command: LaunchAllowlistCommand,
  config: AppConfig,
  stdout: OutputWriter,
): Promise<void> {
  const pool = new pg.Pool({
    application_name: "loop-api-launch-allowlist",
    connectionString: config.databaseUrl,
    max: 1,
  });
  try {
    const chain = createPostgresLaunchChainRepository(pool);
    if (command.kind === "import") {
      const addresses = parseAllowlistCsv(readFileSync(command.file, "utf8"));
      const result = await chain.importAllowlist({
        launchId: command.launchId,
        roundIndex: command.roundIndex,
        addresses,
        source: command.source,
      });
      stdout.write(
        `Imported ${String(result.inserted)} new, ${String(result.existing)} already present (launch ${command.launchId} round ${String(command.roundIndex)})\n`,
      );
      return;
    }
    const contract = config.launchContract;
    if (contract === null) {
      throw new LaunchAllowlistError("launch_allowlist_contract_unconfigured");
    }
    const slot = config.launchChain;
    const readClient =
      slot.rpcUrls.length === 0
        ? createUnavailableBscReadClient({
            chainId: slot.chainId,
            chainReference: slot.chainReference,
            reasonCode: "LAUNCH_CHAIN_RPC_NOT_CONFIGURED",
          })
        : createBscReadClient({ config: slot });
    const adapter = createLaunchContractAdapter({
      contract,
      chain: slot,
      verifyChain: () => readClient.verifyChain(),
    });
    const result = await computeAllowlistRoot(command, {
      launches: createPostgresLaunchRepository(pool, {
        launchChainId: slot.chainId,
      }),
      chain,
      readBlock: (blockNumber) => adapter.readBlock(blockNumber),
    });
    stdout.write(
      `${result.written ? "Stored" : "Computed (add --confirm to store)"} root=${result.root} leaves=${String(result.leafCount)} mode=${result.mode} snapshotBlock=${command.snapshotBlock.toString(10)}\n`,
    );
  } finally {
    await pool.end();
  }
}

export async function runLaunchAllowlist(options: {
  readonly argv: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly stdout: OutputWriter;
  readonly stderr: OutputWriter;
  readonly run?: (
    command: LaunchAllowlistCommand,
    config: AppConfig,
    stdout: OutputWriter,
  ) => Promise<void>;
}): Promise<0 | 1> {
  let command: LaunchAllowlistCommand;
  let config: AppConfig;
  try {
    command = parseLaunchAllowlistArguments(options.argv, options.environment);
    try {
      config = loadConfig(options.environment);
    } catch {
      throw new LaunchAllowlistError("launch_allowlist_configuration_invalid");
    }
  } catch (error) {
    const code =
      error instanceof LaunchAllowlistError
        ? error.code
        : "launch_allowlist_failed";
    options.stderr.write(`Launch allowlist refused (${code})\n`);
    return 1;
  }
  try {
    await (options.run ?? defaultRun)(command, config, options.stdout);
    return 0;
  } catch (error) {
    const code =
      error instanceof LaunchAllowlistError
        ? `${error.code}${error.detail === null ? "" : ` ${error.detail}`}`
        : "launch_allowlist_failed";
    options.stderr.write(`Launch allowlist refused (${code})\n`);
    return 1;
  }
}

const directEntryPoint = process.argv[1];

if (
  directEntryPoint !== undefined &&
  resolve(directEntryPoint) === fileURLToPath(import.meta.url)
) {
  process.exitCode = await runLaunchAllowlist({
    argv: process.argv,
    environment: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
