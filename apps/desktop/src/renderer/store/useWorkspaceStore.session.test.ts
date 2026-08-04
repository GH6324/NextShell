import type { MonitorSnapshot, SessionDescriptor } from "@nextshell/core";
import { useWorkspaceStore } from "./useWorkspaceStore";

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}: expected "${String(expected)}", got "${String(actual)}"`);
  }
};

const assert = (condition: boolean, message: string): void => {
  if (!condition) {
    throw new Error(message);
  }
};

const createSession = (
  id: string,
  connectionId: string,
  status: SessionDescriptor["status"],
  reason?: string,
  type: SessionDescriptor["type"] = "terminal"
): SessionDescriptor => ({
  id,
  target: "remote",
  connectionId,
  title: `${connectionId}#1`,
  type,
  status,
  createdAt: "2026-01-01T00:00:00.000Z",
  reconnectable: true,
  ...(reason !== undefined ? { reason } : {})
});

const createLocalTerminalSession = (
  id: string,
  status: SessionDescriptor["status"]
): SessionDescriptor =>
  ({
    id,
    title: "本地终端 · zsh",
    type: "terminal",
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    reconnectable: true,
    target: "local"
  }) as unknown as SessionDescriptor;

const createMonitorSnapshot = (connectionId: string, cpuPercent = 10): MonitorSnapshot => ({
  connectionId,
  loadAverage: [0.1, 0.2, 0.3],
  cpuPercent,
  memoryPercent: 20,
  memoryUsedMb: 200,
  memoryTotalMb: 1000,
  swapPercent: 0,
  swapUsedMb: 0,
  swapTotalMb: 0,
  diskPercent: 30,
  diskUsedGb: 3,
  diskTotalGb: 10,
  networkInMbps: 1,
  networkOutMbps: 2,
  networkInterface: "eth0",
  networkInterfaceOptions: ["eth0"],
  processes: [],
  capturedAt: "2026-01-01T00:00:00.000Z"
});

const resetStore = (): void => {
  useWorkspaceStore.setState({
    connections: [],
    sshKeys: [],
    proxies: [],
    sessions: [],
    activeConnectionId: undefined,
    activeSessionId: undefined,
    monitorSnapshots: {},
    processSnapshots: {},
    networkSnapshots: {},
    networkRateHistory: {},
    sessionMruIds: [],
    lastActiveRemoteTerminalByConnection: {},
    bottomTab: "files"
  });
};

(() => {
  resetStore();
  useWorkspaceStore.setState({
    sessions: [createSession("s1", "c1", "failed", "previous failure")],
    activeSessionId: "s1",
    activeConnectionId: "c1"
  });
  useWorkspaceStore.getState().setSessionStatus("s1", "connected");
  const session = useWorkspaceStore.getState().sessions[0];
  assert(session !== undefined, "session should exist");
  assertEqual(
    session?.reason,
    undefined,
    "reason should clear on non-failed status when reason omitted"
  );
})();

(() => {
  resetStore();
  useWorkspaceStore.setState({
    sessions: [createSession("s1", "c1", "connected"), createSession("s2", "c2", "connected")],
    activeSessionId: "s1",
    activeConnectionId: "c1"
  });
  useWorkspaceStore.getState().removeSession("s1");
  const state = useWorkspaceStore.getState();
  assertEqual(state.activeSessionId, "s2", "active session should switch to remaining session");
  assertEqual(state.activeConnectionId, "c2", "active connection should align with active session");
})();

(() => {
  resetStore();
  useWorkspaceStore.setState({
    sessions: [createSession("s1", "c1", "connected"), createSession("s2", "c2", "connected")],
    activeSessionId: "s1",
    activeConnectionId: "c1",
    networkRateHistory: {
      "c1:eth0": [{ inMbps: 1, outMbps: 1, capturedAt: "1" }],
      "c2:eth0": [{ inMbps: 2, outMbps: 2, capturedAt: "2" }]
    }
  });
  useWorkspaceStore.getState().removeSessionsByConnection("c1");
  const state = useWorkspaceStore.getState();
  assertEqual(state.sessions.length, 1, "sessions on removed connection should be removed");
  assertEqual(state.sessions[0]?.id, "s2", "remaining session should be from other connection");
  assertEqual(state.activeSessionId, "s2", "active session should align after bulk remove");
  assertEqual(state.activeConnectionId, "c2", "active connection should align after bulk remove");
  assertEqual(
    state.networkRateHistory["c1:eth0"],
    undefined,
    "removed connection history should be pruned"
  );
})();

