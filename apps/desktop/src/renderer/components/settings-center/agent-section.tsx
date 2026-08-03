import { useCallback, useEffect, useState } from "react";
import {
  App as AntdApp,
  Alert,
  Badge,
  Button,
  Input,
  InputNumber,
  Popconfirm,
  Radio,
  Space,
  Switch,
  Tag,
  Typography
} from "antd";
import type { AgentClientKind, AgentEndpointStatus } from "@nextshell/shared";
import { usePreferencesStore } from "../../store/usePreferencesStore";
import { formatErrorMessage } from "../../utils/errorMessage";
import { SettingsCard, SettingsRow, SettingsSwitchRow } from "./shared-components";

const CLIENT_OPTIONS: Array<{ label: string; value: AgentClientKind }> = [
  { label: "Claude Code", value: "claude-code" },
  { label: "Claude Desktop", value: "claude-desktop" },
  { label: "Cursor", value: "cursor" },
  { label: "通用 JSON", value: "generic" }
];

/** Exported for unit testing — maps a connected-client count to its display copy. */
export const formatClientCount = (count: number): string =>
  count > 0 ? `${count} 个客户端已连接` : "暂无客户端连接";

/**
 * Exported for unit testing — maps live endpoint status to the running-state
 * badge copy. A halted endpoint is still listening, so reporting it as "监听中"
 * would tell the user the opposite of what is true.
 */
export const formatRunningState = (
  enabled: boolean,
  listening: boolean,
  halted = false
): { status: "success" | "error" | "warning" | "default"; text: string } => {
  if (!enabled) return { status: "default", text: "未启用" };
  if (!listening) return { status: "error", text: "已启用但未监听" };
  return halted
    ? { status: "warning", text: "监听中（调用已被切断）" }
    : { status: "success", text: "监听中" };
};

