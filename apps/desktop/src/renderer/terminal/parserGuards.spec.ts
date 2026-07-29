import { describe, expect, test, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { installParserHandlerGuards } from "./parserGuards";

type AnyHandler = (...args: unknown[]) => boolean | Promise<boolean>;

const createMockParserTerminal = () => {
  const handlers = new Map<string, AnyHandler>();
  const disposed: string[] = [];

  const register =
    (kind: string) =>
    (ident: unknown, callback: AnyHandler): { dispose: () => void } => {
      const key = `${kind}:${JSON.stringify(ident)}`;
      handlers.set(key, callback);
      return {
        dispose: () => {
          handlers.delete(key);
          disposed.push(key);
        }
      };
    };

  const terminal = {
    parser: {
      registerCsiHandler: register("csi"),
      registerDcsHandler: register("dcs"),
      registerEscHandler: register("esc"),
      registerOscHandler: register("osc")
    }
  } as unknown as Terminal;

  return { terminal, handlers, disposed };
};

describe("installParserHandlerGuards", () => {
  test("a synchronously throwing handler is contained and reported as handled", () => {
    const { terminal, handlers } = createMockParserTerminal();
    installParserHandlerGuards(terminal);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    terminal.parser.registerOscHandler(133, () => {
      throw new Error("handler bug");
    });

    const handler = handlers.get("osc:133");
    expect(handler).toBeDefined();
    // Without the guard this throw would unwind xterm's write loop and freeze
    // the terminal permanently; the guard must swallow it and consume the
    // sequence instead.
    expect(handler!("A")).toBe(true);
    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  test("non-throwing handlers keep their return value and disposal", () => {
    const { terminal, handlers, disposed } = createMockParserTerminal();
    installParserHandlerGuards(terminal);

    const seen: string[] = [];
    const registration = terminal.parser.registerOscHandler(7, (data: string) => {
      seen.push(data);
      return false;
    });

    const handler = handlers.get("osc:7");
    expect(handler!("file:///tmp")).toBe(false);
    expect(seen).toEqual(["file:///tmp"]);

    registration.dispose();
    expect(disposed).toEqual(["osc:7"]);
    expect(handlers.has("osc:7")).toBe(false);
  });

  test("async handler results pass through untouched", async () => {
    const { terminal, handlers } = createMockParserTerminal();
    installParserHandlerGuards(terminal);

    terminal.parser.registerDcsHandler({ final: "q" }, () => Promise.resolve(true));
    const handler = handlers.get('dcs:{"final":"q"}');
    await expect(handler!("payload", [])).resolves.toBe(true);
  });

  test("every registration method is guarded", () => {
    const { terminal, handlers } = createMockParserTerminal();
    installParserHandlerGuards(terminal);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const boom = () => {
      throw new Error("boom");
    };
    terminal.parser.registerCsiHandler({ final: "c" }, boom);
    terminal.parser.registerDcsHandler({ final: "q" }, boom);
    terminal.parser.registerEscHandler({ final: "E" }, boom);
    terminal.parser.registerOscHandler(9, boom);

    for (const key of handlers.keys()) {
      expect(handlers.get(key)!()).toBe(true);
    }
    expect(consoleError).toHaveBeenCalledTimes(4);
    consoleError.mockRestore();
  });
});
