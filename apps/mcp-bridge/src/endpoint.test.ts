import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  discoverEndpointTargets,
  parseEndpointRecords,
  readEndpointRecords,
  resolveUserDataDirs,
  selectEndpointTargets,
  type EndpointDiscoveryDeps,
  type EndpointRecord
} from "./endpoint.js";

const tempDirs: string[] = [];

const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nsbridge-"));
  tempDirs.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const record = (overrides: Partial<EndpointRecord> = {}): EndpointRecord => ({
  socketPath: "/tmp/nextshell.sock",
  host: "127.0.0.1",
  tcpPort: null,
  token: null,
  httpPath: "/mcp",
  pid: 4242,
  updatedAt: 1000,
  source: "test",
  ...overrides
});

describe("resolveUserDataDirs", () => {
  it("uses the platform application data directory", () => {
    expect(resolveUserDataDirs({ platform: "darwin", env: { HOME: "/Users/tester" } })).toContain(
      "/Users/tester/Library/Application Support/NextShell"
    );
    expect(resolveUserDataDirs({ platform: "linux", env: { HOME: "/home/tester" } })).toContain(
      "/home/tester/.config/NextShell"
    );
    expect(resolveUserDataDirs({ platform: "linux", env: { XDG_CONFIG_HOME: "/xdg" } })).toContain(
      "/xdg/NextShell"
    );
    expect(
      resolveUserDataDirs({ platform: "win32", env: { APPDATA: "C:\\Users\\t\\AppData\\Roaming" } })
    ).toContain("C:\\Users\\t\\AppData\\Roaming\\NextShell");
  });
});

describe("parseEndpointRecords", () => {
  it("accepts a single object and a list of instances", () => {
    const single = parseEndpointRecords(
      { socketPath: "/tmp/a.sock", pid: 1, updatedAt: "2026-08-03T00:00:00.000Z" },
      "file"
    );
    expect(single).toHaveLength(1);
    expect(single[0]?.socketPath).toBe("/tmp/a.sock");
    expect(single[0]?.updatedAt).toBe(Date.parse("2026-08-03T00:00:00.000Z"));

    const many = parseEndpointRecords(
      { endpoints: [{ socketPath: "/tmp/a.sock" }, { tcpPort: 7000, token: "t" }] },
      "file"
    );
    expect(many).toHaveLength(2);
    expect(many[1]?.tcpPort).toBe(7000);
    expect(many[1]?.httpPath).toBe("/mcp");
  });

  it("drops entries that describe no listener at all", () => {
    expect(parseEndpointRecords({ pid: 5 }, "file")).toEqual([]);
    expect(parseEndpointRecords("nonsense", "file")).toEqual([]);
  });
});

describe("selectEndpointTargets", () => {
  it("discards records whose process is gone and prefers the newest survivor", () => {
    const deps: EndpointDiscoveryDeps = {
      isProcessAlive: (pid) => pid === 200,
      fileExists: () => true
    };
    const targets = selectEndpointTargets(
      [
        record({ pid: 100, socketPath: "/tmp/dead.sock", updatedAt: 9000 }),
        record({ pid: 200, socketPath: "/tmp/old.sock", updatedAt: 1000 }),
        record({ pid: 200, socketPath: "/tmp/new.sock", updatedAt: 5000 })
      ],
      deps
    );
    expect(targets.map((target) => target.socketPath)).toEqual(["/tmp/new.sock", "/tmp/old.sock"]);
  });

  it("skips a socket whose file no longer exists but keeps the TCP fallback", () => {
    const targets = selectEndpointTargets(
      [record({ pid: null, socketPath: "/tmp/missing.sock", tcpPort: 7100, token: "secret" })],
      { fileExists: () => false }
    );
    expect(targets).toHaveLength(1);
    expect(targets[0]?.transport).toBe("tcp");
    expect(targets[0]?.port).toBe(7100);
    expect(targets[0]?.token).toBe("secret");
  });

  it("never attaches a token to a socket target", () => {
    const targets = selectEndpointTargets([record({ pid: null, token: "secret" })], {
      fileExists: () => true
    });
    expect(targets[0]?.transport).toBe("socket");
    expect(targets[0]?.token).toBeNull();
  });
});

