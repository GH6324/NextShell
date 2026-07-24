import { describe, expect, test } from "vitest";
import {
  claimNextSessionIndex,
  formatSessionTitle,
  isOscTitleEligibleStatus,
  resolveSessionBaseTitle
} from "./sessionTitle";

describe("resolveSessionBaseTitle", () => {
  test("prefers an explicit OSC title over every other source", () => {
    expect(
      resolveSessionBaseTitle(
        "session-title",
        { name: "prod-web", host: "10.0.0.1" },
        "vim ~/app.ts"
      )
    ).toBe("vim ~/app.ts");
  });

  test("ignores empty or whitespace-only OSC titles", () => {
    expect(resolveSessionBaseTitle("session-title", { name: "prod-web" }, "   ")).toBe("prod-web");
    expect(resolveSessionBaseTitle("session-title", { name: "prod-web" }, "")).toBe("prod-web");
  });

  test("trims the OSC title", () => {
    expect(resolveSessionBaseTitle(undefined, undefined, "  htop  ")).toBe("htop");
  });

  test("keeps the fallback chain intact without an OSC title", () => {
    expect(
      resolveSessionBaseTitle("session-title", { name: "prod-web", host: "10.0.0.1" })
    ).toBe("prod-web");
    expect(resolveSessionBaseTitle("session-title", { host: "10.0.0.1" })).toBe("10.0.0.1");
    expect(resolveSessionBaseTitle("session-title")).toBe("session-title");
    expect(resolveSessionBaseTitle(undefined, { name: "  ", host: " " })).toBe("session");
    expect(resolveSessionBaseTitle(undefined)).toBe("session");
  });

  test("stays backward-compatible with the two-argument signature", () => {
    expect(resolveSessionBaseTitle("tab", { name: "prod-web" })).toBe("prod-web");
  });
});

describe("isOscTitleEligibleStatus", () => {
  test("allows live sessions", () => {
    expect(isOscTitleEligibleStatus("connected")).toBe(true);
    expect(isOscTitleEligibleStatus("connecting")).toBe(true);
  });

  test("rejects ended sessions so displays fall back to the connection title", () => {
    expect(isOscTitleEligibleStatus("disconnected")).toBe(false);
    expect(isOscTitleEligibleStatus("failed")).toBe(false);
  });
});

describe("claimNextSessionIndex / formatSessionTitle", () => {
  test("increments per connection", () => {
    const counters = new Map<string, number>();
    expect(claimNextSessionIndex(counters, "c1")).toBe(1);
    expect(claimNextSessionIndex(counters, "c1")).toBe(2);
    expect(claimNextSessionIndex(counters, "c2")).toBe(1);
  });

  test("normalizes the base title", () => {
    expect(formatSessionTitle("  prod-web  ", 1)).toBe("prod-web");
    expect(formatSessionTitle("   ", 1)).toBe("session");
  });
});
