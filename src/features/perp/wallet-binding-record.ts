import { z } from "zod";

import type { PerpWalletBindingRecord } from "../../database/perp-wallet-binding-repository.js";

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const lowerEvmAddressPattern = /^0x[0-9a-f]{40}$/;
const zeroAddress = `0x${"0".repeat(40)}`;
const maximumBindingVersion = 9_223_372_036_854_775_807n;

const versionSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((value) => {
    try {
      return BigInt(value) <= maximumBindingVersion;
    } catch {
      return false;
    }
  });

const timestampSchema = z.string().max(64).datetime({ offset: true });

const recordSchema = z
  .object({
    ownerUserId: z.string().regex(canonicalUuidPattern),
    privyUserId: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[\x21-\x7e]+$/),
    state: z.enum(["bound", "unbound"]),
    walletId: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[\x21-\x7e]+$/)
      .nullable(),
    accountAddress: z.string().regex(lowerEvmAddressPattern).nullable(),
    accountKind: z.literal("master").nullable(),
    bindingVersion: versionSchema,
    lastVerifiedAt: timestampSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((record, context) => {
    const boundAuthorityIsValid =
      record.walletId === null || record.walletId.length > 0;
    if (
      record.state === "bound" &&
      (record.bindingVersion === "0" ||
        record.accountAddress === null ||
        record.accountAddress === zeroAddress ||
        record.accountKind !== "master" ||
        record.lastVerifiedAt === null ||
        !boundAuthorityIsValid)
    ) {
      context.addIssue({ code: "custom" });
    }
    if (
      record.state === "unbound" &&
      (record.walletId !== null ||
        record.accountAddress !== null ||
        record.accountKind !== null ||
        record.lastVerifiedAt !== null)
    ) {
      context.addIssue({ code: "custom" });
    }
  });

export function parsePerpWalletBindingRecord(
  value: unknown,
  expected: { readonly ownerUserId: string; readonly privyUserId: string },
): PerpWalletBindingRecord {
  const parsed = recordSchema.parse(value);
  if (
    parsed.ownerUserId !== expected.ownerUserId ||
    parsed.privyUserId !== expected.privyUserId
  ) {
    throw new Error("Unexpected wallet-binding owner");
  }
  return Object.freeze(parsed);
}
