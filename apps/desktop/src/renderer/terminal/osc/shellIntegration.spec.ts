import { describe, expect, test } from "vitest";
import type { IDecoration, IMarker } from "@xterm/xterm";
import type { CommandMark } from "../../store/useSessionOscStore";
import {
  exitCodeDecorationColor,
  findPromptJumpTarget,
  parseOsc133Payload,
  resolvePromptJumpDirection,
  ShellCommandTracker,
  type PromptJumpKeyEvent
} from "./shellIntegration";

interface FakeMarker {
  handle: IMarker;
  isDisposed: boolean;
}

interface FakeDecoration {
  handle: IDecoration;
  marker: IMarker;
  exitCode: number | undefined;
  isDisposed: boolean;
}

const createFakeMarker = (line: number): FakeMarker => {
  const fake: FakeMarker = { handle: undefined as unknown as IMarker, isDisposed: false };
  fake.handle = {
    get line() {
      return fake.isDisposed ? -1 : line;
    },
    get isDisposed() {
      return fake.isDisposed;
    },
    dispose() {
      fake.isDisposed = true;
    }
  } as unknown as IMarker;
  return fake;
};

const createHarness = () => {
  const state = {
    sessionId: "s1" as string | undefined,
    replaying: false,
    cursorLine: 0,
    cursorColumn: 0,
    viewportTopLine: 0
  };
  const bufferLines = new Map<number, string>();
  const markers: FakeMarker[] = [];
  const decorations: FakeDecoration[] = [];
  const appendedMarks: Array<{ sessionId: string; mark: CommandMark }> = [];
  const clearedSessions: string[] = [];
  const pushedHistory: string[] = [];
  const scrolls: number[] = [];

  const tracker = new ShellCommandTracker({
    getSessionId: () => state.sessionId,
    isReplaying: () => state.replaying,
    getViewportTopLine: () => state.viewportTopLine,
    getCursorLine: () => state.cursorLine,
    getCursorColumn: () => state.cursorColumn,
    readLine: (line, startColumn, endColumn) => {
      const raw = bufferLines.get(line);
      if (raw === undefined) {
        return undefined;
      }
      // Mimic translateToString(true, startColumn, endColumn).
      return raw.slice(startColumn ?? 0, endColumn).trimEnd();
    },
    registerMarker: () => {
      const marker = createFakeMarker(state.cursorLine);
      markers.push(marker);
      return marker.handle;
    },
    registerDecoration: (marker, exitCode) => {
      const fake: FakeDecoration = {
        handle: undefined as unknown as IDecoration,
        marker,
        exitCode,
        isDisposed: false
      };
      fake.handle = {
        dispose() {
          fake.isDisposed = true;
        }
      } as unknown as IDecoration;
      decorations.push(fake);
      return fake.handle;
    },
    scrollToLine: (line) => {
      scrolls.push(line);
    },
    appendMark: (sessionId, mark) => {
      appendedMarks.push({ sessionId, mark });
    },
    clearMarks: (sessionId) => {
      clearedSessions.push(sessionId);
    },
    pushHistory: (command) => {
      pushedHistory.push(command);
    }
  });

  return {
    tracker,
    state,
    bufferLines,
    markers,
    decorations,
    appendedMarks,
    clearedSessions,
    pushedHistory,
    scrolls
  };
};

// Drives a full prompt cycle: A on `promptLine`, B with the cursor resting
// after a 2-char prompt ("❯ "), typed `command`, then C/D from the line the
// cursor lands on after Enter.
const driveCommand = (
  harness: ReturnType<typeof createHarness>,
  options: { promptLine: number; command: string; exitCode?: number | undefined }
): void => {
  const { tracker, state, bufferLines } = harness;
  state.cursorLine = options.promptLine;
  state.cursorColumn = 0;
  tracker.handleOsc133("A");

  state.cursorColumn = 2;
  tracker.handleOsc133("B");

  bufferLines.set(options.promptLine, `❯ ${options.command}`);
  state.cursorLine = options.promptLine + 1;
  state.cursorColumn = 0;
  tracker.handleOsc133("C");

  tracker.handleOsc133(options.exitCode === undefined ? "D" : `D;${options.exitCode}`);
};

