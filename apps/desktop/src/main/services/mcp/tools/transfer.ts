import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  outputShape,
  READ_ONLY_ANNOTATIONS,
  targetInputDescription,
  toCallToolResult,
  transferSnapshotSchema,
  WRITE_ANNOTATIONS,
  type AgentToolContext
} from "./shared";

const ASYNC_NOTE =
  "Returns immediately with a taskId; poll transfer_status. The transfer also appears in NextShell's transfer queue with an Agent badge, where the user can watch or cancel it.";

export const registerTransferTools = (server: McpServer, ctx: AgentToolContext): void => {
  server.registerTool(
    "transfer_upload",
    {
      title: "上传到远端",
      description: `Upload a local file or directory to a host. A directory is packed as tar.gz and unpacked remotely, which is far faster than copying files one by one. Local paths are checked against NextShell's local-path policy (credential stores and the app's own data are always refused) and the user confirms the full local path before any bytes leave this machine. ${ASYNC_NOTE}`,
      inputSchema: {
        target: z.string().min(1).describe(targetInputDescription),
        localPath: z
          .string()
          .min(1)
          .describe("Absolute path on the machine running NextShell; `~` is expanded"),
        remotePath: z
          .string()
          .min(1)
          .describe("Absolute remote destination: the file path, or the directory to unpack into")
      },
      outputSchema: outputShape(transferSnapshotSchema),
      annotations: WRITE_ANNOTATIONS
    },
    async (args) => toCallToolResult(await ctx.gateway.uploadTransfer(ctx.client, args))
  );

  server.registerTool(
    "transfer_download",
    {
      title: "下载到本机",
      description: `Download a remote file to the machine running NextShell. The destination is checked against the local-path policy — writing into shell startup files, autostart directories or system paths is refused — and the user confirms the full destination path. ${ASYNC_NOTE}`,
      inputSchema: {
        target: z.string().min(1).describe(targetInputDescription),
        remotePath: z.string().min(1).describe("Absolute remote file path"),
        localPath: z
          .string()
          .min(1)
          .describe("Absolute local destination file path (not a directory); `~` is expanded")
      },
      outputSchema: outputShape(transferSnapshotSchema),
      annotations: WRITE_ANNOTATIONS
    },
    async (args) => toCallToolResult(await ctx.gateway.downloadTransfer(ctx.client, args))
  );

  server.registerTool(
    "transfer_status",
    {
      title: "查询传输进度",
      description:
        "Poll one transfer started by this client. `state` settles on success, failed or cancelled; `cancelled` means the user stopped it from NextShell's transfer queue.",
      inputSchema: { taskId: z.string().min(1) },
      outputSchema: outputShape(transferSnapshotSchema),
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (args) => toCallToolResult(await ctx.gateway.transferStatus(ctx.client, args))
  );

  server.registerTool(
    "transfer_cancel",
    {
      title: "取消传输",
      description:
        "Request cancellation of a transfer started by this client. `cancelRequested: false` means it had already finished.",
      inputSchema: { taskId: z.string().min(1) },
      outputSchema: outputShape(
        z.object({ taskId: z.string(), cancelRequested: z.boolean() })
      ),
      annotations: { ...WRITE_ANNOTATIONS, idempotentHint: true }
    },
    async (args) => toCallToolResult(await ctx.gateway.cancelTransfer(ctx.client, args))
  );
};
