import { describe, expect, test } from "vitest";
import { EventEmitter } from "node:events";
import { ChannelBudget, DEFAULT_MAX_CHANNELS_PER_CONNECTION } from "./channel-budget";
import { isChannelClosed } from "./index";
import type { ClientChannel } from "ssh2";

/**
 * Stand-in for an ssh2 channel. It deliberately never sets Node's `destroyed`
 * or `closed` flags — a real ssh2 `Channel` never does either (`emitClose:
 * false` plus an overridden `destroy()`), so a fake that did would hide exactly
 * the bug the endpoint-state probe exists to fix.
 */
class FakeChannel extends EventEmitter {
  incoming = { state: "open" };
  outgoing = { state: "open" };

  /** Our side closes: `close()` moves the outgoing endpoint to `closing`. */
  close(event: "close" | "end" | "error" = "close"): void {
    this.outgoing.state = "closing";
    this.emit(event);
  }

  /** Half-close: still holding a server-side session slot. */
  eof(): void {
    this.outgoing.state = "eof";
  }

  /** The peer closed the channel (ssh2's onCHANNEL_CLOSE). */
  peerClose(): void {
    this.incoming.state = "closed";
    this.outgoing.state = "closed";
  }
}

const asChannel = (fake: FakeChannel): ClientChannel => fake as unknown as ClientChannel;

const track = (budget: ChannelBudget, channel: FakeChannel, budgeted = true): void => {
  budget.track(channel, () => isChannelClosed(asChannel(channel)), budgeted);
};

describe("isChannelClosed", () => {
  test("stays false while either endpoint is open or half-closed", () => {
    const channel = new FakeChannel();
    expect(isChannelClosed(asChannel(channel))).toBe(false);
    channel.eof();
    expect(isChannelClosed(asChannel(channel))).toBe(false);
    // Node's own flags are never set by ssh2 — relying on them would return
    // false here forever.
    expect((channel as unknown as { destroyed?: boolean }).destroyed).toBeUndefined();
  });

  test("detects both our close and the peer's close", () => {
    const ours = new FakeChannel();
    ours.close();
    expect(isChannelClosed(asChannel(ours))).toBe(true);

    const theirs = new FakeChannel();
    theirs.peerClose();
    expect(isChannelClosed(asChannel(theirs))).toBe(true);
  });
});

describe("ChannelBudget", () => {
  test("counts open channels and frees the slot when they close", () => {
    const budget = new ChannelBudget();
    const a = new FakeChannel();
    const b = new FakeChannel();
    track(budget, a);
    track(budget, b);
    expect(budget.count()).toBe(2);

    a.close();
    expect(budget.count()).toBe(1);
    b.close("error");
    expect(budget.count()).toBe(0);
  });

  test("excludes unbudgeted channels (the shared SFTP channel) from the budget", () => {
    const budget = new ChannelBudget();
    track(budget, new FakeChannel(), false);
    track(budget, new FakeChannel(), true);

    expect(budget.count(true)).toBe(1);
    expect(budget.count(false)).toBe(2);
  });

  test("recovers the count when a consumer removes our listeners", () => {
    // Session teardown calls channel.removeAllListeners() before end(), which
    // drops the release listener — the isClosed probe is the fallback.
    const budget = new ChannelBudget();
    const channel = new FakeChannel();
    track(budget, channel);
    expect(budget.count()).toBe(1);

    channel.removeAllListeners();
    // Half-closed is not closed: the slot is still taken.
    channel.eof();
    expect(budget.count()).toBe(1);

    channel.peerClose();
    expect(budget.count()).toBe(0);
  });

  test("reservations occupy the budget until released", () => {
    const budget = new ChannelBudget();
    const release = budget.reserve(0);
    expect(budget.count()).toBe(1);

    release();
    expect(budget.count()).toBe(0);
    // Releasing twice must not push the count negative.
    release();
    expect(budget.count()).toBe(0);
  });

  test("hasCapacity flips once the budget is saturated", () => {
    const budget = new ChannelBudget();
    const releases = Array.from({ length: DEFAULT_MAX_CHANNELS_PER_CONNECTION }, () =>
      budget.reserve(0)
    );
    expect(budget.hasCapacity()).toBe(false);
    expect(budget.hasCapacity(DEFAULT_MAX_CHANNELS_PER_CONNECTION + 1)).toBe(true);

    releases[0]?.();
    expect(budget.hasCapacity()).toBe(true);
  });

  test("clear drops every lease", () => {
    const budget = new ChannelBudget();
    budget.reserve(0);
    track(budget, new FakeChannel());
    expect(budget.count()).toBe(2);

    budget.clear();
    expect(budget.count()).toBe(0);
  });
});
