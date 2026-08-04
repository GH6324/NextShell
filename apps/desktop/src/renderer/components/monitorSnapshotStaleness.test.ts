import { describe, expect, test } from "vitest";
import {
  MONITOR_SNAPSHOT_STALE_AFTER_MS,
  SYSTEM_MONITOR_PROBE_INTERVAL_MS,
  isMonitorSnapshotStale,
  msUntilMonitorSnapshotStale
} from "./monitorSnapshotStaleness";

const now = Date.parse("2026-08-04T12:00:00.000Z");
const at = (offsetMs: number): string => new Date(now + offsetMs).toISOString();

describe("monitor snapshot staleness", () => {
  test("threshold is three probe intervals", () => {
    expect(MONITOR_SNAPSHOT_STALE_AFTER_MS).toBe(SYSTEM_MONITOR_PROBE_INTERVAL_MS * 3);
  });

  test("a just-arrived snapshot is fresh", () => {
    expect(isMonitorSnapshotStale(at(0), now)).toBe(false);
    expect(isMonitorSnapshotStale(at(-SYSTEM_MONITOR_PROBE_INTERVAL_MS), now)).toBe(false);
  });

  test("one missed frame is still fresh, three are not", () => {
    expect(isMonitorSnapshotStale(at(-2 * SYSTEM_MONITOR_PROBE_INTERVAL_MS), now)).toBe(false);
    expect(isMonitorSnapshotStale(at(-MONITOR_SNAPSHOT_STALE_AFTER_MS), now)).toBe(true);
    expect(isMonitorSnapshotStale(at(-60_000), now)).toBe(true);
  });

  test("countdown reaches zero exactly when the snapshot turns stale", () => {
    expect(msUntilMonitorSnapshotStale(at(0), now)).toBe(MONITOR_SNAPSHOT_STALE_AFTER_MS);
    expect(msUntilMonitorSnapshotStale(at(-1_000), now)).toBe(
      MONITOR_SNAPSHOT_STALE_AFTER_MS - 1_000
    );
    expect(msUntilMonitorSnapshotStale(at(-60_000), now)).toBe(0);
  });

  test("failure path: a missing or unparseable timestamp never dims the panel", () => {
    expect(isMonitorSnapshotStale(undefined, now)).toBe(false);
    expect(isMonitorSnapshotStale("not-a-date", now)).toBe(false);
    expect(msUntilMonitorSnapshotStale(undefined, now)).toBe(0);
    expect(msUntilMonitorSnapshotStale("not-a-date", now)).toBe(0);
  });

  test("a snapshot from a clock-skewed host is treated as fresh", () => {
    expect(isMonitorSnapshotStale(at(30_000), now)).toBe(false);
    expect(msUntilMonitorSnapshotStale(at(30_000), now)).toBe(
      MONITOR_SNAPSHOT_STALE_AFTER_MS + 30_000
    );
  });

  test("threshold is overridable for callers with a different cadence", () => {
    expect(isMonitorSnapshotStale(at(-5_000), now, 10_000)).toBe(false);
    expect(isMonitorSnapshotStale(at(-5_000), now, 4_000)).toBe(true);
  });
});
