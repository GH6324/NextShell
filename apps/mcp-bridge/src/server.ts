import {
  BRIDGE_INSTRUCTIONS,
  BRIDGE_NAME,
  BRIDGE_VERSION,
  DEFAULT_CALL_TIMEOUT_MS,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_REFRESH_INTERVAL_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  UNAVAILABLE_MESSAGE
} from "./constants.js";
import type { EndpointTarget } from "./endpoint.js";
import {
  errorResponse,
  isRecord,
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  okResponse,
  type JsonRpcId,
  type JsonRpcMessage
} from "./json-rpc.js";
import {
  BRIDGE_STATUS_TOOL,
  BRIDGE_STATUS_TOOL_DESCRIPTOR,
  parseToolDescriptors,
  STATIC_TOOLS,
  toolListSignature,
  type ToolDescriptor
} from "./tools.js";
import {
  isTransportFailure,
  UpstreamError,
  UpstreamRpcError,
  type UpstreamLike,
  type UpstreamSessionOptions
} from "./upstream.js";

export interface BridgeServerDeps {
  send: (message: JsonRpcMessage) => void;
  log: (message: string) => void;
  discover: () => EndpointTarget[] | Promise<EndpointTarget[]>;
  openSession: (target: EndpointTarget, options: UpstreamSessionOptions) => Promise<UpstreamLike>;
  staticTools?: ToolDescriptor[];
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  callTimeoutMs?: number;
  refreshIntervalMs?: number;
  now?: () => number;
}

const textResult = (text: string, isError: boolean): unknown => ({
  content: [{ type: "text", text }],
  isError
});

const failureCode = (error: unknown): string => {
  if (error instanceof UpstreamError) {
    return error.code;
  }
  return "UNKNOWN";
};

/**
 * Everything on stdout is agent-visible, so failures are reported by code only —
 * the underlying Node messages embed the socket path.
 */
const unavailableText = (error: unknown): string =>
  `${UNAVAILABLE_MESSAGE}（原因：${failureCode(error)}）`;

export class BridgeServer {
  private readonly deps: BridgeServerDeps;
  private readonly now: () => number;
  private tools: ToolDescriptor[];
  private toolsFromUpstream = false;
  private session: UpstreamLike | null = null;
  private dialing: Promise<UpstreamLike> | null = null;
  private lastDialAt = 0;
  private lastFailure: string | null = null;
  private initialized = false;
  private negotiatedProtocol = LATEST_PROTOCOL_VERSION;

  constructor(deps: BridgeServerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.tools = deps.staticTools ?? STATIC_TOOLS;
  }

  async handleMessage(raw: unknown): Promise<void> {
    if (!isRecord(raw)) {
      this.deps.send(errorResponse(null, JSON_RPC_INVALID_REQUEST, "Invalid JSON-RPC message"));
      return;
    }

    const method = typeof raw.method === "string" ? raw.method : null;
    const id = typeof raw.id === "string" || typeof raw.id === "number" ? raw.id : null;

    if (method === null) {
      // A response to a request the bridge never sends; nothing to do.
      return;
    }

    if (id === null) {
      this.handleNotification(method);
      return;
    }

    try {
      const result = await this.dispatch(method, raw.params);
      this.deps.send(okResponse(id, result));
    } catch (error) {
      this.deps.send(this.toErrorResponse(id, error));
    }
  }

  /** Best-effort teardown; never rejects. */
  async close(): Promise<void> {
    const session = this.session;
    this.session = null;
    if (session === null) {
      return;
    }
    try {
      await session.close();
    } catch (error) {
      this.deps.log(`failed to close upstream session: ${String(error)}`);
    }
  }

