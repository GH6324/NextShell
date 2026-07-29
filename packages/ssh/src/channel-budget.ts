/**
 * Per-client SSH channel accounting.
 *
 * Every shell, exec and SFTP subsystem opened on an ssh2 `Client` consumes one
 * server-side session slot. OpenSSH's default `MaxSessions` is 10, and once it
 * is exhausted further `shell()`/`sftp()` requests fail *silently* — the
 * symptom users see as "the 9th tab never prints anything". The connection pool
 * therefore keeps several clients per connection and needs to know how loaded
 * each one is; this class is that bookkeeping, kept free of ssh2 types so it
 * can be unit-tested on its own.
 */

/**
 * Channels a single ssh2 Client may hold before the pool hands out (or opens)
 * another client. Leaves headroom under OpenSSH's default `MaxSessions=10` for
 * the client's long-lived shared SFTP channel plus a transient probe.
 */
export const DEFAULT_MAX_CHANNELS_PER_CONNECTION = 8;

/**
 * How long a slot handed out by `reserve()` stays counted when nobody releases
 * it. A caller that dies between "give me a client" and "open the channel"
 * must not wedge the budget forever.
 */
export const CHANNEL_RESERVATION_TTL_MS = 30_000;

/** Minimal surface of an ssh2 channel needed to observe its termination. */
export interface ChannelLike {
  once(event: string, listener: () => void): unknown;
}

interface ChannelLease {
  /** Counts against the per-client channel budget. */
  budgeted: boolean;
  released: boolean;
  /**
   * Authoritative liveness probe. The `close`/`end`/`error` listeners are only
   * a fast path: consumers routinely call `removeAllListeners()` on a channel
   * they own (session teardown does exactly that), which drops our listener, so
   * the count has to be able to recover by inspecting the channel itself.
   */
  isClosed: () => boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export class ChannelBudget {
  private readonly leases = new Set<ChannelLease>();

  /**
   * Reserve a slot before the channel exists. Returns an idempotent release.
   *
   * The pool hands a client to a caller that opens its channel a few
   * microtasks later; without a reservation a burst of concurrent session
   * opens would all measure the same zero load and pile onto one client.
   */
  reserve(ttlMs: number = CHANNEL_RESERVATION_TTL_MS): () => void {
    const lease: ChannelLease = { budgeted: true, released: false, isClosed: () => false };
    this.leases.add(lease);
    const release = (): void => {
      if (lease.released) return;
      lease.released = true;
      this.leases.delete(lease);
      if (lease.timer) clearTimeout(lease.timer);
    };
    if (ttlMs > 0) {
      const timer = setTimeout(release, ttlMs);
      // Never hold the process open on a bookkeeping timer.
      timer.unref?.();
      lease.timer = timer;
    }
    return release;
  }

  /** Start counting an opened channel until it closes. */
  track(channel: ChannelLike, isClosed: () => boolean, budgeted: boolean): void {
    const lease: ChannelLease = { budgeted, released: false, isClosed };
    this.leases.add(lease);
    const release = (): void => {
      if (lease.released) return;
      lease.released = true;
      this.leases.delete(lease);
    };
    channel.once("close", release);
    channel.once("end", release);
    channel.once("error", release);
  }

  /** Channels counted against the budget (`budgetedOnly`) or every channel. */
  count(budgetedOnly = true): number {
    let count = 0;
    for (const lease of this.leases) {
      if (lease.released || lease.isClosed()) {
        lease.released = true;
        if (lease.timer) clearTimeout(lease.timer);
        this.leases.delete(lease);
        continue;
      }
      if (!budgetedOnly || lease.budgeted) count += 1;
    }
    return count;
  }

  /** Whether another budgeted channel fits on this client. */
  hasCapacity(budget: number = DEFAULT_MAX_CHANNELS_PER_CONNECTION): boolean {
    return this.count(true) < budget;
  }

  /** Drop every lease (the client itself is gone). */
  clear(): void {
    for (const lease of this.leases) {
      lease.released = true;
      if (lease.timer) clearTimeout(lease.timer);
    }
    this.leases.clear();
  }
}
