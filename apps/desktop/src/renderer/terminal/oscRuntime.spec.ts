import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import type { SessionDescriptor } from "@nextshell/core";
import { installOscRuntime, type OscRuntimeContext, type OscRuntimeModule } from "./oscRuntime";
import { useSessionOscStore } from "../store/useSessionOscStore";
import { useWorkspaceStore } from "../store/useWorkspaceStore";

type OscHandler = (data: string) => boolean | Promise<boolean>;

interface QueuedWrite {
  data: string;
  callback?: () => void;
}

const createMockTerminal = () => {
  const oscHandlers = new Map<number, OscHandler>();
  const titleListeners = new Set<(title: string) => void>();
  // xterm parses writes in submission order and runs each write's callback once
  // that chunk has been parsed; the queue below lets a test stand in for the
  // parser and settle chunks one at a time.
  const writes: QueuedWrite[] = [];
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
    },
    write(data: string, callback?: () => void) {
      writes.push({ data, callback });
    }
  } as unknown as Terminal;

  const settleWrite = (index: number): void => {
    const queued = writes[index];
    if (!queued) {
      throw new Error(`no queued write at index ${index}`);
    }
    queued.callback?.();
  };

  return { terminal, oscHandlers, writes, settleWrite };
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

  test("notifyReplayStart hands the incoming session id to its listeners", () => {
    const { terminal } = createMockTerminal();
    const { probe, getCtx } = captureContext();
    const handle = installOscRuntime(
      terminal,
      { getSessionId: () => "s1", writeToRemote: () => {} },
      [probe]
    );

    const ctx = getCtx();
    const events: (string | undefined)[] = [];
    const offReplayStart = ctx.onReplayStart((sessionId) => events.push(sessionId));

    // The id is passed explicitly rather than read back from the runtime: an
    // earlier replay may still be in the parser when the next one starts.
    handle.notifyReplayStart("s2");
    expect(events).toEqual(["s2"]);

    offReplayStart();
    handle.notifyReplayStart("s3");
    expect(events).toEqual(["s2"]);

    handle.dispose();
  });

  test("credits OSC output to the session being parsed while replays overlap", () => {
    const { terminal, oscHandlers, settleWrite } = createMockTerminal();
    // The foreground session is already "c" — the value a mutable ref would
    // have reported for every one of the writes below.
    const handle = installOscRuntime(terminal, {
      getSessionId: () => "c",
      writeToRemote: () => {}
    });

    const osc7 = oscHandlers.get(7);
    expect(osc7).toBeDefined();

    // Two tab switches in quick succession leave both replays queued.
    handle.replaySessionData("a", "scrollback-a");
    handle.replaySessionData("b", "scrollback-b");

    osc7?.("file://host/home/a");
    expect(useSessionOscStore.getState().cwdBySession["a"]).toBe("/home/a");
    expect(useSessionOscStore.getState().cwdBySession["c"]).toBeUndefined();

    settleWrite(0);

    osc7?.("file://host/home/b");
    expect(useSessionOscStore.getState().cwdBySession["b"]).toBe("/home/b");
    expect(useSessionOscStore.getState().cwdBySession["a"]).toBe("/home/a");

    settleWrite(1);

    // Nothing in flight: sequences fall back to the foreground session.
    osc7?.("file://host/home/c");
    expect(useSessionOscStore.getState().cwdBySession["c"]).toBe("/home/c");

    handle.dispose();
  });

  test("isReplaying and writeToRemote follow the chunk in the parser", () => {
    const { terminal, settleWrite } = createMockTerminal();
    const { probe, getCtx } = captureContext();
    const replies: { sessionId: string; data: string }[] = [];
    const handle = installOscRuntime(
      terminal,
      {
        getSessionId: () => "live",
        writeToRemote: (sessionId, data) => replies.push({ sessionId, data })
      },
      [probe]
    );

    const ctx = getCtx();
    expect(ctx.isReplaying()).toBe(false);

    handle.replaySessionData("a", "scrollback-a");
    handle.writeSessionData("b", "live-b");

    expect(ctx.isReplaying()).toBe(true);
    expect(ctx.getSessionId()).toBe("a");

    settleWrite(0);
    expect(ctx.isReplaying()).toBe(false);
    expect(ctx.getSessionId()).toBe("b");
    ctx.writeToRemote("reply");
    expect(replies).toEqual([{ sessionId: "b", data: "reply" }]);

    settleWrite(1);
    expect(ctx.isReplaying()).toBe(false);
    expect(ctx.getSessionId()).toBe("live");

    handle.dispose();
  });

  test("writeToRemoteAs replies to the named session whatever the parser is doing", () => {
    const { terminal } = createMockTerminal();
    const { probe, getCtx } = captureContext();
    const replies: { sessionId: string; data: string }[] = [];
    const handle = installOscRuntime(
      terminal,
      {
        getSessionId: () => "live",
        writeToRemote: (sessionId, data) => replies.push({ sessionId, data })
      },
      [probe]
    );

    const ctx = getCtx();
    // A replay for another session is in the parser: the late reply of an async
    // OSC handler must still reach the session that issued the request.
    handle.replaySessionData("b", "scrollback-b");
    ctx.writeToRemoteAs("a", "reply");

    expect(replies).toEqual([{ sessionId: "a", data: "reply" }]);

    handle.dispose();
  });

  test("runAfterPendingWrites orders its continuation behind the queued chunks", () => {
    const { terminal, writes, settleWrite } = createMockTerminal();
    const handle = installOscRuntime(terminal, {
      getSessionId: () => "live",
      writeToRemote: () => {}
    });

    const order: string[] = [];
    handle.replaySessionData("a", "scrollback-a", () => order.push("a-parsed"));
    handle.runAfterPendingWrites(() => order.push("drained"));

    // Queued, not run: xterm's reset() would otherwise jump the backlog.
    expect(order).toEqual([]);
    expect(writes).toHaveLength(2);
    expect(writes[1]?.data).toBe("");

    settleWrite(0);
    expect(order).toEqual(["a-parsed"]);

    settleWrite(1);
    expect(order).toEqual(["a-parsed", "drained"]);

    handle.dispose();
  });

  test("runAfterPendingWrites stays synchronous when nothing is queued", () => {
    const { terminal, writes } = createMockTerminal();
    const handle = installOscRuntime(terminal, {
      getSessionId: () => "live",
      writeToRemote: () => {}
    });

    let drained = 0;
    handle.runAfterPendingWrites(() => {
      drained += 1;
    });

    expect(drained).toBe(1);
    expect(writes).toHaveLength(0);

    handle.dispose();
  });

  test("a lost write callback does not strand attribution on the dead chunk", () => {
    const { terminal, settleWrite } = createMockTerminal();
    const { probe, getCtx } = captureContext();
    const handle = installOscRuntime(
      terminal,
      { getSessionId: () => "live", writeToRemote: () => {} },
      [probe]
    );

    const ctx = getCtx();
    handle.writeSessionData("a", "chunk-a");
    handle.writeSessionData("b", "chunk-b");

    // "a" never settles (terminal torn down mid-parse, write discarded);
    // settling "b" must clear the whole prefix rather than leave "a" pinned as
    // the attribution for everything that follows.
    settleWrite(1);
    expect(ctx.getSessionId()).toBe("live");

    handle.dispose();
  });

  test("empty writes are not queued and still run their completion hook", () => {
    const { terminal, writes } = createMockTerminal();
    const { probe, getCtx } = captureContext();
    const handle = installOscRuntime(
      terminal,
      { getSessionId: () => "live", writeToRemote: () => {} },
      [probe]
    );

    const ctx = getCtx();
    let parsed = 0;
    handle.writeSessionData("a", "", () => {
      parsed += 1;
    });

    expect(parsed).toBe(1);
    expect(writes).toHaveLength(0);
    expect(ctx.getSessionId()).toBe("live");

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
