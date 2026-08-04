import { describe, expect, it } from "vitest";
import { clampScrollLinesFromBottom, shouldDeferReplay } from "./TerminalPane.switching";

describe("shouldDeferReplay", () => {
  it("replays immediately for the first switch", () => {
    expect(shouldDeferReplay(undefined, 1_000, 150)).toBe(false);
  });

  it("defers while the user is still cycling tabs", () => {
    expect(shouldDeferReplay(1_000, 1_060, 150)).toBe(true);
  });

  it("replays immediately for an isolated switch", () => {
    expect(shouldDeferReplay(1_000, 1_400, 150)).toBe(false);
  });

  it("treats the window boundary as isolated", () => {
    expect(shouldDeferReplay(1_000, 1_150, 150)).toBe(false);
  });

  it("falls back to immediate replay when the clock goes backwards", () => {
    expect(shouldDeferReplay(2_000, 1_000, 150)).toBe(false);
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
