import type { Terminal } from "@xterm/xterm";
import { useSessionOscStore, type SessionProgress } from "../../store/useSessionOscStore";
import { useWorkspaceStore } from "../../store/useWorkspaceStore";
import type { OscRuntimeContext } from "../oscRuntime";

const clampProgressValue = (value: number): number => Math.min(100, Math.max(0, Math.round(value)));

// OSC 9;4;st;pr (ConEmu/Windows Terminal progress report): st 0=none,
// 1=normal, 2=error, 3=indeterminate, 4=paused; pr is a 0-100 percentage that
// only states 1/2/4 carry. Anything malformed is rejected so a garbage
// sequence never disturbs the current progress state.
export const parseConEmuProgress = (data: string): SessionProgress | undefined => {
  const parts = data.split(";");
  if (parts[0] !== "4") {
    return undefined;
  }

  // Strict single-digit match: Number("") and Number("1.5") would otherwise
  // slip through as valid states.
  const statePart = parts[1];
  if (statePart === undefined || !/^[0-4]$/.test(statePart)) {
    return undefined;
  }
  const state = Number(statePart);

  if (state === 0) {
    return { state: "none" };
  }
  if (state === 3) {
    return { state: "indeterminate" };
  }

  const valuePart = parts[2];
  const rawValue = Number(valuePart);
  if (!valuePart || !Number.isFinite(rawValue)) {
    return undefined;
  }

  const value = clampProgressValue(rawValue);
  if (state === 1) {
    return { state: "normal", value };
  }
  if (state === 2) {
    return { state: "error", value };
  }
  return { state: "paused", value };
};

// Store update is idempotent and therefore allowed during session-buffer
// replay; the taskbar IPC side effect stays silent during replay and only
// fires for the session the user is actually looking at.
export const applyConEmuProgress = (ctx: OscRuntimeContext, data: string): void => {
  const sessionId = ctx.getSessionId();
  if (!sessionId) {
    return;
  }

  const progress = parseConEmuProgress(data);
  if (!progress) {
    return;
  }

  useSessionOscStore.getState().setSessionProgress(sessionId, progress);

  if (ctx.isReplaying()) {
    return;
  }
  if (useWorkspaceStore.getState().activeSessionId !== sessionId) {
    return;
  }

  void window.nextshell.terminal
    .setProgress({ sessionId, state: progress.state, value: progress.value })
    .catch(() => {});
};

// Only the active session owns the window progress bar: on session switch,
// re-apply the newly active session's stored progress, or clear the bar when
// it has none (which also sweeps stale progress left by a closed session).
export const install = (_terminal: Terminal, _ctx: OscRuntimeContext): (() => void) => {
  let previousActiveId = useWorkspaceStore.getState().activeSessionId;
  const unsubscribe = useWorkspaceStore.subscribe((state) => {
    const nextActiveId = state.activeSessionId;
    if (nextActiveId === previousActiveId) {
      return;
    }
    previousActiveId = nextActiveId;
    if (!nextActiveId) {
      return;
    }

    const progress = useSessionOscStore.getState().progressBySession[nextActiveId];
    void window.nextshell.terminal
      .setProgress(
        progress
          ? { sessionId: nextActiveId, state: progress.state, value: progress.value }
          : { sessionId: nextActiveId, state: "none" }
      )
      .catch(() => {});
  });

  return () => {
    unsubscribe();
  };
};
