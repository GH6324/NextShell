import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App as AntdApp } from "antd";
import type { ConnectionProfile, RemoteFileEntry } from "@nextshell/core";
import {
  FILE_EXPLORER_FOLLOW_CWD_DEBOUNCE_MS,
  shouldSuppressFollowNavigation
} from "../../FileExplorerPane.follow";
import { formatErrorMessage } from "../../../utils/errorMessage";
import { resolveInitialRemotePath } from "../../../utils/remoteHomePath";
import { readLastSftpPath, writeLastSftpPath } from "../../../utils/sftpLastPath";
import {
  consumeExplorerLoadSuppression,
  planExplorerInit,
  shouldRunSilentRevalidation,
  type ExplorerLoadSuppression,
  type PendingExplorerRevalidation
} from "../explorerInitPlan";
import { readExplorerCache, writeExplorerCache } from "../explorerStateCache";
import { createRemoteExplorerRequestGate } from "../requestGate";
import { normalizeRemotePath } from "../shared";
import type { DirTreeNode } from "../types";

type AppMessage = ReturnType<typeof AntdApp.useApp>["message"];

interface UseRemoteExplorerStateParams {
  connection?: ConnectionProfile;
  connected: boolean;
  active: boolean;
  followSessionId?: string;
  followSessionCwd?: string;
  message: AppMessage;
}

