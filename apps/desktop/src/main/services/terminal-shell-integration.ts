import type { ExecResult } from "@nextshell/ssh";
import integrationSh from "../../shared/shell-integration/nextshell-shell-integration.sh?raw";
import integrationFish from "../../shared/shell-integration/nextshell-shell-integration.fish?raw";

// Shell-integration injection ("auto" preference mode): after the PTY shell
// opens, passively watch its output for a short window. A remote that already
// emits OSC 133 or OSC 7 has its own integration (starship, wezterm, iTerm2,
// VTE prompt hooks) and is left untouched; otherwise the integration script
// is installed under $HOME/.cache/nextshell via an exec channel and activated
// with a single visible `source` line written to the live shell. This
// replaces the old restart-shell bootstrap (mktemp rcfile / ZDOTDIR via an
// exec channel) and preserves real PTY semantics.

export type ShellIntegrationFamily = "bash" | "zsh" | "sh" | "fish";

export const SHELL_INTEGRATION_REMOTE_DIR = "$HOME/.cache/nextshell";
export const SHELL_INTEGRATION_SH_NAME = "nextshell-shell-integration.sh";
export const SHELL_INTEGRATION_FISH_NAME = "nextshell-shell-integration.fish";

const HEREDOC_DELIMITER = "__NEXTSHELL_INTEGRATION_EOF__";
const DEFAULT_OBSERVE_WINDOW_MS = 2000;
const INTEGRATED_SEQUENCE_PATTERN = /\u001b\](?:133|7);/;

export const resolveShellFamily = (
  shellPath?: string | null
): ShellIntegrationFamily | undefined => {
  const normalized = shellPath?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  switch (basename) {
    case "bash":
      return "bash";
    case "zsh":
      return "zsh";
    case "sh":
      return "sh";
    case "fish":
      return "fish";
    default:
      return undefined;
  }
};

export const resolveShellIntegrationScriptName = (family: ShellIntegrationFamily): string =>
  family === "fish" ? SHELL_INTEGRATION_FISH_NAME : SHELL_INTEGRATION_SH_NAME;

export const buildSourceLine = (family: ShellIntegrationFamily): string =>
  `source "${SHELL_INTEGRATION_REMOTE_DIR}/${resolveShellIntegrationScriptName(family)}"`;

export const buildHeredocInstallCommand = (
  scriptText: string,
  family: ShellIntegrationFamily
): string => {
  // The heredoc delimiter must sit alone on its line, so guarantee a trailing
  // newline after the script body.
  const body = scriptText.endsWith("\n") ? scriptText : `${scriptText}\n`;
  return [
    `mkdir -p "${SHELL_INTEGRATION_REMOTE_DIR}" && cat > "${SHELL_INTEGRATION_REMOTE_DIR}/${resolveShellIntegrationScriptName(family)}" <<'${HEREDOC_DELIMITER}'`,
    body + HEREDOC_DELIMITER
  ].join("\n");
};

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

export interface ShellIntegrationObserverOptions {
  connection: ShellIntegrationExecLike;
  shell: ShellIntegrationChannelLike;
  family: ShellIntegrationFamily;
  /** False once the owning session is gone; pending injection is skipped. */
  isSessionActive: () => boolean;
  /** Decode raw channel chunks with the session's terminal encoding. */
  decode?: (chunk: Buffer | string) => string;
  observeWindowMs?: number;
  /** setTimeout seam: schedules the callback, returns a cancel function. */
  schedule?: (callback: () => void, ms: number) => () => void;
  /** Script body override for tests; defaults to the bundled script. */
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
    family,
    isSessionActive,
    decode = (chunk) => (typeof chunk === "string" ? chunk : chunk.toString("utf-8")),
    observeWindowMs = DEFAULT_OBSERVE_WINDOW_MS,
    schedule = (callback, ms) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    },
    scriptText = family === "fish" ? integrationFish : integrationSh,
    log = () => undefined
  } = options;

  let settled = false;
  let cancelTimer: () => void = () => undefined;

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

  const inject = async (): Promise<void> => {
    if (!isSessionActive()) {
      return;
    }
    try {
      const result = await connection.exec(buildHeredocInstallCommand(scriptText, family));
      if (result.exitCode !== 0) {
        log("[ShellIntegration] install command failed; skipping injection", {
          exitCode: result.exitCode
        });
        return;
      }
      if (!isSessionActive()) {
        return;
      }
      // One short visible line is the accepted fallback (WindTerm/Tabby do
      // the same); the script itself is idempotent and append-only.
      shell.write(`${buildSourceLine(family)}\r`);
    } catch (error) {
      log("[ShellIntegration] injection skipped", {
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const onData = (chunk: Buffer | string): void => {
    if (settled) {
      return;
    }
    if (INTEGRATED_SEQUENCE_PATTERN.test(decode(chunk))) {
      // The remote already runs its own integration; stay passive.
      cleanup();
    }
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
