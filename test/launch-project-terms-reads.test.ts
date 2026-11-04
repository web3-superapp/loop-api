import { describe, expect, it } from "vitest";

import {
  createAdminLaunchReviewConsoleService,
  type AdminLaunchReviewRepository,
} from "../src/features/admin/admin-launch-review.js";
import { createUnavailableLaunchRepository } from "../src/features/launch/launch-repository.js";
import { createLaunchService } from "../src/features/launch/launch-service.js";
import {
  createInMemoryAdminLaunchReview,
  launchProjectFixture,
} from "./helpers/admin-role-fakes.js";

/**
 * Decision 0199: the launch terms read keys on GET /v2/launch/projects/{id}
 * and the admin launch review detail (`project`), behind
 * LAUNCH2_PROJECT_TERMS_EMIT (default off).
 */

const projectId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const ownerUserId = "00000000-0000-4000-8000-0000000000aa";
const terms = { nftPriceUsd1: 250, walletCapPerMille: 12 };

describe("GET /v2/launch/projects/{id} launch terms (Decision 0199)", () => {
  const record = {
    projectId,
    ownerUserId,
    name: "MoonCat",
    ticker: "MCAT",
    narrative: null,
    officialLinks: {},
    materialVersion: 1,
    kind: "launch2",
    reviewStatus: "approved",
    reviewReasonCode: null,
    reviewReasonText: null,
    rejection: null,
    communityId: null,
    kybStatus: "not_required",
    attachments: [],
    submittedAt: null,
    reviewedAt: null,
    launchId: null,
    version: 1,
    createdAt: "2026-11-04T00:00:00.000Z",
    updatedAt: "2026-11-04T00:00:00.000Z",
  };
  const service = (
    projectTerms: NonNullable<
      Parameters<typeof createLaunchService>[0]["projectTerms"]
    > | null,
  ) =>
    createLaunchService({
      repository: {
        ...createUnavailableLaunchRepository(),
        getProject: () => Promise.resolve(record as never),
      },
      cursorCodec: null,
      projectTerms,
    });
  const principal = { userId: ownerUserId } as never;

  it("omits the keys while the switch is off or without a reader", async () => {
    for (const source of [
      null,
      { emit: false, latest: () => Promise.resolve(terms) },
    ]) {
      const { project } = await service(source).getProject({
        principal,
        projectId,
      });
      expect(project).not.toHaveProperty("nftPriceUsd1");
      expect(project).not.toHaveProperty("maxCumulativeBuyRaw");
    }
  });

  it("emits the latest version's terms, defaults without a config", async () => {
    const on = await service({
      emit: true,
      latest: () => Promise.resolve(terms),
    }).getProject({ principal, projectId });
    expect(on.project).toMatchObject({
      nftPriceUsd1: 250,
      walletCapPerMille: 12,
      maxCumulativeBuyRaw: "12000000000000000000000000",
    });
    const none = await service({
      emit: true,
      latest: () => Promise.resolve(null),
    }).getProject({ principal, projectId });
    expect(none.project).toMatchObject({
      nftPriceUsd1: 100,
      walletCapPerMille: 5,
      maxCumulativeBuyRaw: "5000000000000000000000000",
    });
  });
});

describe("admin launch review detail `project` launch terms (Decision 0199)", () => {
  const project = launchProjectFixture({ projectId });
  const repository: AdminLaunchReviewRepository =
    createInMemoryAdminLaunchReview([project], new Map());
  const context = {
    principal: {
      kind: "account",
      accountId: "00000000-0000-4000-8000-000000000001",
      username: "ops",
      role: "administrator",
      permissions: ["launch.read"],
      operatorUserId: null,
    },
    requestId: "req-1",
  } as never;
  const service = (emit: boolean) =>
    createAdminLaunchReviewConsoleService({
      repository,
      projectTerms: {
        emit,
        latest: (id) => Promise.resolve(id === projectId ? terms : null),
      },
      deploymentChainId: 97,
      review: {} as never,
      audit: { appendAudit: () => Promise.reject(new Error("unused")) },
      sessionSecret: "s".repeat(32),
      logger: { warn: () => undefined },
    });

  it("puts the three keys on `project` with the switch on, none with it off", async () => {
    const on = (await service(true).getProject(context, projectId)) as {
      project: Record<string, unknown>;
    };
    expect(on.project).toMatchObject({
      projectId,
      nftPriceUsd1: 250,
      walletCapPerMille: 12,
      maxCumulativeBuyRaw: "12000000000000000000000000",
    });
    const off = (await service(false).getProject(context, projectId)) as {
      project: Record<string, unknown>;
    };
    expect(off.project).not.toHaveProperty("nftPriceUsd1");
    expect(off.project).not.toHaveProperty("walletCapPerMille");
    expect(off.project).not.toHaveProperty("maxCumulativeBuyRaw");
  });
});
