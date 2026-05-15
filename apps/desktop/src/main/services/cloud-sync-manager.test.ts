import { describe, expect, test } from "bun:test";
import { buildScopeKey } from "@nextshell/core";
import type {
  CloudSyncWorkspaceProfile,
  ConnectionProfile,
  ProxyProfile,
  RecycleBinEntry,
  SshKeyProfile,
  WorkspaceCommandItem,
  WorkspaceRepoCommitMeta,
  WorkspaceRepoConflict,
  WorkspaceRepoLocalState,
  WorkspaceRepoSnapshot,
} from "@nextshell/core";
import { CloudSyncManager, type CloudSyncManagerDeps } from "./cloud-sync-manager";

const createWorkspace = (): CloudSyncWorkspaceProfile => ({
  id: "ws-1",
  apiBaseUrl: "https://sync.example.com/",
  workspaceName: "prod-team",
  displayName: "生产环境",
  pullIntervalSec: 120,
  ignoreTlsErrors: true,
  enabled: false,
  createdAt: "2026-03-15T00:00:00.000Z",
  updatedAt: "2026-03-15T00:00:00.000Z",
  lastSyncAt: null,
  lastError: null,
});

const createDeps = (
  workspace: CloudSyncWorkspaceProfile,
  password: string | undefined,
): CloudSyncManagerDeps => ({
  listConnections: (): ConnectionProfile[] => [],
  saveConnection: (_conn): void => undefined,
  removeConnection: (_id): void => undefined,
  listSshKeys: (): SshKeyProfile[] => [],
  saveSshKey: (_key): void => undefined,
  removeSshKey: (_id): void => undefined,
  listProxies: (): ProxyProfile[] => [],
  saveProxy: (_proxy): void => undefined,
  removeProxy: (_id): void => undefined,
  readCredential: async (_ref): Promise<string | undefined> => undefined,
  storeCredential: async (_name, _secret): Promise<string> => "secret://test",
  deleteCredential: async (_ref): Promise<void> => undefined,
  listWorkspaces: (): CloudSyncWorkspaceProfile[] => [workspace],
  saveWorkspace: (_ws): void => undefined,
  removeWorkspace: (_id): void => undefined,
  listWorkspaceRepoCommits: (
    _workspaceId: string,
    _limit?: number,
    _cursorCreatedAt?: string,
  ): WorkspaceRepoCommitMeta[] => [],
  getWorkspaceRepoCommit: (_workspaceId: string, _commitId: string): WorkspaceRepoCommitMeta | undefined => undefined,
  saveWorkspaceRepoCommit: (_commit: WorkspaceRepoCommitMeta): void => undefined,
  getWorkspaceRepoSnapshot: (_workspaceId: string, _snapshotId: string): WorkspaceRepoSnapshot | undefined => undefined,
  saveWorkspaceRepoSnapshot: (_snapshot: WorkspaceRepoSnapshot): void => undefined,
  getWorkspaceRepoLocalState: (_workspaceId: string): WorkspaceRepoLocalState | undefined => undefined,
  saveWorkspaceRepoLocalState: (_state: WorkspaceRepoLocalState): void => undefined,
  listWorkspaceRepoConflicts: (_workspaceId: string): WorkspaceRepoConflict[] => [],
  saveWorkspaceRepoConflict: (_conflict: WorkspaceRepoConflict): void => undefined,
  removeWorkspaceRepoConflict: (_workspaceId: string, _resourceType: string, _resourceId: string): void => undefined,
  clearWorkspaceRepoConflicts: (_workspaceId: string): void => undefined,
  listWorkspaceCommands: (_workspaceId: string): WorkspaceCommandItem[] => [],
  replaceWorkspaceCommands: (_workspaceId: string, _commands: WorkspaceCommandItem[]): void => undefined,
  getWorkspaceCommandsVersion: (_workspaceId: string): string | undefined => undefined,
  saveWorkspaceCommandsVersion: (_workspaceId: string, _version: string): void => undefined,
  saveRecycleBinEntry: (_entry: RecycleBinEntry): void => undefined,
  listRecycleBinEntries: (): RecycleBinEntry[] => [],
  removeRecycleBinEntry: (_id): void => undefined,
  storeWorkspacePassword: async (_workspaceId, _nextPassword): Promise<void> => undefined,
  getWorkspacePassword: async (_workspaceId): Promise<string | undefined> => password,
  deleteWorkspacePassword: async (_workspaceId): Promise<void> => undefined,
  getJsonSetting: <T,>(_key: string): T | undefined => undefined,
  saveJsonSetting: (_key: string, _value: unknown): void => undefined,
  broadcastStatus: (_status): void => undefined,
  broadcastApplied: (_workspaceId): void => undefined,
});

