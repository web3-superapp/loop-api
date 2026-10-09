import {
  toEventSelector,
  toFunctionSelector,
  type AbiEvent,
  type AbiFunction,
  type AbiParameter,
} from "viem";

/**
 * ABI acceptance check for a delivered LoopLaunchpad ABI (Decision 0076,
 * 06 §8 step 1). Compares against ABI v1: the 14 event signatures with their
 * `indexed` flags and parameter names, the `buy/claim/claimRefund`
 * selectors, and the read functions' input signatures and output structure
 * (struct field names and types, in order). Anything the delivered ABI has
 * beyond v1 is reported as `info`, never as a failure.
 */

export type AbiCheckStatus = "pass" | "fail" | "info";

export interface AbiCheckItem {
  readonly status: AbiCheckStatus;
  readonly kind: "event" | "function" | "extra";
  readonly name: string;
  readonly detail: string;
}

export interface AbiCheckReport {
  readonly items: readonly AbiCheckItem[];
  readonly passed: boolean;
}

export const launchpadUserFunctions = ["buy", "claim", "claimRefund"] as const;
export const launchpadReadFunctions = [
  "getState",
  "getRounds",
  "getSaleConfig",
  "quote",
  "getPosition",
  "getRoundPosition",
] as const;

type AbiEntry = { readonly type?: unknown; readonly name?: unknown };

function isEvent(entry: AbiEntry): entry is AbiEvent {
  return entry.type === "event" && typeof entry.name === "string";
}

function isFunction(entry: AbiEntry): entry is AbiFunction {
  return entry.type === "function" && typeof entry.name === "string";
}

/** Canonical type including tuple components, e.g. `(uint16,uint64)[]`. */
function canonicalType(parameter: AbiParameter): string {
  if (parameter.type.startsWith("tuple")) {
    const components =
      "components" in parameter && Array.isArray(parameter.components)
        ? (parameter.components as readonly AbiParameter[])
        : [];
    return `(${components.map(canonicalType).join(",")})${parameter.type.slice("tuple".length)}`;
  }
  return parameter.type;
}

/** Names and types, recursively, for a structural comparison. */
function shape(parameter: AbiParameter): string {
  if (parameter.type.startsWith("tuple")) {
    const components =
      "components" in parameter && Array.isArray(parameter.components)
        ? (parameter.components as readonly AbiParameter[])
        : [];
    return `{${components.map(shape).join(",")}}${parameter.type.slice("tuple".length)}`;
  }
  return `${parameter.type} ${parameter.name ?? ""}`;
}

function eventSignature(event: AbiEvent): string {
  return `${event.name}(${event.inputs.map(canonicalType).join(",")})`;
}

function functionSignature(fn: AbiFunction): string {
  return `${fn.name}(${fn.inputs.map(canonicalType).join(",")})`;
}

function indexedPattern(event: AbiEvent): string {
  return event.inputs
    .map((input) => `${input.name ?? ""}${input.indexed === true ? "*" : ""}`)
    .join(",");
}

/** Accepts a bare ABI array or a Hardhat/Foundry artifact `{abi: [...]}`. */
export function extractAbi(document: unknown): readonly AbiEntry[] {
  if (Array.isArray(document)) {
    return document as readonly AbiEntry[];
  }
  if (
    typeof document === "object" &&
    document !== null &&
    "abi" in document &&
    Array.isArray(document.abi)
  ) {
    return (document as { abi: readonly AbiEntry[] }).abi;
  }
  throw new TypeError("not an ABI array or an artifact with an abi field");
}

