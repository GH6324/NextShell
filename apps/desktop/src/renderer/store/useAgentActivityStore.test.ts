import { beforeEach, describe, expect, test } from "vitest";
import { useAgentActivityStore } from "./useAgentActivityStore";

const event = (id: string, status: "running" | "succeeded" | "failed" = "running") => ({
  id,
  clientName: "codex",
  tool: "exec",
  status,
  summary: `exec: ${status}`,
  createdAt: `2026-08-04T00:00:${id.padStart(2, "0")}Z`
});

describe("useAgentActivityStore", () => {
  beforeEach(() => useAgentActivityStore.setState({ activities: [] }));

  test("updates an in-flight activity in place", () => {
    useAgentActivityStore.getState().applyEvent(event("1"));
    useAgentActivityStore.getState().applyEvent(event("1", "succeeded"));
    expect(useAgentActivityStore.getState().activities).toEqual([event("1", "succeeded")]);
  });

  test("keeps running entries when clearing finished activity", () => {
    useAgentActivityStore.getState().applyEvent(event("1", "failed"));
    useAgentActivityStore.getState().applyEvent(event("2"));
    useAgentActivityStore.getState().clearFinished();
    expect(useAgentActivityStore.getState().activities.map((item) => item.id)).toEqual(["2"]);
  });
});
