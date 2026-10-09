import { z } from "zod";

import {
  parseSpotContract,
  type DeepReadonly,
} from "./spot-contract-support.js";

const maximumBindingVersion = 9_223_372_036_854_775_807n;
const bindingVersionSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,18})$/)
  .refine((value) => BigInt(value) <= maximumBindingVersion);
const rfc3339Schema = z.string().max(64).datetime({ offset: true });

const mutationRequestSchema = z
  .object({ expected_binding_version: bindingVersionSchema })
  .strict();

const resourceSchema = z
  .object({
    state: z.enum(["bound", "unbound"]),
    binding_version: bindingVersionSchema,
    account_kind: z.literal("master").nullable(),
    last_verified_at: rfc3339Schema.nullable(),
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

export type SpotWalletBindingMutationRequest = DeepReadonly<
  z.output<typeof mutationRequestSchema>
>;
export type SpotWalletBindingResource = DeepReadonly<
  z.output<typeof resourceSchema>
>;

export const unboundSpotWalletBindingResource: SpotWalletBindingResource =
  Object.freeze({
    state: "unbound",
    binding_version: "0",
    account_kind: null,
    last_verified_at: null,
  });

export function parseSpotWalletBindingMutationRequest(
  value: unknown,
): SpotWalletBindingMutationRequest {
  return parseSpotContract(mutationRequestSchema, value);
}

export function parseSpotWalletBindingResource(
  value: unknown,
): SpotWalletBindingResource {
  return parseSpotContract(resourceSchema, value);
}
