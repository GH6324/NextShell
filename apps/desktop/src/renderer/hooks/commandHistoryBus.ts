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

// A command sent programmatically into the terminal (input bar submit, 命令库
// execute) is recorded right away, but the shell echoes it back as a full
// OSC 133 cycle moments later — without coordination one execution would be
// counted twice. Senders note the command here; the OSC tracker consumes the
// note at command-start (phase C) and skips its own push on a hit. Notes
// expire because a note that never meets its echo (shell without OSC 133,
// capture producing different text) must not swallow the same command
// genuinely typed in the terminal later.
interface PendingEcho {
  command: string;
  notedAt: number;
}

const ECHO_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_ECHOES_PER_SESSION = 20;
const pendingEchoesBySession = new Map<string, PendingEcho[]>();

export const recordSentCommand = (
  sessionId: string,
  command: string,
  now: number = Date.now()
): void => {
  const trimmed = command.trim();
  if (!trimmed) {
    return;
  }

  const queue = (pendingEchoesBySession.get(sessionId) ?? []).filter(
    (echo) => now - echo.notedAt <= ECHO_TTL_MS
  );
  queue.push({ command: trimmed, notedAt: now });
  if (queue.length > MAX_PENDING_ECHOES_PER_SESSION) {
    queue.splice(0, queue.length - MAX_PENDING_ECHOES_PER_SESSION);
  }
  pendingEchoesBySession.set(sessionId, queue);

  recordCommandHistoryEntry(trimmed);
};

export const consumeSentCommandEcho = (
  sessionId: string,
  command: string,
  now: number = Date.now()
): boolean => {
  const queue = pendingEchoesBySession.get(sessionId);
  if (!queue) {
    return false;
  }

  const fresh = queue.filter((echo) => now - echo.notedAt <= ECHO_TTL_MS);
  const index = fresh.findIndex((echo) => echo.command === command);
  if (index >= 0) {
    fresh.splice(index, 1);
  }

  if (fresh.length > 0) {
    pendingEchoesBySession.set(sessionId, fresh);
  } else {
    pendingEchoesBySession.delete(sessionId);
  }
  return index >= 0;
};
