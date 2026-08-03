import { useState } from "react";
import { Button, Empty, Tag } from "antd";
import { useAgentActivityStore } from "../store/useAgentActivityStore";

const STATUS = {
  running: { color: "processing", label: "执行中" },
  succeeded: { color: "success", label: "完成" },
  failed: { color: "error", label: "失败" }
} as const;

export const AgentActivityPanel = () => {
  const [collapsed, setCollapsed] = useState(false);
  const activities = useAgentActivityStore((state) => state.activities);
  const clearFinished = useAgentActivityStore((state) => state.clearFinished);
  const running = activities.filter((activity) => activity.status === "running").length;

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
        <Button type="text" size="small" onClick={clearFinished} disabled={activities.length === running}>
          清理
        </Button>
      </div>
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
