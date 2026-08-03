import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_APP_PREFERENCES } from "@nextshell/core";
import type { AppPreferences } from "@nextshell/core";

import { createAgentMcpService, type AgentMcpService, type AgentMcpServiceDeps } from "./index";
import type { AgentTransferSnapshot } from "./transfers";

const TIMESTAMP = "2026-08-03T00:00:00.000Z";

/** Minimal Tier 2 transfer stub; the tracker itself is covered in transfers.test.ts. */
const stubTransfer = (
  direction: "upload" | "download",
  input: { connectionId: string; localPath: string; remotePath: string }
): AgentTransferSnapshot => ({
  taskId: "task-stub",
  direction,
  connectionId: input.connectionId,
  localPath: input.localPath,
  remotePath: input.remotePath,
  packed: false,
  state: "running",
  progress: 0,
  transferredBytes: 0,
  totalBytes: null,
  startedAt: TIMESTAMP,
  finishedAt: null,
  error: null
});

const tempDirs: string[] = [];
let service: AgentMcpService | null = null;

const createTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nsmcp-service-"));
  tempDirs.push(dir);
  return dir;
};

const baseDeps = (
  userDataDir: string,
  preferences: () => AppPreferences,
  overrides: Partial<AgentMcpServiceDeps> = {}
): AgentMcpServiceDeps => ({
  userDataDir,
  appVersion: "9.9.9",
  socketPath: path.join(os.tmpdir(), `nsmcp-svc-${randomUUID().slice(0, 8)}`, "s"),
  listConnections: () => [],
  isConnectionOnline: () => false,
  listSessions: () => [],
  getMonitorSnapshot: async () => null,
  listRemoteFiles: async () => [],
  statRemoteFile: async () => {
    throw new Error("ENOENT");
  },
  readRemoteFile: async () => ({ bytes: Buffer.alloc(0), truncated: false }),
  listSavedCommands: () => [],
  getSessionHistory: () => null,
  execCommand: async () => ({
    stdout: "",
    stderr: "",
    exitCode: 0,
    executedAt: new Date().toISOString()
  }),
  writeRemoteFile: async () => undefined,
  makeRemoteDirectory: async () => undefined,
  renameRemotePath: async () => undefined,
  deleteRemotePath: async () => undefined,
  statLocalPath: () => null,
  localPathContext: () => ({
    homeDir: "/home/tester",
    appDataDir: "/home/tester/.nextshell",
    allowedRoots: []
  }),
  startUpload: (input) => stubTransfer("upload", input),
  startDownload: (input) => stubTransfer("download", input),
  getTransfer: () => undefined,
  cancelTransfer: () => false,
  runningTransferCount: () => 0,
  retainConnection: () => () => undefined,
  closeConnectionIfIdle: async () => undefined,
  promptUser: async () => ({ id: randomUUID(), canceled: true }),
  notifyUser: () => undefined,
  emitActivity: () => undefined,
  respondToPrompt: () => undefined,
  appendAuditLog: () => undefined,
  getPreferences: preferences,
  ...overrides
});

const withAgent = (patch: Partial<AppPreferences["agent"]>): AppPreferences => ({
  ...DEFAULT_APP_PREFERENCES,
  agent: { ...DEFAULT_APP_PREFERENCES.agent, ...patch }
});

