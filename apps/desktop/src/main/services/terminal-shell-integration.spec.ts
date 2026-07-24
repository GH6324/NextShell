import { describe, expect, test, vi } from "vitest";
import {
  buildHeredocInstallCommand,
  buildSourceLine,
  resolveShellFamily,
  startShellIntegrationObserver,
  type ShellIntegrationChannelLike
} from "./terminal-shell-integration";

const ESC = "\u001b";
const BEL = "\u0007";

interface FakeShell extends ShellIntegrationChannelLike {
  emitData(chunk: Buffer | string): void;
  emitClose(): void;
  written: string[];
}

const createFakeShell = (): FakeShell => {
  const dataListeners = new Set<(chunk: Buffer | string) => void>();
  const closeListeners = new Set<() => void>();
  const written: string[] = [];
  return {
    written,
    on(event, listener) {
      if (event === "data") {
        dataListeners.add(listener as (chunk: Buffer | string) => void);
      } else {
        closeListeners.add(listener as () => void);
      }
    },
    removeListener(event, listener) {
      if (event === "data") {
        dataListeners.delete(listener as (chunk: Buffer | string) => void);
      } else {
        closeListeners.delete(listener as () => void);
      }
    },
    write(data) {
      written.push(data);
    },
    emitData(chunk) {
      for (const listener of dataListeners) {
        listener(chunk);
      }
    },
    emitClose() {
      for (const listener of closeListeners) {
        listener();
      }
    }
  };
};

const createManualScheduler = () => {
  const pending: Array<() => void> = [];
  const cancelled: Array<() => void> = [];
  return {
    schedule: (callback: () => void): (() => void) => {
      pending.push(callback);
      return () => {
        cancelled.push(callback);
        const index = pending.indexOf(callback);
        if (index >= 0) {
          pending.splice(index, 1);
        }
      };
    },
    fireAll: () => {
      for (const callback of pending.splice(0)) {
        callback();
      }
    },
    cancelled,
    pending
  };
};

const flushMicrotasks = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve));
};

describe("resolveShellFamily", () => {
  test("matches supported shells by basename", () => {
    expect(resolveShellFamily("/bin/bash")).toBe("bash");
    expect(resolveShellFamily("/usr/bin/zsh")).toBe("zsh");
    expect(resolveShellFamily("/bin/sh")).toBe("sh");
    expect(resolveShellFamily("/usr/local/bin/fish")).toBe("fish");
    expect(resolveShellFamily("bash")).toBe("bash");
    expect(resolveShellFamily("  /opt/homebrew/bin/FISH  ")).toBe("fish");
  });

  test("returns undefined for unsupported or empty shells", () => {
    expect(resolveShellFamily("/bin/dash")).toBeUndefined();
    expect(resolveShellFamily("/usr/bin/tcsh")).toBeUndefined();
    expect(resolveShellFamily("")).toBeUndefined();
    expect(resolveShellFamily(undefined)).toBeUndefined();
    expect(resolveShellFamily(null)).toBeUndefined();
  });
});

describe("buildSourceLine", () => {
  test("sources the .sh script for bash/zsh/sh and the .fish script for fish", () => {
    const shLine = 'source "$HOME/.cache/nextshell/nextshell-shell-integration.sh"';
    expect(buildSourceLine("bash")).toBe(shLine);
    expect(buildSourceLine("zsh")).toBe(shLine);
    expect(buildSourceLine("sh")).toBe(shLine);
    expect(buildSourceLine("fish")).toBe(
      'source "$HOME/.cache/nextshell/nextshell-shell-integration.fish"'
    );
  });
});

describe("buildHeredocInstallCommand", () => {
  test("creates the cache dir and writes the script through a quoted heredoc", () => {
    const command = buildHeredocInstallCommand("# script\necho hi\n", "zsh");

    expect(command).toContain('mkdir -p "$HOME/.cache/nextshell"');
    expect(command).toContain(
      "cat > \"$HOME/.cache/nextshell/nextshell-shell-integration.sh\" <<'__NEXTSHELL_INTEGRATION_EOF__'"
    );
    expect(command).toContain("# script\necho hi\n__NEXTSHELL_INTEGRATION_EOF__");
    expect(command.endsWith("__NEXTSHELL_INTEGRATION_EOF__")).toBe(true);
  });

  test("targets the .fish file for fish and appends the missing trailing newline", () => {
    const command = buildHeredocInstallCommand("# fish script", "fish");

    expect(command).toContain("$HOME/.cache/nextshell/nextshell-shell-integration.fish");
    expect(command).toContain("# fish script\n__NEXTSHELL_INTEGRATION_EOF__");
  });
});

