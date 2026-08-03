import { useState } from "react";
import { App as AntdApp, Alert, Button, Empty, Tag } from "antd";
import { useAgentActivityStore } from "../store/useAgentActivityStore";
import { formatErrorMessage } from "../utils/errorMessage";

const STATUS = {
  running: { color: "processing", label: "执行中" },
  succeeded: { color: "success", label: "完成" },
  failed: { color: "error", label: "失败" }
} as const;

export const AgentActivityPanel = () => {
  const { message } = AntdApp.useApp();
  const [collapsed, setCollapsed] = useState(false);
  const [toggling, setToggling] = useState(false);
  const activities = useAgentActivityStore((state) => state.activities);
  const clearFinished = useAgentActivityStore((state) => state.clearFinished);
  const halted = useAgentActivityStore((state) => state.halted);
  const setHalted = useAgentActivityStore((state) => state.setHalted);
  const running = activities.filter((activity) => activity.status === "running").length;

  const toggleHalted = async (next: boolean): Promise<void> => {
    setToggling(true);
    try {
      const status = await window.nextshell.agent.setHalted({ halted: next });
      setHalted(status.halted);
      message.success(next ? "已切断 Agent 的所有调用" : "已恢复 Agent 调用");
    } catch (error) {
      message.error(`操作失败：${formatErrorMessage(error, "请稍后重试")}`);
    } finally {
      setToggling(false);
    }
  };

  return (
    <section className="border-t border-[var(--border)] px-3 py-2" aria-label="Agent 活动">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="min-w-0 flex-1 text-left text-xs font-medium"
          onClick={() => setCollapsed((value) => !value)}
        >
          <i className="ri-robot-2-line mr-1" aria-hidden="true" />
          Agent 活动{running > 0 ? ` · ${running} 项执行中` : ""}
        </button>
        {/* The breaker stays reachable even when the list is collapsed: taking
            control back must never be more than one click away. */}
        <Button
          type="text"
          size="small"
          danger={!halted}
          loading={toggling}
          onClick={() => void toggleHalted(!halted)}
        >
          {halted ? "恢复" : "全部中止"}
        </Button>
        <Button type="text" size="small" onClick={clearFinished} disabled={activities.length === running}>
          清理
        </Button>
      </div>
      {halted ? (
        <Alert
          className="mt-2"
          type="warning"
          showIcon
          message="Agent 调用已被切断"
          description="所有工具调用会立即被拒绝，「本会话始终允许」也已全部作废。"
        />
      ) : null}
      {!collapsed ? (
        activities.length > 0 ? (
          <div className="mt-2 max-h-40 space-y-2 overflow-y-auto">
            {activities.slice(0, 20).map((activity) => {
              const status = STATUS[activity.status];
              return (
                <div key={activity.id} className="rounded border border-[var(--border)] px-2 py-1.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{activity.clientName ?? "未知客户端"} · {activity.tool}</span>
                    <Tag color={status.color} className="m-0">{status.label}</Tag>
                  </div>
                  <div className="mt-1 truncate text-[var(--text-secondary)]" title={activity.summary}>
                    {activity.summary}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无 Agent 活动" className="my-2" />
        )
      ) : null}
    </section>
  );
};
