import type { IDecoration, IMarker, Terminal } from "@xterm/xterm";
import { useSessionOscStore, type CommandMark } from "../../store/useSessionOscStore";
import { recordCommandHistoryEntry } from "../../hooks/commandHistoryBus";
import type { OscRuntimeContext } from "../oscRuntime";

// OSC 133 (FinalTerm semantic prompts / shell integration): the remote shell
// announces prompt boundaries (A), input start (B), command execution (C) and
// command completion (D;exitCode). Passive parsing only — this module runs in
// every shellIntegration preference mode ("off" still means passive parsing);
// the preference only gates the injection track. The sequence is always
// consumed (returns true) so it never reaches the screen.

export type Osc133Phase = "A" | "B" | "C" | "D";

export interface Osc133Event {
  phase: Osc133Phase;
  /** Present only on D when the shell actually reported a code. */
  exitCode?: number;
}

// Payloads seen in the wild carry vendor extras after the letter
// (`A;aid=...`, `C;cmdline=...`); only the first `;`-segment is meaningful.
// Unknown letters (e.g. WezTerm's `P`/`L` extensions) parse to undefined and
// are silently consumed by the handler.
export const parseOsc133Payload = (data: string): Osc133Event | undefined => {
  const segments = data.split(";");
  const phase = segments[0]?.trim();
  if (phase !== "A" && phase !== "B" && phase !== "C" && phase !== "D") {
    return undefined;
  }

  if (phase !== "D") {
    return { phase };
  }

  const rawExitCode = segments[1]?.trim();
  if (!rawExitCode) {
    return { phase };
  }

  const exitCode = Number.parseInt(rawExitCode, 10);
  return Number.isNaN(exitCode) ? { phase } : { phase, exitCode };
};

export type PromptJumpDirection = "previous" | "next";

// Jump targets are prompt-marker lines relative to the viewport top:
// "previous" is the nearest prompt strictly above the viewport top, "next"
// the nearest strictly below. Strict comparison keeps pressing the same key
// walking through prompts instead of sticking on the current one.
export const findPromptJumpTarget = (
  markerLines: readonly number[],
  viewportTopLine: number,
  direction: PromptJumpDirection
): number | undefined => {
  const sorted = [...new Set(markerLines)].sort((a, b) => a - b);

  if (direction === "previous") {
    for (let index = sorted.length - 1; index >= 0; index -= 1) {
      const line = sorted[index];
      if (line !== undefined && line < viewportTopLine) {
        return line;
      }
    }
    return undefined;
  }

  for (const line of sorted) {
    if (line > viewportTopLine) {
      return line;
    }
  }
  return undefined;
};

export interface PromptJumpKeyEvent {
  type: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
}

// Cmd+↑/↓ on macOS, Ctrl+Shift+↑/↓ elsewhere. Plain Ctrl+↑/↓ is deliberately
// avoided off macOS: it is a real terminal sequence (CSI 1;5A/B) that tmux, mc
// and assorted TUIs bind, and swallowing it would make those keys unusable.
// Cmd carries no encoding, so it is free to take on macOS.
export const resolvePromptJumpDirection = (
  event: PromptJumpKeyEvent,
  platform: string
): PromptJumpDirection | undefined => {
  if (event.type !== "keydown" || event.repeat || event.altKey) {
    return undefined;
  }

  const direction =
    event.key === "ArrowUp" ? "previous" : event.key === "ArrowDown" ? "next" : undefined;
  if (!direction) {
    return undefined;
  }

  const modifierPressed =
    platform === "darwin"
      ? event.metaKey && !event.ctrlKey && !event.shiftKey
      : event.ctrlKey && event.shiftKey && !event.metaKey;
  return modifierPressed ? direction : undefined;
};

/** Upper bound on live prompt markers kept per session for prompt jumping. */
const MAX_TRACKED_PROMPT_MARKERS = 500;

const EXIT_CODE_SUCCESS_BACKGROUND = "#3fb950";
const EXIT_CODE_FAILURE_BACKGROUND = "#f85149";

// exitCode undefined means the shell reported a bare `D` without a code — the
// outcome is unknown, so it gets the neutral success color rather than red.
export const exitCodeDecorationColor = (exitCode: number | undefined): string =>
  exitCode === undefined || exitCode === 0
    ? EXIT_CODE_SUCCESS_BACKGROUND
    : EXIT_CODE_FAILURE_BACKGROUND;

export interface ShellCommandTrackerDeps {
  getSessionId(): string | undefined;
  isReplaying(): boolean;
  getViewportTopLine(): number;
  /** Absolute buffer line the cursor currently sits on. */
  getCursorLine(): number;
  getCursorColumn(): number;
  /** Mirrors IBufferLine.translateToString(true, startColumn, endColumn). */
  readLine(line: number, startColumn?: number, endColumn?: number): string | undefined;
  registerMarker(): IMarker;
  registerDecoration(marker: IMarker, exitCode: number | undefined): IDecoration | undefined;
  scrollToLine(line: number): void;
  appendMark(sessionId: string, mark: CommandMark): void;
  clearMarks(sessionId: string): void;
  pushHistory(command: string): void;
}

