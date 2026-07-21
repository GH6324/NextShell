import { describe, expect, test } from "bun:test";
import type { RemoteFileEntry } from "@nextshell/core";
import {
  DEFAULT_FILE_EXPLORER_SORT,
  isEditableKeyboardTarget,
  moveFocusIndex,
  resolveEntryOpenAction,
  resolveFileExplorerKeyAction,
  resolveFileExplorerSort,
  sortRemoteFileEntries
} from "./fileExplorerKeyboard";

const entry = (name: string, overrides: Partial<RemoteFileEntry> = {}): RemoteFileEntry => ({
  name,
  path: `/data/${name}`,
  type: "file",
  size: 0,
  permissions: "rw-r--r--",
  owner: "root",
  group: "root",
  modifiedAt: "2026-01-01T00:00:00.000Z",
  ...overrides
});

describe("resolveFileExplorerKeyAction", () => {
  test("maps navigation keys to actions", () => {
    expect(resolveFileExplorerKeyAction({ key: "ArrowUp" })).toBe("moveUp");
    expect(resolveFileExplorerKeyAction({ key: "ArrowDown" })).toBe("moveDown");
    expect(resolveFileExplorerKeyAction({ key: "Enter" })).toBe("activate");
    expect(resolveFileExplorerKeyAction({ key: "Backspace" })).toBe("parent");
  });

  test("ignores unrelated keys", () => {
    expect(resolveFileExplorerKeyAction({ key: " " })).toBe(null);
    expect(resolveFileExplorerKeyAction({ key: "a" })).toBe(null);
    expect(resolveFileExplorerKeyAction({ key: "Tab" })).toBe(null);
    expect(resolveFileExplorerKeyAction({ key: "ArrowLeft" })).toBe(null);
  });

  test("leaves Ctrl/Meta/Alt combos to other shortcuts", () => {
    expect(resolveFileExplorerKeyAction({ key: "ArrowDown", ctrlKey: true })).toBe(null);
    expect(resolveFileExplorerKeyAction({ key: "Enter", metaKey: true })).toBe(null);
    expect(resolveFileExplorerKeyAction({ key: "Backspace", altKey: true })).toBe(null);
  });

  test("Shift alone still moves focus (no range selection)", () => {
    expect(resolveFileExplorerKeyAction({ key: "ArrowDown", shiftKey: true })).toBe("moveDown");
  });
});

describe("isEditableKeyboardTarget", () => {
  test("treats text editing controls as editable", () => {
    expect(isEditableKeyboardTarget({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(isEditableKeyboardTarget({ tagName: "input", type: "search" })).toBe(true);
    expect(isEditableKeyboardTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isEditableKeyboardTarget({ tagName: "SELECT" })).toBe(true);
    expect(isEditableKeyboardTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  test("keeps selection checkboxes navigable", () => {
    expect(isEditableKeyboardTarget({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isEditableKeyboardTarget({ tagName: "INPUT", type: "radio" })).toBe(false);
  });

  test("plain containers and empty targets are not editable", () => {
    expect(isEditableKeyboardTarget({ tagName: "DIV" })).toBe(false);
    expect(isEditableKeyboardTarget(null)).toBe(false);
    expect(isEditableKeyboardTarget(undefined)).toBe(false);
  });
});

describe("moveFocusIndex", () => {
  test("moves within bounds without wrapping", () => {
    expect(moveFocusIndex(0, 1, 3)).toBe(1);
    expect(moveFocusIndex(2, 1, 3)).toBe(2);
    expect(moveFocusIndex(0, -1, 3)).toBe(0);
  });

  test("starts from the edges when nothing is focused", () => {
    expect(moveFocusIndex(-1, 1, 3)).toBe(0);
    expect(moveFocusIndex(-1, -1, 3)).toBe(2);
    expect(moveFocusIndex(99, 1, 3)).toBe(0);
  });

  test("returns -1 for an empty list", () => {
    expect(moveFocusIndex(-1, 1, 0)).toBe(-1);
    expect(moveFocusIndex(2, 1, 0)).toBe(-1);
  });
});

describe("sortRemoteFileEntries", () => {
  const files = [entry("b.txt", { size: 2 }), entry("a.txt", { size: 1 }), entry("c.txt", { size: 3 })];

  test("sorts by the active column in both directions", () => {
    expect(sortRemoteFileEntries(files, { key: "name", order: "ascend" }).map((f) => f.name)).toEqual([
      "a.txt",
      "b.txt",
      "c.txt"
    ]);
    expect(sortRemoteFileEntries(files, { key: "name", order: "descend" }).map((f) => f.name)).toEqual([
      "c.txt",
      "b.txt",
      "a.txt"
    ]);
    expect(sortRemoteFileEntries(files, { key: "size", order: "ascend" }).map((f) => f.name)).toEqual([
      "a.txt",
      "b.txt",
      "c.txt"
    ]);
  });

  test("keeps the original relative order for ties, matching antd getSortData", () => {
    const tied = [
      entry("first", { size: 1 }),
      entry("second", { size: 1 }),
      entry("third", { size: 1 })
    ];
    expect(sortRemoteFileEntries(tied, { key: "size", order: "descend" }).map((f) => f.name)).toEqual([
      "first",
      "second",
      "third"
    ]);
  });

  test("returns the original order when sorting is cleared", () => {
    expect(sortRemoteFileEntries(files, null).map((f) => f.name)).toEqual(["b.txt", "a.txt", "c.txt"]);
  });

  test("does not mutate the input array", () => {
    const before = files.map((f) => f.name);
    sortRemoteFileEntries(files, { key: "name", order: "ascend" });
    expect(files.map((f) => f.name)).toEqual(before);
  });
});

describe("resolveFileExplorerSort", () => {
  test("reads the active sorter from antd onChange payloads", () => {
    expect(resolveFileExplorerSort({ columnKey: "name", order: "ascend" })).toEqual({
      key: "name",
      order: "ascend"
    });
    expect(resolveFileExplorerSort([{ columnKey: "size", order: "descend" }])).toEqual({
      key: "size",
      order: "descend"
    });
  });

  test("returns null when sorting is cancelled or not sortable", () => {
    expect(resolveFileExplorerSort({ columnKey: "name", order: null })).toBe(null);
    expect(resolveFileExplorerSort({ columnKey: "type", order: "ascend" })).toBe(null);
    expect(resolveFileExplorerSort([])).toBe(null);
  });

  test("default sort state mirrors the name column defaultSortOrder", () => {
    expect(DEFAULT_FILE_EXPLORER_SORT).toEqual({ key: "name", order: "ascend" });
  });
});

describe("resolveEntryOpenAction", () => {
  test("navigates into directories and edits files or links", () => {
    const dir = entry("logs", { type: "directory" });
    expect(resolveEntryOpenAction(dir)).toEqual({ type: "navigate", path: "/data/logs" });

    const file = entry("app.log");
    expect(resolveEntryOpenAction(file)).toEqual({ type: "edit", entry: file });

    const link = entry("latest", { type: "link" });
    expect(resolveEntryOpenAction(link)).toEqual({ type: "edit", entry: link });
  });
});
