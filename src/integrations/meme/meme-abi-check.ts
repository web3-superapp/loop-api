import {
  toEventSelector,
  toFunctionSelector,
  type AbiEvent,
  type AbiFunction,
  type AbiParameter,
} from "viem";

import {
  extractAbi,
  formatAbiCheckReport,
  type AbiCheckItem,
  type AbiCheckReport,
} from "../launch/launchpad-abi-check.js";

/**
 * ABI acceptance check for a delivered LoopMemeCurve ABI (Decision 0101),
 * the `launch:abi-check` discipline applied to the MEME curve: every event
 * of the v1 reference with its parameter names and `indexed` flags, the
 * four user calls, the reads this backend makes, and the custom errors the
 * backend maps (docs/10 §3.4). Anything the delivered ABI has beyond v1 is
 * reported as `info`, never as a failure.
 */

export { extractAbi, formatAbiCheckReport };

export const memeUserFunctions = [
  "createToken",
  "buy",
  "sell",
  "graduate",
] as const;
export const memeReadFunctions = [
  "getCurve",
  "quoteBuy",
  "quoteSell",
  "predictTokenAddress",
  "params",
  "getResidual",
  "tokenImplementation",
] as const;
export const memeErrors = [
  "CurveNotTrading",
  "CurveFull",
  "NotFull",
  "BelowMinBuy",
  "WalletCapExceeded",
  "Slippage",
  "Expired",
  "SameBlockRoundTrip",
  "SaltUsed",
  "TokenUnknown",
] as const;

type AbiEntry = {
  readonly type?: unknown;
  readonly name?: unknown;
  readonly inputs?: readonly AbiParameter[];
};

function isEvent(entry: AbiEntry): entry is AbiEvent {
  return entry.type === "event" && typeof entry.name === "string";
}

function isFunction(entry: AbiEntry): entry is AbiFunction {
  return entry.type === "function" && typeof entry.name === "string";
}

function isError(entry: AbiEntry): entry is AbiEntry & { name: string } {
  return entry.type === "error" && typeof entry.name === "string";
}

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

function signature(name: string, inputs: readonly AbiParameter[]): string {
  return `${name}(${inputs.map(canonicalType).join(",")})`;
}

function indexedPattern(event: AbiEvent): string {
  return event.inputs
    .map((input) => `${input.name ?? ""}${input.indexed === true ? "*" : ""}`)
    .join(",");
}

export function checkMemeCurveAbi(
  reference: readonly AbiEntry[],
  candidate: readonly AbiEntry[],
): AbiCheckReport {
  const items: AbiCheckItem[] = [];
  const candidateEvents = candidate.filter(isEvent);
  const candidateFunctions = candidate.filter(isFunction);
  const candidateErrors = candidate.filter(isError);
  const matched = new Set<AbiEntry>();

  for (const event of reference.filter(isEvent)) {
    const sig = signature(event.name, event.inputs);
    const topic0 = toEventSelector(sig);
    const found = candidateEvents.find(
      (other) => signature(other.name, other.inputs) === sig,
    );
    if (found === undefined) {
      items.push({
        status: "fail",
        kind: "event",
        name: event.name,
        detail: `${sig} ${topic0} missing`,
      });
      continue;
    }
    matched.add(found);
    const expected = indexedPattern(event);
    const actual = indexedPattern(found);
    items.push({
      status: expected === actual ? "pass" : "fail",
      kind: "event",
      name: event.name,
      detail:
        expected === actual
          ? `${sig} ${topic0}`
          : `${sig} parameters/indexed differ: expected ${expected}, got ${actual}`,
    });
  }

  const referenceFunctions = reference.filter(isFunction);
  for (const name of [...memeUserFunctions, ...memeReadFunctions]) {
    const expected = referenceFunctions.find((fn) => fn.name === name);
    if (expected === undefined) {
      continue;
    }
    const sig = signature(expected.name, expected.inputs);
    const selector = toFunctionSelector(sig);
    const found = candidateFunctions.find(
      (fn) => signature(fn.name, fn.inputs) === sig,
    );
    if (found === undefined) {
      items.push({
        status: "fail",
        kind: "function",
        name,
        detail: `${sig} ${selector} missing`,
      });
      continue;
    }
    matched.add(found);
    const problems: string[] = [];
    const expectedInputs = expected.inputs.map(shape).join(",");
    const actualInputs = found.inputs.map(shape).join(",");
    if (expectedInputs !== actualInputs) {
      problems.push(`inputs ${actualInputs} ≠ ${expectedInputs}`);
    }
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
      problems.push(
        `outputs ${found.outputs.map(shape).join(",")} ≠ ${expected.outputs.map(shape).join(",")}`,
      );
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
          ? `${sig} ${selector}`
          : `${sig} ${problems.join("; ")}`,
    });
  }

  const referenceErrors = reference.filter(isError);
  for (const name of memeErrors) {
    const expected = referenceErrors.find((entry) => entry.name === name);
    if (expected === undefined) {
      continue;
    }
    const sig = signature(name, expected.inputs ?? []);
    const found = candidateErrors.find(
      (entry) => signature(entry.name, entry.inputs ?? []) === sig,
    );
    if (found !== undefined) {
      matched.add(found);
    }
    items.push({
      status: found === undefined ? "fail" : "pass",
      kind: "function",
      name,
      detail: `error ${sig} ${toFunctionSelector(sig)}${found === undefined ? " missing" : ""}`,
    });
  }

  for (const entry of candidate) {
    if (
      (isEvent(entry) || isFunction(entry) || isError(entry)) &&
      !matched.has(entry)
    ) {
      items.push({
        status: "info",
        kind: "extra",
        name: entry.name,
        detail: `${String(entry.type)} ${signature(entry.name, entry.inputs ?? [])} not checked (ignored)`,
      });
    }
  }

  return Object.freeze({
    items: Object.freeze(items),
    passed: items.every((item) => item.status !== "fail"),
  });
}
