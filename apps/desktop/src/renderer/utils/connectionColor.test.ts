import { describe, expect, test } from "vitest";
import { connectionColor, connectionHue } from "./connectionColor";

describe("connectionColor", () => {
  test("is stable for the same connection id", () => {
    expect(connectionColor("conn-a")).toBe(connectionColor("conn-a"));
  });

  test("hue lands on the 15-degree grid within [0, 360)", () => {
    for (const id of ["a", "b", "conn-123", "e58d2c", ""]) {
      const hue = connectionHue(id);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
      expect(hue % 15).toBe(0);
    }
  });

  test("different ids usually differ", () => {
    const hues = new Set(["c1", "c2", "c3", "c4"].map(connectionHue));
    expect(hues.size).toBeGreaterThan(1);
  });
});
