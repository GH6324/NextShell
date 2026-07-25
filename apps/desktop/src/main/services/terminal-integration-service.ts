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
 * - OSC 9 / 777 desktop notifications. Whether a notification is warranted is
 *   decided entirely in the renderer, which is the only side that knows both
 *   the focus state and which session the user is looking at: a background
 *   session finishing its build *should* notify even while the window is
 *   focused. Re-testing focus here would silently drop exactly that case, so
 *   this service only renders what it is asked to render.
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
    if (!owner || !Notification.isSupported()) {
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