describe("startShellIntegrationObserver", () => {
  test("installs and injects the source line when the window expires with no OSC", async () => {
    const shell = createFakeShell();
    const scheduler = createManualScheduler();
    const exec = vi.fn(async (_command: string) => ({ stdout: "", stderr: "", exitCode: 0 }));

    startShellIntegrationObserver({
      connection: { exec },
      shell,
      family: "bash",
      isSessionActive: () => true,
      schedule: scheduler.schedule,
      scriptText: "# test script\n"
    });

    shell.emitData(Buffer.from("user@host:~$ "));
    scheduler.fireAll();
    await flushMicrotasks();

    expect(exec).toHaveBeenCalledTimes(1);
    const installCommand = exec.mock.calls[0]?.[0];
    expect(installCommand).toContain("__NEXTSHELL_INTEGRATION_EOF__");
    expect(installCommand).toContain("# test script");
    expect(shell.written).toEqual([
      'source "$HOME/.cache/nextshell/nextshell-shell-integration.sh"\r'
    ]);
  });

  test("stays passive when the remote already emits OSC 133", async () => {
    const shell = createFakeShell();
    const scheduler = createManualScheduler();
    const exec = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));

    startShellIntegrationObserver({
      connection: { exec },
      shell,
      family: "zsh",
      isSessionActive: () => true,
      schedule: scheduler.schedule
    });

    shell.emitData(`${ESC}]133;A${BEL}prompt$ `);
    scheduler.fireAll();
    await flushMicrotasks();

    expect(exec).not.toHaveBeenCalled();
    expect(shell.written).toEqual([]);
    expect(scheduler.cancelled).toHaveLength(1);
  });

  test("stays passive when the remote already emits OSC 7", async () => {
    const shell = createFakeShell();
    const scheduler = createManualScheduler();
    const exec = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));

    startShellIntegrationObserver({
      connection: { exec },
      shell,
      family: "fish",
      isSessionActive: () => true,
      schedule: scheduler.schedule
    });

    shell.emitData(`${ESC}]7;file://host/home/user${BEL}`);
    scheduler.fireAll();
    await flushMicrotasks();

    expect(exec).not.toHaveBeenCalled();
    expect(shell.written).toEqual([]);
  });

  test("skips injection when the session is gone by the time the window expires", async () => {
    const shell = createFakeShell();
    const scheduler = createManualScheduler();
    const exec = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    let active = true;

    startShellIntegrationObserver({
      connection: { exec },
      shell,
      family: "bash",
      isSessionActive: () => active,
      schedule: scheduler.schedule
    });

    active = false;
    scheduler.fireAll();
    await flushMicrotasks();

    expect(exec).not.toHaveBeenCalled();
    expect(shell.written).toEqual([]);
  });

  test("does not write the source line when the install command fails", async () => {
    const shell = createFakeShell();
    const scheduler = createManualScheduler();
    const exec = vi.fn(async () => ({ stdout: "", stderr: "boom", exitCode: 1 }));
    const log = vi.fn();

    startShellIntegrationObserver({
      connection: { exec },
      shell,
      family: "bash",
      isSessionActive: () => true,
      schedule: scheduler.schedule,
      log
    });

    scheduler.fireAll();
    await flushMicrotasks();

    expect(exec).toHaveBeenCalledTimes(1);
    expect(shell.written).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
  });

  test("swallows exec rejections and only logs them", async () => {
    const shell = createFakeShell();
    const scheduler = createManualScheduler();
    const exec = vi.fn(async () => {
      throw new Error("channel closed");
    });
    const log = vi.fn();

    startShellIntegrationObserver({
      connection: { exec },
      shell,
      family: "bash",
      isSessionActive: () => true,
      schedule: scheduler.schedule,
      log
    });

    scheduler.fireAll();
    await flushMicrotasks();

    expect(shell.written).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
  });

  test("close before the window expires cancels the pending injection", async () => {
    const shell = createFakeShell();
    const scheduler = createManualScheduler();
    const exec = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));

    startShellIntegrationObserver({
      connection: { exec },
      shell,
      family: "bash",
      isSessionActive: () => true,
      schedule: scheduler.schedule
    });

    shell.emitClose();
    scheduler.fireAll();
    await flushMicrotasks();

    expect(exec).not.toHaveBeenCalled();
    expect(shell.written).toEqual([]);
    expect(scheduler.cancelled).toHaveLength(1);
  });
});
