const ESC = "\u001b";
const BEL = "\u0007";

export const OSC_TAP_MAX_OUTPUT_BYTES = 512 * 1024;
export const OSC_TAP_MAX_PENDING_BYTES = 64 * 1024;
export const OSC_TAP_MAX_HISTORY_ENTRIES = 100;

export interface OscTapCommandHistoryEntry {
  command: string | null;
  exitCode: number | null;
  startedAt: string;
  endedAt: string;
  /** Raw terminal data observed between OSC 133 C and D, excluding the marks. */
  output: string;
  /** Total bytes observed, including bytes omitted from `output`. */
  outputBytes: number;
  truncated: boolean;
}

export interface OscTapSnapshot {
  sessionId: string;
  cwd: string | null;
  lastCommand: string | null;
  activeCommand: {
    command: string | null;
    startedAt: string;
    outputBytes: number;
    truncated: boolean;
  } | null;
  history: OscTapCommandHistoryEntry[];
}

export interface OscTapOptions {
  maxOutputBytes?: number;
  maxPendingBytes?: number;
  maxHistoryEntries?: number;
  now?: () => number;
}

interface ActiveCommand {
  command: string | null;
  startedAt: string;
  outputParts: string[];
  retainedOutputBytes: number;
  outputBytes: number;
  truncated: boolean;
}

type ParserState = "text" | "escape" | "osc" | "osc-escape";

const positiveInteger = (value: number | undefined, fallback: number): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;

const normalizePosixPath = (rawPath: string): string | null => {
  const trimmed = rawPath.trim();
  if (!trimmed.startsWith("/") || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    return null;
  }
  const normalized = trimmed.replace(/\/+/g, "/").replace(/\/$/, "");
  return normalized || "/";
};

export const parseOsc7Cwd = (payload: string): string | null => {
  let url: URL;
  try {
    url = new URL(payload);
  } catch {
    return null;
  }
  if (url.protocol !== "file:") {
    return null;
  }
  try {
    return normalizePosixPath(decodeURIComponent(url.pathname));
  } catch {
    return null;
  }
};