export function checkLaunchpadAbi(
  reference: readonly AbiEntry[],
  candidate: readonly AbiEntry[],
): AbiCheckReport {
  const items: AbiCheckItem[] = [];
  const candidateEvents = candidate.filter(isEvent);
  const candidateFunctions = candidate.filter(isFunction);
  const matchedEvents = new Set<AbiEvent>();
  const matchedFunctions = new Set<AbiFunction>();

  for (const event of reference.filter(isEvent)) {
    const signature = eventSignature(event);
    const topic0 = toEventSelector(signature);
    const found = candidateEvents.find(
      (other) => eventSignature(other) === signature,
    );
    if (found === undefined) {
      items.push({
        status: "fail",
        kind: "event",
        name: event.name,
        detail: `${signature} ${topic0} missing`,
      });
      continue;
    }
    matchedEvents.add(found);
    const expected = indexedPattern(event);
    const actual = indexedPattern(found);
    items.push({
      status: expected === actual ? "pass" : "fail",
      kind: "event",
      name: event.name,
      detail:
        expected === actual
          ? `${signature} ${topic0}`
          : `${signature} parameters/indexed differ: expected ${expected}, got ${actual}`,
    });
  }

  const referenceFunctions = reference.filter(isFunction);
  for (const name of [...launchpadUserFunctions, ...launchpadReadFunctions]) {
    const expected = referenceFunctions.find((fn) => fn.name === name);
    if (expected === undefined) {
      continue;
    }
    const signature = functionSignature(expected);
    const selector = toFunctionSelector(signature);
    const found = candidateFunctions.find(
      (fn) => functionSignature(fn) === signature,
    );
    if (found === undefined) {
      items.push({
        status: "fail",
        kind: "function",
        name,
        detail: `${signature} ${selector} missing`,
      });
      continue;
    }
    matchedFunctions.add(found);
    const problems: string[] = [];
    const expectedInputs = expected.inputs.map(shape).join(",");
    const actualInputs = found.inputs.map(shape).join(",");
    if (expectedInputs !== actualInputs) {
      problems.push(`inputs ${actualInputs} ≠ ${expectedInputs}`);
    }
    const expectedOutputs = expected.outputs.map(shape).join(",");
    const actualOutputs = found.outputs.map(shape).join(",");
    // A return's own name does not reach the wire (`returns (uint256
    // tokenAmount)` encodes like `returns (uint256)`); a struct's field names
    // and types, in order, are the contract.
    const outputsEqual =
      expected.outputs.length === found.outputs.length &&
      expected.outputs.every((output, index) => {
        const other = found.outputs[index];
        return (
          other !== undefined &&
          shape({ ...output, name: "" }) === shape({ ...other, name: "" })
        );
      });
    if (!outputsEqual) {
      problems.push(`outputs ${actualOutputs} ≠ ${expectedOutputs}`);
    }
    if (found.stateMutability !== expected.stateMutability) {
      problems.push(
        `stateMutability ${found.stateMutability} ≠ ${expected.stateMutability}`,
      );
    }
    items.push({
      status: problems.length === 0 ? "pass" : "fail",
      kind: "function",
      name,
      detail:
        problems.length === 0
          ? `${signature} ${selector}`
          : `${signature} ${problems.join("; ")}`,
    });
  }

  for (const event of candidateEvents) {
    if (!matchedEvents.has(event)) {
      items.push({
        status: "info",
        kind: "extra",
        name: event.name,
        detail: `event ${eventSignature(event)} not in v1 (ignored)`,
      });
    }
  }
  for (const fn of candidateFunctions) {
    if (!matchedFunctions.has(fn)) {
      items.push({
        status: "info",
        kind: "extra",
        name: fn.name,
        detail: `function ${functionSignature(fn)} not in v1 (ignored)`,
      });
    }
  }

  return Object.freeze({
    items: Object.freeze(items),
    passed: items.every((item) => item.status !== "fail"),
  });
}

export function formatAbiCheckReport(report: AbiCheckReport): string {
  const marks: Readonly<Record<AbiCheckStatus, string>> = {
    pass: "✓",
    fail: "✗",
    info: "·",
  };
  const lines = report.items.map(
    (item) => `${marks[item.status]} ${item.kind} ${item.detail}`,
  );
  const failed = report.items.filter((item) => item.status === "fail").length;
  const passed = report.items.filter((item) => item.status === "pass").length;
  lines.push(
    report.passed
      ? `ABI v1 check passed: ${passed} items ✓`
      : `ABI v1 check FAILED: ${failed} ✗, ${passed} ✓`,
  );
  return `${lines.join("\n")}\n`;
}
