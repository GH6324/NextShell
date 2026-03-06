import type { SshConnection } from "../../../../../../packages/ssh/src/index";

export class MonitorExecTimeoutError extends Error {
  constructor(message = "monitor exec timeout") {
    super(message);
    this.name = "MonitorExecTimeoutError";
  }
}

export interface TimedExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export const normalizeMonitorError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

export const runTimedExec = async (
  connection: SshConnection,
  command: string,
  timeoutMs: number
): Promise<TimedExecResult> => {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new MonitorExecTimeoutError()), timeoutMs);

  try {
    const result = await connection.exec(command, { signal: controller.signal });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    if (error instanceof MonitorExecTimeoutError) {
      throw error;
    }
    const reason = controller.signal.reason;
    if (reason instanceof MonitorExecTimeoutError) {
      throw reason;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};
