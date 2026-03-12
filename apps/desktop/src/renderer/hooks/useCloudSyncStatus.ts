import { useCallback, useEffect, useRef, useState } from "react";
import type { CloudSyncStatusView } from "../components/settings-center/types";
import {
  DEFAULT_CLOUD_SYNC_STATUS,
  getCloudSyncApi,
  normalizeCloudSyncStatus,
} from "../components/settings-center/constants";

/**
 * Hook that subscribes to cloud sync status events and periodically polls.
 * Returns the latest CloudSyncStatusView – usable anywhere in the renderer
 * (connection tree, manager modal, etc.).
 */
export const useCloudSyncStatus = (): CloudSyncStatusView => {
  const [status, setStatus] = useState<CloudSyncStatusView>(DEFAULT_CLOUD_SYNC_STATUS);
  const mountedRef = useRef(true);

  // Initial fetch
  const fetchStatus = useCallback(async () => {
    const api = getCloudSyncApi();
    if (!api?.status) return;
    try {
      const result = await api.status();
      if (mountedRef.current) {
        setStatus((prev) => normalizeCloudSyncStatus(result, prev));
      }
    } catch {
      // Silently ignore – status will be updated by events
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void fetchStatus();
    return () => { mountedRef.current = false; };
  }, [fetchStatus]);

  // Subscribe to status events
  useEffect(() => {
    const api = getCloudSyncApi();
    if (!api?.onStatus) return;

    const unsubscribe = api.onStatus((event: unknown) => {
      if (mountedRef.current) {
        setStatus((prev) => normalizeCloudSyncStatus(event, prev));
      }
    });

    return () => {
      if (typeof unsubscribe === "function") {
        unsubscribe();
      }
    };
  }, []);

  return status;
};
