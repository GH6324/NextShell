import { StringDecoder } from "node:string_decoder";

import type { JsonRpcMessage } from "./json-rpc.js";

export interface StdioTransportOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  onMessage: (message: unknown) => void;
  onParseError?: (line: string, error: unknown) => void;
  onClose?: () => void;
}

/**
 * Newline-delimited JSON-RPC over stdio. Nothing but protocol messages may ever
 * reach `output`; diagnostics belong on stderr.
 */
export class StdioTransport {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";

  constructor(private readonly options: StdioTransportOptions) {}

  start(): void {
    this.options.input.on("data", (chunk: Buffer | string) => {
      this.append(typeof chunk === "string" ? chunk : this.decoder.write(chunk));
    });
    this.options.input.on("end", () => {
      this.options.onClose?.();
    });
    this.options.input.on("close", () => {
      this.options.onClose?.();
    });
  }

  send(message: JsonRpcMessage): void {
    this.options.output.write(`${JSON.stringify(message)}\n`);
  }

  private append(chunk: string): void {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.consume(line);
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  private consume(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.options.onParseError?.(line, error);
      return;
    }
    this.options.onMessage(parsed);
  }
}
