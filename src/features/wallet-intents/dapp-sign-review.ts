import {
  hashTypedData,
  recoverMessageAddress,
  recoverTypedDataAddress,
  type Hex,
  type TypedDataDomain,
} from "viem";

import {
  permit2Address,
  dappUnlimitedApprovalFloor,
} from "./dapp-call-decoder.js";
import type {
  DappMessageReview,
  DappRiskFlag,
  DappTypedDataField,
  DappTypedDataReview,
} from "./intent-contract.js";

/**
 * Decision 0197 (S342): the message half of the DApp sign sheet. Pure
 * parsing of `personal_sign` messages and `eth_signTypedData_v4` payloads,
 * the Permit / Permit2 risk recognition, and the recovery check the
 * signature report uses (Privy embedded wallets are EOAs, so ecrecover is
 * the whole verification).
 */

/** Largest personal_sign message, in bytes. */
export const maximumPersonalSignBytes = 16_384;
/** Largest eth_signTypedData_v4 JSON payload, in characters. */
export const maximumTypedDataLength = 32_768;
const maximumFields = 256;
const maximumFieldValueLength = 1_024;
const maximumDepth = 8;

export class DappPayloadInvalidError extends Error {
  constructor(message = "The DApp signature payload is not valid") {
    super(message);
    this.name = "DappPayloadInvalidError";
  }
}

const hexBytesPattern = /^0x([0-9a-fA-F]{2})*$/u;

function bytesToHex(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

/** Printable UTF-8: decodes strictly and has no control character but \t\n\r. */
function printableUtf8(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)
    ? null
    : text;
}

/**
 * A personal_sign message as the page sent it: a 0x hex string is raw
 * bytes (MetaMask semantics), anything else is UTF-8 text.
 */
export function reviewPersonalSignMessage(payload: string): DappMessageReview {
  const bytes = hexBytesPattern.test(payload)
    ? Uint8Array.from(Buffer.from(payload.slice(2), "hex"))
    : new TextEncoder().encode(payload);
  if (bytes.length === 0 || bytes.length > maximumPersonalSignBytes) {
    throw new DappPayloadInvalidError();
  }
  const text = printableUtf8(bytes);
  return Object.freeze({
    encoding: text === null ? ("hex" as const) : ("utf8" as const),
    text,
    hex: bytesToHex(bytes),
    byteLength: bytes.length,
  });
}

interface TypedField {
  readonly name: string;
  readonly type: string;
}

export interface ParsedTypedData {
  readonly types: Readonly<Record<string, readonly TypedField[]>>;
  readonly primaryType: string;
  readonly domain: TypedDataDomain;
  /** The message with integers as bigint and addresses lower-case. */
  readonly message: Record<string, unknown>;
  /** domain.chainId as a bigint, when present. */
  readonly domainChainId: bigint | null;
}

const identifierPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const arraySuffix = /^(.*)\[([0-9]*)\]$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^-?(0|[1-9][0-9]{0,79})$/u.test(value)) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^0x[0-9a-fA-F]{1,64}$/u.test(value)) {
    return BigInt(value);
  }
  throw new DappPayloadInvalidError();
}

function normalizeValue(
  types: Readonly<Record<string, readonly TypedField[]>>,
  type: string,
  value: unknown,
  depth: number,
): unknown {
  if (depth > maximumDepth) throw new DappPayloadInvalidError();
  const array = arraySuffix.exec(type);
  if (array !== null) {
    if (!Array.isArray(value)) throw new DappPayloadInvalidError();
    const length = array[2] ?? "";
    if (length !== "" && value.length !== Number(length)) {
      throw new DappPayloadInvalidError();
    }
    return value.map((entry) =>
      normalizeValue(types, array[1] ?? "", entry, depth + 1),
    );
  }
  const struct = types[type];
  if (struct !== undefined) {
    if (!isRecord(value)) throw new DappPayloadInvalidError();
    return normalizeStruct(types, struct, value, depth + 1);
  }
  if (
    /^u?int(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?$/u.test(
      type,
    )
  ) {
    return toBigInt(value);
  }
  if (type === "address") {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/u.test(value)) {
      throw new DappPayloadInvalidError();
    }
    return value.toLowerCase();
  }
  if (type === "bool") {
    if (typeof value !== "boolean") throw new DappPayloadInvalidError();
    return value;
  }
  if (type === "string") {
    if (typeof value !== "string") throw new DappPayloadInvalidError();
    return value;
  }
  if (/^bytes([1-9]|[12][0-9]|3[0-2])?$/u.test(type)) {
    if (typeof value !== "string" || !hexBytesPattern.test(value)) {
      throw new DappPayloadInvalidError();
    }
    return value.toLowerCase();
  }
  throw new DappPayloadInvalidError();
}

