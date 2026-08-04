/**
 * 每个连接的 SFTP 面板状态快照（进程内、非持久化）。
 *
 * WorkspaceLayout 只挂一个 FileExplorerPane，连接一变整个面板就要重建：
 * 清列表、重建目录树、探测上次目录、再列一次。有了这份缓存，A→B→A 这种
 * 秒级来回切换可以原地恢复（不转圈、不重建树），随后在后台静默校验一次。
 *
 * 只缓存「可安全复原」的状态：selectedPaths 故意不缓存——陈旧的选中项
 * 会让删除/移动这类破坏性操作打在用户以为没选中的文件上。
 */

import type { RemoteFileEntry } from "@nextshell/core";
import type { DirTreeNode } from "./types";

/** 缓存连接数上限：按 LRU 淘汰，够覆盖日常来回切的几个主机又不至于长期占内存。 */
export const EXPLORER_STATE_CACHE_CAPACITY = 8;

export interface ExplorerCachedState {
  pathName: string;
  files: RemoteFileEntry[];
  treeData: DirTreeNode[];
  expandedKeys: string[];
  pathHistory: string[];
  historyIndex: number;
  /** 写入时刻，仅作信息用途（留给将来判断 TTL），当前不做过期处理。 */
  fetchedAt: number;
}

export type ExplorerCacheInput = Omit<ExplorerCachedState, "fetchedAt">;

// Map 的键序即插入序，删除后重新插入就等于把它置为「最近使用」。
const cache = new Map<string, ExplorerCachedState>();

/** 命中即刷新 LRU 新鲜度；未命中返回 undefined。 */
export const readExplorerCache = (connectionId: string): ExplorerCachedState | undefined => {
  const entry = cache.get(connectionId);
  if (!entry) return undefined;
  cache.delete(connectionId);
  cache.set(connectionId, entry);
  return entry;
};

export const writeExplorerCache = (
  connectionId: string,
  state: ExplorerCacheInput,
  fetchedAt: number = Date.now()
): void => {
  cache.delete(connectionId);
  cache.set(connectionId, { ...state, fetchedAt });
  while (cache.size > EXPLORER_STATE_CACHE_CAPACITY) {
    const oldest = cache.keys().next();
    if (oldest.done || oldest.value === undefined) break;
    cache.delete(oldest.value);
  }
};

/** 连接被删除时清掉，避免残留在内存里（容量上限已保证不会无界增长）。 */
export const deleteExplorerCache = (connectionId: string): void => {
  cache.delete(connectionId);
};

export const clearExplorerCache = (): void => {
  cache.clear();
};

/** 当前缓存的连接，按 LRU 顺序（最久未使用在前）。用于测试与排查。 */
export const explorerCacheKeys = (): string[] => [...cache.keys()];
