import { createElement } from "react";
import { Modal, message, Typography } from "antd";
import { formatErrorMessage } from "../../utils/errorMessage";

// Unified exit point for opening links found in terminal output — both OSC 8
// explicit hyperlinks and bare URLs detected by WebLinksAddon land here, so
// the confirm-first flow and the failure toast stay consistent. The confirm
// dialog always shows the full target URL: with OSC 8 the display text may
// differ from the actual target, which is the classic phishing angle.

export interface OpenExternalLinkOptions {
  confirm: boolean;
}

export interface OpenExternalLinkHooks {
  confirmOpen?: (uri: string) => Promise<boolean>;
  openPath?: (uri: string) => Promise<{ ok: boolean; error?: string }>;
  showError?: (text: string) => void;
}

const defaultOpenPath = (uri: string): Promise<{ ok: boolean; error?: string }> =>
  window.nextshell.dialog.openPath({ path: uri, revealInFolder: false });

const defaultShowError = (text: string): void => {
  void message.error(text);
};

const confirmExternalLinkOpen = (uri: string): Promise<boolean> =>
  new Promise((resolve) => {
    let settled = false;
    const settle = (confirmed: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(confirmed);
    };

    Modal.confirm({
      title: "打开外部链接",
      content: createElement(
        "div",
        null,
        createElement(
          "p",
          null,
          "终端中的链接显示文本可能与实际目标地址不一致，请确认以下目标地址可信后再打开："
        ),
        createElement(
          Typography.Paragraph,
          {
            code: true,
            style: { wordBreak: "break-all", userSelect: "text", maxHeight: 160, overflow: "auto" }
          },
          uri
        )
      ),
      okText: "打开",
      cancelText: "取消",
      onOk: () => settle(true),
      onCancel: () => settle(false)
    });
  });

export const openExternalLink = async (
  uri: string,
  options: OpenExternalLinkOptions,
  hooks: OpenExternalLinkHooks = {}
): Promise<void> => {
  if (options.confirm) {
    const confirmed = await (hooks.confirmOpen ?? confirmExternalLinkOpen)(uri);
    if (!confirmed) {
      return;
    }
  }

  const openPath = hooks.openPath ?? defaultOpenPath;
  const showError = hooks.showError ?? defaultShowError;

  try {
    const result = await openPath(uri);
    if (!result.ok) {
      showError(`打开链接失败：${formatErrorMessage(result.error, "请稍后重试")}`);
    }
  } catch (error) {
    showError(`打开链接失败：${formatErrorMessage(error, "请稍后重试")}`);
  }
};