function normalizeStruct(
  types: Readonly<Record<string, readonly TypedField[]>>,
  fields: readonly TypedField[],
  value: Record<string, unknown>,
  depth: number,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const field of fields) {
    normalized[field.name] = normalizeValue(
      types,
      field.type,
      value[field.name],
      depth,
    );
  }
  return normalized;
}

function parseTypes(
  value: unknown,
): Readonly<Record<string, readonly TypedField[]>> {
  if (!isRecord(value)) throw new DappPayloadInvalidError();
  const types: Record<string, readonly TypedField[]> = {};
  for (const [name, fields] of Object.entries(value)) {
    if (!identifierPattern.test(name) || !Array.isArray(fields)) {
      throw new DappPayloadInvalidError();
    }
    types[name] = fields.map((field) => {
      if (
        !isRecord(field) ||
        typeof field["name"] !== "string" ||
        typeof field["type"] !== "string" ||
        !identifierPattern.test(field["name"])
      ) {
        throw new DappPayloadInvalidError();
      }
      return Object.freeze({ name: field["name"], type: field["type"] });
    });
  }
  return types;
}

function parseDomain(value: unknown): {
  readonly domain: TypedDataDomain;
  readonly chainId: bigint | null;
} {
  if (value === undefined) return { domain: {}, chainId: null };
  if (!isRecord(value)) throw new DappPayloadInvalidError();
  const domain: {
    name?: string;
    version?: string;
    chainId?: bigint;
    verifyingContract?: `0x${string}`;
    salt?: `0x${string}`;
  } = {};
  let chainId: bigint | null = null;
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || entry === null) continue;
    switch (key) {
      case "name":
      case "version":
        if (typeof entry !== "string") throw new DappPayloadInvalidError();
        domain[key] = entry;
        break;
      case "chainId":
        chainId = toBigInt(entry);
        domain.chainId = chainId;
        break;
      case "verifyingContract":
        if (typeof entry !== "string" || !/^0x[0-9a-fA-F]{40}$/u.test(entry)) {
          throw new DappPayloadInvalidError();
        }
        domain.verifyingContract = entry.toLowerCase() as `0x${string}`;
        break;
      case "salt":
        if (typeof entry !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(entry)) {
          throw new DappPayloadInvalidError();
        }
        domain.salt = entry.toLowerCase() as `0x${string}`;
        break;
      default:
        throw new DappPayloadInvalidError();
    }
  }
  return { domain, chainId };
}

/**
 * Parses an eth_signTypedData_v4 payload (the JSON string the page sent)
 * and checks it hashes under EIP-712 — a payload viem cannot hash is a
 * payload no wallet would sign the same way.
 */
export function parseTypedData(payload: string): ParsedTypedData {
  if (payload.length === 0 || payload.length > maximumTypedDataLength) {
    throw new DappPayloadInvalidError();
  }
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    throw new DappPayloadInvalidError();
  }
  if (!isRecord(json)) throw new DappPayloadInvalidError();
  const types = parseTypes(json["types"]);
  const primaryType = json["primaryType"];
  if (
    typeof primaryType !== "string" ||
    primaryType === "EIP712Domain" ||
    types[primaryType] === undefined ||
    !isRecord(json["message"])
  ) {
    throw new DappPayloadInvalidError();
  }
  const { domain, chainId } = parseDomain(json["domain"]);
  const structTypes = Object.fromEntries(
    Object.entries(types).filter(([name]) => name !== "EIP712Domain"),
  );
  const message = normalizeStruct(
    structTypes,
    types[primaryType] ?? [],
    json["message"],
    0,
  );
  const parsed: ParsedTypedData = Object.freeze({
    types,
    primaryType,
    domain,
    message,
    domainChainId: chainId,
  });
  try {
    typedDataDigest(parsed);
  } catch {
    throw new DappPayloadInvalidError();
  }
  return parsed;
}

function typedDataArguments(parsed: ParsedTypedData) {
  return {
    domain: parsed.domain,
    types: parsed.types as Record<string, readonly TypedField[]>,
    primaryType: parsed.primaryType,
    message: parsed.message,
  } as unknown as Parameters<typeof hashTypedData>[0];
}

export function typedDataDigest(parsed: ParsedTypedData): Hex {
  return hashTypedData(typedDataArguments(parsed));
}

