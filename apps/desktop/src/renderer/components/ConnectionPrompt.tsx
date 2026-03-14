/**
 * 居中、带图标的「未连接 / 需先连接」提示，用于终端下方功能模块（SFTP、文件快传、系统信息、磁盘、路由追踪等）。
 */
interface ConnectionPromptProps {
  message: string;
  icon?: string;
}

export function ConnectionPrompt({ message, icon = "ri-links-line" }: ConnectionPromptProps) {
  return (
    <div className="pane-connection-prompt" role="status">
      <i className={icon} aria-hidden="true" />
      <span className="pane-connection-prompt-text">{message}</span>
    </div>
  );
}
