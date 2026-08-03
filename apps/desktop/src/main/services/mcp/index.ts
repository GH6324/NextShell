import { randomBytes } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  AgentClientConfigResult,
  AgentClientKind,
  AgentEndpointStatus
} from "@nextshell/shared";

import {
  AgentGateway,
  type AgentClientIdentity,
  type AgentGatewayDeps,
  type AgentGatewayLimits
} from "./agent-gateway";
import { EndpointDiscoveryFile } from "./discovery";
import { McpEndpointServer, type AgentLogger } from "./endpoint-server";
import { registerAgentTools } from "./tools";

export const ENDPOINT_ENV_VAR = "NEXTSHELL_MCP_ENDPOINT";
export const MCP_SERVER_NAME = "nextshell";
const MCP_CLIENT_KEY = "nextshell";
/** Makes the Electron binary behave as a plain Node runtime for the stdio bridge. */
const RUN_AS_NODE_ENV_VAR = "ELECTRON_RUN_AS_NODE";

export interface AgentMcpServiceDeps extends AgentGatewayDeps {
  /** Electron `app.getPath("userData")`; the discovery file lands in `<userData>/mcp`. */
  userDataDir: string;
  appVersion: string;
  /** Override for tests; production uses a short tmpdir path. */
  socketPath?: string;
  gatewayLimits?: Partial<AgentGatewayLimits>;
  /** Survives restarts when provided (e.g. a JSON setting); otherwise the token is per-run. */
  tokenStore?: { read: () => string | null; write: (token: string | null) => void };
  /**
   * Absolute path to the bundled stdio bridge entry, or null when it is not
   * shipped. The bridge is not published to npm, so a generated config must
   * point at the copy inside the installation — never at `npx <package>`.
   */
  resolveBridgeEntry?: () => string | null;
  /** Runtime that executes the bridge; defaults to the current executable. */
  bridgeRuntimePath?: string;
  writeClipboard?: (text: string) => void;
  logger?: AgentLogger;
}

export interface AgentMcpService {
  /** Starts the listeners when `preferences.agent.enabled` is true. Idempotent. */
  start: () => Promise<AgentEndpointStatus>;
  /** Stops the listeners without touching preferences. Idempotent. */
  stop: () => Promise<AgentEndpointStatus>;
  /** Reconciles the running listeners with the current preferences. */
  applyPreferences: () => Promise<AgentEndpointStatus>;
  getStatus: () => AgentEndpointStatus;
  /** Issues a new bearer token and drops every connected client. */
  rotateToken: () => Promise<AgentEndpointStatus>;
  buildClientConfig: (client: AgentClientKind) => AgentClientConfigResult;
  dispose: () => Promise<void>;
}