function leafString(value: unknown): string {
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function flatten(
  types: Readonly<Record<string, readonly TypedField[]>>,
  type: string,
  value: unknown,
  path: string,
  out: DappTypedDataField[],
  budget: { remaining: number; truncated: boolean },
): void {
  if (budget.remaining <= 0) {
    budget.truncated = true;
    return;
  }
  const array = arraySuffix.exec(type);
  if (array !== null && Array.isArray(value)) {
    value.forEach((entry, index) => {
      flatten(
        types,
        array[1] ?? "",
        entry,
        `${path}[${String(index)}]`,
        out,
        budget,
      );
    });
    return;
  }
  const struct = types[type];
  if (struct !== undefined && isRecord(value)) {
    for (const field of struct) {
      flatten(
        types,
        field.type,
        value[field.name],
        path === "" ? field.name : `${path}.${field.name}`,
        out,
        budget,
      );
    }
    return;
  }
  const text = leafString(value);
  budget.remaining -= 1;
  out.push(
    Object.freeze({
      path,
      type,
      value:
        text.length > maximumFieldValueLength
          ? text.slice(0, maximumFieldValueLength)
          : text,
      truncated: text.length > maximumFieldValueLength,
    }),
  );
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return leafString(value);
}

export function reviewTypedData(parsed: ParsedTypedData): DappTypedDataReview {
  const fields: DappTypedDataField[] = [];
  const budget = { remaining: maximumFields, truncated: false };
  flatten(parsed.types, parsed.primaryType, parsed.message, "", fields, budget);
  const domain = parsed.domain as Record<string, unknown>;
  return Object.freeze({
    primaryType: parsed.primaryType,
    domain: Object.freeze({
      name: optionalString(domain["name"]),
      version: optionalString(domain["version"]),
      chainId: parsed.domainChainId?.toString(10) ?? null,
      verifyingContract: optionalString(domain["verifyingContract"]),
      salt: optionalString(domain["salt"]),
    }),
    fields: Object.freeze(fields),
    fieldsTruncated: budget.truncated,
  });
}

const permit2PrimaryTypes = new Set([
  "PermitSingle",
  "PermitBatch",
  "PermitTransferFrom",
  "PermitBatchTransferFrom",
  "PermitWitnessTransferFrom",
  "PermitBatchWitnessTransferFrom",
]);

/**
 * PERMIT_SIGNATURE: an EIP-2612 / DAI `Permit`, any Permit2 message (by
 * domain name, verifying contract, or primary type), or any other primary
 * type named `Permit…`. UNLIMITED_APPROVAL on top when a permit grants an
 * amount at or above 2^128 (`value` / `amount` leaves) or a DAI-style
 * `allowed: true`.
 */
export function typedDataRiskFlags(
  parsed: ParsedTypedData,
  review: DappTypedDataReview,
): readonly DappRiskFlag[] {
  const domain = review.domain;
  const isPermit =
    parsed.primaryType.startsWith("Permit") ||
    permit2PrimaryTypes.has(parsed.primaryType) ||
    domain.name === "Permit2" ||
    domain.verifyingContract === permit2Address;
  if (!isPermit) return [];
  const flags: DappRiskFlag[] = ["PERMIT_SIGNATURE"];
  const unlimited = review.fields.some((field) => {
    const leaf = field.path
      .split(".")
      .at(-1)
      ?.replace(/\[[0-9]+\]$/u, "");
    if (field.type === "bool") {
      return leaf === "allowed" && field.value === "true";
    }
    return (
      (leaf === "value" || leaf === "amount") &&
      /^uint/u.test(field.type) &&
      !field.truncated &&
      BigInt(field.value) >= dappUnlimitedApprovalFloor
    );
  });
  if (unlimited) flags.push("UNLIMITED_APPROVAL");
  return flags;
}

/** The address that produced `signature` over the personal_sign payload. */
export async function recoverPersonalSigner(
  payload: string,
  signature: Hex,
): Promise<string> {
  const address = await recoverMessageAddress({
    message: hexBytesPattern.test(payload)
      ? { raw: payload.toLowerCase() as Hex }
      : payload,
    signature,
  });
  return address.toLowerCase();
}

/** The address that produced `signature` over the typed data. */
export async function recoverTypedDataSigner(
  parsed: ParsedTypedData,
  signature: Hex,
): Promise<string> {
  const address = await recoverTypedDataAddress({
    ...typedDataArguments(parsed),
    signature,
  });
  return address.toLowerCase();
}
