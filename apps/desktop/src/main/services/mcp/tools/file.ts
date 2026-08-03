import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  DESTRUCTIVE_ANNOTATIONS,
  fileEntrySchema,
  fileStatSchema,
  outputShape,
  READ_ONLY_ANNOTATIONS,
  targetInputDescription,
  toCallToolResult,
  WRITE_ANNOTATIONS,
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

  server.registerTool(
    "file_write",
    {
      title: "写入远端文件",
      description:
        "Write a small file over SFTP, replacing it if it exists. Requires a host granted `full` access and may open a NextShell confirmation dialog. For anything over 1 MB, or for a whole directory, use transfer_upload instead.",
      inputSchema: {
        target: z.string().min(1).describe(targetInputDescription),
        path: z.string().min(1).describe("Absolute remote file path"),
        content: z.string().max(4 * 1024 * 1024),
        encoding: z
          .enum(["utf-8", "base64"])
          .optional()
          .describe("How `content` is encoded; defaults to utf-8")
      },
      outputSchema: outputShape(z.object({ path: z.string(), bytes: z.number() })),
      annotations: WRITE_ANNOTATIONS
    },
    async (args) => toCallToolResult(await ctx.gateway.writeFile(ctx.client, args))
  );

  server.registerTool(
    "file_mkdir",
    {
      title: "创建远端目录",
      description:
        "Create a remote directory over SFTP, including any missing parents. Requires a host granted `full` access.",
      inputSchema: {
        target: z.string().min(1).describe(targetInputDescription),
        path: z.string().min(1).describe("Absolute remote directory path")
      },
      outputSchema: outputShape(z.object({ path: z.string() })),
      annotations: { ...WRITE_ANNOTATIONS, idempotentHint: true }
    },
    async (args) => toCallToolResult(await ctx.gateway.makeDirectory(ctx.client, args))
  );

  server.registerTool(
    "file_rename",
    {
      title: "重命名远端路径",
      description:
        "Rename or move a remote path over SFTP. Both paths must be absolute and on the same host. Requires a host granted `full` access.",
      inputSchema: {
        target: z.string().min(1).describe(targetInputDescription),
        from: z.string().min(1).describe("Absolute current remote path"),
        to: z.string().min(1).describe("Absolute destination remote path")
      },
      outputSchema: outputShape(z.object({ from: z.string(), to: z.string() })),
      annotations: WRITE_ANNOTATIONS
    },
    async (args) => toCallToolResult(await ctx.gateway.renamePath(ctx.client, args))
  );

  server.registerTool(
    "file_delete",
    {
      title: "删除远端路径",
      description:
        "Delete a remote path over SFTP. Deleting a directory removes its contents recursively and cannot be undone, so this always asks the user in NextShell regardless of settings. Requires a host granted `full` access.",
      inputSchema: {
        target: z.string().min(1).describe(targetInputDescription),
        path: z.string().min(1).describe("Absolute remote path"),
        type: z
          .enum(["file", "directory", "link"])
          .describe("Use file_stat first when unsure; the wrong type fails on the remote side")
      },
      outputSchema: outputShape(z.object({ path: z.string() })),
      annotations: DESTRUCTIVE_ANNOTATIONS
    },
    async (args) => toCallToolResult(await ctx.gateway.deletePath(ctx.client, args))
  );
};
