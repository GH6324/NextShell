/**
 * System monitor probe cadence, mirrored from the main-process scheduler.
 *
 * Source of truth: `DEFAULT_POLL_INTERVAL_MS` in
 * `apps/desktop/src/main/services/monitor/system-monitor-controller.ts` — the
 * ticker that drives one network probe (and therefore one snapshot) per second.
 * The renderer cannot import main-process code, so keep the two in sync.
 */
export const SYSTEM_MONITOR_PROBE_INTERVAL_MS = 1_000;

/**
 * How old a cached snapshot may be before the panel marks it as not-live.
 *
 * Three probe intervals: one missed frame is normal (a slow probe makes the
 * controller skip a tick), three in a row means the stream really is not
 * flowing — either because we just switched back to a connection whose panel is
 * rendering from cache, or because the probe/hidden SSH is struggling.
 */
export const MONITOR_SNAPSHOT_STALE_AFTER_MS = SYSTEM_MONITOR_PROBE_INTERVAL_MS * 3;

const snapshotAgeMs = (capturedAt: string | undefined, nowMs: number): number | undefined => {
  if (!capturedAt) {
    return undefined;
  }
  const capturedMs = Date.parse(capturedAt);
  if (Number.isNaN(capturedMs)) {
    return undefined;
  }
  return nowMs - capturedMs;
};

/**
 * Is this snapshot too old to be presented as live data?
 *
 * An unparseable/absent timestamp counts as fresh on purpose: an unknown age
 * must not dim a panel forever, and it is the one case where dimming would
 * never be lifted by an arriving frame.
 */
export const isMonitorSnapshotStale = (
  capturedAt: string | undefined,
  nowMs: number,
  staleAfterMs: number = MONITOR_SNAPSHOT_STALE_AFTER_MS
): boolean => {
  const ageMs = snapshotAgeMs(capturedAt, nowMs);
  if (ageMs === undefined) {
    return false;
  }
  return ageMs >= staleAfterMs;
};

/**
 * Milliseconds until this snapshot turns stale, `0` when it already is (or when
 * its age is unknown).
 *
 * Staleness only ever flips once per snapshot, so the panel schedules exactly
 * one timer with this delay instead of polling the clock.
 */
export const msUntilMonitorSnapshotStale = (
  capturedAt: string | undefined,
  nowMs: number,
  staleAfterMs: number = MONITOR_SNAPSHOT_STALE_AFTER_MS
): number => {
  const ageMs = snapshotAgeMs(capturedAt, nowMs);
  if (ageMs === undefined) {
    return 0;
  }
  return Math.max(0, staleAfterMs - ageMs);
};
