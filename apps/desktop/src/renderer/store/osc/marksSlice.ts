import type { StateCreator } from "zustand";

export interface CommandMark {
  id: string;
  promptLine?: number;
  commandText?: string;
  exitCode?: number;
  startedAt?: number;
  endedAt?: number;
}

/**
 * Marks accumulate for the whole life of a session (one per command), so the
 * list is capped: a long-lived shell would otherwise grow without bound, and
 * only recent commands are of any use to the UI.
 */
export const MAX_SESSION_COMMAND_MARKS = 500;

export interface SessionOscMarksSlice {
  marksBySession: Record<string, CommandMark[]>;
  setSessionMarks: (sessionId: string, marks: CommandMark[]) => void;
  clearSessionMarks: (sessionId: string) => void;
  appendSessionMark: (sessionId: string, mark: CommandMark) => void;
}

const omitSessionMarks = (
  marksBySession: Record<string, CommandMark[]>,
  sessionId: string
): Record<string, CommandMark[]> => {
  if (!(sessionId in marksBySession)) {
    return marksBySession;
  }

  const next = { ...marksBySession };
  delete next[sessionId];
  return next;
};

export const createSessionOscMarksSlice: StateCreator<SessionOscMarksSlice> = (set) => ({
  marksBySession: {},
  setSessionMarks: (sessionId, marks) =>
    set((state) => ({
      marksBySession: {
        ...state.marksBySession,
        [sessionId]: marks.slice(-MAX_SESSION_COMMAND_MARKS)
      }
    })),
  clearSessionMarks: (sessionId) =>
    set((state) => ({
      marksBySession: omitSessionMarks(state.marksBySession, sessionId)
    })),
  appendSessionMark: (sessionId, mark) =>
    set((state) => {
      const previous = state.marksBySession[sessionId] ?? [];
      const next = [...previous, mark];
      return {
        marksBySession: {
          ...state.marksBySession,
          [sessionId]:
            next.length > MAX_SESSION_COMMAND_MARKS
              ? next.slice(next.length - MAX_SESSION_COMMAND_MARKS)
              : next
        }
      };
    })
});
