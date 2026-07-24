import type { Terminal } from "@xterm/xterm";
import { useSessionOscStore } from "../../store/useSessionOscStore";
import { parseOsc7Path } from "../../utils/osc7";
import type { OscRuntimeContext } from "../oscRuntime";

// OSC 7 (cwd report): the remote shell announces its working directory; feed
// it to the session OSC store so consumers (SFTP cwd follow, ...) can react.
// The sequence is always consumed and never reaches the screen. Works for
// every session whose data passes through the parser — no monitorSession gate.
export const install = (terminal: Terminal, ctx: OscRuntimeContext): (() => void) => {
  const registration = terminal.parser.registerOscHandler(7, (data) => {
    const sessionId = ctx.getSessionId();
    const cwd = parseOsc7Path(data);
    if (sessionId && cwd) {
      useSessionOscStore.getState().setSessionCwd(sessionId, cwd);
    }
    return true;
  });

  return () => {
    registration.dispose();
  };
};