interface PendingCommand {
  id: string;
  promptMarker: IMarker;
  inputMarker?: IMarker;
  inputColumn?: number;
  commandText?: string;
  startedAt?: number;
}

export class ShellCommandTracker {
  private readonly pendingBySession = new Map<string, PendingCommand>();
  private readonly promptMarkersBySession = new Map<string, IMarker[]>();
  private readonly decorationsBySession = new Map<string, IDecoration[]>();
  private readonly lastPushedCommandBySession = new Map<string, string>();
  private nextMarkId = 0;

  constructor(private readonly deps: ShellCommandTrackerDeps) {}

  // Always consumes the sequence (true) so OSC 133 never reaches the screen,
  // even when the payload is unknown or no session is active.
  handleOsc133 = (data: string): boolean => {
    const event = parseOsc133Payload(data);
    const sessionId = this.deps.getSessionId();
    if (!event || !sessionId) {
      return true;
    }

    switch (event.phase) {
      case "A":
        this.beginPending(sessionId);
        break;
      case "B":
        this.beginInput(sessionId);
        break;
      case "C":
        this.captureCommand(sessionId);
        break;
      case "D":
        this.finalizePending(sessionId, event.exitCode);
        break;
    }
    return true;
  };

  // TerminalPane resets the shared xterm buffer right before replaying the
  // incoming session's scrollback, so every tracked marker/decoration handle
  // is already dead — drop them all, then clear the incoming session's marks
  // so the replayed OSC 133 stream rebuilds them without duplicates. History
  // is a side effect and stays untouched: replay never pushes.
  handleReplayStart = (): void => {
    const sessionId = this.deps.getSessionId();
    this.disposeTrackedResources();
    if (sessionId) {
      this.deps.clearMarks(sessionId);
    }
  };

  jumpToPrompt = (direction: PromptJumpDirection): boolean => {
    const sessionId = this.deps.getSessionId();
    if (!sessionId) {
      return false;
    }

    const target = findPromptJumpTarget(
      this.getPromptLines(sessionId),
      this.deps.getViewportTopLine(),
      direction
    );
    if (target === undefined) {
      return false;
    }

    this.deps.scrollToLine(target);
    return true;
  };

  getPromptLines(sessionId: string): number[] {
    const markers = this.promptMarkersBySession.get(sessionId) ?? [];
    const alive = markers.filter((marker) => !marker.isDisposed && marker.line >= 0);
    if (alive.length !== markers.length) {
      this.promptMarkersBySession.set(sessionId, alive);
    }
    return alive.map((marker) => marker.line);
  }

  dispose(): void {
    this.disposeTrackedResources();
    this.lastPushedCommandBySession.clear();
  }

  // xterm disposes a marker once its line falls out of the scrollback, but the
  // dead handles stay in our arrays until swept. Runs once per prompt, so the
  // tracked set never outgrows what is still on screen.
  private sweepTrackedResources(sessionId: string): void {
    const markers = this.promptMarkersBySession.get(sessionId);
    if (markers) {
      const alive = markers.filter((marker) => !marker.isDisposed);
      const excess = alive.length - MAX_TRACKED_PROMPT_MARKERS;
      if (excess > 0) {
        for (const marker of alive.splice(0, excess)) {
          marker.dispose();
        }
      }
      this.promptMarkersBySession.set(sessionId, alive);
    }

    const decorations = this.decorationsBySession.get(sessionId);
    if (decorations) {
      this.decorationsBySession.set(
        sessionId,
        decorations.filter((decoration) => !decoration.isDisposed)
      );
    }
  }

  private beginPending(sessionId: string): void {
    const promptMarker = this.deps.registerMarker();
    const markers = this.promptMarkersBySession.get(sessionId) ?? [];
    markers.push(promptMarker);
    this.promptMarkersBySession.set(sessionId, markers);
    // After the push, so the tracked set is bounded at rest. The marker just
    // added is the newest and the sweep only ever drops the oldest.
    this.sweepTrackedResources(sessionId);

    // A new prompt while another command is still pending means the previous
    // one was abandoned (Ctrl+C without a D, prompt redraw): drop it without
    // producing a mark. Its prompt marker stays — it is still a real prompt
    // line and a valid jump target.
    const abandoned = this.pendingBySession.get(sessionId);
    abandoned?.inputMarker?.dispose();

    this.nextMarkId += 1;
    this.pendingBySession.set(sessionId, { id: `${sessionId}:${this.nextMarkId}`, promptMarker });
  }

  private beginInput(sessionId: string): void {
    const pending = this.pendingBySession.get(sessionId);
    if (!pending) {
      return;
    }

    pending.inputMarker?.dispose();
    pending.inputMarker = this.deps.registerMarker();
    pending.inputColumn = this.deps.getCursorColumn();
  }

