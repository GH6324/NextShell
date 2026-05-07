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
