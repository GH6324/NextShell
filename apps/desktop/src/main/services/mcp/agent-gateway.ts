import type {
  AgentAccessLevel,
  AppPreferences,
  ConnectionProfile,
  MonitorSnapshot,
  RemoteFileEntry,
  SavedCommand,
  SessionStatus,
  SessionType
} from "@nextshell/core";
import { redactAuditMetadata } from "@nextshell/storage";

import {
  ConnectionTargetAmbiguousError,
  ConnectionTargetNotFoundError,
  buildServerSummary,
  listServerSummaries,
  resolveConnectionTarget,
  searchServerSummaries,
  type ServerSummary
} from "./target-resolver";

// ─── Client identity ────────────────────────────────────────────────────────

export type AgentTransportKind = "socket" | "tcp";

export interface AgentClientIdentity {
  /** MCP session id. */
  id: string;
  name: string | null;
  version: string | null;
  transport: AgentTransportKind;
  /**
   * Rate-limit bucket. Must stay stable across MCP sessions of the same client:
   * keying the budget on the session id would let any caller reset it by
   * re-sending `initialize`.
   */
  rateKey: string;
}

// ─── Result envelope ────────────────────────────────────────────────────────

export type AgentErrorCode =
  | "invalid_argument"
  | "not_found"
  | "ambiguous"
  | "forbidden"
  | "too_large"
  | "rate_limited"
  | "busy"
  | "timeout"
  | "unavailable"
  | "internal";

export interface AgentToolError {
  code: AgentErrorCode;
  /**
   * Agent-facing text. Never carries a raw exception message, stack, host
   * connection string or key path — those only ever reach the audit log.
   */
  message: string;
  /** Populated for `ambiguous`, so the agent can ask the user to pick. */
  candidates?: ServerSummary[];
}

export type AgentToolResult<T> = { ok: true; data: T } | { ok: false; error: AgentToolError };

/** Lets a task inside `execute` fail with an already-classified agent error. */
export class AgentToolFailure extends Error {
  readonly toolError: AgentToolError;

  constructor(toolError: AgentToolError) {
    super(toolError.code);
    this.name = "AgentToolFailure";
    this.toolError = toolError;
  }
}

// ─── Agent-facing payloads ──────────────────────────────────────────────────

/**
 * Host metadata handed to MCP clients verbatim. Every credential-bearing field
 * of `ConnectionProfile` (`credentialRef`, `sshKeyId`, `sshKeyResourceId`,
 * `proxyId`, `hostFingerprint`, `notes`) is deliberately absent.
 */
export interface AgentHostInfo {
  nameId: string;
  name: string;
  host: string;
  port: number;
  user: string;
  groupPath: string;
  tags: string[];
  favorite: boolean;
  access: Exclude<AgentAccessLevel, "off">;
  connected: boolean;
  activeSessions: number;
  lastConnectedAt: string | null;
}

export interface AgentSessionInfo {
  id: string;
  connectionId: string | null;
  title: string;
  status: SessionStatus;
  type: SessionType;
  createdAt: string;
  /** Requires the Phase 1 OscTap; `null` until then. */
  cwd: string | null;
  lastCommand: string | null;
}

export interface AgentHostDetail extends AgentHostInfo {
  sessions: AgentSessionInfo[];
  monitor: MonitorSnapshot | null;
}

export interface AgentFileEntry {
  name: string;
  path: string;
  type: RemoteFileEntry["type"];
  size: number;
  permissions: string;
  owner: string;
  group: string;
  modifiedAt: string;
}

export interface AgentRemoteFileStat {
  path: string;
  type: "file" | "directory" | "link" | "other";
  size: number;
  permissions: string;
  uid: number;
  gid: number;
  modifiedAt: string;
  accessedAt: string;
}

export interface AgentRemoteFileChunk {
  bytes: Buffer;
  /** True when the source was longer than the requested byte budget. */
  truncated: boolean;
}

