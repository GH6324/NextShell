import type { Terminal } from "@xterm/xterm";
import type { OscRuntimeContext } from "../oscRuntime";

// TODO(OSC phase 1): subscribe terminal.onTitleChange (OSC 0/2) and write the
// title into useSessionOscStore.setSessionTitle for the current session,
// honoring the oscTitleUpdates preference.
export const install = (_terminal: Terminal, _ctx: OscRuntimeContext): (() => void) => {
  return () => {};
};
