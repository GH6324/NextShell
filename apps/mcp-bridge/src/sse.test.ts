import { describe, expect, it } from "vitest";

import { SseParser } from "./sse.js";

describe("SseParser", () => {
  it("parses a complete frame", () => {
    const parser = new SseParser();
    const messages = parser.push('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n');
    expect(messages).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
  });

  it("keeps state across chunk boundaries that cut a frame apart", () => {
    const parser = new SseParser();
    expect(parser.push("event: mess")).toEqual([]);
    expect(parser.push('age\ndata: {"jsonrpc":"2.0",')).toEqual([]);
    expect(parser.push('"id":7,"result":{"ok":true}}')).toEqual([]);
    expect(parser.push("\n")).toEqual([]);
    expect(parser.push("\n")).toEqual([{ jsonrpc: "2.0", id: 7, result: { ok: true } }]);
  });

  it("handles CRLF line endings, comments and multi-line data", () => {
    const parser = new SseParser();
    const messages = parser.push(
      [
        ": keep-alive",
        "event: message",
        'data: {"jsonrpc":"2.0",',
        'data: "id":2,"result":1}',
        "",
        ""
      ].join("\r\n")
    );
    expect(messages).toEqual([{ jsonrpc: "2.0", id: 2, result: 1 }]);
  });

  it("emits every message of a batched frame and skips foreign events", () => {
    const parser = new SseParser();
    expect(parser.push("event: ping\ndata: {}\n\n")).toEqual([]);
    const messages = parser.push(
      'data: [{"jsonrpc":"2.0","id":1,"result":{}},{"jsonrpc":"2.0","method":"x"}]\n\n'
    );
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({ jsonrpc: "2.0", method: "x" });
  });

  it("drops frames whose data is not JSON instead of throwing", () => {
    const parser = new SseParser();
    expect(parser.push("data: not-json\n\n")).toEqual([]);
    expect(parser.push('data: {"jsonrpc":"2.0","id":3,"result":{}}\n\n')).toEqual([
      { jsonrpc: "2.0", id: 3, result: {} }
    ]);
  });
});
