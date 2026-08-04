export interface RemoteExplorerRequestSnapshot {
  connectionId: string;
  path: string;
  version: number;
}

export interface RemoteExplorerRequestState {
  connectionId?: string;
  path: string;
}

export const createRemoteExplorerRequestGate = () => {
  let version = 0;

  return {
    invalidate(): void {
      version += 1;
    },

    /**
     * 当前闸门版本。用于判断「自某一刻起是否有别的请求接管过面板」，
     * 例如缓存恢复后的静默校验发车前要先确认没人抢先加载过。
     */
    version(): number {
      return version;
    },

    begin(connectionId: string, path: string): RemoteExplorerRequestSnapshot {
      version += 1;
      return {
        connectionId,
        path,
        version
      };
    },

    isCurrent(
      snapshot: RemoteExplorerRequestSnapshot,
      current: RemoteExplorerRequestState
    ): boolean {
      return (
        snapshot.version === version &&
        snapshot.connectionId === current.connectionId &&
        snapshot.path === current.path
      );
    }
  };
};
