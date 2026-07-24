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
  getSessionId(): string | undefined;
  isReplaying(): boolean;
  getTerminalPreferences(): AppPreferences["terminal"];
  writeToRemote(data: string): void;
  registerKeyHandler(handler: (event: KeyboardEvent) => boolean): () => void;
  onReplayStart(listener: () => void): () => void;
}

export interface OscRuntimeHooks {
  getSessionId(): string | undefined;
  writeToRemote(data: string): void;
}

export interface OscRuntimeHandle {
  handleKeyEvent(event: KeyboardEvent): boolean;
  beginReplay(): void;
  endReplay(): void;
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

export const installOscRuntime = (
  terminal: Terminal,
  hooks: OscRuntimeHooks,
  modules: readonly OscRuntimeModule[] = OSC_RUNTIME_MODULES
): OscRuntimeHandle => {
  // Depth counter rather than a plain flag: back-to-back session switches can
  // queue overlapping replays, and the replay window must only close once the
  // last write callback has run.
  let replayDepth = 0;
  const keyHandlers = new Set<(event: KeyboardEvent) => boolean>();
  const replayStartListeners = new Set<() => void>();

  const ctx: OscRuntimeContext = {
    getSessionId: () => hooks.getSessionId(),
    isReplaying: () => replayDepth > 0,
    getTerminalPreferences: () => usePreferencesStore.getState().preferences.terminal,
    writeToRemote: (data) => hooks.writeToRemote(data),
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
    beginReplay: () => {
      replayDepth += 1;
      for (const listener of replayStartListeners) {
        listener();
      }
    },
    endReplay: () => {
      if (replayDepth > 0) {
        replayDepth -= 1;
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
      keyHandlers.clear();
      replayStartListeners.clear();
    }
  };
};
