import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { recordCommandHistoryEntry, subscribeCommandHistory } from "./commandHistoryBus";

const push = vi.fn(async () => ({ ok: true as const }));

beforeEach(() => {
  push.mockClear();
  push.mockImplementation(async () => ({ ok: true as const }));
  (globalThis as { window?: unknown }).window = {
    nextshell: { commandHistory: { push } }
  };
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("recordCommandHistoryEntry", () => {
  test("notifies subscribers and persists the command", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeCommandHistory((command) => seen.push(command));

    recordCommandHistoryEntry("ls -al");

    expect(seen).toEqual(["ls -al"]);
    expect(push).toHaveBeenCalledWith({ command: "ls -al" });
    unsubscribe();
  });

  test("trims before dispatching so both sinks agree on the text", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeCommandHistory((command) => seen.push(command));

    recordCommandHistoryEntry("  git status \n");

    expect(seen).toEqual(["git status"]);
    expect(push).toHaveBeenCalledWith({ command: "git status" });
    unsubscribe();
  });

  test("ignores blank commands entirely", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeCommandHistory((command) => seen.push(command));

    recordCommandHistoryEntry("   \t \n ");

    expect(seen).toEqual([]);
    expect(push).not.toHaveBeenCalled();
    unsubscribe();
  });

  test("fans out to every subscriber", () => {
    const first: string[] = [];
    const second: string[] = [];
    const offFirst = subscribeCommandHistory((command) => first.push(command));
    const offSecond = subscribeCommandHistory((command) => second.push(command));

    recordCommandHistoryEntry("pwd");

    expect(first).toEqual(["pwd"]);
    expect(second).toEqual(["pwd"]);
    offFirst();
    offSecond();
  });

  test("stops delivering after unsubscribe", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeCommandHistory((command) => seen.push(command));

    unsubscribe();
    recordCommandHistoryEntry("whoami");

    expect(seen).toEqual([]);
    expect(push).toHaveBeenCalledTimes(1);
  });

  test("a subscriber unsubscribing mid-dispatch does not skip the others", () => {
    const seen: string[] = [];
    const offFirst = subscribeCommandHistory(() => offSecond());
    const offSecond = subscribeCommandHistory((command) => seen.push(command));

    recordCommandHistoryEntry("uptime");

    expect(seen).toEqual(["uptime"]);
    offFirst();
  });

  test("a rejected persist never escapes as an unhandled rejection", async () => {
    push.mockImplementation(async () => {
      throw new Error("ipc down");
    });
    const seen: string[] = [];
    const unsubscribe = subscribeCommandHistory((command) => seen.push(command));

    expect(() => recordCommandHistoryEntry("df -h")).not.toThrow();
    await Promise.resolve();

    // The optimistic update still happened; the write self-heals on reload.
    expect(seen).toEqual(["df -h"]);
    unsubscribe();
  });
});
