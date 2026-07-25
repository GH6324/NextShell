import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import type { SessionDescriptor } from "@nextshell/core";
import { installOscRuntime, type OscRuntimeContext, type OscRuntimeModule } from "./oscRuntime";
import { useSessionOscStore } from "../store/useSessionOscStore";
import { useWorkspaceStore } from "../store/useWorkspaceStore";

type OscHandler = (data: string) => boolean | Promise<boolean>;

const createMockTerminal = () => {
  const oscHandlers = new Map<number, OscHandler>();
  const titleListeners = new Set<(title: string) => void>();
  const terminal = {
    parser: {
      registerOscHandler(ident: number, callback: OscHandler) {
        oscHandlers.set(ident, callback);
        return {
          dispose: () => {
            oscHandlers.delete(ident);
          }
        };
      }
    },
    // hyperlink module assigns `options.linkHandler`; title module subscribes
    // `onTitleChange` — both run at install time with the default module set.
    options: {} as Record<string, unknown>,
    onTitleChange(listener: (title: string) => void) {
      titleListeners.add(listener);
      return {
        dispose: () => {
          titleListeners.delete(listener);
        }
      };
    }
  } as unknown as Terminal;

  return { terminal, oscHandlers };
};

// The notify module subscribes `window.nextshell.terminal.onNotificationAction`
// at install time; vitest runs in a node environment, so stub the bridge.
const stubNotificationActionBridge = (): void => {
  vi.stubGlobal("window", {
    nextshell: {
      terminal: {
        onNotificationAction: () => () => {}
      }
    }
  });
};

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

const captureContext = (): { probe: OscRuntimeModule; getCtx: () => OscRuntimeContext } => {
  let captured: OscRuntimeContext | undefined;
  return {
    probe: (_terminal, ctx) => {
      captured = ctx;
      return () => {};
    },
    getCtx: () => {
      if (!captured) {
        throw new Error("probe module was not installed");
      }
      return captured;
    }
  };
};

const resetStores = (): void => {
  useWorkspaceStore.setState({ sessions: [] });
  useSessionOscStore.setState({
    cwdBySession: {},
    titleBySession: {},
    marksBySession: {},
    progressBySession: {},
    userVarsBySession: {}
  });
};

describe("oscRuntime", () => {
  beforeEach(() => {
    resetStores();
    stubNotificationActionBridge();
  });

  test("registers an OSC 7 handler that records cwd for the current session", () => {
    const { terminal, oscHandlers } = createMockTerminal();
    const handle = installOscRuntime(terminal, {
      getSessionId: () => "s1",
      writeToRemote: () => {}
    });

    const osc7 = oscHandlers.get(7);
    expect(osc7).toBeDefined();
    osc7?.("file://remote-host/home/user/projects");

    expect(useSessionOscStore.getState().cwdBySession["s1"]).toBe("/home/user/projects");

    handle.dispose();
    expect(oscHandlers.get(7)).toBeUndefined();
  });

  test("consumes OSC 7 sequences even without a session or a valid path", () => {
    const { terminal, oscHandlers } = createMockTerminal();
    let sessionId: string | undefined = "s1";
    const handle = installOscRuntime(terminal, {
      getSessionId: () => sessionId,
      writeToRemote: () => {}
    });

    const osc7 = oscHandlers.get(7);
    expect(osc7?.("file://host/etc")).toBe(true);
    expect(useSessionOscStore.getState().cwdBySession["s1"]).toBe("/etc");

    expect(osc7?.("http://host/tmp")).toBe(true);
    expect(useSessionOscStore.getState().cwdBySession["s1"]).toBe("/etc");

    sessionId = undefined;
    expect(osc7?.("file://host/tmp")).toBe(true);
    expect(useSessionOscStore.getState().cwdBySession["s1"]).toBe("/etc");

    handle.dispose();
  });

  test("beginReplay/endReplay toggles isReplaying and fires onReplayStart listeners", () => {
    const { terminal } = createMockTerminal();
    const { probe, getCtx } = captureContext();
    const handle = installOscRuntime(
      terminal,
      { getSessionId: () => "s1", writeToRemote: () => {} },
      [probe]
    );

    const ctx = getCtx();
    const events: string[] = [];
    const offReplayStart = ctx.onReplayStart(() => events.push("replay-start"));

    expect(ctx.isReplaying()).toBe(false);
    handle.beginReplay();
    expect(ctx.isReplaying()).toBe(true);
    handle.endReplay();
    expect(ctx.isReplaying()).toBe(false);
    expect(events).toEqual(["replay-start"]);

    offReplayStart();
    handle.beginReplay();
    handle.endReplay();
    expect(events).toEqual(["replay-start"]);

    handle.dispose();
  });

  test("prunes session OSC state when sessions leave the workspace", () => {
    const { terminal } = createMockTerminal();
    const handle = installOscRuntime(terminal, {
      getSessionId: () => "s1",
      writeToRemote: () => {}
    });

    useWorkspaceStore.setState({ sessions: [createSession("s1"), createSession("s2")] });

    const oscStore = useSessionOscStore.getState();
    oscStore.setSessionCwd("s1", "/a");
    oscStore.setSessionCwd("s2", "/b");
    oscStore.setSessionTitle("s2", "title");
    oscStore.appendSessionMark("s2", { id: "m1" });
    oscStore.setSessionProgress("s2", { state: "normal", value: 50 });
    oscStore.setSessionUserVar("s2", "key", "value");

    useWorkspaceStore.setState({ sessions: [createSession("s1")] });

    const state = useSessionOscStore.getState();
    expect(state.cwdBySession["s1"]).toBe("/a");
    expect(state.cwdBySession["s2"]).toBeUndefined();
    expect(state.titleBySession["s2"]).toBeUndefined();
    expect(state.marksBySession["s2"]).toBeUndefined();
    expect(state.progressBySession["s2"]).toBeUndefined();
    expect(state.userVarsBySession["s2"]).toBeUndefined();

    handle.dispose();
  });

  test("handleKeyEvent runs registered handlers in order until one consumes the event", () => {
    const { terminal } = createMockTerminal();
    const { probe, getCtx } = captureContext();
    const handle = installOscRuntime(
      terminal,
      { getSessionId: () => "s1", writeToRemote: () => {} },
      [probe]
    );

    const ctx = getCtx();
    const calls: string[] = [];
    const event = { type: "keydown", key: "x" } as KeyboardEvent;

    ctx.registerKeyHandler(() => {
      calls.push("first");
      return false;
    });
    const offSecond = ctx.registerKeyHandler(() => {
      calls.push("second");
      return true;
    });
    ctx.registerKeyHandler(() => {
      calls.push("third");
      return true;
    });

    expect(handle.handleKeyEvent(event)).toBe(true);
    expect(calls).toEqual(["first", "second"]);

    offSecond();
    calls.length = 0;
    expect(handle.handleKeyEvent(event)).toBe(true);
    expect(calls).toEqual(["first", "third"]);

    handle.dispose();
    calls.length = 0;
    expect(handle.handleKeyEvent(event)).toBe(false);
    expect(calls).toEqual([]);
  });
});