afterEach(async () => {
  await service?.dispose();
  service = null;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("agent mcp service", () => {
  test("stays silent until the preference is enabled", async () => {
    const userDataDir = await createTempDir();
    let preferences = withAgent({ enabled: false });
    service = createAgentMcpService(baseDeps(userDataDir, () => preferences));

    const idle = await service.start();
    expect(idle.enabled).toBe(false);
    expect(idle.listening).toBe(false);
    expect(idle.socketPath).toBeNull();
    expect(idle.token).toBeNull();
    await expect(stat(idle.endpointFilePath)).rejects.toThrow();

    preferences = withAgent({ enabled: true });
    const running = await service.applyPreferences();
    expect(running.listening).toBe(true);
    expect(running.socketPath).not.toBeNull();
    expect(running.tcpPort).toBeNull();
    expect(running.token).toBeNull();
    await expect(stat(running.endpointFilePath)).resolves.toBeDefined();
    await expect(stat(running.socketPath!)).resolves.toBeDefined();
  });

  test("start and stop are idempotent and clean up the discovery file", async () => {
    const userDataDir = await createTempDir();
    const preferences = withAgent({ enabled: true });
    service = createAgentMcpService(baseDeps(userDataDir, () => preferences));

    const first = await service.start();
    const second = await service.start();
    expect(second.socketPath).toBe(first.socketPath);
    expect(second.listening).toBe(true);

    const stopped = await service.stop();
    expect(stopped.listening).toBe(false);
    expect(stopped.socketPath).toBeNull();
    await expect(stat(first.endpointFilePath)).rejects.toThrow();
    await expect(stat(first.socketPath!)).rejects.toThrow();

    const stoppedAgain = await service.stop();
    expect(stoppedAgain.listening).toBe(false);
  });

  test("the loopback listener issues a token and rotation replaces it", async () => {
    const userDataDir = await createTempDir();
    const preferences = withAgent({ enabled: true, tcpEnabled: true, tcpPort: 0 });
    service = createAgentMcpService(baseDeps(userDataDir, () => preferences));

    const started = await service.start();
    expect(started.tcpPort).toBeGreaterThan(0);
    expect(started.token).toBeTruthy();

    const rotated = await service.rotateToken();
    expect(rotated.token).toBeTruthy();
    expect(rotated.token).not.toBe(started.token);
    expect(rotated.listening).toBe(true);
  });

  test("client config points at the bundled bridge, never at npx or a credential", async () => {
    const userDataDir = await createTempDir();
    const preferences = withAgent({ enabled: true });
    const clipboard: string[] = [];
    const bridgeEntry = path.join(userDataDir, "mcp-bridge", "index.js");
    service = createAgentMcpService(
      baseDeps(userDataDir, () => preferences, {
        writeClipboard: (text) => clipboard.push(text),
        resolveBridgeEntry: () => bridgeEntry,
        bridgeRuntimePath: "/Applications/NextShell.app/Contents/MacOS/NextShell"
      })
    );
    await service.start();

    const config = service.buildClientConfig("claude-code");
    expect(config.ok).toBe(true);
    expect(config.command).toContain("claude mcp add nextshell");
    expect(config.command).toContain("NEXTSHELL_MCP_ENDPOINT=");
    // The bridge is not published to npm; an `npx` config would 404 for users.
    expect(config.command).not.toContain("npx");
    expect(config.json).not.toContain("npx");
    expect(config.json).toContain(bridgeEntry);
    expect(config.json).toContain("ELECTRON_RUN_AS_NODE");
    expect(config.json).not.toContain("Authorization");
    expect(clipboard).toEqual([config.command]);

    const cursor = service.buildClientConfig("cursor");
    expect(clipboard.at(-1)).toBe(cursor.json);
  });

  test("a missing bundled bridge fails loudly instead of emitting a broken config", async () => {
    const userDataDir = await createTempDir();
    const preferences = withAgent({ enabled: true });
    const clipboard: string[] = [];
    service = createAgentMcpService(
      baseDeps(userDataDir, () => preferences, {
        writeClipboard: (text) => clipboard.push(text),
        resolveBridgeEntry: () => null
      })
    );
    await service.start();

    expect(() => service?.buildClientConfig("claude-code")).toThrow(/桥接程序/);
    expect(clipboard).toEqual([]);
  });

  test("client config switches to loopback HTTP when TCP is on", async () => {
    const userDataDir = await createTempDir();
    const preferences = withAgent({ enabled: true, tcpEnabled: true });
    service = createAgentMcpService(baseDeps(userDataDir, () => preferences));
    const status = await service.start();

    const config = service.buildClientConfig("claude-code");
    expect(config.command).toContain(`http://127.0.0.1:${status.tcpPort}/mcp`);
    expect(config.json).toContain("Authorization");
  });
});
