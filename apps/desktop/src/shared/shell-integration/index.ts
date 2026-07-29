import integrationBash from "./nextshell-shell-integration.bash?raw";
import integrationZsh from "./nextshell-shell-integration.zsh?raw";
import integrationSh from "./nextshell-shell-integration.sh?raw";
import integrationFish from "./nextshell-shell-integration.fish?raw";

// Shared between the main process (auto-injection) and the renderer (the
// "manual" mode copy-install command) so the remote paths, the heredoc
// delimiter and the source line can never drift apart.

export type ShellIntegrationFamily = "bash" | "zsh" | "sh" | "fish";

export const SHELL_INTEGRATION_FAMILIES: readonly ShellIntegrationFamily[] = [
  "bash",
  "zsh",
  "sh",
  "fish"
];

export const SHELL_INTEGRATION_REMOTE_DIR = "$HOME/.cache/nextshell";

const HEREDOC_DELIMITER = "__NEXTSHELL_INTEGRATION_EOF__";

const SCRIPT_TEXT_BY_FAMILY: Record<ShellIntegrationFamily, string> = {
  bash: integrationBash,
  zsh: integrationZsh,
  sh: integrationSh,
  fish: integrationFish
};

export const resolveShellFamily = (
  shellPath?: string | null
): ShellIntegrationFamily | undefined => {
  const normalized = shellPath?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  return SHELL_INTEGRATION_FAMILIES.find((family) => family === basename);
};

/** One script per family: bash/zsh/sh share no parseable syntax subset. */
export const shellIntegrationScriptName = (family: ShellIntegrationFamily): string =>
  `nextshell-shell-integration.${family}`;

export const shellIntegrationScriptPath = (family: ShellIntegrationFamily): string =>
  `${SHELL_INTEGRATION_REMOTE_DIR}/${shellIntegrationScriptName(family)}`;

export const shellIntegrationScriptText = (family: ShellIntegrationFamily): string =>
  SCRIPT_TEXT_BY_FAMILY[family];

/** POSIX single-quoting: close, escape, reopen — valid in sh, bash, zsh and fish. */
export const posixSingleQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * sshd runs an exec request through the *user's login shell*, and the same
 * applies to anything the user pastes into their own prompt. fish supports
 * neither heredocs nor `${VAR:-}`, so every remote command we generate is
 * handed to `/bin/sh` instead of being written in the caller's dialect.
 */
export const wrapForPosixShell = (script: string): string =>
  `/bin/sh -c ${posixSingleQuote(script)}`;

/** Reads the remote login shell; POSIX-wrapped so it also works under fish. */
export const SHELL_INTEGRATION_PROBE_COMMAND = wrapForPosixShell('printf %s "${SHELL:-}"');

/**
 * The line written into the live shell (auto mode) or appended to the user's rc
 * (manual mode). fish has no `.` builtin and dash has no `source` builtin, so
 * the two cannot share one spelling.
 */
export const buildSourceLine = (family: ShellIntegrationFamily): string => {
  const quotedPath = `"${shellIntegrationScriptPath(family)}"`;
  return family === "fish" ? `source ${quotedPath}` : `. ${quotedPath}`;
};

/**
 * Same directory as the final script (so the rename stays on one filesystem and
 * is therefore atomic) plus the writing shell's PID, which is unique among all
 * processes alive at that moment — i.e. among exactly the concurrent installers
 * we are racing against.
 */
export const shellIntegrationScriptTempPath = (family: ShellIntegrationFamily): string =>
  `${shellIntegrationScriptPath(family)}.$$.tmp`;

/**
 * POSIX script that creates the cache dir and writes the requested scripts.
 *
 * The write is staged through a per-process temp file and published with `mv`:
 * opening the final path with `>` truncates it in place, so a second tab
 * installing while a first tab's shell is mid-`source` would hand that shell an
 * empty or half-written file (parse errors, or OSC 133/7 silently never
 * arriving). `mv` within one directory is a rename(2) — a sourcing shell sees
 * either the whole old file or the whole new one.
 */
export const buildInstallScript = (
  families: readonly ShellIntegrationFamily[],
  readScript: (family: ShellIntegrationFamily) => string = shellIntegrationScriptText
): string => {
  const blocks = families.map((family) => {
    const text = readScript(family);
    // The heredoc delimiter must sit alone on its line, so guarantee a
    // trailing newline after the script body.
    const body = text.endsWith("\n") ? text : `${text}\n`;
    const finalPath = shellIntegrationScriptPath(family);
    const tempPath = shellIntegrationScriptTempPath(family);
    // The heredoc body starts after the *whole* command line, so the `&&`/`||`
    // tail is allowed to sit next to the `<<` redirection. A failed write must
    // never be published, and must not leave the temp file behind either.
    const header =
      `cat > "${tempPath}" <<'${HEREDOC_DELIMITER}' &&` +
      ` mv -f "${tempPath}" "${finalPath}"` +
      ` || { rm -f "${tempPath}"; exit 1; }`;
    return `${header}\n${body}${HEREDOC_DELIMITER}`;
  });

  return [`mkdir -p "${SHELL_INTEGRATION_REMOTE_DIR}"`, ...blocks].join("\n");
};

/** Ready-to-exec remote command that installs the given integration scripts. */
export const buildInstallCommand = (
  families: readonly ShellIntegrationFamily[],
  readScript?: (family: ShellIntegrationFamily) => string
): string => wrapForPosixShell(buildInstallScript(families, readScript));

const MANUAL_RC_FILE_BY_FAMILY: Record<ShellIntegrationFamily, string> = {
  bash: "~/.bashrc",
  zsh: "~/.zshrc",
  sh: "~/.profile",
  fish: "~/.config/fish/config.fish"
};

/**
 * "Manual" mode payload: one command that installs every family's script,
 * followed by the per-shell activation line. Everything runs through
 * `/bin/sh -c`, so pasting it into bash, zsh or fish all behave the same.
 */
export const buildManualInstallInstructions = (): string =>
  [
    "# NextShell 终端集成：把下面整段粘贴到远端 shell 执行",
    buildInstallCommand(SHELL_INTEGRATION_FAMILIES),
    "",
    "# 然后把与你的 shell 对应的一行追加到登录配置文件中：",
    ...SHELL_INTEGRATION_FAMILIES.map(
      (family) =>
        `#   ${family.padEnd(4)} → echo '${buildSourceLine(family)}' >> ${MANUAL_RC_FILE_BY_FAMILY[family]}`
    )
  ].join("\n");
