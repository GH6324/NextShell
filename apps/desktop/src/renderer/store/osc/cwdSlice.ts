import type { StateCreator } from "zustand";

export interface SessionOscCwdSlice {
  cwdBySession: Record<string, string>;
  setSessionCwd: (sessionId: string, cwd?: string) => void;
}

const omitSessionCwd = (
  cwdBySession: Record<string, string>,
  sessionId: string
): Record<string, string> => {
  if (!(sessionId in cwdBySession)) {
    return cwdBySession;
  }

  const next = { ...cwdBySession };
  delete next[sessionId];
  return next;
};

export const createSessionOscCwdSlice: StateCreator<SessionOscCwdSlice> = (set) => ({
  cwdBySession: {},
  setSessionCwd: (sessionId, cwd) =>
    set((state) => {
      if (!cwd) {
        return {
          cwdBySession: omitSessionCwd(state.cwdBySession, sessionId)
        };
      }

      if (state.cwdBySession[sessionId] === cwd) {
        return {};
      }

      return {
        cwdBySession: { ...state.cwdBySession, [sessionId]: cwd }
      };
    })
});
