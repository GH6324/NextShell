import { useEffect, useRef, useState } from "react";
import type { ConnectionProfile, SessionDescriptor } from "@nextshell/core";
import { connectionColor } from "../utils/connectionColor";
import { sessionStatusLabel } from "../utils/sessionStatus";

/**
 * Ctrl+Tab 切换器面板。只负责显示:选中项由状态机(useSessionTabShortcuts)
 * 持有,松开 Ctrl 才真正切换会话,所以这里没有任何键盘监听。
 *
 * 刻意延迟 150ms 才出现:轻点一下 Ctrl+Tab 立刻松手是最常用的「回到上一个标签」
 * 手势,面板闪一下反而碍眼。状态机那边是立即开的,延迟只在视觉层。
 */

const SWITCHER_APPEAR_DELAY_MS = 150;

interface SessionSwitcherOverlayProps {
  /** 本轮循环的会话行,已按循环顺序排好且剔除了中途消失的标签。 */
  sessions: SessionDescriptor[];
  /** 选中行下标,调用方保证落在 sessions 内。 */
  selectedIndex: number;
  connectionById: ReadonlyMap<string, ConnectionProfile>;
  /** 鼠标点选:直接落定并关闭。 */
  onSelect: (sessionId: string) => void;
  onCancel: () => void;
}

const describeSessionTarget = (
  session: SessionDescriptor,
  connection: ConnectionProfile | undefined
): string => {
  if (connection) {
    const user = connection.username.trim() ? `${connection.username}@` : "";
    return `${user}${connection.host}:${connection.port}`;
  }

  return session.target === "local" ? "本地终端" : "";
};

export const SessionSwitcherOverlay = ({
  sessions,
  selectedIndex,
  connectionById,
  onSelect,
  onCancel
}: SessionSwitcherOverlayProps) => {
  const [visible, setVisible] = useState(false);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  // 空依赖:延迟从这一轮循环打开时起算,选中项移动不重置计时。
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), SWITCHER_APPEAR_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  const selectedSessionId = sessions[selectedIndex]?.id;

  useEffect(() => {
    if (!visible || !selectedSessionId) {
      return;
    }
    rowRefs.current.get(selectedSessionId)?.scrollIntoView({ block: "nearest" });
  }, [selectedSessionId, visible]);

  if (!visible || sessions.length === 0) {
    return null;
  }

  return (
    <div
      className="session-switcher-backdrop"
      onMouseDown={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <div
        className="session-switcher-panel"
        role="listbox"
        aria-label="会话切换器"
        aria-activedescendant={
          selectedSessionId ? `session-switcher-${selectedSessionId}` : undefined
        }
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="session-switcher-list">
          {sessions.map((session, index) => {
            const connection = session.connectionId
              ? connectionById.get(session.connectionId)
              : undefined;
            const subtitle = describeSessionTarget(session, connection);
            const offline = session.status === "disconnected" || session.status === "failed";
            return (
              <div
                key={session.id}
                id={`session-switcher-${session.id}`}
                ref={(element) => {
                  if (element) {
                    rowRefs.current.set(session.id, element);
                  } else {
                    rowRefs.current.delete(session.id);
                  }
                }}
                role="option"
                aria-selected={index === selectedIndex}
                className={[
                  "session-switcher-row",
                  index === selectedIndex ? "session-switcher-row--selected" : "",
                  offline ? "session-switcher-row--offline" : ""
                ]
                  .filter(Boolean)
                  .join(" ")}
                onMouseDown={(event) => {
                  // mousedown 而非 click:用户此刻多半还按着 Ctrl,松手的 keyup
                  // 会先于 click 到达,那时这一轮已经被 onSelect 关掉了。
                  event.preventDefault();
                  event.stopPropagation();
                  onSelect(session.id);
                }}
              >
                <span
                  className="tab-connection-dot"
                  style={{
                    background: session.connectionId
                      ? connectionColor(session.connectionId)
                      : "var(--t3)"
                  }}
                  aria-hidden="true"
                />
                <span className="session-switcher-row-text">
                  <span className="session-switcher-row-title">{session.title}</span>
                  {subtitle ? (
                    <span className="session-switcher-row-subtitle">{subtitle}</span>
                  ) : null}
                </span>
                {offline ? (
                  <span className="session-switcher-row-status">
                    {sessionStatusLabel(session.status)}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
        <div className="session-switcher-hint">Ctrl+Tab 选择 · 松开 Ctrl 切换 · Esc 取消</div>
      </div>
    </div>
  );
};
