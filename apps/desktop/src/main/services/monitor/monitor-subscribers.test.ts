import { MonitorSubscriberRegistry } from "./monitor-subscribers";

const assertTrue = (value: unknown, message: string): void => {
  if (!value) {
    throw new Error(message);
  }
};

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
};

interface FakeSender {
  id: string;
  alive: boolean;
}

// Normal path: two sessions on the same connection, one leaves, the monitor
// must survive until the last subscriber is gone.
(() => {
  const registry = new MonitorSubscriberRegistry<FakeSender>();
  const senderA: FakeSender = { id: "window-1", alive: true };
  const senderB: FakeSender = { id: "window-2", alive: true };

  registry.add("conn-1", "session-a", senderA);
  registry.add("conn-1", "session-b", senderB);
  assertEqual(registry.count("conn-1"), 2, "both sessions should be registered");
  assertEqual(registry.senders("conn-1").length, 2, "two distinct renderers should be listed");

  assertEqual(
    registry.remove("conn-1", "session-a"),
    false,
    "removing one of two subscribers must not report the connection as idle"
  );
  assertEqual(registry.count("conn-1"), 1, "one subscriber should remain");
  assertEqual(registry.senders("conn-1")[0], senderB, "the remaining sender should still receive");

  assertEqual(
    registry.remove("conn-1", "session-b"),
    true,
    "removing the last subscriber must report the connection as idle"
  );
  assertEqual(registry.count("conn-1"), 0, "registry entry should be dropped when empty");
})();

// De-duplication: several sessions of one window share one sender, so a
// snapshot must only be pushed once per renderer.
(() => {
  const registry = new MonitorSubscriberRegistry<FakeSender>();
  const shared: FakeSender = { id: "window-1", alive: true };
  registry.add("conn-2", "session-a", shared);
  registry.add("conn-2", "session-b", shared);

  assertEqual(registry.count("conn-2"), 2, "both sessions should be registered");
  assertEqual(registry.senders("conn-2").length, 1, "shared sender should be emitted once");
})();

// Failure path: unknown subscriber / unknown connection, and dead renderers.
(() => {
  const registry = new MonitorSubscriberRegistry<FakeSender>();

  assertEqual(
    registry.remove("missing-conn", "session-x"),
    true,
    "removing from an unknown connection should report idle instead of throwing"
  );
  assertEqual(registry.senders("missing-conn").length, 0, "unknown connection has no senders");

  const dead: FakeSender = { id: "window-dead", alive: false };
  const alive: FakeSender = { id: "window-alive", alive: true };
  registry.add("conn-3", "session-dead", dead);
  registry.add("conn-3", "session-alive", alive);

  const remaining = registry.pruneDead("conn-3", (sender) => sender.alive);
  assertEqual(remaining.length, 1, "dead renderer should be pruned");
  assertEqual(remaining[0], alive, "live renderer should survive pruning");
  assertEqual(registry.count("conn-3"), 1, "pruned subscriber should be unregistered");

  alive.alive = false;
  assertEqual(
    registry.pruneDead("conn-3", (sender) => sender.alive).length,
    0,
    "pruning every subscriber should leave no receivers"
  );
  assertEqual(registry.count("conn-3"), 0, "registry entry should be dropped when fully pruned");

  registry.add("conn-4", "session-a", alive);
  registry.clear("conn-4");
  assertEqual(registry.count("conn-4"), 0, "clear() should drop every subscriber");
  assertTrue(
    registry.remove("conn-4", "session-a"),
    "after clear() a stale stop must still report idle"
  );
})();

// Renderer reload: the WebContents survives, so its pre-reload subscriber ids
// can only be dropped by identity — and the caller must learn which
// connections went idle so it can hard-stop them.
(() => {
  const registry = new MonitorSubscriberRegistry<FakeSender>();
  const reloaded: FakeSender = { id: "window-1", alive: true };
  const other: FakeSender = { id: "window-2", alive: true };

  registry.add("conn-a", "old-uuid", reloaded);
  registry.add("conn-a", "other-window", other);
  registry.add("conn-b", "old-uuid", reloaded);
  registry.add("conn-b", "old-uuid-2", reloaded);

  const idle = registry.removeSender(reloaded);
  assertEqual(idle.length, 1, "only the connection left without subscribers should be reported");
  assertEqual(idle[0], "conn-b", "conn-b lost every subscriber");
  assertEqual(registry.count("conn-a"), 1, "the other window keeps conn-a alive");
  assertEqual(registry.senders("conn-a")[0], other, "the surviving sender should still receive");
  assertEqual(registry.count("conn-b"), 0, "conn-b should have no subscribers left");
})();

// Failure path: purging a renderer that never subscribed is a no-op.
(() => {
  const registry = new MonitorSubscriberRegistry<FakeSender>();
  const known: FakeSender = { id: "window-1", alive: true };
  const stranger: FakeSender = { id: "window-2", alive: true };
  registry.add("conn-c", "session-a", known);

  assertEqual(
    registry.removeSender(stranger).length,
    0,
    "purging an unknown renderer must not report anything idle"
  );
  assertEqual(registry.count("conn-c"), 1, "an unrelated subscriber must survive the purge");
})();