export interface AgentHostListPayload {
  hosts: AgentHostInfo[];
  total: number;
  truncated: boolean;
}

export interface AgentSessionListPayload {
  sessions: AgentSessionInfo[];
  truncated: boolean;
}

export interface AgentFileListPayload {
  path: string;
  entries: AgentFileEntry[];
  total: number;
  truncated: boolean;
}

export interface AgentFileReadPayload {
  path: string;
  encoding: "utf-8" | "base64";
  content: string;
  bytes: number;
  size: number;
  truncated: boolean;
}

export interface AgentCommandMatch {
  command: string;
  source: "library";
  name: string | null;
  group: string | null;
  lastUsedAt: string | null;
}

export interface AgentCommandSearchPayload {
  matches: AgentCommandMatch[];
  total: number;
  truncated: boolean;
  /**
   * Only the user's curated command library is reachable. The global shell
   * history is not a source here: it is unattributed (no connection id, so
   * entries typed against unauthorized hosts and local shells cannot be
   * filtered out) and routinely carries inline credentials.
   */
  source: "library";
}

// ─── Dependencies ───────────────────────────────────────────────────────────

export interface AgentAuditEntry {
  action: string;
  level: "info" | "warn" | "error";
  connectionId?: string;
  message: string;
  metadata?: Record<string, unknown>;
}

/**
 * Narrow view of the main-process services the gateway needs. Kept as an
 * interface (rather than `ServiceContainer`) so the authorization surface
 * cannot reach anything it was not explicitly handed.
 */
export interface AgentGatewayDeps {
  listConnections: () => ConnectionProfile[];
  isConnectionOnline: (connectionId: string) => boolean;
  listSessions: () => AgentSessionInfo[];
  getMonitorSnapshot: (connectionId: string) => Promise<MonitorSnapshot | null>;
  listRemoteFiles: (connectionId: string, remotePath: string) => Promise<RemoteFileEntry[]>;
  statRemoteFile: (connectionId: string, remotePath: string) => Promise<AgentRemoteFileStat>;
  readRemoteFile: (
    connectionId: string,
    remotePath: string,
    maxBytes: number,
    signal: AbortSignal
  ) => Promise<AgentRemoteFileChunk>;
  listSavedCommands: (query: { keyword?: string; group?: string }) => SavedCommand[];
  /** Must append unconditionally — agent activity is audited even when the user disabled audit capture. */
  appendAuditLog: (entry: AgentAuditEntry) => void;
  getPreferences: () => AppPreferences;
  now?: () => number;
}

export interface AgentGatewayLimits {
  /** Sliding-window call budget per MCP client. */
  callsPerMinute: number;
  /** Concurrent in-flight calls against a single host. */
  perHostConcurrency: number;
  /** Ceiling applied on top of `preferences.agent.execTimeoutSec`. */
  maxCallTimeoutMs: number;
  maxListItems: number;
  maxFileBytes: number;
}

export const DEFAULT_AGENT_GATEWAY_LIMITS: AgentGatewayLimits = {
  callsPerMinute: 60,
  perHostConcurrency: 4,
  maxCallTimeoutMs: 120_000,
  maxListItems: 500,
  maxFileBytes: 256 * 1024
};

export interface AgentGatewayOptions {
  limits?: Partial<AgentGatewayLimits>;
}

export type AgentAccessRequirement = "read" | "write";