const shellQuote = (value: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

export const createAgentMcpService = (deps: AgentMcpServiceDeps): AgentMcpService => {
  const gateway = new AgentGateway(deps, { limits: deps.gatewayLimits });
  const discovery = new EndpointDiscoveryFile({
    userDataDir: deps.userDataDir,
    appVersion: deps.appVersion
  });

  let endpoint: McpEndpointServer | null = null;
  let token: string | null = deps.tokenStore?.read() ?? null;
  let lastError: string | null = null;
  let signature = "";
  let pending: Promise<void> = Promise.resolve();

  const preferences = () => deps.getPreferences().agent;

  const listenSignature = (): string => {
    const agent = preferences();
    return `${agent.socketEnabled ? 1 : 0}|${agent.tcpEnabled ? 1 : 0}|${agent.tcpPort}`;
  };

  const ensureToken = (): string => {
    if (!token) {
      token = randomBytes(32).toString("base64url");
      deps.tokenStore?.write(token);
    }
    return token;
  };

  const createMcpServer = (identity: AgentClientIdentity): McpServer => {
    const server = new McpServer(
      { name: MCP_SERVER_NAME, version: deps.appVersion },
      {
        instructions:
          "NextShell exposes the hosts the user explicitly granted to agents. Resolve a host with host_list before calling other tools; ambiguous targets return candidates instead of guessing. Every tool here is read-only."
      }
    );
    registerAgentTools(server, { gateway, client: identity });
    return server;
  };

  // Buckets are keyed per client, not per session: only fully aged-out ones are
  // dropped, so reconnecting cannot hand a client a fresh budget.
  const onClientsChanged = (): void => {
    gateway.pruneRateLimits();
  };

  const getStatus = (): AgentEndpointStatus => {
    const agent = preferences();
    const listening = endpoint?.listening ?? false;
    const tcpPort = endpoint?.tcpPort ?? null;
    return {
      enabled: agent.enabled,
      listening,
      socketPath: endpoint?.socketPath ?? null,
      tcpPort,
      token: listening && tcpPort !== null ? token : null,
      endpointFilePath: discovery.primaryPath,
      clients: endpoint?.getClients() ?? [],
      lastError
    };
  };

  const stopEndpoint = async (): Promise<void> => {
    if (endpoint) {
      await endpoint.stop();
      endpoint = null;
    }
    signature = "";
    await discovery.remove();
  };

  const startEndpoint = async (): Promise<void> => {
    const agent = preferences();
    if (!agent.socketEnabled && !agent.tcpEnabled) {
      lastError = "未启用任何监听方式（Unix socket 或本地 TCP）";
      return;
    }

    const server = new McpEndpointServer({
      socketEnabled: agent.socketEnabled,
      tcpEnabled: agent.tcpEnabled,
      tcpPort: agent.tcpPort,
      token: agent.tcpEnabled ? ensureToken() : null,
      socketPath: deps.socketPath,
      createMcpServer,
      onClientsChanged,
      logger: deps.logger
    });

    try {
      await server.start();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      deps.logger?.error?.("MCP endpoint failed to start", { error: lastError });
      await server.stop().catch(() => undefined);
      return;
    }

    endpoint = server;
    signature = listenSignature();
    lastError = null;

    try {
      await discovery.write({
        socketPath: server.socketPath,
        httpPort: server.tcpPort,
        token: server.tcpPort !== null ? token : null
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      deps.logger?.warn?.("Failed to write the MCP endpoint discovery file", { error: lastError });
    }
  };

  /** Serialized so overlapping enable/disable/rotate calls cannot interleave. */
  const enqueue = async (task: () => Promise<void>): Promise<AgentEndpointStatus> => {
    const run = pending.then(task, task);
    pending = run.then(
      () => undefined,
      () => undefined
    );
    await run;
    return getStatus();
  };

  const reconcile = async (): Promise<void> => {
    const agent = preferences();
    if (!agent.enabled) {
      await stopEndpoint();
      return;
    }
    if (!endpoint) {
      await startEndpoint();
      return;
    }
    if (signature !== listenSignature()) {
      await stopEndpoint();
      await startEndpoint();
    }
  };

  return {
    start: () => enqueue(reconcile),
    stop: () => enqueue(stopEndpoint),
    applyPreferences: () => enqueue(reconcile),
    getStatus,
    rotateToken: () =>
      enqueue(async () => {
        token = randomBytes(32).toString("base64url");
        deps.tokenStore?.write(token);
        if (endpoint) {
          // A live connection keeps working after the token changes, so the
          // rotation has to tear the sockets down as well.
          await endpoint.disconnectClients();
          await stopEndpoint();
          await startEndpoint();
        }
      }),
    buildClientConfig: (client) => {
      const status = getStatus();
      const useTcp = status.tcpPort !== null && status.token !== null;

      let serverConfig: Record<string, unknown>;
      let command: string;
      if (useTcp) {
        serverConfig = {
          type: "http",
          url: `http://127.0.0.1:${status.tcpPort}/mcp`,
          headers: { Authorization: `Bearer ${status.token}` }
        };
        command = `claude mcp add --transport http ${MCP_CLIENT_KEY} http://127.0.0.1:${status.tcpPort}/mcp --header ${shellQuote(
          `Authorization: Bearer ${status.token}`
        )}`;
      } else {
        const bridgeEntry = deps.resolveBridgeEntry?.() ?? null;
        if (!bridgeEntry) {
          throw new Error(
            "未找到随应用分发的 MCP 桥接程序，无法生成 Socket 接入配置；请改用 127.0.0.1 TCP 监听，或重新安装应用"
          );
        }
        const runtime = deps.bridgeRuntimePath ?? process.execPath;
        const env = {
          [RUN_AS_NODE_ENV_VAR]: "1",
          [ENDPOINT_ENV_VAR]: status.endpointFilePath
        };
        serverConfig = { command: runtime, args: [bridgeEntry], env };
        command = `claude mcp add ${MCP_CLIENT_KEY} --env ${RUN_AS_NODE_ENV_VAR}=1 --env ${ENDPOINT_ENV_VAR}=${shellQuote(
          status.endpointFilePath
        )} -- ${shellQuote(runtime)} ${shellQuote(bridgeEntry)}`;
      }

      const json = JSON.stringify({ mcpServers: { [MCP_CLIENT_KEY]: serverConfig } }, null, 2);
      deps.writeClipboard?.(client === "claude-code" ? command : json);
      return { ok: true, command, json };
    },
    dispose: () => enqueue(stopEndpoint).then(() => undefined)
  };
};

export {
  AgentGateway,
  type AgentClientIdentity,
  type AgentGatewayDeps,
  type AgentGatewayLimits,
  type AgentSessionInfo,
  type AgentRemoteFileStat,
  type AgentRemoteFileChunk,
  type AgentToolError,
  type AgentToolResult
} from "./agent-gateway";
export { McpEndpointServer, resolveDefaultSocketPath } from "./endpoint-server";
export { EndpointDiscoveryFile, type EndpointDiscoveryRecord } from "./discovery";
export {
  buildServerSummary,
  listServerSummaries,
  resolveConnectionTarget,
  searchServerSummaries,
  type ServerSummary
} from "./target-resolver";
