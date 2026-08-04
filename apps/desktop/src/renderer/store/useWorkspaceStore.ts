import { create } from "zustand";
import type {
  ConnectionProfile,
  MonitorSnapshot,
  NetworkSnapshot,
  ProcessSnapshot,
  SessionDescriptor,
  SshKeyProfile,
  ProxyProfile
} from "@nextshell/core";

type LocalAwareSessionDescriptor = SessionDescriptor & {
  target?: "remote" | "local";
  connectionId?: string;
};

export type BottomTab = "files" | "commands" | "system-info" | "traceroute";

export interface NetworkPoint {
  inMbps: number;
  outMbps: number;
  capturedAt: string;
}

const NETWORK_RATE_HISTORY_CAP = 50;

function networkRateHistoryKey(connectionId: string, iface: string): string {
  return `${connectionId}:${iface}`;
}

function omitConnectionSnapshot<T>(
  snapshots: Record<string, T>,
  connectionId: string
): Record<string, T> {
  if (!(connectionId in snapshots)) {
    return snapshots;
  }

  const nextSnapshots = { ...snapshots };
  delete nextSnapshots[connectionId];
  return nextSnapshots;
}

function pruneNetworkRateHistory(
  networkRateHistory: Record<string, NetworkPoint[]>,
  connectionId: string
): Record<string, NetworkPoint[]> {
  const prefix = `${connectionId}:`;
  let changed = false;
  const nextHistory = { ...networkRateHistory };

  for (const key of Object.keys(nextHistory)) {
    if (key.startsWith(prefix)) {
      delete nextHistory[key];
      changed = true;
    }
  }

  return changed ? nextHistory : networkRateHistory;
}

function getSessionConnectionId(session?: SessionDescriptor): string | undefined {
  return (session as LocalAwareSessionDescriptor | undefined)?.connectionId;
}

function hasSessionForConnection(
  sessions: SessionDescriptor[],
  connectionId: string,
  type: SessionDescriptor["type"]
): boolean {
  return sessions.some(
    (session) => session.type === type && getSessionConnectionId(session) === connectionId
  );
}

interface MonitorSnapshotState {
  processSnapshots: Record<string, ProcessSnapshot>;
  networkSnapshots: Record<string, NetworkSnapshot>;
}

/**
 * Drop a connection's monitor snapshot only when the removed session was the *last*
 * pane of that kind for the connection. Multiple tabs against the same host share one
 * snapshot entry, so clearing eagerly blanks the panes that are still open.
 */
function pruneMonitorSnapshots(
  state: MonitorSnapshotState,
  remainingSessions: SessionDescriptor[],
  removedSessions: SessionDescriptor[]
): MonitorSnapshotState {
  let processSnapshots = state.processSnapshots;
  let networkSnapshots = state.networkSnapshots;

  for (const removed of removedSessions) {
    const connectionId = getSessionConnectionId(removed);
    if (!connectionId) {
      continue;
    }

    if (
      removed.type === "processManager" &&
      !hasSessionForConnection(remainingSessions, connectionId, "processManager")
    ) {
      processSnapshots = omitConnectionSnapshot(processSnapshots, connectionId);
    }

    if (
      removed.type === "networkMonitor" &&
      !hasSessionForConnection(remainingSessions, connectionId, "networkMonitor")
    ) {
      networkSnapshots = omitConnectionSnapshot(networkSnapshots, connectionId);
    }
  }

  return { processSnapshots, networkSnapshots };
}

function isLocalSession(session?: SessionDescriptor): boolean {
  return (session as LocalAwareSessionDescriptor | undefined)?.target === "local";
}

interface WorkspaceState {
  connections: ConnectionProfile[];
  sshKeys: SshKeyProfile[];
  proxies: ProxyProfile[];
  sessions: SessionDescriptor[];
  activeConnectionId?: string;
  activeSessionId?: string;
  monitor?: MonitorSnapshot;
  processSnapshots: Record<string, ProcessSnapshot>;
  networkSnapshots: Record<string, NetworkSnapshot>;
  networkRateHistory: Record<string, NetworkPoint[]>;
  lastActiveRemoteTerminalByConnection: Record<string, string | undefined>;
  /** 会话激活历史,最近使用在前。Ctrl+Tab 切换与关闭标签后的落点都用它。 */
  sessionMruIds: string[];
  bottomTab: BottomTab;
  setConnections: (connections: ConnectionProfile[]) => void;
  setSshKeys: (keys: SshKeyProfile[]) => void;
  setProxies: (proxies: ProxyProfile[]) => void;
  setActiveConnection: (connectionId?: string) => void;
  upsertSession: (session: SessionDescriptor) => void;
  setSessionStatus: (
    sessionId: string,
    status: SessionDescriptor["status"],
    reason?: string | null
  ) => void;
  removeSession: (sessionId: string) => void;
  removeSessionsByConnection: (connectionId: string) => void;
  reorderSession: (sourceSessionId: string, targetSessionId: string) => void;
  renameSessionTitle: (sessionId: string, title: string) => void;
  setActiveSession: (sessionId?: string) => void;
  setMonitor: (snapshot?: MonitorSnapshot) => void;
  setProcessSnapshot: (connectionId: string, snapshot: ProcessSnapshot) => void;
  setNetworkSnapshot: (connectionId: string, snapshot: NetworkSnapshot) => void;
  appendNetworkRate: (connectionId: string, iface: string, point: NetworkPoint) => void;
  clearNetworkRateHistory: (connectionId: string) => void;
  setBottomTab: (tab: BottomTab) => void;
}

