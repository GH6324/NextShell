import { useCallback, useEffect, useMemo, useRef } from "react";

/**
 * 多标签工作流的全局快捷键。捕获阶段监听,优先于 xterm 的按键处理,
 * 命中的组合键不会落进终端;未命中的一律不拦截。
 *
 * - Ctrl+Tab / Ctrl+Shift+Tab:打开切换器沿 MRU 顺序选择,松开 Ctrl 才真正切换
 *   (Windows Alt-Tab 语义)。循环期间只动选中项,不激活会话——共享的单个 xterm
 *   每次激活都要 reset 并重解析整段回放,途经的标签一个都不该付这个代价。
 *   循环开着时方向键上下也能移动选中项,Esc 取消。
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

/** 键盘焦点上下文,由 hook 层从真实事件算出(纯判定不碰 DOM)。 */
export interface TabShortcutFocusContext {
  /** 输入法组字中:此时的按键属于候选窗,不能当快捷键解释。 */
  isComposing: boolean;
  /** 焦点在可编辑元素里(input / textarea / select / contenteditable)。 */
  targetIsEditable: boolean;
  /** 该元素属于终端宿主。xterm 的隐藏 helper textarea 也是 textarea,不能当输入框放过。 */
  targetInsideTerminal: boolean;
}

/**
 * 这次按键是否该整体放过。组字期间不解释快捷键;终端之外的输入框里也不解释——
 * 连接表单里按 Ctrl+Tab 或 Cmd+1 应该是输入框自己的事,不该把标签切走。
 */
export const shouldIgnoreTabShortcutEvent = ({
  isComposing,
  targetIsEditable,
  targetInsideTerminal
}: TabShortcutFocusContext): boolean => {
  if (isComposing) {
    return true;
  }

  return targetIsEditable && !targetInsideTerminal;
};

/** 切换器的对外状态:本轮的 id 快照与当前选中项;null 表示没有循环在进行。 */
export interface SessionSwitcherState {
  ids: string[];
  index: number;
}

export interface SessionTabShortcutCallbacks {
  /** 当前标签条里的会话 id,按显示顺序。 */
  getSessionIds: () => string[];
  /** MRU 顺序(最近在前)的会话 id,仅含仍存在的会话。 */
  getMruSessionIds: () => string[];
  getActiveSessionId: () => string | undefined;
  activateSession: (sessionId: string) => void;
  closeActiveSession: () => void;
  duplicateActiveSession: () => void;
  /** 循环开启/移动/落定/取消时发布状态,null = 已关闭。 */
  onSwitcherStateChange: (state: SessionSwitcherState | null) => void;
}

/** keydown 用到的事件面:命中的组合键要拦下来,不能落进终端。 */
export interface TabShortcutKeyDownEvent extends TabShortcutKeyEvent, TabShortcutFocusContext {
  preventDefault: () => void;
  stopPropagation: () => void;
}

export interface SessionTabShortcutHandlers {
  onKeyDown: (event: TabShortcutKeyDownEvent) => void;
  /** 松开 Ctrl:落定本轮循环,真正切到选中的会话。 */
  onKeyUp: (event: Pick<TabShortcutKeyEvent, "key">) => void;
  /** 窗口失焦:画面从没切过去,静默切换会莫名其妙,所以按取消处理。 */
  onBlur: () => void;
  /** 外部路径(鼠标点选)已经自己落定并关掉了切换器:丢掉这一轮,后到的 Ctrl keyup 变 no-op。 */
  onExternalClose: () => void;
}

/**
 * 快捷键处理器工厂。MRU 循环的状态机放在组件外,好让「循环只移动选中项、
 * 只有松开 Ctrl 才激活一次」这条规则不依赖 DOM 就能测。
 */