const now = "2026-03-15T00:00:00.000Z";

const snapshotConnection = (
  uuid: string,
  name: string,
  host: string,
): WorkspaceRepoSnapshot["connections"][number] => ({
  uuid,
  name,
  host,
  port: 22,
  username: "root",
  authType: "agent",
  strictHostKeyChecking: false,
  terminalEncoding: "utf-8",
  backspaceMode: "ascii-backspace",
  deleteMode: "vt220-delete",
  groupPath: "/workspace/prod-team",
  tags: [],
  favorite: false,
  createdAt: now,
  updatedAt: now,
});

const repoSnapshot = (
  workspaceId: string,
  snapshotId: string,
  connections: WorkspaceRepoSnapshot["connections"][number][],
): WorkspaceRepoSnapshot => ({
  workspaceId,
  snapshotId,
  createdAt: now,
  connections,
  sshKeys: [],
  proxies: [],
});

interface MutableCloudSyncState {
  workspace: CloudSyncWorkspaceProfile;
  password?: string;
  connections: ConnectionProfile[];
  sshKeys: SshKeyProfile[];
  proxies: ProxyProfile[];
  commands: WorkspaceCommandItem[];
  commandsVersion?: string;
  commits: Map<string, WorkspaceRepoCommitMeta>;
  snapshots: Map<string, WorkspaceRepoSnapshot>;
  localState?: WorkspaceRepoLocalState;
  conflicts: WorkspaceRepoConflict[];
  credentials: Map<string, string>;
}

const createMutableState = (
  workspace: CloudSyncWorkspaceProfile,
  overrides: Partial<MutableCloudSyncState> = {},
): MutableCloudSyncState => ({
  workspace,
  password: "workspace-password",
  connections: [],
  sshKeys: [],
  proxies: [],
  commands: [],
  commits: new Map(),
  snapshots: new Map(),
  conflicts: [],
  credentials: new Map(),
  ...overrides,
});