(() => {
  resetStore();
  useWorkspaceStore.setState({
    sessions: [
      createSession("remote-1", "c1", "connected"),
      createLocalTerminalSession("local-1", "connected")
    ],
    activeSessionId: "remote-1",
    activeConnectionId: "c1"
  });

  useWorkspaceStore.getState().removeSessionsByConnection("c1");
  const state = useWorkspaceStore.getState();
  assertEqual(
    state.activeSessionId,
    "local-1",
    "removeSessionsByConnection should switch to the remaining local session"
  );
  assertEqual(
    state.activeConnectionId,
    "c1",
    "removeSessionsByConnection should preserve the last active remote connection when local session remains"
  );
})();

(() => {
  resetStore();
  useWorkspaceStore.setState({
    sessions: [
      createSession("pm1", "c1", "connected", undefined, "processManager"),
      createSession("nm1", "c1", "connected", undefined, "networkMonitor")
    ],
    processSnapshots: {
      c1: { connectionId: "c1", capturedAt: "2026-01-01T00:00:00.000Z", processes: [] }
    },
    networkSnapshots: {
      c1: {
        connectionId: "c1",
        capturedAt: "2026-01-01T00:00:00.000Z",
        listeners: [],
        connections: []
      }
    }
  });
  useWorkspaceStore.getState().removeSession("pm1");
  const state = useWorkspaceStore.getState();
  assertEqual(
    state.processSnapshots.c1,
    undefined,
    "closing process manager should clear process snapshot"
  );
  assert(
    state.networkSnapshots.c1 !== undefined,
    "closing process manager should keep network snapshot"
  );
})();

(() => {
  resetStore();
  useWorkspaceStore.setState({
    sessions: [
      createSession("pm1", "c1", "connected", undefined, "processManager"),
      createSession("nm1", "c1", "connected", undefined, "networkMonitor")
    ],
    processSnapshots: {
      c1: { connectionId: "c1", capturedAt: "2026-01-01T00:00:00.000Z", processes: [] }
    },
    networkSnapshots: {
      c1: {
        connectionId: "c1",
        capturedAt: "2026-01-01T00:00:00.000Z",
        listeners: [],
        connections: []
      }
    }
  });
  useWorkspaceStore.getState().removeSession("nm1");
  const state = useWorkspaceStore.getState();
  assertEqual(
    state.networkSnapshots.c1,
    undefined,
    "closing network monitor should clear network snapshot"
  );
  assert(
    state.processSnapshots.c1 !== undefined,
    "closing network monitor should keep process snapshot"
  );
})();

(() => {
  resetStore();
  useWorkspaceStore.setState({
    sessions: [
      createSession("s1", "c1", "connected"),
      createSession("pm1", "c1", "connected", undefined, "processManager")
    ],
    processSnapshots: {
      c1: { connectionId: "c1", capturedAt: "2026-01-01T00:00:00.000Z", processes: [] }
    },
    networkSnapshots: {
      c1: {
        connectionId: "c1",
        capturedAt: "2026-01-01T00:00:00.000Z",
        listeners: [],
        connections: []
      }
    }
  });
  useWorkspaceStore.getState().removeSession("s1");
  const state = useWorkspaceStore.getState();
  assert(
    state.processSnapshots.c1 !== undefined,
    "closing terminal should not clear process snapshot"
  );
  assert(
    state.networkSnapshots.c1 !== undefined,
    "closing terminal should not clear network snapshot"
  );
})();

