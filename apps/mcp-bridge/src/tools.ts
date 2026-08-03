import { isRecord } from "./json-rpc.js";

export interface ToolDescriptor {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/** Answered by the bridge itself; never forwarded upstream. */
export const BRIDGE_STATUS_TOOL = "nextshell_bridge_status";

const emptySchema = (): Record<string, unknown> => ({ type: "object", properties: {} });

export const BRIDGE_STATUS_TOOL_DESCRIPTOR: ToolDescriptor = {
  name: BRIDGE_STATUS_TOOL,
  title: "NextShell 桥接状态",
  description:
    "检查 NextShell 桌面应用是否可达、Agent 接入是否已开启。NextShell 未运行时其他工具会失败，先用它确认。",
  inputSchema: emptySchema(),
  annotations: { readOnlyHint: true, openWorldHint: false }
};

const targetSchema = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "object",
  properties: { target: { type: "string" }, ...extra },
  required: ["target"]
});

/**
 * Fallback manifest used only while NextShell is unreachable, so that a client
 * that starts before the app still completes `initialize` / `tools/list`. The
 * running app is authoritative: the first successful dial replaces this list and
 * emits `notifications/tools/list_changed`.
 */
export const STATIC_TOOLS: ToolDescriptor[] = [
  BRIDGE_STATUS_TOOL_DESCRIPTOR,
  {
    name: "host_list",
    title: "列出主机",
    description: "列出已授权 Agent 访问的 NextShell 主机摘要（不含任何凭据字段）。",
    inputSchema: emptySchema(),
    annotations: { readOnlyHint: true }
  },
  {
    name: "host_describe",
    title: "查看主机",
    description: "查看一台已授权主机、活动会话与监控摘要。",
    inputSchema: targetSchema(),
    annotations: { readOnlyHint: true }
  },
  {
    name: "session_list",
    title: "列出会话",
    description: "列出已授权主机的活动会话与 OSC 跟踪的 cwd。",
    inputSchema: emptySchema(),
    annotations: { readOnlyHint: true }
  },
  {
    name: "session_history",
    title: "读取会话历史",
    description: "读取活动会话的命令、退出码与有界输出。",
    inputSchema: targetSchema(),
    annotations: { readOnlyHint: true }
  },
  {
    name: "file_list",
    title: "列出远端目录",
    inputSchema: targetSchema({ path: { type: "string" } }),
    annotations: { readOnlyHint: true }
  },
  {
    name: "file_stat",
    title: "查看远端文件属性",
    inputSchema: targetSchema({ path: { type: "string" } }),
    annotations: { readOnlyHint: true }
  },
  {
    name: "file_read",
    title: "读取远端文件",
    inputSchema: targetSchema({ path: { type: "string" } }),
    annotations: { readOnlyHint: true }
  },
  {
    name: "monitor_snapshot",
    title: "读取监控快照",
    inputSchema: targetSchema(),
    annotations: { readOnlyHint: true }
  },
  {
    name: "command_search",
    title: "检索命令库",
    inputSchema: emptySchema(),
    annotations: { readOnlyHint: true }
  },
  {
    name: "exec",
    title: "执行远程命令",
    description: "在已授权主机上执行一条命令并返回输出。",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "主机或活动会话 id" },
        command: { type: "string" },
        cwd: { type: "string" },
        timeoutSec: { type: "integer", minimum: 1, maximum: 3600 }
      },
      required: ["target", "command"]
    }
  },
  {
    name: "file_write",
    title: "写入远端文件",
    description: "写入一个小文件（1MB 以内），已存在则覆盖。大文件或整个目录请用 transfer_upload。",
    inputSchema: targetSchema({
      path: { type: "string" },
      content: { type: "string" },
      encoding: { type: "string", enum: ["utf-8", "base64"] }
    })
  },
  {
    name: "file_mkdir",
    title: "创建远端目录",
    inputSchema: targetSchema({ path: { type: "string" } }),
    annotations: { idempotentHint: true }
  },
  {
    name: "file_rename",
    title: "重命名远端路径",
    inputSchema: targetSchema({ from: { type: "string" }, to: { type: "string" } })
  },
  {
    name: "file_delete",
    title: "删除远端路径",
    description: "删除远端路径。目录会被递归删除且不可恢复，始终需要用户在 NextShell 内确认。",
    inputSchema: targetSchema({
      path: { type: "string" },
      type: { type: "string", enum: ["file", "directory", "link"] }
    }),
    annotations: { destructiveHint: true }
  },
  {
    name: "transfer_upload",
    title: "上传到远端",
    description:
      "把本机文件或目录传到主机（目录自动打包为 tar.gz 并在远端解包）。立即返回 taskId，用 transfer_status 轮询。",
    inputSchema: targetSchema({
      localPath: { type: "string" },
      remotePath: { type: "string" }
    })
  },
  {
    name: "transfer_download",
    title: "下载到本机",
    description: "把远端文件下载到本机。立即返回 taskId，用 transfer_status 轮询。",
    inputSchema: targetSchema({
      remotePath: { type: "string" },
      localPath: { type: "string" }
    })
  },
  {
    name: "transfer_status",
    title: "查询传输进度",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"]
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: "transfer_cancel",
    title: "取消传输",
    inputSchema: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"]
    },
    annotations: { idempotentHint: true }
  },
  {
    name: "ask_user",
    title: "询问用户",
    description: "在 NextShell 内弹出确认、选择或文本问询。",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string" }, choices: { type: "array", items: { type: "string" } } },
      required: ["question"]
    }
  },
  {
    name: "notify_user",
    title: "通知用户",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, message: { type: "string" } },
      required: ["title", "message"]
    }
  }
];

export const parseToolDescriptors = (value: unknown): ToolDescriptor[] | null => {
  if (!isRecord(value) || !Array.isArray(value.tools)) {
    return null;
  }
  const tools: ToolDescriptor[] = [];
  for (const entry of value.tools) {
    if (isRecord(entry) && typeof entry.name === "string" && entry.name.length > 0) {
      // Kept by reference so client-visible fields the bridge does not model survive.
      tools.push(entry as unknown as ToolDescriptor);
    }
  }
  return tools;
};

export const toolListSignature = (tools: ToolDescriptor[]): string =>
  JSON.stringify(
    tools.map((tool) => [tool.name, tool.description ?? "", tool.inputSchema ?? null])
  );
