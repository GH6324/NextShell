import type { Terminal } from "@xterm/xterm";
import type { AppPreferences } from "@nextshell/core";
import type { OscRuntimeContext } from "../oscRuntime";

export type OscColorCode = 10 | 11 | 12;

// OSC 10/11/12 color queries: answer with the real theme colors so remote
// programs can detect light/dark and match the local palette.
//
// SET requests are deliberately consumed and dropped rather than forwarded to
// xterm's built-in handler: the terminal palette belongs to the user's
// preferences, and letting a remote host repaint it means any `cat`ed file can
// leave the terminal in an unreadable state with no way back. Queries still
// get a truthful answer, so well-behaved programs adapt to the theme instead
// of overriding it.

/**
 * "#rgb" / "#rrggbb" → xterm's 16-bit-per-channel "rrrr/gggg/bbbb" form
 * (nibbles/bytes duplicated, e.g. #d8eaff → "d8d8/eaea/ffff").
 */
export const hexToOscRgb = (hex: string): string | undefined => {
  let normalized = hex.trim();
  if (normalized.startsWith("#")) {
    normalized = normalized.slice(1);
  }

  if (/^[0-9a-fA-F]{3}$/.test(normalized)) {
    normalized = normalized
      .split("")
      .map((digit) => digit + digit)
      .join("");
  }

  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    return undefined;
  }

  const red = normalized.slice(0, 2);
  const green = normalized.slice(2, 4);
  const blue = normalized.slice(4, 6);
  return `${red}${red}/${green}${green}/${blue}${blue}`.toLowerCase();
};

/** Builds the reply for one color code, or undefined when the theme color is not a usable hex value. */
export const buildOscColorReply = (
  code: OscColorCode,
  prefs: AppPreferences["terminal"]
): string | undefined => {
  // This app's theme has no separate cursor color; the cursor follows the
  // foreground color.
  const rgb = hexToOscRgb(code === 11 ? prefs.backgroundColor : prefs.foregroundColor);
  return rgb ? `\x1b]${code};rgb:${rgb}\x07` : undefined;
};

export const install = (terminal: Terminal, ctx: OscRuntimeContext): (() => void) => {
  const codes: readonly OscColorCode[] = [10, 11, 12];
  const registrations = codes.map((code) =>
    terminal.parser.registerOscHandler(code, (data) => {
      const isQuery = data.split(";").some((segment) => segment.trim() === "?");
      // Replies are side-effectful writes to the remote: stay silent while a
      // session buffer is being replayed.
      if (isQuery && !ctx.isReplaying()) {
        const reply = buildOscColorReply(code, ctx.getTerminalPreferences());
        if (reply) {
          ctx.writeToRemote(reply);
        }
      }
      return true;
    })
  );

  return () => {
    for (const registration of registrations) {
      registration.dispose();
    }
  };
};