(() => {
  resetStore();
  useWorkspaceStore.setState({
    sessions: [
      createSession("s1", "c1", "connected"),
      createSession("pm1", "c1", "connected", undefined, "processManager"),
      createSession("nm1", "c1", "connected", undefined, "networkMonitor"),
      createSession("s2", "c2", "connected")
    ],
    activeSessionId: "pm1",
    activeConnectionId: "c1",
    processSnapshots: {
      c1: { connectionId: "c1", capturedAt: "2026-01-01T00:00:00.000Z", processes: [] },
      c2: { connectionId: "c2", capturedAt: "2026-01-01T00:00:00.000Z", processes: [] }
    },
    networkSnapshots: {
      c1: {
        connectionId: "c1",
        capturedAt: "2026-01-01T00:00:00.000Z",
        listeners: [],
        connections: []
      },
      c2: {
        connectionId: "c2",
        capturedAt: "2026-01-01T00:00:00.000Z",
        listeners: [],
        connections: []
      }
    },
    networkRateHistory: {
      "c1:eth0": [{ inMbps: 1, outMbps: 1, capturedAt: "1" }],
      "c2:eth0": [{ inMbps: 2, outMbps: 2, capturedAt: "2" }]
    }
  });
  useWorkspaceStore.getState().removeSessionsByConnection("c1");
  const state = useWorkspaceStore.getState();
  assertEqual(state.processSnapshots.c1, undefined, "bulk remove should clear process snapshot");
  assertEqual(state.networkSnapshots.c1, undefined, "bulk remove should clear network snapshot");
  assert(
    state.processSnapshots.c2 !== undefined,
    "bulk remove should keep other process snapshots"
  );
  assert(
    state.networkSnapshots.c2 !== undefined,
    "bulk remove should keep other network snapshots"
  );
  assertEqual(state.activeSessionId, "s2", "bulk remove should advance active session");
  assertEqual(state.activeConnectionId, "c2", "bulk remove should advance active connection");
})();

(() => {
  resetStore();
  useWorkspaceStore.setState({
    sessions: [createSession("s1", "c1", "connected"), createSession("s2", "c2", "connected")],
    activeSessionId: "s1",
    activeConnectionId: "c1"
  });
  useWorkspaceStore.getState().setActiveSession("s2");
  const state = useWorkspaceStore.getState();
  assertEqual(state.activeSessionId, "s2", "setActiveSession should switch active session");
  assertEqual(state.activeConnectionId, "c2", "setActiveSession should align active connection");
})();

(() => {
  resetStore();
  useWorkspaceStore.setState({
    sessions: [
      createSession("remote-1", "c1", "connected"),
      createLocalTerminalSession("local-1", "connected")
    ],
    activeSessionId: "remote-1",
    activeConnectionId: "c1"
  });

  useWorkspaceStore.getState().setActiveSession("local-1");
  const state = useWorkspaceStore.getState();
  assertEqual(
    state.activeSessionId,
    "local-1",
    "setActiveSession should switch to local terminal session"
  );
  assertEqual(
    state.activeConnectionId,
    "c1",
    "setActiveSession should preserve active connection when the selected session is local"
  );
})();

(() => {
  // Two process manager tabs on the same host: closing one must keep the shared snapshot
  // so the surviving pane does not blank out until the next poll.
  resetStore();
  useWorkspaceStore.setState({
    sessions: [
      createSession("pm1", "c1", "connected", undefined, "processManager"),
      createSession("pm2", "c1", "connected", undefined, "processManager"),
      createSession("nm1", "c1", "connected", undefined, "networkMonitor"),
      createSession("nm2", "c1", "connected", undefined, "networkMonitor")
    ],
    activeSessionId: "pm1",
    activeConnectionId: "c1",
    processSnapshots: {
      c1: { connectionId: "c1", capturedAt: "2026-01-01T00:00:00.000Z", processes: [] }
    },
    networkSnapshots: {
      c1: {
        connectionId: "c1",
        capturedAt: "2026-01-01T00:00:00.000Z",
        listeners: [],
        connections: []
      }
    }
  });

  useWorkspaceStore.getState().removeSession("pm1");
  let state = useWorkspaceStore.getState();
  assert(
    state.processSnapshots.c1 !== undefined,
    "closing one of two process managers on the same connection should keep the snapshot"
  );

  useWorkspaceStore.getState().removeSession("nm1");
  state = useWorkspaceStore.getState();
  assert(
    state.networkSnapshots.c1 !== undefined,
    "closing one of two network monitors on the same connection should keep the snapshot"
  );

  useWorkspaceStore.getState().removeSession("pm2");
  useWorkspaceStore.getState().removeSession("nm2");
  state = useWorkspaceStore.getState();
  assertEqual(
    state.processSnapshots.c1,
    undefined,
    "closing the last process manager should clear the process snapshot"
  );
  assertEqual(
    state.networkSnapshots.c1,
    undefined,
    "closing the last network monitor should clear the network snapshot"
  );
})();