describe("parseOsc133Payload", () => {
  test("parses the plain FTCS letters", () => {
    expect(parseOsc133Payload("A")).toEqual({ phase: "A" });
    expect(parseOsc133Payload("B")).toEqual({ phase: "B" });
    expect(parseOsc133Payload("C")).toEqual({ phase: "C" });
  });

  test("parses exit codes on D", () => {
    expect(parseOsc133Payload("D;0")).toEqual({ phase: "D", exitCode: 0 });
    expect(parseOsc133Payload("D;3")).toEqual({ phase: "D", exitCode: 3 });
  });

  test("treats missing or malformed exit codes as unknown", () => {
    expect(parseOsc133Payload("D")).toEqual({ phase: "D" });
    expect(parseOsc133Payload("D;")).toEqual({ phase: "D" });
    expect(parseOsc133Payload("D;abc")).toEqual({ phase: "D" });
  });

  test("ignores vendor parameters after the letter", () => {
    expect(parseOsc133Payload("A;aid=1")).toEqual({ phase: "A" });
    expect(parseOsc133Payload("C;cmdline=xyz")).toEqual({ phase: "C" });
    expect(parseOsc133Payload("D;1;extra=1")).toEqual({ phase: "D", exitCode: 1 });
  });

  test("returns undefined for unknown letters and empty payloads", () => {
    expect(parseOsc133Payload("P;k=i")).toBeUndefined();
    expect(parseOsc133Payload("L")).toBeUndefined();
    expect(parseOsc133Payload("")).toBeUndefined();
  });
});