export const useRemoteExplorerState = ({
  connection,
  connected,
  active,
  followSessionId,
  followSessionCwd,
  message
}: UseRemoteExplorerStateParams) => {
  const connectionId = connection?.id;
  const fileRequestGate = useMemo(() => createRemoteExplorerRequestGate(), []);
  const [pathName, setPathName] = useState("/");
  const [pathInput, setPathInput] = useState("/");
  const [files, setFiles] = useState<RemoteFileEntry[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [treeData, setTreeData] = useState<DirTreeNode[]>([]);
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const [pathHistory, setPathHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [initialPathReady, setInitialPathReady] = useState(false);
  // 当前这批 state（路径/列表/目录树/历史）属于哪个连接。
  // 特意用 state 而非 ref：切连接的那一帧,各效应闭包里的数据还是上一个连接的,
  // 只有同样带在 state 里的归属标记能揭穿这点,免得把 A 的列表写进 B 的缓存
  // 或替 B 发一个 A 路径的请求。
  const [stateOwnerId, setStateOwnerId] = useState<string | undefined>(undefined);
  const [followCwd, setFollowCwd] = useState(false);
  const skipHistoryRef = useRef(false);
  const pathNameRef = useRef(pathName);
  const connectionIdRef = useRef(connectionId);
  const initialPathRequestIdRef = useRef(0);
  const treeInitRequestIdRef = useRef(0);
  const followCwdLastRef = useRef<string | null>(null);
  const followCwdDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const navigateRef = useRef<(path: string) => void>(() => {});
  // 已完成初始定位的连接：同一连接因切标签/临时断开再回来时原地恢复,不重置。
  const initializedConnectionIdRef = useRef<string | undefined>(undefined);
  // 最近一次用户手动导航的时间戳,用于压制终端跟随的抢占。
  const manualNavAtRef = useRef<number | undefined>(undefined);
  const followNavigatingRef = useRef(false);
  // initialPathReady 的同步镜像：切连接的那一帧里,加载效应的闭包拿到的还是
  // 上一个连接的旧值,只能靠 ref 读到刚刚写下的真值。
  const initialPathReadyRef = useRef(false);
  // 一次性令牌：缓存恢复/冷启动探测已经把该目录的列表放进 state 了,
  // 紧随其后的那次加载效应不要再带转圈重复请求一遍。
  const suppressNextLoadRef = useRef<ExplorerLoadSuppression | undefined>(undefined);
  // 待执行的静默校验（面板不可见时先攒着,可见时补跑,且每次切换只跑一次）。
  const pendingRevalidationRef = useRef<PendingExplorerRevalidation | undefined>(undefined);

  const applyInitialPathReady = useCallback((ready: boolean) => {
    initialPathReadyRef.current = ready;
    setInitialPathReady(ready);
  }, []);

  const selectedEntries = useMemo(() => {
    const selected = new Set(selectedPaths);
    return files.filter((item) => selected.has(item.path));
  }, [files, selectedPaths]);

  const singleSelected = selectedEntries.length === 1 ? selectedEntries[0] : undefined;

  const pushHistory = useCallback(
    (path: string) => {
      setPathHistory((prev) => {
        const next = prev.slice(0, historyIndex + 1);
        next.push(path);
        return next;
      });
      setHistoryIndex((prev) => prev + 1);
    },
    [historyIndex]
  );

  const navigate = useCallback(
    (path: string) => {
      // 终端跟随触发的导航不算「用户手动浏览」,其余全部算。
      if (followNavigatingRef.current) {
        followNavigatingRef.current = false;
      } else {
        manualNavAtRef.current = Date.now();
      }
      const normalizedPath = normalizeRemotePath(path);
      if (pathNameRef.current === normalizedPath) {
        skipHistoryRef.current = false;
        return;
      }

      if (skipHistoryRef.current) {
        skipHistoryRef.current = false;
      } else {
        pushHistory(normalizedPath);
      }
      fileRequestGate.invalidate();
      pathNameRef.current = normalizedPath;
      setPathName(normalizedPath);
    },
    [fileRequestGate, pushHistory]
  );

  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);

  const goBack = useCallback(() => {
    if (historyIndex <= 0) return;
    const prev = pathHistory[historyIndex - 1];
    if (!prev) return;
    manualNavAtRef.current = Date.now();
    skipHistoryRef.current = true;
    fileRequestGate.invalidate();
    pathNameRef.current = prev;
    setHistoryIndex((index) => index - 1);
    setPathName(prev);
  }, [fileRequestGate, historyIndex, pathHistory]);

  const goForward = useCallback(() => {
    if (historyIndex >= pathHistory.length - 1) return;
    const next = pathHistory[historyIndex + 1];
    if (!next) return;
    manualNavAtRef.current = Date.now();
    skipHistoryRef.current = true;
    fileRequestGate.invalidate();
    pathNameRef.current = next;
    setHistoryIndex((index) => index + 1);
    setPathName(next);
  }, [fileRequestGate, historyIndex, pathHistory]);

  const loadFiles = useCallback(async (): Promise<void> => {
    if (!connectionId || !connected || !initialPathReady) {
      fileRequestGate.invalidate();
      setBusy(false);
      setFiles([]);
      setSelectedPaths([]);
      return;
    }

    const normalizedPath = normalizeRemotePath(pathName);
    const request = fileRequestGate.begin(connectionId, normalizedPath);
    const isCurrentRequest = (): boolean =>
      fileRequestGate.isCurrent(request, {
        connectionId: connectionIdRef.current,
        path: normalizeRemotePath(pathNameRef.current)
      });

    setBusy(true);
    try {
      const list = await window.nextshell.sftp.list({
        connectionId,
        path: normalizedPath
      });
      if (!isCurrentRequest()) {
        return;
      }
      setFiles(list);
      setSelectedPaths([]);
    } catch (error) {
      if (!isCurrentRequest()) {
        return;
      }
      message.error(`读取目录失败：${formatErrorMessage(error, "请检查连接状态")}`);
      setFiles([]);
    } finally {
      if (isCurrentRequest()) {
        setBusy(false);
      }
    }
  }, [connectionId, connected, fileRequestGate, initialPathReady, message, pathName]);

  const loadTreeChildren = useCallback(
    async (parentPath: string): Promise<DirTreeNode[]> => {
      if (!connectionId || !connected) return [];
      try {
        const list = await window.nextshell.sftp.list({
          connectionId,
          path: parentPath
        });
        return list
          .filter((file) => file.type === "directory")
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((file) => ({
            key: file.path,
            title: file.name,
            isLeaf: false as const
          }));
      } catch {
        return [];
      }
    },
    [connectionId, connected]
  );

  const updateTreeNode = useCallback(
    (nodes: DirTreeNode[], key: string, children: DirTreeNode[]): DirTreeNode[] =>
      nodes.map((node) => {
        if (node.key === key) return { ...node, children };
        if (node.children) {
          return { ...node, children: updateTreeNode(node.children, key, children) };
        }
        return node;
      }),
    []
  );

  const initTree = useCallback(async () => {
    treeInitRequestIdRef.current += 1;
    const requestId = treeInitRequestIdRef.current;

    if (!connectionId || !connected) {
      setTreeData([]);
      setExpandedKeys([]);
      return;
    }
    const children = await loadTreeChildren("/");
    if (treeInitRequestIdRef.current !== requestId || connectionIdRef.current !== connectionId) {
      return;
    }
    setTreeData([{ key: "/", title: "/", isLeaf: false, children }]);
    setExpandedKeys(["/"]);
  }, [connectionId, connected, loadTreeChildren]);

  useEffect(() => {
    initialPathRequestIdRef.current += 1;
    const requestId = initialPathRequestIdRef.current;
    fileRequestGate.invalidate();

    // 选中项一律不跨连接沿用：陈旧选中会让删除/移动打在意料之外的文件上。
    setSelectedPaths([]);
    setBusy(false);
    skipHistoryRef.current = false;

    const cached = connectionId ? readExplorerCache(connectionId) : undefined;
    const plan = planExplorerInit({
      connectionId,
      connected,
      initializedConnectionId: initializedConnectionIdRef.current,
      hasCachedState: Boolean(cached)
    });

    if (plan === "pause") {
      // 暂停而非重置：切到别的标签/窗口或临时断开时保留当前路径、
      // 历史和目录树,回来时原地恢复,不再重新解析 home、重建整棵树。
      // 缓存条目也一并保留,重连后切回来照样能秒开。
      applyInitialPathReady(false);
      return;
    }

    if (plan === "resume") {
      // 同一连接恢复：直接在当前路径继续,列表由 loadFiles 效应刷新。
      setStateOwnerId(connectionId);
      applyInitialPathReady(true);
      return;
    }

    if (plan === "restore" && connectionId && cached) {
      // 命中缓存：同步复原全部快照,不清列表、不转圈、不重建目录树,
      // 也不再探测上次目录；可见时在后台静默校验一次。
      initializedConnectionIdRef.current = connectionId;
      pathNameRef.current = cached.pathName;
      setPathName(cached.pathName);
      setFiles(cached.files);
      setTreeData(cached.treeData);
      setExpandedKeys(cached.expandedKeys);
      setPathHistory(cached.pathHistory);
      setHistoryIndex(cached.historyIndex);
      setStateOwnerId(connectionId);
      suppressNextLoadRef.current = { connectionId, path: cached.pathName };
      pendingRevalidationRef.current = {
        connectionId,
        gateVersion: fileRequestGate.version()
      };
      applyInitialPathReady(true);
      return;
    }

    if (!connectionId) return;

    // 冷启动：这批 state 暂时无主,同步清干净（含目录树,别把上一台主机的
    // 目录残留在树上）,再重建树并解析初始目录。
    applyInitialPathReady(false);
    setStateOwnerId(undefined);
    pathNameRef.current = "/";
    setPathName("/");
    setPathHistory([]);
    setHistoryIndex(-1);
    setFiles([]);
    setTreeData([]);
    setExpandedKeys([]);
    suppressNextLoadRef.current = undefined;
    pendingRevalidationRef.current = undefined;
    void initTree();

    void (async () => {
      // 优先回到该连接上次浏览的目录；目录已不存在（list 失败）则回退 home。
      let initialPath: string | undefined;
      // 探测成功时顺手把这份列表留下来当初始数据,省掉紧接着的重复 list。
      let probedFiles: RemoteFileEntry[] | undefined;
      const stored = readLastSftpPath(connectionId);
      const storedPath = stored ? normalizeRemotePath(stored) : undefined;
      if (storedPath) {
        try {
          probedFiles = await window.nextshell.sftp.list({
            connectionId,
            path: storedPath
          });
          initialPath = storedPath;
        } catch {
          initialPath = undefined;
          probedFiles = undefined;
        }
      }
      if (initialPath === undefined) {
        initialPath = await resolveInitialRemotePath(() =>
          window.nextshell.session.getHomeDir({ connectionId })
        );
      }
      const normalized = normalizeRemotePath(initialPath);
      if (initialPathRequestIdRef.current !== requestId) {
        return;
      }
      initializedConnectionIdRef.current = connectionId;
      pathNameRef.current = normalized;
      if (probedFiles && normalized === storedPath) {
        // 探测那一次 list 就是这个目录的内容,直接当初始数据用,
        // 并压制紧随其后的那次重复请求（结果同样会被写穿进缓存）。
        setFiles(probedFiles);
        suppressNextLoadRef.current = { connectionId, path: normalized };
      }
      setPathName(normalized);
      setPathHistory([normalized]);
      setHistoryIndex(0);
      setStateOwnerId(connectionId);
      applyInitialPathReady(true);
    })();
  }, [applyInitialPathReady, connectionId, connected, fileRequestGate, initTree]);

  // 记录每个连接的落脚点,供下次打开时恢复。
  // 同样要 stateOwnerId 守卫,否则切连接那一帧会把上一个连接的路径记到新连接名下。
  useEffect(() => {
    if (!connectionId || !initialPathReady || stateOwnerId !== connectionId) return;
    writeLastSftpPath(connectionId, pathName);
  }, [connectionId, initialPathReady, pathName, stateOwnerId]);

  // 写穿缓存：状态一落定就存一份快照,下次切回该连接可原地恢复。
  // 增删改名/上传都走 setFiles/loadFiles,所以这里顺带把它们也覆盖了。
  // stateOwnerId 守卫：切连接的那一帧闭包里还是上一个连接的数据,必须跳过。
  useEffect(() => {
    if (!connectionId || !initialPathReady || stateOwnerId !== connectionId) return;
    writeExplorerCache(connectionId, {
      pathName,
      files,
      treeData,
      expandedKeys,
      pathHistory,
      historyIndex
    });
  }, [
    connectionId,
    expandedKeys,
    files,
    historyIndex,
    initialPathReady,
    pathHistory,
    pathName,
    stateOwnerId,
    treeData
  ]);

  useEffect(() => {
    connectionIdRef.current = connectionId;
  }, [connectionId]);

  useEffect(() => {
    pathNameRef.current = pathName;
  }, [pathName]);

  useEffect(() => {
    setPathInput(pathName);
  }, [pathName]);

  // 只在切换到另一个连接时关掉跟随；同一连接的临时断开/切标签保留
  // 用户的选择,免得每次都要重新打开。
  useEffect(() => {
    setFollowCwd(false);
  }, [connectionId]);

  const followCwdTrackingEnabled = Boolean(
    active && followCwd && connectionId && connected && followSessionId
  );

  useEffect(() => {
    if (!followCwdTrackingEnabled) {
      if (followCwdDebounceRef.current) {
        clearTimeout(followCwdDebounceRef.current);
        followCwdDebounceRef.current = undefined;
      }
      followCwdLastRef.current = null;
      return;
    }

    return () => {
      if (followCwdDebounceRef.current) {
        clearTimeout(followCwdDebounceRef.current);
        followCwdDebounceRef.current = undefined;
      }
    };
  }, [followCwdTrackingEnabled, followSessionId]);

  useEffect(() => {
    if (!followCwdTrackingEnabled || !followSessionCwd) {
      return;
    }

    const normalized = normalizeRemotePath(followSessionCwd);
    if (normalized === followCwdLastRef.current) {
      return;
    }

    // 用户刚手动导航过,这次终端 cd 不抢占面板；下次 cd 再正常跟随。
    if (shouldSuppressFollowNavigation(manualNavAtRef.current, Date.now())) {
      return;
    }

    followCwdLastRef.current = normalized;
    if (followCwdDebounceRef.current) {
      clearTimeout(followCwdDebounceRef.current);
    }
    followCwdDebounceRef.current = setTimeout(() => {
      followCwdDebounceRef.current = undefined;
      // 防抖等待期间用户又动了面板,同样让位。
      if (shouldSuppressFollowNavigation(manualNavAtRef.current, Date.now())) {
        return;
      }
      if (pathNameRef.current !== normalized) {
        followNavigatingRef.current = true;
        navigateRef.current(normalized);
      }
    }, FILE_EXPLORER_FOLLOW_CWD_DEBOUNCE_MS);

    return () => {
      if (followCwdDebounceRef.current) {
        clearTimeout(followCwdDebounceRef.current);
        followCwdDebounceRef.current = undefined;
      }
    };
  }, [followCwdTrackingEnabled, followSessionCwd]);

  // 缓存恢复后的静默校验：不转圈、不弹错,拿到新列表就顶掉旧的。
  const revalidateQuietly = useCallback(async (): Promise<void> => {
    if (!connectionId || !connected) return;
    const normalizedPath = normalizeRemotePath(pathNameRef.current);
    // 照常登记到请求闸门：一旦用户在这期间导航或手动刷新,这次校验就作废,
    // 绝不会把结果画到别的连接/目录上。
    const request = fileRequestGate.begin(connectionId, normalizedPath);
    try {
      const list = await window.nextshell.sftp.list({
        connectionId,
        path: normalizedPath
      });
      const isCurrent = fileRequestGate.isCurrent(request, {
        connectionId: connectionIdRef.current,
        path: normalizeRemotePath(pathNameRef.current)
      });
      if (!isCurrent) return;
      setFiles(list);
    } catch (error) {
      // 静默失败：继续用缓存里的数据,不打扰用户。
      if (import.meta.env.DEV) {
        console.debug("[FileExplorer] silent revalidation failed", error);
      }
    }
  }, [connectionId, connected, fileRequestGate]);

  useEffect(() => {
    if (
      !shouldRunSilentRevalidation({
        pending: pendingRevalidationRef.current,
        connectionId,
        connected,
        active,
        initialPathReady,
        stateOwnerId,
        gateVersion: fileRequestGate.version()
      })
    ) {
      return;
    }
    // 消费掉令牌：每次切换只校验一次,反复切底部标签不会再触发请求。
    pendingRevalidationRef.current = undefined;
    void revalidateQuietly();
  }, [
    active,
    connected,
    connectionId,
    fileRequestGate,
    initialPathReady,
    revalidateQuietly,
    stateOwnerId
  ]);

  useEffect(() => {
    // 切连接的那一帧,本效应闭包里的 pathName/files 还属于上一个连接。
    // 直接让这一帧过去（不清列表、不发注定被丢弃的请求）,等下一帧带着
    // 恢复好或冷启动好的状态再处理。
    if (stateOwnerId !== connectionId) return;

    const normalizedPath = normalizeRemotePath(pathName);
    // initialPathReady 只负责触发本效应,判断一律用 ref 里的最新真值
    // （重连的那一帧 state 还是 false,不该把已有列表清掉再转圈）。
    void initialPathReady;
    if (!connectionId || !connected || !initialPathReadyRef.current) {
      fileRequestGate.invalidate();
      setBusy(false);
      setFiles([]);
      setSelectedPaths([]);
      return;
    }

    const { suppress, next } = consumeExplorerLoadSuppression(suppressNextLoadRef.current, {
      connectionId,
      path: normalizedPath
    });
    suppressNextLoadRef.current = next;
    if (suppress) return;

    void loadFiles();
  }, [
    connectionId,
    connected,
    fileRequestGate,
    initialPathReady,
    loadFiles,
    pathName,
    stateOwnerId
  ]);

  const findNodeByKey = (nodes: DirTreeNode[], key: string): DirTreeNode | undefined => {
    for (const node of nodes) {
      if (node.key === key) return node;
      if (node.children) {
        const found = findNodeByKey(node.children, key);
        if (found) return found;
      }
    }
    return undefined;
  };

  // 导航后自动把目录树展开/加载到当前路径,使高亮项可见(修复树停在 / 而列表已切换的割裂)
  useEffect(() => {
    // stateOwnerId 守卫：切连接那一帧的路径/树都还是上一个连接的,
    // 不能拿去展开新连接的树(否则会把跨主机的目录写进树并被缓存)。
    if (stateOwnerId !== connectionId) return;
    if (!connectionId || !connected || !initialPathReady || pathName === "/") {
      return;
    }

    const expandTreeToPath = async (): Promise<void> => {
      const normalized = normalizeRemotePath(pathName);
      const parts = normalized.split("/").filter(Boolean);
      const ancestorPaths: string[] = ["/"];
      for (let i = 0; i < parts.length; i++) {
        ancestorPaths.push("/" + parts.slice(0, i + 1).join("/"));
      }

      let currentTreeData = treeData;
      const newExpandedKeys = expandedKeys.slice();
      let needsUpdate = false;

      // 只展开祖先节点(不含叶子本身),逐级按需懒加载子节点
      for (let i = 0; i < ancestorPaths.length - 1; i++) {
        const ancestorPath = ancestorPaths[i];
        if (!ancestorPath) continue;

        if (!newExpandedKeys.includes(ancestorPath)) {
          newExpandedKeys.push(ancestorPath);
          needsUpdate = true;
        }

        const node = findNodeByKey(currentTreeData, ancestorPath);
        if (node && (!node.children || node.children.length === 0)) {
          const children = await loadTreeChildren(ancestorPath);
          if (connectionIdRef.current !== connectionId) return;
          currentTreeData = updateTreeNode(currentTreeData, ancestorPath, children);
          needsUpdate = true;
        }
      }

      if (needsUpdate) {
        setTreeData(currentTreeData);
        setExpandedKeys(newExpandedKeys);
      }
    };

    void expandTreeToPath();
  }, [
    connectionId,
    connected,
    initialPathReady,
    pathName,
    stateOwnerId,
    treeData,
    expandedKeys,
    loadTreeChildren,
    updateTreeNode
  ]);

  const handleTreeExpand = useCallback(
    async (keys: string[], info: { node: DirTreeNode; expanded: boolean }) => {
      setExpandedKeys(keys);
      if (!info.expanded) return;
      const node = info.node;
      if (node.children && node.children.length > 0) return;
      const requestConnectionId = connectionId;
      const children = await loadTreeChildren(node.key);
      if (connectionIdRef.current !== requestConnectionId) return;
      setTreeData((prev) => updateTreeNode(prev, node.key, children));
    },
    [connectionId, loadTreeChildren, updateTreeNode]
  );

  const toParentPath = useCallback((): void => {
    const normalized = normalizeRemotePath(pathName);
    if (normalized === "/") return;
    const next = normalized.slice(0, normalized.lastIndexOf("/")) || "/";
    navigate(next);
  }, [navigate, pathName]);

  const toggleFollowCwd = useCallback(() => {
    if (!followSessionId) {
      message.info({
        content: "当前连接暂无可跟随的远程终端。",
        duration: 2
      });
      return;
    }
    const nextFollowCwd = !followCwd;
    if (nextFollowCwd) {
      followCwdLastRef.current = null;
      // 用户主动开启跟随,立即生效,不受手动浏览压制期影响。
      manualNavAtRef.current = undefined;
    }
    setFollowCwd(nextFollowCwd);
    message.info({
      content: nextFollowCwd ? "已启用跟随终端目录" : "已关闭跟随终端目录",
      duration: 2
    });
  }, [followCwd, followSessionId, message]);

  return {
    busy,
    expandedKeys,
    files,
    followCwd,
    goBack,
    goForward,
    handleTreeExpand,
    historyIndex,
    navigate,
    loadFiles,
    pathHistory,
    pathInput,
    pathName,
    selectedEntries,
    selectedPaths,
    setBusy,
    setFiles,
    setPathInput,
    setSelectedPaths,
    singleSelected,
    toParentPath,
    toggleFollowCwd,
    treeData
  };
};
