import { describe, expect, test, vi } from "vitest";
import type { SftpTransferStatusEvent } from "@nextshell/shared";

import { AgentTransferTracker, describeTransferError } from "./transfers";

const CONNECTION_ID = "11111111-1111-1111-1111-111111111111";

const progress = (
  taskId: string,
  overrides: Partial<SftpTransferStatusEvent> = {}
): SftpTransferStatusEvent => ({
  taskId,
  direction: "upload",
  connectionId: CONNECTION_ID,
  localPath: "/Users/tester/repo/dist.tar.gz",
  remotePath: "/opt/app/dist.tar.gz",
  status: "running",
  progress: 50,
  ...overrides
});

const start = (tracker: AgentTransferTracker, overrides: Partial<{ clientId: string }> = {}) => {
  const deferred: { resolve: () => void; reject: (error: unknown) => void } = {
    resolve: () => undefined,
    reject: () => undefined
  };
  const snapshot = tracker.start({
    clientId: overrides.clientId ?? "client-a",
    connectionId: CONNECTION_ID,
    direction: "upload",
    localPath: "/Users/tester/repo/dist.tar.gz",
    remotePath: "/opt/app/dist.tar.gz",
    packed: false,
    run: () =>
      new Promise<void>((resolve, reject) => {
        deferred.resolve = resolve;
        deferred.reject = reject;
      })
  });
  return { snapshot, deferred };
};

describe("AgentTransferTracker", () => {
  test("returns a running snapshot immediately instead of awaiting the transfer", () => {
    const tracker = new AgentTransferTracker();
    const { snapshot } = start(tracker);

    expect(snapshot.state).toBe("running");
    expect(snapshot.progress).toBe(0);
    expect(tracker.runningCountForClient("client-a")).toBe(1);
  });

  test("folds GUI progress events into the matching task", () => {
    const tracker = new AgentTransferTracker();
    const { snapshot } = start(tracker);

    tracker.applyProgress(
      progress(snapshot.taskId, { progress: 40, transferredBytes: 400, totalBytes: 1000 })
    );

    expect(tracker.get(snapshot.taskId)).toMatchObject({
      progress: 40,
      transferredBytes: 400,
      totalBytes: 1000,
      state: "running"
    });
  });

  test("ignores progress for transfers the user started", () => {
    const tracker = new AgentTransferTracker();
    expect(tracker.applyProgress(progress("00000000-0000-4000-8000-000000000000"))).toBe(false);
  });

  test("a user cancel from the GUI queue settles the task as cancelled, not failed", async () => {
    const tracker = new AgentTransferTracker();
    const { snapshot, deferred } = start(tracker);

    // Real ordering: the SFTP service emits the cancelled status first, then the
    // transfer promise rejects with the cancellation error.
    tracker.applyProgress(progress(snapshot.taskId, { status: "cancelled", progress: 100 }));
    deferred.reject(new Error("Transfer cancelled"));
    await vi.waitFor(() => expect(tracker.get(snapshot.taskId)?.state).toBe("cancelled"));
    expect(tracker.get(snapshot.taskId)?.error).toBeNull();
  });

  test("a rejected transfer settles as failed with a sanitized reason", async () => {
    const tracker = new AgentTransferTracker();
    const { snapshot, deferred } = start(tracker);

    deferred.reject(new Error("Error: EACCES: permission denied, open '/Users/tester/secret'"));
    await vi.waitFor(() => expect(tracker.get(snapshot.taskId)?.state).toBe("failed"));
    const settled = tracker.get(snapshot.taskId);
    expect(settled?.error).toBe("没有访问该路径的权限");
    expect(JSON.stringify(settled)).not.toContain("secret");
  });

  test("tasks are scoped to the client that started them", () => {
    const tracker = new AgentTransferTracker();
    const { snapshot } = start(tracker, { clientId: "client-a" });

    expect(tracker.getForClient(snapshot.taskId, "client-a")).toBeDefined();
    expect(tracker.getForClient(snapshot.taskId, "client-b")).toBeUndefined();
    expect(tracker.listForClient("client-b")).toEqual([]);
    expect(tracker.runningCountForClient("client-b")).toBe(0);
  });

  test("the public snapshot never leaks the owning client id", () => {
    const tracker = new AgentTransferTracker();
    const { snapshot } = start(tracker, { clientId: "client-secret" });
    expect(JSON.stringify(snapshot)).not.toContain("client-secret");
  });

  test("retention evicts settled tasks and never a running one", async () => {
    const tracker = new AgentTransferTracker({ maxRetained: 2 });
    const first = start(tracker);
    const second = start(tracker);
    first.deferred.resolve();
    second.deferred.resolve();
    await vi.waitFor(() => expect(tracker.get(second.snapshot.taskId)?.state).toBe("success"));

    const third = start(tracker);
    const fourth = start(tracker);

    // Both settled tasks gave way; the two still running are untouched.
    expect(tracker.get(first.snapshot.taskId)).toBeUndefined();
    expect(tracker.get(third.snapshot.taskId)?.state).toBe("running");
    expect(tracker.get(fourth.snapshot.taskId)?.state).toBe("running");
  });
});

describe("describeTransferError", () => {
  test("collapses raw errors into fixed sentences that carry no paths", () => {
    expect(describeTransferError(new Error("ENOENT: no such file, open '/Users/x/.ssh/id'"))).toBe(
      "路径不存在"
    );
    expect(describeTransferError(new Error("Transfer cancelled"))).toBe("传输已取消");
    expect(describeTransferError("something entirely unexpected")).toBe("传输失败");
  });
});
