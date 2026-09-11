import { describe, expect, it } from "vitest";

import {
  InvalidLaunchRequestError,
  isVenueMilestoneTransitionAllowed,
  launchCommandDigest,
  launchProjectDigestParts,
  launchReviewReasonText,
  launchReviewStatuses,
  parseLaunchProjectValues,
  parseReplaceLaunchProjectRequest,
  reviewTransition,
  submitTransition,
  unavailableOnChainState,
  venueEvidenceDigest,
  venueMilestoneRequiresEvidence,
  venueMilestoneStates,
} from "../src/features/launch/launch-contract.js";

describe("launch application state machine", () => {
  it("lets the applicant submit only from draft or returned", () => {
    expect(submitTransition("draft")).toBe("submitted");
    expect(submitTransition("returned")).toBe("submitted");
    for (const status of [
      "submitted",
      "in_review",
      "approved",
      "rejected",
    ] as const) {
      expect(submitTransition(status), status).toBeNull();
    }
  });

  it("lets the operator review, approve, return, or reject a submitted project", () => {
    expect(reviewTransition("submitted", "review")).toBe("in_review");
    expect(reviewTransition("submitted", "approve")).toBe("approved");
    expect(reviewTransition("in_review", "approve")).toBe("approved");
    expect(reviewTransition("in_review", "return")).toBe("returned");
    expect(reviewTransition("in_review", "reject")).toBe("rejected");
    for (const status of [
      "draft",
      "returned",
      "approved",
      "rejected",
    ] as const) {
      expect(reviewTransition(status, "approve"), status).toBeNull();
      expect(reviewTransition(status, "review"), status).toBeNull();
    }
    expect(launchReviewStatuses).toHaveLength(6);
  });
});

describe("venue milestone state machine (03 §8.4)", () => {
  it("allows only the documented transitions", () => {
    expect(isVenueMilestoneTransitionAllowed("PREPARING", "APPLIED")).toBe(
      true,
    );
    expect(
      isVenueMilestoneTransitionAllowed("APPLIED", "EVIDENCE_PENDING"),
    ).toBe(true);
    expect(
      isVenueMilestoneTransitionAllowed("EVIDENCE_PENDING", "LISTED"),
    ).toBe(true);
    expect(
      isVenueMilestoneTransitionAllowed("EVIDENCE_PENDING", "FEATURED"),
    ).toBe(true);
    expect(isVenueMilestoneTransitionAllowed("LISTED", "DELISTED")).toBe(true);
    // Alpha (FEATURED) never implies spot; and nothing jumps to LISTED.
    expect(isVenueMilestoneTransitionAllowed("PREPARING", "LISTED")).toBe(
      false,
    );
    expect(isVenueMilestoneTransitionAllowed("APPLIED", "LISTED")).toBe(false);
    expect(isVenueMilestoneTransitionAllowed("DELISTED", "LISTED")).toBe(false);
    for (const state of venueMilestoneStates) {
      expect(isVenueMilestoneTransitionAllowed(state, state)).toBe(false);
    }
  });

  it("requires evidence for the two platform-fact states and digests it", () => {
    expect(venueMilestoneRequiresEvidence("LISTED")).toBe(true);
    expect(venueMilestoneRequiresEvidence("FEATURED")).toBe(true);
    expect(venueMilestoneRequiresEvidence("APPLIED")).toBe(false);
    const digest = venueEvidenceDigest("https://announcements.example/lbank/1");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(
      venueEvidenceDigest("https://announcements.example/lbank/1"),
    );
    expect(digest).not.toBe(
      venueEvidenceDigest("https://announcements.example/lbank/2"),
    );
  });
});

