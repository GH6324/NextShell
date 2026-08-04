/**
 * 切换连接时 SFTP 面板的决策逻辑，抽成纯函数以便脱离 React 单测
 * （仓库的 vitest 跑在 node 环境，没有组件测试设施）。
 *
 * 三个决策：
 * - planExplorerInit：这次 connection/connected 变化要暂停、原地续跑、
 *   从缓存恢复，还是走冷启动。
 * - consumeExplorerLoadSuppression：一次性令牌，让「刚刚已经拿到该目录列表」
 *   的那一次 loadFiles 效应不要再带转圈重复请求一遍。
 * - shouldRunSilentRevalidation：缓存恢复后的静默校验该不该在此刻发车。
 */

export type ExplorerInitPlan =
  | "pause" // 无连接或未连接：保留现有路径/历史/目录树，等回来原地恢复。
  | "resume" // 还是同一个连接：什么都不用重建。
  | "restore" // 换了连接但命中缓存：同步复原快照，不清空、不转圈。
  | "cold"; // 换了连接且没有缓存：重建目录树 + 解析初始目录。

export interface ExplorerInitInput {
  connectionId?: string;
  connected: boolean;
  initializedConnectionId?: string;
  hasCachedState: boolean;
}

export const planExplorerInit = ({
  connectionId,
  connected,
  initializedConnectionId,
  hasCachedState
}: ExplorerInitInput): ExplorerInitPlan => {
  if (!connectionId || !connected) return "pause";
  if (initializedConnectionId === connectionId) return "resume";
  return hasCachedState ? "restore" : "cold";
};

/** 「这一对 (连接, 路径) 的列表刚拿到手，别再请求一次」的一次性令牌。 */
export interface ExplorerLoadSuppression {
  connectionId: string;
  path: string;
}

export interface ExplorerLoadSuppressionResult {
  suppress: boolean;
  /** 写回令牌 ref 的下一个值：无论命中与否都作废，绝不留到下一轮。 */
  next: ExplorerLoadSuppression | undefined;
}

export const consumeExplorerLoadSuppression = (
  token: ExplorerLoadSuppression | undefined,
  current: ExplorerLoadSuppression
): ExplorerLoadSuppressionResult => {
  if (!token) return { suppress: false, next: undefined };
  const matches = token.connectionId === current.connectionId && token.path === current.path;
  return { suppress: matches, next: undefined };
};

/**
 * 待执行的静默校验。gateVersion 记录恢复瞬间的请求闸门版本：
 * 之后只要有别的请求（用户导航/手动刷新/挂载后的加载）动过闸门，
 * 那份数据更新更权威，这次校验就直接放弃，免得反过来把它作废掉。
 */
export interface PendingExplorerRevalidation {
  connectionId: string;
  gateVersion: number;
}

export interface SilentRevalidationInput {
  pending?: PendingExplorerRevalidation;
  connectionId?: string;
  connected: boolean;
  /** SFTP 底部标签当前是否可见：不可见就先攒着，可见时再校验一次。 */
  active: boolean;
  initialPathReady: boolean;
  /** 面板 state 当前归属的连接：还没落到新连接名下就再等一帧。 */
  stateOwnerId?: string;
  gateVersion: number;
}

export const shouldRunSilentRevalidation = ({
  pending,
  connectionId,
  connected,
  active,
  initialPathReady,
  stateOwnerId,
  gateVersion
}: SilentRevalidationInput): boolean => {
  if (!pending || !connectionId) return false;
  if (pending.connectionId !== connectionId) return false;
  if (stateOwnerId !== connectionId) return false;
  if (pending.gateVersion !== gateVersion) return false;
  return connected && active && initialPathReady;
};
