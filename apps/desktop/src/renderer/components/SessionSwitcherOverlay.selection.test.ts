import { describe, expect, it } from "vitest";
import { resolveSwitcherSelection } from "./SessionSwitcherOverlay.selection";

const lookupFrom = (alive: Record<string, string>) => (id: string) => alive[id];

describe("resolveSwitcherSelection", () => {
  it("keeps the cycle order and the selection when every tab is alive", () => {
    const result = resolveSwitcherSelection(
      ["a", "b", "c"],
      2,
      lookupFrom({ a: "A", b: "B", c: "C" })
    );

    expect(result.entries).toEqual(["A", "B", "C"]);
    expect(result.selectedIndex).toBe(2);
  });

  it("follows the selected tab after an earlier tab vanished", () => {
    const result = resolveSwitcherSelection(["a", "b", "c"], 2, lookupFrom({ a: "A", c: "C" }));

    expect(result.entries).toEqual(["A", "C"]);
    expect(result.selectedIndex).toBe(1);
  });

  it("keeps the highlight where the vanished selection used to be", () => {
    const result = resolveSwitcherSelection(["a", "b", "c"], 1, lookupFrom({ a: "A", c: "C" }));

    expect(result.entries).toEqual(["A", "C"]);
    expect(result.selectedIndex).toBe(1);
  });

  it("clamps to the last row when the selection and everything after it vanished", () => {
    const result = resolveSwitcherSelection(["a", "b", "c"], 2, lookupFrom({ a: "A" }));

    expect(result.entries).toEqual(["A"]);
    expect(result.selectedIndex).toBe(0);
  });

  it("reports index 0 for an empty list instead of a negative row", () => {
    const result = resolveSwitcherSelection(["a", "b"], 1, lookupFrom({}));

    expect(result.entries).toEqual([]);
    expect(result.selectedIndex).toBe(0);
  });

  it("stays inside the list for an out-of-range index", () => {
    const result = resolveSwitcherSelection(["a", "b"], 9, lookupFrom({ a: "A", b: "B" }));

    expect(result.selectedIndex).toBe(1);
  });
});