(() => {
  // Failure path: removing an unknown session id must not touch monitor state.
  resetStore();
  useWorkspaceStore.setState({
    sessions: [createSession("pm1", "c1", "connected", undefined, "processManager")],
    activeSessionId: "pm1",
    activeConnectionId: "c1",
    processSnapshots: {
      c1: { connectionId: "c1", capturedAt: "2026-01-01T00:00:00.000Z", processes: [] }
    },
    networkRateHistory: {
      "c1:eth0": [{ inMbps: 1, outMbps: 1, capturedAt: "1" }]
    }
  });
  useWorkspaceStore.getState().removeSession("does-not-exist");
  const state = useWorkspaceStore.getState();
  assertEqual(state.sessions.length, 1, "removing an unknown session should keep sessions intact");
  assert(
    state.processSnapshots.c1 !== undefined,
    "removing an unknown session should not clear process snapshots"
  );
  assert(
    state.networkRateHistory["c1:eth0"] !== undefined,
    "removing an unknown session should not prune network rate history"
  );
})();

(() => {
  // removeSession never prunes the rate history, so the sidebar chart survives tab churn.
  resetStore();
  useWorkspaceStore.setState({
    sessions: [
      createSession("nm1", "c1", "connected", undefined, "networkMonitor"),
      createSession("s1", "c1", "connected")
    ],
    activeSessionId: "nm1",
    activeConnectionId: "c1",
    networkRateHistory: {
      "c1:eth0": [{ inMbps: 1, outMbps: 1, capturedAt: "1" }]
    }
  });
  useWorkspaceStore.getState().removeSession("nm1");
  const state = useWorkspaceStore.getState();
  assert(
    state.networkRateHistory["c1:eth0"] !== undefined,
    "closing a monitor tab should keep the connection rate history for remaining tabs"
  );
})();

(() => {
  resetStore();
  useWorkspaceStore.getState().setBottomTab("files");
  const state = useWorkspaceStore.getState();
  assertEqual(state.bottomTab, "files", "setBottomTab should accept files");
})();

(() => {
  // setActiveSession maintains the MRU stack: most recent first, no duplicates.
  resetStore();
  useWorkspaceStore.setState({
    sessions: [
      createSession("s1", "c1", "connected"),
      createSession("s2", "c2", "connected"),
      createSession("s3", "c3", "connected")
    ]
  });
  const store = useWorkspaceStore.getState();
  store.setActiveSession("s1");
  useWorkspaceStore.getState().setActiveSession("s2");
  useWorkspaceStore.getState().setActiveSession("s3");
  useWorkspaceStore.getState().setActiveSession("s2");
  const state = useWorkspaceStore.getState();
  assertEqual(
    state.sessionMruIds.join(","),
    "s2,s3,s1",
    "MRU should be most-recent-first, deduped"
  );
})();

(() => {
  // 每次激活都进 MRU:Ctrl+Tab 循环期间不再有「途经的激活」,松开 Ctrl 的那一次
  // 就是唯一一次激活,所以 setActiveSession 没有不提升 MRU 的分支。
  resetStore();
  useWorkspaceStore.setState({
    sessions: [
      createSession("s1", "c1", "connected"),
      createSession("s2", "c2", "connected"),
      createSession("s3", "c3", "connected")
    ]
  });
  useWorkspaceStore.getState().setActiveSession("s1");
  useWorkspaceStore.getState().setActiveSession("s2");
  useWorkspaceStore.getState().setActiveSession("s3");
  const state = useWorkspaceStore.getState();
  assertEqual(state.activeSessionId, "s3", "activation should switch tabs");
  assertEqual(state.activeConnectionId, "c3", "activation should follow the connection");
  assertEqual(
    state.sessionMruIds.join(","),
    "s3,s2,s1",
    "the landed tab should end up in front of the MRU"
  );
})();

