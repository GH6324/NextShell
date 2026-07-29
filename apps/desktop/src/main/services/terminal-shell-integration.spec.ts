import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  forgetShellIntegrationInstalls,
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

describe("startShellIntegrationObserver", () => {
  beforeEach(() => {
    // The install guard is module state shared by every session.
    forgetShellIntegrationInstalls();
  });

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
    expect(installCommand?.startsWith("/bin/sh -c '")).toBe(true);
    expect(installCommand).toContain("__NEXTSHELL_INTEGRATION_EOF__");
    expect(installCommand).toContain("# test script");
    expect(installCommand).toContain("nextshell-shell-integration.bash");
    expect(shell.written).toEqual([
      '. "$HOME/.cache/nextshell/nextshell-shell-integration.bash"\r'
    ]);
  });

  test("awaits a pending family probe instead of blocking session startup", async () => {
    const shell = createFakeShell();
    const scheduler = createManualScheduler();
    const exec = vi.fn(async (_command: string) => ({ stdout: "", stderr: "", exitCode: 0 }));

    startShellIntegrationObserver({
      connection: { exec },
      shell,
      family: Promise.resolve("fish" as const),
      isSessionActive: () => true,
      schedule: scheduler.schedule,
      scriptText: "# fish\n"
    });

    scheduler.fireAll();
    await flushMicrotasks();

    expect(exec.mock.calls[0]?.[0]).toContain("nextshell-shell-integration.fish");
    expect(shell.written).toEqual([
      'source "$HOME/.cache/nextshell/nextshell-shell-integration.fish"\r'
    ]);
  });

  test("skips injection when the probe never resolved to a supported family", async () => {
    const shell = createFakeShell();
    const scheduler = createManualScheduler();
    const exec = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));

    startShellIntegrationObserver({
      connection: { exec },
      shell,
      family: Promise.resolve(undefined),
      isSessionActive: () => true,
      schedule: scheduler.schedule
    });

    scheduler.fireAll();
    await flushMicrotasks();

    expect(exec).not.toHaveBeenCalled();
    expect(shell.written).toEqual([]);
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

  test("detects a marker split across two chunks", async () => {
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

    // The IPC stream dispatcher slices on byte windows, so a sequence can
    // straddle two reads.
    shell.emitData(`output${ESC}]13`);
    shell.emitData(`3;A${BEL}prompt$ `);
    scheduler.fireAll();
    await flushMicrotasks();

    expect(exec).not.toHaveBeenCalled();
    expect(shell.written).toEqual([]);
  });

  test("does not treat plain text that looks like a marker as integration", async () => {
    const shell = createFakeShell();
    const scheduler = createManualScheduler();
    const exec = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));

    startShellIntegrationObserver({
      connection: { exec },
      shell,
      family: "bash",
      isSessionActive: () => true,
      schedule: scheduler.schedule,
      scriptText: "# test\n"
    });

    shell.emitData("see ]133; in this log line");
    scheduler.fireAll();
    await flushMicrotasks();

    expect(exec).toHaveBeenCalledTimes(1);
  });

  test("skips injection once the user has typed into the session", async () => {
    const shell = createFakeShell();
    const scheduler = createManualScheduler();
    const exec = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const log = vi.fn();

    startShellIntegrationObserver({
      connection: { exec },
      shell,
      family: "bash",
      isSessionActive: () => true,
      hasUserInput: () => true,
      schedule: scheduler.schedule,
      log
    });

    scheduler.fireAll();
    await flushMicrotasks();

    // Writing the source line now would splice into the half-typed command.
    expect(exec).not.toHaveBeenCalled();
    expect(shell.written).toEqual([]);
    expect(log).toHaveBeenCalled();
  });

  test("skips the source line when the user starts typing during the install", async () => {
    const shell = createFakeShell();
    const scheduler = createManualScheduler();
    let typed = false;
    const exec = vi.fn(async () => {
      typed = true;
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    startShellIntegrationObserver({
      connection: { exec },
      shell,
      family: "bash",
      isSessionActive: () => true,
      hasUserInput: () => typed,
      schedule: scheduler.schedule,
      scriptText: "# test\n"
    });

    scheduler.fireAll();
    await flushMicrotasks();

    expect(exec).toHaveBeenCalledTimes(1);
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

  test("installs once for two sessions sharing a connection, but injects into both", async () => {
    // Both tabs leave the observation window within milliseconds of each other.
    // Two installs would mean one tab rewriting the script file while the other
    // tab's shell is already sourcing it.
    const shells = [createFakeShell(), createFakeShell()];
    const scheduler = createManualScheduler();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const exec = vi.fn(async () => {
      await gate;
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const connection = { exec };

    for (const shell of shells) {
      startShellIntegrationObserver({
        connection,
        shell,
        connectionId: "conn-1",
        family: "bash",
        isSessionActive: () => true,
        schedule: scheduler.schedule,
        scriptText: "# test\n"
      });
    }

    scheduler.fireAll();
    await flushMicrotasks();
    release();
    await flushMicrotasks();

    expect(exec).toHaveBeenCalledTimes(1);
    for (const shell of shells) {
      expect(shell.written).toEqual([
        '. "$HOME/.cache/nextshell/nextshell-shell-integration.bash"\r'
      ]);
    }
  });

  test("a session opened after the install skips the install and only injects", async () => {
    const scheduler = createManualScheduler();
    const exec = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const connection = { exec };

    const openSession = async (): Promise<FakeShell> => {
      const shell = createFakeShell();
      startShellIntegrationObserver({
        connection,
        shell,
        connectionId: "conn-1",
        family: "zsh",
        isSessionActive: () => true,
        schedule: scheduler.schedule,
        scriptText: "# test\n"
      });
      scheduler.fireAll();
      await flushMicrotasks();
      return shell;
    };

    await openSession();
    const second = await openSession();

    expect(exec).toHaveBeenCalledTimes(1);
    expect(second.written).toEqual([
      '. "$HOME/.cache/nextshell/nextshell-shell-integration.zsh"\r'
    ]);
  });

  test("a failed install is not remembered — the next session retries it", async () => {
    const scheduler = createManualScheduler();
    let exitCode = 1;
    const exec = vi.fn(async () => ({ stdout: "", stderr: "", exitCode }));
    const connection = { exec };

    const openSession = async (): Promise<FakeShell> => {
      const shell = createFakeShell();
      startShellIntegrationObserver({
        connection,
        shell,
        connectionId: "conn-1",
        family: "bash",
        isSessionActive: () => true,
        schedule: scheduler.schedule,
        scriptText: "# test\n"
      });
      scheduler.fireAll();
      await flushMicrotasks();
      return shell;
    };

    const first = await openSession();
    expect(first.written).toEqual([]);

    exitCode = 0;
    const second = await openSession();

    expect(exec).toHaveBeenCalledTimes(2);
    expect(second.written).toEqual([
      '. "$HOME/.cache/nextshell/nextshell-shell-integration.bash"\r'
    ]);
  });

  test("different connections each get their own install", async () => {
    const scheduler = createManualScheduler();
    const exec = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));

    for (const connectionId of ["conn-1", "conn-2"]) {
      startShellIntegrationObserver({
        connection: { exec },
        shell: createFakeShell(),
        connectionId,
        family: "bash",
        isSessionActive: () => true,
        schedule: scheduler.schedule,
        scriptText: "# test\n"
      });
    }

    scheduler.fireAll();
    await flushMicrotasks();

    expect(exec).toHaveBeenCalledTimes(2);
  });

  test("falls back to the connection object when no connectionId is given", async () => {
    const scheduler = createManualScheduler();
    const exec = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const connection = { exec };

    for (let index = 0; index < 2; index += 1) {
      startShellIntegrationObserver({
        connection,
        shell: createFakeShell(),
        family: "bash",
        isSessionActive: () => true,
        schedule: scheduler.schedule,
        scriptText: "# test\n"
      });
    }

    scheduler.fireAll();
    await flushMicrotasks();

    expect(exec).toHaveBeenCalledTimes(1);
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
