import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  DESTRUCTIVE_ANNOTATIONS,
  outputShape,
  targetInputDescription,
  toCallToolResult,
  WRITE_ANNOTATIONS,
  type AgentToolContext
} from "./shared";

/**
 * Tier 3: driving the PTY the user is looking at.
 *
 * `exec` is the default for running anything — it is bounded, classified and
 * has no way to collide with the person at the keyboard. These tools exist for
 * the cases where the state genuinely lives in that shell: a TUI, an
 * interactive installer, a sudo prompt, an already-entered venv or `docker exec`.
 */
export const registerControlTools = (server: McpServer, ctx: AgentToolContext): void => {
  server.registerTool(
    "session_send_keys",
    {
      title: "向会话注入输入",
      description:
        "Type into a live session's PTY, as if the user had typed it. Prefer exec unless the state you need lives in that shell (a TUI, an interactive prompt, an entered venv or container). Always asks the user first. Refused while the user is actively typing in that session. With waitForPrompt the call returns once the shell reports the command finished (OSC 133), including its exit code and output; without shell integration no mark ever arrives and waitTimedOut comes back true rather than a guessed result.",
      inputSchema: {
        target: z.string().min(1).describe("Live session id returned by session_list"),
        text: z.string().max(4096).describe("Characters to type; control bytes are shown to the user by name"),
        submit: z.boolean().optional().describe("Append a carriage return to run it"),
        waitForPrompt: z
          .boolean()
          .optional()
          .describe("Wait for the shell's next OSC 133 completion mark"),
        timeoutSec: z.number().int().min(1).max(600).optional()
      },
      outputSchema: outputShape(
        z.object({
          sessionId: z.string(),
          bytes: z.number(),
          submitted: z.boolean(),
          completed: z
            .object({
              command: z.string().nullable(),
              exitCode: z.number().nullable(),
              output: z.string(),
              truncated: z.boolean()
            })
            .nullable(),
          waitTimedOut: z.boolean()
        })
      ),
      annotations: DESTRUCTIVE_ANNOTATIONS
    },
    async (args) => toCallToolResult(await ctx.gateway.sendKeys(ctx.client, args))
  );

  server.registerTool(
    "session_send_signal",
    {
      title: "向会话发送控制信号",
      description:
        "Send a control character to a live session: interrupt (Ctrl-C), eof (Ctrl-D), suspend (Ctrl-Z) or quit (Ctrl-\\). Use interrupt to stop something you started that is taking too long.",
      inputSchema: {
        target: z.string().min(1).describe("Live session id returned by session_list"),
        signal: z.enum(["interrupt", "eof", "suspend", "quit"])
      },
      outputSchema: outputShape(
        z.object({
          sessionId: z.string(),
          signal: z.enum(["interrupt", "eof", "suspend", "quit"])
        })
      ),
      annotations: DESTRUCTIVE_ANNOTATIONS
    },
    async (args) => toCallToolResult(await ctx.gateway.sendSignal(ctx.client, args))
  );

  server.registerTool(
    "session_open",
    {
      title: "打开终端标签",
      description:
        "Open a new terminal session on a host. The tab is real and visible in NextShell, badged as agent-controlled, and the user can close it at any time. Requires a host granted `full` access and a host key the user has already pinned.",
      inputSchema: { target: z.string().min(1).describe(targetInputDescription) },
      outputSchema: outputShape(
        z.object({
          sessionId: z.string(),
          connectionId: z.string(),
          title: z.string(),
          status: z.string()
        })
      ),
      annotations: WRITE_ANNOTATIONS
    },
    async (args) => toCallToolResult(await ctx.gateway.openSession(ctx.client, args))
  );

  server.registerTool(
    "session_close",
    {
      title: "关闭终端标签",
      description:
        "Close a live session and its GUI tab. Anything running in it is terminated, so close only sessions you opened.",
      inputSchema: { target: z.string().min(1).describe("Live session id returned by session_list") },
      outputSchema: outputShape(z.object({ sessionId: z.string() })),
      annotations: DESTRUCTIVE_ANNOTATIONS
    },
    async (args) => toCallToolResult(await ctx.gateway.closeSession(ctx.client, args))
  );

  server.registerTool(
    "session_focus",
    {
      title: "聚焦终端标签",
      description:
        "Bring NextShell's window forward and switch to this session's tab. Use it to hand something back to the user — a prompt that needs their judgement, or a result worth watching live.",
      inputSchema: { target: z.string().min(1).describe("Live session id returned by session_list") },
      outputSchema: outputShape(z.object({ sessionId: z.string() })),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args) => toCallToolResult(await ctx.gateway.focusSession(ctx.client, args))
  );
};
