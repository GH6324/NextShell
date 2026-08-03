import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { outputShape, toCallToolResult, type AgentToolContext } from "./shared";

export const registerInteractionTools = (server: McpServer, ctx: AgentToolContext): void => {
  server.registerTool(
    "ask_user",
    {
      title: "在 NextShell 中询问用户",
      description:
        "Ask the user through a NextShell-owned dialog. Use this for ambiguous choices or information that must not pass through the MCP client.",
      inputSchema: {
        question: z.string().min(1).max(4000),
        choices: z.array(z.string().min(1).max(200)).min(1).max(20).optional(),
        allowText: z.boolean().optional(),
        sensitive: z.boolean().optional()
      },
      outputSchema: outputShape(
        z.object({ canceled: z.boolean(), answer: z.string().nullable() })
      ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (args) => toCallToolResult(await ctx.gateway.askUser(ctx.client, args))
  );

  server.registerTool(
    "notify_user",
    {
      title: "通知用户",
      description: "Show a native notification from NextShell.",
      inputSchema: {
        title: z.string().min(1).max(160),
        message: z.string().min(1).max(2000)
      },
      outputSchema: outputShape(z.object({ delivered: z.literal(true) })),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (args) => toCallToolResult(await ctx.gateway.notifyUser(ctx.client, args))
  );
};
