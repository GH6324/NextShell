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
};