const createMutableDeps = (state: MutableCloudSyncState): CloudSyncManagerDeps => ({
  listConnections: (): ConnectionProfile[] => state.connections,
  saveConnection: (conn): void => {
    state.connections = [...state.connections.filter((item) => item.id !== conn.id), conn];
  },
  removeConnection: (id): void => {
    state.connections = state.connections.filter((item) => item.id !== id);
  },
  listSshKeys: (): SshKeyProfile[] => state.sshKeys,
  saveSshKey: (key): void => {
    state.sshKeys = [...state.sshKeys.filter((item) => item.id !== key.id), key];
  },
  removeSshKey: (id): void => {
    state.sshKeys = state.sshKeys.filter((item) => item.id !== id);
  },
  listProxies: (): ProxyProfile[] => state.proxies,
  saveProxy: (proxy): void => {
    state.proxies = [...state.proxies.filter((item) => item.id !== proxy.id), proxy];
  },
  removeProxy: (id): void => {
    state.proxies = state.proxies.filter((item) => item.id !== id);
  },
  readCredential: async (ref): Promise<string | undefined> => state.credentials.get(ref),
  storeCredential: async (name, secret): Promise<string> => {
    const ref = `secret://${name}`;
    state.credentials.set(ref, secret);
    return ref;
  },
  deleteCredential: async (ref): Promise<void> => {
    state.credentials.delete(ref);
  },
  listWorkspaces: (): CloudSyncWorkspaceProfile[] => [state.workspace],
  saveWorkspace: (ws): void => {
    state.workspace = ws;
  },
  removeWorkspace: (_id): void => undefined,
  listWorkspaceRepoCommits: (
    _workspaceId: string,
    limit = 50,
  ): WorkspaceRepoCommitMeta[] => [...state.commits.values()].slice(0, limit),
  getWorkspaceRepoCommit: (_workspaceId: string, commitId: string): WorkspaceRepoCommitMeta | undefined =>
    state.commits.get(commitId),
  saveWorkspaceRepoCommit: (commit): void => {
    state.commits.set(commit.commitId, commit);
  },
  getWorkspaceRepoSnapshot: (_workspaceId: string, snapshotId: string): WorkspaceRepoSnapshot | undefined =>
    state.snapshots.get(snapshotId),
  saveWorkspaceRepoSnapshot: (snapshot): void => {
    state.snapshots.set(snapshot.snapshotId, snapshot);
  },
  getWorkspaceRepoLocalState: (_workspaceId: string): WorkspaceRepoLocalState | undefined => state.localState,
  saveWorkspaceRepoLocalState: (nextState): void => {
    state.localState = nextState;
  },
  listWorkspaceRepoConflicts: (_workspaceId: string): WorkspaceRepoConflict[] => state.conflicts,
  saveWorkspaceRepoConflict: (conflict): void => {
    state.conflicts = [
      ...state.conflicts.filter(
        (item) => item.resourceType !== conflict.resourceType || item.resourceId !== conflict.resourceId,
      ),
      conflict,
    ];
  },
  removeWorkspaceRepoConflict: (_workspaceId, resourceType, resourceId): void => {
    state.conflicts = state.conflicts.filter(
      (item) => item.resourceType !== resourceType || item.resourceId !== resourceId,
    );
  },
  clearWorkspaceRepoConflicts: (_workspaceId): void => {
    state.conflicts = [];
  },
  listWorkspaceCommands: (_workspaceId: string): WorkspaceCommandItem[] => state.commands,
  replaceWorkspaceCommands: (_workspaceId: string, commands: WorkspaceCommandItem[]): void => {
    state.commands = commands;
    state.commandsVersion = undefined;
  },
  getWorkspaceCommandsVersion: (_workspaceId: string): string | undefined => state.commandsVersion,
  saveWorkspaceCommandsVersion: (_workspaceId: string, version: string): void => {
    state.commandsVersion = version;
  },
  saveRecycleBinEntry: (_entry): void => undefined,
  listRecycleBinEntries: (): RecycleBinEntry[] => [],
  removeRecycleBinEntry: (_id): void => undefined,
  storeWorkspacePassword: async (_workspaceId, password): Promise<void> => {
    state.password = password;
  },
  getWorkspacePassword: async (_workspaceId): Promise<string | undefined> => state.password,
  deleteWorkspacePassword: async (_workspaceId): Promise<void> => {
    state.password = undefined;
  },
  getJsonSetting: <T,>(_key: string): T | undefined => undefined,
  saveJsonSetting: (_key: string, _value: unknown): void => undefined,
  broadcastStatus: (_status): void => undefined,
  broadcastApplied: (_workspaceId): void => undefined,
});

