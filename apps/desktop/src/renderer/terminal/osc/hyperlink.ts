import type { ILinkHandler, Terminal } from "@xterm/xterm";
import { openExternalLink } from "./linkOpening";
import type { OscRuntimeContext } from "../oscRuntime";

// OSC 8 explicit hyperlinks: xterm 6 parses the sequence itself and routes
// activations through options.linkHandler (bare URLs stay with WebLinksAddon).
// Both paths share the confirm-first openExternalLink flow; the confirmation
// shows the real target because the OSC 8 display text may differ from it.
export const install = (terminal: Terminal, ctx: OscRuntimeContext): (() => void) => {
  const previousLinkHandler = terminal.options.linkHandler;

  const linkHandler: ILinkHandler = {
    activate: (_event, uri) => {
      void openExternalLink(uri, {
        confirm: ctx.getTerminalPreferences().hyperlinkConfirm
      });
    }
  };

  terminal.options.linkHandler = linkHandler;

  return () => {
    // Restore the handler that was in place before us, but only if nobody else
    // replaced ours in the meantime — never clobber a newer handler.
    if (terminal.options.linkHandler === linkHandler) {
      terminal.options.linkHandler = previousLinkHandler ?? undefined;
    }
  };
};
