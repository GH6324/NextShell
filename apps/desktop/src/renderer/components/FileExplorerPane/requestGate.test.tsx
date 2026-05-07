import { describe, expect, test } from "bun:test";
import { createRemoteExplorerRequestGate } from "./requestGate";

describe("remote explorer request gate", () => {
  test("rejects an older directory load after a newer path request starts", () => {
    const gate = createRemoteExplorerRequestGate();

    const first = gate.begin("conn-1", "/custom");
    const second = gate.begin("conn-1", "/home");

    expect(gate.isCurrent(first, { connectionId: "conn-1", path: "/custom" })).toBe(false);
    expect(gate.isCurrent(second, { connectionId: "conn-1", path: "/home" })).toBe(true);
  });

  test("rejects an in-flight directory load after connection state changes", () => {
    const gate = createRemoteExplorerRequestGate();

    const request = gate.begin("conn-1", "/custom");
    gate.invalidate();

    expect(gate.isCurrent(request, { connectionId: "conn-1", path: "/custom" })).toBe(false);
    expect(gate.isCurrent(request, { connectionId: "conn-2", path: "/custom" })).toBe(false);
  });
});