(() => {
  // Closing the active tab lands on the previously used tab, not the last tab.
  resetStore();
  useWorkspaceStore.setState({
    sessions: [
      createSession("s1", "c1", "connected"),
      createSession("s2", "c2", "connected"),
      createSession("s3", "c3", "connected")
    ]
  });
  useWorkspaceStore.getState().setActiveSession("s1");
  useWorkspaceStore.getState().setActiveSession("s2");
  useWorkspaceStore.getState().removeSession("s2");
  const state = useWorkspaceStore.getState();
  assertEqual(state.activeSessionId, "s1", "closing active tab should return to MRU predecessor");
  assertEqual(state.sessionMruIds.includes("s2"), false, "closed session should leave the MRU");
})();

(() => {
  // Without MRU history, closing falls back to the neighbor that slides into place.
  resetStore();
  useWorkspaceStore.setState({
    sessions: [
      createSession("s1", "c1", "connected"),
      createSession("s2", "c2", "connected"),
      createSession("s3", "c3", "connected")
    ],
    activeSessionId: "s2",
    activeConnectionId: "c2",
    sessionMruIds: []
  });
  useWorkspaceStore.getState().removeSession("s2");
  const state = useWorkspaceStore.getState();
  assertEqual(state.activeSessionId, "s3", "no-MRU close should activate the right neighbor");
})();

(() => {
  // Bulk close of a connection also consults the MRU for the next active tab.
  resetStore();
  useWorkspaceStore.setState({
    sessions: [
      createSession("a1", "c1", "connected"),
      createSession("b1", "c2", "connected"),
      createSession("b2", "c2", "connected"),
      createSession("z1", "c3", "connected")
    ]
  });
  useWorkspaceStore.getState().setActiveSession("b1");
  useWorkspaceStore.getState().setActiveSession("a1");
  useWorkspaceStore.getState().setActiveSession("b2");
  useWorkspaceStore.getState().removeSessionsByConnection("c2");
  const state = useWorkspaceStore.getState();
  assertEqual(state.activeSessionId, "a1", "bulk close should land on the MRU survivor");
})();

(() => {
  // System monitor snapshots are per connection: switching hosts must not blank
  // the other host's cached data.
  resetStore();
  useWorkspaceStore.getState().setMonitorSnapshot(createMonitorSnapshot("c1", 11));
  useWorkspaceStore.getState().setMonitorSnapshot(createMonitorSnapshot("c2", 22));
  let state = useWorkspaceStore.getState();
  assertEqual(state.monitorSnapshots.c1?.cpuPercent, 11, "c1 snapshot should be stored under c1");
  assertEqual(state.monitorSnapshots.c2?.cpuPercent, 22, "c2 snapshot should be stored under c2");

  useWorkspaceStore.getState().setMonitorSnapshot(createMonitorSnapshot("c1", 33));
  state = useWorkspaceStore.getState();
  assertEqual(state.monitorSnapshots.c1?.cpuPercent, 33, "a newer snapshot should replace its own");
  assertEqual(state.monitorSnapshots.c2?.cpuPercent, 22, "the other connection must be untouched");

  useWorkspaceStore.getState().removeMonitorSnapshot("c1");
  state = useWorkspaceStore.getState();
  assertEqual(state.monitorSnapshots.c1, undefined, "removeMonitorSnapshot should drop its entry");
  assert(state.monitorSnapshots.c2 !== undefined, "removeMonitorSnapshot should drop only one key");

  // Failure path: removing an unknown connection is a no-op.
  const before = useWorkspaceStore.getState().monitorSnapshots;
  useWorkspaceStore.getState().removeMonitorSnapshot("nope");
  assertEqual(
    useWorkspaceStore.getState().monitorSnapshots,
    before,
    "removing an unknown connection should not even rebuild the record"
  );
})();

