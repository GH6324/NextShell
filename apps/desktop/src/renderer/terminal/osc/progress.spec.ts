import { describe, expect, test } from "vitest";
import { parseConEmuProgress } from "./progress";

describe("parseConEmuProgress", () => {
  test("parses state 0 as none without a value", () => {
    expect(parseConEmuProgress("4;0;0")).toEqual({ state: "none" });
  });

  test("parses state 1 as normal with a clamped value", () => {
    expect(parseConEmuProgress("4;1;42")).toEqual({ state: "normal", value: 42 });
    expect(parseConEmuProgress("4;1;-5")).toEqual({ state: "normal", value: 0 });
    expect(parseConEmuProgress("4;1;250")).toEqual({ state: "normal", value: 100 });
  });

  test("parses state 2 as error with a value", () => {
    expect(parseConEmuProgress("4;2;77")).toEqual({ state: "error", value: 77 });
  });

  test("parses state 3 as indeterminate without a value", () => {
    expect(parseConEmuProgress("4;3;0")).toEqual({ state: "indeterminate" });
  });

  test("parses state 4 as paused with a value", () => {
    expect(parseConEmuProgress("4;4;55")).toEqual({ state: "paused", value: 55 });
  });

  test("rejects payloads without the 4 prefix", () => {
    expect(parseConEmuProgress("9;1;50")).toBeUndefined();
    expect(parseConEmuProgress("hello")).toBeUndefined();
  });

  test("rejects missing or unknown states", () => {
    expect(parseConEmuProgress("4")).toBeUndefined();
    expect(parseConEmuProgress("4;")).toBeUndefined();
    expect(parseConEmuProgress("4;5;10")).toBeUndefined();
    expect(parseConEmuProgress("4;1.5;10")).toBeUndefined();
    expect(parseConEmuProgress("4;x;10")).toBeUndefined();
  });

  test("rejects value states without a numeric value", () => {
    expect(parseConEmuProgress("4;1")).toBeUndefined();
    expect(parseConEmuProgress("4;1;")).toBeUndefined();
    expect(parseConEmuProgress("4;2;abc")).toBeUndefined();
    expect(parseConEmuProgress("4;4;Infinity")).toBeUndefined();
  });
});
