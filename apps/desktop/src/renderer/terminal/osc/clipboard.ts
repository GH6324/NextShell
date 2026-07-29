import type { Terminal } from "@xterm/xterm";
import type { OscRuntimeContext } from "../oscRuntime";

// OSC 52 (clipboard access): `OSC 52 ; Pc ; Pd ST`. Pc names the selection(s)
// (c/p/s/q — accepted verbatim, treated uniformly), Pd is either a base64
// payload (write) or "?" (read). Write is preference-gated and capped, read is
// refused unless explicitly enabled; both stay silent during buffer replay.
// The sequence is always consumed (handler returns true) and never displayed.

/** Maximum decoded clipboard payload accepted from a remote host. */
export const OSC52_MAX_DECODED_BYTES = 1024 * 1024;

const BASE64_PAYLOAD_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export interface Osc52Payload {
  selection: string;
  payload: string;
}

/** Split the raw OSC 52 data into selection and payload parts. */
export const parseOsc52Payload = (data: string): Osc52Payload | undefined => {
  const separatorIndex = data.indexOf(";");
  if (separatorIndex < 0) {
    return undefined;
  }

  return {
    selection: data.slice(0, separatorIndex),
    payload: data.slice(separatorIndex + 1)
  };
};

/** Strip whitespace some senders wrap payloads in; undefined when not base64. */
const normalizeBase64Payload = (payload: string): string | undefined => {
  const normalized = payload.replace(/\s+/g, "");
  if (!BASE64_PAYLOAD_PATTERN.test(normalized) || normalized.length % 4 === 1) {
    return undefined;
  }
  return normalized;
};

/** Decode a base64 clipboard payload as UTF-8 text; undefined when invalid. */
export const decodeOsc52Base64 = (payload: string): string | undefined => {
  const normalized = normalizeBase64Payload(payload);
  if (normalized === undefined) {
    return undefined;
  }

  try {
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
};

/** Encode clipboard text for a read reply (UTF-8 bytes → base64). */
export const encodeOsc52Base64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

/** Decoded byte length from the base64 length alone — never materializes data. */
const estimateDecodedByteLength = (payload: string): number | undefined => {
  const normalized = normalizeBase64Payload(payload);
  if (normalized === undefined) {
    return undefined;
  }

  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.floor((normalized.length * 3) / 4) - padding;
};

export interface Osc52HandleOptions {
  allowWrite: boolean;
  allowRead: boolean;
  clipboard: Pick<Clipboard, "writeText" | "readText">;
  writeReply: (data: string) => void;
  warn?: (message: string, details?: unknown) => void;
}

/**
 * Handle one OSC 52 sequence. Side effects flow through the injected clipboard
 * / writeReply seams so the gating logic stays testable in a node environment.
 * Always consumes the sequence (returns true).
 */
export const handleOsc52Sequence = (data: string, options: Osc52HandleOptions): boolean => {
  const warn = options.warn ?? console.warn;
  const parsed = parseOsc52Payload(data);
  if (!parsed) {
    return true;
  }

  const { selection, payload } = parsed;

  if (payload === "?") {
    // Read path: refused unless explicitly enabled — consume silently either way.
    if (!options.allowRead) {
      return true;
    }

    void options.clipboard
      .readText()
      .then((text) => {
        options.writeReply(`\x1b]52;${selection || "c"};${encodeOsc52Base64(text)}\x07`);
      })
      .catch(() => undefined);
    return true;
  }

  if (!options.allowWrite) {
    return true;
  }

  const decodedByteLength = estimateDecodedByteLength(payload);
  if (decodedByteLength === undefined) {
    // Invalid base64 — ignore, but still consume the sequence.
    return true;
  }

  if (decodedByteLength > OSC52_MAX_DECODED_BYTES) {
    warn(
      `[osc52] 剪贴板写入被丢弃：解码后约 ${decodedByteLength} 字节，超过 ${OSC52_MAX_DECODED_BYTES} 字节上限`
    );
    return true;
  }

  const text = decodeOsc52Base64(payload);
  if (text === undefined) {
    return true;
  }

  void options.clipboard
    .writeText(text)
    .catch((error: unknown) => warn("[osc52] 剪贴板写入失败", error));
  return true;
};

// Rejecting stub for environments where the async clipboard API is unavailable
// (non-secure context): failures are swallowed by the handler's catch paths.
const unavailableClipboard: Pick<Clipboard, "writeText" | "readText"> = {
  writeText: () => Promise.reject(new Error("clipboard unavailable")),
  readText: () => Promise.reject(new Error("clipboard unavailable"))
};

const resolveClipboard = (): Pick<Clipboard, "writeText" | "readText"> => {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    return navigator.clipboard;
  }
  return unavailableClipboard;
};

export const install = (terminal: Terminal, ctx: OscRuntimeContext): (() => void) => {
  const registration = terminal.parser.registerOscHandler(52, (data) => {
    const preferences = ctx.getTerminalPreferences();
    const replaying = ctx.isReplaying();
    // Captured here, synchronously with the parse: the read reply is produced
    // from an async clipboard promise, and by the time it settles the parser
    // may be chewing on another session's chunk. Resolving the target then
    // would send the local clipboard into whichever session is in front —
    // possibly a shell on a different host.
    const replySessionId = ctx.getSessionId();
    return handleOsc52Sequence(data, {
      allowWrite: preferences.oscClipboardWrite && !replaying,
      allowRead: preferences.oscClipboardRead === true && !replaying,
      clipboard: resolveClipboard(),
      writeReply: (reply) => {
        if (!replySessionId) {
          return;
        }
        ctx.writeToRemoteAs(replySessionId, reply);
      }
    });
  });

  return () => {
    registration.dispose();
  };
};
