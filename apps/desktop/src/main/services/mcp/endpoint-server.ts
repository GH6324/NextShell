import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AgentConnectedClient } from "@nextshell/shared";

import type { AgentClientIdentity, AgentTransportKind } from "./agent-gateway";

/** macOS `sun_path` is 104 bytes; a longer path makes `listen()` fail with EINVAL. */
export const MAX_UNIX_SOCKET_PATH_BYTES = 104;

const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;
const MCP_PATHS = new Set(["/", "/mcp"]);

/**
 * A client that is SIGKILLed never sends the DELETE that closes its transport,
 * so sessions have to expire on their own or every crashed client leaks an
 * `McpServer` for the lifetime of the app.
 */
export const DEFAULT_MAX_SESSIONS = 32;
export const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 10 * 60_000;
const SESSION_SWEEP_INTERVAL_MS = 30_000;

export interface AgentLogger {
  info?: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
  error?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface McpEndpointServerOptions {
  socketEnabled: boolean;
  tcpEnabled: boolean;
  /** 0 lets the OS pick; the resolved port is readable from `tcpPort` after start. */
  tcpPort: number;
  /** Required when `tcpEnabled`; unused (and not issued) for socket listeners. */
  token: string | null;
  /** Unix socket path or Windows named pipe. Defaults to a short tmpdir path. */
  socketPath?: string;
  createMcpServer: (identity: AgentClientIdentity) => McpServer;
  onClientsChanged?: (clients: AgentConnectedClient[]) => void;
  /** Extra exact-match Host header values accepted on top of the loopback set. */
  extraAllowedHosts?: string[];
  /** Concurrent MCP sessions; further `initialize` requests get 503. */
  maxSessions?: number;
  /** Sessions with no request and no open stream for this long are torn down. */
  sessionIdleTimeoutMs?: number;
  /** Test seam for the idle sweep. */
  now?: () => number;
  logger?: AgentLogger;
}

export class AgentEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentEndpointError";
  }
}

interface SessionEntry {
  id: string;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  identity: AgentClientIdentity;
  connectedAt: string;
  lastSeenAt: number;
  /** Responses still streaming (SSE); an idle session with one is not dead. */
  openStreams: number;
}

const isWindows = process.platform === "win32";

/**
 * Socket lives in a short path because of {@link MAX_UNIX_SOCKET_PATH_BYTES};
 * the endpoint discovery file is the thing that goes under userData.
 */
export const resolveDefaultSocketPath = (pid: number = process.pid): string => {
  if (isWindows) {
    return `\\\\.\\pipe\\nextshell-mcp-${pid}`;
  }
  const candidates = [os.tmpdir(), "/tmp"];
  for (const base of candidates) {
    const candidate = path.join(base, `nextshell-mcp-${pid}`, "mcp.sock");
    if (Buffer.byteLength(candidate) <= MAX_UNIX_SOCKET_PATH_BYTES) {
      return candidate;
    }
  }
  throw new AgentEndpointError(
    `No socket path under ${MAX_UNIX_SOCKET_PATH_BYTES} bytes is available for the MCP endpoint`
  );
};

const readRequestBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.byteLength;
    if (size > MAX_REQUEST_BODY_BYTES) {
      throw new AgentEndpointError("Request body too large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return undefined;
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
};

/** Length is compared first: `timingSafeEqual` throws on unequal buffer sizes. */
export const isTokenValid = (expected: string | null, presented: string | null): boolean => {
  if (!expected || !presented) {
    return false;
  }
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  return timingSafeEqual(a, b);
};

const extractBearer = (header: string | undefined): string | null => {
  if (!header) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
};

const jsonRpcError = (res: ServerResponse, status: number, code: number, message: string): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
};

const readClientInfo = (body: unknown): { name: string | null; version: string | null } => {
  const params = (body as { params?: { clientInfo?: { name?: unknown; version?: unknown } } })
    ?.params;
  const info = params?.clientInfo;
  return {
    name: typeof info?.name === "string" ? info.name : null,
    version: typeof info?.version === "string" ? info.version : null
  };
};

