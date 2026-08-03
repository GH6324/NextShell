import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerCommandTools } from "./command";
import { registerExecTools } from "./exec";
import { registerFileTools } from "./file";
import { registerHostTools } from "./host";
import { registerMonitorTools } from "./monitor";
import { registerSessionTools } from "./session";
import { registerInteractionTools } from "./interact";
import type { AgentToolContext } from "./shared";

export type AgentToolRegistrar = (server: McpServer, ctx: AgentToolContext) => void;

/**
 * Tier 0 (read-only) registrars. Later phases append their own registrar here:
 * exec/session_send_keys (Tier 1/3), SFTP writes and transfers (Tier 2),
 * ask_user/notify_user (Tier 4).
 */
export const AGENT_TOOL_REGISTRARS: readonly AgentToolRegistrar[] = [
  registerHostTools,
  registerSessionTools,
  registerFileTools,
  registerMonitorTools,
  registerCommandTools,
  registerExecTools,
  registerInteractionTools
];

export const registerAgentTools = (server: McpServer, ctx: AgentToolContext): void => {
  for (const register of AGENT_TOOL_REGISTRARS) {
    register(server, ctx);
  }
};

export type { AgentToolContext } from "./shared";
export {
  registerCommandTools,
  registerExecTools,
  registerFileTools,
  registerHostTools,
  registerMonitorTools,
  registerSessionTools,
  registerInteractionTools
};