  private handleNotification(method: string): void {
    if (method === "notifications/initialized") {
      this.initialized = true;
      this.warmUp();
      return;
    }
    if (method === "notifications/cancelled" || method === "notifications/progress") {
      return;
    }
    this.deps.log(`ignoring notification: ${method}`);
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "initialize":
        return this.handleInitialize(params);
      case "ping":
        return {};
      case "tools/list":
        this.warmUp();
        return { tools: this.tools };
      case "tools/call":
        return await this.handleToolCall(params);
      default:
        throw new MethodNotFound(method);
    }
  }

  private handleInitialize(params: unknown): unknown {
    const requested =
      isRecord(params) && typeof params.protocolVersion === "string"
        ? params.protocolVersion
        : null;
    this.negotiatedProtocol =
      requested !== null && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION;

    return {
      protocolVersion: this.negotiatedProtocol,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: BRIDGE_NAME, version: BRIDGE_VERSION },
      instructions: BRIDGE_INSTRUCTIONS
    };
  }

  private async handleToolCall(params: unknown): Promise<unknown> {
    if (!isRecord(params) || typeof params.name !== "string" || params.name.length === 0) {
      throw new InvalidParams("tools/call requires a tool name");
    }
    const name = params.name;
    const args = isRecord(params.arguments) ? params.arguments : {};

    if (name === BRIDGE_STATUS_TOOL) {
      return await this.statusResult();
    }

    let session: UpstreamLike;
    try {
      session = await this.ensureSession();
    } catch (error) {
      // A missing app is an expected state, not a protocol failure: report it as a
      // tool result so the client keeps the session alive.
      return textResult(unavailableText(error), true);
    }

    if (this.toolsFromUpstream && !this.tools.some((tool) => tool.name === name)) {
      const available = this.tools.map((tool) => tool.name).join(", ");
      return textResult(
        `NextShell 未提供名为 "${name}" 的工具。当前可用工具：${available}。`,
        true
      );
    }

    try {
      return await this.callUpstream(session, name, args);
    } catch (error) {
      if (error instanceof UpstreamRpcError) {
        return textResult(`NextShell 拒绝了该调用：${error.body.message}`, true);
      }
      this.deps.log(`tools/call ${name} failed: ${String(error)}`);
      return textResult(unavailableText(error), true);
    }
  }

  private async callUpstream(
    session: UpstreamLike,
    name: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const timeout = this.deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    try {
      return await session.request("tools/call", { name, arguments: args }, timeout);
    } catch (error) {
      if (!isTransportFailure(error)) {
        throw error;
      }
      this.dropSession(session);
      const retry = await this.ensureSession();
      return await retry.request("tools/call", { name, arguments: args }, timeout);
    }
  }

  private async statusResult(): Promise<unknown> {
    let reachable = false;
    let transport: string | null = null;
    let serverInfo: { name: string; version: string } | null = null;
    try {
      const session = await this.ensureSession();
      reachable = true;
      transport = session.transport;
      serverInfo = session.serverInfo;
    } catch (error) {
      this.lastFailure = failureCode(error);
    }

    const payload = {
      reachable,
      // Deliberately no socket path, port or token.
      transport,
      app: serverInfo,
      toolSource: this.toolsFromUpstream ? "nextshell" : "bridge-fallback",
      toolCount: this.tools.length,
      lastFailure: reachable ? null : this.lastFailure,
      hint: reachable ? null : UNAVAILABLE_MESSAGE
    };
    return textResult(JSON.stringify(payload, null, 2), false);
  }

  private ensureSession(): Promise<UpstreamLike> {
    const existing = this.session;
    if (existing !== null) {
      return Promise.resolve(existing);
    }
    const pending = this.dialing;
    if (pending !== null) {
      return pending;
    }

    this.lastDialAt = this.now();
    const attempt = this.dial()
      .then((session) => {
        this.session = session;
        this.lastFailure = null;
        void this.refreshTools(session);
        return session;
      })
      .catch((error: unknown) => {
        this.lastFailure = failureCode(error);
        throw error;
      })
      .finally(() => {
        this.dialing = null;
      });
    this.dialing = attempt;
    return attempt;
  }

  private async dial(): Promise<UpstreamLike> {
    const targets = await this.deps.discover();
    if (targets.length === 0) {
      throw new UpstreamError("no NextShell endpoint file was found", "UNREACHABLE");
    }

    let lastError: unknown = new UpstreamError(
      "no endpoint accepted the connection",
      "UNREACHABLE"
    );
    for (const target of targets) {
      try {
        const session = await this.deps.openSession(target, this.sessionOptions());
        this.deps.log(`connected to NextShell over ${target.transport}`);
        return session;
      } catch (error) {
        lastError = error;
        this.deps.log(`endpoint (${target.transport}) unavailable: ${String(error)}`);
      }
    }
    throw lastError;
  }

  private sessionOptions(): UpstreamSessionOptions {
    return {
      clientInfo: { name: BRIDGE_NAME, version: BRIDGE_VERSION },
      protocolVersion: this.negotiatedProtocol,
      connectTimeoutMs: this.deps.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      requestTimeoutMs: this.deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      log: this.deps.log
    };
  }

  private dropSession(session: UpstreamLike): void {
    if (this.session === session) {
      this.session = null;
    }
    void Promise.resolve(session.close()).catch(() => undefined);
  }

  private async refreshTools(session: UpstreamLike): Promise<void> {
    let result: unknown;
    try {
      result = await session.request("tools/list", {});
    } catch (error) {
      this.deps.log(`tools/list refresh failed: ${String(error)}`);
      return;
    }

    const tools = parseToolDescriptors(result);
    if (tools === null) {
      this.deps.log("upstream tools/list returned an unexpected shape; keeping current tools");
      return;
    }

    const next = [
      BRIDGE_STATUS_TOOL_DESCRIPTOR,
      ...tools.filter((tool) => tool.name !== BRIDGE_STATUS_TOOL)
    ];
    const changed = toolListSignature(next) !== toolListSignature(this.tools);
    this.tools = next;
    this.toolsFromUpstream = true;
    if (changed && this.initialized) {
      this.deps.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    }
  }

  /** Background dial; never rejects and never blocks the caller's response. */
  private warmUp(): void {
    if (this.session !== null || this.dialing !== null) {
      return;
    }
    const interval = this.deps.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    if (this.lastDialAt !== 0 && this.now() - this.lastDialAt < interval) {
      return;
    }
    void this.ensureSession().catch(() => undefined);
  }

  private toErrorResponse(id: JsonRpcId, error: unknown) {
    if (error instanceof MethodNotFound) {
      return errorResponse(id, JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${error.method}`);
    }
    if (error instanceof InvalidParams) {
      return errorResponse(id, JSON_RPC_INVALID_PARAMS, error.message);
    }
    this.deps.log(`request failed: ${String(error)}`);
    return errorResponse(id, JSON_RPC_INTERNAL_ERROR, "Bridge failed to handle the request");
  }
}

class MethodNotFound extends Error {
  readonly method: string;

  constructor(method: string) {
    super(`Method not found: ${method}`);
    this.name = "MethodNotFound";
    this.method = method;
  }
}

class InvalidParams extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidParams";
  }
}
