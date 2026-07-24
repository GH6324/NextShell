import { describe, expect, test } from "vitest";
import { createNotificationRateLimiter, parseOsc777 } from "./notify";

describe("createNotificationRateLimiter", () => {
  test("allows the first notification for a session", () => {
    const isAllowed = createNotificationRateLimiter(5_000, () => 1_000);

    expect(isAllowed("session-1")).toBe(true);
  });

  test("denies a second notification inside the interval", () => {
    let current = 1_000;
    const isAllowed = createNotificationRateLimiter(5_000, () => current);

    expect(isAllowed("session-1")).toBe(true);

    current = 5_999;
    expect(isAllowed("session-1")).toBe(false);
  });

  test("allows again once the interval has fully elapsed", () => {
    let current = 1_000;
    const isAllowed = createNotificationRateLimiter(5_000, () => current);

    expect(isAllowed("session-1")).toBe(true);

    current = 6_000;
    expect(isAllowed("session-1")).toBe(true);
  });

  test("limits sessions independently", () => {
    const isAllowed = createNotificationRateLimiter(5_000, () => 1_000);

    expect(isAllowed("session-1")).toBe(true);
    expect(isAllowed("session-2")).toBe(true);
    expect(isAllowed("session-1")).toBe(false);
  });
});

describe("parseOsc777", () => {
  test("parses a notify payload into title and body", () => {
    expect(parseOsc777("notify;Build finished;Tests passed")).toEqual({
      title: "Build finished",
      body: "Tests passed"
    });
  });

  test("keeps semicolons inside the body", () => {
    expect(parseOsc777("notify;title;line 1; line 2; line 3")).toEqual({
      title: "title",
      body: "line 1; line 2; line 3"
    });
  });

  test("accepts an empty title", () => {
    expect(parseOsc777("notify;;just a body")).toEqual({ title: "", body: "just a body" });
  });

  test("rejects payloads without the notify command", () => {
    expect(parseOsc777("remind;title;body")).toBeUndefined();
    expect(parseOsc777("notify")).toBeUndefined();
  });

  test("rejects payloads with fewer than three parts", () => {
    expect(parseOsc777("notify;title-only")).toBeUndefined();
  });

  test("rejects an empty body", () => {
    expect(parseOsc777("notify;title;")).toBeUndefined();
  });
});
