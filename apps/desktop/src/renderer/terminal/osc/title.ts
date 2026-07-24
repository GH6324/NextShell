import type { Terminal } from "@xterm/xterm";
import { useSessionOscStore } from "../../store/useSessionOscStore";
import type { OscRuntimeContext } from "../oscRuntime";

// OSC 0/2 (window/tab title): xterm parses these natively and re-emits them via
// onTitleChange. Mirror the title into the session OSC store so tab labels and
// the workspace header can show it. Idempotent state — safe to rebuild while a
// session buffer is being replayed.
export const install = (terminal: Terminal, ctx: OscRuntimeContext): (() => void) => {
  const subscription = terminal.onTitleChange((title) => {
    if (!ctx.getTerminalPreferences().oscTitleUpdates) {
      return;
    }

    const sessionId = ctx.getSessionId();
    if (!sessionId) {
      return;
    }

    useSessionOscStore.getState().setSessionTitle(sessionId, title.trim() || undefined);
  });

  return () => {
    subscription.dispose();
  };
};