describe("launch request parsing", () => {
  const valid = {
    name: "  MoonCat  ",
    ticker: "MCAT",
    narrative: "A curated meme with a story.",
    officialLinks: { website: "https://mooncat.example", x: null },
  };

  it("normalises a draft body and fills absent links with null", () => {
    const values = parseLaunchProjectValues(valid);
    expect(values).toEqual({
      name: "MoonCat",
      ticker: "MCAT",
      narrative: "A curated meme with a story.",
      officialLinks: {
        website: "https://mooncat.example",
        x: null,
        telegram: null,
        discord: null,
      },
    });
  });

  it("treats an omitted officialLinks object as four null links", () => {
    const withoutLinks = {
      name: valid.name,
      ticker: valid.ticker,
      narrative: valid.narrative,
    };
    expect(parseLaunchProjectValues(withoutLinks).officialLinks).toEqual({
      website: null,
      x: null,
      telegram: null,
      discord: null,
    });
  });

  it("rejects a lowercase ticker, a non-https link, credentials in a link, control characters, and unknown keys", () => {
    for (const body of [
      { ...valid, ticker: "mcat" },
      { ...valid, officialLinks: { website: "http://mooncat.example" } },
      {
        ...valid,
        officialLinks: { website: "https://user:pw@mooncat.example" },
      },
      { ...valid, name: "Moon\u0000Cat" },
      { ...valid, extra: true },
      { ...valid, officialLinks: { youtube: "https://x" } },
      { ...valid, narrative: "" },
    ]) {
      expect(() => parseLaunchProjectValues(body)).toThrow(
        InvalidLaunchRequestError,
      );
    }
  });

  it("parses a compare-and-swap replacement and rejects version 0", () => {
    expect(
      parseReplaceLaunchProjectRequest({ expectedVersion: 3, project: valid })
        .expectedVersion,
    ).toBe(3);
    expect(() =>
      parseReplaceLaunchProjectRequest({ expectedVersion: 0, project: valid }),
    ).toThrow(InvalidLaunchRequestError);
  });

  it("binds every field into the command digest with present/absent markers", () => {
    const a = parseLaunchProjectValues(valid);
    const b = parseLaunchProjectValues({ ...valid, narrative: null });
    expect(launchProjectDigestParts(a)).not.toEqual(
      launchProjectDigestParts(b),
    );
    expect(
      launchCommandDigest("createProject", launchProjectDigestParts(a)),
    ).not.toBe(
      launchCommandDigest("createProject", launchProjectDigestParts(b)),
    );
    expect(
      launchCommandDigest("createProject", launchProjectDigestParts(a)),
    ).toBe(launchCommandDigest("createProject", launchProjectDigestParts(a)));
  });
});

describe("four-axis projection", () => {
  it("uses the fixed axis names, literal unavailable values, and null digest/snapshot", () => {
    expect(unavailableOnChainState).toEqual({
      saleState: "unavailable",
      entitlementState: "unavailable",
      liquidityState: "unavailable",
      operationalState: "unavailable",
      stateTupleDigest: null,
      snapshotBlockNumber: null,
      snapshotBlockHash: null,
      source: "unavailable",
      reasonCode: "LAUNCH_CONTRACT_BASELINE_PENDING",
    });
    expect(Object.keys(unavailableOnChainState)).not.toContain(
      "graduationState",
    );
  });
});

describe("applicant-facing review copy (Decision 0041)", () => {
  it("shows nothing when there is no stored reason code", () => {
    for (const status of launchReviewStatuses) {
      expect(launchReviewReasonText(status, null), status).toBeNull();
    }
  });

  it("explains a catalog code on the status it belongs to", () => {
    expect(launchReviewReasonText("returned", "needs_more_material")).toBe(
      "材料还不完整，补齐后可以重新提交审核。",
    );
    expect(launchReviewReasonText("rejected", "policy_violation")).toBe(
      "材料不符合上线规则，这份申请不会继续；调整后可以新建项目再提交。",
    );
  });

  it("falls back to the status sentence for a generic, unknown, or mismatched code", () => {
    const approved = launchReviewReasonText(
      "approved",
      "operator_manual_review",
    );
    expect(approved).toBe("审核已通过，材料不再可改，可以继续后面的发行安排。");
    expect(launchReviewReasonText("in_review", "operator_manual_review")).toBe(
      "材料正在审核，这期间不能修改，有结果后状态会更新。",
    );
    // An operator code invented outside the catalog never reaches a screen.
    expect(launchReviewReasonText("returned", "some_new_operator_code")).toBe(
      "材料被退回，修改后可以重新提交审核。",
    );
    // A catalog code used against another status explains the status instead
    // of telling the applicant to do what the state machine forbids.
    expect(launchReviewReasonText("rejected", "needs_more_material")).toBe(
      "审核未通过，这份申请不能再提交，需要的话可以新建项目。",
    );
  });

  it("keeps every sentence free of internal identifiers and to one sentence", () => {
    const codes = [
      "operator_manual_review",
      "needs_more_material",
      "official_links_unreachable",
      "material_mismatch",
      "ticker_conflict",
      "duplicate_submission",
      "policy_violation",
    ];
    for (const status of launchReviewStatuses) {
      for (const code of codes) {
        const text = launchReviewReasonText(status, code);
        expect(text, `${status}/${code}`).not.toBeNull();
        const sentence = text ?? "";
        // No reason code, rule id, step number, or other latin identifier.
        expect(sentence, `${status}/${code}`).not.toMatch(/[A-Za-z0-9_]/u);
        expect(sentence.length, `${status}/${code}`).toBeLessThanOrEqual(40);
        expect(sentence.endsWith("。"), `${status}/${code}`).toBe(true);
        expect(sentence.slice(0, -1).includes("。"), `${status}/${code}`).toBe(
          false,
        );
      }
    }
  });
});
