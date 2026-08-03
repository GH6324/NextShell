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
    name: "host_search",
    title: "搜索主机",
    description: "按名称、主机地址、分组或标签搜索已授权的 NextShell 主机。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
        limit: { type: "integer", minimum: 1, maximum: 100 }
      },
      required: ["query"]
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: "session_open",
    title: "打开会话",
    description: "对已授权主机建立一个可复用的 SSH 会话，返回会话 id。",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "主机 nameId、名称或地址" }
      },
      required: ["target"]
    }
  },
  {
    name: "session_close",
    title: "关闭会话",
    description: "关闭之前打开的 SSH 会话。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" }
      },
      required: ["sessionId"]
    }
  },
  {
    name: "exec",
    title: "执行远程命令",
    description: "在已授权主机上执行一条命令并返回输出。",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "主机 nameId、名称或地址" },
        sessionId: { type: "string", description: "复用已有会话时提供" },
        command: { type: "string" },
        timeoutSec: { type: "integer", minimum: 1, maximum: 3600 }
      },
      required: ["command"]
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
