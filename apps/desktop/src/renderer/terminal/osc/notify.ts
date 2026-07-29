import type { Terminal } from "@xterm/xterm";
import { useWorkspaceStore } from "../../store/useWorkspaceStore";
import type { OscRuntimeContext } from "../oscRuntime";
import { applyConEmuProgress } from "./progress";

const NOTIFICATION_RATE_LIMIT_MS = 5_000;
const NOTIFICATION_TITLE_MAX = 200;
const NOTIFICATION_BODY_MAX = 500;

// At most one desktop notification per session per interval; `now` is
// injectable so the limiter stays pure and testable.
export const createNotificationRateLimiter = (
  intervalMs: number,
  now: () => number = () => Date.now()
): ((sessionId: string) => boolean) => {
  const lastAtBySession = new Map<string, number>();

  return (sessionId) => {
    const current = now();
    const lastAt = lastAtBySession.get(sessionId);
    if (lastAt !== undefined && current - lastAt < intervalMs) {
      return false;
    }
    lastAtBySession.set(sessionId, current);
    return true;
  };
};

// OSC 777 payload: `notify;<title>;<body>`. The body may itself contain
// semicolons, so split on the first two separators only. Malformed payloads
// (missing parts, empty body) are rejected and consumed silently.
export const parseOsc777 = (data: string): { title: string; body: string } | undefined => {
  const firstSeparator = data.indexOf(";");
  if (firstSeparator < 0 || data.slice(0, firstSeparator) !== "notify") {
    return undefined;
  }

  const secondSeparator = data.indexOf(";", firstSeparator + 1);
  if (secondSeparator < 0) {
    return undefined;
  }

  const body = data.slice(secondSeparator + 1);
  if (!body) {
    return undefined;
  }

  return { title: data.slice(firstSeparator + 1, secondSeparator), body };
};

interface NotificationRequest {
  title?: string;
  body: string;
}

// Sole decision point for whether a notification is warranted — the main
// process renders whatever it is handed, because only the renderer knows both
// the focus state and which session the user is looking at. Notifications are
// noise when the user is already watching that session, so they fire only when
// the app prefers them, the sequence is not a replay artifact, the per-session
// rate limit allows it, and the session is not the active one in a focused
// window.
//
// Known limitation — background sessions never notify. The app multiplexes
// every session through one xterm instance, so only the foreground session's
// bytes reach the parser; a background session's OSC 9/777 sits in its output
// buffer until the user switches to that tab, and by then the bytes arrive as
// a replay (suppressed here) for a session the user is looking at anyway.
// Deliberately not relaxed for replays: the replayed scrollback can be
// megabytes of history, so the "notification" would be an arbitrarily old
// event announced at the exact moment it stopped being news. Real background
// notifications need the session's stream parsed while it is in the
// background — a headless per-session parser or one xterm per session — not a
// tweak to this predicate.
const shouldNotify = (
  ctx: OscRuntimeContext,
  isAllowedByRateLimit: (sessionId: string) => boolean,
  sessionId: string
): boolean => {
  if (!ctx.getTerminalPreferences().oscNotifications || ctx.isReplaying()) {
    return false;
  }
  if (!isAllowedByRateLimit(sessionId)) {
    return false;
  }
  const isActiveAndFocused =
    useWorkspaceStore.getState().activeSessionId === sessionId && document.hasFocus();
  return !isActiveAndFocused;
};

export const install = (terminal: Terminal, ctx: OscRuntimeContext): (() => void) => {
  const isAllowedByRateLimit = createNotificationRateLimiter(NOTIFICATION_RATE_LIMIT_MS);

  const notify = (sessionId: string, request: NotificationRequest): void => {
    if (!shouldNotify(ctx, isAllowedByRateLimit, sessionId)) {
      return;
    }

    void window.nextshell.terminal
      .showNotification({
        sessionId,
        title: request.title ? request.title.slice(0, NOTIFICATION_TITLE_MAX) : undefined,
        body: request.body.slice(0, NOTIFICATION_BODY_MAX)
      })
      .catch(() => {});
  };

  // OSC 9 doubles as two protocols: `4;...` is the ConEmu/WT taskbar progress
  // report (owned by the progress module), anything else is a notification
  // body. Both shapes are always consumed.
  const osc9Registration = terminal.parser.registerOscHandler(9, (data) => {
    if (data.startsWith("4;")) {
      applyConEmuProgress(ctx, data);
      return true;
    }

    const sessionId = ctx.getSessionId();
    if (sessionId) {
      notify(sessionId, { body: data });
    }
    return true;
  });

  const osc777Registration = terminal.parser.registerOscHandler(777, (data) => {
    const parsed = parseOsc777(data);
    const sessionId = ctx.getSessionId();
    if (parsed && sessionId) {
      notify(sessionId, { title: parsed.title, body: parsed.body });
    }
    return true;
  });

  const unsubscribeNotificationAction = window.nextshell.terminal.onNotificationAction(
    ({ sessionId }) => {
      useWorkspaceStore.getState().setActiveSession(sessionId);
    }
  );

  return () => {
    osc9Registration.dispose();
    osc777Registration.dispose();
    unsubscribeNotificationAction();
  };
};
