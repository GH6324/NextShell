import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  outputShape,
  READ_ONLY_ANNOTATIONS,
  toCallToolResult,
  type AgentToolContext
} from "./shared";

export const registerCommandTools = (server: McpServer, ctx: AgentToolContext): void => {
  server.registerTool(
    "command_search",
    {
      title: "检索命令库",
      description:
        "Search the user's saved command library, so the agent can reuse commands the user already curated instead of inventing them. The global shell history is not searchable here. Entries are redacted and entries naming hosts the agent cannot access are dropped.",
      inputSchema: {
        query: z.string().optional().describe("Substring filter over the command text"),
        limit: z.number().int().min(1).max(200).optional()
      },
      outputSchema: outputShape(
        z.object({
          matches: z.array(
            z.object({
              command: z.string(),
              source: z.literal("library"),
              name: z.string().nullable(),
              group: z.string().nullable(),
              lastUsedAt: z.string().nullable()
            })
          ),
          total: z.number(),
          truncated: z.boolean(),
          source: z.literal("library")
        })
      ),
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (args) =>
      toCallToolResult(
        await ctx.gateway.searchCommands(ctx.client, { query: args.query, limit: args.limit })
      )
  );
};
