export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  result?: unknown;
  error?: JsonRpcErrorBody;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isJsonRpcRequest = (value: unknown): value is JsonRpcRequest =>
  isRecord(value) &&
  typeof value.method === "string" &&
  (typeof value.id === "string" || typeof value.id === "number");

export const isJsonRpcNotification = (value: unknown): value is JsonRpcNotification =>
  isRecord(value) && typeof value.method === "string" && value.id === undefined;

export const isJsonRpcResponse = (value: unknown): value is JsonRpcResponse =>
  isRecord(value) &&
  value.method === undefined &&
  (value.result !== undefined || isRecord(value.error));

export const okResponse = (id: JsonRpcId, result: unknown): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  result
});

export const errorResponse = (
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: data === undefined ? { code, message } : { code, message, data }
});

/** Accepts a single message or a JSON-RPC batch; non-object entries are dropped. */
export const parseJsonRpcPayload = (raw: string): JsonRpcMessage[] => {
  const parsed: unknown = JSON.parse(raw);
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  return entries.filter(isRecord) as unknown as JsonRpcMessage[];
};
