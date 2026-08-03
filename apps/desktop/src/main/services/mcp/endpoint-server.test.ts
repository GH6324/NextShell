import { afterEach, describe, expect, test } from "vitest";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  isTokenValid,
  McpEndpointServer,
  MAX_UNIX_SOCKET_PATH_BYTES,
  resolveDefaultSocketPath
} from "./endpoint-server";
import type { AgentClientIdentity } from "./agent-gateway";

const TOKEN = "test-token-value";

interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

interface Endpoint {
  socketPath?: string;
  port?: number;
}

const send = (
  endpoint: Endpoint,
  options: { method: string; headers?: Record<string, string>; body?: unknown }
): Promise<HttpResult> =>
  new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = httpRequest(
      {
        method: options.method,
        path: "/mcp",
        socketPath: endpoint.socketPath,
        host: endpoint.port ? "127.0.0.1" : undefined,
        port: endpoint.port,
        headers: {
          accept: "application/json, text/event-stream",
          ...(payload ? { "content-type": "application/json" } : {}),
          ...options.headers
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8")
          })
        );
      }
    );
    req.on("error", reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });

/** POST responses arrive as SSE frames by default. */
const parseMessage = (body: string): Record<string, unknown> => {
  const dataLine = body.split("\n").find((line) => line.startsWith("data:"));
  const json = dataLine ? dataLine.slice("data:".length).trim() : body;
  return JSON.parse(json) as Record<string, unknown>;
};

const initializeBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "vitest-client", version: "9.9.9" }
  }
};

const createTestServer = (_identity: AgentClientIdentity): McpServer => {
  const server = new McpServer({ name: "nextshell-test", version: "0.0.0" });
  server.registerTool(
    "ping",
    { description: "ping", inputSchema: { value: z.string().optional() } },
    async () => ({ content: [{ type: "text", text: "pong" }] })
  );
  return server;
};

let endpointServer: McpEndpointServer | null = null;

const startEndpoint = async (options: {
  tcp: boolean;
  maxSessions?: number;
  sessionIdleTimeoutMs?: number;
  now?: () => number;
}): Promise<McpEndpointServer> => {
  const socketPath = path.join(
    os.tmpdir(),
    `nsmcp-${process.pid}-${randomUUID().slice(0, 8)}`,
    "s"
  );
  const server = new McpEndpointServer({
    socketEnabled: true,
    tcpEnabled: options.tcp,
    tcpPort: 0,
    token: options.tcp ? TOKEN : null,
    socketPath,
    maxSessions: options.maxSessions,
    sessionIdleTimeoutMs: options.sessionIdleTimeoutMs,
    now: options.now,
    createMcpServer: createTestServer
  });
  await server.start();
  endpointServer = server;
  return server;
};

afterEach(async () => {
  await endpointServer?.stop();
  endpointServer = null;
});

describe("socket path constraints", () => {
  test("the default socket path stays inside the sun_path budget", () => {
    const socketPath = resolveDefaultSocketPath(12345);
    expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(MAX_UNIX_SOCKET_PATH_BYTES);
  });

  test("an over-long socket path is rejected instead of failing in listen()", async () => {
    const tooLong = path.join(os.tmpdir(), "n".repeat(120), "mcp.sock");
    const server = new McpEndpointServer({
      socketEnabled: true,
      tcpEnabled: false,
      tcpPort: 0,
      token: null,
      socketPath: tooLong,
      createMcpServer: createTestServer
    });

    await expect(server.start()).rejects.toThrow(/104 bytes/);
  });
});

describe("token comparison", () => {
  test("mismatched lengths return false instead of throwing", () => {
    expect(isTokenValid(TOKEN, "short")).toBe(false);
    expect(isTokenValid(TOKEN, TOKEN)).toBe(true);
    expect(isTokenValid(null, TOKEN)).toBe(false);
    expect(isTokenValid(TOKEN, null)).toBe(false);
  });
});

