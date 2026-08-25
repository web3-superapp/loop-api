import { z } from "zod";

const maximumBindingVersion = 9_223_372_036_854_775_807n;
const bindingVersionPattern = /^(0|[1-9][0-9]{0,18})$/;

const bindingVersionSchema = z
  .string()
  .regex(bindingVersionPattern)
  .refine((value) => {
    try {
      return BigInt(value) <= maximumBindingVersion;
    } catch {
      return false;
    }
  });

const timestampSchema = z.string().max(64).datetime({ offset: true });

const mutationRequestSchema = z
  .object({ expected_binding_version: bindingVersionSchema })
  .strict();

const resourceSchema = z
  .object({
    state: z.enum(["bound", "unbound"]),
    binding_version: bindingVersionSchema,
    account_kind: z.literal("master").nullable(),
    last_verified_at: timestampSchema.nullable(),
  })
  .strict()
  .superRefine((resource, context) => {
    if (
      resource.state === "unbound" &&
      (resource.account_kind !== null || resource.last_verified_at !== null)
    ) {
      context.addIssue({ code: "custom" });
    }
    if (
      resource.state === "bound" &&
      (resource.binding_version === "0" ||
        resource.account_kind !== "master" ||
        resource.last_verified_at === null)
    ) {
      context.addIssue({ code: "custom" });
    }
  });

export type PerpWalletBindingMutationRequest = Readonly<
  z.infer<typeof mutationRequestSchema>
>;
export type PerpWalletBindingResource = Readonly<
  z.infer<typeof resourceSchema>
>;

export const unboundPerpWalletBindingResource: PerpWalletBindingResource =
  Object.freeze({
    state: "unbound",
    binding_version: "0",
    account_kind: null,
    last_verified_at: null,
  });

export function parsePerpWalletBindingMutationRequest(
  value: unknown,
): PerpWalletBindingMutationRequest {
  return Object.freeze(mutationRequestSchema.parse(value));
}

export function parsePerpWalletBindingResource(
  value: unknown,
): PerpWalletBindingResource {
  return Object.freeze(resourceSchema.parse(value));
}
