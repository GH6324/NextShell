import type { Terminal } from "@xterm/xterm";
import type { OscRuntimeContext } from "../oscRuntime";

// TODO(OSC phase 2): registerOscHandler(133) — track FTCS prompt marks
// (A/B/C/D) as CommandMark entries in useSessionOscStore, clear the session's
// marks via ctx.onReplayStart before replay rebuilds them.
export const install = (_terminal: Terminal, _ctx: OscRuntimeContext): (() => void) => {
  return () => {};
};