describe("session routing", () => {
  test("initialize over the socket registers a client and the session works over TCP too", async () => {
    const server = await startEndpoint({ tcp: true });
    const socketPath = server.socketPath!;
    const port = server.tcpPort!;

    const initialized = await send({ socketPath }, { method: "POST", body: initializeBody });
    expect(initialized.status).toBe(200);
    const sessionId = initialized.headers["mcp-session-id"];
    expect(typeof sessionId).toBe("string");
    expect(parseMessage(initialized.body).result).toBeDefined();

    const clients = server.getClients();
    expect(clients).toHaveLength(1);
    expect(clients[0]?.name).toBe("vitest-client");
    expect(clients[0]?.transport).toBe("socket");

    const notified = await send(
      { socketPath },
      {
        method: "POST",
        headers: { "mcp-session-id": String(sessionId) },
        body: { jsonrpc: "2.0", method: "notifications/initialized" }
      }
    );
    expect(notified.status).toBe(202);

    // Same session map is shared by both listeners.
    const listed = await send(
      { port },
      {
        method: "POST",
        headers: { "mcp-session-id": String(sessionId), authorization: `Bearer ${TOKEN}` },
        body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }
      }
    );
    expect(listed.status).toBe(200);
    const result = parseMessage(listed.body).result as { tools: Array<{ name: string }> };
    expect(result.tools.map((tool) => tool.name)).toContain("ping");
  });

  test("an unknown session id is refused", async () => {
    const server = await startEndpoint({ tcp: false });
    const response = await send(
      { socketPath: server.socketPath! },
      {
        method: "POST",
        headers: { "mcp-session-id": randomUUID() },
        body: { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }
      }
    );

    expect(response.status).toBe(400);
    expect(server.getClients()).toHaveLength(0);
  });

  test("DELETE closes the session and drops the client", async () => {
    const server = await startEndpoint({ tcp: false });
    const socketPath = server.socketPath!;
    const initialized = await send({ socketPath }, { method: "POST", body: initializeBody });
    const sessionId = String(initialized.headers["mcp-session-id"]);
    expect(server.getClients()).toHaveLength(1);

    const deleted = await send(
      { socketPath },
      { method: "DELETE", headers: { "mcp-session-id": sessionId } }
    );

    expect(deleted.status).toBeLessThan(300);
    expect(server.getClients()).toHaveLength(0);
  });
});

describe("session reclamation", () => {
  test("a client that never sends DELETE is evicted once it goes idle", async () => {
    let clock = 1_000_000;
    const server = await startEndpoint({
      tcp: false,
      sessionIdleTimeoutMs: 60_000,
      now: () => clock
    });
    const socketPath = server.socketPath!;

    await send({ socketPath }, { method: "POST", body: initializeBody });
    expect(server.getClients()).toHaveLength(1);

    clock += 30_000;
    await server.sweepIdleSessions();
    expect(server.getClients()).toHaveLength(1);

    // Stands in for a SIGKILLed client: no DELETE ever arrives.
    clock += 61_000;
    await server.sweepIdleSessions();
    expect(server.getClients()).toHaveLength(0);
  });

  test("concurrent sessions are capped instead of growing without bound", async () => {
    const server = await startEndpoint({ tcp: false, maxSessions: 2 });
    const socketPath = server.socketPath!;

    for (let index = 0; index < 2; index += 1) {
      const accepted = await send({ socketPath }, { method: "POST", body: initializeBody });
      expect(accepted.status).toBe(200);
    }

    const refused = await send({ socketPath }, { method: "POST", body: initializeBody });
    expect(refused.status).toBe(503);
    expect(server.getClients()).toHaveLength(2);
  });
});

describe("authorization", () => {
  test("TCP rejects a wrong or missing bearer token", async () => {
    const server = await startEndpoint({ tcp: true });
    const port = server.tcpPort!;

    const missing = await send({ port }, { method: "POST", body: initializeBody });
    expect(missing.status).toBe(401);

    const wrong = await send(
      { port },
      { method: "POST", headers: { authorization: "Bearer nope" }, body: initializeBody }
    );
    expect(wrong.status).toBe(401);
    expect(server.getClients()).toHaveLength(0);

    const accepted = await send(
      { port },
      { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: initializeBody }
    );
    expect(accepted.status).toBe(200);
    expect(server.getClients()[0]?.transport).toBe("tcp");
  });

  test("a foreign Host header is rejected", async () => {
    const server = await startEndpoint({ tcp: true });

    const overSocket = await send(
      { socketPath: server.socketPath! },
      { method: "POST", headers: { host: "attacker.example" }, body: initializeBody }
    );
    expect(overSocket.status).toBe(403);

    const overTcp = await send(
      { port: server.tcpPort! },
      {
        method: "POST",
        headers: { host: "attacker.example", authorization: `Bearer ${TOKEN}` },
        body: initializeBody
      }
    );
    expect(overTcp.status).toBe(403);
  });

  test("a non-loopback Origin header is rejected", async () => {
    const server = await startEndpoint({ tcp: false });
    const response = await send(
      { socketPath: server.socketPath! },
      { method: "POST", headers: { origin: "https://evil.example" }, body: initializeBody }
    );

    expect(response.status).toBe(403);
  });
});

describe("lifecycle", () => {
  test.skipIf(process.platform === "win32")(
    "the socket is chmod 0600 and removed on stop",
    async () => {
      const server = await startEndpoint({ tcp: false });
      const socketPath = server.socketPath!;

      const before = await stat(socketPath);
      expect(before.mode & 0o777).toBe(0o600);

      await send({ socketPath }, { method: "POST", body: initializeBody });
      expect(server.getClients()).toHaveLength(1);

      await server.stop();
      endpointServer = null;

      await expect(stat(socketPath)).rejects.toThrow();
      expect(server.getClients()).toHaveLength(0);
      expect(server.listening).toBe(false);
    }
  );

  test("start is idempotent", async () => {
    const server = await startEndpoint({ tcp: false });
    const socketPath = server.socketPath;
    await server.start();
    expect(server.socketPath).toBe(socketPath);
  });
});
