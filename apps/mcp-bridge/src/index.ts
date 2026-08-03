/**
 * stdio ↔ NextShell bridge entry point.
 *
 * Two constraints the implementation must not drop:
 * - this process never holds credentials; it only forwards MCP traffic;
 * - it answers `initialize` / `tools/list` on its own and stays alive when
 *   NextShell is not running, otherwise every client session starts with a
 *   failed-to-connect error (clients dial stdio servers once, at startup).
 */
import { BRIDGE_NAME, BRIDGE_VERSION } from "./constants.js";
import { discoverEndpointTargets, ENDPOINT_ENV_VAR } from "./endpoint.js";
import { errorResponse, JSON_RPC_PARSE_ERROR } from "./json-rpc.js";
import { BridgeServer } from "./server.js";
import { StdioTransport } from "./stdio.js";
import { UpstreamSession } from "./upstream.js";

export { BRIDGE_NAME, BRIDGE_VERSION, ENDPOINT_ENV_VAR };

const log = (message: string): void => {
  process.stderr.write(`[${BRIDGE_NAME}] ${message}\n`);
};

export const startBridge = (): void => {
  // A stray console.log would corrupt the JSON-RPC stream.
  console.log = (...args: unknown[]) => log(args.map((value) => String(value)).join(" "));
  console.info = console.log;
  console.warn = console.log;

  const transport = new StdioTransport({
    input: process.stdin,
    output: process.stdout,
    onMessage: (message) => {
      void server.handleMessage(message).catch((error: unknown) => {
        log(`unhandled dispatch failure: ${String(error)}`);
      });
    },
    onParseError: () => {
      transport.send(errorResponse(null, JSON_RPC_PARSE_ERROR, "Parse error"));
    },
    onClose: () => {
      void shutdown(0);
    }
  });

  const server = new BridgeServer({
    send: (message) => transport.send(message),
    log,
    discover: () => discoverEndpointTargets(),
    openSession: (target, options) => UpstreamSession.open(target, options)
  });

  let shuttingDown = false;
  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await server.close();
    process.exit(code);
  };

  process.stdout.on("error", () => {
    void shutdown(0);
  });
  process.on("SIGINT", () => {
    void shutdown(0);
  });
  process.on("SIGTERM", () => {
    void shutdown(0);
  });
  process.on("uncaughtException", (error) => {
    log(`uncaught exception: ${String(error)}`);
  });
  process.on("unhandledRejection", (reason) => {
    log(`unhandled rejection: ${String(reason)}`);
  });

  transport.start();
  log(`ready (endpoint discovery honours ${ENDPOINT_ENV_VAR})`);
};

startBridge();
