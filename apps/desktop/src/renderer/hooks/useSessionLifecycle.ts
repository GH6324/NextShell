import { useCallback, useEffect, useRef, useState } from "react";
import { App as AntdApp } from "antd";
import type { ConnectionProfile, SessionDescriptor } from "@nextshell/core";
import type { SessionAuthOverrideInput } from "@nextshell/shared";
import { useWorkspaceStore } from "../store/useWorkspaceStore";
import { formatErrorMessage } from "../utils/errorMessage";
import {
  claimNextSessionIndex,
  formatSessionTitle,
  resolveSessionBaseTitle
} from "../utils/sessionTitle";
import {
  DOUBLE_START_COALESCE_MS,
  extractAuthRequiredReason,
  isSessionGenerationCurrent,
  normalizeOpenError,
  resolveCoalescedStart,
  type RecentSessionStart
} from "./useSessionLifecycle.helpers";
import { deleteSessionFromCollections } from "../utils/sessionScopedCollections";

type RetrySessionAuthResult = { ok: true } | { ok: false; authRequired: boolean; reason: string };

type LocalAwareSessionDescriptor = SessionDescriptor & {
  target?: "remote" | "local";
  connectionId?: string;
};

const isLocalSession = (session?: SessionDescriptor): boolean =>
  (session as LocalAwareSessionDescriptor | undefined)?.target === "local";

const getSessionConnectionId = (session?: SessionDescriptor): string | undefined =>
  (session as LocalAwareSessionDescriptor | undefined)?.connectionId;