describe("CloudSyncManager workspace token", () => {
  test("exports a v1 token and parses it back into a workspace draft", async () => {
    const workspace = createWorkspace();
    const manager = new CloudSyncManager(createDeps(workspace, "super-secret"));

    expect(typeof (manager as unknown as { exportWorkspaceToken?: unknown }).exportWorkspaceToken).toBe("function");
    expect(typeof (manager as unknown as { parseWorkspaceToken?: unknown }).parseWorkspaceToken).toBe("function");

    const { token } = await (manager as unknown as {
      exportWorkspaceToken: (workspaceId: string) => Promise<{ token: string }>;
    }).exportWorkspaceToken(workspace.id);

    expect(token.startsWith("nshell-csv1:")).toBe(true);

    const draft = await (manager as unknown as {
      parseWorkspaceToken: (token: string) => {
        apiBaseUrl: string;
        workspaceName: string;
        displayName: string;
        workspacePassword: string;
        pullIntervalSec: number;
        ignoreTlsErrors: boolean;
        enabled: boolean;
      };
    }).parseWorkspaceToken(token);

    expect(draft).toEqual({
      apiBaseUrl: "https://sync.example.com",
      workspaceName: workspace.workspaceName,
      displayName: workspace.displayName,
      workspacePassword: "super-secret",
      pullIntervalSec: workspace.pullIntervalSec,
      ignoreTlsErrors: workspace.ignoreTlsErrors,
      enabled: workspace.enabled,
    });
  });

  test("rejects tokens without the nshell-csv1 prefix", async () => {
    const manager = new CloudSyncManager(createDeps(createWorkspace(), "super-secret"));

    expect(typeof (manager as unknown as { parseWorkspaceToken?: unknown }).parseWorkspaceToken).toBe("function");

    await expect(
      (manager as unknown as {
        parseWorkspaceToken: (token: string) => Promise<unknown>;
      }).parseWorkspaceToken("token=abc"),
    ).rejects.toThrow("无效的云同步工作区 token");
  });

  test("rejects malformed token payloads", async () => {
    const manager = new CloudSyncManager(createDeps(createWorkspace(), "super-secret"));

    expect(typeof (manager as unknown as { parseWorkspaceToken?: unknown }).parseWorkspaceToken).toBe("function");

    const invalidJson = `nshell-csv1:${Buffer.from("{bad json", "utf8").toString("base64")}`;
    const missingPassword = `nshell-csv1:${Buffer.from(JSON.stringify({
      apiBaseUrl: "https://sync.example.com/",
      workspaceName: "prod-team",
      displayName: "生产环境",
      pullIntervalSec: 120,
      ignoreTlsErrors: false,
      enabled: true,
    }), "utf8").toString("base64")}`;

    await expect(
      (manager as unknown as {
        parseWorkspaceToken: (token: string) => Promise<unknown>;
      }).parseWorkspaceToken(invalidJson),
    ).rejects.toThrow("无效的云同步工作区 token");

    await expect(
      (manager as unknown as {
        parseWorkspaceToken: (token: string) => Promise<unknown>;
      }).parseWorkspaceToken(missingPassword),
    ).rejects.toThrow("无效的云同步工作区 token");
  });

  test("fails export when the workspace password is unavailable", async () => {
    const workspace = createWorkspace();
    const manager = new CloudSyncManager(createDeps(workspace, undefined));

    expect(typeof (manager as unknown as { exportWorkspaceToken?: unknown }).exportWorkspaceToken).toBe("function");

    await expect(
      (manager as unknown as {
        exportWorkspaceToken: (workspaceId: string) => Promise<{ token: string }>;
      }).exportWorkspaceToken(workspace.id),
    ).rejects.toThrow("该工作区缺少可导出的完整配置");
  });
});

