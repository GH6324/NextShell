import type { Terminal } from "@xterm/xterm";
import type { OscRuntimeContext } from "../oscRuntime";

// TODO(OSC phase 3): answer OSC 10/11/12 color queries with the real theme
// colors from ctx.getTerminalPreferences() via ctx.writeToRemote (replacing
// the suppress-only compatibility shim).
export const install = (_terminal: Terminal, _ctx: OscRuntimeContext): (() => void) => {
  return () => {};
};
