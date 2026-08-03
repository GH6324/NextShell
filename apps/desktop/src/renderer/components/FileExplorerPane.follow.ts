export const FILE_EXPLORER_FOLLOW_CWD_DEBOUNCE_MS = 1000;

/** 用户手动导航后的这段时间内，终端 cd 不会把文件面板拽走。 */
export const FILE_EXPLORER_FOLLOW_MANUAL_SUPPRESS_MS = 10_000;

/** 手动浏览优先于终端跟随：刚点过目录就别被 `cd` 抢走视野。 */
export const shouldSuppressFollowNavigation = (
  lastManualNavAt: number | undefined,
  now: number,
  suppressMs: number = FILE_EXPLORER_FOLLOW_MANUAL_SUPPRESS_MS
): boolean => lastManualNavAt !== undefined && now - lastManualNavAt < suppressMs;
