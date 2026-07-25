import { describe, expect, test, vi } from "vitest";
import { DeviceKeyProvider } from "./device-key-provider";
import type { DeviceKeyDbAccess, DeviceKeyStore } from "../../../../../packages/security/src/index";
import { KeychainAccessDeniedError } from "../../../../../packages/security/src/index";

vi.mock("../logger", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
}));

const KEY = "a".repeat(64);

const makeDb = (initial?: string): DeviceKeyDbAccess & { value: string | undefined } => {
  let value = initial;
  return {
    get value() {
      return value;
    },
    getLegacy: () => value,
    saveLegacy: (key) => {
      value = key;
    },
    clearLegacy: () => {
      value = undefined;
    }
  };
};

const makeStore = (recall: DeviceKeyStore["recall"]): DeviceKeyStore & { recalls: number } => {
  let recalls = 0;
  return {
    get recalls() {
      return recalls;
    },
    isAvailable: () => true,
    recall: async () => {
      recalls += 1;
      return recall();
    },
    remember: async () => {}
  };
};

describe("DeviceKeyProvider", () => {
  test("does not touch the keychain until the key is asked for", async () => {
    const store = makeStore(async () => KEY);
    const provider = new DeviceKeyProvider({ store, db: makeDb() });

    expect(store.recalls).toBe(0);
    expect(provider.getStatus()).toBe("unresolved");

    expect((await provider.get()).toString("hex")).toBe(KEY);
    expect(store.recalls).toBe(1);
    expect(provider.getStatus()).toBe("keychain");
  });

  test("resolves once and serves later calls from memory", async () => {
    const store = makeStore(async () => KEY);
    const provider = new DeviceKeyProvider({ store, db: makeDb() });

    await provider.get();
    await provider.get();
    await provider.get();

    expect(store.recalls).toBe(1);
  });

  test("collapses concurrent callers into a single keychain read", async () => {
    const store = makeStore(async () => KEY);
    const provider = new DeviceKeyProvider({ store, db: makeDb() });

    await Promise.all([provider.get(), provider.get(), provider.get()]);

    expect(store.recalls).toBe(1);
  });

  test("a denial sticks for the session instead of re-prompting", async () => {
    const store = makeStore(async () => {
      throw new Error("user denied");
    });
    const db = makeDb();
    const provider = new DeviceKeyProvider({ store, db });

    await expect(provider.get()).rejects.toBeInstanceOf(KeychainAccessDeniedError);
    await expect(provider.get()).rejects.toBeInstanceOf(KeychainAccessDeniedError);
    await expect(provider.get()).rejects.toBeInstanceOf(KeychainAccessDeniedError);

    expect(store.recalls).toBe(1); // only the first attempt reached the OS
    expect(provider.getStatus()).toBe("denied");
    expect(db.value).toBeUndefined(); // no replacement key was minted
  });

  test("reauthorize lets an accidental denial be retried", async () => {
    let deny = true;
    const store = makeStore(async () => {
      if (deny) throw new Error("user denied");
      return KEY;
    });
    const provider = new DeviceKeyProvider({ store, db: makeDb() });

    await expect(provider.get()).rejects.toBeInstanceOf(KeychainAccessDeniedError);

    deny = false;
    provider.reauthorize();

    expect((await provider.get()).toString("hex")).toBe(KEY);
    expect(provider.getStatus()).toBe("keychain");
  });

  test("warns before the first keychain access, and only once", async () => {
    let warned = 0;
    const store = makeStore(async () => KEY);
    const provider = new DeviceKeyProvider({
      store,
      db: makeDb(),
      onBeforeKeychainAccess: async () => {
        warned += 1;
      }
    });

    await provider.get();
    await provider.get();

    expect(warned).toBe(1);
  });

  test("skips the warning when there is no keychain to prompt for", async () => {
    let warned = 0;
    const store: DeviceKeyStore = {
      isAvailable: () => false,
      recall: async () => undefined,
      remember: async () => {}
    };
    const db = makeDb();
    const provider = new DeviceKeyProvider({
      store,
      db,
      onBeforeKeychainAccess: async () => {
        warned += 1;
      }
    });

    await provider.get();

    expect(warned).toBe(0);
    expect(provider.getStatus()).toBe("database");
    expect(db.value).toBeDefined(); // degraded storage, but usable
  });

  test("retries after a transient non-denial failure", async () => {
    let attempts = 0;
    const store: DeviceKeyStore = {
      isAvailable: () => true,
      recall: async () => KEY,
      remember: async () => {}
    };
    const failingDb: DeviceKeyDbAccess = {
      getLegacy: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("db busy");
        return undefined;
      },
      saveLegacy: () => {},
      clearLegacy: () => {}
    };
    const provider = new DeviceKeyProvider({ store, db: failingDb });

    await expect(provider.get()).rejects.toThrow("db busy");
    expect((await provider.get()).toString("hex")).toBe(KEY);
  });
});