describe("CloudSyncManager workspace repo sync", () => {
  test("auto-merges non-conflicting divergence against the pulled remote head", async () => {
    const workspace = { ...createWorkspace(), enabled: true };
    const baseSnapshot = repoSnapshot(workspace.id, "base-snapshot", []);
    const localSnapshot = repoSnapshot(workspace.id, "local-snapshot", [
      snapshotConnection("local-conn", "Local", "local.example.com"),
    ]);
    const remoteSnapshot = repoSnapshot(workspace.id, "remote-snapshot", [
      snapshotConnection("remote-conn", "Remote", "remote.example.com"),
    ]);
    const localState: WorkspaceRepoLocalState = {
      workspaceId: workspace.id,
      localHeadCommitId: "local-head",
      remoteHeadCommitId: "base-head",
      syncState: "ahead",
    };
    const state = createMutableState(workspace, { localState });
    state.snapshots.set(baseSnapshot.snapshotId, baseSnapshot);
    state.snapshots.set(localSnapshot.snapshotId, localSnapshot);
    state.commits.set("base-head", {
      workspaceId: workspace.id,
      commitId: "base-head",
      snapshotId: baseSnapshot.snapshotId,
      authorName: "remote",
      authorKind: "system",
      message: "base",
      createdAt: now,
    });
    state.commits.set("local-head", {
      workspaceId: workspace.id,
      commitId: "local-head",
      parentCommitId: "base-head",
      snapshotId: localSnapshot.snapshotId,
      authorName: "NextShell",
      authorKind: "user",
      message: "local",
      createdAt: now,
    });

    const manager = new CloudSyncManager(createMutableDeps(state));
    let pushedBaseHead: string | null | undefined;
    (manager as unknown as { api: unknown }).api = {
      push: async (_credentials: unknown, payload: {
        baseHeadCommitId?: string | null;
        commitMeta: WorkspaceRepoCommitMeta;
      }) => {
        pushedBaseHead = payload.baseHeadCommitId;
        return {
          status: "accepted" as const,
          headCommitId: payload.commitMeta.commitId,
          recentCommits: [],
        };
      },
    };

    await (manager as unknown as {
      registerDivergence: (
        workspace: CloudSyncWorkspaceProfile,
        credentials: {
          apiBaseUrl: string;
          workspaceName: string;
          workspacePassword: string;
          ignoreTlsErrors: boolean;
          clientId: string;
          clientVersion: string;
        },
        localState: WorkspaceRepoLocalState,
        remoteHeadCommitId: string,
        remoteSnapshot: WorkspaceRepoSnapshot,
      ) => Promise<WorkspaceRepoLocalState>;
    }).registerDivergence(
      workspace,
      {
        apiBaseUrl: workspace.apiBaseUrl,
        workspaceName: workspace.workspaceName,
        workspacePassword: "workspace-password",
        ignoreTlsErrors: false,
        clientId: "test-client",
        clientVersion: "test",
      },
      localState,
      "remote-head",
      remoteSnapshot,
    );

    expect(pushedBaseHead).toBe("remote-head");
    expect(state.connections.map((connection) => connection.host).sort()).toEqual([
      "local.example.com",
      "remote.example.com",
    ]);
  });

  test("keeps non-conflicting remote resources while conflicts remain", async () => {
    const workspace = { ...createWorkspace(), enabled: true };
    const baseSnapshot = repoSnapshot(workspace.id, "base-snapshot", [
      snapshotConnection("conflict-conn", "Conflict", "base.example.com"),
    ]);
    const localSnapshot = repoSnapshot(workspace.id, "local-snapshot", [
      snapshotConnection("conflict-conn", "Conflict", "local.example.com"),
    ]);
    const remoteSnapshot = repoSnapshot(workspace.id, "remote-snapshot", [
      snapshotConnection("conflict-conn", "Conflict", "remote.example.com"),
      snapshotConnection("remote-conn", "Remote", "remote.example.com"),
    ]);
    const localState: WorkspaceRepoLocalState = {
      workspaceId: workspace.id,
      localHeadCommitId: "local-head",
      remoteHeadCommitId: "base-head",
      syncState: "ahead",
    };
    const state = createMutableState(workspace, { localState });
    state.snapshots.set(baseSnapshot.snapshotId, baseSnapshot);
    state.snapshots.set(localSnapshot.snapshotId, localSnapshot);
    state.commits.set("base-head", {
      workspaceId: workspace.id,
      commitId: "base-head",
      snapshotId: baseSnapshot.snapshotId,
      authorName: "remote",
      authorKind: "system",
      message: "base",
      createdAt: now,
    });
    state.commits.set("local-head", {
      workspaceId: workspace.id,
      commitId: "local-head",
      parentCommitId: "base-head",
      snapshotId: localSnapshot.snapshotId,
      authorName: "NextShell",
      authorKind: "user",
      message: "local",
      createdAt: now,
    });

    const manager = new CloudSyncManager(createMutableDeps(state));
    const result = await (manager as unknown as {
      registerDivergence: (
        workspace: CloudSyncWorkspaceProfile,
        credentials: {
          apiBaseUrl: string;
          workspaceName: string;
          workspacePassword: string;
          ignoreTlsErrors: boolean;
          clientId: string;
          clientVersion: string;
        },
        localState: WorkspaceRepoLocalState,
        remoteHeadCommitId: string,
        remoteSnapshot: WorkspaceRepoSnapshot,
      ) => Promise<WorkspaceRepoLocalState>;
    }).registerDivergence(
      workspace,
      {
        apiBaseUrl: workspace.apiBaseUrl,
        workspaceName: workspace.workspaceName,
        workspacePassword: "workspace-password",
        ignoreTlsErrors: false,
        clientId: "test-client",
        clientVersion: "test",
      },
      localState,
      "remote-head",
      remoteSnapshot,
    );

    expect(result.syncState).toBe("diverged");
    expect(state.conflicts.length).toBe(1);
    expect(state.connections.map((connection) => connection.host).sort()).toEqual([
      "local.example.com",
      "remote.example.com",
    ]);
  });

  test("uses stable workspace-scope AAD for encrypted snapshot credentials", async () => {
    const firstWorkspace = { ...createWorkspace(), id: "client-a" };
    const secondWorkspace = { ...createWorkspace(), id: "client-b" };
    const scopeKey = buildScopeKey({
      kind: "cloud",
      apiBaseUrl: firstWorkspace.apiBaseUrl,
      workspaceName: firstWorkspace.workspaceName,
    });

    const buildSnapshotFor = async (workspace: CloudSyncWorkspaceProfile) => {
      const state = createMutableState(workspace);
      state.credentials.set("secret://ssh-key", "PRIVATE KEY");
      state.sshKeys = [{
        id: `key-${workspace.id}`,
        name: "Deploy key",
        keyContentRef: "secret://ssh-key",
        createdAt: now,
        updatedAt: now,
        resourceId: `${scopeKey}-deploy-key`,
        uuidInScope: "deploy-key",
        originKind: "cloud",
        originScopeKey: scopeKey,
        originWorkspaceId: workspace.id,
      }];
      const manager = new CloudSyncManager(createMutableDeps(state));
      return (manager as unknown as {
        buildWorkspaceSnapshot: (
          workspace: CloudSyncWorkspaceProfile,
          workspacePassword: string,
        ) => Promise<WorkspaceRepoSnapshot>;
      }).buildWorkspaceSnapshot(workspace, "workspace-password");
    };

    const firstSnapshot = await buildSnapshotFor(firstWorkspace);
    const secondSnapshot = await buildSnapshotFor(secondWorkspace);
    expect(firstSnapshot.sshKeys[0]?.privateKey.aad).toBe(`${scopeKey}:sshKey:deploy-key:privateKey`);
    expect(secondSnapshot.sshKeys[0]?.privateKey.aad).toBe(firstSnapshot.sshKeys[0]?.privateKey.aad);
  });
});

