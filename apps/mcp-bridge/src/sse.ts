import { isRecord, type JsonRpcMessage } from "./json-rpc.js";

/**
 * Incremental `text/event-stream` reader. Chunk boundaries are arbitrary, so
 * every piece of state (partial line, pending `data:` lines, event name) has to
 * survive across `push` calls.
 */
export class SseParser {
  private buffer = "";
  private dataLines: string[] = [];
  private eventName: string | null = null;

  push(chunk: string): JsonRpcMessage[] {
    this.buffer += chunk;
    const messages: JsonRpcMessage[] = [];

    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      this.handleLine(line, messages);
      newlineIndex = this.buffer.indexOf("\n");
    }

    return messages;
  }

  private handleLine(line: string, sink: JsonRpcMessage[]): void {
    if (line === "") {
      this.dispatch(sink);
      return;
    }
    if (line.startsWith(":")) {
      return;
    }

    const colonIndex = line.indexOf(":");
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
    let value = colonIndex === -1 ? "" : line.slice(colonIndex + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    if (field === "event") {
      this.eventName = value;
      return;
    }
    if (field === "data") {
      this.dataLines.push(value);
    }
  }

  private dispatch(sink: JsonRpcMessage[]): void {
    const payload = this.dataLines.join("\n");
    const eventName = this.eventName;
    this.dataLines = [];
    this.eventName = null;

    if (payload === "") {
      return;
    }
    if (eventName !== null && eventName !== "message") {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }

    const entries = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of entries) {
      if (isRecord(entry)) {
        sink.push(entry as unknown as JsonRpcMessage);
      }
    }
  }
}
