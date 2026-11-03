import type { ChainRegistryRepository } from "../../database/chain-registry-repository.js";
import type { Launch2Repository } from "../launch2/launch2-ports.js";
import type {
  DappKnownContract,
  DappKnownContractKind,
} from "../wallet-intents/intent-contract.js";
import type { DappContractDirectory } from "../wallet-intents/intent-preparation.js";

/**
 * Decision 0197 (S342): what the DApp sign sheet calls a "verified"
 * contract — one LOOP itself configures or indexes on the launch slot:
 * the LoopRouter / official pool router / router registry, the launch2
 * Factories, the contracts of a listed launch2 instance, the Launch (v1)
 * contract and its USD1, and assets the chain registry marks `verified`.
 * Everything else is unverified; nothing is inferred from names or
 * external lists.
 */

export interface DappStaticContracts {
  readonly chainId: string;
  readonly loopRouter: string | null;
  readonly poolRouter: string | null;
  readonly routerRegistry: string | null;
  readonly factories: readonly string[];
  readonly launchContract: string | null;
  readonly usd1: string | null;
}

const instanceRoles = [
  ["meme", "meme"],
  ["hook", "hook"],
  ["nft", "nft"],
  ["curve", "curve"],
  ["gate", "gate"],
  ["escrow", "escrow"],
  ["snapshots", "snapshots"],
  ["graduationAdapter", "graduationAdapter"],
  ["buybackAdapter", "buybackAdapter"],
  ["priceRecorder", "priceRecorder"],
  ["buybackExecutor", "buybackExecutor"],
] as const;

function known(
  kind: DappKnownContractKind,
  role: string | null = null,
  label: string | null = null,
): DappKnownContract {
  return Object.freeze({ kind, role, label });
}

export function createDappContractDirectory(input: {
  readonly statics: DappStaticContracts;
  readonly launch2?:
    Pick<Launch2Repository, "getInstanceByContractAddress"> | undefined;
  readonly registry?: Pick<ChainRegistryRepository, "getAsset"> | undefined;
}): DappContractDirectory {
  const statics = new Map<string, DappKnownContract>();
  const put = (address: string | null, contract: DappKnownContract) => {
    if (address !== null && !statics.has(address.toLowerCase())) {
      statics.set(address.toLowerCase(), contract);
    }
  };
  put(input.statics.loopRouter, known("loopRouter", null, "LoopRouter"));
  put(input.statics.poolRouter, known("launch2PoolRouter"));
  put(input.statics.routerRegistry, known("loopRouterRegistry"));
  for (const factory of input.statics.factories) {
    put(factory, known("launch2Factory"));
  }
  put(input.statics.launchContract, known("launchContract"));
  put(input.statics.usd1, known("usd1", null, "USD1"));

  const directory: DappContractDirectory = {
    async classify({ chainId, address }) {
      if (chainId !== input.statics.chainId) {
        return null;
      }
      const target = address.toLowerCase();
      const fixed = statics.get(target);
      if (fixed !== undefined) return fixed;
      const lookup = input.launch2?.getInstanceByContractAddress;
      if (lookup !== undefined && input.launch2 !== undefined) {
        const instance = await lookup.call(input.launch2, {
          chainId,
          address: target,
        });
        if (instance !== null) {
          const role =
            instanceRoles.find(
              ([key]) => instance.addresses[key].toLowerCase() === target,
            )?.[1] ?? null;
          return known("launch2Instance", role, instance.name);
        }
      }
      if (input.registry !== undefined) {
        const asset = await input.registry.getAsset(`${chainId}:${target}`);
        if (asset !== null && asset.status === "verified") {
          return known("registryAsset", null, asset.symbol);
        }
      }
      return null;
    },
  };
  return Object.freeze(directory);
}
