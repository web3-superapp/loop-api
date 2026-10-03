import { describe, expect, it } from "vitest";
import { parseOperatorArgs } from "../scripts/ops-operator.js";
const user = "3f5493ce-6226-4ac0-b73e-102443a16a79";
describe("operator bootstrap arguments", () => {
  it("requires deliberate confirmation and a real user identifier", () => {
    expect(() =>
      parseOperatorArgs([
        "--user",
        user,
        "--label",
        "Ops",
        "--permissions",
        "mining.edit",
      ]),
    ).toThrow();
  });
  it("rejects invented roles, duplicate flags and scoped global grants", () => {
    for (const args of [
      ["--permissions", "root"],
      ["--permissions", "mining.edit", "--scope", user],
      ["--permissions", "mining.read", "--user", user],
    ])
      expect(() =>
        parseOperatorArgs([
          "--user",
          user,
          "--label",
          "Ops",
          "--confirm",
          ...args,
        ]),
      ).toThrow();
  });
  it("supports narrow community scope and revoke without granting anything", () => {
    expect(
      parseOperatorArgs(["--user", user, "--confirm", "--revoke"]),
    ).toEqual({ userId: user, revoke: true });
    expect(
      parseOperatorArgs([
        "--user",
        user,
        "--label",
        "Ops",
        "--permissions",
        "community.review",
        "--scope",
        user,
        "--confirm",
      ]),
    ).toMatchObject({ scope: user, permissions: ["community.review"] });
  });
});
