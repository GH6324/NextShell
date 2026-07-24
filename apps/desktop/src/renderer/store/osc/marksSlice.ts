import type { StateCreator } from "zustand";

export interface CommandMark {
  id: string;
  promptLine?: number;
  commandText?: string;
  exitCode?: number;
  startedAt?: number;
  endedAt?: number;
}

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
      marksBySession: { ...state.marksBySession, [sessionId]: marks }
    })),
  clearSessionMarks: (sessionId) =>
    set((state) => ({
      marksBySession: omitSessionMarks(state.marksBySession, sessionId)
    })),
  appendSessionMark: (sessionId, mark) =>
    set((state) => ({
      marksBySession: {
        ...state.marksBySession,
        [sessionId]: [...(state.marksBySession[sessionId] ?? []), mark]
      }
    }))
});
