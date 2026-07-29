import { AUTH_REQUIRED_PREFIX } from "@nextshell/shared";
import { formatErrorMessage } from "../utils/errorMessage";

export interface NormalizedOpenError {
  reason: string;
  authRequired: boolean;
}

export const extractAuthRequiredReason = (reason: string): string | undefined => {
  const index = reason.indexOf(AUTH_REQUIRED_PREFIX);
  if (index < 0) {
    return undefined;
  }
  return reason.slice(index);
};

export const normalizeOpenError = (
  error: unknown,
  fallback = "打开 SSH 会话失败"
): NormalizedOpenError => {
  const rawReason = formatErrorMessage(error, fallback);
  const authReason = extractAuthRequiredReason(rawReason);
  return {
    reason: authReason ?? rawReason,
    authRequired: authReason !== undefined
  };
};

/**
 * How long a second `startSession` for the same connection is treated as the
 * echo of a double-click instead of a deliberate second tab. Roughly the
 * platform double-click threshold — long enough to swallow a stutter click,
 * short enough that clicking "connect" twice on purpose still opens two tabs.
 */
export const DOUBLE_START_COALESCE_MS = 400;

export interface RecentSessionStart<T> {
  at: number;
  promise: T;
}

/**
 * The open a repeat click should join, or undefined when it must open its own
 * tab. Connect affordances carry no in-flight state, so without this a
 * double-click opens two tabs and burns two SSH channels on one host.
 */
export const resolveCoalescedStart = <T>(
  recentStart: RecentSessionStart<T> | undefined,
  now: number,
  windowMs = DOUBLE_START_COALESCE_MS
): T | undefined => {
  if (!recentStart) {
    return undefined;
  }
  const elapsed = now - recentStart.at;
  // A clock that went backwards (NTP step) must not coalesce forever.
  if (elapsed < 0 || elapsed >= windowMs) {
    return undefined;
  }
  return recentStart.promise;
};

export const isSessionGenerationCurrent = (
  generationBySession: Map<string, number>,
  cancelledSessionIds: Set<string>,
  sessionId: string,
  generation: number
): boolean => {
  if (cancelledSessionIds.has(sessionId)) {
    return false;
  }
  return (generationBySession.get(sessionId) ?? 0) === generation;
};
