import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import {
  createMiningClaimSigner,
  miningClaimDomain,
  miningClaimTypes,
} from "../src/features/mining/claim-voucher.js";
import { miningHourBudget } from "../src/features/mining/hourly-budget.js";
import { projectMiningMinuteDisplay } from "../src/features/mining/hourly-display.js";
import {
  MiningSettlementInputError,
  settleMiningHour,
  type MiningHourlySettlementInput,
  type MiningParameterSlice,
} from "../src/features/mining/hourly-settlement-calculator.js";
import {
  MiningParameterDocumentError,
  miningDefaultParameterDocument,
  parseMiningParameterDocument,
} from "../src/features/mining/hourly-settlement-contract.js";
import {
  claimContract,
  loop,
  signerKey,
} from "./helpers/mining-settlement-fakes.js";

/**
 * Decision 0116 pure rules. The `§9-n` tests map one-to-one onto the
 * requirer's acceptance table (LOOP双轨挖矿开发说明 §9); the rest pin the
 * budget, display, parameter, and voucher rules.
 */

const S = BigInt(Date.parse("2026-10-10T10:00:00.000Z") / 1000);
const E = S + 3_600n;
const C = "c0000000-0000-4000-8000-000000000001";
const C2 = "c0000000-0000-4000-8000-000000000002";
const ASSET = "eip155:97:0x1111111111111111111111111111111111116666";
const user = (n: number) =>
  `a0000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;

function slice(
  from: bigint,
  to: bigint,
  coefficients: Record<string, string> = { [C]: "2" },
  weights: Record<string, string> = { [ASSET]: "1" },
  versionId = "v1",
): MiningParameterSlice {
  const fixed = (value: string) => {
    const [whole, fraction = ""] = value.split(".");
    return BigInt(whole as string) * loop + BigInt(fraction.padEnd(18, "0"));
  };
  return {
    from,
    to,
    versionId,
    coefficients: new Map(
      Object.entries(coefficients).map(([key, value]) => [key, fixed(value)]),
    ),
    assetWeights: new Map(
      Object.entries(weights).map(([key, value]) => [key, fixed(value)]),
    ),
  };
}

function input(
  overrides: Partial<MiningHourlySettlementInput> = {},
): MiningHourlySettlementInput {
  return {
    hourStart: S,
    hourEnd: E,
    budgetNftRaw: 1_000n * loop,
    budgetAssetRaw: 1_000n * loop,
    referralRatiosBps: [1000, 500, 300, 200, 100],
    parameterSlices: [slice(S, E)],
    nftHoldings: [],
    assetHoldings: [],
    prices: [],
    referralEdges: [],
    ...overrides,
  };
}

function nft(userId: string, count: bigint, from = S, to = E, community = C) {
  return {
    userId,
    instanceId: "i0000000-0000-4000-8000-000000000001",
    communityId: community,
    from,
    to,
    count,
  };
}

function chainEdges(invitee: string, ancestors: readonly string[]) {
  return ancestors.map((inviter, index) => ({
    inviterUserId: inviter,
    inviteeUserId: invitee,
    depth: index + 1,
    from: 0n,
    to: null,
  }));
}

function byUser(result: ReturnType<typeof settleMiningHour>, userId: string) {
  const row = result.users.find((entry) => entry.userId === userId);
  if (row === undefined) throw new Error(`no row for ${userId}`);
  return row;
}

describe("Decision 0116 hourly settlement — requirer §9 acceptance", () => {
  it("§9-1 下级持有 5 个有效 NFT：五级上级分别获得 0.5/0.25/0.15/0.1/0.05 等效 NFT 单位，并按来源社区系数加权", () => {
    const ancestors = [user(1), user(2), user(3), user(4), user(5)];
    const result = settleMiningHour(
      input({
        nftHoldings: [nft(user(9), 5n)],
        referralEdges: chainEdges(user(9), ancestors),
      }),
    );
    const units = ["0.5", "0.25", "0.15", "0.1", "0.05"];
    const powers = ["1", "0.5", "0.3", "0.2", "0.1"];
    ancestors.forEach((ancestor, index) => {
      const level = byUser(result, ancestor).levels[index];
      const fixed = (value: string) => {
        const [whole, fraction = ""] = value.split(".");
        return (
          BigInt(whole as string) * loop + BigInt(fraction.padEnd(18, "0"))
        );
      };
      expect(level?.nftUnitsByCommunity.get(C)).toBe(
        fixed(units[index] as string),
      );
      expect(level?.nftPower).toBe(fixed(powers[index] as string));
      expect(level?.effectiveMembers).toBe(1);
    });
    expect(byUser(result, user(9)).nftSelfPower).toBe(10n * loop);
  });

  it("§9-2 上级无真实 NFT 但有邀请算力：按邀请算力参与 NFT 池奖励，没有真实 NFT 持有", () => {
    const result = settleMiningHour(
      input({
        nftHoldings: [nft(user(9), 5n)],
        referralEdges: chainEdges(user(9), [user(1)]),
      }),
    );
    const upper = byUser(result, user(1));
    expect(upper.nftSelfPower).toBe(0n);
    expect(upper.nftHoldings).toEqual([]);
    expect(upper.nftReferralPower).toBe(1n * loop);
    expect(upper.nftRewardRaw > 0n).toBe(true);
    // 1 of 11 total power of the NFT pool.
    expect(upper.nftRewardRaw).toBe((1_000n * loop * 1n) / 11n);
  });

  it("§9-3 下级同时有本人算力和邀请算力：上级只用下级本人算力，不递归放大", () => {
    const top = user(1);
    const middle = user(2);
    const bottom = user(3);
    const result = settleMiningHour(
      input({
        parameterSlices: [slice(S, E, { [C]: "1" })],
        nftHoldings: [nft(middle, 5n), nft(bottom, 10n)],
        referralEdges: [
          {
            inviterUserId: top,
            inviteeUserId: middle,
            depth: 1,
            from: 0n,
            to: null,
          },
          {
            inviterUserId: middle,
            inviteeUserId: bottom,
            depth: 1,
            from: 0n,
            to: null,
          },
          {
            inviterUserId: top,
            inviteeUserId: bottom,
            depth: 2,
            from: 0n,
            to: null,
          },
        ],
      }),
    );
    expect(byUser(result, middle).nftReferralPower).toBe(1n * loop);
    // top: 10% × 5 (middle's own) + 5% × 10 = 1.0, never 10% of middle's 6.
    expect(byUser(result, top).nftReferralPower).toBe(1n * loop);
    // The middle is not reduced by the boost it gives.
    expect(byUser(result, middle).nftSelfPower).toBe(5n * loop);
  });

  it("§9-4 同一来源的五级以上祖先：不产生邀请加成（图谱不存第六级，输入也拒绝）", () => {
    const sixth = user(6);
    const result = settleMiningHour(
      input({
        nftHoldings: [nft(user(9), 5n)],
        referralEdges: chainEdges(user(9), [
          user(1),
          user(2),
          user(3),
          user(4),
          user(5),
        ]),
      }),
    );
    expect(result.users.some((row) => row.userId === sixth)).toBe(false);
    expect(() =>
      settleMiningHour(
        input({
          nftHoldings: [nft(user(9), 5n)],
          referralEdges: [
            {
              inviterUserId: sixth,
              inviteeUserId: user(9),
              depth: 6,
              from: 0n,
              to: null,
            },
          ],
        }),
      ),
    ).toThrow(MiningSettlementInputError);
  });

  it("§9-5 两条轨道同时挖矿：分别计算各池份额，总奖励为两轨之和", () => {
    const result = settleMiningHour(
      input({
        nftHoldings: [nft(user(1), 1n), nft(user(3), 1n)],
        assetHoldings: [
          {
            userId: user(2),
            assetId: ASSET,
            from: S,
            to: E,
            balanceRaw: 100n * loop,
          },
          {
            userId: user(3),
            assetId: ASSET,
            from: S,
            to: E,
            balanceRaw: 300n * loop,
          },
        ],
        prices: [{ assetId: ASSET, from: S, to: E, priceE18: loop / 100n }],
      }),
    );
    const both = byUser(result, user(3));
    expect(byUser(result, user(1)).nftRewardRaw).toBe(500n * loop);
    expect(byUser(result, user(2)).assetRewardRaw).toBe(250n * loop);
    expect(both.nftRewardRaw).toBe(500n * loop);
    expect(both.assetRewardRaw).toBe(750n * loop);
    expect(both.totalRewardRaw).toBe(both.nftRewardRaw + both.assetRewardRaw);
    expect(result.nft.allocatedRaw).toBe(1_000n * loop);
    expect(result.asset.allocatedRaw).toBe(1_000n * loop);
  });

  it("§9-6 某池全网算力为零：不产生用户奖励，不自动转给另一池", () => {
    const result = settleMiningHour(input({ nftHoldings: [nft(user(1), 2n)] }));
    expect(result.asset.denominatorPower).toBe(0n);
    expect(result.asset.allocatedRaw).toBe(0n);
    expect(result.asset.unallocatedRaw).toBe(1_000n * loop);
    expect(byUser(result, user(1)).assetRewardRaw).toBe(0n);
    // The NFT pool gets its own budget only, never the asset pool's.
    expect(result.nft.allocatedRaw).toBe(1_000n * loop);
  });

  it("§9-7 10:00–11:00 结算 60 LOOP：下一小时每分钟展示 1 LOOP；可领取按完整已结算计算（见路由测试）", () => {
    const lastEpoch = {
      hourStart: "2026-10-10T10:00:00.000Z",
      hourEnd: "2026-10-10T11:00:00.000Z",
      totalRewardRaw: 60n * loop,
    };
    const at = (iso: string) =>
      projectMiningMinuteDisplay({ now: new Date(iso), lastEpoch });
    expect(at("2026-10-10T11:00:30.000Z").displayedRaw).toBe("0");
    expect(at("2026-10-10T11:01:00.000Z").displayedRaw).toBe(
      (1n * loop).toString(),
    );
    expect(at("2026-10-10T11:20:00.000Z").displayedRaw).toBe(
      (20n * loop).toString(),
    );
    expect(at("2026-10-10T11:20:00.000Z").perMinuteRaw).toBe(
      (1n * loop).toString(),
    );
    expect(at("2026-10-10T11:59:59.999Z").displayedRaw).toBe(
      (59n * loop).toString(),
    );
    const done = at("2026-10-10T12:00:00.000Z");
    expect(done.displayedRaw).toBe((60n * loop).toString());
    expect(done.displayState).toBe("settling");
    expect(done.nextUpdateAt).toBeNull();
  });

  it("§9-9 刷新、离线或切换设备：展示进度只由统一时间推导，同一时刻结果一致", () => {
    const lastEpoch = {
      hourStart: "2026-10-10T10:00:00.000Z",
      hourEnd: "2026-10-10T11:00:00.000Z",
      totalRewardRaw: 61n,
    };
    const now = new Date("2026-10-10T11:20:10.000Z");
    const deviceA = projectMiningMinuteDisplay({ now, lastEpoch });
    const deviceB = projectMiningMinuteDisplay({ now, lastEpoch });
    expect(deviceA).toEqual(deviceB);
    expect(deviceA.completedMinutes).toBe(20);
    expect(deviceA.nextUpdateAt).toBe("2026-10-10T11:21:00.000Z");
    // The rounding remainder lands on the last minute.
    expect(
      projectMiningMinuteDisplay({
        now: new Date("2026-10-10T11:59:00.000Z"),
        lastEpoch,
      }).displayedRaw,
    ).toBe("59");
    expect(
      projectMiningMinuteDisplay({
        now: new Date("2026-10-10T12:00:00.000Z"),
        lastEpoch,
      }).displayedRaw,
    ).toBe("61");
  });

  it("§9-13 小时内持仓或系数变化：按生效时间纳入当期计算", () => {
    const half = S + 1_800n;
    // Holding 4 NFTs only for the second half: average 2 × coefficient 2.
    const holding = settleMiningHour(
      input({ nftHoldings: [nft(user(1), 4n, half, E)] }),
    );
    expect(byUser(holding, user(1)).nftSelfPower).toBe(4n * loop);
    // Coefficient 2 → 4 at half past: 5 NFTs average (10 + 20) / 2 = 15.
    const coefficient = settleMiningHour(
      input({
        parameterSlices: [
          slice(S, half, { [C]: "2" }, {}, "v1"),
          slice(half, E, { [C]: "4" }, {}, "v2"),
        ],
        nftHoldings: [nft(user(1), 5n)],
      }),
    );
    expect(byUser(coefficient, user(1)).nftSelfPower).toBe(15n * loop);
    // A referral edge in force for half the hour contributes half.
    const edge = settleMiningHour(
      input({
        nftHoldings: [nft(user(9), 5n)],
        referralEdges: [
          {
            inviterUserId: user(1),
            inviteeUserId: user(9),
            depth: 1,
            from: half,
            to: null,
          },
        ],
      }),
    );
    expect(byUser(edge, user(1)).nftReferralPower).toBe(loop / 2n);
  });
});

describe("Decision 0116 calculator rules", () => {
  it("does not count a zero-power invitee as an effective member", () => {
    const result = settleMiningHour(
      input({
        nftHoldings: [nft(user(9), 5n), nft(user(8), 3n, S, E, C2)],
        referralEdges: [
          ...chainEdges(user(9), [user(1)]),
          // user(8) holds only NFTs of a community without a coefficient.
          ...chainEdges(user(8), [user(1)]),
          ...chainEdges(user(7), [user(1)]),
        ],
      }),
    );
    expect(byUser(result, user(1)).levels[0]?.effectiveMembers).toBe(1);
  });

  it("feeds NFT sources into the NFT pool and asset sources into the asset pool", () => {
    const result = settleMiningHour(
      input({
        assetHoldings: [
          {
            userId: user(9),
            assetId: ASSET,
            from: S,
            to: E,
            balanceRaw: 1_000n * loop,
          },
        ],
        prices: [{ assetId: ASSET, from: S, to: E, priceE18: loop }],
        referralEdges: chainEdges(user(9), [user(1)]),
      }),
    );
    const upper = byUser(result, user(1));
    expect(upper.nftReferralPower).toBe(0n);
    expect(upper.assetReferralPower).toBe(100n * loop);
  });

  it("refuses a weighted positive holding without a price for the whole holding time", () => {
    expect(() =>
      settleMiningHour(
        input({
          assetHoldings: [
            {
              userId: user(1),
              assetId: ASSET,
              from: S,
              to: E,
              balanceRaw: loop,
            },
          ],
          prices: [{ assetId: ASSET, from: S, to: S + 60n, priceE18: loop }],
        }),
      ),
    ).toThrow(/MINING_SETTLEMENT_PRICE_MISSING/u);
  });

  it("never allocates more than the hour budget and keeps the dust unallocated", () => {
    const result = settleMiningHour(
      input({
        budgetNftRaw: 100n,
        nftHoldings: [nft(user(1), 1n), nft(user(2), 1n), nft(user(3), 1n)],
      }),
    );
    expect(result.nft.allocatedRaw).toBe(99n);
    expect(result.nft.unallocatedRaw).toBe(1n);
  });

  it("refuses parameter slices that do not tile the hour", () => {
    expect(() =>
      settleMiningHour(input({ parameterSlices: [slice(S, S + 60n)] })),
    ).toThrow(MiningSettlementInputError);
  });
});

describe("Decision 0116 hour budget", () => {
  const daily = 500_000n * loop;
  const release = BigInt(Date.parse("2026-10-10T00:00:00.000Z") / 1000);

  it("spreads 500,000 LOOP evenly and puts the remainder on UTC 23:00", () => {
    let total = 0n;
    for (let hour = 0n; hour < 24n; hour += 1n) {
      const budget = miningHourBudget({
        hourStart: release + hour * 3_600n,
        dailyBudgetRaw: daily,
        releaseStart: release,
        releaseDays: 900,
      });
      if (hour < 23n) expect(budget).toBe(20_833_333_333_333_333_333_333n);
      else expect(budget).toBe(20_833_333_333_333_333_333_341n);
      total += budget;
    }
    expect(total).toBe(daily);
  });

  it("has no budget before the release start or after 900 days", () => {
    expect(
      miningHourBudget({
        hourStart: release - 3_600n,
        dailyBudgetRaw: daily,
        releaseStart: release,
        releaseDays: 900,
      }),
    ).toBe(0n);
    expect(
      miningHourBudget({
        hourStart: release + 900n * 86_400n,
        dailyBudgetRaw: daily,
        releaseStart: release,
        releaseDays: 900,
      }),
    ).toBe(0n);
  });
});

describe("Decision 0116 display and parameters", () => {
  it("shows awaiting_first_settlement and no growth before the first hour settles", () => {
    expect(
      projectMiningMinuteDisplay({ now: new Date(), lastEpoch: null }),
    ).toMatchObject({
      displayState: "awaiting_first_settlement",
      displayedRaw: "0",
      windowStart: null,
    });
  });

  it("parses a parameter document and refuses a malformed field by name", () => {
    const document = parseMiningParameterDocument({
      ...miningDefaultParameterDocument,
      releaseStartAt: "2026-10-11T00:00:00Z",
      assetWeights: [{ assetId: ASSET, weight: "1.50" }],
      communityCoefficients: [{ communityId: C, coefficient: "2" }],
    });
    expect(document.assetWeights).toEqual([{ assetId: ASSET, weight: "1.5" }]);
    expect(document.releaseStartAt).toBe("2026-10-11T00:00:00.000Z");
    try {
      parseMiningParameterDocument({
        ...miningDefaultParameterDocument,
        releaseStartAt: "2026-10-11T03:00:00Z",
        assetWeights: [],
        communityCoefficients: [],
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MiningParameterDocumentError);
      expect((error as MiningParameterDocumentError).field).toBe(
        "releaseStartAt",
      );
    }
  });
});

describe("Decision 0116 claim voucher", () => {
  it("signs the docs/16 §6 EIP-712 Claim that recovers to the signer", async () => {
    const signer = createMiningClaimSigner(signerKey);
    const voucher = {
      wallet: "0x000000000000000000000000000000000000000a" as const,
      cumulativeAmount: 60n * loop,
      nonce: 3n,
      deadline: 1_791_630_000n,
    };
    const signature = await signer.sign({
      chainId: 97,
      contract: claimContract,
      voucher,
    });
    const recovered = await recoverTypedDataAddress({
      domain: miningClaimDomain(97, claimContract),
      types: miningClaimTypes,
      primaryType: "Claim",
      message: voucher,
      signature,
    });
    expect(recovered.toLowerCase()).toBe(
      privateKeyToAccount(signerKey).address.toLowerCase(),
    );
    expect(signer.address).toBe(recovered.toLowerCase());
  });
});
