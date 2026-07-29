import fs from "node:fs";
import path from "node:path";
import { BrowserWindow } from "electron";
import type { WebContents } from "electron";
import type {
  ConnectionProfile,
  MonitorSnapshot,
  NetworkSnapshot,
  ProcessSnapshot
} from "../../../../../packages/core/src/index";
import {
  DEFAULT_MAX_CHANNELS_PER_CONNECTION,
  SshConnection,
  type SshConnectOptions
} from "../../../../../packages/ssh/src/index";
import { IPCChannel, AUTH_REQUIRED_PREFIX } from "../../../../../packages/shared/src/index";
import type {
  DebugLogEntry,
  SessionAuthOverrideInput,
  SessionStatusEvent,
  SftpTransferStatusEvent
} from "../../../../../packages/shared/src/index";
import {
  APP_SECRET_PURPOSE,
  EncryptedSecretVault,
  KeytarPasswordCache,
  MASTER_PASSWORD_SECRET_ID,
  MASTER_PASSWORD_SECRET_REF,
  verifyMasterPassword
} from "../../../../../packages/security/src/index";
import {
  SQLiteConnectionRepository,
  CachedConnectionRepository,
  SQLiteSshKeyRepository,
  CachedSshKeyRepository,
  SQLiteProxyRepository,
  CachedProxyRepository
} from "../../../../../packages/storage/src/index";
import { DeviceKeyProvider } from "./device-key-provider";
import { RemoteEditManager } from "./remote-edit-manager";
import { BackupService, applyPendingRestore } from "./backup-service";
import { resolveAuditRuntime } from "./audit-runtime";
import { logger } from "../logger";
import { createOrderedBytesDispatcher } from "./ipc-stream-dispatcher";
import { normalizeError } from "./container-utils";
import type { ActiveSession } from "./container-types";

// ─── Sub-services ──────────────────────────────────────────────────────────
import { PreferencesDialogService } from "./preferences-dialog-service";
import { TerminalIntegrationService } from "./terminal-integration-service";
import { NetworkToolService } from "./network-tool-service";
import { CommandService } from "./command-service";
import { BackupPasswordService } from "./backup-password-service";
import { ConnectionService } from "./connection-service";
import { ImportExportService } from "./import-export-service";
import { CloudSyncManager } from "./cloud-sync-manager";
import { ResourceOperationsService } from "./resource-operations-service";
import { MonitorService } from "./monitor-service";
import { SftpService } from "./sftp-service";
import { SessionService } from "./session-service";

const cloudSyncWorkspacePasswordRef = (workspaceId: string): string =>
  `secret://cloud-sync-ws-${workspaceId}`;

// Re-export for consumers (index.ts, register.ts)
export type { ServiceContainer, CreateServiceContainerOptions } from "./container-types";

