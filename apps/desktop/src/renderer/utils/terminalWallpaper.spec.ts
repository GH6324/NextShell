import { describe, expect, test } from "vitest";
import { DEFAULT_APP_PREFERENCES } from "@nextshell/core";
import { resolveTerminalWallpaperRendering } from "./terminalWallpaper";

const WALLPAPER_PATH = "/Users/someone/Pictures/bg.png";

describe("resolveTerminalWallpaperRendering", () => {
  test("keeps the pre-feature behaviour when no wallpaper is set", () => {
    expect(resolveTerminalWallpaperRendering("", { seeThrough: true, useWebgl: false })).toEqual({
      transparent: false,
      webgl: true
    });
  });

  test("treats a whitespace-only path as no wallpaper", () => {
    expect(
      resolveTerminalWallpaperRendering("   \t ", { seeThrough: true, useWebgl: false })
    ).toEqual({ transparent: false, webgl: true });
  });

  test("goes transparent on the DOM renderer with the shipped defaults", () => {
    expect(
      resolveTerminalWallpaperRendering(WALLPAPER_PATH, DEFAULT_APP_PREFERENCES.terminal.wallpaper)
    ).toEqual({ transparent: true, webgl: false });
  });

  test("keeps WebGL when the user opts into the experimental path", () => {
    expect(
      resolveTerminalWallpaperRendering(WALLPAPER_PATH, { seeThrough: true, useWebgl: true })
    ).toEqual({ transparent: true, webgl: true });
  });

  test("falls back to the opaque WebGL path when see-through is turned off", () => {
    expect(
      resolveTerminalWallpaperRendering(WALLPAPER_PATH, { seeThrough: false, useWebgl: false })
    ).toEqual({ transparent: false, webgl: true });
  });

  test("ignores useWebgl while see-through is off (no wallpaper means no DOM fallback)", () => {
    expect(
      resolveTerminalWallpaperRendering(WALLPAPER_PATH, { seeThrough: false, useWebgl: true })
    ).toEqual({ transparent: false, webgl: true });
    expect(resolveTerminalWallpaperRendering("", { seeThrough: false, useWebgl: true })).toEqual({
      transparent: false,
      webgl: true
    });
  });

  test("the shipped defaults never make a wallpaper-less terminal transparent", () => {
    const { seeThrough, useWebgl } = DEFAULT_APP_PREFERENCES.terminal.wallpaper;
    expect(seeThrough).toBe(true);
    expect(useWebgl).toBe(false);
    expect(resolveTerminalWallpaperRendering("", { seeThrough, useWebgl }).transparent).toBe(false);
  });
});
