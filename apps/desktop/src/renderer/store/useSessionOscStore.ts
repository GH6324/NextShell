import { create } from "zustand";
import { createSessionOscCwdSlice, type SessionOscCwdSlice } from "./osc/cwdSlice";
import { createSessionOscTitleSlice, type SessionOscTitleSlice } from "./osc/titleSlice";
import { createSessionOscMarksSlice, type SessionOscMarksSlice } from "./osc/marksSlice";
import { createSessionOscProgressSlice, type SessionOscProgressSlice } from "./osc/progressSlice";
import { createSessionOscVarsSlice, type SessionOscVarsSlice } from "./osc/varsSlice";

export type { CommandMark } from "./osc/marksSlice";
export type { SessionProgress, SessionProgressState } from "./osc/progressSlice";

export interface SessionOscState
  extends
    SessionOscCwdSlice,
    SessionOscTitleSlice,
    SessionOscMarksSlice,
    SessionOscProgressSlice,
    SessionOscVarsSlice {
  pruneSessions: (validIds: ReadonlySet<string>) => void;
}

const pruneBySession = <T>(
  record: Record<string, T>,
  validIds: ReadonlySet<string>
): Record<string, T> => {
  let changed = false;
  const next: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (validIds.has(key)) {
      next[key] = value;
    } else {
      changed = true;
    }
  }

  return changed ? next : record;
};

export const useSessionOscStore = create<SessionOscState>()((set, get, store) => ({
  ...createSessionOscCwdSlice(set, get, store),
  ...createSessionOscTitleSlice(set, get, store),
  ...createSessionOscMarksSlice(set, get, store),
  ...createSessionOscProgressSlice(set, get, store),
  ...createSessionOscVarsSlice(set, get, store),
  pruneSessions: (validIds) =>
    set((state) => ({
      cwdBySession: pruneBySession(state.cwdBySession, validIds),
      titleBySession: pruneBySession(state.titleBySession, validIds),
      marksBySession: pruneBySession(state.marksBySession, validIds),
      progressBySession: pruneBySession(state.progressBySession, validIds),
      userVarsBySession: pruneBySession(state.userVarsBySession, validIds)
    }))
}));
