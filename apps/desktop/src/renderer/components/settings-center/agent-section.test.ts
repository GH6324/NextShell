import { describe, expect, test } from "vitest";
import { formatClientCount, formatRunningState } from "./agent-section";

describe("formatClientCount", () => {
  test("reports the connected count when clients are present", () => {
    expect(formatClientCount(2)).toBe("2 个客户端已连接");
  });

  test("falls back to an empty-state message when no clients are connected", () => {
    expect(formatClientCount(0)).toBe("暂无客户端连接");
  });
});

describe("formatRunningState", () => {
  test("reports disabled regardless of the listening flag", () => {
    expect(formatRunningState(false, true)).toEqual({ status: "default", text: "未启用" });
    expect(formatRunningState(false, false)).toEqual({ status: "default", text: "未启用" });
  });

  test("reports listening when enabled and the endpoint is actually up", () => {
    expect(formatRunningState(true, true)).toEqual({ status: "success", text: "监听中" });
  });

  test("reports a stalled state when enabled but not listening (e.g. bind failure)", () => {
    expect(formatRunningState(true, false)).toEqual({ status: "error", text: "已启用但未监听" });
  });
});
