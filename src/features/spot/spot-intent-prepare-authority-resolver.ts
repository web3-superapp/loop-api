import { z } from "zod";

import {
  SPOT_AGENT_AUTHORIZATION_POLICY_VERSION,
  SpotAgentAuthorizationAuthorityStaleError,
  SpotAgentAuthorizationRepositoryUnavailableError,
  type SpotActiveAgentAuthorityReader,
} from "../../database/spot-agent-authorization-repository.js";
import {
  SPOT_INTENT_PREPARE_POLICY_V1,
  SpotIntentPrepareAuthorityRequiredError,
  SpotIntentPrepareAuthorityUnavailableError,
  type SpotIntentPrepareAuthority,
  type SpotIntentPrepareAuthorityResolver,
} from "./spot-intent-prepare.js";
import {
  WalletBindingRequiredError,
  WalletBindingResolutionUnavailableError,
  type WalletBindingAuthorityResolver,
} from "../wallet/wallet-binding-resolver.js";

const maximumPostgresBigint = 9_223_372_036_854_775_807n;
const zeroAddress = `0x${"0".repeat(40)}`;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const canonicalTimestampSchema = z
  .string()
  .max(24)
  .datetime({ offset: false, precision: 3 })
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const opaqueProviderIdSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value === value.trim())
  .refine((value) =>
    Array.from(value).every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint >= 32 && codePoint !== 127;
    }),
  );
const addressSchema = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/)
  .refine((value) => value !== zeroAddress);
const bindingVersionSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => BigInt(value) <= maximumPostgresBigint);
const resolverInputSchema = z
  .object({
    ownerUserId: z.string().regex(uuidPattern),
    privyUserId: opaqueProviderIdSchema,
    network: z.literal("testnet"),
    requestId: z.string().regex(uuidPattern),
    signal: z.custom<AbortSignal>((value) => value instanceof AbortSignal),
  })
  .strict();
const walletAuthoritySchema = z
  .object({
    ownerUserId: z.string().regex(uuidPattern),
    privyUserId: opaqueProviderIdSchema,
    walletId: opaqueProviderIdSchema.nullable(),
    accountAddress: addressSchema,
    accountKind: z.literal("master"),
    bindingVersion: bindingVersionSchema,
    verifiedAt: canonicalTimestampSchema,
    expiresAt: canonicalTimestampSchema,
  })
  .strict()
  .refine((authority) => {
    const verifiedAt = Date.parse(authority.verifiedAt);
    const expiresAt = Date.parse(authority.expiresAt);
    return (
      verifiedAt < expiresAt &&
      expiresAt - verifiedAt <=
        SPOT_INTENT_PREPARE_POLICY_V1.maximumAuthorityLeaseMilliseconds
    );
  });
const activeAgentAuthoritySchema = z
  .object({
    authorizationId: z.string().regex(uuidPattern),
    agentIdentityId: z.string().regex(uuidPattern),
    agentValidUntil: canonicalTimestampSchema,
  })
  .strict();

export interface CreateSpotIntentPrepareAuthorityResolverOptions {
  readonly walletBindingAuthorityResolver: WalletBindingAuthorityResolver;
  readonly activeAgentAuthorityReader: SpotActiveAgentAuthorityReader;
}

function unavailable(): never {
  throw new SpotIntentPrepareAuthorityUnavailableError();
}

export function createSpotIntentPrepareAuthorityResolver(
  options: CreateSpotIntentPrepareAuthorityResolverOptions,
): SpotIntentPrepareAuthorityResolver {
  return Object.freeze({
    async resolve(
      rawInput: Parameters<SpotIntentPrepareAuthorityResolver["resolve"]>[0],
    ): Promise<unknown> {
      const parsedInput = resolverInputSchema.safeParse(rawInput);
      if (!parsedInput.success) {
        return unavailable();
      }
      const input = parsedInput.data;
      input.signal.throwIfAborted();

      let rawWalletAuthority: unknown;
      try {
        rawWalletAuthority =
          await options.walletBindingAuthorityResolver.resolveAuthority({
            ownerUserId: input.ownerUserId,
            privyUserId: input.privyUserId,
            signal: input.signal,
          });
        input.signal.throwIfAborted();
      } catch (error) {
        input.signal.throwIfAborted();
        if (error instanceof WalletBindingRequiredError) {
          throw new SpotIntentPrepareAuthorityRequiredError();
        }
        if (error instanceof WalletBindingResolutionUnavailableError) {
          return unavailable();
        }
        return unavailable();
      }

      const walletAuthority =
        walletAuthoritySchema.safeParse(rawWalletAuthority);
      if (
        !walletAuthority.success ||
        walletAuthority.data.ownerUserId !== input.ownerUserId ||
        walletAuthority.data.privyUserId !== input.privyUserId
      ) {
        return unavailable();
      }
      if (walletAuthority.data.walletId === null) {
        throw new SpotIntentPrepareAuthorityRequiredError();
      }

      let rawActiveAgent: unknown;
      try {
        rawActiveAgent =
          await options.activeAgentAuthorityReader.findCurrentActive({
            ownerUserId: walletAuthority.data.ownerUserId,
            privyUserId: walletAuthority.data.privyUserId,
            requestId: input.requestId,
            walletId: walletAuthority.data.walletId,
            accountAddress: walletAuthority.data.accountAddress,
            accountKind: walletAuthority.data.accountKind,
            bindingVersion: walletAuthority.data.bindingVersion,
            verifiedAt: walletAuthority.data.verifiedAt,
            expiresAt: walletAuthority.data.expiresAt,
            policyVersion: SPOT_AGENT_AUTHORIZATION_POLICY_VERSION,
          });
        input.signal.throwIfAborted();
      } catch (error) {
        input.signal.throwIfAborted();
        if (
          error instanceof SpotAgentAuthorizationAuthorityStaleError ||
          error instanceof SpotAgentAuthorizationRepositoryUnavailableError
        ) {
          return unavailable();
        }
        return unavailable();
      }
      if (rawActiveAgent === null) {
        throw new SpotIntentPrepareAuthorityRequiredError();
      }
      const activeAgent = activeAgentAuthoritySchema.safeParse(rawActiveAgent);
      if (!activeAgent.success) {
        return unavailable();
      }

      return Object.freeze({
        ownerUserId: walletAuthority.data.ownerUserId,
        privyUserId: walletAuthority.data.privyUserId,
        walletId: walletAuthority.data.walletId,
        accountAddress: walletAuthority.data.accountAddress,
        accountKind: walletAuthority.data.accountKind,
        bindingVersion: walletAuthority.data.bindingVersion,
        agentIdentityId: activeAgent.data.agentIdentityId,
        verifiedAt: walletAuthority.data.verifiedAt,
        expiresAt: walletAuthority.data.expiresAt,
      } satisfies SpotIntentPrepareAuthority);
    },
  });
}
