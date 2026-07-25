import { describe, expect, test } from "vitest";
import {
  consumeTerminalQueryReplyChunk,
  createTerminalQueryReplyFilterState,
  installTerminalQueryCompatibilityGuards
} from "./terminalControlSequenceCompat";

const ESC = "\u001b";
const BEL = "\u0007";
const ST = `${ESC}\\`;

describe("terminal control sequence compatibility", () => {
  test("strips concatenated DA/DECRQM/DECRPM query replies before they can be written upstream", () => {
    const state = createTerminalQueryReplyFilterState();
    const chunk = [`${ESC}[>0;276;0c`, `${ESC}[?12;2$y`, `${ESC}P1$r2 q${ST}`].join("");

    const result = consumeTerminalQueryReplyChunk(state, chunk);

    expect(result.text).toBe("");
    expect(result.state.pending).toBe("");
  });

  test("passes OSC color replies through untouched so real answers reach the remote", () => {
    const state = createTerminalQueryReplyFilterState();
    const chunk = [
      `${ESC}]10;rgb:d8d8/eaea/ffff${ST}`,
      `${ESC}]11;rgb:0000/0000/0000${ST}`,
      `${ESC}]12;rgb:ffff/ffff/ffff${BEL}`
    ].join("");

    const result = consumeTerminalQueryReplyChunk(state, chunk);

    expect(result.text).toBe(chunk);
    expect(result.state.pending).toBe("");
  });

  test("keeps ordinary user input untouched", () => {
    const state = createTerminalQueryReplyFilterState();

    const result = consumeTerminalQueryReplyChunk(state, "ls -la\r");

    expect(result.text).toBe("ls -la\r");
    expect(result.state.pending).toBe("");
  });

  test("handles partial query replies across chunks", () => {
    const state = createTerminalQueryReplyFilterState();

    const first = consumeTerminalQueryReplyChunk(state, `${ESC}[>0;27`);
    expect(first.text).toBe("");
    expect(first.state.pending).toBe(`${ESC}[>0;27`);

    const second = consumeTerminalQueryReplyChunk(first.state, "6;0c" + "pwd\r");
    expect(second.text).toBe("pwd\r");
    expect(second.state.pending).toBe("");
  });

  test("does not buffer partial OSC color replies; they flow through as-is", () => {
    const state = createTerminalQueryReplyFilterState();

    const result = consumeTerminalQueryReplyChunk(state, `${ESC}]10;rgb:d8d8/eaea`);

    expect(result.text).toBe(`${ESC}]10;rgb:d8d8/eaea`);
    expect(result.state.pending).toBe("");
  });

  test("registers guards that only suppress query sequences", () => {
    const csiHandlers = new Map<
      string,
      (params: (number | number[])[]) => boolean | Promise<boolean>
    >();
    const oscHandlers = new Map<number, (data: string) => boolean | Promise<boolean>>();
    const dcsHandlers = new Map<
      string,
      (data: string, params: (number | number[])[]) => boolean | Promise<boolean>
    >();
    const suppressed: string[] = [];

    // The fake parser keeps an OSC registration hook so the test can assert
    // the guard never uses it; ParserLike itself no longer mentions OSC.
    const parser = {
      registerCsiHandler(
        id: { prefix?: string; intermediates?: string; final: string },
        callback: (params: (number | number[])[]) => boolean | Promise<boolean>
      ) {
        csiHandlers.set(`${id.prefix ?? ""}|${id.intermediates ?? ""}|${id.final}`, callback);
        return { dispose() {} };
      },
      registerOscHandler(ident: number, callback: (data: string) => boolean | Promise<boolean>) {
        oscHandlers.set(ident, callback);
        return { dispose() {} };
      },
      registerDcsHandler(
        id: { prefix?: string; intermediates?: string; final: string },
        callback: (data: string, params: (number | number[])[]) => boolean | Promise<boolean>
      ) {
        dcsHandlers.set(`${id.prefix ?? ""}|${id.intermediates ?? ""}|${id.final}`, callback);
        return { dispose() {} };
      }
    };

    const disposer = installTerminalQueryCompatibilityGuards(
      { parser },
      {
        isEnabled: () => true,
        onSuppressed: (kind) => suppressed.push(kind)
      }
    );

    const secondaryDa = csiHandlers.get(">||c");
    const modeRequest = csiHandlers.get("|$|p");
    const privateModeRequest = csiHandlers.get("?|$|p");
    const dcsQ = dcsHandlers.get("|$|q");

    expect(secondaryDa?.([])).toBe(true);
    expect(modeRequest?.([12])).toBe(true);
    expect(privateModeRequest?.([12])).toBe(true);
    expect(dcsQ?.(" q", [])).toBe(true);
    // OSC 10/11/12 are answered for real by the osc colors module; the compat
    // shim must no longer register suppression handlers for them.
    expect(oscHandlers.size).toBe(0);
    expect(suppressed).toEqual([
      "device-attributes",
      "ansi-mode-request",
      "private-mode-request",
      "status-string-request"
    ]);

    disposer.dispose();
  });
});
