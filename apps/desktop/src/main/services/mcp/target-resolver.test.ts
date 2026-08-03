import { describe, expect, test } from "vitest";
import type { ConnectionProfile } from "@nextshell/core";
import {
  buildServerSummary,
  ConnectionTargetAmbiguousError,
  ConnectionTargetNotFoundError,
  listServerSummaries,
  resolveConnectionTarget,
  searchServerSummaries
} from "./target-resolver";

const TIMESTAMP = "2026-08-03T00:00:00.000Z";

const createConnection = (
  overrides: Partial<ConnectionProfile> & Pick<ConnectionProfile, "id" | "name" | "host">
): ConnectionProfile => ({
  port: 22,
  username: "root",
  authType: "password",
  strictHostKeyChecking: false,
  terminalEncoding: "utf-8",
  backspaceMode: "ascii-backspace",
  deleteMode: "vt220-delete",
  groupPath: "/server",
  tags: [],
  favorite: false,
  monitorSession: false,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  ...overrides
});

const connections: ConnectionProfile[] = [
  createConnection({
    id: "11111111-1111-1111-1111-111111111111",
    name: "server1",
    host: "10.0.0.1",
    groupPath: "/server/prod",
    tags: ["api", "prod"],
    favorite: true,
    resourceId: "local-default-11111111-1111-1111-1111-111111111111"
  }),
  createConnection({
    id: "22222222-2222-2222-2222-222222222222",
    name: "server1-backup",
    host: "10.0.0.2",
    groupPath: "/server/prod",
    tags: ["backup"],
    resourceId: "local-default-22222222-2222-2222-2222-222222222222"
  }),
  createConnection({
    id: "33333333-3333-3333-3333-333333333333",
    name: "bastion",
    host: "10.0.0.10",
    username: "ubuntu",
    authType: "privateKey",
    groupPath: "/server/infra",
    tags: ["gateway"],
    resourceId: "local-default-33333333-3333-3333-3333-333333333333"
  }),
  createConnection({
    id: "44444444-4444-4444-4444-444444444444",
    name: "shared",
    host: "192.168.1.20",
    username: "ops",
    groupPath: "/server/shared",
    tags: ["team-a"],
    resourceId: "local-default-44444444-4444-4444-4444-444444444444"
  }),
  createConnection({
    id: "55555555-5555-5555-5555-555555555555",
    name: "shared",
    host: "192.168.1.21",
    username: "ops",
    groupPath: "/server/shared",
    tags: ["team-b"],
    resourceId: "local-default-55555555-5555-5555-5555-555555555555"
  })
];

describe("server summaries", () => {
  test("builds a stable nameId and carries no credential fields", () => {
    const summary = buildServerSummary(connections[0]!);

    expect(summary).toEqual({
      nameId: "server1--11111111",
      name: "server1",
      host: "10.0.0.1",
      port: 22,
      groupPath: "/server/prod",
      tags: ["api", "prod"],
      favorite: true
    });
  });

  test("lists every connection once", () => {
    expect(listServerSummaries(connections).map((summary) => summary.name)).toEqual([
      "server1",
      "server1-backup",
      "bastion",
      "shared",
      "shared"
    ]);
  });

  test("searches by tags and group path", () => {
    expect(searchServerSummaries(connections, "infra")).toEqual([
      {
        nameId: "bastion--33333333",
        name: "bastion",
        host: "10.0.0.10",
        port: 22,
        groupPath: "/server/infra",
        tags: ["gateway"],
        favorite: false
      }
    ]);
  });

  test("an empty query falls back to the full list, capped by limit", () => {
    expect(searchServerSummaries(connections, "   ", 2)).toHaveLength(2);
  });
});

describe("connection target resolution", () => {
  test("resolves an exact nameId", () => {
    expect(resolveConnectionTarget(connections, "server1--11111111").connection.id).toBe(
      "11111111-1111-1111-1111-111111111111"
    );
  });

  test("prefers an exact name over a name prefix", () => {
    expect(resolveConnectionTarget(connections, "server1").connection.host).toBe("10.0.0.1");
  });

  test("resolves an exact host", () => {
    expect(resolveConnectionTarget(connections, "10.0.0.10").connection.name).toBe("bastion");
  });

  test("resolves a unique name prefix", () => {
    expect(resolveConnectionTarget(connections, "bast").connection.name).toBe("bastion");
  });

  test("falls back to fuzzy full-text matching", () => {
    expect(resolveConnectionTarget(connections, "team-b").connection.host).toBe("192.168.1.21");
  });

  test("throws ambiguous with candidate summaries when several exact names match", () => {
    let error: unknown;
    try {
      resolveConnectionTarget(connections, "shared");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ConnectionTargetAmbiguousError);
    expect((error as ConnectionTargetAmbiguousError).candidates).toEqual([
      {
        nameId: "shared--44444444",
        name: "shared",
        host: "192.168.1.20",
        port: 22,
        groupPath: "/server/shared",
        tags: ["team-a"],
        favorite: false
      },
      {
        nameId: "shared--55555555",
        name: "shared",
        host: "192.168.1.21",
        port: 22,
        groupPath: "/server/shared",
        tags: ["team-b"],
        favorite: false
      }
    ]);
  });

  test("throws not found when nothing matches", () => {
    expect(() => resolveConnectionTarget(connections, "missing-host")).toThrow(
      ConnectionTargetNotFoundError
    );
  });

  test("throws not found for a blank target", () => {
    expect(() => resolveConnectionTarget(connections, "   ")).toThrow(
      ConnectionTargetNotFoundError
    );
  });
});
