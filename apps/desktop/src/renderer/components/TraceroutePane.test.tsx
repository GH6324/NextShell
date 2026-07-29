import { describe, expect, test } from "vitest";
import { isEventForRun } from "./TraceroutePane";

describe("isEventForRun", () => {
  test("accepts events produced by the run the pane owns", () => {
    expect(
      isEventForRun({ host: "10.0.0.1", runId: "run-a" }, { host: "10.0.0.1", runId: "run-a" })
    ).toBe(true);
  });

  test("rejects events from another host's trace", () => {
    expect(
      isEventForRun({ host: "10.0.0.2", runId: "run-a" }, { host: "10.0.0.1", runId: "run-a" })
    ).toBe(false);
  });

  test("rejects stale events from an earlier run of the same host", () => {
    expect(
      isEventForRun({ host: "10.0.0.1", runId: "run-a" }, { host: "10.0.0.1", runId: "run-b" })
    ).toBe(false);
  });

  test("rejects every event when the pane owns no run", () => {
    expect(isEventForRun({ host: "10.0.0.1", runId: "run-a" }, null)).toBe(false);
  });
});
