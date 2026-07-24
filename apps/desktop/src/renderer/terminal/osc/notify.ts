import type { Terminal } from "@xterm/xterm";
import type { OscRuntimeContext } from "../oscRuntime";

// TODO(OSC phase 4): registerOscHandler(9) + registerOscHandler(777) —
// rate-limited desktop notifications via IPC, silent while ctx.isReplaying().
export const install = (_terminal: Terminal, _ctx: OscRuntimeContext): (() => void) => {
  return () => {};
};
