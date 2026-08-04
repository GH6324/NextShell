import { beforeEach, describe, expect, test } from "vitest";
import type { RemoteFileEntry } from "@nextshell/core";
import {
  EXPLORER_STATE_CACHE_CAPACITY,
  clearExplorerCache,
  deleteExplorerCache,
  explorerCacheKeys,
  readExplorerCache,
  writeExplorerCache,
  type ExplorerCacheInput
} from "./explorerStateCache";

const entry = (name: string): RemoteFileEntry => ({
  name,
  path: `/var/${name}`,
  type: "file",
  size: 1,
  permissions: "rw-r--r--",
  owner: "root",
  group: "root",
  modifiedAt: "2026-08-04T00:00:00.000Z"
});

const snapshot = (path: string, fileName: string): ExplorerCacheInput => ({
  pathName: path,
  files: [entry(fileName)],
  treeData: [{ key: "/", title: "/", isLeaf: false, children: [] }],
  expandedKeys: ["/"],
  pathHistory: ["/", path],
  historyIndex: 1
});

describe("explorer state cache", () => {
  beforeEach(() => {
    clearExplorerCache();
  });

  test("returns undefined on a miss and the stored snapshot on a hit", () => {
    expect(readExplorerCache("conn-1")).toBeUndefined();

    writeExplorerCache("conn-1", snapshot("/var/log", "syslog"), 1_700_000_000_000);
    const hit = readExplorerCache("conn-1");

    expect(hit?.pathName).toBe("/var/log");
    expect(hit?.files.map((file) => file.name)).toEqual(["syslog"]);
    expect(hit?.expandedKeys).toEqual(["/"]);
    expect(hit?.pathHistory).toEqual(["/", "/var/log"]);
    expect(hit?.historyIndex).toBe(1);
    // fetchedAt 只做信息记录，不参与过期判断。
    expect(hit?.fetchedAt).toBe(1_700_000_000_000);
  });

  test("overwrites an existing connection in place instead of duplicating it", () => {
    writeExplorerCache("conn-1", snapshot("/var/log", "syslog"));
    writeExplorerCache("conn-1", snapshot("/etc", "hosts"));

    expect(explorerCacheKeys()).toEqual(["conn-1"]);
    expect(readExplorerCache("conn-1")?.pathName).toBe("/etc");
    expect(readExplorerCache("conn-1")?.files.map((file) => file.name)).toEqual(["hosts"]);
  });

  test("evicts the least recently used connection past capacity", () => {
    for (let i = 0; i < EXPLORER_STATE_CACHE_CAPACITY; i++) {
      writeExplorerCache(`conn-${i}`, snapshot(`/p${i}`, `f${i}`));
    }
    expect(explorerCacheKeys()).toHaveLength(EXPLORER_STATE_CACHE_CAPACITY);

    writeExplorerCache("conn-new", snapshot("/new", "new"));

    expect(explorerCacheKeys()).toHaveLength(EXPLORER_STATE_CACHE_CAPACITY);
    expect(readExplorerCache("conn-0")).toBeUndefined();
    expect(readExplorerCache("conn-1")?.pathName).toBe("/p1");
    expect(readExplorerCache("conn-new")?.pathName).toBe("/new");
  });

  test("a read refreshes recency so the next eviction drops someone else", () => {
    for (let i = 0; i < EXPLORER_STATE_CACHE_CAPACITY; i++) {
      writeExplorerCache(`conn-${i}`, snapshot(`/p${i}`, `f${i}`));
    }

    // conn-0 是最久未使用的，读一次把它顶到最新。
    expect(readExplorerCache("conn-0")?.pathName).toBe("/p0");
    writeExplorerCache("conn-new", snapshot("/new", "new"));

    expect(readExplorerCache("conn-0")?.pathName).toBe("/p0");
    expect(readExplorerCache("conn-1")).toBeUndefined();
    expect(explorerCacheKeys()).toHaveLength(EXPLORER_STATE_CACHE_CAPACITY);
  });

  test("a write refreshes recency as well", () => {
    for (let i = 0; i < EXPLORER_STATE_CACHE_CAPACITY; i++) {
      writeExplorerCache(`conn-${i}`, snapshot(`/p${i}`, `f${i}`));
    }

    writeExplorerCache("conn-0", snapshot("/p0-updated", "f0"));
    writeExplorerCache("conn-new", snapshot("/new", "new"));

    expect(readExplorerCache("conn-0")?.pathName).toBe("/p0-updated");
    expect(readExplorerCache("conn-1")).toBeUndefined();
  });

  test("delete drops one connection and clear drops everything", () => {
    writeExplorerCache("conn-1", snapshot("/a", "a"));
    writeExplorerCache("conn-2", snapshot("/b", "b"));

    deleteExplorerCache("conn-1");
    expect(readExplorerCache("conn-1")).toBeUndefined();
    expect(readExplorerCache("conn-2")?.pathName).toBe("/b");
    // 删不存在的连接是安全的空操作。
    deleteExplorerCache("conn-missing");
    expect(explorerCacheKeys()).toEqual(["conn-2"]);

    clearExplorerCache();
    expect(explorerCacheKeys()).toEqual([]);
    expect(readExplorerCache("conn-2")).toBeUndefined();
  });

  test("keeps LRU order oldest first for inspection", () => {
    writeExplorerCache("conn-1", snapshot("/a", "a"));
    writeExplorerCache("conn-2", snapshot("/b", "b"));
    writeExplorerCache("conn-3", snapshot("/c", "c"));

    expect(explorerCacheKeys()).toEqual(["conn-1", "conn-2", "conn-3"]);
    readExplorerCache("conn-1");
    expect(explorerCacheKeys()).toEqual(["conn-2", "conn-3", "conn-1"]);
  });
});
