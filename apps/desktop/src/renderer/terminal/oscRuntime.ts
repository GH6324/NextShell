import type { Terminal } from "@xterm/xterm";
import type { AppPreferences } from "@nextshell/core";
import { usePreferencesStore } from "../store/usePreferencesStore";
import { useSessionOscStore } from "../store/useSessionOscStore";
import { useWorkspaceStore } from "../store/useWorkspaceStore";
import { install as installCwdOsc } from "./osc/cwd";
import { install as installTitleOsc } from "./osc/title";
import { install as installClipboardOsc } from "./osc/clipboard";
import { install as installHyperlinkOsc } from "./osc/hyperlink";
import { install as installColorsOsc } from "./osc/colors";
import { install as installShellIntegrationOsc } from "./osc/shellIntegration";
import { install as installNotifyOsc } from "./osc/notify";
import { install as installProgressOsc } from "./osc/progress";
import { install as installIterm2Osc } from "./osc/iterm2";

export interface OscRuntimeContext {
  /**
   * Session the bytes currently in the parser belong to. While a tagged write
   * is being parsed this is that write's session — never "whatever tab is in
   * front right now", which is what makes attribution survive overlapping
   * replays. Outside a parse (key handlers, click handlers) it falls back to
   * the foreground session.
   */
  getSessionId(): string | undefined;
  /** True while the chunk being parsed is replayed scrollback, not live output. */
  isReplaying(): boolean;
  getTerminalPreferences(): AppPreferences["terminal"];
  /**
   * Reply to the session that owns the chunk currently in the parser. Only
   * valid *synchronously* inside an OSC handler: by the time an awaited reply
   * is ready the parser has moved on to another session's chunk. Async replies
   * must capture `getSessionId()` at handler entry and use `writeToRemoteAs`.
   */
  writeToRemote(data: string): void;
  /** Reply to an explicitly named session, whatever the parser is doing now. */
  writeToRemoteAs(sessionId: string, data: string): void;
  registerKeyHandler(handler: (event: KeyboardEvent) => boolean): () => void;
  onReplayStart(listener: (sessionId: string | undefined) => void): () => void;
}

export interface OscRuntimeHooks {
  /** Session currently attached to the terminal; only consulted outside a parse. */
  getSessionId(): string | undefined;
  writeToRemote(sessionId: string, data: string): void;
}

export interface OscRuntimeHandle {
  handleKeyEvent(event: KeyboardEvent): boolean;
  /** Write live session output, tagging the chunk with its owning session. */
  writeSessionData(sessionId: string, data: string, onParsed?: () => void): void;
  /** Same as `writeSessionData`, but the chunk is replayed scrollback. */
  replaySessionData(sessionId: string, data: string, onParsed?: () => void): void;
  /**
   * Announce that the terminal was reset in preparation for replaying
   * `sessionId`. Call it right after `terminal.reset()`, before queueing the
   * replay write.
   */
  notifyReplayStart(sessionId: string | undefined): void;
  /**
   * Run `onDrained` once every chunk queued so far has been parsed.
   *
   * xterm's `Terminal.reset()` does not touch the write buffer, so resetting
   * while an outgoing session's bulk output is still queued paints that
   * backlog into the *incoming* session's freshly cleared screen. Ordering the
   * reset behind a zero-length write makes it happen after the backlog instead.
   */
  runAfterPendingWrites(onDrained: () => void): void;
  dispose(): void;
}

export type OscRuntimeModule = (terminal: Terminal, ctx: OscRuntimeContext) => () => void;

// Fixed composition order: each OSC feature module is installed once per xterm
// instance and later waves fill in their own module without touching this list.
const OSC_RUNTIME_MODULES: readonly OscRuntimeModule[] = [
  installCwdOsc,
  installTitleOsc,
  installClipboardOsc,
  installHyperlinkOsc,
  installColorsOsc,
  installShellIntegrationOsc,
  installNotifyOsc,
  installProgressOsc,
  installIterm2Osc
];

/**
 * Hard cap on in-flight write tags. xterm always runs the per-write callback
 * once the chunk has been parsed, but a callback can still be lost (terminal
 * teardown, a write rejected by xterm's pending-data guard). Without a bound a
 * single lost callback would pin the queue head and misattribute everything
 * after it, so the oldest tag is evicted instead.
 */
const MAX_PENDING_WRITES = 256;

interface PendingWrite {
  sessionId: string;
  replay: boolean;
}

