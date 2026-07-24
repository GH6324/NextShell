import type { StateCreator } from "zustand";

export interface SessionOscVarsSlice {
  userVarsBySession: Record<string, Record<string, string>>;
  setSessionUserVar: (sessionId: string, key: string, value: string) => void;
}

export const createSessionOscVarsSlice: StateCreator<SessionOscVarsSlice> = (set) => ({
  userVarsBySession: {},
  setSessionUserVar: (sessionId, key, value) =>
    set((state) => ({
      userVarsBySession: {
        ...state.userVarsBySession,
        [sessionId]: {
          ...(state.userVarsBySession[sessionId] ?? {}),
          [key]: value
        }
      }
    }))
});
