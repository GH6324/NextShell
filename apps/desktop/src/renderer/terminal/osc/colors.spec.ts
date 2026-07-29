import { describe, expect, test } from "vitest";
import type { Terminal } from "@xterm/xterm";
import type { AppPreferences } from "@nextshell/core";
import type { OscRuntimeContext } from "../oscRuntime";
import { buildOscColorReply, hexToOscRgb, install, type OscColorCode } from "./colors";

const ESC = "\u001b";
const BEL = "\u0007";

const createPrefs = (foregroundColor = "#d8eaff", backgroundColor = "#000000") =>
  ({ foregroundColor, backgroundColor }) as AppPreferences["terminal"];

const createHarness = (options?: { replaying?: boolean; prefs?: AppPreferences["terminal"] }) => {
  const handlers = new Map<number, (data: string) => boolean>();
  const writes: string[] = [];
  const terminal = {
    parser: {
      registerOscHandler(ident: number, callback: (data: string) => boolean) {
        handlers.set(ident, callback);
        return { dispose: () => handlers.delete(ident) };
      }
    }
  } as unknown as Terminal;
  const ctx = {
    getSessionId: () => "s1",
    isReplaying: () => options?.replaying ?? false,
    getTerminalPreferences: () => options?.prefs ?? createPrefs(),
    writeToRemote: (data: string) => writes.push(data),
    writeToRemoteAs: (_sessionId: string, data: string) => writes.push(data),
    registerKeyHandler: () => () => undefined,
    onReplayStart: () => () => undefined
  } satisfies OscRuntimeContext;

  const dispose = install(terminal, ctx);
  return { handlers, writes, dispose };
};

describe("hexToOscRgb", () => {
  test("duplicates each byte of #rrggbb into 16-bit channels", () => {
    expect(hexToOscRgb("#d8eaff")).toBe("d8d8/eaea/ffff");
    expect(hexToOscRgb("#000000")).toBe("0000/0000/0000");
    expect(hexToOscRgb("A1b2C3")).toBe("a1a1/b2b2/c3c3");
  });

  test("expands #rgb shorthand by duplicating nibbles", () => {
    expect(hexToOscRgb("#abc")).toBe("aaaa/bbbb/cccc");
    expect(hexToOscRgb("#fff")).toBe("ffff/ffff/ffff");
  });

  test("rejects invalid hex values", () => {
    expect(hexToOscRgb("")).toBeUndefined();
    expect(hexToOscRgb("#12")).toBeUndefined();
    expect(hexToOscRgb("#1234")).toBeUndefined();
    expect(hexToOscRgb("#12345g")).toBeUndefined();
    expect(hexToOscRgb("rgb(1,2,3)")).toBeUndefined();
  });
});

describe("buildOscColorReply", () => {
  test("answers 10 with the foreground color and 11 with the background color", () => {
    const prefs = createPrefs("#d8eaff", "#101020");
    expect(buildOscColorReply(10, prefs)).toBe(`${ESC}]10;rgb:d8d8/eaea/ffff${BEL}`);
    expect(buildOscColorReply(11, prefs)).toBe(`${ESC}]11;rgb:1010/1010/2020${BEL}`);
  });

  test("answers 12 (cursor) with the foreground color", () => {
    expect(buildOscColorReply(12, createPrefs("#00ff00", "#000000"))).toBe(
      `${ESC}]12;rgb:0000/ffff/0000${BEL}`
    );
  });

  test("returns undefined for unusable theme colors", () => {
    expect(buildOscColorReply(10, createPrefs("not-a-color", "#000000"))).toBeUndefined();
    expect(buildOscColorReply(11, createPrefs("#d8eaff", ""))).toBeUndefined();
  });
});

describe("colors OSC module", () => {
  test("replies to queries for all three codes with the current theme", () => {
    const { handlers, writes, dispose } = createHarness();

    for (const code of [10, 11, 12] as OscColorCode[]) {
      expect(handlers.get(code)?.("?")).toBe(true);
    }

    expect(writes).toEqual([
      `${ESC}]10;rgb:d8d8/eaea/ffff${BEL}`,
      `${ESC}]11;rgb:0000/0000/0000${BEL}`,
      `${ESC}]12;rgb:d8d8/eaea/ffff${BEL}`
    ]);
    dispose();
  });

  test("treats a query mixed into extra segments as a query", () => {
    const { handlers, writes, dispose } = createHarness();

    expect(handlers.get(10)?.("rgb:0000/0000/0000;?")).toBe(true);
    expect(writes).toEqual([`${ESC}]10;rgb:d8d8/eaea/ffff${BEL}`]);
    dispose();
  });

  test("consumes non-query SET payloads silently", () => {
    const { handlers, writes, dispose } = createHarness();

    expect(handlers.get(10)?.("rgb:ffff/0000/0000")).toBe(true);
    expect(handlers.get(11)?.("#112233")).toBe(true);
    expect(writes).toEqual([]);
    dispose();
  });

  test("stays silent while replaying a session buffer", () => {
    const { handlers, writes, dispose } = createHarness({ replaying: true });

    expect(handlers.get(10)?.("?")).toBe(true);
    expect(writes).toEqual([]);
    dispose();
  });

  test("does not reply when the theme color is not a hex value", () => {
    const { handlers, writes, dispose } = createHarness({
      prefs: createPrefs("bogus", "#000000")
    });

    expect(handlers.get(12)?.("?")).toBe(true);
    expect(writes).toEqual([]);
    dispose();
  });
});
