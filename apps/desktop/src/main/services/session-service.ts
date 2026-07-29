import os from "node:os";
import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { spawn as spawnPty } from "node-pty";
import type { ConnectionProfile, SessionDescriptor, SessionStatus } from "@nextshell/core";
import type { SshConnection } from "@nextshell/ssh";
import type {
  SessionAuthOverrideInput,
  SessionOpenInput,
  SessionStatusEvent,
  StreamDeliveryAckInput
} from "@nextshell/shared";
import { AUTH_REQUIRED_PREFIX, IPCChannel } from "@nextshell/shared";
import type { CachedConnectionRepository } from "@nextshell/storage";
import type { ActiveSession, ActiveRemoteSession, SystemMonitorRuntime } from "./container-types";
import {
  normalizeError,
  toAuthRequiredReason,
  decodeTerminalData,
  encodeTerminalData
} from "./container-utils";
import {
  SHELL_INTEGRATION_PROBE_COMMAND,
  resolveShellFamily,
  startShellIntegrationObserver,
  type ShellIntegrationFamily
} from "./terminal-shell-integration";
import { resolveLocalShellLaunch } from "./local-shell";
import type { createOrderedBytesDispatcher } from "./ipc-stream-dispatcher";
import { logger } from "../logger";

export interface SessionServiceOptions {
  connections: CachedConnectionRepository;
  activeSessions: Map<string, ActiveSession>;
  getConnectionOrThrow: (id: string) => ConnectionProfile;
  /**
   * Hands out a pooled SSH client that still has channel budget left, together
   * with a reservation for the shell this session is about to open. The
   * reservation must be released once the shell exists (or the open failed).
   */
  acquireTerminalConnection: (
    connectionId: string,
    authOverride?: SessionAuthOverrideInput
  ) => Promise<{ connection: SshConnection; release: () => void }>;
  /**
   * Marks the connection as in use for the whole "session is opening" window —
   * `activeSessions` only learns about the session once the shell is up, so
   * without this a concurrently closing last tab would close the client out
   * from under it.
   */
  retainConnection: (connectionId: string) => () => void;
  closeConnectionIfIdle: (connectionId: string) => Promise<void>;
  appendAuditLogIfEnabled: (payload: {
    action: string;
    level: "info" | "warn" | "error";
    connectionId?: string;
    message: string;
    metadata?: Record<string, unknown>;
  }) => void;
  sendSessionStatus: (sender: WebContents, payload: SessionStatusEvent) => void;
  sessionDataDispatcher: ReturnType<typeof createOrderedBytesDispatcher>;
  ensureSystemMonitorRuntime: (connectionId: string) => Promise<SystemMonitorRuntime>;
  clearMonitorSuspension: (connectionId: string) => void;
  warmupSftp: (connectionId: string, connection: SshConnection) => Promise<string | undefined>;
  persistAuthOverride: (
    connectionId: string,
    authOverride: SessionAuthOverrideInput
  ) => Promise<string | undefined>;
}

export class SessionService {
  private readonly connections: CachedConnectionRepository;
  private readonly activeSessions: Map<string, ActiveSession>;
  private readonly getConnectionOrThrow: (id: string) => ConnectionProfile;
  private readonly acquireTerminalConnection: SessionServiceOptions["acquireTerminalConnection"];
  private readonly retainConnection: (connectionId: string) => () => void;
  private readonly closeConnectionIfIdle: (connectionId: string) => Promise<void>;
  private readonly appendAuditLogIfEnabled: SessionServiceOptions["appendAuditLogIfEnabled"];
  private readonly sendSessionStatus: (sender: WebContents, payload: SessionStatusEvent) => void;
  private readonly sessionDataDispatcher: ReturnType<typeof createOrderedBytesDispatcher>;
  private readonly ensureSystemMonitorRuntime: (
    connectionId: string
  ) => Promise<SystemMonitorRuntime>;
  private readonly clearMonitorSuspension: (connectionId: string) => void;
  private readonly warmupSftp: (
    connectionId: string,
    connection: SshConnection
  ) => Promise<string | undefined>;
  private readonly persistAuthOverride: (
    connectionId: string,
    authOverride: SessionAuthOverrideInput
  ) => Promise<string | undefined>;

