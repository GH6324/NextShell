import { describe, expect, test } from "vitest";
import { readLastSftpPath, writeLastSftpPath } from "./sftpLastPath";

const memoryStorage = (initial?: Record<string, string>) => {
  const data = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    }
  };
};

describe("sftpLastPath", () => {
  test("round-trips the last path per connection", () => {
    const storage = memoryStorage();
    writeLastSftpPath("conn-a", "/var/www", storage);
    writeLastSftpPath("conn-b", "/etc", storage);
    expect(readLastSftpPath("conn-a", storage)).toBe("/var/www");
    expect(readLastSftpPath("conn-b", storage)).toBe("/etc");
    expect(readLastSftpPath("conn-c", storage)).toBeUndefined();
  });

  test("ignores relative paths and survives corrupted storage", () => {
    const storage = memoryStorage({ "nextshell.sftp.last-paths": "not-json{{" });
    expect(readLastSftpPath("conn-a", storage)).toBeUndefined();
    writeLastSftpPath("conn-a", "relative/path", storage);
    expect(readLastSftpPath("conn-a", storage)).toBeUndefined();
    writeLastSftpPath("conn-a", "/home/user", storage);
    expect(readLastSftpPath("conn-a", storage)).toBe("/home/user");
  });

  test("evicts the least recently written entries beyond the cap", () => {
    const storage = memoryStorage();
    for (let i = 0; i < 205; i++) {
      writeLastSftpPath(`conn-${i}`, `/dir/${i}`, storage);
    }
    // 最早写入的被裁掉，最近写入的保留。
    expect(readLastSftpPath("conn-0", storage)).toBeUndefined();
    expect(readLastSftpPath("conn-204", storage)).toBe("/dir/204");
    // 重写旧连接会刷新它的“新鲜度”。
    writeLastSftpPath("conn-5", "/dir/5-again", storage);
    expect(readLastSftpPath("conn-5", storage)).toBe("/dir/5-again");
  });

  test("is a no-op without storage", () => {
    expect(readLastSftpPath("conn-a", undefined)).toBeUndefined();
    expect(() => writeLastSftpPath("conn-a", "/x", undefined)).not.toThrow();
  });
});
