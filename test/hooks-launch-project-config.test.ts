import { describe, expect, it } from "vitest";

import {
  createHooksLaunchProjectConfigService,
  HooksLaunchProjectNotFoundError,
  HooksLaunchProjectVersionConflictError,
  type HooksLaunchProjectConfigRecord,
  type HooksLaunchProjectConfigRepository,
} from "../src/features/launch/hooks-launch-project-config.js";

const body = {
  name: "LOOP 项目示例",
  ticker: "MEME",
  logoAssetUrl: "https://cdn.example.com/logo.png",
  description: "Project description",
  links: ["https://example.com"],
  nftSaleStartAt: "1800000000",
  buybackRecipient: "0x1234567890123456789012345678901234567890",
};
const projectId = "00000000-0000-4000-8000-000000000001";

function makeHarness() {
  let record: HooksLaunchProjectConfigRecord | null = null;
  const repository: HooksLaunchProjectConfigRepository = {
    getOwnedDraft(input) {
      if (input.projectId !== projectId || input.ownerUserId !== "user-1") {
        return Promise.resolve(null);
      }
      return Promise.resolve(record);
    },
    saveOwnedDraft(input) {
      if (input.projectId !== projectId || input.ownerUserId !== "user-1") {
        return Promise.reject(new HooksLaunchProjectNotFoundError());
      }
      const version = record?.version ?? 0;
      if (input.expectedVersion !== version) {
        return Promise.reject(new HooksLaunchProjectVersionConflictError());
      }
      record = Object.freeze({
        ...input,
        version: version + 1,
        updatedAt: "2026-10-08T00:00:00.000Z",
      });
      return Promise.resolve(record);
    },
  };
  return { repository, getRecord: () => record };
}

describe("Hooks project config service", () => {
  it("persists owner-scoped drafts with the immutable Hooks economics", async () => {
    const harness = makeHarness();
    const service = createHooksLaunchProjectConfigService({
      repository: harness.repository,
      minimumLeadSeconds: 86_400,
      now: () => 1_790_000_000,
    });

    const result = await service.saveDraft({
      ownerUserId: "user-1",
      projectId,
      expectedVersion: 0,
      body,
    });

    expect(result.version).toBe(1);
    expect(result.config.fixedEconomics.curveBuyTaxBps).toBe(1_000);
    expect(result.config.fixedEconomics.buybackOrderUsd1Raw).toBe(
      "100000000000000000000",
    );
    expect(harness.getRecord()?.config.configHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("rejects stale writes and does not mutate the last saved version", async () => {
    const harness = makeHarness();
    const service = createHooksLaunchProjectConfigService({
      repository: harness.repository,
      minimumLeadSeconds: 86_400,
      now: () => 1_790_000_000,
    });
    await service.saveDraft({
      ownerUserId: "user-1",
      projectId,
      expectedVersion: 0,
      body,
    });

    await expect(
      service.saveDraft({
        ownerUserId: "user-1",
        projectId,
        expectedVersion: 0,
        body: { ...body, name: "Changed" },
      }),
    ).rejects.toBeInstanceOf(HooksLaunchProjectVersionConflictError);
    expect(harness.getRecord()?.version).toBe(1);
    expect(harness.getRecord()?.config.name).toBe(body.name);
  });

  it("does not disclose another owner's project", async () => {
    const service = createHooksLaunchProjectConfigService({
      repository: makeHarness().repository,
      minimumLeadSeconds: 86_400,
      now: () => 1_790_000_000,
    });

    await expect(
      service.saveDraft({
        ownerUserId: "user-2",
        projectId,
        expectedVersion: 0,
        body,
      }),
    ).rejects.toBeInstanceOf(HooksLaunchProjectNotFoundError);
  });

  it("rejects economic overrides even when submitted as extra config keys", async () => {
    const service = createHooksLaunchProjectConfigService({
      repository: makeHarness().repository,
      minimumLeadSeconds: 86_400,
      now: () => 1_790_000_000,
    });

    await expect(
      service.saveDraft({
        ownerUserId: "user-1",
        projectId,
        expectedVersion: 0,
        body: { ...body, officialPoolBuyTaxBps: 0 },
      }),
    ).rejects.toThrow("Invalid Hooks launch draft");
  });
});