export const createServiceContainer = async (
  options: import("./container-types").CreateServiceContainerOptions
): Promise<import("./container-types").ServiceContainer> => {
  fs.mkdirSync(options.dataDir, { recursive: true });
  const dbPath = path.join(options.dataDir, "nextshell.db");

  applyPendingRestore(options.dataDir, dbPath);

  const rawRepo = new SQLiteConnectionRepository(dbPath);
  const connections = new CachedConnectionRepository(rawRepo);
  connections.seedIfEmpty([]);

  const sshKeyRepo = new CachedSshKeyRepository(new SQLiteSshKeyRepository(rawRepo.getDb()));
  const proxyRepo = new CachedProxyRepository(new SQLiteProxyRepository(rawRepo.getDb()));

  // ─── Device Key ──────────────────────────────────────────────────────────
  // The device key encrypts every stored credential. Keep it OUT of the SQLite
  // database (where the ciphertext also lives) by storing it in the OS keychain
  // via keytar — otherwise copying nextshell.db yields both key and ciphertext.
  // Fall back to DB storage only when the keychain is unavailable.
  const deviceKeyStore = new KeytarPasswordCache(
    options.keytarServiceName ?? "NextShell",
    "device-key",
    { fallbackService: options.keytarFallbackServiceName }
  );
  // Resolved lazily: reading it eagerly would prompt for keychain authorization
  // on every launch, including sessions that never open a stored credential.
  // The notice is shown at most once per install, hence the persisted flag.
  const { onBeforeKeychainAccess } = options;
  const deviceKeyProvider = new DeviceKeyProvider({
    store: deviceKeyStore,
    db: {
      getLegacy: () => connections.getDeviceKey(),
      saveLegacy: (key) => connections.saveDeviceKey(key),
      clearLegacy: () => connections.clearDeviceKey()
    },
    onBeforeKeychainAccess: onBeforeKeychainAccess
      ? async () => {
          if (connections.getKeychainNoticeAcknowledged()) return;
          await onBeforeKeychainAccess();
          connections.saveKeychainNoticeAcknowledged();
        }
      : undefined
  });

  const vault = new EncryptedSecretVault(connections.getSecretStore(), () =>
    deviceKeyProvider.get()
  );

  // ─── Master Password ────────────────────────────────────────────────────
  // A remembered master password lives in the local secret store, encrypted
  // with the device key. It used to have its own keychain item, which cost a
  // second authorization prompt per launch and bought nothing: it sat next to
  // the device key, so whoever could read one could read the other.
  const keytarServiceName = options.keytarServiceName ?? "NextShell";
  const legacyMasterPasswordItem = new KeytarPasswordCache(keytarServiceName, undefined, {
    fallbackService: options.keytarFallbackServiceName
  });
  let masterPassword: string | undefined;

  const recallRememberedMasterPassword = async (): Promise<string | undefined> => {
    const stored = await vault.readCredential(MASTER_PASSWORD_SECRET_REF);
    if (stored) return stored;

    // Pre-migration install: adopt the old keychain item, then delete it so the
    // prompt it causes is paid exactly once, ever.
    const legacy = await legacyMasterPasswordItem.recall();
    if (!legacy) return undefined;
    await vault.storeCredential(MASTER_PASSWORD_SECRET_ID, legacy, APP_SECRET_PURPOSE);
    await legacyMasterPasswordItem.clear();
    logger.info("[Security] migrated remembered master password out of the system keychain");
    return legacy;
  };

  // Deliberately lazy: reading this at startup costs a keychain authorization
  // prompt on every launch, even for users who never touch backup/reveal. Every
  // consumer (masterPasswordStatus, resolveMasterPassword, backupRun,
  // backupRestore) awaits this before relying on masterPassword.
  const tryRecallMasterPassword = async (): Promise<void> => {
    if (masterPassword) return;
    const meta = connections.getMasterKeyMeta();
    if (!meta) return;
    const remembered = await recallRememberedMasterPassword();
    if (!remembered) return;
    if (await verifyMasterPassword(remembered, meta)) {
      masterPassword = remembered;
      logger.info("[Security] recalled remembered master password");
    }
  };

  const backupService = new BackupService({
    dataDir: options.dataDir,
    repo: connections,
    getMasterPassword: () => masterPassword
  });

  // ─── Audit ───────────────────────────────────────────────────────────────
  const auditEnabledForSession = connections.getAppPreferences().audit.enabled;
  const auditRuntime = resolveAuditRuntime(connections.getAppPreferences().audit);
  const appendAuditLogDirect = connections.appendAuditLog.bind(connections);

  const appendAuditLogIfEnabled = (payload: {
    action: string;
    level: "info" | "warn" | "error";
    connectionId?: string;
    message: string;
    metadata?: Record<string, unknown>;
  }): void => {
    if (!auditEnabledForSession) return;
    appendAuditLogDirect(payload);
  };

  const broadcastToAllWindows = (channel: string, payload: unknown): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload);
    }
  };

  // Audit purge
  const purgeExpiredAuditLogs = (allowWhenDisabled = false): void => {
    try {
      if (!auditEnabledForSession && !allowWhenDisabled) return;
      const prefs = connections.getAppPreferences();
      const days = prefs.audit.retentionDays;
      if (days > 0) {
        const deleted = connections.purgeExpiredAuditLogs(days);
        if (deleted > 0)
          logger.info(`[Audit] purged ${deleted} expired audit log(s) (retention=${days}d)`);
      }
    } catch (error) {
      logger.warn("[Audit] failed to purge expired logs", error);
    }
  };

  if (auditRuntime.runStartupPurge) {
    const prefs = connections.getAppPreferences();
    if (prefs.audit.retentionDays > 0) purgeExpiredAuditLogs(true);
  }
  const auditPurgeTimer = auditRuntime.runPeriodicPurge
    ? setInterval(purgeExpiredAuditLogs, 6 * 3600_000)
    : undefined;

  // ─── Shared State ────────────────────────────────────────────────────────
  const activeSessions = new Map<string, ActiveSession>();

  // ─── Connection Pool State ───────────────────────────────────────────────
  // One connection profile is backed by *several* ssh2 clients. Every shell,
  // exec and SFTP channel consumes one of the server's session slots (OpenSSH
  // defaults to MaxSessions=10), so a single client cannot back more than a
  // handful of terminals: past the limit shell()/sftp() fail silently and the
  // tab stays blank. Clients are filled up to CLIENT_CHANNEL_BUDGET channels,
  // then another client is dialled.
  const CLIENT_CHANNEL_BUDGET = DEFAULT_MAX_CHANNELS_PER_CONNECTION;
  const connectionPool = new Map<string, SshConnection[]>();
  /** Serializes connect attempts per connection id, auth overrides included. */
  const connectQueues = new Map<string, Promise<SshConnection>>();
  /**
   * Sessions that have begun opening but are not registered in
   * `activeSessions` yet. Without this, closing the last tab while another one
   * is still connecting would tear down the client the new tab is about to use.
   */
  const connectionRefCounts = new Map<string, number>();

  // ─── IPC Helpers ─────────────────────────────────────────────────────────
  const sendSessionStatus = (sender: WebContents, payload: SessionStatusEvent): void => {
    if (!sender.isDestroyed()) sender.send(IPCChannel.SessionStatus, payload);
  };

  const sendTransferStatus = (
    sender: WebContents | undefined,
    payload: SftpTransferStatusEvent
  ): void => {
    if (!sender || sender.isDestroyed()) return;
    sender.send(IPCChannel.SftpTransferStatus, payload);
  };

  // ─── Stream Dispatchers ──────────────────────────────────────────────────
  const sessionDataDispatcher = createOrderedBytesDispatcher({
    channel: IPCChannel.SessionData,
    flushIntervalMs: 16,
    targetChunkBytes: 64 * 1024,
    highWaterBytes: 512 * 1024,
    lowWaterBytes: 256 * 1024,
    buildPayload: ({ streamId, deliveryId, chunk, byteLength }) => ({
      // byteLength comes from the dispatcher's single measurement of the
      // frame — the same value used for in-flight accounting, so the
      // renderer's verbatim ack always drains the stream.
      sessionId: streamId,
      data: chunk,
      deliveryId,
      byteLength
    })
  });

  // Monitor snapshots are low-rate (≤1Hz) and sent directly — no delivery-id/ack
  // handshake (that protocol remains exclusively for the high-throughput ordered
  // terminal byte stream above). A blocked-but-alive renderer can therefore queue
  // snapshots in the IPC channel at poll rate; that window is bounded by the
  // main process's "unresponsive" auto-reload and the hide/suspend poll pausing.
  const createMonitorSnapshotEmitter =
    <TSnapshot>(channel: string) =>
    (sender: WebContents | undefined, snapshot: TSnapshot): void => {
      if (sender && !sender.isDestroyed() && !sender.isCrashed()) {
        sender.send(channel, snapshot);
      }
    };

  const emitSystemMonitorSnapshot = createMonitorSnapshotEmitter<MonitorSnapshot>(
    IPCChannel.MonitorSystemData
  );
  const emitProcessMonitorSnapshot = createMonitorSnapshotEmitter<ProcessSnapshot>(
    IPCChannel.MonitorProcessData
  );
  const emitNetworkMonitorSnapshot = createMonitorSnapshotEmitter<NetworkSnapshot>(
    IPCChannel.MonitorNetworkData
  );

  // ─── Connection Pool ─────────────────────────────────────────────────────
  const remoteEditManager = new RemoteEditManager({ getConnection: ensureConnection });

  const getConnectionOrThrow = (id: string): ConnectionProfile => {
    const connection = connections.getById(id);
    if (!connection) throw new Error("Connection not found");
    return connection;
  };

  const resolveConnectOptions = async (
    profile: ConnectionProfile,
    authOverride?: SessionAuthOverrideInput
  ): Promise<SshConnectOptions> => {
    let proxy: SshConnectOptions["proxy"];
    if (profile.proxyId) {
      const proxyProfile = proxyRepo.getById(profile.proxyId);
      if (!proxyProfile)
        throw new Error("Referenced proxy profile not found. Please update the connection.");
      const proxySecret = proxyProfile.credentialRef
        ? await vault.readCredential(proxyProfile.credentialRef)
        : undefined;
      proxy = {
        type: proxyProfile.proxyType,
        host: proxyProfile.host,
        port: proxyProfile.port,
        username: proxyProfile.username,
        password:
          proxyProfile.proxyType === "socks5" && proxyProfile.username ? proxySecret : undefined
      };
      if (!proxy.host || proxy.port <= 0)
        throw new Error("Proxy host and port are required when proxy is enabled.");
    }

    const username = authOverride?.username?.trim() || profile.username.trim();
    if (!username) throw new Error("SSH username is required.");

    const prefs = connections.getAppPreferences();
    const keepAliveEnabled = profile.keepAliveEnabled ?? prefs.ssh.keepAliveEnabled;
    const intervalCandidate = profile.keepAliveIntervalSec ?? prefs.ssh.keepAliveIntervalSec;
    const keepAliveIntervalSec =
      Number.isInteger(intervalCandidate) && intervalCandidate >= 5 && intervalCandidate <= 600
        ? intervalCandidate
        : prefs.ssh.keepAliveIntervalSec;
    const keepaliveInterval = keepAliveEnabled ? keepAliveIntervalSec * 1000 : 0;

    const base: Omit<SshConnectOptions, "authType"> = {
      host: profile.host,
      port: profile.port,
      username,
      hostFingerprint: profile.hostFingerprint,
      strictHostKeyChecking: profile.strictHostKeyChecking,
      proxy,
      keepaliveInterval
    };

    const secret = profile.credentialRef
      ? await vault.readCredential(profile.credentialRef)
      : undefined;
    const effectiveAuthType = authOverride?.authType ?? profile.authType;
    const isPasswordStyleAuth =
      effectiveAuthType === "password" || effectiveAuthType === "interactive";

    if (isPasswordStyleAuth) {
      const password =
        authOverride?.authType === "password" || authOverride?.authType === "interactive"
          ? authOverride.password
          : profile.authType === "password" || profile.authType === "interactive"
            ? secret
            : undefined;
      if (!password) {
        throw new Error(
          effectiveAuthType === "interactive"
            ? "Interactive auth requires password"
            : "Password credential is missing. Please provide password."
        );
      }
      return { ...base, authType: effectiveAuthType, password };
    }

    if (effectiveAuthType === "privateKey") {
      const effectiveKeyId = authOverride?.sshKeyId ?? profile.sshKeyId;
      let privateKey: string | undefined;
      let passphrase: string | undefined;
      if (authOverride?.privateKeyContent) {
        privateKey = authOverride.privateKeyContent;
        passphrase = authOverride.passphrase;
      } else if (effectiveKeyId) {
        const keyProfile = sshKeyRepo.getById(effectiveKeyId);
        if (!keyProfile)
          throw new Error("Referenced SSH key not found. Please update the connection.");
        privateKey = await vault.readCredential(keyProfile.keyContentRef);
        if (keyProfile.passphraseRef)
          passphrase = await vault.readCredential(keyProfile.passphraseRef);
        if (authOverride?.passphrase) passphrase = authOverride.passphrase;
      }
      if (!privateKey)
        throw new Error("Private key auth requires an SSH key. Please select a key.");
      return { ...base, authType: "privateKey", privateKey, passphrase };
    }

    return { ...base, authType: "agent" };
  };

  // TOFU: pin the server host-key fingerprint on the first successful connect so
  // any later key change is detected and rejected (see ssh hostVerifier).
  const pinHostFingerprint = (connectionId: string, fingerprint: string): void => {
    try {
      const latest = connections.getById(connectionId);
      if (!latest || latest.hostFingerprint?.trim()) return;
      connections.save({
        ...latest,
        hostFingerprint: fingerprint,
        updatedAt: new Date().toISOString()
      });
      appendAuditLogIfEnabled({
        action: "connection.host_fingerprint_pinned",
        level: "info",
        connectionId,
        message: "Pinned host key fingerprint on first connect (TOFU)",
        metadata: { fingerprint }
      });
      logger.info("[Security] pinned host fingerprint (TOFU)", { connectionId, fingerprint });
    } catch (error) {
      logger.warn("[Security] failed to pin host fingerprint", {
        connectionId,
        error: normalizeError(error)
      });
    }
  };

  const establishConnection = async (
    connectionId: string,
    profile: ConnectionProfile,
    authOverride?: SessionAuthOverrideInput
  ): Promise<SshConnection> => {
    logger.info("[SSH] connecting", { connectionId, host: profile.host, port: profile.port });
    const connectOptions = await resolveConnectOptions(profile, authOverride);
    let observedFingerprint: string | undefined;
    const ssh = await SshConnection.connect({
      ...connectOptions,
      onHostFingerprint: (fingerprint) => {
        observedFingerprint = fingerprint;
      }
    });
    if (observedFingerprint && !profile.hostFingerprint?.trim()) {
      pinHostFingerprint(connectionId, observedFingerprint);
    }
    ssh.onClose(() => {
      evictClient(connectionId, ssh, "closed");
    });
    // Without this listener a post-handshake client error lands on
    // `uncaughtException` and the dead client stays in the pool forever.
    ssh.onError((error) => {
      logger.warn("[SSH] client error", { connectionId, error: normalizeError(error) });
      evictClient(connectionId, ssh, "error");
      void ssh.close().catch(() => undefined);
    });

    const pooled = connectionPool.get(connectionId);
    if (pooled) pooled.push(ssh);
    else connectionPool.set(connectionId, [ssh]);
    logger.info("[SSH] connected", {
      connectionId,
      clients: connectionPool.get(connectionId)?.length ?? 1
    });
    return ssh;
  };

  /**
   * Remove one client from the pool. The identity check matters: a client that
   * is no longer a pool member (already evicted, or superseded by a reconnect)
   * must not tear down the live pool entry, and remote-edit sessions belong to
   * the connection rather than to one client, so they are only cleaned up when
   * the last client of that connection is gone.
   */
  function evictClient(connectionId: string, ssh: SshConnection, reason: string): void {
    const clients = connectionPool.get(connectionId);
    const index = clients ? clients.indexOf(ssh) : -1;
    if (!clients || index < 0) return;
    clients.splice(index, 1);
    const isLastClient = clients.length === 0;
    if (isLastClient) connectionPool.delete(connectionId);
    logger.info("[SSH] client left the pool", {
      connectionId,
      reason,
      remainingClients: clients.length
    });
    if (isLastClient) void remoteEditManager.cleanupByConnectionId(connectionId);
  }

  /** Live pool members, pruning clients that died without their close handler
   *  having run yet. */
  const listPooledClients = (connectionId: string): SshConnection[] => {
    const clients = connectionPool.get(connectionId);
    if (!clients) return [];
    for (let index = clients.length - 1; index >= 0; index -= 1) {
      if (!clients[index]!.isAlive) clients.splice(index, 1);
    }
    if (clients.length === 0) {
      connectionPool.delete(connectionId);
      return [];
    }
    return clients;
  };

  /**
   * First pool member with spare channel budget. First-fit rather than
   * least-loaded so the shared SFTP channel and remote-edit stay on the
   * earliest client instead of being duplicated across the pool.
   */
  const pickAvailableClient = (connectionId: string): SshConnection | undefined =>
    listPooledClients(connectionId).find((client) =>
      client.hasChannelCapacity(CLIENT_CHANNEL_BUDGET)
    );

  /**
   * Serialize connect attempts per connection id. The authOverride path used to
   * skip the dedupe entirely, so concurrent retries dialled several clients and
   * silently overwrote each other's pool entry, orphaning the losers.
   */
  const enqueueConnect = (
    connectionId: string,
    authOverride?: SessionAuthOverrideInput
  ): Promise<SshConnection> => {
    const run = async (): Promise<SshConnection> => {
      // Re-check: the attempt ahead of us may have produced a client with
      // spare budget, so a burst of tabs shares a single handshake.
      const reusable = pickAvailableClient(connectionId);
      if (reusable) return reusable;
      const profile = getConnectionOrThrow(connectionId);
      return establishConnection(connectionId, profile, authOverride);
    };

    const previous = connectQueues.get(connectionId);
    const next = previous ? previous.then(run, run) : run();
    connectQueues.set(connectionId, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (connectQueues.get(connectionId) === next) connectQueues.delete(connectionId);
      });
    return next;
  };

  function ensureConnection(
    connectionId: string,
    authOverride?: SessionAuthOverrideInput
  ): Promise<SshConnection> {
    const reusable = pickAvailableClient(connectionId);
    if (reusable) return Promise.resolve(reusable);
    return enqueueConnect(connectionId, authOverride);
  }

  /**
   * Terminal variant of `ensureConnection`: it also reserves a channel slot on
   * the chosen client, synchronously with the pick. Tabs opened in the same
   * tick would otherwise all measure the same pre-open load and pile onto one
   * client, which is exactly how MaxSessions gets exhausted.
   */
  const acquireTerminalConnection = async (
    connectionId: string,
    authOverride?: SessionAuthOverrideInput
  ): Promise<{ connection: SshConnection; release: () => void }> => {
    const reusable = pickAvailableClient(connectionId);
    if (reusable) return { connection: reusable, release: reusable.reserveChannel() };
    const connection = await enqueueConnect(connectionId, authOverride);
    return { connection, release: connection.reserveChannel() };
  };

  /**
   * Explicit reference held for the whole "session is opening" window, which
   * starts before the session lands in `activeSessions`.
   */
  const retainConnection = (connectionId: string): (() => void) => {
    connectionRefCounts.set(connectionId, (connectionRefCounts.get(connectionId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (connectionRefCounts.get(connectionId) ?? 1) - 1;
      if (remaining > 0) connectionRefCounts.set(connectionId, remaining);
      else connectionRefCounts.delete(connectionId);
    };
  };

  const isConnectionRetained = (connectionId: string): boolean =>
    (connectionRefCounts.get(connectionId) ?? 0) > 0;

  /**
   * Nothing wants this connection: no handshake in flight *and* no live
   * session. Both halves matter — a session that finishes opening drops its
   * ref-count and lands in `activeSessions` in the same breath, so checking
   * only one of them leaves a window where the connection looks idle while a
   * terminal is using it.
   */
  const isConnectionIdle = (connectionId: string): boolean =>
    !isConnectionRetained(connectionId) &&
    !Array.from(activeSessions.values()).some(
      (s) => s.kind === "remote" && s.connectionId === connectionId
    );

  const closeConnectionIfIdle = async (connectionId: string): Promise<void> => {
    if (!isConnectionIdle(connectionId)) return;
    // Monitor teardown races each hidden client's close against a 2s timeout,
    // so this await is long enough for a whole session open to complete inside
    // it: re-check the *full* idleness condition afterwards, not just the ref
    // count, or the tab that just opened gets its shell closed underneath it.
    await monitorSvc.disposeAllMonitorSessions(connectionId);
    if (!isConnectionIdle(connectionId)) return;
    const clients = connectionPool.get(connectionId);
    if (!clients || clients.length === 0) return;
    connectionPool.delete(connectionId);
    await remoteEditManager.cleanupByConnectionId(connectionId);
    await Promise.all(clients.map((client) => client.close()));
  };

  const hasVisibleTerminalAlive = (connectionId: string): boolean =>
    Array.from(activeSessions.values()).some(
      (s) =>
        s.kind === "remote" &&
        s.connectionId === connectionId &&
        s.descriptor.type === "terminal" &&
        s.descriptor.status === "connected"
    );

  const assertMonitorEnabled = (connectionId: string): ConnectionProfile => {
    const profile = getConnectionOrThrow(connectionId);
    if (!profile.monitorSession)
      throw new Error("当前连接未启用 Monitor Session，请在连接配置中开启后重试。");
    return profile;
  };

  const assertVisibleTerminalAlive = (connectionId: string): void => {
    if (!hasVisibleTerminalAlive(connectionId))
      throw new Error("请先连接 SSH 终端以启动 Monitor Session。");
  };

  const establishHiddenConnection = async (
    connectionId: string,
    tag: string
  ): Promise<SshConnection> => {
    const profile = assertMonitorEnabled(connectionId);
    logger.info(`[${tag}] connecting hidden SSH`, {
      connectionId,
      host: profile.host,
      port: profile.port
    });
    const ssh = await SshConnection.connect(await resolveConnectOptions(profile));
    logger.info(`[${tag}] hidden SSH connected`, { connectionId });
    return ssh;
  };

  // ─── Sub-Service Instantiation ───────────────────────────────────────────
  const prefsSvc = new PreferencesDialogService({
    connections,
    auditEnabledForSession
  });

  const terminalIntegrationSvc = new TerminalIntegrationService();

  const networkToolSvc = new NetworkToolService({ connections });

  const monitorSvc = new MonitorService({
    connections,
    getConnectionOrThrow,
    resolveConnectOptions: (profile) => resolveConnectOptions(profile),
    activeSessions,
    appendAuditLogIfEnabled,
    debugSenders: prefsSvc.debugSenders,
    emitDebugLog: (entry) => prefsSvc.emitDebugLog(entry),
    emitSystemSnapshot: emitSystemMonitorSnapshot,
    emitProcessSnapshot: emitProcessMonitorSnapshot,
    emitNetworkSnapshot: emitNetworkMonitorSnapshot
  });

  const sftpSvc = new SftpService({
    getConnectionOrThrow,
    ensureConnection,
    remoteEditManager,
    appendAuditLogIfEnabled,
    sendTransferStatus
  });

  const connectionSvc = new ConnectionService({
    connections,
    sshKeyRepo,
    proxyRepo,
    vault,
    activeSessions,
    disposeAllMonitorSessions: (id) => monitorSvc.disposeAllMonitorSessions(id),
    closeConnectionIfIdle,
    remoteEditManager,
    monitorStates: monitorSvc.monitorStates,
    getCloudSyncManager: () => cloudSyncManager,
    appendAuditLogIfEnabled,
    sendSessionStatus
  });

  const backupPasswordSvc = new BackupPasswordService({
    connections,
    vault,
    keytarCache: legacyMasterPasswordItem,
    getCredentialStoreStatus: () => deviceKeyProvider.getStatus(),
    reauthorizeCredentialStore: () => deviceKeyProvider.reauthorize(),
    getDeviceKeyHex: async () => (await deviceKeyProvider.get()).toString("hex"),
    backupService,
    getMasterPassword: () => masterPassword,
    setMasterPassword: (p) => {
      masterPassword = p;
    },
    tryRecallMasterPassword,
    appendAuditLogIfEnabled
  });

  let cloudSyncManager: CloudSyncManager | undefined;

  const commandSvc = new CommandService({
    connections,
    getConnectionOrThrow,
    ensureConnection,
    listWorkspaces: () => connections.listCloudSyncWorkspaces(),
    markWorkspaceCommandsDirty: (workspaceId) => {
      cloudSyncManager?.markWorkspaceCommandsDirty(workspaceId);
    },
    appendAuditLogIfEnabled
  });

  const importExportSvc = new ImportExportService({
    connections,
    vault,
    upsertConnection: (input) => connectionSvc.upsertConnection(input),
    appendAuditLogIfEnabled
  });

  const sessionSvc = new SessionService({
    connections,
    activeSessions,
    getConnectionOrThrow,
    acquireTerminalConnection,
    retainConnection,
    closeConnectionIfIdle,
    appendAuditLogIfEnabled,
    sendSessionStatus,
    sessionDataDispatcher,
    ensureSystemMonitorRuntime: (id) => monitorSvc.ensureSystemMonitorRuntime(id),
    clearMonitorSuspension: (id) => monitorSvc.clearMonitorSuspension(id),
    warmupSftp: (id, conn) => sftpSvc.warmupSftp(id, conn),
    persistAuthOverride: (id, override) => connectionSvc.persistSuccessfulAuthOverride(id, override)
  });

  // Cloud Sync Manager
  cloudSyncManager = new CloudSyncManager({
    listConnections: () => connections.list({}),
    saveConnection: (conn) => connections.save(conn),
    removeConnection: (id) => connections.remove(id),
    listSshKeys: () => sshKeyRepo.list(),
    saveSshKey: (key) => sshKeyRepo.save(key),
    removeSshKey: (id) => sshKeyRepo.remove(id),
    listProxies: () => proxyRepo.list(),
    saveProxy: (proxy) => proxyRepo.save(proxy),
    removeProxy: (id) => proxyRepo.remove(id),
    readCredential: async (ref) => {
      try {
        return await vault.readCredential(ref);
      } catch {
        return undefined;
      }
    },
    storeCredential: (name, secret) => vault.storeCredential(name, secret),
    deleteCredential: (ref) => vault.deleteCredential(ref),
    listWorkspaces: () => connections.listCloudSyncWorkspaces(),
    saveWorkspace: (ws) => connections.saveCloudSyncWorkspace(ws),
    removeWorkspace: (id) => connections.removeCloudSyncWorkspace(id),
    getWorkspaceRepoLocalState: (wId) => connections.getWorkspaceRepoLocalState(wId),
    saveWorkspaceRepoLocalState: (state) => connections.saveWorkspaceRepoLocalState(state),
    listWorkspaceRepoConflicts: (wId) => connections.listWorkspaceRepoConflicts(wId),
    saveWorkspaceRepoConflict: (conflict) => connections.saveWorkspaceRepoConflict(conflict),
    removeWorkspaceRepoConflict: (wId, resourceType, resourceId) =>
      connections.removeWorkspaceRepoConflict(wId, resourceType, resourceId),
    clearWorkspaceRepoConflicts: (wId) => connections.clearWorkspaceRepoConflicts(wId),
    listWorkspaceCommands: (wId) => connections.listWorkspaceCommands(wId),
    replaceWorkspaceCommands: (wId, commands) =>
      connections.replaceWorkspaceCommands(wId, commands),
    getWorkspaceCommandsVersion: (wId) => connections.getWorkspaceCommandsVersion(wId),
    saveWorkspaceCommandsVersion: (wId, version) =>
      connections.saveWorkspaceCommandsVersion(wId, version),
    saveRecycleBinEntry: (e) => connections.saveRecycleBinEntry(e),
    listRecycleBinEntries: () => connections.listRecycleBinEntries(),
    removeRecycleBinEntry: (id) => connections.removeRecycleBinEntry(id),
    storeWorkspacePassword: async (wId, pwd) => {
      await vault.storeCredential(`cloud-sync-ws-${wId}`, pwd);
    },
    getWorkspacePassword: async (wId) => {
      try {
        return await vault.readCredential(cloudSyncWorkspacePasswordRef(wId));
      } catch {
        return undefined;
      }
    },
    deleteWorkspacePassword: async (wId) => {
      await vault.deleteCredential(cloudSyncWorkspacePasswordRef(wId)).catch(() => {});
    },
    getJsonSetting: (key) => connections.getJsonSetting(key),
    saveJsonSetting: (key, value) => connections.saveJsonSetting(key, value),
    broadcastStatus: (status) => broadcastToAllWindows(IPCChannel.CloudSyncStatusEvent, status),
    broadcastApplied: (wId) =>
      broadcastToAllWindows(IPCChannel.CloudSyncAppliedEvent, { workspaceId: wId })
  });
  cloudSyncManager.initialize();

  // Resource Operations Service
  const resourceOpsSvc = new ResourceOperationsService({
    connections,
    sshKeyRepo,
    proxyRepo,
    vault,
    cloudSyncManager,
    saveRecycleBinEntry: (e) => connections.saveRecycleBinEntry(e),
    listRecycleBinEntries: () => connections.listRecycleBinEntries(),
    removeRecycleBinEntry: (id) => connections.removeRecycleBinEntry(id),
    appendAuditLog: (payload) => appendAuditLogIfEnabled(payload)
  });

  // ─── Dispose ─────────────────────────────────────────────────────────────
  const dispose = async (): Promise<void> => {
    connections.flush();
    if (auditPurgeTimer) clearInterval(auditPurgeTimer);
    prefsSvc.dispose();

    const allMonitorIds = monitorSvc.getAllConnectionIds();
    await Promise.all(allMonitorIds.map((id) => monitorSvc.disposeAllMonitorSessions(id)));

    await remoteEditManager.dispose();
    networkToolSvc.tracerouteStop();
    cloudSyncManager.dispose();

    const sessionIds = Array.from(activeSessions.keys());
    await Promise.all(sessionIds.map((id) => sessionSvc.closeSession(id)));

    const sshConnections = Array.from(connectionPool.values()).flat();
    connectionPool.clear();
    connectQueues.clear();
    connectionRefCounts.clear();
    await Promise.all(sshConnections.map((c) => c.close()));

    connections.close();
  };

  // ─── Public API ──────────────────────────────────────────────────────────
  // Sub-services are exposed directly; only genuinely composed orchestration
  // (multi-service flows or container-internal state) stays as methods.
  return {
    // Sub-services
    connections: connectionSvc,
    importExport: importExportSvc,
    sessions: sessionSvc,
    monitors: monitorSvc,
    commands: commandSvc,
    sftp: sftpSvc,
    backupPassword: backupPasswordSvc,
    networkTools: networkToolSvc,
    preferences: prefsSvc,
    terminalIntegration: terminalIntegrationSvc,
    cloudSync: cloudSyncManager,
    resourceOps: resourceOpsSvc,

    // Orchestration
    removeConnection: async (id) => {
      // 1. Snapshot to recycle bin + DB remove + push tombstone + delete credentials
      await resourceOpsSvc.deleteConnection({ id });
      // 2. Clean up runtime state (sessions, monitors, SSH connections)
      await connectionSvc.removeConnectionRecord(id, { skipAudit: true });
      return { ok: true as const };
    },

    // Recycle bin listing/clearing sits on the container because it is backed
    // by the connection repository, which is container-internal.
    recycleBinList: () => connections.listRecycleBinEntries(),
    recycleBinClear: () => ({ ok: true as const, deleted: connections.clearRecycleBin() }),

    pauseMonitors: () => monitorSvc.pauseAll(),
    resumeMonitors: () => monitorSvc.resumeAll(),
    getAppPreferences: () => prefsSvc.getAppPreferences(),

    dispose
  };
};