export interface AgentResolvedTarget {
  connection: ConnectionProfile;
  summary: ServerSummary;
  level: Exclude<AgentAccessLevel, "off">;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const AGENT_REDACTED = "«redacted»";
const RATE_WINDOW_MS = 60_000;
const BINARY_SNIFF_BYTES = 4096;

const accessLevelOf = (connection: ConnectionProfile): AgentAccessLevel =>
  connection.agentAccess ?? "off";

const isAgentVisible = (connection: ConnectionProfile): boolean =>
  accessLevelOf(connection) !== "off";

/**
 * Patterns the shared audit redactor misses, verified against real command
 * lines: `DB_PASSWORD=x` (its `\bpass` boundary never matches after `_`),
 * `scheme://user:pass@host`, `-u user:pass`, and a quoted value glued to the
 * flag (`-p'x'`, which its unquoted `-p<value>` rule skips).
 */
const COMMAND_SECRET_RULES: Array<{ re: RegExp; replace: string }> = [
  // FOO_PASSWORD=secret / AWS_SECRET_ACCESS_KEY=secret / api-key="secret"
  {
    re: /([A-Za-z0-9_.-]*(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|passphrase|credential|auth)[A-Za-z0-9_.-]*\s*=\s*)("[^"]*"|'[^']*'|[^\s]+)/gi,
    replace: `$1${AGENT_REDACTED}`
  },
  // scheme://user:password@host
  { re: /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(@)/gi, replace: `$1${AGENT_REDACTED}$2` },
  // curl -u user:password — only the `user:pass` form; a bare `-u user` prompts.
  {
    re: /((?:^|\s)(?:-u|--user)[=\s]+["']?[^\s:"']+:)[^\s"']+/g,
    replace: `$1${AGENT_REDACTED}`
  },
  // -p'secret' / -a"secret": quoted value glued to the flag.
  { re: /((?:^|\s)-[pa])("[^"]*"|'[^']*')/g, replace: `$1${AGENT_REDACTED}` },
  {
    re: /((?:^|\s)--(?:password|passwd|token|secret|passphrase)[=\s]+)("[^"]*"|'[^']*'|[^\s]+)/gi,
    replace: `$1${AGENT_REDACTED}`
  },
  // sshpass -p secret as a separate argument. Scoped to sshpass on purpose:
  // a blanket `-p <value>` rule would also redact `docker run -p 8080:80`.
  {
    re: /(\bsshpass\s+(?:-\S+\s+)*?-p[=\s]+)("[^"]*"|'[^']*'|[^\s]+)/gi,
    replace: `$1${AGENT_REDACTED}`
  },
  // echo 'secret' | sudo -S …  — the piped-in value is a password by construction
  {
    re: /((?:^|\s)echo\s+)("[^"]*"|'[^']*'|[^\s|]+)(\s*\|\s*(?:\S*\s+)*sudo\s+(?:-\S+\s+)*-S\b)/gi,
    replace: `$1${AGENT_REDACTED}$3`
  }
];

/**
 * Layered on top of the shared audit redactor rather than replacing it: neither
 * set is complete, and command text is the one agent-facing surface where a
 * miss means a plaintext credential leaves the app.
 */
const redactText = (value: string): string => {
  const redacted = redactAuditMetadata({ value });
  const base = redacted?.value;
  let out = typeof base === "string" ? base : AGENT_REDACTED;
  for (const rule of COMMAND_SECRET_RULES) {
    out = out.replace(rule.re, rule.replace);
  }
  return out;
};

const clampInt = (
  value: number | undefined,
  fallback: number,
  min: number,
  max: number
): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
};

const ERROR_PATTERNS: Array<{ re: RegExp; code: AgentErrorCode; message: string }> = [
  { re: /no such file|enoent|does not exist/i, code: "not_found", message: "Path does not exist" },
  {
    re: /permission denied|eacces|eperm|access denied/i,
    code: "forbidden",
    message: "The remote host denied access to that path"
  },
  { re: /eisdir|is a directory/i, code: "invalid_argument", message: "Path is a directory" },
  { re: /enotdir|not a directory/i, code: "invalid_argument", message: "Path is not a directory" },
  {
    re: /etimedout|timed ?out/i,
    code: "timeout",
    message: "The remote host did not respond in time"
  },
  {
    re: /econnrefused|econnreset|ehostunreach|not connected|connection closed|channel open failure/i,
    code: "unavailable",
    message: "The host connection is unavailable"
  }
];

/**
 * Exception text is an exfiltration surface (it carries paths, hosts and
 * occasionally credentials), so nothing from the original error reaches the
 * agent: only a code and a fixed sentence chosen by pattern match.
 */
const classifyError = (error: unknown): AgentToolError => {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  for (const pattern of ERROR_PATTERNS) {
    if (pattern.re.test(raw)) {
      return { code: pattern.code, message: pattern.message };
    }
  }
  return { code: "internal", message: "The operation failed" };
};

/**
 * Absolute POSIX paths only: relative paths would silently resolve against a
 * server-side default the agent cannot see.
 */
export const normalizeRemotePath = (input: string): AgentToolResult<string> => {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, error: { code: "invalid_argument", message: "path must not be empty" } };
  }
  if (trimmed.includes("\0")) {
    return {
      ok: false,
      error: { code: "invalid_argument", message: "path must not contain NUL bytes" }
    };
  }
  if (!trimmed.startsWith("/")) {
    return {
      ok: false,
      error: {
        code: "invalid_argument",
        message: "path must be absolute (start with /); ~ and relative paths are not accepted"
      }
    };
  }