(() => {
  // The cached snapshot outlives single tab closes and dies with the last tab of
  // the connection — the sidebar panel keeps rendering while any tab remains.
  resetStore();
  useWorkspaceStore.setState({
    sessions: [
      createSession("s1", "c1", "connected"),
      createSession("pm1", "c1", "connected", undefined, "processManager"),
      createSession("s2", "c2", "connected")
    ],
    activeSessionId: "s1",
    activeConnectionId: "c1",
    monitorSnapshots: {
      c1: createMonitorSnapshot("c1"),
      c2: createMonitorSnapshot("c2")
    }
  });

  useWorkspaceStore.getState().removeSession("s1");
  let state = useWorkspaceStore.getState();
  assert(
    state.monitorSnapshots.c1 !== undefined,
    "closing one tab of a connection should keep its monitor snapshot"
  );

  useWorkspaceStore.getState().removeSession("pm1");
  state = useWorkspaceStore.getState();
  assertEqual(
    state.monitorSnapshots.c1,
    undefined,
    "closing the last tab of a connection should drop its monitor snapshot"
  );
  assert(
    state.monitorSnapshots.c2 !== undefined,
    "another connection's monitor snapshot must survive"
  );
})();

(() => {
  // Bulk removal (connection removed / disconnected) prunes exactly one entry.
  resetStore();
  useWorkspaceStore.setState({
    sessions: [createSession("s1", "c1", "connected"), createSession("s2", "c2", "connected")],
    activeSessionId: "s1",
    activeConnectionId: "c1",
    monitorSnapshots: {
      c1: createMonitorSnapshot("c1"),
      c2: createMonitorSnapshot("c2")
    }
  });
  useWorkspaceStore.getState().removeSessionsByConnection("c1");
  const state = useWorkspaceStore.getState();
  assertEqual(
    state.monitorSnapshots.c1,
    undefined,
    "bulk remove should clear the connection's monitor snapshot"
  );
  assert(state.monitorSnapshots.c2 !== undefined, "bulk remove should keep other snapshots");
})();

(() => {
  // Failure path: removing an unknown session must not touch monitor snapshots.
  resetStore();
  useWorkspaceStore.setState({
    sessions: [createSession("s1", "c1", "connected")],
    monitorSnapshots: { c1: createMonitorSnapshot("c1") }
  });
  useWorkspaceStore.getState().removeSession("ghost");
  assert(
    useWorkspaceStore.getState().monitorSnapshots.c1 !== undefined,
    "removing an unknown session should not clear monitor snapshots"
  );
})();

(() => {
  // Rate history now records background connections too, so the number of
  // (connectionId, iface) series is capped least-recently-appended.
  resetStore();
  const point = { inMbps: 1, outMbps: 1, capturedAt: "2026-01-01T00:00:00.000Z" };
  const append = (connectionId: string, iface: string): void => {
    useWorkspaceStore.getState().appendNetworkRate(connectionId, iface, point);
  };

  for (let index = 0; index < 32; index += 1) {
    append(`conn-${index}`, "eth0");
  }
  assertEqual(
    Object.keys(useWorkspaceStore.getState().networkRateHistory).length,
    32,
    "the history should hold the full cap without evicting"
  );

  // Touch the oldest series so it is no longer the eviction candidate.
  append("conn-0", "eth0");
  append("conn-32", "eth0");
  const state = useWorkspaceStore.getState();
  assertEqual(
    Object.keys(state.networkRateHistory).length,
    32,
    "exceeding the cap should evict instead of growing"
  );
  assert(
    state.networkRateHistory["conn-0:eth0"] !== undefined,
    "a re-appended series should count as recently used and survive"
  );
  assertEqual(
    state.networkRateHistory["conn-1:eth0"],
    undefined,
    "the least recently appended series should be the one evicted"
  );
  assert(
    state.networkRateHistory["conn-32:eth0"] !== undefined,
    "the series just appended must always be kept"
  );
})();

(() => {
  // Per-series cap: only the newest 50 points are kept, newest last.
  resetStore();
  for (let index = 0; index < 60; index += 1) {
    useWorkspaceStore.getState().appendNetworkRate("c1", "eth0", {
      inMbps: index,
      outMbps: index,
      capturedAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`
    });
  }
  const series = useWorkspaceStore.getState().networkRateHistory["c1:eth0"] ?? [];
  assertEqual(series.length, 50, "a series should be trimmed to the point cap");
  assertEqual(series[series.length - 1]?.inMbps, 59, "the newest point should be last");
})();
