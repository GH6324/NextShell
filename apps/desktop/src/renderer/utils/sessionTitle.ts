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
  fallback?: SessionTitleFallback
): string => {
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

export const formatSessionTitle = (baseTitle: string, _index: number): string => {
  const normalizedBaseTitle = baseTitle.trim() || "session";
  return normalizedBaseTitle;
};
