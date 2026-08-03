import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  hostInfoSchema,
  monitorSnapshotSchema,
  outputShape,
  READ_ONLY_ANNOTATIONS,
  sessionInfoSchema,
  targetInputDescription,
  toCallToolResult,
  type AgentToolContext
} from "./shared";

export const registerHostTools = (server: McpServer, ctx: AgentToolContext): void => {
  server.registerTool(
    "host_list",
    {
      title: "列出主机",
      description:
        "List the hosts the user granted the agent access to. Hosts left at access level 'off' are not visible here and cannot be addressed by any tool. Returns metadata only — never credentials.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Optional filter over name, host, group path and tags"),
        limit: z.number().int().min(1).max(500).optional()
      },
      outputSchema: outputShape(
        z.object({
          hosts: z.array(hostInfoSchema),
          total: z.number(),
          truncated: z.boolean()
        })
      ),
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (args) =>
      toCallToolResult(
        await ctx.gateway.listHosts(ctx.client, { query: args.query, limit: args.limit })
      )
  );

  server.registerTool(
    "host_describe",
    {
      title: "查看主机详情",
      description:
        "Describe one host: metadata, its active sessions and the latest monitor snapshot when one is available.",
      inputSchema: {
        target: z.string().min(1).describe(targetInputDescription)
      },
      outputSchema: outputShape(
        hostInfoSchema.extend({
          sessions: z.array(sessionInfoSchema),
          monitor: monitorSnapshotSchema.nullable()
        })
      ),
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (args) =>
      toCallToolResult(await ctx.gateway.describeHost(ctx.client, { target: args.target }))
  );
};
