import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  fileEntrySchema,
  fileStatSchema,
  outputShape,
  READ_ONLY_ANNOTATIONS,
  targetInputDescription,
  toCallToolResult,
  type AgentToolContext
} from "./shared";

export const registerFileTools = (server: McpServer, ctx: AgentToolContext): void => {
  server.registerTool(
    "file_list",
    {
      title: "列出远端目录",
      description:
        "List a remote directory over SFTP. Structured output, so there is no need to parse `ls`. Paths must be absolute.",
      inputSchema: {
        target: z.string().min(1).describe(targetInputDescription),
        path: z.string().min(1).describe("Absolute remote directory path"),
        limit: z.number().int().min(1).max(500).optional()
      },
      outputSchema: outputShape(
        z.object({
          path: z.string(),
          entries: z.array(fileEntrySchema),
          total: z.number(),
          truncated: z.boolean()
        })
      ),
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (args) =>
      toCallToolResult(
        await ctx.gateway.listFiles(ctx.client, {
          target: args.target,
          path: args.path,
          limit: args.limit
        })
      )
  );

  server.registerTool(
    "file_stat",
    {
      title: "查看远端文件属性",
      description:
        "Stat a remote path over SFTP: type, size, permissions, owner ids and timestamps.",
      inputSchema: {
        target: z.string().min(1).describe(targetInputDescription),
        path: z.string().min(1).describe("Absolute remote path")
      },
      outputSchema: outputShape(fileStatSchema),
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (args) =>
      toCallToolResult(
        await ctx.gateway.statFile(ctx.client, { target: args.target, path: args.path })
      )
  );

  server.registerTool(
    "file_read",
    {
      title: "读取远端文件",
      description:
        "Read a remote regular file over SFTP. Non-regular files (devices, sockets, fifos) and files above the size limit are refused; binary content comes back base64-encoded and long files are truncated with `truncated: true`.",
      inputSchema: {
        target: z.string().min(1).describe(targetInputDescription),
        path: z.string().min(1).describe("Absolute remote file path"),
        maxBytes: z.number().int().min(1).max(262144).optional()
      },
      outputSchema: outputShape(
        z.object({
          path: z.string(),
          encoding: z.enum(["utf-8", "base64"]),
          content: z.string(),
          bytes: z.number(),
          size: z.number(),
          truncated: z.boolean()
        })
      ),
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (args) =>
      toCallToolResult(
        await ctx.gateway.readFile(ctx.client, {
          target: args.target,
          path: args.path,
          maxBytes: args.maxBytes
        })
      )
  );
};
