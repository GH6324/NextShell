/**
 * Subscriber id used when a caller does not identify itself with a session id.
 *
 * Legacy (pre-multi-consumer) renderers send `start`/`stop` keyed by connection
 * only; they occupy this single slot and a `stop` without a session id keeps the
 * old connection-level semantics (tear everything down).
 */
export const LEGACY_MONITOR_SUBSCRIBER_ID = "__connection__";

/**
 * Tracks which renderer-side consumers currently want a connection's monitor
 * stream.
 *
 * One hidden SSH connection and one controller are still shared per connection
 * (the resource stays pooled); only the *demand* is reference counted, so a
 * single pane unmounting can no longer tear down the monitors of every other
 * tab pointed at the same host.
 *
 * Several sessions inside one window share one `WebContents`, therefore the
 * sender lists returned here are de-duplicated: a snapshot must be pushed once
 * per renderer, not once per subscriber.
 */
export class MonitorSubscriberRegistry<TSender> {
  private readonly byConnection = new Map<string, Map<string, TSender>>();

  /** Register (or re-register, e.g. after a renderer reload) one subscriber. */
  add(connectionId: string, subscriberId: string, sender: TSender): void {
    let subscribers = this.byConnection.get(connectionId);
    if (!subscribers) {
      subscribers = new Map<string, TSender>();
      this.byConnection.set(connectionId, subscribers);
    }
    subscribers.set(subscriberId, sender);
  }

  /**
   * Unregister one subscriber.
   *
   * @returns `true` when the connection has no subscribers left, i.e. the
   * caller may now really stop the controller and close the hidden SSH session.
   */
  remove(connectionId: string, subscriberId: string): boolean {
    const subscribers = this.byConnection.get(connectionId);
    if (!subscribers) {
      return true;
    }
    subscribers.delete(subscriberId);
    if (subscribers.size === 0) {
      this.byConnection.delete(connectionId);
      return true;
    }
    return false;
  }

  /** Drop every subscriber of a connection (hard teardown / legacy stop). */
  clear(connectionId: string): void {
    this.byConnection.delete(connectionId);
  }

  /**
   * Drop every subscriber that belongs to one renderer.
   *
   * A renderer reload keeps the *same* `WebContents` alive, so liveness
   * probing can never notice that the page which registered these ids is gone:
   * the pre-reload subscribers would otherwise pin the monitor forever and no
   * later stop could ever reach the hard teardown.
   *
   * @returns the connection ids that have no subscribers left, i.e. the ones
   * whose controller and hidden SSH connection may now really be stopped.
   */
  removeSender(sender: TSender): string[] {
    const idle: string[] = [];
    for (const [connectionId, subscribers] of Array.from(this.byConnection.entries())) {
      let removed = false;
      for (const [subscriberId, candidate] of Array.from(subscribers.entries())) {
        if (candidate === sender) {
          subscribers.delete(subscriberId);
          removed = true;
        }
      }
      if (!removed) {
        continue;
      }
      if (subscribers.size === 0) {
        this.byConnection.delete(connectionId);
        idle.push(connectionId);
      }
    }
    return idle;
  }

  count(connectionId: string): number {
    return this.byConnection.get(connectionId)?.size ?? 0;
  }

  subscriberIds(connectionId: string): string[] {
    return Array.from(this.byConnection.get(connectionId)?.keys() ?? []);
  }

  /** Unique senders, in insertion order. */
  senders(connectionId: string): TSender[] {
    const subscribers = this.byConnection.get(connectionId);
    if (!subscribers) {
      return [];
    }
    return Array.from(new Set(subscribers.values()));
  }

  /**
   * Drop subscribers whose sender is gone (destroyed/crashed renderer), then
   * return the remaining unique senders.
   */
  pruneDead(connectionId: string, isAlive: (sender: TSender) => boolean): TSender[] {
    const subscribers = this.byConnection.get(connectionId);
    if (!subscribers) {
      return [];
    }
    for (const [subscriberId, sender] of Array.from(subscribers.entries())) {
      if (!isAlive(sender)) {
        subscribers.delete(subscriberId);
      }
    }
    if (subscribers.size === 0) {
      this.byConnection.delete(connectionId);
      return [];
    }
    return Array.from(new Set(subscribers.values()));
  }
}
