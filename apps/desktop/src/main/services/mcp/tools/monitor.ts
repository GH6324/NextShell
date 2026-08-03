import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  monitorSnapshotSchema,
  outputShape,
  READ_ONLY_ANNOTATIONS,
  targetInputDescription,
  toCallToolResult,
  type AgentToolContext
} from "./shared";

export const registerMonitorTools = (server: McpServer, ctx: AgentToolContext): void => {
  server.registerTool(
    "monitor_snapshot",
    {
      title: "读取监控快照",
      description:
        "Latest CPU / memory / swap / disk / network snapshot plus top processes for one host. Returns an `unavailable` error when no snapshot has been captured yet.",
      inputSchema: {
        target: z.string().min(1).describe(targetInputDescription)
      },
      outputSchema: outputShape(monitorSnapshotSchema),
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (args) =>
      toCallToolResult(await ctx.gateway.monitorSnapshot(ctx.client, { target: args.target }))
  );
};