  constructor(options: SessionServiceOptions) {
    this.connections = options.connections;
    this.activeSessions = options.activeSessions;
    this.getConnectionOrThrow = options.getConnectionOrThrow;
    this.acquireTerminalConnection = options.acquireTerminalConnection;
    this.retainConnection = options.retainConnection;
    this.closeConnectionIfIdle = options.closeConnectionIfIdle;
    this.appendAuditLogIfEnabled = options.appendAuditLogIfEnabled;
    this.sendSessionStatus = options.sendSessionStatus;
    this.sessionDataDispatcher = options.sessionDataDispatcher;
    this.ensureSystemMonitorRuntime = options.ensureSystemMonitorRuntime;
    this.clearMonitorSuspension = options.clearMonitorSuspension;
    this.warmupSftp = options.warmupSftp;
    this.persistAuthOverride = options.persistAuthOverride;
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  async openSession(input: SessionOpenInput, sender: WebContents): Promise<SessionDescriptor> {
    if (input.target === "local") {
      return this.openLocalSession(sender, input.sessionId);
    }

    return this.openRemoteSession(input.connectionId, sender, input.sessionId, input.authOverride);
  }

  async openRemoteSession(
    connectionId: string,
    sender: WebContents,
    sessionId?: string,
    authOverride?: SessionAuthOverrideInput
  ): Promise<SessionDescriptor> {
    const profile = this.getConnectionOrThrow(connectionId);
    const descriptorId = sessionId ?? randomUUID();
    if (this.activeSessions.has(descriptorId)) {
      throw new Error("Session id already exists");
    }
    const descriptor: SessionDescriptor = {
      id: descriptorId,
      target: "remote",
      connectionId,
      title: `${profile.name}@${profile.host}`,
      status: "connecting",
      type: "terminal",
      createdAt: new Date().toISOString(),
      reconnectable: true
    };

    this.sendSessionStatus(sender, {
      sessionId: descriptor.id,
      status: "connecting"
    });

    // Held for the whole open window: the session only becomes visible in
    // activeSessions once its shell is up, so until then nothing else can tell
    // that this connection is still needed — closing another tab meanwhile
    // used to take the shared client down with it.
    const releaseConnectionRef = this.retainConnection(connectionId);
    let releaseChannelSlot: (() => void) | undefined;

    try {
      const lease = await this.acquireTerminalConnection(connectionId, authOverride);
      const connection = lease.connection;
      releaseChannelSlot = lease.release;
      // Shell integration ("auto" mode only): probe the login shell so the
      // post-open observer knows which script to inject. Deliberately *not*
      // awaited here — the family is only needed once the observation window
      // expires, so the probe round-trip runs alongside session startup
      // instead of adding latency to every connect. Probe failures silently
      // disable injection. The session itself always opens as a plain PTY
      // shell; injection never restarts the user's shell.
      const shellIntegrationFamily: Promise<ShellIntegrationFamily | undefined> | undefined =
        this.connections.getAppPreferences().terminal.shellIntegration === "auto"
          ? connection
              .exec(SHELL_INTEGRATION_PROBE_COMMAND)
              .then((probe) => resolveShellFamily(probe.stdout.trim() || undefined))
              .catch(() => undefined)
          : undefined;
      const shell = await connection.openShell({
        cols: 140,
        rows: 40,
        term: "xterm-256color"
      });
      // The real channel now holds the budget slot the lease was standing in for.
      releaseChannelSlot();

      const now = new Date().toISOString();
      this.connections.save({
        ...profile,
        lastConnectedAt: now,
        updatedAt: now
      });

      descriptor.status = "connected";

      this.activeSessions.set(descriptor.id, {
        kind: "remote",
        descriptor,
        channel: shell,
        sender,
        connectionId,
        terminalEncoding: profile.terminalEncoding,
        backspaceMode: profile.backspaceMode,
        deleteMode: profile.deleteMode
      });

      shell.on("data", (chunk: Buffer | string) => {
        const active = this.activeSessions.get(descriptor.id);
        if (!active) {
          return;
        }

        this.sessionDataDispatcher.push({
          streamId: descriptor.id,
          sender: active.sender,
          chunk: decodeTerminalData(chunk, active.terminalEncoding),
          onPause: () => shell.pause(),
          onResume: () => shell.resume()
        });
      });

      shell.stderr.on("data", (chunk: Buffer | string) => {
        const active = this.activeSessions.get(descriptor.id);
        if (!active) {
          return;
        }
        this.sessionDataDispatcher.push({
          streamId: descriptor.id,
          sender: active.sender,
          chunk: decodeTerminalData(chunk, active.terminalEncoding),
          onPause: () => shell.pause(),
          onResume: () => shell.resume()
        });
      });

      shell.on("close", () => {
        shell.removeAllListeners();
        shell.stderr.removeAllListeners();
        this.finalizeRemoteSession(descriptor.id, "disconnected");
      });

      shell.on("error", (error: unknown) => {
        shell.removeAllListeners();
        shell.stderr.removeAllListeners();
        this.finalizeRemoteSession(descriptor.id, "failed", normalizeError(error));
      });

      // Auto shell integration: observe the first prompt cycle; a remote that
      // already emits OSC 7/133 is left alone, otherwise install + inject the
      // integration script. Never blocks or fails the session.
      if (shellIntegrationFamily) {
        startShellIntegrationObserver({
          connection,
          shell,
          family: shellIntegrationFamily,
          isSessionActive: () => this.activeSessions.has(descriptor.id),
          hasUserInput: () => {
            const active = this.activeSessions.get(descriptor.id);
            return active?.kind === "remote" && active.userInputSeen === true;
          },
          decode: (chunk) => decodeTerminalData(chunk, profile.terminalEncoding),
          log: (message, metadata) =>
            logger.info(message, {
              sessionId: descriptor.id,
              connectionId,
              ...metadata
            })
        });
      }

      let connectedReason = await this.warmupSftp(connectionId, connection);
      if (authOverride) {
        const persistWarning = await this.persistAuthOverride(connectionId, authOverride);
        if (persistWarning) {
          connectedReason = connectedReason
            ? `${connectedReason}；${persistWarning}`
            : persistWarning;
        }
      }

      if (profile.monitorSession) {
        this.clearMonitorSuspension(connectionId);
        try {
          await this.ensureSystemMonitorRuntime(connectionId);
        } catch (error) {
          const monitorReason = `Monitor Session 后台连接初始化失败：${normalizeError(error)}`;
          connectedReason = connectedReason
            ? `${connectedReason}；${monitorReason}`
            : monitorReason;
          logger.warn("[MonitorSession] failed to bootstrap runtime after terminal open", {
            connectionId,
            reason: normalizeError(error)
          });
        }
      }

      this.sendSessionStatus(sender, {
        sessionId: descriptor.id,
        status: "connected",
        reason: connectedReason
      });

      this.appendAuditLogIfEnabled({
        action: "session.open",
        level: "info",
        connectionId,
        message: "SSH session opened",
        metadata: {
          sessionId: descriptor.id
        }
      });

      return descriptor;
    } catch (error) {
      const rawReason = normalizeError(error);
      const authReason = toAuthRequiredReason(rawReason);
      const reason = authReason ? `${AUTH_REQUIRED_PREFIX}${authReason}` : rawReason;
      logger.error("[Session] failed to open", {
        connectionId,
        reason
      });
      if (!authReason) {
        this.sendSessionStatus(sender, {
          sessionId: descriptor.id,
          status: "failed",
          reason
        });
      }
      this.appendAuditLogIfEnabled({
        action: "session.open_failed",
        level: "error",
        connectionId,
        message: "SSH session failed to open",
        metadata: {
          reason,
          authRequired: Boolean(authReason)
        }
      });
      throw new Error(reason);
    } finally {
      releaseChannelSlot?.();
      releaseConnectionRef();
      // If this open failed, another tab's close may have been skipped because
      // of the reference we were holding — re-run the idle check so a client
      // nobody uses any more is not left behind.
      if (!this.activeSessions.has(descriptor.id)) {
        void this.closeConnectionIfIdle(connectionId);
      }
    }
  }

  async openLocalSession(sender: WebContents, sessionId?: string): Promise<SessionDescriptor> {
    const descriptorId = sessionId ?? randomUUID();
    if (this.activeSessions.has(descriptorId)) {
      throw new Error("Session id already exists");
    }

    const prefs = this.connections.getAppPreferences();
    const shellLaunch = resolveLocalShellLaunch(prefs.terminal.localShell, process.platform);
    const descriptor: SessionDescriptor = {
      id: descriptorId,
      target: "local",
      title: `本地终端 · ${shellLaunch.label}`,
      status: "connecting",
      type: "terminal",
      createdAt: new Date().toISOString(),
      reconnectable: true
    };

    this.sendSessionStatus(sender, {
      sessionId: descriptor.id,
      status: "connecting"
    });

    try {
      const localShellEnv = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string"
        )
      );
      const pty = spawnPty(shellLaunch.command, shellLaunch.args, {
        name: "xterm-256color",
        cols: 140,
        rows: 40,
        cwd: os.homedir(),
        env: localShellEnv
      });

      descriptor.status = "connected";
      this.activeSessions.set(descriptor.id, {
        kind: "local",
        descriptor,
        pty,
        sender,
        terminalEncoding: "utf-8"
      });

      pty.onData((chunk) => {
        const active = this.activeSessions.get(descriptor.id);
        if (!active || active.kind !== "local") {
          return;
        }

        this.sessionDataDispatcher.push({
          streamId: descriptor.id,
          sender: active.sender,
          chunk,
          onPause: () => pty.pause(),
          onResume: () => pty.resume()
        });
      });

      pty.onExit(({ exitCode, signal }) => {
        const reasonParts: string[] = [];
        if (typeof exitCode === "number") {
          reasonParts.push(`exit ${exitCode}`);
        }
        if (typeof signal === "number") {
          reasonParts.push(`signal ${signal}`);
        }
        this.finalizeLocalSession(
          descriptor.id,
          "disconnected",
          reasonParts.length > 0 ? reasonParts.join(", ") : undefined
        );
      });

      this.sendSessionStatus(sender, {
        sessionId: descriptor.id,
        status: "connected"
      });

      this.appendAuditLogIfEnabled({
        action: "session.local_open",
        level: "info",
        message: "Local terminal session opened",
        metadata: {
          sessionId: descriptor.id,
          shell: shellLaunch.command
        }
      });

      return descriptor;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Failed to open local shell";
      logger.error("[Session] failed to open local terminal", {
        sessionId: descriptor.id,
        reason
      });
      this.sendSessionStatus(sender, {
        sessionId: descriptor.id,
        status: "failed",
        reason
      });
      this.appendAuditLogIfEnabled({
        action: "session.local_open_failed",
        level: "error",
        message: "Local terminal session failed to open",
        metadata: {
          sessionId: descriptor.id,
          reason
        }
      });
      throw new Error(reason);
    }
  }

  writeSession(sessionId: string, data: string, origin?: "user" | "protocol"): { ok: true } {
    const active = this.activeSessions.get(sessionId);
    if (!active) {
      throw new Error("Session not found");
    }

    if (origin !== "protocol" && active.kind === "remote") {
      // Remembered for the shell-integration observer: once the user has typed,
      // writing a source line into the same stdin would splice into their input.
      active.userInputSeen = true;
    }

    if (active.kind === "local") {
      active.pty.write(data);
      return { ok: true };
    }

    const buffer = encodeTerminalData(data, active.terminalEncoding);
    active.channel.write(buffer);
    return { ok: true };
  }

  resizeSession(sessionId: string, cols: number, rows: number): { ok: true } {
    const active = this.activeSessions.get(sessionId);
    if (!active) {
      // Session may have already disconnected; silently ignore resize requests
      return { ok: true };
    }

    if (active.kind === "local") {
      active.pty.resize(cols, rows);
      return { ok: true };
    }

    active.channel.setWindow(rows, cols, 0, 0);
    return { ok: true };
  }

  async closeSession(sessionId: string): Promise<{ ok: true }> {
    const active = this.activeSessions.get(sessionId);
    if (!active) {
      return { ok: true };
    }

    logger.info("[Session] closing", {
      sessionId,
      connectionId: active.kind === "remote" ? active.connectionId : undefined,
      target: active.descriptor.target
    });
    this.sessionDataDispatcher.clear(sessionId);
    if (active.kind === "local") {
      active.pty.kill();
      this.activeSessions.delete(sessionId);
      this.sendSessionStatus(active.sender, {
        sessionId,
        status: "disconnected"
      });

      this.appendAuditLogIfEnabled({
        action: "session.local_close",
        level: "info",
        message: "Local terminal session closed",
        metadata: { sessionId }
      });
      return { ok: true };
    }

    active.channel.removeAllListeners();
    if (active.channel.stderr) {
      active.channel.stderr.removeAllListeners();
    }
    active.channel.end();
    this.activeSessions.delete(sessionId);
    this.sendSessionStatus(active.sender, {
      sessionId,
      status: "disconnected"
    });

    this.appendAuditLogIfEnabled({
      action: "session.close",
      level: "info",
      connectionId: active.connectionId,
      message: "SSH session closed",
      metadata: { sessionId }
    });

    await this.closeConnectionIfIdle(active.connectionId);
    return { ok: true };
  }

  ackStreamDelivery(input: StreamDeliveryAckInput): { ok: true } {
    // Only the ordered terminal byte stream uses the ack protocol; monitor
    // snapshots are sent directly without delivery tracking. Acks are batched
    // by the renderer: deliveryId is the highest id processed so far and
    // consumedBytes is the byte delta since its previous ack.
    this.sessionDataDispatcher.ack({
      streamId: input.streamId,
      deliveryId: input.deliveryId,
      consumedBytes: input.consumedBytes
    });

    return { ok: true };
  }

  // ─── Internal Cleanup ────────────────────────────────────────────────────

  finalizeRemoteSession(
    sessionId: string,
    status: Extract<SessionStatus, "disconnected" | "failed">,
    reason?: string
  ): void {
    const active = this.activeSessions.get(sessionId);
    if (!active) {
      return;
    }

    active.descriptor.status = status;
    // closeWhenDrained is guaranteed to invoke the callback exactly once:
    // on drain (acks), when the sender is destroyed, on ack-stall timeout, or
    // at the dispatcher's hard drain deadline. A hung renderer that stops
    // acking therefore cannot leak this session or its SSH connection.
    this.sessionDataDispatcher.closeWhenDrained(sessionId, () => {
      const drained = this.activeSessions.get(sessionId);
      if (!drained || drained.kind !== "remote") {
        return;
      }

      this.activeSessions.delete(sessionId);
      drained.descriptor.status = status;
      this.sendSessionStatus(drained.sender, { sessionId, status, reason });
      void this.closeConnectionIfIdle(drained.connectionId);
    });
  }

  finalizeLocalSession(
    sessionId: string,
    status: Extract<SessionStatus, "disconnected" | "failed">,
    reason?: string
  ): void {
    const active = this.activeSessions.get(sessionId);
    if (!active || active.kind !== "local") {
      return;
    }

    active.descriptor.status = status;
    this.sessionDataDispatcher.closeWhenDrained(sessionId, () => {
      const drained = this.activeSessions.get(sessionId);
      if (!drained || drained.kind !== "local") {
        return;
      }

      this.activeSessions.delete(sessionId);
      drained.descriptor.status = status;
      this.sendSessionStatus(drained.sender, { sessionId, status, reason });
      this.appendAuditLogIfEnabled({
        action: "session.local_close",
        level: status === "failed" ? "error" : "info",
        message: "Local terminal session closed",
        metadata: { sessionId, reason }
      });
    });
  }
}
