import { useCallback, useMemo, useState } from "react";
import { App as AntdApp, Input } from "antd";
import { formatErrorMessage } from "../../../utils/errorMessage";
import type { ImportPreviewBatch } from "../types";
import {
  buildNextShellImportPreviewQueue
} from "../utils/nextshellImportPreview";

interface UseConnectionImportFlowOptions {
  modal: ReturnType<typeof AntdApp.useApp>["modal"];
  message: ReturnType<typeof AntdApp.useApp>["message"];
  onConnectionsImported: () => Promise<void>;
}

export const useConnectionImportFlow = ({
  modal,
  message,
  onConnectionsImported
}: UseConnectionImportFlowOptions) => {
  const [importingPreview, setImportingPreview] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importPreviewQueue, setImportPreviewQueue] = useState<ImportPreviewBatch[]>([]);
  const [importQueueIndex, setImportQueueIndex] = useState(0);

  const resetImportFlow = useCallback(() => {
    setImportModalOpen(false);
    setImportPreviewQueue([]);
    setImportQueueIndex(0);
  }, []);

  const promptImportDecryptionPassword = useCallback((fileName: string, promptText: string): Promise<string | null> => {
    return new Promise((resolve) => {
      let password = "";
      let settled = false;
      const settle = (value: string | null): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      modal.confirm({
        title: `${fileName} 需要解密密码`,
        okText: "解密",
        cancelText: "跳过该文件",
        content: (
          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ fontSize: 12, color: "var(--t3)" }}>{promptText}</div>
            <Input.Password
              placeholder="请输入导入密码"
              onChange={(event) => {
                password = event.target.value;
              }}
            />
          </div>
        ),
        onOk: async () => {
          const trimmed = password.trim();
          if (!trimmed) {
            message.warning("请输入解密密码。");
            throw new Error("empty-import-password");
          }
          settle(trimmed);
        },
        onCancel: () => settle(null)
      });
    });
  }, [message, modal]);

  const openImportPreviewQueue = useCallback((queue: ImportPreviewBatch[], emptyMessage: string) => {
    if (queue.length === 0) {
      message.warning(emptyMessage);
      return;
    }

    setImportPreviewQueue(queue);
    setImportQueueIndex(0);
    setImportModalOpen(true);
    if (queue.length > 1) {
      message.info(`已加载 ${queue.length} 个文件，将按文件逐个导入`);
    }
  }, [message]);

  const previewNextShellImportFiles = useCallback(async (filePaths: string[]) => {
    const { queue, warnings } = await buildNextShellImportPreviewQueue({
      filePaths,
      importPreview: (payload) => window.nextshell.connection.importPreview(payload),
      promptImportDecryptionPassword
    });

    if (warnings.length > 0) {
      warnings.forEach((item) => {
        message.warning(formatErrorMessage(item, "部分文件导入失败"));
      });
    }

    openImportPreviewQueue(queue, "未找到可导入的 NextShell 连接文件");
  }, [message, openImportPreviewQueue, promptImportDecryptionPassword]);

  const loadDroppedNextShellImportPreviewQueue = useCallback(async (filePaths: string[]) => {
    if (importingPreview) return;
    try {
      setImportingPreview(true);
      await previewNextShellImportFiles(filePaths);
    } catch (error) {
      message.error(`导入预览失败：${formatErrorMessage(error, "请检查文件格式")}`);
    } finally {
      setImportingPreview(false);
    }
  }, [importingPreview, message, previewNextShellImportFiles]);

  const loadImportPreviewQueue = useCallback(async (source: "nextshell" | "finalshell") => {
    if (importingPreview) return;
    try {
      setImportingPreview(true);
      const dialogResult = await window.nextshell.dialog.openFiles({
        title: source === "nextshell" ? "选择 NextShell 导入文件" : "选择 FinalShell 配置文件",
        multi: true
      });
      if (dialogResult.canceled || dialogResult.filePaths.length === 0) return;

      if (source === "nextshell") {
        await previewNextShellImportFiles(dialogResult.filePaths);
        return;
      }

      const queue: ImportPreviewBatch[] = [];
      const warnings: string[] = [];
      for (const filePath of dialogResult.filePaths) {
        const normalized = filePath.replace(/\\/g, "/");
        const fileName = normalized.slice(normalized.lastIndexOf("/") + 1);
        try {
          const entries = await window.nextshell.connection.importFinalShellPreview({
            filePath
          });
          if (entries.length === 0) {
            warnings.push(`${fileName}：文件中没有可导入的连接`);
          } else {
            queue.push({ fileName, entries });
          }
        } catch (error) {
          warnings.push(`${fileName}：${formatErrorMessage(error, "导入预览失败")}`);
        }
      }

      if (warnings.length > 0) {
        warnings.forEach((item) => {
          message.warning(formatErrorMessage(item, "部分文件导入失败"));
        });
      }

      openImportPreviewQueue(queue, "未找到可导入的 FinalShell 连接文件");
    } catch (error) {
      message.error(`导入预览失败：${formatErrorMessage(error, "请检查文件格式")}`);
    } finally {
      setImportingPreview(false);
    }
  }, [importingPreview, message, openImportPreviewQueue, previewNextShellImportFiles]);

  const handleImportNextShell = useCallback(async () => {
    await loadImportPreviewQueue("nextshell");
  }, [loadImportPreviewQueue]);

  const handleImportFinalShell = useCallback(async () => {
    await loadImportPreviewQueue("finalshell");
  }, [loadImportPreviewQueue]);

  const handleImportDroppedNextShellFiles = useCallback(async (filePaths: string[]) => {
    await loadDroppedNextShellImportPreviewQueue(filePaths);
  }, [loadDroppedNextShellImportPreviewQueue]);

  const handleImportBatchImported = useCallback(async () => {
    await onConnectionsImported();
    const nextIndex = importQueueIndex + 1;
    if (nextIndex < importPreviewQueue.length) {
      setImportQueueIndex(nextIndex);
      const nextBatch = importPreviewQueue[nextIndex];
      message.info(`继续导入 ${nextBatch?.fileName ?? "下一个文件"} (${nextIndex + 1}/${importPreviewQueue.length})`);
      return;
    }

    resetImportFlow();
  }, [importPreviewQueue, importQueueIndex, message, onConnectionsImported, resetImportFlow]);

  const currentImportBatch = useMemo(
    () => importPreviewQueue[importQueueIndex],
    [importPreviewQueue, importQueueIndex]
  );

  return {
    currentImportBatch,
    handleImportBatchImported,
    handleImportFinalShell,
    handleImportDroppedNextShellFiles,
    handleImportNextShell,
    importingPreview,
    importModalOpen,
    importPreviewQueue,
    importQueueIndex,
    resetImportFlow
  };
};
