import { describe, expect, test } from "bun:test";
import { isAllowedSessionPermission } from "./session-security";

describe("isAllowedSessionPermission", () => {
  test("allows only the clipboard permissions used by terminal paste/copy", () => {
    expect(isAllowedSessionPermission("clipboard-read")).toBe(true);
    expect(isAllowedSessionPermission("clipboard-sanitized-write")).toBe(true);
  });

  test("denies every other permission by default", () => {
    const denied = [
      "media",
      "mediaKeySystem",
      "geolocation",
      "notifications",
      "midi",
      "clipboard-write",
      "fullscreen",
      "pointerLock",
      "openExternal",
      "unknown",
      ""
    ];
    for (const permission of denied) {
      expect(isAllowedSessionPermission(permission)).toBe(false);
    }
  });
});
