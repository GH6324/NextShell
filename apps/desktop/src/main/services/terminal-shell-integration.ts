import type { ExecResult } from "@nextshell/ssh";
import {
  buildInstallCommand,
  buildSourceLine,
  shellIntegrationScriptText,
  type ShellIntegrationFamily
} from "../../shared/shell-integration";

// Shell-integration injection ("auto" preference mode): after the PTY shell
// opens, passively watch its output for a short window. A remote that already
// emits OSC 133 or OSC 7 has its own integration (starship, wezterm, iTerm2,
// VTE prompt hooks) and is left untouched; otherwise the integration script
// is installed under $HOME/.cache/nextshell via an exec channel and activated
// with a single visible source line written to the live shell. This replaces
// the old restart-shell bootstrap (mktemp rcfile / ZDOTDIR via an exec
// channel) and preserves real PTY semantics.

// Re-exported so session-service has a single import for the whole feature.
export {
  SHELL_INTEGRATION_PROBE_COMMAND,
  resolveShellFamily,
  type ShellIntegrationFamily
} from "../../shared/shell-integration";

const DEFAULT_OBSERVE_WINDOW_MS = 2000;
const INTEGRATED_SEQUENCE_PATTERN = /\u001b\](?:133|7);/;
/** Longest match (ESC ] 1 3 3 ;) minus one, so a chunk split never hides one. */
const DETECTION_TAIL_LENGTH = 5;

export interface ShellIntegrationChannelLike {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  on(event: "close" | "error", listener: () => void): unknown;
  removeListener(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  removeListener(event: "close" | "error", listener: () => void): unknown;
  write(data: string): unknown;
}

export interface ShellIntegrationExecLike {
  exec(command: string): Promise<ExecResult>;
}

/**
 * Per-connection install bookkeeping. Several sessions on one server finish
 * their observation window within milliseconds of each other and would
 * otherwise each rewrite the same remote script while the previous session's
 * shell is sourcing it. Keeping this module-level (rather than in
 * session-service) makes every caller of `startShellIntegrationObserver` share
 * the guard for free.
 *
 * Value semantics: a settled `true` means "installed on this connection, do not
 * install again"; a pending promise means an install is in flight and later
 * observers must await it; a failed install removes the entry so the next
 * session retries.
 */
type FamilyInstalls = Map<ShellIntegrationFamily, Promise<boolean>>;

const installsByConnectionId = new Map<string, FamilyInstalls>();
/** Weak, so connections that go away take their bookkeeping with them. */
let installsByConnection = new WeakMap<ShellIntegrationExecLike, FamilyInstalls>();

const resolveFamilyInstalls = (
  connectionId: string | undefined,
  connection: ShellIntegrationExecLike
): FamilyInstalls => {
  if (connectionId !== undefined) {
    const existing = installsByConnectionId.get(connectionId);
    if (existing) {
      return existing;
    }
    const created: FamilyInstalls = new Map();
    installsByConnectionId.set(connectionId, created);
    return created;
  }

  const existing = installsByConnection.get(connection);
  if (existing) {
    return existing;
  }
  const created: FamilyInstalls = new Map();
  installsByConnection.set(connection, created);
  return created;
};

/**
 * Drops the "already installed" memory for one connection (or all of them).
 * Call it when a connection is torn down so a reconnect — possibly to a host
 * whose cache dir was wiped meanwhile — installs again.
 */
export const forgetShellIntegrationInstalls = (connectionId?: string): void => {
  if (connectionId === undefined) {
    installsByConnectionId.clear();
    installsByConnection = new WeakMap();
    return;
  }
  installsByConnectionId.delete(connectionId);
};

export interface ShellIntegrationObserverOptions {
  connection: ShellIntegrationExecLike;
  shell: ShellIntegrationChannelLike;
  /**
   * Dedupe key for the install step. Tabs opened against the same server share
   * one connection and one remote script path, so only the first observer runs
   * the install; the rest wait for it and then inject. Falls back to the
   * `connection` object's identity when omitted.
   */
  connectionId?: string;
  /**
   * Awaited only at injection time so the login-shell probe can run in
   * parallel with session startup instead of delaying the shell channel.
   */
  family: ShellIntegrationFamily | undefined | Promise<ShellIntegrationFamily | undefined>;
  /** False once the owning session is gone; pending injection is skipped. */
  isSessionActive: () => boolean;
  /**
   * True once the user has typed into this session. The source line is written
   * to the shell's stdin, so injecting after the user started a command would
   * splice into their input line and submit it.
   */
  hasUserInput?: () => boolean;
  /** Decode raw channel chunks with the session's terminal encoding. */
  decode?: (chunk: Buffer | string) => string;
  observeWindowMs?: number;
  /** setTimeout seam: schedules the callback, returns a cancel function. */
  schedule?: (callback: () => void, ms: number) => () => void;
  /** Script body override for tests; defaults to the bundled per-family script. */
  scriptText?: string;
  log?: (message: string, metadata?: Record<string, unknown>) => void;
}

/**
 * Watches the freshly opened shell for up to `observeWindowMs`. Returns a
 * cleanup that detaches all listeners and cancels the pending timer; it is
 * idempotent and also runs automatically on shell close/error.
 */
export const startShellIntegrationObserver = (
  options: ShellIntegrationObserverOptions
): (() => void) => {
  const {
    connection,
    shell,
    connectionId,
    family: familyInput,
    isSessionActive,
    hasUserInput = () => false,
    decode = (chunk) => (typeof chunk === "string" ? chunk : chunk.toString("utf-8")),
    observeWindowMs = DEFAULT_OBSERVE_WINDOW_MS,
    schedule = (callback, ms) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    },
    scriptText,
    log = () => undefined
  } = options;

