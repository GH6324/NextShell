import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { AgentGateway, AgentToolResult, AgentClientIdentity } from "../agent-gateway";

export interface AgentToolContext {
  gateway: AgentGateway;
  client: AgentClientIdentity;
}

export const serverSummarySchema = z.object({
  nameId: z.string(),
  name: z.string(),
  host: z.string(),
  port: z.number(),
  groupPath: z.string(),
  tags: z.array(z.string()),
  favorite: z.boolean()
});

export const agentErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  candidates: z.array(serverSummarySchema).optional()
});

/**
 * Uniform envelope so an agent can branch on `ok` without knowing which failure
 * mode (`not_found` / `ambiguous` / `forbidden` / …) a given tool can produce.
 */
export const outputShape = <T extends z.ZodTypeAny>(data: T) => ({
  ok: z.boolean(),
  data: data.optional(),
  error: agentErrorSchema.optional()
});

export const targetInputDescription =
  "Target to act on: nameId, connectionId, connection name, hostname/IP, unique prefix, or (where documented) a live session id. Ambiguous values come back with candidates instead of a guess.";

export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
} as const;

/** Mutating but recoverable: creating a directory, writing a file, renaming. */
export const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true
} as const;

/** Data loss on the far side; clients are expected to escalate confirmation. */
export const DESTRUCTIVE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true
} as const;

export const transferSnapshotSchema = z.object({
  taskId: z.string(),
  direction: z.enum(["upload", "download"]),
  connectionId: z.string(),
  localPath: z.string(),
  remotePath: z.string(),
  packed: z.boolean(),
  state: z.enum(["running", "success", "failed", "cancelled"]),
  progress: z.number(),
  transferredBytes: z.number(),
  totalBytes: z.number().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable()
});

export const toCallToolResult = <T>(result: AgentToolResult<T>): CallToolResult => {
  if (result.ok) {
    const payload = { ok: true, data: result.data };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload as Record<string, unknown>
    };
  }
  const payload = { ok: false, error: result.error };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload as unknown as Record<string, unknown>,
    isError: true
  };
};

export const hostInfoSchema = z.object({
  nameId: z.string(),
  name: z.string(),
  host: z.string(),
  port: z.number(),
  user: z.string(),
  groupPath: z.string(),
  tags: z.array(z.string()),
  favorite: z.boolean(),
  access: z.enum(["readonly", "full"]),
  connected: z.boolean(),
  activeSessions: z.number(),
  lastConnectedAt: z.string().nullable()
});

export const sessionInfoSchema = z.object({
  id: z.string(),
  connectionId: z.string().nullable(),
  title: z.string(),
  status: z.string(),
  type: z.string(),
  createdAt: z.string(),
  cwd: z.string().nullable(),
  lastCommand: z.string().nullable()
});

export const fileEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(["file", "directory", "link"]),
  size: z.number(),
  permissions: z.string(),
  owner: z.string(),
  group: z.string(),
  modifiedAt: z.string()
});

export const fileStatSchema = z.object({
  path: z.string(),
  type: z.enum(["file", "directory", "link", "other"]),
  size: z.number(),
  permissions: z.string(),
  uid: z.number(),
  gid: z.number(),
  modifiedAt: z.string(),
  accessedAt: z.string()
});

export const monitorProcessSchema = z.object({
  pid: z.number(),
  ppid: z.number(),
  command: z.string(),
  cpuPercent: z.number(),
  memoryPercent: z.number(),
  memoryMb: z.number(),
  user: z.string()
});

export const monitorSnapshotSchema = z.object({
  connectionId: z.string(),
  loadAverage: z.array(z.number()),
  cpuPercent: z.number(),
  memoryPercent: z.number(),
  memoryUsedMb: z.number(),
  memoryTotalMb: z.number(),
  swapPercent: z.number(),
  swapUsedMb: z.number(),
  swapTotalMb: z.number(),
  diskPercent: z.number(),
  diskUsedGb: z.number(),
  diskTotalGb: z.number(),
  networkInMbps: z.number(),
  networkOutMbps: z.number(),
  networkInterface: z.string(),
  networkInterfaceOptions: z.array(z.string()),
  processes: z.array(monitorProcessSchema),
  capturedAt: z.string()
});