export function useSessionLifecycle() {
  const { message } = AntdApp.useApp();
  const connections = useWorkspaceStore((state) => state.connections);
  const sessions = useWorkspaceStore((state) => state.sessions);
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId);

  const setConnections = useWorkspaceStore((state) => state.setConnections);
  const upsertSession = useWorkspaceStore((state) => state.upsertSession);
  const setSessionStatus = useWorkspaceStore((state) => state.setSessionStatus);
  const removeSession = useWorkspaceStore((state) => state.removeSession);
  const setActiveSession = useWorkspaceStore((state) => state.setActiveSession);
  const setActiveConnection = useWorkspaceStore((state) => state.setActiveConnection);

  const [connectingIds, setConnectingIds] = useState<Set<string>>(new Set());

  const sessionIndexByConnectionRef = useRef<Map<string, number>>(new Map());
  /**
   * Handshakes are tracked per session, not per connection: opening a second
   * tab against a server that is still connecting is a legitimate action, so
   * only a repeated open of the *same* session may be suppressed. The value is
   * the owning connection id (undefined for local terminals) purely so the
   * connection-level `connectingIds` view can be derived for the UI.
   */
  const connectingSessionsRef = useRef<Map<string, string | undefined>>(new Map());
  /**
   * Newest `startSession` per connection, kept only for
   * `DOUBLE_START_COALESCE_MS`. Connect affordances are plain buttons with no
   * in-flight state, so a double-click reaches this hook as two calls and would
   * otherwise open two tabs — and two SSH channels — for one intent.
   */
  const recentStartByConnectionRef = useRef<
    Map<string, RecentSessionStart<Promise<SessionDescriptor | undefined>>>
  >(new Map());
  const inFlightOpenBySessionRef = useRef<Map<string, Promise<SessionDescriptor | undefined>>>(
    new Map()
  );
  const cancelledSessionIdsRef = useRef<Set<string>>(new Set());
  const inFlightAuthRetryBySessionRef = useRef<Map<string, Promise<RetrySessionAuthResult>>>(
    new Map()
  );
  const sessionGenerationRef = useRef<Map<string, number>>(new Map());
  const refreshConnectionsPromiseRef = useRef<Promise<void> | undefined>(undefined);
  const statusToastKeyBySessionRef = useRef<Map<string, string>>(new Map());
  const connectionsRef = useRef<ConnectionProfile[]>(connections);

  useEffect(() => {
    connectionsRef.current = connections;
  }, [connections]);

  const syncConnectingIds = useCallback(() => {
    const nextConnectingConnectionIds = new Set<string>();
    for (const connectionId of connectingSessionsRef.current.values()) {
      if (connectionId) {
        nextConnectingConnectionIds.add(connectionId);
      }
    }
    setConnectingIds(nextConnectingConnectionIds);
  }, []);

  const isSessionConnecting = useCallback(
    (sessionId: string): boolean =>
      connectingSessionsRef.current.has(sessionId) ||
      inFlightOpenBySessionRef.current.has(sessionId),
    []
  );

  const beginConnecting = useCallback(
    (sessionId: string, connectionId?: string): boolean => {
      if (connectingSessionsRef.current.has(sessionId)) {
        return false;
      }
      connectingSessionsRef.current.set(sessionId, connectionId);
      syncConnectingIds();
      return true;
    },
    [syncConnectingIds]
  );

  const endConnecting = useCallback(
    (sessionId: string): void => {
      if (!connectingSessionsRef.current.delete(sessionId)) {
        return;
      }
      syncConnectingIds();
    },
    [syncConnectingIds]
  );

  const nextSessionGeneration = useCallback((sessionId: string): number => {
    const next = (sessionGenerationRef.current.get(sessionId) ?? 0) + 1;
    sessionGenerationRef.current.set(sessionId, next);
    cancelledSessionIdsRef.current.delete(sessionId);
    return next;
  }, []);

  const cancelSessionGeneration = useCallback((sessionId: string): void => {
    const next = (sessionGenerationRef.current.get(sessionId) ?? 0) + 1;
    sessionGenerationRef.current.set(sessionId, next);
    cancelledSessionIdsRef.current.add(sessionId);
  }, []);

  const canApplySessionResult = useCallback((sessionId: string, generation: number): boolean => {
    return isSessionGenerationCurrent(
      sessionGenerationRef.current,
      cancelledSessionIdsRef.current,
      sessionId,
      generation
    );
  }, []);

  const closeSessionSilently = useCallback((sessionId: string): void => {
    window.nextshell.session.close({ sessionId }).catch(() => undefined);
  }, []);

  const clearSessionTracking = useCallback(
    (
      sessionId: string,
      options?: {
        preserveCancellation?: boolean;
        preserveRetryPromise?: boolean;
      }
    ): void => {
      deleteSessionFromCollections(sessionId, [statusToastKeyBySessionRef.current]);

      if (!options?.preserveCancellation) {
        deleteSessionFromCollections(sessionId, [
          cancelledSessionIdsRef.current,
          sessionGenerationRef.current
        ]);
      }

      if (!options?.preserveRetryPromise) {
        deleteSessionFromCollections(sessionId, [inFlightAuthRetryBySessionRef.current]);
      }
    },
    []
  );

  const refreshConnectionsOnce = useCallback((): Promise<void> => {
    if (refreshConnectionsPromiseRef.current) {
      return refreshConnectionsPromiseRef.current;
    }

    const refresh = window.nextshell.connection
      .list({})
      .then((refreshed) => {
        setConnections(refreshed);
      })
      .catch((error) => {
        message.warning(formatErrorMessage(error, "刷新连接信息失败"));
      })
      .finally(() => {
        if (refreshConnectionsPromiseRef.current === refresh) {
          refreshConnectionsPromiseRef.current = undefined;
        }
      });

    refreshConnectionsPromiseRef.current = refresh;
    return refresh;
  }, [setConnections]);

  const finalizeSession = useCallback(
    (
      openedSession: SessionDescriptor,
      connection: ConnectionProfile | undefined,
      sessionIndex: number
    ): SessionDescriptor => {
      const openedBaseTitle = resolveSessionBaseTitle(openedSession.title, connection);
      const nextSession: SessionDescriptor = {
        ...openedSession,
        title: formatSessionTitle(openedBaseTitle, sessionIndex)
      };

      upsertSession(nextSession);
      setActiveSession(nextSession.id);
      setActiveConnection(nextSession.connectionId);
      void refreshConnectionsOnce();
      return nextSession;
    },
    [refreshConnectionsOnce, setActiveConnection, setActiveSession, upsertSession]
  );

  const finalizeLocalSession = useCallback(
    (openedSession: SessionDescriptor, preservedTitle?: string): SessionDescriptor => {
      const nextSession: SessionDescriptor = preservedTitle
        ? {
            ...openedSession,
            title: preservedTitle
          }
        : openedSession;

      upsertSession(nextSession);
      setActiveSession(nextSession.id);
      return nextSession;
    },
    [setActiveSession, upsertSession]
  );

  const finalizeRetriedSession = useCallback(
    (openedSession: SessionDescriptor, preservedTitle: string): SessionDescriptor => {
      const nextSession: SessionDescriptor = {
        ...openedSession,
        title: preservedTitle
      };

      upsertSession(nextSession);
      setActiveSession(nextSession.id);
      setActiveConnection(nextSession.connectionId);
      void refreshConnectionsOnce();
      return nextSession;
    },
    [refreshConnectionsOnce, setActiveConnection, setActiveSession, upsertSession]
  );

  useEffect(() => {
    const unsubscribe = window.nextshell.session.onStatus((event) => {
      const hasSession = useWorkspaceStore
        .getState()
        .sessions.some((session) => session.id === event.sessionId);
      if (!hasSession) {
        return;
      }

      if (cancelledSessionIdsRef.current.has(event.sessionId)) {
        return;
      }

      const normalizedReason =
        event.status === "failed" &&
        typeof event.reason === "string" &&
        !isLocalSession(
          useWorkspaceStore.getState().sessions.find((session) => session.id === event.sessionId)
        )
          ? (extractAuthRequiredReason(event.reason) ?? event.reason)
          : event.reason;

      setSessionStatus(event.sessionId, event.status, normalizedReason);

      if (event.status === "failed" && normalizedReason) {
        const { authRequired } = normalizeOpenError(normalizedReason, normalizedReason);
        if (authRequired) {
          return;
        }

        const toastKey = `${event.sessionId}:${event.status}:${normalizedReason}`;
        if (statusToastKeyBySessionRef.current.get(event.sessionId) === toastKey) {
          return;
        }
        statusToastKeyBySessionRef.current.set(event.sessionId, toastKey);

        message.error(formatErrorMessage(normalizedReason, "会话连接失败"));
        return;
      }

      if (event.status === "connected" && normalizedReason) {
        const toastKey = `${event.sessionId}:${event.status}:${normalizedReason}`;
        if (statusToastKeyBySessionRef.current.get(event.sessionId) === toastKey) {
          return;
        }
        statusToastKeyBySessionRef.current.set(event.sessionId, toastKey);

        message.warning(formatErrorMessage(normalizedReason, "会话状态已更新"));
      }
    });

    return () => {
      unsubscribe();
    };
  }, [setSessionStatus]);

  const startSession = useCallback(
    async (
      connectionId: string,
      options?: { forceNewTab?: boolean }
    ): Promise<SessionDescriptor | undefined> => {
      // Opening several tabs on one server is a supported workflow, so calls are
      // de-duplicated by the freshly minted session id rather than by
      // connection. The one exception is a repeat that lands within a
      // double-click of the previous one: that is one intent, and letting it
      // through costs a second tab plus a second SSH channel on the same host.
      // An explicit "duplicate session" action is always a new tab.
      const startedAt = Date.now();
      if (!options?.forceNewTab) {
        const coalesced = resolveCoalescedStart(
          recentStartByConnectionRef.current.get(connectionId),
          startedAt
        );
        if (coalesced) {
          return coalesced;
        }
      }

      const sessionId = crypto.randomUUID();
      if (!beginConnecting(sessionId, connectionId)) {
        return undefined;
      }

      setActiveConnection(connectionId);

      const openPromise = (async () => {
        const connection = connectionsRef.current.find((item) => item.id === connectionId);
        const now = new Date().toISOString();
        const sessionIndex = claimNextSessionIndex(
          sessionIndexByConnectionRef.current,
          connectionId
        );
        const sessionGeneration = nextSessionGeneration(sessionId);
        const baseTitle = resolveSessionBaseTitle(undefined, connection);

        const pendingSession: SessionDescriptor = {
          id: sessionId,
          target: "remote",
          connectionId,
          title: formatSessionTitle(baseTitle, sessionIndex),
          type: "terminal",
          status: "connecting",
          createdAt: now,
          reconnectable: true
        };

        upsertSession(pendingSession);
        setActiveSession(sessionId);

        try {
          const openedSession = await window.nextshell.session.open({
            target: "remote",
            connectionId,
            sessionId
          });

          if (!canApplySessionResult(sessionId, sessionGeneration)) {
            closeSessionSilently(sessionId);
            return undefined;
          }

          return finalizeSession(openedSession, connection, sessionIndex);
        } catch (error) {
          if (!canApplySessionResult(sessionId, sessionGeneration)) {
            return undefined;
          }

          const normalized = normalizeOpenError(error, "打开 SSH 会话失败");
          setSessionStatus(sessionId, "failed", normalized.reason);
          return undefined;
        } finally {
          endConnecting(sessionId);
          inFlightOpenBySessionRef.current.delete(sessionId);
          const hasSession = useWorkspaceStore
            .getState()
            .sessions.some((session) => session.id === sessionId);
          if (!hasSession) {
            clearSessionTracking(sessionId);
          }
        }
      })();

      inFlightOpenBySessionRef.current.set(sessionId, openPromise);
      recentStartByConnectionRef.current.set(connectionId, { at: startedAt, promise: openPromise });
      // The entry only guards the double-click window; a handshake that takes
      // longer must not keep the user from opening a second tab deliberately.
      window.setTimeout(() => {
        const current = recentStartByConnectionRef.current.get(connectionId);
        if (current?.promise === openPromise) {
          recentStartByConnectionRef.current.delete(connectionId);
        }
      }, DOUBLE_START_COALESCE_MS);
      return openPromise;
    },
    [
      beginConnecting,
      canApplySessionResult,
      closeSessionSilently,
      clearSessionTracking,
      endConnecting,
      finalizeSession,
      nextSessionGeneration,
      setActiveConnection,
      setActiveSession,
      setSessionStatus,
      upsertSession
    ]
  );

  const startLocalSession = useCallback(async (): Promise<SessionDescriptor | undefined> => {
    const sessionId = crypto.randomUUID();
    const sessionGeneration = nextSessionGeneration(sessionId);
    const pendingSession = {
      id: sessionId,
      title: "本地终端",
      type: "terminal",
      status: "connecting",
      createdAt: new Date().toISOString(),
      reconnectable: true,
      target: "local"
    } as unknown as SessionDescriptor;

    upsertSession(pendingSession);
    setActiveSession(sessionId);

    try {
      const openedSession = await window.nextshell.session.open({
        target: "local",
        sessionId
      } as never);

      if (!canApplySessionResult(sessionId, sessionGeneration)) {
        closeSessionSilently(sessionId);
        return undefined;
      }

      return finalizeLocalSession(openedSession);
    } catch (error) {
      if (!canApplySessionResult(sessionId, sessionGeneration)) {
        return undefined;
      }

      const normalized = normalizeOpenError(error, "打开本地终端失败");
      setSessionStatus(sessionId, "failed", normalized.reason);
      return undefined;
    } finally {
      const hasSession = useWorkspaceStore
        .getState()
        .sessions.some((session) => session.id === sessionId);
      if (!hasSession) {
        clearSessionTracking(sessionId);
      }
    }
  }, [
    canApplySessionResult,
    clearSessionTracking,
    closeSessionSilently,
    finalizeLocalSession,
    nextSessionGeneration,
    setActiveSession,
    setSessionStatus,
    upsertSession
  ]);

  const retrySessionAuth = useCallback(
    async (
      sessionId: string,
      authOverride: SessionAuthOverrideInput
    ): Promise<RetrySessionAuthResult> => {
      const existingRetry = inFlightAuthRetryBySessionRef.current.get(sessionId);
      if (existingRetry) {
        return existingRetry;
      }

      const target = useWorkspaceStore
        .getState()
        .sessions.find((session) => session.id === sessionId);
      if (!target) {
        return {
          ok: false,
          authRequired: false,
          reason: "会话不存在或已关闭。"
        };
      }

      if (isLocalSession(target)) {
        return {
          ok: false,
          authRequired: false,
          reason: "本地终端不支持认证重试。"
        };
      }

      const targetConnectionId = getSessionConnectionId(target);
      if (!targetConnectionId) {
        return {
          ok: false,
          authRequired: false,
          reason: "会话连接信息缺失。"
        };
      }

      // Only this session's own handshake blocks a retry; sibling tabs on the
      // same server are irrelevant.
      if (isSessionConnecting(sessionId)) {
        return {
          ok: false,
          authRequired: false,
          reason: "该会话正在建立，请稍后重试。"
        };
      }

      beginConnecting(sessionId, targetConnectionId);
      setActiveConnection(targetConnectionId);
      setActiveSession(target.id);
      setSessionStatus(target.id, "connecting", null);

      const sessionGeneration = nextSessionGeneration(target.id);

      const retryPromise: Promise<RetrySessionAuthResult> =
        (async (): Promise<RetrySessionAuthResult> => {
          try {
            const openedSession = await window.nextshell.session.open({
              connectionId: target.connectionId,
              target: "remote",
              sessionId: target.id,
              authOverride
            } as never);

            if (!canApplySessionResult(target.id, sessionGeneration)) {
              closeSessionSilently(target.id);
              return {
                ok: false as const,
                authRequired: false,
                reason: "会话已关闭。"
              };
            }

            finalizeRetriedSession(openedSession, target.title);
            return { ok: true as const };
          } catch (error) {
            if (!canApplySessionResult(target.id, sessionGeneration)) {
              return {
                ok: false as const,
                authRequired: false,
                reason: "会话已关闭。"
              };
            }

            const normalized = normalizeOpenError(error, "打开 SSH 会话失败");
            setSessionStatus(target.id, "failed", normalized.reason);

            return {
              ok: false as const,
              authRequired: normalized.authRequired,
              reason: normalized.reason
            };
          } finally {
            endConnecting(target.id);
            inFlightAuthRetryBySessionRef.current.delete(target.id);
            const hasSession = useWorkspaceStore
              .getState()
              .sessions.some((session) => session.id === target.id);
            if (!hasSession) {
              clearSessionTracking(target.id);
            }
          }
        })();

      inFlightAuthRetryBySessionRef.current.set(sessionId, retryPromise);
      return retryPromise;
    },
    [
      beginConnecting,
      canApplySessionResult,
      closeSessionSilently,
      clearSessionTracking,
      endConnecting,
      finalizeRetriedSession,
      isSessionConnecting,
      nextSessionGeneration,
      setActiveConnection,
      setActiveSession,
      setSessionStatus
    ]
  );

  const activateConnection = useCallback(
    (connectionId: string): void => {
      setActiveConnection(connectionId);

      const state = useWorkspaceStore.getState();
      const active = state.activeSessionId
        ? state.sessions.find((session) => session.id === state.activeSessionId)
        : undefined;

      if (!active || active.connectionId !== connectionId) {
        setActiveSession(undefined);
      }
    },
    [setActiveConnection, setActiveSession]
  );

  const handleCloseSession = useCallback(
    async (sessionId: string): Promise<void> => {
      const target = useWorkspaceStore
        .getState()
        .sessions.find((session) => session.id === sessionId);
      const keepCancellation =
        target?.status === "connecting" || inFlightAuthRetryBySessionRef.current.has(sessionId);

      cancelSessionGeneration(sessionId);
      removeSession(sessionId);
      clearSessionTracking(sessionId, {
        preserveCancellation: keepCancellation,
        preserveRetryPromise: keepCancellation
      });
      window.nextshell.session.close({ sessionId }).catch((error) => {
        message.warning(formatErrorMessage(error, "关闭会话失败"));
      });
    },
    [cancelSessionGeneration, clearSessionTracking, removeSession]
  );

  const handleReconnectSession = useCallback(
    async (sessionId: string): Promise<void> => {
      const target = useWorkspaceStore
        .getState()
        .sessions.find((session) => session.id === sessionId);
      if (!target) {
        return;
      }
      // `failed` stays retryable: a reconnect that errors out lands in
      // `failed`, and stranding the user there means "one reconnect chance".
      if (target.status !== "disconnected" && target.status !== "failed") {
        return;
      }
      if (inFlightAuthRetryBySessionRef.current.has(sessionId)) {
        return;
      }
      const targetIsLocal = isLocalSession(target);
      const targetConnectionId = getSessionConnectionId(target);
      if (!targetIsLocal && !targetConnectionId) {
        return;
      }
      // Guard only against reconnecting *this* session twice; another tab still
      // handshaking against the same server must not disable this button.
      if (!beginConnecting(target.id, targetIsLocal ? undefined : targetConnectionId)) {
        return;
      }
      if (!targetIsLocal && targetConnectionId) {
        setActiveConnection(targetConnectionId);
      }

      setActiveSession(target.id);
      setSessionStatus(target.id, "connecting", null);

      const sessionGeneration = nextSessionGeneration(target.id);

      try {
        const openedSession = await window.nextshell.session.open(
          targetIsLocal
            ? ({
                target: "local",
                sessionId: target.id
              } as never)
            : ({
                target: "remote",
                connectionId: targetConnectionId,
                sessionId: target.id
              } as never)
        );

        if (!canApplySessionResult(target.id, sessionGeneration)) {
          closeSessionSilently(target.id);
          return;
        }

        if (targetIsLocal) {
          finalizeLocalSession(openedSession, target.title);
        } else {
          finalizeRetriedSession(openedSession, target.title);
        }
      } catch (error) {
        if (!canApplySessionResult(target.id, sessionGeneration)) {
          return;
        }

        const normalized = normalizeOpenError(
          error,
          targetIsLocal ? "打开本地终端失败" : "打开 SSH 会话失败"
        );
        setSessionStatus(target.id, "failed", normalized.reason);
      } finally {
        endConnecting(target.id);
        const hasSession = useWorkspaceStore
          .getState()
          .sessions.some((session) => session.id === target.id);
        if (!hasSession) {
          clearSessionTracking(target.id);
        }
      }
    },
    [
      beginConnecting,
      canApplySessionResult,
      clearSessionTracking,
      closeSessionSilently,
      endConnecting,
      finalizeRetriedSession,
      nextSessionGeneration,
      setActiveConnection,
      setActiveSession,
      setSessionStatus
    ]
  );

  useEffect(() => {
    const existingSessionIds = new Set(sessions.map((session) => session.id));

    for (const sessionId of Array.from(statusToastKeyBySessionRef.current.keys())) {
      if (!existingSessionIds.has(sessionId)) {
        statusToastKeyBySessionRef.current.delete(sessionId);
      }
    }

    for (const sessionId of Array.from(sessionGenerationRef.current.keys())) {
      if (!existingSessionIds.has(sessionId) && !cancelledSessionIdsRef.current.has(sessionId)) {
        sessionGenerationRef.current.delete(sessionId);
      }
    }
  }, [sessions]);

  useEffect(() => {
    const active = activeSessionId
      ? sessions.find((session) => session.id === activeSessionId)
      : undefined;

    if (active && active.connectionId) {
      const state = useWorkspaceStore.getState();
      if (state.activeConnectionId !== active.connectionId) {
        setActiveConnection(active.connectionId);
      }
    }
  }, [activeSessionId, sessions, setActiveConnection]);

  return {
    connectingIds,
    startSession,
    startLocalSession,
    retrySessionAuth,
    activateConnection,
    handleCloseSession,
    handleReconnectSession
  };
}
