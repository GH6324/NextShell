import { randomUUID } from "node:crypto";

import type { SftpTransferStatusEvent } from "@nextshell/shared";

export type AgentTransferDirection = "upload" | "download";
export type AgentTransferState = "running" | "success" | "failed" | "cancelled";

export interface AgentTransferSnapshot {
  taskId: string;
  direction: AgentTransferDirection;
  connectionId: string;
  localPath: string;
  remotePath: string;
  /** True when a directory was sent as a tar.gz and unpacked on the far side. */
  packed: boolean;
  state: AgentTransferState;
  progress: number;
  transferredBytes: number;
  totalBytes: number | null;
  startedAt: string;
  finishedAt: string | null;
  /** Sanitized; never carries a raw exception message. */
  error: string | null;
}

interface TrackedTransfer extends AgentTransferSnapshot {
  /** MCP session that started it; other clients cannot see or cancel it. */
  clientId: string;
}

export interface AgentTransferStartInput {
  clientId: string;
  direction: AgentTransferDirection;
  connectionId: string;
  localPath: string;
  remotePath: string;
  packed: boolean;
  /**
   * Runs the actual SFTP work. Started detached on purpose: a multi-gigabyte
   * upload must not be bounded by the MCP call timeout, which is why the tool
   * hands back a task id instead of a result.
   */
  run: (taskId: string) => Promise<unknown>;
}

export interface AgentTransferTrackerOptions {
  /** Finished tasks retained so `transfer_status` can still answer. */
  maxRetained?: number;
  now?: () => number;
  onSettled?: (snapshot: AgentTransferSnapshot) => void;
}

const DEFAULT_MAX_RETAINED = 100;

const publicView = (task: TrackedTransfer): AgentTransferSnapshot => {
  const { clientId: _clientId, ...snapshot } = task;
  return { ...snapshot };
};

/**
 * Bookkeeping for agent-initiated transfers.
 *
 * The SFTP service already owns cancellation and progress; what it does not
 * have is a notion of "who asked". This keeps that mapping so `transfer_status`
 * and `transfer_cancel` can be scoped to the client that started the task, and
 * so the container can tag the GUI progress stream as agent-owned.
 */
export class AgentTransferTracker {
  private readonly tasks = new Map<string, TrackedTransfer>();
  private readonly maxRetained: number;
  private readonly now: () => number;
  private readonly onSettled: ((snapshot: AgentTransferSnapshot) => void) | undefined;

  constructor(options: AgentTransferTrackerOptions = {}) {
    this.maxRetained = Math.max(1, options.maxRetained ?? DEFAULT_MAX_RETAINED);
    this.now = options.now ?? Date.now;
    this.onSettled = options.onSettled;
  }

  start(input: AgentTransferStartInput): AgentTransferSnapshot {
    const taskId = randomUUID();
    const task: TrackedTransfer = {
      taskId,
      clientId: input.clientId,
      direction: input.direction,
      connectionId: input.connectionId,
      localPath: input.localPath,
      remotePath: input.remotePath,
      packed: input.packed,
      state: "running",
      progress: 0,
      transferredBytes: 0,
      totalBytes: null,
      startedAt: new Date(this.now()).toISOString(),
      finishedAt: null,
      error: null
    };
    this.tasks.set(taskId, task);
    this.prune();

    void input
      .run(taskId)
      .then(() => this.settle(taskId, "success", null))
      .catch((error: unknown) => {
        // A cancel arrives as a rejected promise too; the progress event that
        // preceded it is authoritative about which of the two happened.
        const current = this.tasks.get(taskId);
        if (current?.state === "cancelled") return;
        this.settle(taskId, "failed", describeTransferError(error));
      });

    return publicView(task);
  }

  /**
   * Folds one GUI progress event into the matching task. Events for tasks this
   * tracker did not start (i.e. everything the user initiated) are ignored.
   */
  applyProgress(event: SftpTransferStatusEvent): boolean {
    const taskId = event.taskId;
    if (!taskId) return false;
    const task = this.tasks.get(taskId);
    if (!task) return false;

    task.progress = event.progress;
    if (typeof event.transferredBytes === "number") task.transferredBytes = event.transferredBytes;
    if (typeof event.totalBytes === "number") task.totalBytes = event.totalBytes;

    if (event.status === "success" || event.status === "failed" || event.status === "cancelled") {
      task.state = event.status;
      task.finishedAt = new Date(this.now()).toISOString();
      if (event.status === "failed" && event.error) task.error = "传输失败";
      if (event.status === "cancelled") task.error = null;
      this.onSettled?.(publicView(task));
    }
    return true;
  }

  get(taskId: string): AgentTransferSnapshot | undefined {
    const task = this.tasks.get(taskId);
    return task ? publicView(task) : undefined;
  }

  /** Returns the task only when `clientId` is the one that started it. */
  getForClient(taskId: string, clientId: string): AgentTransferSnapshot | undefined {
    const task = this.tasks.get(taskId);
    return task && task.clientId === clientId ? publicView(task) : undefined;
  }

  listForClient(clientId: string): AgentTransferSnapshot[] {
    return [...this.tasks.values()]
      .filter((task) => task.clientId === clientId)
      .map((task) => publicView(task));
  }

  /** Number of transfers this client still has in flight. */
  runningCountForClient(clientId: string): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.clientId === clientId && task.state === "running") count += 1;
    }
    return count;
  }

  private settle(taskId: string, state: AgentTransferState, error: string | null): void {
    const task = this.tasks.get(taskId);
    if (!task || task.state !== "running") return;
    task.state = state;
    task.error = error;
    task.progress = 100;
    task.finishedAt = new Date(this.now()).toISOString();
    this.onSettled?.(publicView(task));
  }

  /** Drops the oldest *settled* tasks; anything still running is never evicted. */
  private prune(): void {
    if (this.tasks.size <= this.maxRetained) return;
    const settled = [...this.tasks.values()]
      .filter((task) => task.state !== "running")
      .sort((a, b) => (a.finishedAt ?? a.startedAt).localeCompare(b.finishedAt ?? b.startedAt));
    for (const task of settled) {
      if (this.tasks.size <= this.maxRetained) return;
      this.tasks.delete(task.taskId);
    }
  }
}

/**
 * Collapses an SFTP failure into one of a few fixed sentences. Raw errors carry
 * absolute paths and occasionally host details, and the agent is the one
 * surface where that text would leave the machine.
 */
export const describeTransferError = (error: unknown): string => {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (/cancel/i.test(raw)) return "传输已取消";
  if (/no such file|enoent/i.test(raw)) return "路径不存在";
  if (/permission denied|eacces|eperm/i.test(raw)) return "没有访问该路径的权限";
  if (/tar/i.test(raw)) return "打包传输失败（本地或远端缺少 tar）";
  if (/econnreset|not connected|closed/i.test(raw)) return "连接在传输过程中断开";
  return "传输失败";
};
