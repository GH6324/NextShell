import { create } from "zustand";
import type { AgentActivityEvent } from "@nextshell/shared";

const MAX_AGENT_ACTIVITIES = 100;

interface AgentActivityState {
  activities: AgentActivityEvent[];
  applyEvent: (event: AgentActivityEvent) => void;
  clearFinished: () => void;
}

export const useAgentActivityStore = create<AgentActivityState>((set) => ({
  activities: [],
  applyEvent: (event) =>
    set((state) => {
      const existing = state.activities.findIndex((item) => item.id === event.id);
      const next = [...state.activities];
      if (existing >= 0) next[existing] = event;
      else next.unshift(event);
      next.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      return { activities: next.slice(0, MAX_AGENT_ACTIVITIES) };
    }),
  clearFinished: () =>
    set((state) => ({
      activities: state.activities.filter((activity) => activity.status === "running")
    }))
}));
