import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerCommandTools } from "./command";
import { registerControlTools } from "./control";
import { registerExecTools } from "./exec";
import { registerFileTools } from "./file";
import { registerHostTools } from "./host";
import { registerMonitorTools } from "./monitor";
import { registerSessionTools } from "./session";
import { registerTransferTools } from "./transfer";
import { registerInteractionTools } from "./interact";
import type { AgentToolContext } from "./shared";

export type AgentToolRegistrar = (server: McpServer, ctx: AgentToolContext) => void;

/** Every tool the endpoint exposes, in registration order. */
export const AGENT_TOOL_REGISTRARS: readonly AgentToolRegistrar[] = [
  registerHostTools,
  registerSessionTools,
  registerFileTools,
  registerMonitorTools,
  registerCommandTools,
  registerExecTools,
  registerTransferTools,
  registerControlTools,
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
  registerControlTools,
  registerExecTools,
  registerFileTools,
  registerHostTools,
  registerMonitorTools,
  registerSessionTools,
  registerTransferTools,
  registerInteractionTools
};
