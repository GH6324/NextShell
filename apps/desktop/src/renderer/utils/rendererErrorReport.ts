import type { RendererErrorReportInput } from "@nextshell/shared";

const MAX_MESSAGE_LENGTH = 2000;
const MAX_STACK_LENGTH = 8000;
/**
 * Hard cap per renderer lifetime: an error firing once per render/frame would
 * otherwise turn a single bug into an IPC flood and a runaway log file. The
 * first occurrences carry all the diagnostic value.
 */
const MAX_REPORTS_PER_LIFETIME = 30;

let reportedCount = 0;

/** Test seam — reports are capped per renderer lifetime, not per test. */
export const resetRendererErrorReportBudget = (): void => {
  reportedCount = 0;
};

const safeString = (value: unknown): string => {
  try {
    return String(value);
  } catch {
    // e.g. a thrown Symbol, or an object whose toString itself throws.
    return "[unserializable error value]";
  }
};

/**
 * Normalize an arbitrary thrown value into the IPC report shape, or undefined
 * when there is nothing worth reporting (empty message).
 */
export const buildRendererErrorReport = (
  source: RendererErrorReportInput["source"],
  error: unknown,
  componentStack?: string
): RendererErrorReportInput | undefined => {
  const normalized = error instanceof Error ? error : undefined;
  const message = (normalized?.message ?? safeString(error ?? "")).trim();
  if (!message) {
    return undefined;
  }

  const report: RendererErrorReportInput = {
    source,
    message: message.slice(0, MAX_MESSAGE_LENGTH)
  };
  const stack = normalized?.stack?.trim();
  if (stack) {
    report.stack = stack.slice(0, MAX_STACK_LENGTH);
  }
  const trimmedComponentStack = componentStack?.trim();
  if (trimmedComponentStack) {
    report.componentStack = trimmedComponentStack.slice(0, MAX_STACK_LENGTH);
  }
  return report;
};

/**
 * Forward a renderer error into the main-process log file. Console output is
 * the primary record during development; this is what survives in packaged
 * builds where the renderer console is invisible. Must never throw — it runs
 * inside error handlers — so a missing bridge (tests, browser-mock rigs) or a
 * failed invoke is swallowed.
 */
export const reportRendererError = (
  source: RendererErrorReportInput["source"],
  error: unknown,
  componentStack?: string
): void => {
  if (reportedCount >= MAX_REPORTS_PER_LIFETIME) {
    return;
  }

  const report = buildRendererErrorReport(source, error, componentStack);
  if (!report) {
    return;
  }

  reportedCount += 1;
  try {
    void window.nextshell.debug.reportRendererError(report).catch(() => undefined);
  } catch {
    // window/bridge unavailable — the console.error alongside already has it.
  }
};