/**
 * The rate-limit bucket a client falls into. Sessions are cheap to recreate, so
 * anything derived from the session id would be a free budget reset; the
 * transport plus the self-reported client name is the most stable identifier
 * available before Phase 1 adds per-client approval.
 */
export const buildClientRateKey = (
  transport: AgentTransportKind,
  clientName: string | null
): string => `${transport}:${(clientName ?? "unknown").trim().toLowerCase() || "unknown"}`;

/**
 * One `http.Server` per listener (Unix socket and optional loopback TCP) sharing
 * a single request handler and a single session map — a server instance cannot
 * `listen()` twice.
 */
export class McpEndpointServer {
  private readonly options: McpEndpointServerOptions;
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly openSockets = new Set<Socket>();
  private readonly maxSessions: number;
  private readonly idleTimeoutMs: number;
  private socketServer: Server | null = null;
  private tcpServer: Server | null = null;
  private activeSocketPath: string | null = null;
  private activeTcpPort: number | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: McpEndpointServerOptions) {
    this.options = options;
    this.maxSessions = Math.max(1, options.maxSessions ?? DEFAULT_MAX_SESSIONS);
    this.idleTimeoutMs = Math.max(
      1_000,
      options.sessionIdleTimeoutMs ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS
    );
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  get listening(): boolean {
    return this.socketServer !== null || this.tcpServer !== null;
  }

  get socketPath(): string | null {
    return this.activeSocketPath;
  }

  get tcpPort(): number | null {
    return this.activeTcpPort;
  }

  getClients(): AgentConnectedClient[] {
    return [...this.sessions.values()].map((entry) => ({
      id: entry.id,
      name: entry.identity.name,
      version: entry.identity.version,
      transport: entry.identity.transport,
      connectedAt: entry.connectedAt
    }));
  }

  async start(): Promise<void> {
    if (this.listening) {
      return;
    }
    if (!this.options.socketEnabled && !this.options.tcpEnabled) {
      throw new AgentEndpointError("No listener is enabled for the MCP endpoint");
    }
    if (this.options.tcpEnabled && !this.options.token) {
      throw new AgentEndpointError("A bearer token is required for the loopback TCP listener");
    }

    try {
      if (this.options.socketEnabled) {
        await this.startSocketListener();
      }
      if (this.options.tcpEnabled) {
        await this.startTcpListener();
      }
    } catch (error) {
      await this.stop();
      throw error;
    }

    this.sweepTimer = setInterval(() => {
      void this.sweepIdleSessions();
    }, SESSION_SWEEP_INTERVAL_MS);
    // Never keep the event loop (and therefore the app quit) alive.
    this.sweepTimer.unref?.();
  }

  /** Exposed for tests; the interval calls it. */
  async sweepIdleSessions(): Promise<void> {
    const now = this.now();
    const expired = [...this.sessions.values()].filter(
      (entry) => entry.openStreams === 0 && now - entry.lastSeenAt >= this.idleTimeoutMs
    );
    if (expired.length === 0) {
      return;
    }
    for (const entry of expired) {
      this.sessions.delete(entry.id);
    }
    await Promise.all(expired.map((entry) => this.closeSession(entry)));
    this.options.logger?.info?.("Evicted idle MCP sessions", { count: expired.length });
    this.options.onClientsChanged?.(this.getClients());
  }

  private async closeSession(entry: SessionEntry): Promise<void> {
    try {
      await entry.transport.close();
    } catch {
      // Already gone.
    }
    try {
      await entry.server.close();
    } catch {
      // Already gone.
    }
  }

  private async startSocketListener(): Promise<void> {
    const socketPath = this.options.socketPath ?? resolveDefaultSocketPath();
    if (!isWindows && Buffer.byteLength(socketPath) > MAX_UNIX_SOCKET_PATH_BYTES) {
      throw new AgentEndpointError(
        `Socket path exceeds ${MAX_UNIX_SOCKET_PATH_BYTES} bytes: ${socketPath}`
      );
    }

    if (!isWindows) {
      // 0700 before listen; the socket itself is only chmod-able afterwards and
      // defaults to 0777 & ~umask, so the parent directory closes that window.
      await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
      await chmod(path.dirname(socketPath), 0o700).catch(() => undefined);
      await this.removeStaleSocket(socketPath);
    }

    const server = createServer(this.createRequestListener("socket"));
    this.trackConnections(server);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(socketPath, () => {
        server.off("error", onError);
        resolve();
      });
    });

    if (!isWindows) {
      await chmod(socketPath, 0o600);
    }
    this.socketServer = server;
    this.activeSocketPath = socketPath;
    this.options.logger?.info?.("MCP endpoint listening on socket", { socketPath });
  }

  private async removeStaleSocket(socketPath: string): Promise<void> {
    try {
      await stat(socketPath);
    } catch {
      return;
    }
    await rm(socketPath, { force: true });
  }

  private async startTcpListener(): Promise<void> {
    const server = createServer(this.createRequestListener("tcp"));
    this.trackConnections(server);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(this.options.tcpPort, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    });

    const address = server.address();
    this.activeTcpPort = typeof address === "object" && address !== null ? address.port : null;
    this.tcpServer = server;
    this.options.logger?.info?.("MCP endpoint listening on loopback TCP", {
      port: this.activeTcpPort
    });
  }

  private trackConnections(server: Server): void {
    server.on("connection", (socket: Socket) => {
      this.openSockets.add(socket);
      socket.on("close", () => {
        this.openSockets.delete(socket);
      });
    });
  }

  /**
   * chmod and file removal only affect *new* connections, so revoking access
   * has to tear down the live sockets as well.
   */
  async disconnectClients(): Promise<void> {
    const entries = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(entries.map((entry) => this.closeSession(entry)));
    for (const socket of this.openSockets) {
      socket.destroy();
    }
    this.openSockets.clear();
    this.options.onClientsChanged?.(this.getClients());
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    await this.disconnectClients();

    const closeServer = async (server: Server | null): Promise<void> => {
      if (!server) {
        return;
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    };

    await closeServer(this.socketServer);
    await closeServer(this.tcpServer);
    this.socketServer = null;
    this.tcpServer = null;

    const socketPath = this.activeSocketPath;
    this.activeSocketPath = null;
    this.activeTcpPort = null;

    if (socketPath && !isWindows) {
      await rm(socketPath, { force: true }).catch(() => undefined);
      await rm(path.dirname(socketPath), { force: true, recursive: true }).catch(() => undefined);
    }
  }

  // ─── Request handling ─────────────────────────────────────────────────────

  private allowedHosts(): Set<string> {
    const hosts = new Set<string>(["localhost", "127.0.0.1", "[::1]"]);
    const port = this.activeTcpPort ?? this.options.tcpPort;
    if (port) {
      hosts.add(`localhost:${port}`);
      hosts.add(`127.0.0.1:${port}`);
      hosts.add(`[::1]:${port}`);
    }
    for (const host of this.options.extraAllowedHosts ?? []) {
      hosts.add(host);
    }
    return hosts;
  }

  /**
   * Exact-match Host allowlist plus a loopback-only Origin check. A missing
   * Host header is rejected: Node clients over UDS still send `Host: localhost`.
   */
  private isRequestOriginAllowed(req: IncomingMessage): boolean {
    const host = req.headers.host;
    if (!host || !this.allowedHosts().has(host.toLowerCase())) {
      return false;
    }
    const origin = req.headers.origin;
    if (typeof origin === "string" && origin.length > 0 && origin !== "null") {
      try {
        const parsed = new URL(origin);
        if (
          parsed.hostname !== "localhost" &&
          parsed.hostname !== "127.0.0.1" &&
          parsed.hostname !== "::1"
        ) {
          return false;
        }
      } catch {
        return false;
      }
    }
    return true;
  }

  private createRequestListener(
    transport: AgentTransportKind
  ): (req: IncomingMessage, res: ServerResponse) => void {
    return (req, res) => {
      void this.handleRequest(transport, req, res).catch((error: unknown) => {
        this.options.logger?.error?.("MCP endpoint request failed", {
          error: error instanceof Error ? error.message : String(error)
        });
        if (!res.headersSent) {
          jsonRpcError(res, 500, -32603, "Internal error");
        } else {
          res.end();
        }
      });
    };
  }

  private async handleRequest(
    transport: AgentTransportKind,
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const url = (req.url ?? "/").split("?")[0] ?? "/";
    if (!MCP_PATHS.has(url)) {
      jsonRpcError(res, 404, -32601, "Not found");
      return;
    }
    if (!this.isRequestOriginAllowed(req)) {
      jsonRpcError(res, 403, -32600, "Forbidden");
      return;
    }
    if (transport === "tcp") {
      const presented = extractBearer(req.headers.authorization);
      if (!isTokenValid(this.options.token, presented)) {
        res.writeHead(401, {
          "content-type": "application/json",
          "www-authenticate": 'Bearer realm="nextshell"'
        });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Unauthorized" },
            id: null
          })
        );
        return;
      }
    }

    let body: unknown;
    if (req.method === "POST") {
      try {
        body = await readRequestBody(req);
      } catch {
        jsonRpcError(res, 400, -32700, "Parse error");
        return;
      }
    }

    const sessionId = req.headers["mcp-session-id"];
    const existing = typeof sessionId === "string" ? this.sessions.get(sessionId) : undefined;
    if (existing) {
      this.trackActivity(existing, res);
      await existing.transport.handleRequest(req, res, body);
      return;
    }

    if (req.method !== "POST" || !isInitializeRequest(body)) {
      jsonRpcError(res, 400, -32000, "No valid MCP session; send an initialize request first");
      return;
    }

    if (this.sessions.size >= this.maxSessions) {
      // One last chance to reclaim whatever the sweep timer has not yet noticed.
      await this.sweepIdleSessions();
    }
    if (this.sessions.size >= this.maxSessions) {
      this.options.logger?.warn?.("Refused an MCP session: concurrency limit reached", {
        limit: this.maxSessions
      });
      jsonRpcError(res, 503, -32000, "Too many MCP sessions; close an existing one and retry");
      return;
    }

    const entry = await this.createSession(transport, body);
    this.trackActivity(entry, res);
    await entry.transport.handleRequest(req, res, body);
  }

  /**
   * Marks the session live and counts responses that stay open (SSE streams), so
   * a client that only listens is not mistaken for a dead one.
   */
  private trackActivity(entry: SessionEntry, res: ServerResponse): void {
    entry.lastSeenAt = this.now();
    entry.openStreams += 1;
    let released = false;
    res.once("close", () => {
      if (released) {
        return;
      }
      released = true;
      entry.openStreams = Math.max(0, entry.openStreams - 1);
      entry.lastSeenAt = this.now();
    });
  }

  private async createSession(transport: AgentTransportKind, body: unknown): Promise<SessionEntry> {
    const sessionId = randomUUID();
    const clientInfo = readClientInfo(body);
    const identity: AgentClientIdentity = {
      id: sessionId,
      name: clientInfo.name,
      version: clientInfo.version,
      transport,
      rateKey: buildClientRateKey(transport, clientInfo.name)
    };

    const httpTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId
    });
    const server = this.options.createMcpServer(identity);
    const entry: SessionEntry = {
      id: sessionId,
      transport: httpTransport,
      server,
      identity,
      connectedAt: new Date().toISOString(),
      lastSeenAt: this.now(),
      openStreams: 0
    };

    httpTransport.onclose = () => {
      if (this.sessions.delete(sessionId)) {
        void server.close().catch(() => undefined);
        this.options.onClientsChanged?.(this.getClients());
      }
    };

    await server.connect(httpTransport);
    this.sessions.set(sessionId, entry);
    this.options.onClientsChanged?.(this.getClients());
    return entry;
  }
}
