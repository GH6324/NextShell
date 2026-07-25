type CommandHistoryListener = (command: string) => void;

const listeners = new Set<CommandHistoryListener>();

/**
 * Single entry point for "a command was executed". Two very different sources
 * feed it — the command input bar and OSC 133 shell integration marks parsed
 * out of the terminal stream — and both must land in the same place: the
 * SQLite history *and* the in-memory list the UI renders. Without this bus a
 * command typed directly in the terminal would only be persisted, staying
 * invisible in the history dropdown until the next app start.
 */
export const recordCommandHistoryEntry = (command: string): void => {
  const trimmed = command.trim();
  if (!trimmed) {
    return;
  }

  // Snapshot: a listener may unsubscribe while we are iterating.
  for (const listener of [...listeners]) {
    listener(trimmed);
  }

  // Fire-and-forget: the optimistic UI update already happened above, and the
  // main process owns dedupe/use-count. A failed write self-heals on reload.
  void window.nextshell.commandHistory.push({ command: trimmed }).catch(() => undefined);
};

export const subscribeCommandHistory = (listener: CommandHistoryListener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
