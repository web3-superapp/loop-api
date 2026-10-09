import { describe, expect, it } from "vitest";
import {
  commandPermission,
  opsCommandSchema,
  opsHash,
} from "../src/features/ops/ops-contract.js";

describe("operations command boundary", () => {
  it("hashes key order canonically without conflating values", () => {
    expect(opsHash({ a: "1", b: [2] })).toBe(opsHash({ b: [2], a: "1" }));
    expect(opsHash({ a: "1" })).not.toBe(opsHash({ a: 1 }));
  });
  it("rejects supplied actors and unsupported execution actions", () => {
    expect(
      opsCommandSchema.safeParse({ action: "transfer", actor: "admin" })
        .success,
    ).toBe(false);
    expect(
      opsCommandSchema.safeParse({
        action: "support.answer",
        operationId: "b51b0ade-16dc-4c1e-9dd3-2f387a076591",
        target: "b51b0ade-16dc-4c1e-9dd3-2f387a076590",
        reason: "处理",
        payload: { status: "answered", note: "已处理" },
        actor: "admin",
      }).success,
    ).toBe(false);
  });
  it("routes Hooks config writes through the project edit permission", () => {
    const command = opsCommandSchema.parse({
      operationId: "b51b0ade-16dc-4c1e-9dd3-2f387a076591",
      action: "launch.config.save",
      target: "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f",
      reason: "项目确认调整开售时间",
      payload: {
        expectedVersion: 0,
        config: {
          name: "Moon Cat",
          ticker: "MCAT",
          logoAssetUrl: "https://cdn.example/mcat.png",
          description: "Community token",
          links: ["https://example.org"],
          nftSaleStartAt: "1798848000",
          buybackRecipient: "0x28816c4C4792467390C90e5B426F198570E29307",
        },
      },
    });
    expect(commandPermission(command.action)).toBe("launch.edit");
    expect(
      opsCommandSchema.safeParse({
        operationId: "b51b0ade-16dc-4c1e-9dd3-2f387a076591",
        action: "launch.config.save",
        target: "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f",
        reason: "项目确认调整开售时间",
        payload: {
          expectedVersion: 0,
          config: {
            name: "Moon Cat",
            ticker: "MCAT",
            logoAssetUrl: "https://cdn.example/mcat.png",
            description: "Community token",
            links: ["https://example.org"],
            nftSaleStartAt: "1798848000",
            buybackRecipient: "0x28816c4C4792467390C90e5B426F198570E29307",
            curveBuyTaxBps: 500,
          },
        },
      }).success,
    ).toBe(false);
  });

  it("requires a different launch approver and testnet evidence payloads", () => {
    const approval = opsCommandSchema.parse({
      operationId: "b51b0ade-16dc-4c1e-9dd3-2f387a076591",
      action: "launch.config.approve",
      target: "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f",
      reason: "复核配置哈希",
      payload: { configVersion: 1, configHash: `0x${"a".repeat(64)}` },
    });
    expect(commandPermission(approval.action)).toBe("launch.approve");

    const acceptance = opsCommandSchema.parse({
      operationId: "b51b0ade-16dc-4c1e-9dd3-2f387a076592",
      action: "testnet.acceptance.record",
      target: "9c1f0f2e-5a7b-4c3d-8e9f-0a1b2c3d4e5f",
      reason: "BSC Testnet 验收记录",
      payload: {
        configVersion: 1,
        configHash: `0x${"a".repeat(64)}`,
        contractManifestHash: `0x${"b".repeat(64)}`,
        checklistVersion: "hooks-testnet-v1",
        outcome: "passed",
        evidence: [{ label: "测试报告", uri: "https://example.org/report" }],
      },
    });
    expect(commandPermission(acceptance.action)).toBe("testnet.accept");
    expect(
      opsCommandSchema.safeParse({
        ...acceptance,
        payload: { ...acceptance.payload, chainId: 56 },
      }).success,
    ).toBe(false);
  });
});
