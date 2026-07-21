import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { SFTPWrapper } from "ssh2";
import { mapWithConcurrency, SharedSftpChannel } from "./index";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

/** Minimal stand-in for an ssh2 SFTPWrapper (event emitter + end()). */
class FakeSftpChannel extends EventEmitter {
  endCalls = 0;
  end(): void {
    this.endCalls += 1;
  }
}

const asSftp = (fake: FakeSftpChannel): SFTPWrapper => fake as unknown as SFTPWrapper;

describe("SharedSftpChannel", () => {
  test("opens lazily and shares one channel across concurrent callers", async () => {
    let openCalls = 0;
    const fake = new FakeSftpChannel();
    const channel = new SharedSftpChannel(async () => {
      openCalls += 1;
      await tick();
      return asSftp(fake);
    });

    const [a, b, c] = await Promise.all([channel.get(), channel.get(), channel.get()]);
    expect(openCalls).toBe(1);
    expect(a).toBe(asSftp(fake));
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  test("reopens after the cached channel closes", async () => {
    const fakes = [new FakeSftpChannel(), new FakeSftpChannel()];
    let openCalls = 0;
    const channel = new SharedSftpChannel(async () => asSftp(fakes[openCalls++]!));

    const first = await channel.get();
    expect(first).toBe(asSftp(fakes[0]!));

    fakes[0]!.emit("close");
    const second = await channel.get();
    expect(second).toBe(asSftp(fakes[1]!));
    expect(openCalls).toBe(2);
  });

  test("reopens after the cached channel errors", async () => {
    const fakes = [new FakeSftpChannel(), new FakeSftpChannel()];
    let openCalls = 0;
    const channel = new SharedSftpChannel(async () => asSftp(fakes[openCalls++]!));

    await channel.get();
    fakes[0]!.emit("error", new Error("channel died"));

    const second = await channel.get();
    expect(second).toBe(asSftp(fakes[1]!));
    expect(openCalls).toBe(2);
  });

  test("propagates an open failure and retries on the next call", async () => {
    let attempts = 0;
    const channel = new SharedSftpChannel(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("sftp unavailable");
      }
      return asSftp(new FakeSftpChannel());
    });

    let caught: unknown;
    try {
      await channel.get();
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toBe("sftp unavailable");

    const sftp = await channel.get();
    expect(sftp).toBeDefined();
    expect(attempts).toBe(2);
  });

  test("end() ends and drops the cached channel", async () => {
    const fake = new FakeSftpChannel();
    let openCalls = 0;
    const channel = new SharedSftpChannel(async () => {
      openCalls += 1;
      return asSftp(fake);
    });

    await channel.get();
    channel.end();
    expect(fake.endCalls).toBe(1);

    await channel.get();
    expect(openCalls).toBe(2);
  });

  test("invalidate(stale) keeps the current channel", async () => {
    const fake = new FakeSftpChannel();
    const channel = new SharedSftpChannel(async () => asSftp(fake));

    const current = await channel.get();
    channel.invalidate(asSftp(new FakeSftpChannel()));

    expect(await channel.get()).toBe(current);
  });
});

describe("mapWithConcurrency", () => {
  test("processes every item while respecting the concurrency bound", async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const seen: number[] = [];
    let active = 0;
    let maxActive = 0;

    await mapWithConcurrency(items, 4, async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await tick();
      seen.push(item);
      active -= 1;
    });

    expect(seen.sort((a, b) => a - b)).toEqual(items);
    expect(maxActive).toBe(4);
  });

  test("does nothing for an empty list", async () => {
    let calls = 0;
    await mapWithConcurrency([], 4, async () => {
      calls += 1;
    });
    expect(calls).toBe(0);
  });

  test("stops scheduling new work after the first failure and rejects with it", async () => {
    const started: number[] = [];
    let caught: unknown;
    try {
      await mapWithConcurrency([0, 1, 2, 3, 4, 5, 6, 7], 2, async (item) => {
        started.push(item);
        if (item === 0) {
          throw new Error("boom");
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    } catch (error) {
      caught = error;
    }

    expect((caught as Error).message).toBe("boom");
    // The failing worker stopped pulling; items beyond the in-flight ones
    // (0 and 1) must never have started.
    expect(started).toEqual([0, 1]);
  });

  test("keeps the first error when several workers fail", async () => {
    let caught: unknown;
    try {
      await mapWithConcurrency([0, 1], 2, async (item) => {
        if (item === 0) {
          throw new Error("first");
        }
        await tick();
        throw new Error("second");
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toBe("first");
  });
});
