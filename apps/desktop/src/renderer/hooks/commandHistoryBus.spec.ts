import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  consumeSentCommandEcho,
  recordCommandHistoryEntry,
  recordSentCommand,
  subscribeCommandHistory
} from "./commandHistoryBus";

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

// Module-level ledger state persists across tests: every test uses its own
// session id so leftovers cannot bleed between cases.
describe("sent-command echo ledger", () => {
  test("recordSentCommand records the command and notes it for echo dedupe", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeCommandHistory((command) => seen.push(command));

    recordSentCommand("ledger-1", " htop ");

    expect(seen).toEqual(["htop"]);
    expect(push).toHaveBeenCalledWith({ command: "htop" });
    expect(consumeSentCommandEcho("ledger-1", "htop")).toBe(true);
    unsubscribe();
  });

  test("a note is consumed exactly once", () => {
    recordSentCommand("ledger-2", "ls");

    expect(consumeSentCommandEcho("ledger-2", "ls")).toBe(true);
    expect(consumeSentCommandEcho("ledger-2", "ls")).toBe(false);
  });

  test("notes are scoped per session", () => {
    recordSentCommand("ledger-3a", "pwd");

    expect(consumeSentCommandEcho("ledger-3b", "pwd")).toBe(false);
    expect(consumeSentCommandEcho("ledger-3a", "pwd")).toBe(true);
  });

  test("an expired note no longer matches its echo", () => {
    recordSentCommand("ledger-4", "uptime", 0);

    expect(consumeSentCommandEcho("ledger-4", "uptime", 6 * 60 * 1000)).toBe(false);
  });

  test("blank commands are neither recorded nor noted", () => {
    recordSentCommand("ledger-5", "   ");

    expect(push).not.toHaveBeenCalled();
    expect(consumeSentCommandEcho("ledger-5", "")).toBe(false);
  });

  test("repeated sends of the same command stack as separate notes", () => {
    recordSentCommand("ledger-6", "make");
    recordSentCommand("ledger-6", "make");

    expect(consumeSentCommandEcho("ledger-6", "make")).toBe(true);
    expect(consumeSentCommandEcho("ledger-6", "make")).toBe(true);
    expect(consumeSentCommandEcho("ledger-6", "make")).toBe(false);
  });
});
