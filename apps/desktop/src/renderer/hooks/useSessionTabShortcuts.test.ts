import { describe, expect, test } from "vitest";
import { resolveSessionTabShortcut } from "./useSessionTabShortcuts";
import type { TabShortcutKeyEvent } from "./useSessionTabShortcuts";

const event = (overrides: Partial<TabShortcutKeyEvent>): TabShortcutKeyEvent => ({
  key: "",
  code: "",
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...overrides
});

describe("resolveSessionTabShortcut", () => {
  test("Ctrl+Tab cycles MRU forward, Shift reverses", () => {
    expect(resolveSessionTabShortcut(event({ key: "Tab", ctrlKey: true }), true)).toEqual({
      type: "mru-cycle",
      direction: 1
    });
    expect(
      resolveSessionTabShortcut(event({ key: "Tab", ctrlKey: true, shiftKey: true }), false)
    ).toEqual({ type: "mru-cycle", direction: -1 });
    expect(resolveSessionTabShortcut(event({ key: "Tab" }), true)).toBeUndefined();
  });

  test("mod+digit jumps to nth tab, 9 means last", () => {
    expect(resolveSessionTabShortcut(event({ code: "Digit1", metaKey: true }), true)).toEqual({
      type: "index",
      index: 0
    });
    expect(resolveSessionTabShortcut(event({ code: "Digit9", ctrlKey: true }), false)).toEqual({
      type: "index",
      index: "last"
    });
    // 数字键在非 mac 上要求 Ctrl,meta 不算
    expect(resolveSessionTabShortcut(event({ code: "Digit1", metaKey: true }), false)).toBeUndefined();
    // Digit0 不是合法标签序号
    expect(resolveSessionTabShortcut(event({ code: "Digit0", metaKey: true }), true)).toBeUndefined();
  });

  test("mod+shift+brackets and Ctrl+Page keys move to adjacent tabs", () => {
    expect(
      resolveSessionTabShortcut(event({ code: "BracketRight", metaKey: true, shiftKey: true }), true)
    ).toEqual({ type: "adjacent", delta: 1 });
    expect(
      resolveSessionTabShortcut(event({ code: "BracketLeft", ctrlKey: true, shiftKey: true }), false)
    ).toEqual({ type: "adjacent", delta: -1 });
    expect(resolveSessionTabShortcut(event({ code: "PageDown", ctrlKey: true }), false)).toEqual({
      type: "adjacent",
      delta: 1
    });
    expect(resolveSessionTabShortcut(event({ code: "PageUp", ctrlKey: true }), true)).toEqual({
      type: "adjacent",
      delta: -1
    });
  });

  test("close is Cmd+W on mac and Ctrl+Shift+W elsewhere — bare Ctrl+W stays with the shell", () => {
    expect(resolveSessionTabShortcut(event({ code: "KeyW", metaKey: true }), true)).toEqual({
      type: "close"
    });
    expect(
      resolveSessionTabShortcut(event({ code: "KeyW", ctrlKey: true, shiftKey: true }), false)
    ).toEqual({ type: "close" });
    expect(resolveSessionTabShortcut(event({ code: "KeyW", ctrlKey: true }), false)).toBeUndefined();
  });

  test("mod+shift+D duplicates; alt combos never match", () => {
    expect(
      resolveSessionTabShortcut(event({ code: "KeyD", metaKey: true, shiftKey: true }), true)
    ).toEqual({ type: "duplicate" });
    expect(
      resolveSessionTabShortcut(event({ code: "KeyD", ctrlKey: true, shiftKey: true }), false)
    ).toEqual({ type: "duplicate" });
    expect(
      resolveSessionTabShortcut(
        event({ code: "KeyD", metaKey: true, shiftKey: true, altKey: true }),
        true
      )
    ).toBeUndefined();
  });
});
