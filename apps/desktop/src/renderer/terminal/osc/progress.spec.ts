import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import type { SessionDescriptor } from "@nextshell/core";
import type { OscRuntimeContext } from "../oscRuntime";
import { useSessionOscStore } from "../../store/useSessionOscStore";
import { useWorkspaceStore } from "../../store/useWorkspaceStore";
import { install, parseConEmuProgress } from "./progress";

describe("parseConEmuProgress", () => {
  test("parses state 0 as none without a value", () => {
    expect(parseConEmuProgress("4;0;0")).toEqual({ state: "none" });
  });

  test("parses state 1 as normal with a clamped value", () => {
    expect(parseConEmuProgress("4;1;42")).toEqual({ state: "normal", value: 42 });
    expect(parseConEmuProgress("4;1;-5")).toEqual({ state: "normal", value: 0 });
    expect(parseConEmuProgress("4;1;250")).toEqual({ state: "normal", value: 100 });
  });

  test("parses state 2 as error with a value", () => {
    expect(parseConEmuProgress("4;2;77")).toEqual({ state: "error", value: 77 });
  });

  test("parses state 3 as indeterminate without a value", () => {
    expect(parseConEmuProgress("4;3;0")).toEqual({ state: "indeterminate" });
  });

  test("parses state 4 as paused with a value", () => {
    expect(parseConEmuProgress("4;4;55")).toEqual({ state: "paused", value: 55 });
  });

  test("rejects payloads without the 4 prefix", () => {
    expect(parseConEmuProgress("9;1;50")).toBeUndefined();
    expect(parseConEmuProgress("hello")).toBeUndefined();
  });

  test("rejects missing or unknown states", () => {
    expect(parseConEmuProgress("4")).toBeUndefined();
    expect(parseConEmuProgress("4;")).toBeUndefined();
    expect(parseConEmuProgress("4;5;10")).toBeUndefined();
    expect(parseConEmuProgress("4;1.5;10")).toBeUndefined();
    expect(parseConEmuProgress("4;x;10")).toBeUndefined();
  });

  test("rejects value states without a numeric value", () => {
    expect(parseConEmuProgress("4;1")).toBeUndefined();
    expect(parseConEmuProgress("4;1;")).toBeUndefined();
    expect(parseConEmuProgress("4;2;abc")).toBeUndefined();
    expect(parseConEmuProgress("4;4;Infinity")).toBeUndefined();
  });
});

const createSession = (id: string): SessionDescriptor => ({
  id,
  target: "remote",
  connectionId: "c1",
  title: `${id}#1`,
  type: "terminal",
  status: "connected",
  createdAt: "2026-01-01T00:00:00.000Z",
  reconnectable: true
});

describe("install window progress ownership", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ sessions: [], activeSessionId: undefined });
    useSessionOscStore.setState({
      cwdBySession: {},
      titleBySession: {},
      marksBySession: {},
      progressBySession: {},
      userVarsBySession: {}
    });
  });

  test("clears the bar through the previous owner when the last session closes", () => {
    const setProgress = vi.fn(() => Promise.resolve({ ok: true }));
    vi.stubGlobal("window", { nextshell: { terminal: { setProgress } } });

    const dispose = install({} as Terminal, {} as OscRuntimeContext);
    try {
      useWorkspaceStore.getState().upsertSession(createSession("s1"));
      useWorkspaceStore.getState().setActiveSession("s1");
      useSessionOscStore.getState().setSessionProgress("s1", { state: "normal", value: 50 });
      setProgress.mockClear();

      useWorkspaceStore.getState().removeSession("s1");

      expect(setProgress).toHaveBeenCalledWith({ sessionId: "s1", state: "none" });
    } finally {
      dispose();
    }
  });

  test("re-applies stored progress when switching sessions", () => {
    const setProgress = vi.fn(() => Promise.resolve({ ok: true }));
    vi.stubGlobal("window", { nextshell: { terminal: { setProgress } } });

    const dispose = install({} as Terminal, {} as OscRuntimeContext);
    try {
      useWorkspaceStore.getState().upsertSession(createSession("s1"));
      useWorkspaceStore.getState().upsertSession(createSession("s2"));
      useWorkspaceStore.getState().setActiveSession("s1");
      useSessionOscStore.getState().setSessionProgress("s2", { state: "error", value: 80 });
      setProgress.mockClear();

      useWorkspaceStore.getState().setActiveSession("s2");
      expect(setProgress).toHaveBeenCalledWith({ sessionId: "s2", state: "error", value: 80 });

      useWorkspaceStore.getState().setActiveSession("s1");
      expect(setProgress).toHaveBeenCalledWith({ sessionId: "s1", state: "none" });
    } finally {
      dispose();
    }
  });
});
