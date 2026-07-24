import { BrowserWindow, Notification } from "electron";
import type { WebContents } from "electron";
import { IPCChannel } from "@nextshell/shared";
import type { TerminalNotificationInput, TerminalProgressInput } from "@nextshell/shared";

export interface TerminalIntegrationResult {
  ok: boolean;
  error?: string;
}

/**
 * Main-process side of the terminal OSC integration:
 * - OSC 9 / 777 desktop notifications. The renderer pre-filters per-session
 *   activity (background sessions only); this service enforces the remaining
 *   window-focus gate so no notification pops while the user is looking at
 *   the app.
 * - OSC 9;4 taskbar/dock progress bar, mapped onto
 *   `BrowserWindow.setProgressBar`.
 *
 * Both entry points resolve the owning window from the IPC sender, mirroring
 * `PreferencesDialogService.openLocalPath`.
 */
export class TerminalIntegrationService {
  showNotification(
    sender: WebContents,
    input: TerminalNotificationInput
  ): TerminalIntegrationResult {
    const owner = BrowserWindow.fromWebContents(sender);
    // No owning window, or the user is already looking at the app: stay
    // silent instead of popping a redundant notification.
    if (!owner || owner.isFocused()) {
      return { ok: true };
    }

    const notification = new Notification({
      title: input.title ?? "NextShell",
      body: input.body
    });
    notification.on("click", () => {
      owner.show();
      owner.focus();
      if (!sender.isDestroyed()) {
        sender.send(IPCChannel.TerminalNotificationAction, { sessionId: input.sessionId });
      }
    });
    notification.show();
    return { ok: true };
  }

  setProgress(sender: WebContents, input: TerminalProgressInput): TerminalIntegrationResult {
    const owner = BrowserWindow.fromWebContents(sender);
    if (!owner) {
      return { ok: true };
    }

    // `value` arrives as 0-100 (IPC schema); Electron expects a 0-1 fraction.
    switch (input.state) {
      case "none":
        // Clear the progress bar entirely.
        owner.setProgressBar(-1);
        break;
      case "indeterminate":
        // Value is ignored in this mode; 2 just keeps it out of 0-1 range.
        owner.setProgressBar(2, { mode: "indeterminate" });
        break;
      case "normal":
        owner.setProgressBar((input.value ?? 0) / 100, { mode: "normal" });
        break;
      case "error":
        // Without an explicit value, show a full bar in the error state.
        owner.setProgressBar((input.value ?? 100) / 100, { mode: "error" });
        break;
      case "paused":
        owner.setProgressBar((input.value ?? 0) / 100, { mode: "paused" });
        break;
    }
    return { ok: true };
  }
}
