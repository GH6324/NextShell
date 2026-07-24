import type { Terminal } from "@xterm/xterm";
import type { OscRuntimeContext } from "../oscRuntime";

// TODO(OSC phase 1): wire OSC 8 explicit hyperlinks (xterm linkHandler)
// through a confirm dialog with a scheme allowlist; keep WebLinksAddon for
// bare URLs.
export const install = (_terminal: Terminal, _ctx: OscRuntimeContext): (() => void) => {
  return () => {};
};