describe("ShellCommandTracker", () => {
  test("A→B→C→D produces one mark with commandText and exitCode", () => {
    const harness = createHarness();

    driveCommand(harness, { promptLine: 5, command: "echo hi", exitCode: 0 });

    expect(harness.appendedMarks).toHaveLength(1);
    const { sessionId, mark } = harness.appendedMarks[0]!;
    expect(sessionId).toBe("s1");
    expect(mark.commandText).toBe("echo hi");
    expect(mark.exitCode).toBe(0);
    expect(mark.promptLine).toBe(5);
    expect(typeof mark.startedAt).toBe("number");
    expect(typeof mark.endedAt).toBe("number");
    expect(mark.id).toBe("s1:1");

    expect(harness.decorations).toHaveLength(1);
    expect(exitCodeDecorationColor(harness.decorations[0]!.exitCode)).toBe(
      exitCodeDecorationColor(0)
    );
    expect(harness.pushedHistory).toEqual(["echo hi"]);
  });

  test("captures multi-line commands between B and C", () => {
    const harness = createHarness();
    const { tracker, state, bufferLines } = harness;

    state.cursorLine = 5;
    state.cursorColumn = 0;
    tracker.handleOsc133("A");
    state.cursorColumn = 2;
    tracker.handleOsc133("B");

    bufferLines.set(5, "❯ echo \\");
    bufferLines.set(6, "hello");
    bufferLines.set(7, "");
    state.cursorLine = 7;
    state.cursorColumn = 0;
    tracker.handleOsc133("C");
    tracker.handleOsc133("D;0");

    expect(harness.appendedMarks[0]!.mark.commandText).toBe("echo \\\nhello");
    expect(harness.pushedHistory).toEqual(["echo \\\nhello"]);
  });

  test("D without C finalizes a mark without commandText", () => {
    const harness = createHarness();
    const { tracker, state } = harness;

    state.cursorLine = 2;
    tracker.handleOsc133("A");
    state.cursorColumn = 2;
    tracker.handleOsc133("B");
    tracker.handleOsc133("D;1");

    expect(harness.appendedMarks).toHaveLength(1);
    const { mark } = harness.appendedMarks[0]!;
    expect(mark.commandText).toBeUndefined();
    expect(mark.startedAt).toBeUndefined();
    expect(mark.exitCode).toBe(1);
    expect(harness.pushedHistory).toEqual([]);
  });

  test("consecutive commands produce distinct marks in order", () => {
    const harness = createHarness();

    driveCommand(harness, { promptLine: 1, command: "ls", exitCode: 0 });
    driveCommand(harness, { promptLine: 4, command: "pwd", exitCode: 0 });

    expect(harness.appendedMarks.map(({ mark }) => mark.id)).toEqual(["s1:1", "s1:2"]);
    expect(harness.appendedMarks.map(({ mark }) => mark.commandText)).toEqual(["ls", "pwd"]);
    expect(harness.pushedHistory).toEqual(["ls", "pwd"]);
  });

  test("D;3 marks a non-zero exit with a red decoration", () => {
    const harness = createHarness();

    driveCommand(harness, { promptLine: 3, command: "false", exitCode: 3 });

    expect(harness.appendedMarks[0]!.mark.exitCode).toBe(3);
    expect(harness.decorations).toHaveLength(1);
    expect(exitCodeDecorationColor(harness.decorations[0]!.exitCode)).not.toBe(
      exitCodeDecorationColor(0)
    );
  });

  test("bare D leaves exitCode undefined and uses the neutral decoration color", () => {
    const harness = createHarness();

    driveCommand(harness, { promptLine: 3, command: "true" });

    expect(harness.appendedMarks[0]!.mark.exitCode).toBeUndefined();
    expect(exitCodeDecorationColor(harness.decorations[0]!.exitCode)).toBe(
      exitCodeDecorationColor(undefined)
    );
    expect(exitCodeDecorationColor(undefined)).toBe(exitCodeDecorationColor(0));
  });

  test("vendor-param payloads still drive the state machine", () => {
    const harness = createHarness();
    const { tracker, state, bufferLines } = harness;

    state.cursorLine = 8;
    tracker.handleOsc133("A;aid=1");
    state.cursorColumn = 2;
    tracker.handleOsc133("B");
    bufferLines.set(8, "❯ ls -la");
    state.cursorLine = 9;
    state.cursorColumn = 0;
    tracker.handleOsc133("C;cmdline=xyz");
    tracker.handleOsc133("D;0");

    expect(harness.appendedMarks).toHaveLength(1);
    expect(harness.appendedMarks[0]!.mark.commandText).toBe("ls -la");
    expect(harness.pushedHistory).toEqual(["ls -la"]);
  });

  test("tolerates a missing B (fish): no commandText, no crash", () => {
    const harness = createHarness();
    const { tracker, state } = harness;

    state.cursorLine = 4;
    tracker.handleOsc133("A");
    state.cursorLine = 5;
    state.cursorColumn = 0;
    tracker.handleOsc133("C");
    tracker.handleOsc133("D;0");

    expect(harness.appendedMarks).toHaveLength(1);
    const { mark } = harness.appendedMarks[0]!;
    expect(mark.commandText).toBeUndefined();
    expect(mark.exitCode).toBe(0);
    expect(harness.pushedHistory).toEqual([]);
  });

  test("ignores B/C/D without a pending A and empty commands", () => {
    const harness = createHarness();
    const { tracker, state } = harness;

    tracker.handleOsc133("B");
    tracker.handleOsc133("C");
    tracker.handleOsc133("D;2");
    expect(harness.appendedMarks).toHaveLength(0);

    // Empty input: cursor never advanced past the prompt before C.
    state.cursorLine = 6;
    state.cursorColumn = 0;
    tracker.handleOsc133("A");
    state.cursorColumn = 2;
    tracker.handleOsc133("B");
    harness.bufferLines.set(6, "❯ ");
    tracker.handleOsc133("C");
    tracker.handleOsc133("D;0");

    expect(harness.appendedMarks).toHaveLength(1);
    expect(harness.appendedMarks[0]!.mark.commandText).toBeUndefined();
    expect(harness.pushedHistory).toEqual([]);
  });

  test("a fresh A abandons the previous pending command without a mark", () => {
    const harness = createHarness();
    const { tracker, state } = harness;

    state.cursorLine = 1;
    tracker.handleOsc133("A");
    state.cursorColumn = 2;
    tracker.handleOsc133("B");
    state.cursorLine = 2;
    state.cursorColumn = 0;
    tracker.handleOsc133("A");
    tracker.handleOsc133("D;0");

    expect(harness.appendedMarks).toHaveLength(1);
    expect(harness.appendedMarks[0]!.mark.promptLine).toBe(2);
    expect(harness.tracker.getPromptLines("s1")).toEqual([1, 2]);
  });

  test("always consumes the sequence, even without a session or known payload", () => {
    const harness = createHarness();

    expect(harness.tracker.handleOsc133("X;unknown")).toBe(true);
    harness.state.sessionId = undefined;
    expect(harness.tracker.handleOsc133("A")).toBe(true);
    expect(harness.appendedMarks).toHaveLength(0);
  });

  test("skips immediate duplicate history pushes but keeps the marks", () => {
    const harness = createHarness();

    driveCommand(harness, { promptLine: 1, command: "ls", exitCode: 0 });
    driveCommand(harness, { promptLine: 3, command: "ls", exitCode: 0 });
    driveCommand(harness, { promptLine: 5, command: "pwd", exitCode: 0 });

    expect(harness.appendedMarks).toHaveLength(3);
    expect(harness.pushedHistory).toEqual(["ls", "pwd"]);
  });

  test("replay rebuilds marks without duplicates and pushes no history", () => {
    const harness = createHarness();

    driveCommand(harness, { promptLine: 1, command: "ls", exitCode: 0 });
    expect(harness.appendedMarks).toHaveLength(1);
    expect(harness.pushedHistory).toEqual(["ls"]);

    harness.tracker.handleReplayStart();
    expect(harness.clearedSessions).toEqual(["s1"]);
    expect(harness.markers.every((marker) => marker.isDisposed)).toBe(true);
    expect(harness.decorations.every((decoration) => decoration.isDisposed)).toBe(true);

    // The replayed stream rebuilds marks and decorations (idempotent state)…
    harness.state.replaying = true;
    driveCommand(harness, { promptLine: 1, command: "ls", exitCode: 0 });

    expect(harness.appendedMarks).toHaveLength(2);
    expect(harness.decorations).toHaveLength(2);
    // …but history is a side effect and stays silent during replay.
    expect(harness.pushedHistory).toEqual(["ls"]);
  });

  test("dispose releases markers and decorations", () => {
    const harness = createHarness();

    driveCommand(harness, { promptLine: 1, command: "ls", exitCode: 0 });
    harness.tracker.dispose();

    expect(harness.markers.every((marker) => marker.isDisposed)).toBe(true);
    expect(harness.decorations.every((decoration) => decoration.isDisposed)).toBe(true);
    expect(harness.tracker.getPromptLines("s1")).toEqual([]);
  });

  test("jumpToPrompt scrolls to the nearest prompt marker", () => {
    const harness = createHarness();
    const { tracker, state } = harness;

    state.cursorLine = 3;
    tracker.handleOsc133("A");
    state.cursorLine = 10;
    tracker.handleOsc133("A");
    state.cursorLine = 22;
    tracker.handleOsc133("A");

    state.viewportTopLine = 15;
    expect(tracker.jumpToPrompt("previous")).toBe(true);
    expect(harness.scrolls).toEqual([10]);

    expect(tracker.jumpToPrompt("next")).toBe(true);
    expect(harness.scrolls).toEqual([10, 22]);

    expect(tracker.jumpToPrompt("next")).toBe(true);
    expect(harness.scrolls).toEqual([10, 22, 22]);
  });

  test("jumpToPrompt returns false when there is no target", () => {
    const harness = createHarness();

    expect(harness.tracker.jumpToPrompt("previous")).toBe(false);
    expect(harness.scrolls).toEqual([]);

    harness.state.cursorLine = 3;
    harness.tracker.handleOsc133("A");
    harness.state.viewportTopLine = 3;
    expect(harness.tracker.jumpToPrompt("next")).toBe(false);
    expect(harness.tracker.jumpToPrompt("previous")).toBe(false);

    harness.state.sessionId = undefined;
    expect(harness.tracker.jumpToPrompt("previous")).toBe(false);
  });

  test("dead markers are pruned from jump targets", () => {
    const harness = createHarness();
    const { tracker, state } = harness;

    state.cursorLine = 3;
    tracker.handleOsc133("A");
    state.cursorLine = 10;
    tracker.handleOsc133("A");

    harness.markers[0]!.handle.dispose();
    expect(tracker.getPromptLines("s1")).toEqual([10]);

    state.viewportTopLine = 15;
    expect(tracker.jumpToPrompt("previous")).toBe(true);
    expect(harness.scrolls).toEqual([10]);
  });
});

