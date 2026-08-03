import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { outputShape, targetInputDescription, toCallToolResult, type AgentToolContext } from "./shared";

const EXEC_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true
} as const;

export const registerExecTools = (server: McpServer, ctx: AgentToolContext): void => {
  server.registerTool(
    "exec",
    {
      title: "执行远端命令",
      description:
        "Execute a command through NextShell's managed SSH connection. A session id inherits that session's OSC-tracked cwd; explicit cwd wins. Commands are risk-classified and may require in-app approval.",
      inputSchema: {
        target: z.string().min(1).describe(`${targetInputDescription} A live session id is also accepted.`),
        command: z.string().min(1).max(256 * 1024),
        cwd: z.string().optional().describe("Absolute remote working directory"),
        timeoutSec: z.number().int().min(1).max(3600).optional()
      },
      outputSchema: outputShape(
        z.object({
          connectionId: z.string(),
          command: z.string(),
          stdout: z.string(),
          stderr: z.string(),
          exitCode: z.number(),
          actualCwd: z.string().nullable(),
          executedAt: z.string(),
          risk: z.object({
            level: z.enum(["readonly", "unknown", "dangerous"]),
            reason: z.string(),
            hasSudo: z.boolean()
          })
        })
      ),
      annotations: EXEC_ANNOTATIONS
    },
    async (args) => toCallToolResult(await ctx.gateway.execCommand(ctx.client, args))
  );
};
