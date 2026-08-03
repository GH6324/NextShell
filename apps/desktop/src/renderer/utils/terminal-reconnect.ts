import type { SessionStatus } from "@nextshell/core";

export const isEnterInput = (data: string): boolean => data === "\r" || data === "\n";

// `failed` is retryable too: a flaky network must not burn the user's single
// reconnect chance — the auth-failure variant never reaches this path because
// the in-terminal credential prompt consumes input first.
export const shouldReconnectOnInput = (status: SessionStatus | undefined, data: string): boolean =>
  (status === "disconnected" || status === "failed") && isEnterInput(data);
