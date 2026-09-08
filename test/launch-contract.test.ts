import { describe, expect, it } from "vitest";

import {
  InvalidLaunchRequestError,
  isVenueMilestoneTransitionAllowed,
  launchCommandDigest,
  launchProjectDigestParts,
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
