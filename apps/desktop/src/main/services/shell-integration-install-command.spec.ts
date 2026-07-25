import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  SHELL_INTEGRATION_FAMILIES,
  buildInstallCommand,
  buildSourceLine,
  shellIntegrationScriptText
} from "../../shared/shell-integration";

// Escaping a shell script that is itself full of quotes into a single `sh -c`
// argument is the most fragile part of the injection path, and a mistake there
// silently corrupts the installed file rather than failing loudly. So run the
// generated command for real against a throwaway HOME and diff the result.
const canRunPosixShell = process.platform !== "win32" && existsSync("/bin/sh");

describe.skipIf(!canRunPosixShell)("generated install command", () => {
  const home = mkdtempSync(path.join(tmpdir(), "nextshell-shell-integration-"));

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const runInHome = (command: string): string =>
    execFileSync("/bin/sh", ["-c", command], {
      env: { ...process.env, HOME: home }
    }).toString();

  test("installs every script byte-identically", () => {
    runInHome(buildInstallCommand(SHELL_INTEGRATION_FAMILIES));

    for (const family of SHELL_INTEGRATION_FAMILIES) {
      const installed = readFileSync(
        path.join(home, ".cache/nextshell", `nextshell-shell-integration.${family}`),
        "utf-8"
      );
      expect(installed).toBe(shellIntegrationScriptText(family));
    }
  });

  test("is re-runnable — reinstalling overwrites instead of appending", () => {
    runInHome(buildInstallCommand(["sh"]));
    runInHome(buildInstallCommand(["sh"]));

    const installed = readFileSync(
      path.join(home, ".cache/nextshell", "nextshell-shell-integration.sh"),
      "utf-8"
    );
    expect(installed).toBe(shellIntegrationScriptText("sh"));
  });

  test("the POSIX source line loads the script and emits OSC 7", () => {
    runInHome(buildInstallCommand(["sh"]));

    const output = runInHome(`PS1='$ '; ${buildSourceLine("sh")}; __nextshell_emit_cwd`);

    expect(output).toContain("]7;file://");
  });

  test("sourcing twice is a no-op thanks to the sentinel", () => {
    runInHome(buildInstallCommand(["sh"]));

    const sourceLine = buildSourceLine("sh");
    const output = runInHome(
      `PS1='$ '; ${sourceLine}; ${sourceLine}; printf '%s' "$PS1" | tr -dc 'a-z_' `
    );

    // A second source must not append the cwd hook to PS1 again.
    expect(output.match(/__nextshell_emit_cwd/g)).toHaveLength(1);
  });
});

// bash re-parses PROMPT_COMMAND as a script on *every* prompt, so a splice that
// merely looks right is not enough — it has to still parse next to whatever the
// user already had there.
const canRunBash = process.platform !== "win32" && existsSync("/bin/bash");

describe.skipIf(!canRunBash)("bash PROMPT_COMMAND splicing", () => {
  const home = mkdtempSync(path.join(tmpdir(), "nextshell-bash-prompt-"));

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  beforeAll(() => {
    execFileSync("/bin/sh", ["-c", buildInstallCommand(["bash"])], {
      env: { ...process.env, HOME: home }
    });
  });

  // Env vars arrive in the child as ordinary shell variables, so this is the
  // closest stand-in for a user whose rc file already set PROMPT_COMMAND.
  const spliceInto = (existing: string): string =>
    execFileSync(
      "/bin/bash",
      ["--norc", "--noprofile", "-c", `${buildSourceLine("bash")}; printf %s "$PROMPT_COMMAND"`],
      {
        env: { ...process.env, HOME: home, PROMPT_COMMAND: existing }
      }
    ).toString();

  const expectParses = (command: string): void => {
    expect(() =>
      execFileSync("/bin/bash", ["-n"], { input: command, stdio: "pipe" })
    ).not.toThrow();
  };

  test("a PROMPT_COMMAND ending in a separator stays parseable", () => {
    // `PROMPT_COMMAND='history -a; '` is a widespread snippet. Joining with
    // `;` yielded `history -a; ;__nextshell_prompt_end` — an empty command
    // between two separators, i.e. a syntax error on every single prompt.
    const spliced = spliceInto("history -a; ");

    expect(spliced).toContain("history -a");
    expect(spliced).toContain("__nextshell_prompt_start");
    expect(spliced).toContain("__nextshell_prompt_end");
    expectParses(spliced);
  });

  test("empty and plain PROMPT_COMMAND values stay parseable", () => {
    for (const existing of ["", "history -a", "printf ''"]) {
      expectParses(spliceInto(existing));
    }
  });

  test("re-sourcing in a fresh shell does not stack the hooks twice", () => {
    const once = spliceInto("history -a; ");
    expect(spliceInto(once)).toBe(once);
  });
});