export const AgentSection = () => {
  const { message } = AntdApp.useApp();
  const preferences = usePreferencesStore((s) => s.preferences);
  const prefsLoading = usePreferencesStore((s) => s.loading);
  const updatePreferences = usePreferencesStore((s) => s.updatePreferences);
  const agentPrefs = preferences.agent;

  const [status, setStatus] = useState<AgentEndpointStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [togglingEnabled, setTogglingEnabled] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [tokenVisible, setTokenVisible] = useState(false);
  const [clientKind, setClientKind] = useState<AgentClientKind>("claude-code");
  const [copyingConfig, setCopyingConfig] = useState(false);
  const [configResult, setConfigResult] = useState<{ command: string; json: string } | null>(null);

  const refreshStatus = useCallback(async (): Promise<void> => {
    setStatusLoading(true);
    try {
      const result = await window.nextshell.agent.status();
      setStatus(result);
    } catch (error) {
      message.error(`获取 Agent 状态失败：${formatErrorMessage(error, "请稍后重试")}`);
    } finally {
      setStatusLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void refreshStatus();
    // Runs once on mount; the section unmounts when the sidebar tab changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = useCallback(
    (patch: Parameters<typeof updatePreferences>[0]) => {
      void updatePreferences(patch).catch((error) => {
        message.error(`保存设置失败：${formatErrorMessage(error, "请稍后重试")}`);
      });
    },
    [updatePreferences, message]
  );

  const handleToggleEnabled = async (checked: boolean): Promise<void> => {
    setTogglingEnabled(true);
    try {
      const result = checked
        ? await window.nextshell.agent.enable()
        : await window.nextshell.agent.disable();
      setStatus(result);
      setTokenVisible(false);
      if (checked && result.lastError) {
        message.warning(`Agent 接入已开启，但监听未能建立：${result.lastError}`);
      } else {
        message.success(checked ? "Agent 接入已启用" : "Agent 接入已停用");
      }
    } catch (error) {
      message.error(`操作失败：${formatErrorMessage(error, "请稍后重试")}`);
    } finally {
      setTogglingEnabled(false);
    }
  };

  const handleRotateToken = async (): Promise<void> => {
    setRotating(true);
    try {
      const result = await window.nextshell.agent.rotateToken();
      setStatus(result);
      setTokenVisible(false);
      message.success("令牌已轮换，所有已连接客户端已断开");
    } catch (error) {
      message.error(`轮换令牌失败：${formatErrorMessage(error, "请稍后重试")}`);
    } finally {
      setRotating(false);
    }
  };

  const handleCopyText = async (text: string, label: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      message.success(`${label}已复制到剪贴板`);
    } catch (error) {
      message.error(`复制失败：${formatErrorMessage(error, "请稍后重试")}`);
    }
  };

  const handleAddAllowedRoot = async (): Promise<void> => {
    try {
      const result = await window.nextshell.dialog.openDirectory({
        title: "选择 Agent 可访问的本地根目录"
      });
      if (result.canceled || !result.filePath) return;
      if (agentPrefs.allowedLocalRoots.includes(result.filePath)) {
        message.info("该目录已在允许列表中");
        return;
      }
      save({ agent: { allowedLocalRoots: [...agentPrefs.allowedLocalRoots, result.filePath] } });
    } catch (error) {
      message.error(`选择目录失败：${formatErrorMessage(error, "请稍后重试")}`);
    }
  };

  const handleCopyClientConfig = async (): Promise<void> => {
    setCopyingConfig(true);
    try {
      const result = await window.nextshell.agent.copyClientConfig({ client: clientKind });
      setConfigResult({ command: result.command, json: result.json });
      message.success("接入配置已复制到剪贴板");
    } catch (error) {
      message.error(`生成接入配置失败：${formatErrorMessage(error, "请稍后重试")}`);
    } finally {
      setCopyingConfig(false);
    }
  };

  const enabled = status?.enabled ?? false;
  const listening = status?.listening ?? false;
  const runningState = formatRunningState(enabled, listening, status?.halted ?? false);
  const hasToken = Boolean(status?.token);

  return (
    <>
      <SettingsCard
        title="Agent 接入（MCP）"
        description="允许 Claude Code 等 AI Agent 通过 MCP 协议连接本机，纳管你逐台授权的主机"
      >
        <div className="stg-switch-row">
          <div className="stg-switch-label">
            <span>启用 Agent 接入</span>
            <span className="stg-row-hint">
              开启后本机会监听一个仅当前系统用户可访问的本地端点，供 MCP 客户端连接。默认关闭，关闭时不会监听任何端点。
            </span>
          </div>
          <Switch
            size="small"
            checked={enabled}
            loading={togglingEnabled || (statusLoading && !status)}
            onChange={(v) => void handleToggleEnabled(v)}
          />
        </div>

        <div className="flex items-center gap-2">
          <Typography.Text style={{ fontSize: 12 }}>运行状态：</Typography.Text>
          {statusLoading && !status ? (
            <Tag>加载中…</Tag>
          ) : (
            <Badge status={runningState.status} text={runningState.text} />
          )}
        </div>

        {status?.lastError && <Alert type="error" showIcon message={status.lastError} />}
      </SettingsCard>

      <SettingsCard title="运行详情" description="端点当前的监听信息，仅本机可见">
        <SettingsRow label="Unix Socket 路径">
          <Typography.Text
            style={{ fontSize: 12 }}
            type={status?.socketPath ? undefined : "secondary"}
            copyable={status?.socketPath ? { text: status.socketPath } : false}
          >
            {status?.socketPath ?? "未监听"}
          </Typography.Text>
        </SettingsRow>
        <SettingsRow label="TCP 端口">
          <Typography.Text style={{ fontSize: 12 }} type={status?.tcpPort ? undefined : "secondary"}>
            {status?.tcpPort ?? "未监听"}
          </Typography.Text>
        </SettingsRow>
        <SettingsRow label="已连接客户端">
          <Typography.Text style={{ fontSize: 12 }}>
            {formatClientCount(status?.clients.length ?? 0)}
          </Typography.Text>
        </SettingsRow>
        <SettingsRow label="endpoint.json 路径" hint="MCP 客户端可通过该文件自动发现端点">
          <Typography.Text
            style={{ fontSize: 12, wordBreak: "break-all" }}
            copyable={status?.endpointFilePath ? { text: status.endpointFilePath } : false}
          >
            {status?.endpointFilePath ?? "-"}
          </Typography.Text>
        </SettingsRow>
      </SettingsCard>

      <SettingsCard
        title="传输方式"
        description="Unix Socket 为默认推荐方式；TCP 仅用于无法访问本地 Socket 的场景（如 WSL），安全性弱于 Socket"
      >
        <SettingsSwitchRow
          label="Unix Socket（推荐）"
          hint="通过 0600 文件权限授权，仅当前系统用户可访问，不签发令牌"
          checked={agentPrefs.socketEnabled}
          disabled={prefsLoading || !enabled}
          onChange={(v) => save({ agent: { socketEnabled: v } })}
        />
        <SettingsSwitchRow
          label="额外监听 127.0.0.1 TCP"
          hint="用于 WSL 等无法访问 Unix Socket 的客户端，需搭配令牌使用，默认关闭"
          checked={agentPrefs.tcpEnabled}
          disabled={prefsLoading || !enabled}
          onChange={(v) => save({ agent: { tcpEnabled: v } })}
        />
        {agentPrefs.tcpEnabled && (
          <SettingsRow label="TCP 端口" hint="0 表示由系统自动分配">
            <InputNumber
              style={{ width: "100%" }}
              min={0}
              max={65535}
              precision={0}
              value={agentPrefs.tcpPort}
              disabled={prefsLoading || !enabled}
              onChange={(v) => {
                if (typeof v === "number" && Number.isInteger(v)) {
                  save({ agent: { tcpPort: v } });
                }
              }}
            />
          </SettingsRow>
        )}
        <div className="stg-note">修改传输方式后需重新启用 Agent 接入才会生效。</div>
      </SettingsCard>

      <SettingsCard title="访问令牌" description="仅 TCP 监听时使用；Socket 连接依赖文件权限，不签发令牌">
        <SettingsRow label="当前令牌">
          <div className="flex items-center gap-2">
            <Input.Password
              style={{ maxWidth: 360 }}
              value={status?.token ?? ""}
              visibilityToggle={{ visible: tokenVisible, onVisibleChange: setTokenVisible }}
              readOnly
              disabled={!hasToken}
              placeholder={enabled && agentPrefs.tcpEnabled ? "启用 TCP 监听后生成" : "未启用 TCP 监听"}
            />
            <Button
              size="small"
              disabled={!hasToken}
              onClick={() => hasToken && void handleCopyText(status!.token!, "令牌")}
            >
              复制
            </Button>
            <Popconfirm
              title="轮换令牌？"
              description="轮换后旧令牌立即失效，所有已连接的客户端都会被断开。"
              onConfirm={() => void handleRotateToken()}
              okText="轮换"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              disabled={!hasToken}
            >
              <Button size="small" danger loading={rotating} disabled={!hasToken}>
                轮换
              </Button>
            </Popconfirm>
          </div>
        </SettingsRow>
      </SettingsCard>

      <SettingsCard title="一键接入客户端" description="按客户端类型生成接入配置，点击后直接复制到剪贴板">
        <SettingsRow label="客户端类型">
          <Radio.Group
            value={clientKind}
            onChange={(e) => setClientKind(e.target.value as AgentClientKind)}
            options={CLIENT_OPTIONS}
            optionType="button"
            size="small"
          />
        </SettingsRow>
        <Space>
          <Button type="primary" loading={copyingConfig} onClick={() => void handleCopyClientConfig()}>
            生成并复制接入配置
          </Button>
        </Space>
        {configResult && (
          <>
            <SettingsRow label="CLI 命令">
              <div className="flex items-center gap-2">
                <Typography.Text code style={{ fontSize: 12, wordBreak: "break-all" }}>
                  {configResult.command}
                </Typography.Text>
                <Button size="small" onClick={() => void handleCopyText(configResult.command, "命令")}>
                  复制
                </Button>
              </div>
            </SettingsRow>
            <SettingsRow label="JSON 片段">
              <div className="flex items-start gap-2">
                <Typography.Text
                  code
                  style={{ fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-all" }}
                >
                  {configResult.json}
                </Typography.Text>
                <Button
                  size="small"
                  onClick={() => void handleCopyText(configResult.json, "JSON 片段")}
                >
                  复制
                </Button>
              </div>
            </SettingsRow>
          </>
        )}
        {(clientKind === "cursor" || clientKind === "claude-desktop") && (
          <div className="stg-note">
            Cursor 一键安装与自动写入 Claude Desktop 配置文件将在后续版本支持，当前请手动粘贴上方配置。
          </div>
        )}
      </SettingsCard>

      <SettingsCard
        title="写操作与命令确认"
        description="Agent 执行写操作或不在只读白名单里的命令时，是否在应用内弹窗确认"
      >
        <SettingsSwitchRow
          label="写操作需要确认"
          hint="文件写入 / 创建目录 / 重命名。关闭后这些操作不再弹窗；删除与文件传输始终确认，不受此项影响"
          checked={agentPrefs.confirmWrites}
          disabled={prefsLoading}
          onChange={(v) => save({ agent: { confirmWrites: v } })}
        />
        <SettingsSwitchRow
          label="未知命令需要确认"
          hint="命令不在只读白名单也不在危险黑名单时弹窗。危险命令与 sudo 始终确认，不受此项影响"
          checked={agentPrefs.confirmUnknownCommands}
          disabled={prefsLoading}
          onChange={(v) => save({ agent: { confirmUnknownCommands: v } })}
        />
        <SettingsRow label="命令超时（秒）" hint="Agent 发起的单条命令最长执行时间，上限 120 秒">
          <InputNumber
            style={{ width: "100%" }}
            min={1}
            max={3600}
            precision={0}
            value={agentPrefs.execTimeoutSec}
            disabled={prefsLoading}
            onChange={(v) => {
              if (typeof v === "number" && Number.isInteger(v)) {
                save({ agent: { execTimeoutSec: v } });
              }
            }}
          />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard
        title="本地路径策略"
        description="限制 Agent 在本机可读写的范围。文件传输是本机文件外泄与被篡改的唯一通道，这里是它的闸门"
      >
        <SettingsRow
          label="允许的本地根目录"
          hint="留空表示不限制目录（拒绝清单仍然生效）。设置后，Agent 的上传与下载只能落在这些目录内"
        >
          <div className="flex flex-col gap-2">
            {agentPrefs.allowedLocalRoots.length > 0 ? (
              <Space size={[4, 4]} wrap>
                {agentPrefs.allowedLocalRoots.map((root) => (
                  <Tag
                    key={root}
                    closable
                    onClose={() =>
                      save({
                        agent: {
                          allowedLocalRoots: agentPrefs.allowedLocalRoots.filter(
                            (item) => item !== root
                          )
                        }
                      })
                    }
                  >
                    {root}
                  </Tag>
                ))}
              </Space>
            ) : (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                未限制目录
              </Typography.Text>
            )}
            <Space>
              <Button
                size="small"
                disabled={prefsLoading}
                onClick={() => void handleAddAllowedRoot()}
              >
                添加目录…
              </Button>
              {agentPrefs.allowedLocalRoots.length > 0 && (
                <Button
                  size="small"
                  type="text"
                  danger
                  disabled={prefsLoading}
                  onClick={() => save({ agent: { allowedLocalRoots: [] } })}
                >
                  清空
                </Button>
              )}
            </Space>
          </div>
        </SettingsRow>
        <div className="stg-note">
          无论是否设置允许根，以下始终拒绝：~/.ssh、~/.aws、~/.gnupg、~/.kube
          等凭据目录，浏览器配置目录，NextShell 自身的数据目录，以及 .env / id_* / *.pem / *.key
          等凭据文件模式。下载还会额外拒绝写入 ~/.zshrc、~/.bashrc、自启动目录与系统目录。
        </div>
      </SettingsCard>

      <SettingsCard title="安全说明">
        <div className="stg-note">
          主机默认对 Agent 不可见。需要在「连接管理」中逐台编辑连接，在「属性」标签页把「Agent
          授权」改为「只读」或「完全」并保存后，该主机才会出现在 Agent 可见的主机列表中。
        </div>
        <div className="stg-note">
          Agent 无法获取明文密码、私钥、密钥口令等凭据；上方令牌仅用于建立 MCP 连接本身，不是主机凭据。
        </div>
      </SettingsCard>
    </>
  );
};
