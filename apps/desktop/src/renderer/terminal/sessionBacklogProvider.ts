/**
 * TerminalPane 持有所有会话的输出缓冲(组件内部 ref)。监视网格等
 * 只读消费者通过这个模块级注册表拿到某会话的回放尾部,而不必把
 * 缓冲搬进全局 store(那会让 2MB 级字符串进入 React 状态)。
 */

export type SessionBacklogProvider = (sessionId: string) => string | undefined;

let provider: SessionBacklogProvider | undefined;

export const setSessionBacklogProvider = (next: SessionBacklogProvider | undefined): void => {
  provider = next;
};

/**
 * 取会话输出的尾部片段。从截断点后的第一个换行开始,避免把半截
 * ANSI 转义序列喂给解析器。
 */
export const readSessionBacklogTail = (
  sessionId: string,
  maxChars = 256 * 1024
): string | undefined => {
  const full = provider?.(sessionId);
  if (full === undefined) {
    return undefined;
  }
  if (full.length <= maxChars) {
    return full;
  }
  const cut = full.length - maxChars;
  const newlineAfterCut = full.indexOf("\n", cut);
  return newlineAfterCut >= 0 && newlineAfterCut < full.length - 1
    ? full.slice(newlineAfterCut + 1)
    : full.slice(cut);
};
