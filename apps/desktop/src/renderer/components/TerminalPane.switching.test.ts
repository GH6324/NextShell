import { describe, expect, it } from "vitest";
import { clampScrollLinesFromBottom, shouldRememberSessionScroll } from "./TerminalPane.switching";

describe("shouldRememberSessionScroll", () => {
  it("records the snapshot when the buffer shows the session being left", () => {
    expect(shouldRememberSessionScroll("b", "b")).toBe(true);
  });

  it("skips the snapshot when the buffer still shows an earlier session", () => {
    // A→B→C: B's replay was still queued behind pending writes when C
    // superseded it, so leaving B would otherwise store A's viewport under B.
    expect(shouldRememberSessionScroll("b", "a")).toBe(false);
  });

  it("skips the snapshot when nothing has been painted yet", () => {
    expect(shouldRememberSessionScroll("b", undefined)).toBe(false);
  });
});

describe("clampScrollLinesFromBottom", () => {
  it("keeps the recorded distance when the buffer is tall enough", () => {
    expect(clampScrollLinesFromBottom(40, 500)).toBe(40);
  });

  it("clamps to the scrollback the replayed buffer actually has", () => {
    expect(clampScrollLinesFromBottom(400, 120)).toBe(120);
  });

  it("stays pinned to the bottom for zero or negative offsets", () => {
    expect(clampScrollLinesFromBottom(0, 500)).toBe(0);
    expect(clampScrollLinesFromBottom(-5, 500)).toBe(0);
  });

  it("stays pinned to the bottom when there is no scrollback", () => {
    expect(clampScrollLinesFromBottom(40, 0)).toBe(0);
  });

  it("ignores a non-finite offset", () => {
    expect(clampScrollLinesFromBottom(Number.NaN, 500)).toBe(0);
  });
});