  let settled = false;
  let cancelTimer: () => void = () => undefined;
  // Carries the trailing bytes of the previous chunk so an escape sequence
  // split across two IPC-sized reads is still recognised.
  let pendingTail = "";

  const cleanup = (): void => {
    if (settled) {
      return;
    }
    settled = true;
    cancelTimer();
    shell.removeListener("data", onData);
    shell.removeListener("close", onClosed);
    shell.removeListener("error", onClosed);
  };

  const canInject = (): boolean => {
    if (!isSessionActive()) {
      return false;
    }
    if (hasUserInput()) {
      log("[ShellIntegration] user already typed; skipping injection");
      return false;
    }
    return true;
  };

  const runInstall = async (family: ShellIntegrationFamily): Promise<boolean> => {
    const script = scriptText ?? shellIntegrationScriptText(family);
    try {
      const result = await connection.exec(buildInstallCommand([family], () => script));
      if (result.exitCode !== 0) {
        log("[ShellIntegration] install command failed; skipping injection", {
          exitCode: result.exitCode
        });
        return false;
      }
      return true;
    } catch (error) {
      log("[ShellIntegration] injection skipped", {
        reason: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  };

  /** Runs the install at most once per connection+family; never rejects. */
  const ensureInstalled = (family: ShellIntegrationFamily): Promise<boolean> => {
    const installs = resolveFamilyInstalls(connectionId, connection);
    const inFlight = installs.get(family);
    if (inFlight) {
      return inFlight;
    }

    // Annotated because the callback below refers to `pending` itself.
    const pending: Promise<boolean> = runInstall(family).then((installed) => {
      if (!installed) {
        // Keep failures out of the cache so the next session tries again.
        if (installs.get(family) === pending) {
          installs.delete(family);
        }
      }
      return installed;
    });
    installs.set(family, pending);
    return pending;
  };

  const inject = async (): Promise<void> => {
    if (!canInject()) {
      return;
    }

    const family = await Promise.resolve(familyInput);
    if (!family || !canInject()) {
      return;
    }

    if (!(await ensureInstalled(family)) || !canInject()) {
      return;
    }

    // One short visible line is the accepted fallback (WindTerm/Tabby do
    // the same); the script itself is idempotent and append-only.
    shell.write(`${buildSourceLine(family)}\r`);
  };

  const onData = (chunk: Buffer | string): void => {
    if (settled) {
      return;
    }
    const text = pendingTail + decode(chunk);
    if (INTEGRATED_SEQUENCE_PATTERN.test(text)) {
      // The remote already runs its own integration; stay passive.
      cleanup();
      return;
    }
    pendingTail = text.slice(-DETECTION_TAIL_LENGTH);
  };

  const onClosed = (): void => {
    cleanup();
  };

  shell.on("data", onData);
  shell.on("close", onClosed);
  shell.on("error", onClosed);
  cancelTimer = schedule(() => {
    cleanup();
    void inject();
  }, observeWindowMs);

  return cleanup;
};
