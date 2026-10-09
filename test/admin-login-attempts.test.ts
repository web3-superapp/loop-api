import { beforeAll, describe, expect, it } from "vitest";

import { hashAdminPassword } from "../src/features/admin/admin-auth.js";
import {
  adminLoginIpKey,
  adminLoginMalformedUsernameKey,
  adminLoginUsernameKey,
  createMemoryAdminLoginAttemptStore,
  defaultAdminLoginPolicy,
  type AdminLoginPolicy,
  type AdminLoginSubjects,
} from "../src/features/admin/admin-login-attempts.js";
import { s7TestConfig } from "./s7-route-fakes.js";

/**
 * Decision 0110: login lock buckets per lower-cased username and per client
 * address (the transitions the PostgreSQL store shares).
 */

const policy: AdminLoginPolicy = defaultAdminLoginPolicy;

function subjects(username: string, ip = "203.0.113.7"): AdminLoginSubjects {
  return {
    usernameKey: adminLoginUsernameKey(username),
    ipKey: adminLoginIpKey(ip),
  };
}

describe("admin login attempt keys (Decision 0110)", () => {
  it("lower-cases account names and never stores other typed text", () => {
    expect(adminLoginUsernameKey("Reviewer.One")).toBe("reviewer.one");
    expect(adminLoginUsernameKey("has space")).toBe(
      adminLoginMalformedUsernameKey,
    );
    expect(adminLoginUsernameKey("p@ss word!")).toBe(
      adminLoginMalformedUsernameKey,
    );
  });

  it("keys IPv4 as is, IPv4-mapped IPv6 as IPv4, IPv6 by /64", () => {
    expect(adminLoginIpKey("203.0.113.7")).toBe("203.0.113.7");
    expect(adminLoginIpKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(adminLoginIpKey("2001:db8:0:12:aaaa::1")).toBe("2001:db8:0:12::/64");
    expect(adminLoginIpKey("2001:0DB8:0000:0012:ffff:0:0:2")).toBe(
      "2001:db8:0:12::/64",
    );
    expect(adminLoginIpKey("::1")).toBe("0:0:0:0::/64");
    expect(adminLoginIpKey(undefined)).toBe("unknown");
    expect(adminLoginIpKey("not-an-ip")).toBe("unknown");
  });
});

describe("in-memory admin login attempt store (Decision 0110)", () => {
  it("locks one username after five failures without touching another", async () => {
    let now = 0;
    const store = createMemoryAdminLoginAttemptStore({
      now: () => new Date(now),
    });
    const alice = subjects("alice");
    for (let index = 1; index <= 5; index += 1) {
      expect(await store.reserve(alice, policy)).toEqual({
        status: "reserved",
      });
      const outcome = await store.fail(alice, policy);
      expect(outcome.username.failures).toBe(index);
      expect(outcome.username.lockedForSeconds).toBe(index === 5 ? 900 : 0);
    }
    expect(await store.reserve(alice, policy)).toEqual({
      status: "locked",
      scope: "username",
      retryAfterSeconds: 900,
    });
    // Same address, other name: not locked.
    expect(await store.reserve(subjects("bob"), policy)).toEqual({
      status: "reserved",
    });
    await store.succeed(subjects("bob"), policy);
    // Case-insensitive.
    expect(await store.reserve(subjects("ALICE"), policy)).toMatchObject({
      status: "locked",
      scope: "username",
    });
    now += 899_000;
    expect(await store.reserve(alice, policy)).toMatchObject({
      retryAfterSeconds: 1,
    });
    now += 1_000;
    expect(await store.reserve(alice, policy)).toEqual({ status: "reserved" });
    expect((await store.fail(alice, policy)).username.failures).toBe(1);
  });

  it("clears the username count on success and refunds a cancelled attempt", async () => {
    const store = createMemoryAdminLoginAttemptStore({
      now: () => new Date(0),
    });
    const alice = subjects("alice");
    for (let index = 0; index < 4; index += 1) {
      await store.reserve(alice, policy);
      await store.fail(alice, policy);
    }
    await store.reserve(alice, policy);
    await store.succeed(alice, policy);
    for (let index = 1; index <= 4; index += 1) {
      await store.reserve(alice, policy);
      expect((await store.fail(alice, policy)).username.failures).toBe(index);
    }
    // The fifth reservation locks at once (other attempts are refused while
    // it runs); a cancelled one lifts it again.
    await store.reserve(alice, policy);
    expect(await store.reserve(alice, policy)).toMatchObject({
      status: "locked",
    });
    await store.cancel(alice, policy);
    expect(await store.reserve(alice, policy)).toEqual({ status: "reserved" });
  });

  it("locks an address after 50 failures in the window, whatever the names", async () => {
    let now = 0;
    const store = createMemoryAdminLoginAttemptStore({
      now: () => new Date(now),
    });
    for (let index = 1; index <= 50; index += 1) {
      const attempt = subjects(`user${index}`, "198.51.100.9");
      expect(await store.reserve(attempt, policy)).toEqual({
        status: "reserved",
      });
      const outcome = await store.fail(attempt, policy);
      expect(outcome.ip.failures).toBe(index);
      expect(outcome.ip.lockedForSeconds).toBe(index === 50 ? 900 : 0);
    }
    expect(
      await store.reserve(subjects("fresh", "198.51.100.9"), policy),
    ).toEqual({ status: "locked", scope: "ip", retryAfterSeconds: 900 });
    // Another address is unaffected.
    expect(
      await store.reserve(subjects("fresh", "198.51.100.10"), policy),
    ).toEqual({ status: "reserved" });
    now += 900_000;
    expect(
      await store.reserve(subjects("fresh", "198.51.100.9"), policy),
    ).toEqual({ status: "reserved" });
  });

  it("forgets address failures once the window has passed", async () => {
    let now = 0;
    const store = createMemoryAdminLoginAttemptStore({
      now: () => new Date(now),
    });
    for (let index = 0; index < 49; index += 1) {
      const attempt = subjects(`user${index}`);
      await store.reserve(attempt, policy);
      await store.fail(attempt, policy);
    }
    now += 900_000;
    const attempt = subjects("late");
    await store.reserve(attempt, policy);
    expect((await store.fail(attempt, policy)).ip).toEqual({
      failures: 1,
      lockedForSeconds: 0,
    });
  });

  it("does not let a success reset the address count", async () => {
    const store = createMemoryAdminLoginAttemptStore({
      now: () => new Date(0),
    });
    const tight: AdminLoginPolicy = { ...policy, ipMaximumFailures: 3 };
    for (let index = 0; index < 2; index += 1) {
      const attempt = subjects(`user${index}`);
      await store.reserve(attempt, tight);
      await store.fail(attempt, tight);
    }
    await store.reserve(subjects("valid"), tight);
    await store.succeed(subjects("valid"), tight);
    const third = subjects("user3");
    await store.reserve(third, tight);
    expect((await store.fail(third, tight)).ip.lockedForSeconds).toBe(900);
  });
});

describe("ADMIN_LOGIN_* configuration (Decision 0110)", () => {
  let passwordHash = "";
  beforeAll(async () => {
    passwordHash = await hashAdminPassword("correct-horse-battery-staple");
  });
  const admin = () => ({
    ADMIN_USERNAME: "operator",
    ADMIN_PASSWORD_HASH: passwordHash,
    ADMIN_SESSION_SECRET: "s".repeat(40),
  });

  it("defaults to 5 / 900 per name and 50 in 900 / 900 per address", () => {
    expect(s7TestConfig(admin()).admin?.loginPolicy).toEqual({
      usernameMaximumFailures: 5,
      usernameLockSeconds: 900,
      ipMaximumFailures: 50,
      ipWindowSeconds: 900,
      ipLockSeconds: 900,
    });
  });

  it("reads overrides and refuses out-of-range values", () => {
    expect(
      s7TestConfig({
        ...admin(),
        ADMIN_LOGIN_USERNAME_MAX_FAILURES: "3",
        ADMIN_LOGIN_IP_MAX_FAILURES: "20",
        ADMIN_LOGIN_IP_WINDOW_SECONDS: "600",
      }).admin?.loginPolicy,
    ).toMatchObject({
      usernameMaximumFailures: 3,
      ipMaximumFailures: 20,
      ipWindowSeconds: 600,
    });
    expect(() =>
      s7TestConfig({ ...admin(), ADMIN_LOGIN_USERNAME_MAX_FAILURES: "0" }),
    ).toThrow(/ADMIN_LOGIN_USERNAME_MAX_FAILURES/u);
  });
});
