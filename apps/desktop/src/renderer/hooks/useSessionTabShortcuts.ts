import { useEffect, useRef } from "react";

/**
 * 多标签工作流的全局快捷键。捕获阶段监听,优先于 xterm 的按键处理,
 * 命中的组合键不会落进终端;未命中的一律不拦截。
 *
 * - Ctrl+Tab / Ctrl+Shift+Tab:按 MRU 顺序切换;按住 Ctrl 连按可沿
 *   使用历史继续走(Alt-Tab 语义),松开 Ctrl 结束本轮。
 * - Cmd/Ctrl+1..9:跳到第 N 个标签(9 = 最后一个)。
 * - Cmd/Ctrl+Shift+[ / ] 与 Ctrl+PageUp/PageDown:相邻标签,循环。
 * - Cmd+W(mac)/ Ctrl+Shift+W(其他):关闭当前标签。
 *   非 mac 不能用裸 Ctrl+W —— 那是 shell 的 kill-word。
 * - Cmd/Ctrl+Shift+D:对当前主机再开一个终端。
 */

export type SessionTabShortcutAction =
  | { type: "mru-cycle"; direction: 1 | -1 }
  | { type: "adjacent"; delta: 1 | -1 }
  | { type: "index"; index: number | "last" }
  | { type: "close" }
  | { type: "duplicate" };

export interface TabShortcutKeyEvent {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export const resolveSessionTabShortcut = (
  event: TabShortcutKeyEvent,
  isMac: boolean
): SessionTabShortcutAction | undefined => {
  const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;

  if (event.key === "Tab" && event.ctrlKey && !event.metaKey && !event.altKey) {
    return { type: "mru-cycle", direction: event.shiftKey ? -1 : 1 };
  }

  if (event.altKey) {
    return undefined;
  }

  if (mod && event.shiftKey) {
    if (event.code === "BracketRight") return { type: "adjacent", delta: 1 };
    if (event.code === "BracketLeft") return { type: "adjacent", delta: -1 };
    if (event.code === "KeyD") return { type: "duplicate" };
    if (!isMac && event.code === "KeyW") return { type: "close" };
    return undefined;
  }

  if (mod && !event.shiftKey) {
    if (isMac && event.code === "KeyW") return { type: "close" };
    const digitMatch = /^Digit([1-9])$/.exec(event.code);
    if (digitMatch?.[1]) {
      const digit = Number(digitMatch[1]);
      return { type: "index", index: digit === 9 ? "last" : digit - 1 };
    }
  }

  if (event.ctrlKey && !event.metaKey && !event.shiftKey) {
    if (event.code === "PageDown") return { type: "adjacent", delta: 1 };
    if (event.code === "PageUp") return { type: "adjacent", delta: -1 };
  }

  return undefined;
};

interface UseSessionTabShortcutsParams {
  /** 当前标签条里的会话 id,按显示顺序。 */
  getSessionIds: () => string[];
  /** MRU 顺序(最近在前)的会话 id,仅含仍存在的会话。 */
  getMruSessionIds: () => string[];
  getActiveSessionId: () => string | undefined;
  activateSession: (sessionId: string) => void;
  closeActiveSession: () => void;
  duplicateActiveSession: () => void;
  isMac?: boolean;
}

export const useSessionTabShortcuts = ({
  getSessionIds,
  getMruSessionIds,
  getActiveSessionId,
  activateSession,
  closeActiveSession,
  duplicateActiveSession,
  isMac = typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.platform)
}: UseSessionTabShortcutsParams): void => {
  const paramsRef = useRef({
    getSessionIds,
    getMruSessionIds,
    getActiveSessionId,
    activateSession,
    closeActiveSession,
    duplicateActiveSession
  });
  paramsRef.current = {
    getSessionIds,
    getMruSessionIds,
    getActiveSessionId,
    activateSession,
    closeActiveSession,
    duplicateActiveSession
  };

  // Ctrl 按住期间的 MRU 快照:循环走快照序,激活带来的 MRU 变化不干扰本轮。
  const mruCycleRef = useRef<{ ids: string[]; index: number } | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const action = resolveSessionTabShortcut(event, isMac);
      if (!action) {
        return;
      }

      const params = paramsRef.current;
      const sessionIds = params.getSessionIds();
      if (sessionIds.length === 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      switch (action.type) {
        case "mru-cycle": {
          if (!mruCycleRef.current) {
            const mruIds = params.getMruSessionIds();
            if (mruIds.length < 2) {
              return;
            }
            mruCycleRef.current = { ids: mruIds, index: 0 };
          }
          const cycle = mruCycleRef.current;
          const length = cycle.ids.length;
          cycle.index = (cycle.index + action.direction + length) % length;
          const target = cycle.ids[cycle.index];
          if (target !== undefined) {
            params.activateSession(target);
          }
          return;
        }
        case "adjacent": {
          const activeId = params.getActiveSessionId();
          const currentIndex = activeId ? sessionIds.indexOf(activeId) : -1;
          const base = currentIndex >= 0 ? currentIndex : 0;
          const target = sessionIds[(base + action.delta + sessionIds.length) % sessionIds.length];
          if (target !== undefined) {
            params.activateSession(target);
          }
          return;
        }
        case "index": {
          const target =
            action.index === "last" ? sessionIds.at(-1) : sessionIds[action.index];
          if (target !== undefined) {
            params.activateSession(target);
          }
          return;
        }
        case "close":
          params.closeActiveSession();
          return;
        case "duplicate":
          params.duplicateActiveSession();
          return;
      }
    };

    const endMruCycle = (event: KeyboardEvent): void => {
      if (event.key === "Control") {
        mruCycleRef.current = null;
      }
    };
    const cancelMruCycle = (): void => {
      mruCycleRef.current = null;
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", endMruCycle, true);
    window.addEventListener("blur", cancelMruCycle);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", endMruCycle, true);
      window.removeEventListener("blur", cancelMruCycle);
    };
  }, [isMac]);
};
