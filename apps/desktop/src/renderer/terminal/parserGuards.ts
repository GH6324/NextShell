import type { Terminal } from "@xterm/xterm";

/**
 * A parser handler that throws synchronously does not just fail its own
 * sequence: the exception unwinds xterm's WriteBuffer._innerWrite mid-loop.
 * That loop never reschedules itself after an abort (later write() calls only
 * schedule processing when the queue was empty, and it no longer is), so every
 * subsequent write piles up unparsed and the terminal freezes for the rest of
 * its life — no echo, and reset/replay/clear are all ordered behind the dead
 * queue. This is exactly how one bad OSC handler used to brick every session
 * sharing the terminal until all tabs were closed.
 *
 * Wrapping the registration methods once, before any handler is installed,
 * turns any current or future handler bug into a logged, consumed sequence
 * instead of a dead terminal.
 */
export const installParserHandlerGuards = (terminal: Terminal): void => {
  const parser = terminal.parser;

  const contain = <Args extends unknown[]>(
    kind: string,
    callback: (...args: Args) => boolean | Promise<boolean>
  ): ((...args: Args) => boolean | Promise<boolean>) => {
    return (...args: Args) => {
      try {
        return callback(...args);
      } catch (error) {
        console.error(`[terminal] ${kind} handler threw; sequence dropped`, error);
        // The sequence was addressed to this handler; report it as handled so
        // xterm does not run fallback actions on top of a half-applied one.
        // Async rejections are deliberately left alone — xterm already
        // logs-and-continues those without aborting the parse loop.
        return true;
      }
    };
  };

  const registerCsi = parser.registerCsiHandler.bind(parser);
  parser.registerCsiHandler = (id, callback) => registerCsi(id, contain("CSI", callback));
  const registerDcs = parser.registerDcsHandler.bind(parser);
  parser.registerDcsHandler = (id, callback) => registerDcs(id, contain("DCS", callback));
  const registerEsc = parser.registerEscHandler.bind(parser);
  parser.registerEscHandler = (id, callback) => registerEsc(id, contain("ESC", callback));
  const registerOsc = parser.registerOscHandler.bind(parser);
  parser.registerOscHandler = (ident, callback) => registerOsc(ident, contain("OSC", callback));
};
