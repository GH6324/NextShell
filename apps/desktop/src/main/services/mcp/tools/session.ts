import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  outputShape,
  READ_ONLY_ANNOTATIONS,
  sessionInfoSchema,
  targetInputDescription,
  toCallToolResult,
  type AgentToolContext
} from "./shared";

/**
 * `session_read` (ScreenMirror) and `session_history` (OscTap) join this module
 * once the main process gains session awareness; until then `cwd` and
 * `lastCommand` are reported as null rather than guessed.
 */
export const registerSessionTools = (server: McpServer, ctx: AgentToolContext): void => {
  server.registerTool(
    "session_list",
    {
      title: "列出会话",
      description:
        "List the live terminal sessions on authorized hosts. Sessions on hosts the agent cannot access are omitted. cwd and lastCommand stay null until main-process session tracking ships.",
      inputSchema: {
        target: z.string().optional().describe(targetInputDescription)
      },
      outputSchema: outputShape(
        z.object({
          sessions: z.array(sessionInfoSchema),
          truncated: z.boolean()
        })
      ),
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (args) =>
      toCallToolResult(await ctx.gateway.listSessions(ctx.client, { target: args.target }))
  );

  server.registerTool(
    "session_history",
    {
      title: "读取会话命令记录",
      description:
        "Read OSC-tracked commands, exit codes and bounded raw output for one live authorized session. Sessions without shell integration report limited capability instead of guessed command text.",
      inputSchema: {
        target: z.string().min(1).describe("Live session id returned by session_list"),
        limit: z.number().int().min(1).max(200).optional(),
        stripAnsi: z.boolean().optional()
      },
      outputSchema: outputShape(
        z.object({
          sessionId: z.string(),
          integrationAvailable: z.boolean(),
          entries: z.array(
            z.object({
              command: z.string().nullable(),
              exitCode: z.number().nullable(),
              startedAt: z.string(),
              finishedAt: z.string().nullable(),
              output: z.string(),
              truncated: z.boolean()
            })
          ),
          truncated: z.boolean()
        })
      ),
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (args) => toCallToolResult(await ctx.gateway.sessionHistory(ctx.client, args))
  );
};
