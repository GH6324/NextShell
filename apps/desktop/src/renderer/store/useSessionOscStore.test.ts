import { beforeEach, describe, expect, test } from "vitest";
import { useSessionOscStore } from "./useSessionOscStore";

const resetStore = (): void => {
  useSessionOscStore.setState({
    cwdBySession: {},
    titleBySession: {},
    marksBySession: {},
    progressBySession: {},
    userVarsBySession: {}
  });
};

describe("useSessionOscStore", () => {
  beforeEach(resetStore);

  test("setSessionCwd stores, no-ops on the same value, and clears on empty", () => {
    const store = useSessionOscStore.getState();
    store.setSessionCwd("s1", "/home/user");
    expect(useSessionOscStore.getState().cwdBySession["s1"]).toBe("/home/user");

    const before = useSessionOscStore.getState().cwdBySession;
    store.setSessionCwd("s1", "/home/user");
    expect(useSessionOscStore.getState().cwdBySession).toBe(before);

    store.setSessionCwd("s1", "/tmp");
    expect(useSessionOscStore.getState().cwdBySession["s1"]).toBe("/tmp");

    store.setSessionCwd("s1", undefined);
    expect("s1" in useSessionOscStore.getState().cwdBySession).toBe(false);
  });

  test("setSessionTitle mirrors the cwd semantics", () => {
    const store = useSessionOscStore.getState();
    store.setSessionTitle("s1", "vim");
    expect(useSessionOscStore.getState().titleBySession["s1"]).toBe("vim");

    const before = useSessionOscStore.getState().titleBySession;
    store.setSessionTitle("s1", "vim");
    expect(useSessionOscStore.getState().titleBySession).toBe(before);

    store.setSessionTitle("s1", undefined);
    expect("s1" in useSessionOscStore.getState().titleBySession).toBe(false);
  });

  test("appends, replaces, and clears command marks", () => {
    const store = useSessionOscStore.getState();
    store.appendSessionMark("s1", { id: "m1", promptLine: 3 });
    store.appendSessionMark("s1", { id: "m2", exitCode: 1 });
    expect(useSessionOscStore.getState().marksBySession["s1"]?.map((mark) => mark.id)).toEqual([
      "m1",
      "m2"
    ]);

    store.setSessionMarks("s1", [{ id: "m3" }]);
    expect(useSessionOscStore.getState().marksBySession["s1"]?.map((mark) => mark.id)).toEqual([
      "m3"
    ]);

    store.clearSessionMarks("s1");
    expect("s1" in useSessionOscStore.getState().marksBySession).toBe(false);
  });

  test("setSessionProgress sets and clears progress", () => {
    const store = useSessionOscStore.getState();
    store.setSessionProgress("s1", { state: "normal", value: 40 });
    expect(useSessionOscStore.getState().progressBySession["s1"]).toEqual({
      state: "normal",
      value: 40
    });

    store.setSessionProgress("s1", undefined);
    expect("s1" in useSessionOscStore.getState().progressBySession).toBe(false);
  });

  test("setSessionUserVar stores vars per session", () => {
    const store = useSessionOscStore.getState();
    store.setSessionUserVar("s1", "iterm2_hostname", "example");
    store.setSessionUserVar("s1", "iterm2_user", "root");
    expect(useSessionOscStore.getState().userVarsBySession["s1"]).toEqual({
      iterm2_hostname: "example",
      iterm2_user: "root"
    });
  });

  test("pruneSessions drops stale keys from every map", () => {
    const store = useSessionOscStore.getState();
    store.setSessionCwd("s1", "/a");
    store.setSessionCwd("s2", "/b");
    store.setSessionTitle("s2", "title");
    store.appendSessionMark("s2", { id: "m1" });
    store.setSessionProgress("s2", { state: "normal", value: 50 });
    store.setSessionUserVar("s2", "key", "value");

    store.pruneSessions(new Set(["s1"]));

    const state = useSessionOscStore.getState();
    expect(state.cwdBySession["s1"]).toBe("/a");
    expect("s2" in state.cwdBySession).toBe(false);
    expect("s2" in state.titleBySession).toBe(false);
    expect("s2" in state.marksBySession).toBe(false);
    expect("s2" in state.progressBySession).toBe(false);
    expect("s2" in state.userVarsBySession).toBe(false);
  });
});