  const resolved: string[] = [];
  for (const segment of trimmed.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return { ok: true, data: `/${resolved.join("/")}` };
};

const looksBinary = (bytes: Buffer): boolean => {
  const window = bytes.subarray(0, BINARY_SNIFF_BYTES);
  for (const byte of window) {
    if (byte === 0) {
      return true;
    }
  }
  return false;
};

// ─── Gateway ────────────────────────────────────────────────────────────────

/**
 * The single authorization surface for MCP tool calls. Tools never touch the
 * service container directly: every call goes through `execute`, which applies
 * host authorization, rate limiting, per-host concurrency, a timeout, output
 * truncation and audit logging.
 */
export class AgentGateway {
  private readonly deps: AgentGatewayDeps;
  private readonly limits: AgentGatewayLimits;
  private readonly callWindows = new Map<string, number[]>();
  private readonly hostInflight = new Map<string, number>();

  constructor(deps: AgentGatewayDeps, options: AgentGatewayOptions = {}) {
    this.deps = deps;
    this.limits = { ...DEFAULT_AGENT_GATEWAY_LIMITS, ...options.limits };
  }

  get gatewayLimits(): AgentGatewayLimits {
    return this.limits;
  }

  /**
   * Drops buckets that have fully aged out. Deliberately not keyed on client
   * disconnect: a client that reconnects must inherit its remaining budget,
   * otherwise reconnecting is a free rate-limit reset.
   */
  pruneRateLimits(): void {
    const now = this.now();
    for (const [key, window] of this.callWindows) {
      const live = window.filter((timestamp) => now - timestamp < RATE_WINDOW_MS);
      if (live.length === 0) {
        this.callWindows.delete(key);
      } else {
        this.callWindows.set(key, live);
      }
    }
  }

  /**
   * Connections the agent is allowed to know about at all. `off` (including a
   * missing field) means the host does not exist as far as MCP is concerned.
   */
  private authorizedConnections(): ConnectionProfile[] {
    return this.deps.listConnections().filter(isAgentVisible);
  }

  /**
   * Unauthorized hosts resolve to `not_found`, never to `forbidden`: the agent
   * must not be able to tell "exists but not granted" from "does not exist".
   */
  resolveTarget(
    target: string,
    requirement: AgentAccessRequirement
  ): AgentToolResult<AgentResolvedTarget> {
    let resolved;
    try {
      resolved = resolveConnectionTarget(this.authorizedConnections(), target);
    } catch (error) {
      if (error instanceof ConnectionTargetAmbiguousError) {
        return {
          ok: false,
          error: {
            code: "ambiguous",
            message: `"${target}" matches ${error.candidates.length} hosts; pass one of the candidate nameId values`,
            candidates: error.candidates
          }
        };
      }
      if (error instanceof ConnectionTargetNotFoundError) {
        return {
          ok: false,
          error: {
            code: "not_found",
            message: `No host available to the agent matches "${target}"`
          }
        };
      }
      return { ok: false, error: classifyError(error) };
    }

    const level = accessLevelOf(resolved.connection);
    if (level === "off") {
      return {
        ok: false,
        error: { code: "not_found", message: `No host available to the agent matches "${target}"` }
      };
    }
    if (requirement === "write" && level !== "full") {
      return {
        ok: false,
        error: {
          code: "forbidden",
          message: `Host "${resolved.summary.name}" is granted read-only access to the agent`
        }
      };
    }
    return {
      ok: true,
      data: { connection: resolved.connection, summary: resolved.summary, level }
    };
  }

