import {
  hooksLaunchLoopDynamicHookPermissionBits,
  hooksLaunchLoopDynamicTemplateHash,
  isHooksLaunchMaxCumulativeBuy,
  isHooksLaunchMaxDynamicFeeWad,
  type HooksLaunchLoopDynamicParams,
} from "./hooks-launch-config.js";

/**
 * Decision 0152: the LoopDynamic part of a loop-contracts deployment
 * manifest (`protocol/deployments/<chain>/factory-*.json`, written by
 * `VerifyLoopProtocol`) as this backend understands it — the Hook
 * parameters its `TEMPLATE_HASH` commits, the generation, and the recorded
 * hash the parameters must reproduce. Used by the deployment checks and the
 * tests that pin manifests; never read at runtime (the runtime reads the
 * same facts from the chain, `readHooksLaunchLoopDynamicTemplate`).
 *
 * Generations (loop-contracts Decision 0015 §6):
 *
 * - S209 — top-level `maxCumulativeBuy` and `loopDynamic.maxCumulativeBuy`
 *   (equal decimal strings) and `loopDynamic.params.{buyFeeToken: "USD1",
 *   buyFeeAccrual: "baseFeesAccrued", hookPermissionFlags: "0x10cc"}`;
 * - before — none of those keys (5,000,000 MEME constant, MEME buy fee,
 *   0x10C4). A manifest with only some of them is refused.
 */
export interface HooksLaunchLoopDynamicManifest {
  readonly generation: "s209" | "legacy";
  readonly params: HooksLaunchLoopDynamicParams;
  readonly templateHash: string;
  readonly buyFeeToken: "usd1" | "meme";
  readonly hookPermissionFlags: bigint;
}

export class HooksLaunchManifestInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HooksLaunchManifestInvalidError";
  }
}

const addressPattern = /^0x[0-9a-fA-F]{40}$/u;

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HooksLaunchManifestInvalidError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function address(value: unknown, name: string): string {
  if (typeof value !== "string" || !addressPattern.test(value)) {
    throw new HooksLaunchManifestInvalidError(`${name} must be an address`);
  }
  return value.toLowerCase();
}

function ppm(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value >= 1_000_000
  ) {
    throw new HooksLaunchManifestInvalidError(`${name} must be a ppm`);
  }
  return value;
}

export function parseHooksLaunchLoopDynamicManifest(
  manifest: unknown,
): HooksLaunchLoopDynamicManifest {
  const top = record(manifest, "manifest");
  const ld = record(top["loopDynamic"], "loopDynamic");
  const p = record(ld["params"], "loopDynamic.params");
  const s209Keys = [
    top["maxCumulativeBuy"],
    ld["maxCumulativeBuy"],
    p["buyFeeToken"],
    p["buyFeeAccrual"],
    p["hookPermissionFlags"],
  ];
  const present = s209Keys.filter((value) => value !== undefined).length;
  if (present !== 0 && present !== s209Keys.length) {
    throw new HooksLaunchManifestInvalidError(
      "an S209 manifest carries every one of maxCumulativeBuy, loopDynamic.maxCumulativeBuy and loopDynamic.params.{buyFeeToken, buyFeeAccrual, hookPermissionFlags}",
    );
  }
  const s209 = present === s209Keys.length;
  if (s209) {
    if (
      !isHooksLaunchMaxCumulativeBuy(top["maxCumulativeBuy"]) ||
      ld["maxCumulativeBuy"] !== top["maxCumulativeBuy"]
    ) {
      throw new HooksLaunchManifestInvalidError(
        "maxCumulativeBuy must be the same decimal string in (0, 1e27] at both places",
      );
    }
    if (
      p["buyFeeToken"] !== "USD1" ||
      p["buyFeeAccrual"] !== "baseFeesAccrued" ||
      typeof p["hookPermissionFlags"] !== "string" ||
      p["hookPermissionFlags"].toLowerCase() !== "0x10cc"
    ) {
      throw new HooksLaunchManifestInvalidError(
        "an S209 manifest's Hooks charge the buy fee in USD1 into baseFeesAccrued with permission bits 0x10cc",
      );
    }
  }
  const timing = p["priceTiming"];
  const routing = p["routingPolicy"];
  if (
    (timing !== "PRE_SWAP" && timing !== "POST_SWAP") ||
    (routing !== "LoopRouterOnly" && routing !== "Open") ||
    typeof p["excludeBuybackFromRewards"] !== "boolean"
  ) {
    throw new HooksLaunchManifestInvalidError(
      "priceTiming / routingPolicy / excludeBuybackFromRewards malformed",
    );
  }
  const capRaw = p["maxDynamicFeeWad"];
  const cap =
    capRaw === undefined
      ? undefined
      : // VerifyLoopProtocol writes this one as a JSON number (2e17 is
        // exact in a double; anything else is checked by the bound below).
        typeof capRaw === "number" && Number.isInteger(capRaw) && capRaw >= 0
        ? BigInt(capRaw).toString(10)
        : typeof capRaw === "string"
          ? capRaw
          : null;
  if (
    cap === null ||
    (cap !== undefined && !isHooksLaunchMaxDynamicFeeWad(cap))
  ) {
    throw new HooksLaunchManifestInvalidError("maxDynamicFeeWad malformed");
  }
  if (s209 && cap === undefined) {
    throw new HooksLaunchManifestInvalidError(
      "an S209 manifest has maxDynamicFeeWad",
    );
  }
  const params: HooksLaunchLoopDynamicParams = Object.freeze({
    router: address(ld["loopRouter"], "loopDynamic.loopRouter"),
    baseSellFeePpm: ppm(p["baseSellFeePpm"], "baseSellFeePpm"),
    baseFeeRecipient: address(p["baseFeeRecipient"], "baseFeeRecipient"),
    priceTiming: timing === "POST_SWAP" ? 1 : 0,
    routingPolicy: routing === "Open" ? 1 : 0,
    routerRegistryAdmin: address(
      p["routerRegistryAdmin"],
      "routerRegistryAdmin",
    ),
    excludeBuybackFromRewards: p["excludeBuybackFromRewards"],
    buyFeePpm: ppm(p["buyFeePpm"], "buyFeePpm"),
    ...(cap === undefined ? {} : { maxDynamicFeeWad: cap }),
    ...(s209 ? { maxCumulativeBuy: top["maxCumulativeBuy"] as string } : {}),
  });
  const recorded = ld["templateHash"];
  if (
    typeof recorded !== "string" ||
    hooksLaunchLoopDynamicTemplateHash(params).toLowerCase() !==
      recorded.toLowerCase()
  ) {
    throw new HooksLaunchManifestInvalidError(
      "loopDynamic.templateHash is not reproduced by its parameters",
    );
  }
  return Object.freeze({
    generation: s209 ? "s209" : "legacy",
    params,
    templateHash: recorded.toLowerCase(),
    buyFeeToken: s209 ? "usd1" : "meme",
    hookPermissionFlags: hooksLaunchLoopDynamicHookPermissionBits(params),
  });
}
