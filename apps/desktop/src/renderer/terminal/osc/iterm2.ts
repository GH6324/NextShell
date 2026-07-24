import type { Terminal } from "@xterm/xterm";
import type { OscRuntimeContext } from "../oscRuntime";

// TODO(OSC phase 4): registerOscHandler(1337) subset — CurrentDir= as a
// fallback cwd source, SetUserVar= into useSessionOscStore.setSessionUserVar.
// File= (inline images/downloads) is out of scope.
export const install = (_terminal: Terminal, _ctx: OscRuntimeContext): (() => void) => {
  return () => {};
};