  // ─── Call plumbing ────────────────────────────────────────────────────────

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private checkRateLimit(clientId: string): AgentToolError | null {
    const now = this.now();
    const window = (this.callWindows.get(clientId) ?? []).filter(
      (timestamp) => now - timestamp < RATE_WINDOW_MS
    );
    if (window.length >= this.limits.callsPerMinute) {
      this.callWindows.set(clientId, window);
      return {
        code: "rate_limited",
        message: `Rate limit reached (${this.limits.callsPerMinute} calls/minute); retry shortly`
      };
    }
    window.push(now);
    this.callWindows.set(clientId, window);
    return null;
  }

  private callTimeoutMs(): number {
    const seconds = this.deps.getPreferences().agent.execTimeoutSec;
    const millis = clampInt(seconds, 60, 1, 3600) * 1000;
    return Math.min(millis, this.limits.maxCallTimeoutMs);
  }

  private audit(
    client: AgentClientIdentity,
    tool: string,
    params: Record<string, unknown>,
    outcome: { code: "ok" | AgentErrorCode; connectionId?: string; level: "info" | "warn" }
  ): void {
    try {
      this.deps.appendAuditLog({
        action: `agent.${tool}`,
        level: outcome.level,
        connectionId: outcome.connectionId,
        message: `Agent tool ${tool} → ${outcome.code}`,
        metadata: {
          client: client.name ?? "unknown",
          clientVersion: client.version ?? "unknown",
          clientSessionId: client.id,
          transport: client.transport,
          tool,
          params: redactAuditMetadata(params) ?? {},
          result: outcome.code
        }
      });
    } catch {
      // Audit must never break a tool call.
    }
  }

