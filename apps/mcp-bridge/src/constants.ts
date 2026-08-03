export const BRIDGE_NAME = "nextshell-mcp-bridge";
/** Keep in sync with apps/mcp-bridge/package.json. */
export const BRIDGE_VERSION = "0.1.0";

export const LATEST_PROTOCOL_VERSION = "2025-11-25";
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export const DEFAULT_CONNECT_TIMEOUT_MS = 4000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
/** Remote commands and transfers can legitimately outlive a plain RPC. */
export const DEFAULT_CALL_TIMEOUT_MS = 300000;
/** Lower bound between two background dial attempts while NextShell is down. */
export const DEFAULT_REFRESH_INTERVAL_MS = 5000;

export const UNAVAILABLE_MESSAGE =
  "无法连接到 NextShell：应用未运行，或未在设置中心开启 Agent 接入。请启动 NextShell 桌面应用，" +
  "在「设置中心 → Agent 接入」中开启后重试。";

export const BRIDGE_INSTRUCTIONS =
  "本工具集由本机运行的 NextShell 桌面应用提供，所有 SSH 凭据都留在应用内，桥接进程不持有任何密码或私钥。" +
  "只有用户在应用中显式授权的主机对你可见。若工具报告无法连接，请提示用户启动 NextShell 并开启 Agent 接入。";
