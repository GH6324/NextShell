import { afterEach, describe, expect, test, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import type { AppPreferences } from "@nextshell/core";
import type { OscRuntimeContext } from "../oscRuntime";
import {
  decodeOsc52Base64,
  encodeOsc52Base64,
  handleOsc52Sequence,
  install,
  OSC52_MAX_DECODED_BYTES,
  parseOsc52Payload
} from "./clipboard";

const createClipboardFake = (readValue = "hello", failWrite = false) => {
  const written: string[] = [];
  return {
    written,
    clipboard: {
      writeText: (text: string): Promise<void> => {
        written.push(text);
        return failWrite ? Promise.reject(new Error("denied")) : Promise.resolve();
      },
      readText: (): Promise<string> => Promise.resolve(readValue)
    }
  };
};

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("parseOsc52Payload", () => {
  test("splits selection and payload", () => {
    expect(parseOsc52Payload("c;aGk=")).toEqual({ selection: "c", payload: "aGk=" });
  });

  test("accepts an empty selection", () => {
    expect(parseOsc52Payload(";aGk=")).toEqual({ selection: "", payload: "aGk=" });
  });

  test("accepts combined selections verbatim", () => {
    expect(parseOsc52Payload("cps;aGk=")).toEqual({ selection: "cps", payload: "aGk=" });
  });

  test("keeps the read marker as payload", () => {
    expect(parseOsc52Payload("c;?")).toEqual({ selection: "c", payload: "?" });
  });

  test("rejects data without a separator", () => {
    expect(parseOsc52Payload("?")).toBeUndefined();
    expect(parseOsc52Payload("")).toBeUndefined();
  });
});

describe("decodeOsc52Base64", () => {
  test("decodes base64 payloads", () => {
    expect(decodeOsc52Base64("aGk=")).toBe("hi");
  });

  test("tolerates whitespace in the payload", () => {
    expect(decodeOsc52Base64("aG k=\n")).toBe("hi");
  });

  test("returns undefined for invalid base64", () => {
    expect(decodeOsc52Base64("aGk$")).toBeUndefined();
    expect(decodeOsc52Base64("A")).toBeUndefined();
  });

  test("round-trips UTF-8 text with the encoder", () => {
    const text = "你好，终端 ✓";
    expect(decodeOsc52Base64(encodeOsc52Base64(text))).toBe(text);
    expect(encodeOsc52Base64("hello")).toBe("aGVsbG8=");
  });
});

describe("handleOsc52Sequence write path", () => {
  test("writes the decoded payload to the clipboard when allowed", () => {
    const { clipboard, written } = createClipboardFake();

    const consumed = handleOsc52Sequence("c;aGk=", {
      allowWrite: true,
      allowRead: false,
      clipboard,
      writeReply: () => undefined
    });

    expect(consumed).toBe(true);
    expect(written).toEqual(["hi"]);
  });

  test("stays silent when writes are disabled (preference off or replaying)", () => {
    const { clipboard, written } = createClipboardFake();

    const consumed = handleOsc52Sequence("c;aGk=", {
      allowWrite: false,
      allowRead: false,
      clipboard,
      writeReply: () => undefined
    });

    expect(consumed).toBe(true);
    expect(written).toEqual([]);
  });

  test("ignores invalid base64 without warning", () => {
    const { clipboard, written } = createClipboardFake();
    const warn = vi.fn();

    const consumed = handleOsc52Sequence("c;not$base64", {
      allowWrite: true,
      allowRead: false,
      clipboard,
      writeReply: () => undefined,
      warn
    });

    expect(consumed).toBe(true);
    expect(written).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  test("drops payloads whose decoded size exceeds the cap", () => {
    const { clipboard, written } = createClipboardFake();
    const warn = vi.fn();
    // Decoded-length math only: this base64 length decodes past the 1MB cap,
    // so the handler rejects it before any large decoded string exists.
    const oversizedPayload = "A".repeat(Math.ceil((OSC52_MAX_DECODED_BYTES + 1) / 3) * 4);

    const consumed = handleOsc52Sequence(`c;${oversizedPayload}`, {
      allowWrite: true,
      allowRead: false,
      clipboard,
      writeReply: () => undefined,
      warn
    });

    expect(consumed).toBe(true);
    expect(written).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });

  test("warns when the clipboard write itself fails", async () => {
    const { clipboard } = createClipboardFake("hello", true);
    const warn = vi.fn();

    handleOsc52Sequence("c;aGk=", {
      allowWrite: true,
      allowRead: false,
      clipboard,
      writeReply: () => undefined,
      warn
    });
    await flushMicrotasks();

    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("handleOsc52Sequence read path", () => {
  test("refuses reads by default without replying", async () => {
    const readText = vi.fn(() => Promise.resolve("hello"));
    const writeReply = vi.fn();

    const consumed = handleOsc52Sequence("c;?", {
      allowWrite: true,
      allowRead: false,
      clipboard: { writeText: () => Promise.resolve(), readText },
      writeReply
    });
    await flushMicrotasks();

    expect(consumed).toBe(true);
    expect(readText).not.toHaveBeenCalled();
    expect(writeReply).not.toHaveBeenCalled();
  });

  test("replies with the base64 clipboard content when reads are enabled", async () => {
    const { clipboard } = createClipboardFake("hello");
    const writeReply = vi.fn();

    const consumed = handleOsc52Sequence("c;?", {
      allowWrite: true,
      allowRead: true,
      clipboard,
      writeReply
    });
    await flushMicrotasks();

    expect(consumed).toBe(true);
    expect(writeReply).toHaveBeenCalledWith("\x1b]52;c;aGVsbG8=\x07");
  });

  test("keeps the requested selection and defaults an empty one to c", async () => {
    const { clipboard } = createClipboardFake("hi");
    const writeReply = vi.fn();

    handleOsc52Sequence("s;?", {
      allowWrite: true,
      allowRead: true,
      clipboard,
      writeReply
    });
    await flushMicrotasks();
    expect(writeReply).toHaveBeenCalledWith("\x1b]52;s;aGk=\x07");

    writeReply.mockClear();
    handleOsc52Sequence(";?", {
      allowWrite: true,
      allowRead: true,
      clipboard,
      writeReply
    });
    await flushMicrotasks();
    expect(writeReply).toHaveBeenCalledWith("\x1b]52;c;aGk=\x07");
  });

  test("does not reply when reading the clipboard fails", async () => {
    const writeReply = vi.fn();

    handleOsc52Sequence("c;?", {
      allowWrite: true,
      allowRead: true,
      clipboard: {
        writeText: () => Promise.resolve(),
        readText: () => Promise.reject(new Error("denied"))
      },
      writeReply
    });
    await flushMicrotasks();

    expect(writeReply).not.toHaveBeenCalled();
  });
});

const createInstallHarness = (initialSessionId: string | undefined) => {
  const handlers = new Map<number, (data: string) => boolean>();
  const terminal = {
    parser: {
      registerOscHandler(ident: number, callback: (data: string) => boolean) {
        handlers.set(ident, callback);
        return { dispose: () => handlers.delete(ident) };
      }
    }
  } as unknown as Terminal;

  const parser = { sessionId: initialSessionId };
  const replies: { sessionId: string; data: string }[] = [];
  const ctx = {
    getSessionId: () => parser.sessionId,
    isReplaying: () => false,
    getTerminalPreferences: () =>
      ({ oscClipboardWrite: true, oscClipboardRead: true }) as AppPreferences["terminal"],
    // Resolving the target late is exactly the bug under test: route it to a
    // distinguishable id so a regression is visible instead of coincidental.
    writeToRemote: (data: string) => replies.push({ sessionId: "<late>", data }),
    writeToRemoteAs: (sessionId: string, data: string) => replies.push({ sessionId, data }),
    registerKeyHandler: () => () => undefined,
    onReplayStart: () => () => undefined
  } satisfies OscRuntimeContext;

  const dispose = install(terminal, ctx);
  return { handlers, parser, replies, dispose };
};

describe("install (OSC 52 session attribution)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("sends the read reply to the session that asked, not the one in front later", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        readText: () => Promise.resolve("hi"),
        writeText: () => Promise.resolve()
      }
    });
    const { handlers, parser, replies, dispose } = createInstallHarness("a");

    expect(handlers.get(52)?.("c;?")).toBe(true);
    // The user switches tabs while the clipboard promise is still pending.
    parser.sessionId = "b";
    await flushMicrotasks();

    expect(replies).toEqual([{ sessionId: "a", data: "\x1b]52;c;aGk=\x07" }]);
    dispose();
  });

  test("drops the reply when no session owned the request", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        readText: () => Promise.resolve("hi"),
        writeText: () => Promise.resolve()
      }
    });
    const { handlers, parser, replies, dispose } = createInstallHarness(undefined);

    expect(handlers.get(52)?.("c;?")).toBe(true);
    parser.sessionId = "b";
    await flushMicrotasks();

    expect(replies).toEqual([]);
    dispose();
  });
});