describe("findPromptJumpTarget", () => {
  const lines = [3, 10, 10, 22];

  test("finds the nearest prompt strictly above/below the viewport top", () => {
    expect(findPromptJumpTarget(lines, 15, "previous")).toBe(10);
    expect(findPromptJumpTarget(lines, 15, "next")).toBe(22);
  });

  test("a marker exactly at the viewport top is not a target", () => {
    expect(findPromptJumpTarget(lines, 10, "previous")).toBe(3);
    expect(findPromptJumpTarget(lines, 10, "next")).toBe(22);
  });

  test("returns undefined when no prompt exists in that direction", () => {
    expect(findPromptJumpTarget(lines, 3, "previous")).toBeUndefined();
    expect(findPromptJumpTarget(lines, 22, "next")).toBeUndefined();
    expect(findPromptJumpTarget([], 5, "previous")).toBeUndefined();
  });
});

describe("resolvePromptJumpDirection", () => {
  const keyEvent = (overrides: Partial<PromptJumpKeyEvent>): PromptJumpKeyEvent => ({
    type: "keydown",
    key: "ArrowUp",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    ...overrides
  });

  test("Cmd+ArrowUp/Down on macOS", () => {
    expect(resolvePromptJumpDirection(keyEvent({ metaKey: true }), "darwin")).toBe("previous");
    expect(
      resolvePromptJumpDirection(keyEvent({ metaKey: true, key: "ArrowDown" }), "darwin")
    ).toBe("next");
  });

  test("Ctrl+ArrowUp/Down on other platforms", () => {
    expect(resolvePromptJumpDirection(keyEvent({ ctrlKey: true }), "linux")).toBe("previous");
    expect(
      resolvePromptJumpDirection(keyEvent({ ctrlKey: true, key: "ArrowDown" }), "win32")
    ).toBe("next");
  });

  test("rejects the wrong modifier for the platform", () => {
    expect(resolvePromptJumpDirection(keyEvent({ ctrlKey: true }), "darwin")).toBeUndefined();
    expect(resolvePromptJumpDirection(keyEvent({ metaKey: true }), "linux")).toBeUndefined();
    expect(
      resolvePromptJumpDirection(keyEvent({ metaKey: true, ctrlKey: true }), "darwin")
    ).toBeUndefined();
  });

  test("rejects keyup, repeats, extra modifiers and other keys", () => {
    expect(
      resolvePromptJumpDirection(keyEvent({ metaKey: true, type: "keyup" }), "darwin")
    ).toBeUndefined();
    expect(
      resolvePromptJumpDirection(keyEvent({ metaKey: true, repeat: true }), "darwin")
    ).toBeUndefined();
    expect(
      resolvePromptJumpDirection(keyEvent({ metaKey: true, shiftKey: true }), "darwin")
    ).toBeUndefined();
    expect(
      resolvePromptJumpDirection(keyEvent({ metaKey: true, altKey: true }), "darwin")
    ).toBeUndefined();
    expect(
      resolvePromptJumpDirection(keyEvent({ metaKey: true, key: "ArrowLeft" }), "darwin")
    ).toBeUndefined();
  });
});