describe("CloudSyncManager workspace command sync", () => {
  test("preserves both local and remote command edits when both sides changed", async () => {
    const workspace = { ...createWorkspace(), enabled: true };
    const localCommand: WorkspaceCommandItem = {
      id: "cmd-1",
      workspaceId: workspace.id,
      name: "Deploy",
      group: "ops",
      command: "deploy local",
      isTemplate: false,
      createdAt: now,
      updatedAt: "2026-03-15T01:00:00.000Z",
    };
    const remoteCommand: WorkspaceCommandItem = {
      ...localCommand,
      command: "deploy remote",
      updatedAt: "2026-03-15T02:00:00.000Z",
    };
    const state = createMutableState(workspace, {
      commands: [localCommand],
      commandsVersion: "base-version",
    });
    const manager = new CloudSyncManager(createMutableDeps(state));
    let pushedCommands: WorkspaceCommandItem[] = [];
    (manager as unknown as { api: unknown }).api = {
      pullCommands: async () => ({
        status: "changed" as const,
        version: "remote-version",
        commands: [remoteCommand],
      }),
      pushCommands: async (_credentials: unknown, commands: WorkspaceCommandItem[]) => {
        pushedCommands = commands;
        return { version: "merged-version" };
      },
    };

    const result = await (manager as unknown as {
      syncWorkspaceCommands: (
        workspace: CloudSyncWorkspaceProfile,
        credentials: {
          apiBaseUrl: string;
          workspaceName: string;
          workspacePassword: string;
          ignoreTlsErrors: boolean;
          clientId: string;
          clientVersion: string;
        },
        localState: WorkspaceRepoLocalState,
        resolvedRemoteVersion?: string,
      ) => Promise<WorkspaceRepoLocalState>;
    }).syncWorkspaceCommands(
      workspace,
      {
        apiBaseUrl: workspace.apiBaseUrl,
        workspaceName: workspace.workspaceName,
        workspacePassword: "workspace-password",
        ignoreTlsErrors: false,
        clientId: "test-client",
        clientVersion: "test",
      },
      {
        workspaceId: workspace.id,
        remoteCommandsVersion: "base-version",
        syncState: "synced",
      },
      "remote-version",
    );

    expect(result.remoteCommandsVersion).toBe("merged-version");
    expect(state.commandsVersion).toBe("merged-version");
    expect(pushedCommands.map((command) => command.command).sort()).toEqual([
      "deploy local",
      "deploy remote",
    ]);
    expect(pushedCommands.some((command) => command.name === "Deploy (云端版本)")).toBe(true);
  });
});
