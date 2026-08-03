import { describe, expect, test } from "vitest";
import {
  FILE_EXPLORER_FOLLOW_MANUAL_SUPPRESS_MS,
  shouldSuppressFollowNavigation
} from "./FileExplorerPane.follow";

describe("shouldSuppressFollowNavigation", () => {
  test("suppresses within the manual-navigation window", () => {
    expect(shouldSuppressFollowNavigation(1_000, 1_000 + 1)).toBe(true);
    expect(
      shouldSuppressFollowNavigation(1_000, 1_000 + FILE_EXPLORER_FOLLOW_MANUAL_SUPPRESS_MS - 1)
    ).toBe(true);
  });

  test("allows follow once the window elapsed or without manual navigation", () => {
    expect(
      shouldSuppressFollowNavigation(1_000, 1_000 + FILE_EXPLORER_FOLLOW_MANUAL_SUPPRESS_MS)
    ).toBe(false);
    expect(shouldSuppressFollowNavigation(undefined, 5_000)).toBe(false);
  });
});