const MAX_MRU_ENTRIES = 128;

const promoteMru = (mruIds: string[], sessionId: string): string[] =>
  [sessionId, ...mruIds.filter((id) => id !== sessionId)].slice(0, MAX_MRU_ENTRIES);

const pruneMru = (mruIds: string[], removedIds: ReadonlySet<string>): string[] =>
  mruIds.filter((id) => !removedIds.has(id));

/**
 * 关闭标签后的落点：优先回到最近用过的仍存活的标签(视线不跳),
 * 其次是被关标签原位置右侧的邻居,最后才是末尾标签。
 */
export const pickNextActiveSessionId = (
  remainingSessions: readonly SessionDescriptor[],
  removedIndex: number,
  mruIds: readonly string[]
): string | undefined => {
  const alive = new Set(remainingSessions.map((session) => session.id));
  for (const id of mruIds) {
    if (alive.has(id)) {
      return id;
    }
  }
  const neighbor =
    remainingSessions[Math.min(Math.max(removedIndex, 0), remainingSessions.length - 1)];
  return neighbor?.id;
};

const omitLastActiveTerminalForSession = (
  lastActiveRemoteTerminalByConnection: Record<string, string | undefined>,
  session?: SessionDescriptor
): Record<string, string | undefined> => {
  if (
    !session ||
    session.target !== "remote" ||
    session.type !== "terminal" ||
    !session.connectionId
  ) {
    return lastActiveRemoteTerminalByConnection;
  }

  if (lastActiveRemoteTerminalByConnection[session.connectionId] !== session.id) {
    return lastActiveRemoteTerminalByConnection;
  }

  const next = { ...lastActiveRemoteTerminalByConnection };
  delete next[session.connectionId];
  return next;
};

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  connections: [],
  sshKeys: [],
  proxies: [],
  sessions: [],
  bottomTab: "files",
  processSnapshots: {},
  networkSnapshots: {},
  networkRateHistory: {},
  lastActiveRemoteTerminalByConnection: {},
  sessionMruIds: [],
  setConnections: (connections) => set({ connections }),
  setSshKeys: (sshKeys) => set({ sshKeys }),
  setProxies: (proxies) => set({ proxies }),
  setActiveConnection: (activeConnectionId) => set({ activeConnectionId }),
  upsertSession: (session) =>
    set((state) => {
      const exists = state.sessions.some((item) => item.id === session.id);
      return {
        sessions: exists
          ? state.sessions.map((item) => (item.id === session.id ? session : item))
          : [...state.sessions, session]
      };
    }),
  setSessionStatus: (sessionId, status, reason) =>
    set((state) => ({
      sessions: state.sessions.map((session) => {
        if (session.id !== sessionId) {
          return session;
        }

        if (reason === null) {
          const { reason: _ignored, ...rest } = session;
          return { ...rest, status };
        }

        if (reason !== undefined) {
          return { ...session, status, reason };
        }

        if (status !== "failed") {
          const { reason: _ignored, ...rest } = session;
          return { ...rest, status };
        }

        return { ...session, status };
      })
    })),
  removeSession: (sessionId) =>
    set((state) => {
      const target = state.sessions.find((session) => session.id === sessionId);
      const removedIndex = state.sessions.findIndex((session) => session.id === sessionId);
      const sessions = state.sessions.filter((session) => session.id !== sessionId);
      const sessionMruIds = pruneMru(state.sessionMruIds, new Set([sessionId]));
      const candidateActiveSessionId =
        state.activeSessionId === sessionId
          ? pickNextActiveSessionId(sessions, removedIndex, sessionMruIds)
          : state.activeSessionId;
      const nextActiveSession = candidateActiveSessionId
        ? sessions.find((session) => session.id === candidateActiveSessionId)
        : undefined;
      const nextActiveConnectionId = nextActiveSession
        ? isLocalSession(nextActiveSession)
          ? state.activeConnectionId
          : getSessionConnectionId(nextActiveSession)
        : undefined;

      const { processSnapshots, networkSnapshots } = pruneMonitorSnapshots(
        state,
        sessions,
        target ? [target] : []
      );

      return {
        sessions,
        sessionMruIds,
        activeSessionId: nextActiveSession?.id,
        activeConnectionId: nextActiveConnectionId,
        processSnapshots,
        networkSnapshots,
        lastActiveRemoteTerminalByConnection: omitLastActiveTerminalForSession(
          state.lastActiveRemoteTerminalByConnection,
          target
        )
      };
    }),
  removeSessionsByConnection: (connectionId) =>
    set((state) => {
      const removedSessions = state.sessions.filter(
        (session) => session.connectionId === connectionId
      );
      const sessions = state.sessions.filter((session) => session.connectionId !== connectionId);
      const sessionMruIds = pruneMru(
        state.sessionMruIds,
        new Set(removedSessions.map((session) => session.id))
      );
      const hasCurrentActiveSession = Boolean(
        state.activeSessionId && sessions.some((session) => session.id === state.activeSessionId)
      );
      const candidateActiveSessionId = hasCurrentActiveSession
        ? state.activeSessionId
        : pickNextActiveSessionId(sessions, sessions.length - 1, sessionMruIds);
      const nextActiveSession = candidateActiveSessionId
        ? sessions.find((session) => session.id === candidateActiveSessionId)
        : undefined;
      const nextActiveConnectionId = nextActiveSession
        ? isLocalSession(nextActiveSession)
          ? state.activeConnectionId
          : getSessionConnectionId(nextActiveSession)
        : undefined;

      let lastActiveRemoteTerminalByConnection = state.lastActiveRemoteTerminalByConnection;
      for (const removedSession of removedSessions) {
        lastActiveRemoteTerminalByConnection = omitLastActiveTerminalForSession(
          lastActiveRemoteTerminalByConnection,
          removedSession
        );
      }

      const { processSnapshots, networkSnapshots } = pruneMonitorSnapshots(
        state,
        sessions,
        removedSessions
      );
      // Only wipe the rate history once nothing else references the connection.
      const networkRateHistory = sessions.some(
        (session) => getSessionConnectionId(session) === connectionId
      )
        ? state.networkRateHistory
        : pruneNetworkRateHistory(state.networkRateHistory, connectionId);

      return {
        sessions,
        sessionMruIds,
        activeSessionId: nextActiveSession?.id,
        activeConnectionId: nextActiveConnectionId,
        processSnapshots,
        networkSnapshots,
        networkRateHistory,
        lastActiveRemoteTerminalByConnection
      };
    }),
  reorderSession: (sourceSessionId, targetSessionId) =>
    set((state) => {
      if (sourceSessionId === targetSessionId) {
        return {};
      }

      const sourceIndex = state.sessions.findIndex((session) => session.id === sourceSessionId);
      const targetIndex = state.sessions.findIndex((session) => session.id === targetSessionId);

      if (sourceIndex < 0 || targetIndex < 0) {
        return {};
      }

      const sessions = [...state.sessions];
      const [source] = sessions.splice(sourceIndex, 1);
      if (!source) {
        return {};
      }
      const adjustedTargetIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
      sessions.splice(adjustedTargetIndex, 0, source);

      return { sessions };
    }),
  renameSessionTitle: (sessionId, title) =>
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId ? { ...session, title } : session
      )
    })),
  setActiveSession: (activeSessionId) =>
    set((state) => {
      if (!activeSessionId) {
        return { activeSessionId };
      }

      const activeSession = state.sessions.find((session) => session.id === activeSessionId);
      if (!activeSession) {
        return { activeSessionId };
      }

      return {
        activeSessionId,
        sessionMruIds: promoteMru(state.sessionMruIds, activeSessionId),
        activeConnectionId: isLocalSession(activeSession)
          ? state.activeConnectionId
          : getSessionConnectionId(activeSession),
        lastActiveRemoteTerminalByConnection:
          activeSession.target === "remote" &&
          activeSession.type === "terminal" &&
          activeSession.connectionId
            ? {
                ...state.lastActiveRemoteTerminalByConnection,
                [activeSession.connectionId]: activeSession.id
              }
            : state.lastActiveRemoteTerminalByConnection
      };
    }),
  setMonitor: (monitor) => set({ monitor }),
  setProcessSnapshot: (connectionId, snapshot) =>
    set((state) => ({
      processSnapshots: { ...state.processSnapshots, [connectionId]: snapshot }
    })),
  setNetworkSnapshot: (connectionId, snapshot) =>
    set((state) => ({
      networkSnapshots: { ...state.networkSnapshots, [connectionId]: snapshot }
    })),
  appendNetworkRate: (connectionId, iface, point) =>
    set((state) => {
      const key = networkRateHistoryKey(connectionId, iface);
      const existing = state.networkRateHistory[key] ?? [];
      const latest = existing[existing.length - 1];
      let merged: NetworkPoint[];
      if (latest?.capturedAt === point.capturedAt) {
        merged = [...existing.slice(0, -1), point];
      } else {
        merged = [...existing, point];
      }
      const trimmed = merged.slice(-NETWORK_RATE_HISTORY_CAP);
      return {
        networkRateHistory: { ...state.networkRateHistory, [key]: trimmed }
      };
    }),
  clearNetworkRateHistory: (connectionId) =>
    set((state) => {
      return {
        networkRateHistory: pruneNetworkRateHistory(state.networkRateHistory, connectionId)
      };
    }),
  setBottomTab: (tab) =>
    set({
      bottomTab:
        tab === "commands" || tab === "files" || tab === "system-info" || tab === "traceroute"
          ? tab
          : "files"
    })
}));
