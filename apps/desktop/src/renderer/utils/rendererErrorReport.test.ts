import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  buildRendererErrorReport,
  reportRendererError,
  resetRendererErrorReportBudget
} from "./rendererErrorReport";

describe("buildRendererErrorReport", () => {
  test("normalizes an Error with message and stack", () => {
    const error = new Error("boom");
    const report = buildRendererErrorReport("window-error", error);
    expect(report).toMatchObject({ source: "window-error", message: "boom" });
    expect(report?.stack).toContain("boom");
    expect(report?.componentStack).toBeUndefined();
  });

  test("stringifies non-Error values and drops empty ones", () => {
    expect(buildRendererErrorReport("unhandled-rejection", "plain string")).toMatchObject({
      message: "plain string"
    });
    expect(buildRendererErrorReport("unhandled-rejection", "   ")).toBeUndefined();
    expect(buildRendererErrorReport("unhandled-rejection", undefined)).toBeUndefined();
    // A value whose own toString throws must not take the reporter down.
    const hostile = {
      toString() {
        throw new Error("toString bomb");
      }
    };
    expect(buildRendererErrorReport("unhandled-rejection", hostile)).toMatchObject({
      message: "[unserializable error value]"
    });
  });

  test("caps message and stack lengths", () => {
    const error = new Error("m".repeat(5000));
    error.stack = "s".repeat(20000);
    const report = buildRendererErrorReport("react-error-boundary", error, "c".repeat(20000));
    expect(report?.message.length).toBe(2000);
    expect(report?.stack?.length).toBe(8000);
    expect(report?.componentStack?.length).toBe(8000);
  });
});

describe("reportRendererError", () => {
  const reportSpy = vi.fn(() => Promise.resolve({ ok: true as const }));

  beforeEach(() => {
    resetRendererErrorReportBudget();
    reportSpy.mockClear();
    vi.stubGlobal("window", {
      nextshell: { debug: { reportRendererError: reportSpy } }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("forwards through the bridge", () => {
    reportRendererError("window-error", new Error("boom"));
    expect(reportSpy).toHaveBeenCalledTimes(1);
    expect(reportSpy).toHaveBeenCalledWith(
      expect.objectContaining({ source: "window-error", message: "boom" })
    );
  });

  test("stops after the per-lifetime budget", () => {
    for (let index = 0; index < 40; index += 1) {
      reportRendererError("window-error", new Error(`boom ${index}`));
    }
    expect(reportSpy).toHaveBeenCalledTimes(30);
  });

  test("never throws when the bridge is missing or rejects", () => {
    vi.stubGlobal("window", {});
    expect(() => reportRendererError("window-error", new Error("no bridge"))).not.toThrow();

    vi.stubGlobal("window", {
      nextshell: { debug: { reportRendererError: () => Promise.reject(new Error("ipc down")) } }
    });
    expect(() => reportRendererError("window-error", new Error("rejected"))).not.toThrow();
  });
});
