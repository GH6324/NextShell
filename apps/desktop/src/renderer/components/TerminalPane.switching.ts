/**
 * Pure decision helpers for TerminalPane's session switching. They live outside
 * the component so the scroll-restore rules can be tested without an xterm
 * instance.
 */

/**
 * Whether the outgoing session's viewport position may be recorded, given which
 * session the shared xterm buffer is actually showing right now.
 *
 * A replay is queued behind the pending writes (`runLatestScreenChange` /
 * `runAfterPendingWrites`), so a switch A→B→C that happens before B's replay
 * reaches the front of the queue supersedes it: B never repaints, and when the
 * switch away from B runs the buffer still holds A's content. Snapshotting then
 * would file A's viewport under B and dump the user somewhere they never
 * scrolled to. Only the session whose content is on screen may write a snapshot
 * — an unpainted (`undefined`) buffer belongs to nobody.
 */
export const shouldRememberSessionScroll = (
  outgoingSessionId: string,
  displayedSessionId: string | undefined
): boolean => displayedSessionId !== undefined && displayedSessionId === outgoingSessionId;

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
