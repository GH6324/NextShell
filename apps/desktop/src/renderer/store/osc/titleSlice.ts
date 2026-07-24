import type { StateCreator } from "zustand";

export interface SessionOscTitleSlice {
  titleBySession: Record<string, string>;
  setSessionTitle: (sessionId: string, title?: string) => void;
}

const omitSessionTitle = (
  titleBySession: Record<string, string>,
  sessionId: string
): Record<string, string> => {
  if (!(sessionId in titleBySession)) {
    return titleBySession;
  }

  const next = { ...titleBySession };
  delete next[sessionId];
  return next;
};

export const createSessionOscTitleSlice: StateCreator<SessionOscTitleSlice> = (set) => ({
  titleBySession: {},
  setSessionTitle: (sessionId, title) =>
    set((state) => {
      if (!title) {
        return {
          titleBySession: omitSessionTitle(state.titleBySession, sessionId)
        };
      }

      if (state.titleBySession[sessionId] === title) {
        return {};
      }

      return {
        titleBySession: { ...state.titleBySession, [sessionId]: title }
      };
    })
});