export const createSessionTabShortcutHandlers = (
  getCallbacks: () => SessionTabShortcutCallbacks,
  isMac: boolean
): SessionTabShortcutHandlers => {
  // Ctrl 按住期间的 MRU 快照:循环走快照序,期间标签的增删不改写本轮的顺序。
  let cycle: { ids: string[]; index: number } | null = null;

  const publishCycle = (): void => {
    getCallbacks().onSwitcherStateChange(
      cycle ? { ids: [...cycle.ids], index: cycle.index } : null
    );
  };

  /** 关掉切换器且不切换会话(Esc、失焦、外部落定)。 */
  const cancelCycle = (): void => {
    if (!cycle) {
      return;
    }
    cycle = null;
    publishCycle();
  };

  /**
   * 落定本轮循环:整轮只有这里激活会话,而且只激活一次。选中项就是当前会话时
   * 连这一次也省掉——重复激活除了让共享 xterm 白重放一遍没有别的作用。
   */
  const commitCycle = (): void => {
    if (!cycle) {
      return;
    }
    const targetSessionId = cycle.ids[cycle.index];
    cycle = null;
    publishCycle();

    const callbacks = getCallbacks();
    if (targetSessionId !== undefined && targetSessionId !== callbacks.getActiveSessionId()) {
      callbacks.activateSession(targetSessionId);
    }
  };

  /** 开启(或推进)一轮循环。只动选中项,不激活。 */
  const moveCycle = (direction: 1 | -1): void => {
    if (!cycle) {
      const mruIds = getCallbacks().getMruSessionIds();
      // 只有一个标签没什么可切换的,别弹一个单行面板出来。
      if (mruIds.length < 2) {
        return;
      }
      cycle = { ids: mruIds, index: 0 };
    }

    const length = cycle.ids.length;
    cycle.index = (cycle.index + direction + length) % length;
    publishCycle();
  };

  const onKeyDown = (event: TabShortcutKeyDownEvent): void => {
    if (shouldIgnoreTabShortcutEvent(event)) {
      return;
    }

    // 切换器开着时方向键与 Esc 归它管,且要先于快捷键解析——否则 Esc 会落进终端。
    if (cycle) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        moveCycle(event.key === "ArrowDown" ? 1 : -1);
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancelCycle();
        return;
      }
    }

    const action = resolveSessionTabShortcut(event, isMac);
    if (!action) {
      return;
    }

    // 循环期间除了继续循环之外的动作一概不理:数字键/关闭/复制此刻按下多半是
    // 误触,处理它们会让选择器和真实激活状态对不上。也不拦——不做的键别乱吞。
    if (cycle && action.type !== "mru-cycle") {
      return;
    }

    const callbacks = getCallbacks();
    const sessionIds = callbacks.getSessionIds();
    if (sessionIds.length === 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    switch (action.type) {
      case "mru-cycle":
        moveCycle(action.direction);
        return;
      case "adjacent": {
        const activeId = callbacks.getActiveSessionId();
        const currentIndex = activeId ? sessionIds.indexOf(activeId) : -1;
        const base = currentIndex >= 0 ? currentIndex : 0;
        const target = sessionIds[(base + action.delta + sessionIds.length) % sessionIds.length];
        if (target !== undefined) {
          callbacks.activateSession(target);
        }
        return;
      }
      case "index": {
        const target = action.index === "last" ? sessionIds.at(-1) : sessionIds[action.index];
        if (target !== undefined) {
          callbacks.activateSession(target);
        }
        return;
      }
      case "close":
        callbacks.closeActiveSession();
        return;
      case "duplicate":
        callbacks.duplicateActiveSession();
        return;
    }
  };

  return {
    onKeyDown,
    onKeyUp: (event) => {
      if (event.key === "Control") {
        commitCycle();
      }
    },
    onBlur: cancelCycle,
    onExternalClose: cancelCycle
  };
};

const EDITABLE_TAG_NAMES = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** 事件目标是否是输入控件。非 Element 目标(window/document)一律不是。 */
const isEditableEventTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) {
    return false;
  }

  if (EDITABLE_TAG_NAMES.has(target.tagName)) {
    return true;
  }

  // isContentEditable 已经算过继承与 contenteditable="false",不必自己爬祖先。
  return target instanceof HTMLElement && target.isContentEditable;
};

/** 事件目标是否落在 xterm 宿主里(含它那个隐藏的 helper textarea)。 */
const isEventTargetInsideTerminal = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest(".xterm") !== null;

interface UseSessionTabShortcutsParams extends SessionTabShortcutCallbacks {
  isMac?: boolean;
}

export interface SessionTabShortcutsApi {
  /**
   * 鼠标点选等外部路径落定之后调用:状态机里那一轮就此作废,随后到来的
   * Ctrl keyup 不会再切一次。
   */
  closeSwitcher: () => void;
}

export const useSessionTabShortcuts = ({
  getSessionIds,
  getMruSessionIds,
  getActiveSessionId,
  activateSession,
  closeActiveSession,
  duplicateActiveSession,
  onSwitcherStateChange,
  isMac = typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.platform)
}: UseSessionTabShortcutsParams): SessionTabShortcutsApi => {
  const paramsRef = useRef<SessionTabShortcutCallbacks>({
    getSessionIds,
    getMruSessionIds,
    getActiveSessionId,
    activateSession,
    closeActiveSession,
    duplicateActiveSession,
    onSwitcherStateChange
  });
  paramsRef.current = {
    getSessionIds,
    getMruSessionIds,
    getActiveSessionId,
    activateSession,
    closeActiveSession,
    duplicateActiveSession,
    onSwitcherStateChange
  };
  const handlersRef = useRef<SessionTabShortcutHandlers | null>(null);

  useEffect(() => {
    const handlers = createSessionTabShortcutHandlers(() => paramsRef.current, isMac);
    handlersRef.current = handlers;
    const onKeyDown = (event: KeyboardEvent): void => {
      handlers.onKeyDown({
        key: event.key,
        code: event.code,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        isComposing: event.isComposing,
        targetIsEditable: isEditableEventTarget(event.target),
        targetInsideTerminal: isEventTargetInsideTerminal(event.target),
        preventDefault: () => event.preventDefault(),
        stopPropagation: () => event.stopPropagation()
      });
    };
    const onKeyUp = (event: KeyboardEvent): void => handlers.onKeyUp(event);
    const onBlur = (): void => handlers.onBlur();

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      // 卸载时收尾:留着一轮没关的循环会让覆盖层状态挂在那里。
      handlers.onExternalClose();
      if (handlersRef.current === handlers) {
        handlersRef.current = null;
      }
    };
  }, [isMac]);

  const closeSwitcher = useCallback(() => {
    handlersRef.current?.onExternalClose();
  }, []);

  return useMemo(() => ({ closeSwitcher }), [closeSwitcher]);
};
