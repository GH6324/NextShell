/**
 * Pure decision helpers for TerminalPane's session switching. They live outside
 * the component so the rapid-cycling and scroll-restore rules can be tested
 * without an xterm instance.
 */

/**
 * True while the user is still cycling tabs (the previous switch landed inside
 * `windowMs`), which is the signal to postpone the incoming session's replay
 * instead of parsing a backlog the user is about to leave behind.
 *
 * A first switch (`lastSwitchAt === undefined`) and a backwards clock both
 * answer "no": the fallback must be the zero-latency synchronous replay.
 */
export const shouldDeferReplay = (
  lastSwitchAt: number | undefined,
  now: number,
  windowMs: number
): boolean => {
  if (lastSwitchAt === undefined) {
    return false;
  }

  const elapsed = now - lastSwitchAt;
  if (elapsed < 0) {
    return false;
  }

  return elapsed < windowMs;
};

/**
 * How far up to scroll after a replay, given the distance from the bottom that
 * was recorded when the session was left.
 *
 * The replayed buffer is rarely the same height as the one the offset was taken
 * from (output kept arriving while the session was inactive, and the 2MB cap
 * can drop the oldest lines), so the stored distance is clamped to what the new
 * buffer actually has above the viewport — `viewportY` must stay >= 0.
 */
export const clampScrollLinesFromBottom = (linesFromBottom: number, baseY: number): number => {
  if (!Number.isFinite(linesFromBottom) || linesFromBottom <= 0 || baseY <= 0) {
    return 0;
  }

  return Math.min(Math.floor(linesFromBottom), baseY);
};