describe("discoverEndpointTargets", () => {
  it("reads endpoint.json from the real user data directory layout", () => {
    const home = makeTempDir();
    const dir = path.join(home, "Library", "Application Support", "NextShell", "mcp");
    fs.mkdirSync(dir, { recursive: true });
    const socketPath = path.join(home, "live.sock");
    fs.writeFileSync(socketPath, "");
    fs.writeFileSync(
      path.join(dir, "endpoint.json"),
      JSON.stringify({ pid: process.pid, socketPath, updatedAt: Date.now() })
    );

    const targets = discoverEndpointTargets({
      platform: "darwin",
      env: { HOME: home }
    });
    expect(targets).toHaveLength(1);
    expect(targets[0]?.socketPath).toBe(socketPath);
  });

  it("resolves a TCP-only endpoint written with the desktop app's field names", () => {
    const home = makeTempDir();
    const dir = path.join(home, ".config", "NextShell", "mcp");
    fs.mkdirSync(dir, { recursive: true });
    // Byte-for-byte the shape of EndpointDiscoveryRecord in
    // apps/desktop/src/main/services/mcp/discovery.ts: the port key is
    // `httpPort`, and a socket-disabled run writes `socketPath: null`.
    fs.writeFileSync(
      path.join(dir, "endpoint.json"),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        socketPath: null,
        httpPort: 7412,
        token: "loopback-token",
        appVersion: "0.1.6",
        startedAt: new Date().toISOString()
      })
    );

    const targets = discoverEndpointTargets({ platform: "linux", env: { HOME: home } });
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ transport: "tcp", port: 7412, token: "loopback-token" });
  });

  it("eliminates a stale endpoint file left behind by a crashed app", () => {
    const home = makeTempDir();
    const dir = path.join(home, ".config", "NextShell", "mcp");
    fs.mkdirSync(dir, { recursive: true });
    const socketPath = path.join(home, "stale.sock");
    fs.writeFileSync(socketPath, "");
    fs.writeFileSync(
      path.join(dir, "endpoint.json"),
      JSON.stringify({ pid: 999999, socketPath, tcpPort: 7000, updatedAt: Date.now() })
    );

    const targets = discoverEndpointTargets({
      platform: "linux",
      env: { HOME: home },
      isProcessAlive: (pid) => pid !== 999999
    });
    expect(targets).toEqual([]);
  });

  it("collects per-instance endpoint files from the same directory", () => {
    const home = makeTempDir();
    const dir = path.join(home, ".config", "NextShell", "mcp");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "endpoint-2.json"),
      JSON.stringify({ pid: process.pid, tcpPort: 7300, token: "abc", updatedAt: 2 })
    );
    fs.writeFileSync(path.join(dir, "unrelated.json"), "{}");

    const records = readEndpointRecords({ platform: "linux", env: { HOME: home } });
    expect(records).toHaveLength(1);
    expect(records[0]?.tcpPort).toBe(7300);
  });

  it("honours the environment override for socket paths, URLs and files", () => {
    const socketTargets = discoverEndpointTargets({
      env: { NEXTSHELL_MCP_ENDPOINT: "/tmp/override.sock" }
    });
    expect(socketTargets[0]).toMatchObject({
      transport: "socket",
      socketPath: "/tmp/override.sock"
    });

    const tcpTargets = discoverEndpointTargets({
      env: {
        NEXTSHELL_MCP_ENDPOINT: "http://127.0.0.1:7788/mcp",
        NEXTSHELL_MCP_TOKEN: "bearer-token"
      }
    });
    expect(tcpTargets[0]).toMatchObject({
      transport: "tcp",
      host: "127.0.0.1",
      port: 7788,
      httpPath: "/mcp",
      token: "bearer-token"
    });

    const dir = makeTempDir();
    const file = path.join(dir, "endpoint.json");
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, tcpPort: 7900 }));
    const fileTargets = discoverEndpointTargets({ env: { NEXTSHELL_MCP_ENDPOINT: file } });
    expect(fileTargets[0]).toMatchObject({ transport: "tcp", port: 7900 });
  });

  it("ignores an override pointing at an unreadable file", () => {
    expect(
      discoverEndpointTargets({ env: { NEXTSHELL_MCP_ENDPOINT: "/nope/missing-endpoint.json" } })
    ).toEqual([]);
  });
});