  private captureCommand(sessionId: string): void {
    const pending = this.pendingBySession.get(sessionId);
    if (!pending) {
      return;
    }

    pending.startedAt = Date.now();

    // Fish emits no B: without an input-start marker there is no reliable
    // command range, so commandText stays undefined rather than guessing.
    const inputMarker = pending.inputMarker;
    if (!inputMarker || inputMarker.isDisposed) {
      return;
    }

    const startLine = inputMarker.line;
    const endLine = this.deps.getCursorLine();
    if (startLine < 0 || endLine < startLine) {
      return;
    }

    const lines: string[] = [];
    for (let line = startLine; line <= endLine; line += 1) {
      const startColumn = line === startLine ? pending.inputColumn : undefined;
      const endColumn = line === endLine ? this.deps.getCursorColumn() : undefined;
      lines.push(this.deps.readLine(line, startColumn, endColumn) ?? "");
    }

    const commandText = lines.join("\n").trim();
    pending.commandText = commandText ? commandText : undefined;
  }

  private finalizePending(sessionId: string, exitCode: number | undefined): void {
    const pending = this.pendingBySession.get(sessionId);
    if (!pending) {
      return;
    }

    this.pendingBySession.delete(sessionId);
    pending.inputMarker?.dispose();

    const promptLine = pending.promptMarker.line;
    this.deps.appendMark(sessionId, {
      id: pending.id,
      promptLine: promptLine >= 0 ? promptLine : undefined,
      commandText: pending.commandText,
      exitCode,
      startedAt: pending.startedAt,
      endedAt: Date.now()
    });

    if (!pending.promptMarker.isDisposed) {
      const decoration = this.deps.registerDecoration(pending.promptMarker, exitCode);
      if (decoration) {
        const decorations = this.decorationsBySession.get(sessionId) ?? [];
        decorations.push(decoration);
        this.decorationsBySession.set(sessionId, decorations);
      }
    }

    // History push is a side effect: never while replaying a session buffer.
    // The last-pushed string skips immediate duplicates renderer-side; the
    // main process dedupe stays authoritative.
    if (!this.deps.isReplaying() && pending.commandText) {
      if (this.lastPushedCommandBySession.get(sessionId) !== pending.commandText) {
        this.lastPushedCommandBySession.set(sessionId, pending.commandText);
        this.deps.pushHistory(pending.commandText);
      }
    }
  }

  private disposeTrackedResources(): void {
    // Prompt markers (including any pending one) are all owned by
    // promptMarkersBySession — the loop below disposes them exactly once.
    for (const pending of this.pendingBySession.values()) {
      pending.inputMarker?.dispose();
    }
    this.pendingBySession.clear();

    for (const markers of this.promptMarkersBySession.values()) {
      for (const marker of markers) {
        marker.dispose();
      }
    }
    this.promptMarkersBySession.clear();

    for (const decorations of this.decorationsBySession.values()) {
      for (const decoration of decorations) {
        decoration.dispose();
      }
    }
    this.decorationsBySession.clear();
  }
}

export const install = (terminal: Terminal, ctx: OscRuntimeContext): (() => void) => {
  const tracker = new ShellCommandTracker({
    getSessionId: () => ctx.getSessionId(),
    isReplaying: () => ctx.isReplaying(),
    getViewportTopLine: () => terminal.buffer.active.viewportY,
    getCursorLine: () => terminal.buffer.active.baseY + terminal.buffer.active.cursorY,
    getCursorColumn: () => terminal.buffer.active.cursorX,
    readLine: (line, startColumn, endColumn) =>
      terminal.buffer.active.getLine(line)?.translateToString(true, startColumn, endColumn),
    registerMarker: () => terminal.registerMarker(0),
    registerDecoration: (marker, exitCode) =>
      terminal.registerDecoration({
        marker,
        x: 0,
        width: 1,
        backgroundColor: exitCodeDecorationColor(exitCode),
        layer: "bottom"
      }),
    scrollToLine: (line) => terminal.scrollToLine(line),
    appendMark: (sessionId, mark) => {
      useSessionOscStore.getState().appendSessionMark(sessionId, mark);
    },
    clearMarks: (sessionId) => {
      useSessionOscStore.getState().clearSessionMarks(sessionId);
    },
    pushHistory: (command) => {
      // Through the shared bus so the rendered history list updates too, not
      // just the persisted one.
      recordCommandHistoryEntry(command);
    }
  });

  const oscRegistration = terminal.parser.registerOscHandler(133, (data) =>
    tracker.handleOsc133(data)
  );
  const offReplayStart = ctx.onReplayStart(tracker.handleReplayStart);
  const offKeyHandler = ctx.registerKeyHandler((event) => {
    const direction = resolvePromptJumpDirection(event, window.nextshell.platform);
    return direction ? tracker.jumpToPrompt(direction) : false;
  });

  return () => {
    oscRegistration.dispose();
    offReplayStart();
    offKeyHandler();
    tracker.dispose();
  };
};
