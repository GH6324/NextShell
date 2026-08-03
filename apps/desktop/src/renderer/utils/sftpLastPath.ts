/**
 * 每个连接最后浏览的 SFTP 目录，存 localStorage 而非 ConnectionProfile：
 * 连接档案会云同步，这类易变的 UI 状态不应跟着同步到别的设备。
 */

const STORAGE_KEY = "nextshell.sftp.last-paths";
const MAX_ENTRIES = 200;

type LastPathMap = Record<string, string>;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

const defaultStorage = (): StorageLike | undefined =>
  typeof localStorage === "undefined" ? undefined : localStorage;

const readMap = (storage: StorageLike): LastPathMap => {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const map: LastPathMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.startsWith("/")) {
        map[key] = value;
      }
    }
    return map;
  } catch {
    return {};
  }
};

export const readLastSftpPath = (
  connectionId: string,
  storage: StorageLike | undefined = defaultStorage()
): string | undefined => {
  if (!storage) return undefined;
  return readMap(storage)[connectionId];
};

export const writeLastSftpPath = (
  connectionId: string,
  path: string,
  storage: StorageLike | undefined = defaultStorage()
): void => {
  if (!storage || !path.startsWith("/")) return;
  try {
    const map = readMap(storage);
    // 删掉再插入，让对象键序成为「最久未使用在前」，超限时裁掉最旧的。
    delete map[connectionId];
    map[connectionId] = path;
    const keys = Object.keys(map);
    for (let i = 0; i < keys.length - MAX_ENTRIES; i++) {
      const key = keys[i];
      if (key !== undefined) delete map[key];
    }
    storage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // localStorage 满或被禁用时静默放弃：丢记忆不打扰用户。
  }
};
