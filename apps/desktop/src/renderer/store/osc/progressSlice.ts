import type { StateCreator } from "zustand";

export type SessionProgressState = "none" | "normal" | "error" | "indeterminate" | "paused";

export interface SessionProgress {
  state: SessionProgressState;
  value?: number;
}

export interface SessionOscProgressSlice {
  progressBySession: Record<string, SessionProgress>;
  setSessionProgress: (sessionId: string, progress?: SessionProgress) => void;
}

const omitSessionProgress = (
  progressBySession: Record<string, SessionProgress>,
  sessionId: string
): Record<string, SessionProgress> => {
  if (!(sessionId in progressBySession)) {
    return progressBySession;
  }

  const next = { ...progressBySession };
  delete next[sessionId];
  return next;
};

export const createSessionOscProgressSlice: StateCreator<SessionOscProgressSlice> = (set) => ({
  progressBySession: {},
  setSessionProgress: (sessionId, progress) =>
    set((state) => {
      if (!progress) {
        return {
          progressBySession: omitSessionProgress(state.progressBySession, sessionId)
        };
      }

      return {
        progressBySession: { ...state.progressBySession, [sessionId]: progress }
      };
    })
});
