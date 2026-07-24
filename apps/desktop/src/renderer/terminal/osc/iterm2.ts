import type { Terminal } from "@xterm/xterm";
import { useSessionOscStore } from "../../store/useSessionOscStore";
import type { OscRuntimeContext } from "../oscRuntime";

const CURRENT_DIR_PREFIX = "CurrentDir=";
const SET_USER_VAR_PREFIX = "SetUserVar=";

// OSC 1337 `CurrentDir=<path>`: iTerm2's cwd report, a fallback source next to
// OSC 7. The path may be percent-encoded; only absolute paths are accepted so
// a bogus value can never clobber a good OSC 7 report.
export const parseIterm2CurrentDir = (data: string): string | undefined => {
  if (!data.startsWith(CURRENT_DIR_PREFIX)) {
    return undefined;
  }

  const raw = data.slice(CURRENT_DIR_PREFIX.length);
  let path = raw;
  try {
    path = decodeURIComponent(raw);
  } catch {
    // Not valid percent-encoding — fall back to the raw value.
  }

  return path.startsWith("/") ? path : undefined;
};

// OSC 1337 `SetUserVar=<key>=<base64>`: iTerm2 base64-encodes the value. The
// key stops at the first "=" so the base64 payload keeps its padding.
export const parseIterm2SetUserVar = (
  data: string
): { key: string; value: string } | undefined => {
  if (!data.startsWith(SET_USER_VAR_PREFIX)) {
    return undefined;
  }

  const payload = data.slice(SET_USER_VAR_PREFIX.length);
  const separator = payload.indexOf("=");
  if (separator <= 0) {
    return undefined;
  }

  const key = payload.slice(0, separator);
  const encoded = payload.slice(separator + 1);

  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return { key, value: new TextDecoder().decode(bytes) };
  } catch {
    return undefined;
  }
};

// Everything else in the 1337 namespace (File= inline images/downloads, ...)
// is explicitly out of scope and consumed silently. Both accepted commands
// are idempotent store writes, so they are allowed during replay.
export const install = (terminal: Terminal, ctx: OscRuntimeContext): (() => void) => {
  const registration = terminal.parser.registerOscHandler(1337, (data) => {
    const sessionId = ctx.getSessionId();
    if (sessionId) {
      const cwd = parseIterm2CurrentDir(data);
      if (cwd) {
        useSessionOscStore.getState().setSessionCwd(sessionId, cwd);
      } else {
        const userVar = parseIterm2SetUserVar(data);
        if (userVar) {
          useSessionOscStore.getState().setSessionUserVar(sessionId, userVar.key, userVar.value);
        }
      }
    }
    return true;
  });

  return () => {
    registration.dispose();
  };
};