const parseExitCode = (value: string | undefined): number | null => {
  if (!value || !/^-?\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

/** Returns the largest UTF-8-safe prefix that fits in `maxBytes`. */
const truncateUtf8 = (value: string, maxBytes: number): string => {
  if (maxBytes <= 0) {
    return "";
  }
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return value;
  }

  let end = maxBytes;
  while (end > 0 && (buffer[end] ?? 0) >>> 6 === 0b10) {
    end -= 1;
  }
  return buffer.subarray(0, end).toString("utf8");
};

const cloneHistoryEntry = (entry: OscTapCommandHistoryEntry): OscTapCommandHistoryEntry => ({
  ...entry
});

/**
 * Lightweight, streaming OSC scanner for one terminal session.
 *
 * It deliberately does not emulate a terminal grid. Only OSC 7 and OSC 133 are
 * interpreted; all other data stays available as raw command output. Parser
 * state survives arbitrary chunk boundaries, including a split ESC + `\\` ST.
 */
export class OscTap {
  private readonly sessionId: string;
  private readonly maxOutputBytes: number;
  private readonly maxPendingBytes: number;
  private readonly maxHistoryEntries: number;
  private readonly now: () => number;

  private parserState: ParserState = "text";
  private oscPayload = "";
  private oscPayloadBytes = 0;
  private cwd: string | null = null;
  private lastCommand: string | null = null;
  private activeCommand: ActiveCommand | null = null;
  private history: OscTapCommandHistoryEntry[] = [];
  private disposed = false;

  constructor(sessionId: string, options: OscTapOptions = {}) {
    this.sessionId = sessionId;
    this.maxOutputBytes = positiveInteger(options.maxOutputBytes, OSC_TAP_MAX_OUTPUT_BYTES);
    this.maxPendingBytes = positiveInteger(options.maxPendingBytes, OSC_TAP_MAX_PENDING_BYTES);
    this.maxHistoryEntries = positiveInteger(
      options.maxHistoryEntries,
      OSC_TAP_MAX_HISTORY_ENTRIES
    );
    this.now = options.now ?? Date.now;
  }

  feed(chunk: string): void {
    if (this.disposed || chunk.length === 0) {
      return;
    }

    let offset = 0;
    while (offset < chunk.length) {
      if (this.parserState === "text") {
        const escapeAt = chunk.indexOf(ESC, offset);
        if (escapeAt === -1) {
          this.appendOutput(chunk.slice(offset));
          return;
        }
        if (escapeAt > offset) {
          this.appendOutput(chunk.slice(offset, escapeAt));
        }
        this.parserState = "escape";
        offset = escapeAt + 1;
        continue;
      }

      if (this.parserState === "escape") {
        if (chunk[offset] === "]") {
          this.parserState = "osc";
          this.oscPayload = "";
          this.oscPayloadBytes = 0;
          offset += 1;
          continue;
        }
        // It was a non-OSC escape sequence. Preserve ESC as command output and
        // let the current character be processed normally (it may be another ESC).
        this.appendOutput(ESC);
        this.parserState = "text";
        continue;
      }

      if (this.parserState === "osc-escape") {
        const current = chunk[offset];
        if (current === "\\") {
          this.finishOsc(`${ESC}\\`);
          offset += 1;
          continue;
        }
        if (current === BEL) {
          if (!this.appendOscPayload(ESC)) {
            offset += 1;
            continue;
          }
          this.finishOsc(BEL);
          offset += 1;
          continue;
        }
        if (!this.appendOscPayload(`${ESC}${current}`)) {
          offset += 1;
          continue;
        }
        this.parserState = "osc";
        offset += 1;
        continue;
      }

      const current = chunk[offset];
      if (current === BEL) {
        this.finishOsc(BEL);
        offset += 1;
        continue;
      }
      if (current === ESC) {
        this.parserState = "osc-escape";
        offset += 1;
        continue;
      }

      let boundary = offset;
      while (boundary < chunk.length && chunk[boundary] !== BEL && chunk[boundary] !== ESC) {
        boundary += 1;
      }
      const fragment = chunk.slice(offset, boundary);
      if (!this.appendOscPayload(fragment)) {
        offset = boundary;
        continue;
      }
      offset = boundary;
    }
  }

  getSnapshot(): OscTapSnapshot {
    const active = this.activeCommand;
    return {
      sessionId: this.sessionId,
      cwd: this.cwd,
      lastCommand: this.lastCommand,
      activeCommand: active
        ? {
            command: active.command,
            startedAt: active.startedAt,
            outputBytes: active.outputBytes,
            truncated: active.truncated
          }
        : null,
      history: this.history.map(cloneHistoryEntry)
    };
  }

  dispose(): void {
    this.disposed = true;
    this.parserState = "text";
    this.oscPayload = "";
    this.oscPayloadBytes = 0;
    this.activeCommand = null;
    this.history = [];
    this.cwd = null;
    this.lastCommand = null;
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  private appendOscPayload(fragment: string): boolean {
    const fragmentBytes = Buffer.byteLength(fragment, "utf8");
    if (this.oscPayloadBytes + fragmentBytes <= this.maxPendingBytes) {
      this.oscPayload += fragment;
      this.oscPayloadBytes += fragmentBytes;
      return true;
    }

    // A missing terminator must not retain an unbounded string. Once the safety
    // limit is crossed, degrade the pending OSC to ordinary terminal output and
    // resume scanning so a later well-formed OSC can still be recognized.
    this.appendOutput(`${ESC}]${this.oscPayload}${fragment}`);
    this.oscPayload = "";
    this.oscPayloadBytes = 0;
    this.parserState = "text";
    return false;
  }

  private finishOsc(terminator: string): void {
    const payload = this.oscPayload;
    const raw = `${ESC}]${payload}${terminator}`;
    this.oscPayload = "";
    this.oscPayloadBytes = 0;
    this.parserState = "text";

    if (payload.startsWith("7;")) {
      const nextCwd = parseOsc7Cwd(payload.slice(2));
      if (nextCwd !== null) {
        this.cwd = nextCwd;
      }
      this.appendOutput(raw);
      return;
    }

    if (!payload.startsWith("133;")) {
      this.appendOutput(raw);
      return;
    }

    const fields = payload.split(";");
    const mark = fields[1];
    if (mark === "C") {
      const commandText = fields.slice(2).join(";");
      this.startCommand(commandText.length > 0 ? commandText : null);
      return;
    }
    if (mark === "D") {
      this.finishCommand(parseExitCode(fields[2]));
      return;
    }

    this.appendOutput(raw);
  }

  private startCommand(command: string | null): void {
    this.activeCommand = {
      command,
      startedAt: this.timestamp(),
      outputParts: [],
      retainedOutputBytes: 0,
      outputBytes: 0,
      truncated: false
    };
    // A bare legacy C means the latest command is unknown, not that the prior
    // known command is still current.
    this.lastCommand = command;
  }

  private finishCommand(exitCode: number | null): void {
    const active = this.activeCommand;
    if (!active) {
      return;
    }
    const entry: OscTapCommandHistoryEntry = {
      command: active.command,
      exitCode,
      startedAt: active.startedAt,
      endedAt: this.timestamp(),
      output: active.outputParts.join(""),
      outputBytes: active.outputBytes,
      truncated: active.truncated
    };
    this.history.push(entry);
    if (this.history.length > this.maxHistoryEntries) {
      this.history.splice(0, this.history.length - this.maxHistoryEntries);
    }
    this.activeCommand = null;
  }

  private appendOutput(value: string): void {
    const active = this.activeCommand;
    if (!active || value.length === 0) {
      return;
    }

    const bytes = Buffer.byteLength(value, "utf8");
    active.outputBytes += bytes;
    const remaining = this.maxOutputBytes - active.retainedOutputBytes;
    if (remaining <= 0) {
      active.truncated = true;
      return;
    }

    if (bytes <= remaining) {
      active.outputParts.push(value);
      active.retainedOutputBytes += bytes;
      return;
    }

    const prefix = truncateUtf8(value, remaining);
    if (prefix.length > 0) {
      active.outputParts.push(prefix);
      active.retainedOutputBytes += Buffer.byteLength(prefix, "utf8");
    }
    active.truncated = true;
  }
}

export class OscTapRegistry {
  private readonly options: OscTapOptions;
  private readonly taps = new Map<string, OscTap>();

  constructor(options: OscTapOptions = {}) {
    this.options = options;
  }

  feed(sessionId: string, chunk: string): OscTapSnapshot {
    let tap = this.taps.get(sessionId);
    if (!tap) {
      tap = new OscTap(sessionId, this.options);
      this.taps.set(sessionId, tap);
    }
    tap.feed(chunk);
    return tap.getSnapshot();
  }

  get(sessionId: string): OscTapSnapshot | undefined {
    return this.taps.get(sessionId)?.getSnapshot();
  }

  list(): OscTapSnapshot[] {
    return [...this.taps.values()].map((tap) => tap.getSnapshot());
  }

  dispose(sessionId: string): boolean {
    const tap = this.taps.get(sessionId);
    if (!tap) {
      return false;
    }
    tap.dispose();
    this.taps.delete(sessionId);
    return true;
  }

  disposeAll(): void {
    for (const tap of this.taps.values()) {
      tap.dispose();
    }
    this.taps.clear();
  }
}
