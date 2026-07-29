import type { SessionStatus } from "@nextshell/core";

interface SessionTitleFallback {
  name?: string;
  host?: string;
}

export const claimNextSessionIndex = (
  counters: Map<string, number>,
  connectionId: string
): number => {
  const next = (counters.get(connectionId) ?? 0) + 1;
  counters.set(connectionId, next);
  return next;
};

export const resolveSessionBaseTitle = (
  sessionTitle: string | undefined,
  fallback?: SessionTitleFallback,
  oscTitle?: string
): string => {
  const explicitOscTitle = oscTitle?.trim();
  if (explicitOscTitle) {
    return explicitOscTitle;
  }

  const connectionName = fallback?.name?.trim();
  if (connectionName) {
    return connectionName;
  }

  const connectionHost = fallback?.host?.trim();
  if (connectionHost) {
    return connectionHost;
  }

  const title = sessionTitle?.trim();
  if (title) {
    return title;
  }

  return "session";
};

/**
 * An OSC-provided title only reflects reality while the session is live; once
 * it disconnects or fails, displays must fall back to the connection-derived
 * title (the stale store entry is pruned when the session is removed).
 */
export const isOscTitleEligibleStatus = (status: SessionStatus): boolean =>
  status === "connected" || status === "connecting";

/**
 * The first tab for a connection keeps the bare title; every additional tab on
 * the same connection is suffixed with its claimed index so multiple sessions
 * against one server stay tellable apart.
 */
export const formatSessionTitle = (baseTitle: string, index: number): string => {
  const normalizedBaseTitle = baseTitle.trim() || "session";
  if (!Number.isFinite(index)) {
    return normalizedBaseTitle;
  }

  const normalizedIndex = Math.floor(index);
  if (normalizedIndex <= 1) {
    return normalizedBaseTitle;
  }

  return `${normalizedBaseTitle} (${normalizedIndex})`;
};
