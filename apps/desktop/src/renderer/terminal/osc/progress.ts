import type { Terminal } from "@xterm/xterm";
import type { OscRuntimeContext } from "../oscRuntime";

// TODO(OSC phase 4): parse ConEmu/WT progress reports (OSC 9;4;st;pr) into
// useSessionOscStore.setSessionProgress and forward to
// BrowserWindow.setProgressBar via IPC.
export const install = (_terminal: Terminal, _ctx: OscRuntimeContext): (() => void) => {
  return () => {};
};
