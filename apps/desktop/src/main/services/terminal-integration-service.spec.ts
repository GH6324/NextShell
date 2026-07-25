import { beforeEach, describe, expect, test, vi } from "vitest";
import type { WebContents } from "electron";

interface FakeWindow {
  focused: boolean;
  progressCalls: Array<[number, { mode: string } | undefined]>;
  isFocused(): boolean;
  setProgressBar(value: number, options?: { mode: string }): void;
  show(): void;
  focus(): void;
}

interface FakeNotification {
  options: { title?: string; body?: string };
  shown: boolean;
  clickListeners: Array<() => void>;
}

const state: {
  window: FakeWindow | null;
  notifications: FakeNotification[];
  notificationSupported: boolean;
} = {
  window: null,
  notifications: [],
  notificationSupported: true
};

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: () => state.window
  },
  Notification: class {
    static isSupported = () => state.notificationSupported;
    readonly clickListeners: Array<() => void> = [];
    shown = false;

    constructor(readonly options: { title?: string; body?: string }) {
      state.notifications.push(this as unknown as FakeNotification);
    }

    on(event: string, listener: () => void): this {
      if (event === "click") {
        this.clickListeners.push(listener);
      }
      return this;
    }

    show(): void {
      this.shown = true;
    }
  }
}));

const { TerminalIntegrationService } = await import("./terminal-integration-service");
const { IPCChannel } = await import("@nextshell/shared");

const createWindow = (focused: boolean): FakeWindow => ({
  focused,
  progressCalls: [],
  isFocused() {
    return this.focused;
  },
  setProgressBar(value, options) {
    this.progressCalls.push([value, options]);
  },
  show: vi.fn(),
  focus: vi.fn()
});

const createSender = () =>
  ({
    send: vi.fn(),
    isDestroyed: () => false
  }) as unknown as WebContents & { send: ReturnType<typeof vi.fn> };

beforeEach(() => {
  state.window = createWindow(false);
  state.notifications = [];
  state.notificationSupported = true;
});

describe("showNotification", () => {
  test("shows the notification the renderer asked for", () => {
    const service = new TerminalIntegrationService();

    const result = service.showNotification(createSender(), {
      sessionId: "s1",
      title: "build",
      body: "done"
    });

    expect(result).toEqual({ ok: true });
    expect(state.notifications).toHaveLength(1);
    expect(state.notifications[0]?.options).toEqual({ title: "build", body: "done" });
  });

  test("still notifies while the window is focused", () => {
    // The renderer already established that the *session* is a background one.
    // Re-testing window focus here would kill the most useful case: a long
    // command finishing in a tab the user is not currently looking at.
    state.window = createWindow(true);
    const service = new TerminalIntegrationService();

    service.showNotification(createSender(), { sessionId: "s1", body: "done" });

    expect(state.notifications).toHaveLength(1);
  });

  test("falls back to the app name when the payload has no title", () => {
    const service = new TerminalIntegrationService();

    service.showNotification(createSender(), { sessionId: "s1", body: "done" });

    expect(state.notifications[0]?.options.title).toBe("NextShell");
  });

  test("stays silent without an owning window or notification support", () => {
    const service = new TerminalIntegrationService();

    state.window = null;
    service.showNotification(createSender(), { sessionId: "s1", body: "done" });

    state.window = createWindow(false);
    state.notificationSupported = false;
    service.showNotification(createSender(), { sessionId: "s1", body: "done" });

    expect(state.notifications).toHaveLength(0);
  });

  test("clicking focuses the window and routes the session back to the renderer", () => {
    const service = new TerminalIntegrationService();
    const sender = createSender();

    service.showNotification(sender, { sessionId: "s1", body: "done" });
    state.notifications[0]?.clickListeners.forEach((listener) => listener());

    expect(state.window?.show).toHaveBeenCalled();
    expect(state.window?.focus).toHaveBeenCalled();
    expect(sender.send).toHaveBeenCalledWith(IPCChannel.TerminalNotificationAction, {
      sessionId: "s1"
    });
  });
});

describe("setProgress", () => {
  test("maps 0-100 percentages onto Electron's 0-1 fraction", () => {
    const service = new TerminalIntegrationService();

    service.setProgress(createSender(), { sessionId: "s1", state: "normal", value: 50 });

    expect(state.window?.progressCalls).toEqual([[0.5, { mode: "normal" }]]);
  });

  test("clears the bar for state none", () => {
    const service = new TerminalIntegrationService();

    service.setProgress(createSender(), { sessionId: "s1", state: "none" });

    expect(state.window?.progressCalls).toEqual([[-1, undefined]]);
  });

  test("indeterminate ignores the value", () => {
    const service = new TerminalIntegrationService();

    service.setProgress(createSender(), { sessionId: "s1", state: "indeterminate", value: 30 });

    expect(state.window?.progressCalls).toEqual([[2, { mode: "indeterminate" }]]);
  });

  test("error without a value shows a full bar, paused defaults to empty", () => {
    const service = new TerminalIntegrationService();

    service.setProgress(createSender(), { sessionId: "s1", state: "error" });
    service.setProgress(createSender(), { sessionId: "s1", state: "paused" });

    expect(state.window?.progressCalls).toEqual([
      [1, { mode: "error" }],
      [0, { mode: "paused" }]
    ]);
  });
});
