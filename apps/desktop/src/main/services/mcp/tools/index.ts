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
 * Every tool the endpoint exposes, in registration order. Later phases append
 * their own registrar here: SFTP writes and transfers (Tier 2), session_read
 * (Tier 0, needs ScreenMirror), session_send_keys and friends (Tier 3).
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