  /**
   * Rate limit → per-host concurrency → timeout → error sanitization → audit.
   * The task is handed an `AbortSignal` that fires on timeout: without it a
   * timed-out call would only stop the caller waiting while the underlying
   * SSH/SFTP work kept consuming memory in the background.
   */
  private async execute<T>(
    client: AgentClientIdentity,
    tool: string,
    params: Record<string, unknown>,
    task: (signal: AbortSignal) => Promise<T>,
    connectionId?: string
  ): Promise<AgentToolResult<T>> {
    const rateError = this.checkRateLimit(client.rateKey);
    if (rateError) {
      this.audit(client, tool, params, { code: rateError.code, connectionId, level: "warn" });
      return { ok: false, error: rateError };
    }

    if (connectionId) {
      const inflight = this.hostInflight.get(connectionId) ?? 0;
      if (inflight >= this.limits.perHostConcurrency) {
        const error: AgentToolError = {
          code: "busy",
          message: `Too many concurrent calls against this host (limit ${this.limits.perHostConcurrency})`
        };
        this.audit(client, tool, params, { code: error.code, connectionId, level: "warn" });
        return { ok: false, error };
      }
      this.hostInflight.set(connectionId, inflight + 1);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
      const timeoutMs = this.callTimeoutMs();
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("ETIMEDOUT: agent tool call timed out"));
        }, timeoutMs);
      });
      const data = await Promise.race([task(controller.signal), timeout]);
      this.audit(client, tool, params, { code: "ok", connectionId, level: "info" });
      return { ok: true, data };
    } catch (error) {
      const toolError = error instanceof AgentToolFailure ? error.toolError : classifyError(error);
      this.audit(client, tool, params, { code: toolError.code, connectionId, level: "warn" });
      return { ok: false, error: toolError };
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      if (connectionId) {
        const inflight = this.hostInflight.get(connectionId) ?? 1;
        if (inflight <= 1) {
          this.hostInflight.delete(connectionId);
        } else {
          this.hostInflight.set(connectionId, inflight - 1);
        }
      }
    }
  }

  private failed<T>(
    client: AgentClientIdentity,
    tool: string,
    params: Record<string, unknown>,
    error: AgentToolError,
    connectionId?: string
  ): AgentToolResult<T> {
    this.audit(client, tool, params, { code: error.code, connectionId, level: "warn" });
    return { ok: false, error };
  }

  // ─── Host views ───────────────────────────────────────────────────────────

  private toHostInfo(connection: ConnectionProfile, sessions: AgentSessionInfo[]): AgentHostInfo {
    const summary = buildServerSummary(connection);
    const level = accessLevelOf(connection);
    const active = sessions.filter(
      (session) => session.connectionId === connection.id && session.status !== "disconnected"
    ).length;
    return {
      nameId: summary.nameId,
      name: summary.name,
      host: summary.host,
      port: summary.port,
      user: connection.username,
      groupPath: summary.groupPath,
      tags: summary.tags,
      favorite: summary.favorite,
      access: level === "full" ? "full" : "readonly",
      connected: this.safeOnline(connection.id),
      activeSessions: active,
      lastConnectedAt: connection.lastConnectedAt ?? null
    };
  }

  private safeOnline(connectionId: string): boolean {
    try {
      return this.deps.isConnectionOnline(connectionId);
    } catch {
      return false;
    }
  }

  private authorizedSessions(): AgentSessionInfo[] {
    const allowed = new Set(this.authorizedConnections().map((connection) => connection.id));
    return this.deps
      .listSessions()
      .filter((session) => session.connectionId !== null && allowed.has(session.connectionId));
  }

  // ─── Tier 0 tool surface ──────────────────────────────────────────────────

  async listHosts(
    client: AgentClientIdentity,
    input: { query?: string; limit?: number }
  ): Promise<AgentToolResult<AgentHostListPayload>> {
    const limit = clampInt(input.limit, 50, 1, this.limits.maxListItems);
    return this.execute(client, "host_list", { query: input.query ?? "", limit }, async () => {
      const connections = this.authorizedConnections();
      const sessions = this.authorizedSessions();
      const query = input.query?.trim() ?? "";
      const summaries = query
        ? searchServerSummaries(connections, query, connections.length)
        : listServerSummaries(connections);
      const byNameId = new Map(
        connections.map((connection) => [buildServerSummary(connection).nameId, connection])
      );
      const hosts = summaries
        .slice(0, limit)
        .map((summary) => byNameId.get(summary.nameId))
        .filter((connection): connection is ConnectionProfile => connection !== undefined)
        .map((connection) => this.toHostInfo(connection, sessions));
      return { hosts, total: summaries.length, truncated: summaries.length > hosts.length };
    });
  }

  async describeHost(
    client: AgentClientIdentity,
    input: { target: string }
  ): Promise<AgentToolResult<AgentHostDetail>> {
    const resolved = this.resolveTarget(input.target, "read");
    if (!resolved.ok) {
      return this.failed(client, "host_describe", { target: input.target }, resolved.error);
    }
    const connection = resolved.data.connection;
    return this.execute(
      client,
      "host_describe",
      { target: input.target },
      async () => {
        const sessions = this.authorizedSessions();
        const info = this.toHostInfo(connection, sessions);
        let monitor: MonitorSnapshot | null;
        try {
          monitor = await this.deps.getMonitorSnapshot(connection.id);
        } catch {
          monitor = null;
        }
        return {
          ...info,
          sessions: sessions.filter((session) => session.connectionId === connection.id),
          monitor
        };
      },
      connection.id
    );
  }

  async listSessions(
    client: AgentClientIdentity,
    input: { target?: string }
  ): Promise<AgentToolResult<AgentSessionListPayload>> {
    let connectionId: string | undefined;
    if (input.target) {
      const resolved = this.resolveTarget(input.target, "read");
      if (!resolved.ok) {
        return this.failed(client, "session_list", { target: input.target }, resolved.error);
      }
      connectionId = resolved.data.connection.id;
    }

    return this.execute(
      client,
      "session_list",
      { target: input.target ?? "" },
      async () => {
        const sessions = this.authorizedSessions().filter(
          (session) => !connectionId || session.connectionId === connectionId
        );
        const capped = sessions.slice(0, this.limits.maxListItems);
        return { sessions: capped, truncated: capped.length < sessions.length };
      },
      connectionId
    );
  }

  async listFiles(
    client: AgentClientIdentity,
    input: { target: string; path: string; limit?: number }
  ): Promise<AgentToolResult<AgentFileListPayload>> {
    const params = { target: input.target, path: input.path };
    const resolved = this.resolveTarget(input.target, "read");
    if (!resolved.ok) {
      return this.failed(client, "file_list", params, resolved.error);
    }
    const normalized = normalizeRemotePath(input.path);
    if (!normalized.ok) {
      return this.failed(
        client,
        "file_list",
        params,
        normalized.error,
        resolved.data.connection.id
      );
    }

    const connectionId = resolved.data.connection.id;
    const limit = clampInt(input.limit, this.limits.maxListItems, 1, this.limits.maxListItems);
    return this.execute(
      client,
      "file_list",
      params,
      async () => {
        const entries = await this.deps.listRemoteFiles(connectionId, normalized.data);
        const capped = entries.slice(0, limit).map((entry) => ({
          name: entry.name,
          path: entry.path,
          type: entry.type,
          size: entry.size,
          permissions: entry.permissions,
          owner: entry.owner,
          group: entry.group,
          modifiedAt: entry.modifiedAt
        }));
        return {
          path: normalized.data,
          entries: capped,
          total: entries.length,
          truncated: capped.length < entries.length
        };
      },
      connectionId
    );
  }

  async statFile(
    client: AgentClientIdentity,
    input: { target: string; path: string }
  ): Promise<AgentToolResult<AgentRemoteFileStat>> {
    const params = { target: input.target, path: input.path };
    const resolved = this.resolveTarget(input.target, "read");
    if (!resolved.ok) {
      return this.failed(client, "file_stat", params, resolved.error);
    }
    const normalized = normalizeRemotePath(input.path);
    if (!normalized.ok) {
      return this.failed(
        client,
        "file_stat",
        params,
        normalized.error,
        resolved.data.connection.id
      );
    }

    const connectionId = resolved.data.connection.id;
    return this.execute(
      client,
      "file_stat",
      params,
      () => this.deps.statRemoteFile(connectionId, normalized.data),
      connectionId
    );
  }

  /**
   * The stat is an early-exit courtesy only — `st_size` lies for procfs/sysfs
   * and can change between the stat and the read, so the real ceiling is the
   * byte budget `readRemoteFile` enforces while streaming.
   */
  async readFile(
    client: AgentClientIdentity,
    input: { target: string; path: string; maxBytes?: number }
  ): Promise<AgentToolResult<AgentFileReadPayload>> {
    const params = { target: input.target, path: input.path };
    const resolved = this.resolveTarget(input.target, "read");
    if (!resolved.ok) {
      return this.failed(client, "file_read", params, resolved.error);
    }
    const normalized = normalizeRemotePath(input.path);
    if (!normalized.ok) {
      return this.failed(
        client,
        "file_read",
        params,
        normalized.error,
        resolved.data.connection.id
      );
    }

    const connectionId = resolved.data.connection.id;
    const budget = clampInt(input.maxBytes, this.limits.maxFileBytes, 1, this.limits.maxFileBytes);
    return this.execute(
      client,
      "file_read",
      params,
      async (signal) => {
        const stat = await this.deps.statRemoteFile(connectionId, normalized.data);
        if (stat.type === "directory") {
          throw new AgentToolFailure({
            code: "invalid_argument",
            message: "Path is a directory; use file_list instead"
          });
        }
        if (stat.type === "other") {
          throw new AgentToolFailure({
            code: "invalid_argument",
            message: "Path is not a regular file (device, socket or fifo)"
          });
        }
        if (stat.size > this.limits.maxFileBytes) {
          throw new AgentToolFailure({
            code: "too_large",
            message: `File is ${stat.size} bytes; the agent read limit is ${this.limits.maxFileBytes} bytes`
          });
        }

        const chunk = await this.deps.readRemoteFile(
          connectionId,
          normalized.data,
          budget,
          signal
        );
        const bytes = chunk.bytes.subarray(0, budget);
        const truncated = chunk.truncated || chunk.bytes.byteLength > budget;
        const binary = looksBinary(bytes);
        return {
          path: normalized.data,
          encoding: binary ? ("base64" as const) : ("utf-8" as const),
          content: binary ? bytes.toString("base64") : bytes.toString("utf8"),
          bytes: bytes.byteLength,
          size: stat.size,
          truncated
        };
      },
      connectionId
    );
  }

  async monitorSnapshot(
    client: AgentClientIdentity,
    input: { target: string }
  ): Promise<AgentToolResult<MonitorSnapshot>> {
    const params = { target: input.target };
    const resolved = this.resolveTarget(input.target, "read");
    if (!resolved.ok) {
      return this.failed(client, "monitor_snapshot", params, resolved.error);
    }
    const connectionId = resolved.data.connection.id;
    return this.execute(
      client,
      "monitor_snapshot",
      params,
      async () => {
        const snapshot = await this.deps.getMonitorSnapshot(connectionId);
        if (!snapshot) {
          throw new AgentToolFailure({
            code: "unavailable",
            message: "No monitor snapshot is available for this host yet"
          });
        }
        return snapshot;
      },
      connectionId
    );
  }

  /**
   * Only the saved command library — the entries the user deliberately curated
   * in-app. The global shell history is deliberately unreachable: it has no
   * connection id (see `CommandHistoryEntry`), so commands typed against
   * unauthorized hosts and local shells cannot be told apart from authorized
   * ones, and its lines regularly carry inline credentials. Entries naming an
   * unauthorized host are still dropped and every line is redacted.
   */
  async searchCommands(
    client: AgentClientIdentity,
    input: { query?: string; limit?: number }
  ): Promise<AgentToolResult<AgentCommandSearchPayload>> {
    const limit = clampInt(input.limit, 30, 1, this.limits.maxListItems);
    const query = input.query?.trim().toLowerCase() ?? "";
    return this.execute(client, "command_search", { query, limit }, async () => {
      const forbiddenTokens = this.deps
        .listConnections()
        .filter((connection) => !isAgentVisible(connection))
        .flatMap((connection) => [connection.host, connection.name])
        .map((token) => token.trim().toLowerCase())
        .filter((token) => token.length >= 3);

      const mentionsForbiddenHost = (command: string): boolean => {
        const lowered = command.toLowerCase();
        return forbiddenTokens.some((token) => lowered.includes(token));
      };

      const matches: AgentCommandMatch[] = [];
      for (const item of this.deps.listSavedCommands(query ? { keyword: query } : {})) {
        if (mentionsForbiddenHost(item.command)) {
          continue;
        }
        matches.push({
          command: redactText(item.command),
          source: "library",
          name: item.name,
          group: item.group,
          lastUsedAt: item.updatedAt
        });
      }

      const capped = matches.slice(0, limit);
      return {
        matches: capped,
        total: matches.length,
        truncated: capped.length < matches.length,
        source: "library" as const
      };
    });
  }
}
