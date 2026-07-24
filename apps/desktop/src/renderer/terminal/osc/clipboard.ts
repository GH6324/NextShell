import type { Terminal } from "@xterm/xterm";
import type { OscRuntimeContext } from "../oscRuntime";

// TODO(OSC phase 1): registerOscHandler(52) — base64 clipboard write gated by
// the oscClipboardWrite preference with a 1MB payload cap, read ("?") denied
// by default, silent while ctx.isReplaying().
export const install = (_terminal: Terminal, _ctx: OscRuntimeContext): (() => void) => {
  return () => {};
};
