import type { Session } from "electron";

// Renderer permission baseline: deny every permission request by default and
// allow only the clipboard operations the renderer actually uses
// (terminal paste/copy via navigator.clipboard, e.g. TerminalPane). Everything
// else (media, geolocation, notifications, ...) must stay denied.
const ALLOWED_SESSION_PERMISSIONS: ReadonlySet<string> = new Set([
  "clipboard-read",
  "clipboard-sanitized-write"
]);

export const isAllowedSessionPermission = (permission: string): boolean =>
  ALLOWED_SESSION_PERMISSIONS.has(permission);

export const applySessionPermissionBaseline = (session: Session): void => {
  session.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(isAllowedSessionPermission(permission));
  });
  session.setPermissionCheckHandler((_webContents, permission) =>
    isAllowedSessionPermission(permission)
  );
};