export const installOscRuntime = (
  terminal: Terminal,
  hooks: OscRuntimeHooks,
  modules: readonly OscRuntimeModule[] = OSC_RUNTIME_MODULES
): OscRuntimeHandle => {
  // One xterm instance multiplexes every session, so "which session do these
  // bytes belong to?" cannot be read from a mutable ref at parse time: back to
  // back tab switches queue overlapping replays, and by the time an older
  // replay reaches the parser the foreground session has moved on. xterm parses
  // writes strictly in submission order and runs each write's callback right
  // after that chunk is parsed, so a FIFO of tags pushed at write time and
  // dropped in the callback names the session that owns whatever the parser is
  // chewing on right now.
  const pendingWrites: PendingWrite[] = [];
  const keyHandlers = new Set<(event: KeyboardEvent) => boolean>();
  const replayStartListeners = new Set<(sessionId: string | undefined) => void>();

  const settlePendingWrite = (entry: PendingWrite): void => {
    const index = pendingWrites.indexOf(entry);
    if (index < 0) {
      return;
    }
    // Everything queued before this entry was parsed earlier, so drop the whole
    // prefix: that also clears tags whose callback never arrived.
    pendingWrites.splice(0, index + 1);
  };

  const enqueueWrite = (
    sessionId: string,
    data: string,
    replay: boolean,
    onParsed?: () => void
  ): void => {
    if (!data) {
      onParsed?.();
      return;
    }

    if (pendingWrites.length >= MAX_PENDING_WRITES) {
      pendingWrites.shift();
    }

    const entry: PendingWrite = { sessionId, replay };
    // Pushed before the write: xterm may run the callback synchronously (it
    // does right after user input), and the tag has to already be in place.
    pendingWrites.push(entry);
    try {
      terminal.write(data, () => {
        settlePendingWrite(entry);
        if (!onParsed) {
          return;
        }
        try {
          onParsed();
        } catch (error) {
          // An exception escaping a write callback aborts xterm's parse loop
          // with the queue non-empty and nothing ever reschedules it — the
          // terminal would freeze permanently. Contain and log instead.
          console.error("[oscRuntime] write completion callback threw", error);
        }
      });
    } catch (error) {
      settlePendingWrite(entry);
      throw error;
    }
  };

  const resolveSessionId = (): string | undefined => {
    const active = pendingWrites[0];
    return active ? active.sessionId : hooks.getSessionId();
  };

  const ctx: OscRuntimeContext = {
    getSessionId: resolveSessionId,
    isReplaying: () => pendingWrites[0]?.replay ?? false,
    getTerminalPreferences: () => usePreferencesStore.getState().preferences.terminal,
    writeToRemote: (data) => {
      // Replies (OSC 52 reads, color queries) go back to whoever asked, which
      // during a replay is not necessarily the foreground session.
      const sessionId = resolveSessionId();
      if (!sessionId) {
        return;
      }
      hooks.writeToRemote(sessionId, data);
    },
    writeToRemoteAs: (sessionId, data) => {
      if (!sessionId) {
        return;
      }
      hooks.writeToRemote(sessionId, data);
    },
    registerKeyHandler: (handler) => {
      keyHandlers.add(handler);
      return () => {
        keyHandlers.delete(handler);
      };
    },
    onReplayStart: (listener) => {
      replayStartListeners.add(listener);
      return () => {
        replayStartListeners.delete(listener);
      };
    }
  };

  const disposeModules = modules.map((install) => install(terminal, ctx));

  // Per-session OSC state must not outlive its session: whenever the workspace
  // session list changes, drop store entries for sessions that no longer exist.
  const unsubscribeWorkspace = useWorkspaceStore.subscribe((state, previousState) => {
    if (state.sessions === previousState.sessions) {
      return;
    }

    useSessionOscStore
      .getState()
      .pruneSessions(new Set(state.sessions.map((session) => session.id)));
  });

  let disposed = false;

  return {
    handleKeyEvent: (event) => {
      for (const handler of keyHandlers) {
        if (handler(event)) {
          return true;
        }
      }
      return false;
    },
    writeSessionData: (sessionId, data, onParsed) => {
      enqueueWrite(sessionId, data, false, onParsed);
    },
    replaySessionData: (sessionId, data, onParsed) => {
      enqueueWrite(sessionId, data, true, onParsed);
    },
    notifyReplayStart: (sessionId) => {
      for (const listener of replayStartListeners) {
        listener(sessionId);
      }
    },
    runAfterPendingWrites: (onDrained) => {
      if (pendingWrites.length === 0) {
        // Nothing unparsed: staying synchronous keeps a tab switch from
        // flashing the outgoing session's screen for a frame.
        onDrained();
        return;
      }
      try {
        // An empty chunk parses to nothing but still takes its place in the
        // queue, so its callback runs after everything queued before it.
        terminal.write("", () => {
          try {
            onDrained();
          } catch (error) {
            // Same containment as enqueueWrite: the continuation runs inside
            // xterm's write loop (it performs reset + replay), and a throw
            // there would kill the loop — and with it every session — for
            // the life of this terminal instance.
            console.error("[oscRuntime] pending-write continuation threw", error);
          }
        });
      } catch {
        // Terminal already torn down — run the continuation anyway so callers
        // never wait forever on a callback that can no longer arrive.
        onDrained();
      }
    },
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      unsubscribeWorkspace();
      for (const disposeModule of disposeModules) {
        disposeModule();
      }
      pendingWrites.length = 0;
      keyHandlers.clear();
      replayStartListeners.clear();
    }
  };
};
