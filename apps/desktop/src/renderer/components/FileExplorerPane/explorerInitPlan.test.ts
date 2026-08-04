import { describe, expect, test } from "vitest";
import {
  consumeExplorerLoadSuppression,
  planExplorerInit,
  shouldRunSilentRevalidation
} from "./explorerInitPlan";

describe("planExplorerInit", () => {
  test("pauses without a connection or while disconnected", () => {
    expect(
      planExplorerInit({
        connected: true,
        initializedConnectionId: undefined,
        hasCachedState: true
      })
    ).toBe("pause");
    expect(
      planExplorerInit({
        connectionId: "conn-1",
        connected: false,
        initializedConnectionId: "conn-1",
        hasCachedState: true
      })
    ).toBe("pause");
  });

  test("resumes in place for the connection that is already initialized", () => {
    expect(
      planExplorerInit({
        connectionId: "conn-1",
        connected: true,
        initializedConnectionId: "conn-1",
        hasCachedState: false
      })
    ).toBe("resume");
  });

  test("restores a different connection from cache and cold-starts without one", () => {
    expect(
      planExplorerInit({
        connectionId: "conn-2",
        connected: true,
        initializedConnectionId: "conn-1",
        hasCachedState: true
      })
    ).toBe("restore");
    expect(
      planExplorerInit({
        connectionId: "conn-2",
        connected: true,
        initializedConnectionId: "conn-1",
        hasCachedState: false
      })
    ).toBe("cold");
  });

  test("a first mount restores from cache when a snapshot survived the previous mount", () => {
    expect(
      planExplorerInit({
        connectionId: "conn-1",
        connected: true,
        initializedConnectionId: undefined,
        hasCachedState: true
      })
    ).toBe("restore");
  });
});

describe("consumeExplorerLoadSuppression", () => {
  test("suppresses exactly the matching load and then expires", () => {
    const token = { connectionId: "conn-1", path: "/var/log" };

    const first = consumeExplorerLoadSuppression(token, {
      connectionId: "conn-1",
      path: "/var/log"
    });
    expect(first.suppress).toBe(true);
    expect(first.next).toBeUndefined();

    const second = consumeExplorerLoadSuppression(first.next, {
      connectionId: "conn-1",
      path: "/var/log"
    });
    expect(second.suppress).toBe(false);
  });

  test("never suppresses another connection or another directory, and expires anyway", () => {
    const token = { connectionId: "conn-1", path: "/var/log" };

    expect(
      consumeExplorerLoadSuppression(token, { connectionId: "conn-2", path: "/var/log" })
    ).toEqual({ suppress: false, next: undefined });
    expect(consumeExplorerLoadSuppression(token, { connectionId: "conn-1", path: "/etc" })).toEqual(
      {
        suppress: false,
        next: undefined
      }
    );
  });

  test("is a no-op without a token", () => {
    expect(
      consumeExplorerLoadSuppression(undefined, { connectionId: "conn-1", path: "/" })
    ).toEqual({ suppress: false, next: undefined });
  });
});

describe("shouldRunSilentRevalidation", () => {
  const base = {
    pending: { connectionId: "conn-1", gateVersion: 7 },
    connectionId: "conn-1",
    connected: true,
    active: true,
    initialPathReady: true,
    stateOwnerId: "conn-1",
    gateVersion: 7
  };

  test("runs for a freshly restored, visible connection", () => {
    expect(shouldRunSilentRevalidation(base)).toBe(true);
  });

  test("waits while the pane is hidden and runs once it becomes visible", () => {
    expect(shouldRunSilentRevalidation({ ...base, active: false })).toBe(false);
    expect(shouldRunSilentRevalidation({ ...base, active: true })).toBe(true);
  });

  test("does not run without a pending revalidation", () => {
    expect(shouldRunSilentRevalidation({ ...base, pending: undefined })).toBe(false);
  });

  test("does not run for a connection other than the pending one", () => {
    expect(shouldRunSilentRevalidation({ ...base, connectionId: "conn-2" })).toBe(false);
    expect(shouldRunSilentRevalidation({ ...base, connectionId: undefined })).toBe(false);
  });

  test("gives up once another request has claimed the gate", () => {
    expect(shouldRunSilentRevalidation({ ...base, gateVersion: 8 })).toBe(false);
  });

  test("waits for the state to belong to the new connection and for it to be ready", () => {
    expect(shouldRunSilentRevalidation({ ...base, stateOwnerId: "conn-0" })).toBe(false);
    expect(shouldRunSilentRevalidation({ ...base, stateOwnerId: undefined })).toBe(false);
    expect(shouldRunSilentRevalidation({ ...base, initialPathReady: false })).toBe(false);
  });

  test("does not run while disconnected", () => {
    expect(shouldRunSilentRevalidation({ ...base, connected: false })).toBe(false);
  });
});
