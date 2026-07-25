import type { AppPreferences } from "@nextshell/core";

export interface TerminalWallpaperRendering {
  /**
   * Whether the xterm canvas must be transparent so the app wallpaper shows
   * through. Construction-time only (`allowTransparency`), so a change here
   * means the terminal has to be rebuilt.
   */
  transparent: boolean;
  /** Whether the WebGL addon should be loaded (false leaves xterm on DOM). */
  webgl: boolean;
}

/**
 * Single source of truth for the see-through terminal decision.
 *
 * See-through requires an actual app wallpaper: with none set (or with the
 * preference off) the result is the pre-feature behaviour — opaque theme
 * background plus WebGL renderer.
 *
 * In see-through mode WebGL is opt-in because the upstream fix for glyph-atlas
 * ghosting under transparency + sustained heavy output (xterm.js #5847, PR
 * #5883) has not shipped in a stable release yet.
 */
export const resolveTerminalWallpaperRendering = (
  backgroundImagePath: string,
  wallpaper: AppPreferences["terminal"]["wallpaper"]
): TerminalWallpaperRendering => {
  const wallpaperActive = backgroundImagePath.trim().length > 0;
  const transparent = wallpaperActive && wallpaper.seeThrough;
  return {
    transparent,
    webgl: !transparent || wallpaper.useWebgl
  };
};
