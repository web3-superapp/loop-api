import { describe, expect, it } from "vitest";

import {
  launch2ProjectLinks,
  launch2ProjectProfileProjection,
  launch2ProjectSummary,
} from "../src/features/launch2/launch2-project-profile.js";

/** Decision 0138: summary / links projected from the project profile. */
describe("launch2 project profile projection (Decision 0138)", () => {
  it("projects a saved profile: collapsed summary and the links verbatim", () => {
    expect(
      launch2ProjectProfileProjection({
        description: "  A frog\n\n launch\t on BSC.  ",
        links: ["https://x.com/frog", "http://frog.example/about?a=1"],
      }),
    ).toEqual({
      summary: "A frog launch on BSC.",
      links: ["https://x.com/frog", "http://frog.example/about?a=1"],
    });
  });

  it("answers null / [] without a profile (orphan or legacy instance)", () => {
    expect(launch2ProjectProfileProjection(null)).toEqual({
      summary: null,
      links: [],
    });
    expect(launch2ProjectProfileProjection(undefined)).toEqual({
      summary: null,
      links: [],
    });
    expect(
      launch2ProjectProfileProjection({ description: " \n\t ", links: [] }),
    ).toEqual({ summary: null, links: [] });
    expect(
      launch2ProjectProfileProjection({ description: null, links: [] }),
    ).toEqual({ summary: null, links: [] });
  });

  it("cuts a long description at 60 Unicode characters and appends …", () => {
    const exact = "a".repeat(60);
    expect(launch2ProjectSummary(exact)).toBe(exact);
    expect(launch2ProjectSummary(`${exact}b`)).toBe(`${exact}…`);
    // Code points, not UTF-16 units: 61 emoji keep 60 whole emoji.
    const emoji = "🐸".repeat(61);
    const cut = launch2ProjectSummary(emoji);
    expect(cut).toBe(`${"🐸".repeat(60)}…`);
    expect(Array.from(cut ?? "")).toHaveLength(61);
    expect(launch2ProjectSummary(`${"青蛙".repeat(40)}`)).toBe(
      `${"青蛙".repeat(30)}…`,
    );
    // Whitespace is collapsed before counting; no dangling space before …
    expect(launch2ProjectSummary(`${"a".repeat(59)}   bcd`)).toBe(
      `${"a".repeat(59)}…`,
    );
  });

  it("keeps only http(s) links", () => {
    expect(
      launch2ProjectLinks([
        "https://ok.example",
        "javascript:alert(1)",
        "ftp://files.example",
        "not a url",
        "mailto:a@b.example",
        "http://plain.example",
        "",
        42,
        `https://long.example/${"a".repeat(2048)}`,
      ]),
    ).toEqual(["https://ok.example", "http://plain.example"]);
    expect(launch2ProjectLinks(null)).toEqual([]);
  });

  it("returns at most 5 links in saved order", () => {
    const links = Array.from(
      { length: 8 },
      (_, index) => `https://l${index}.example/`,
    );
    expect(launch2ProjectLinks(links)).toEqual(links.slice(0, 5));
    expect(launch2ProjectLinks(["data:x", ...links])).toEqual(
      links.slice(0, 5),
    );
  });
});
