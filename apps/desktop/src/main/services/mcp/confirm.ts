import { randomUUID } from "node:crypto";

import type { AgentPromptRequest, AgentPromptResponse } from "@nextshell/shared";

const DEFAULT_PROMPT_TIMEOUT_MS = 5 * 60_000;

interface PendingPrompt {
  resolve: (response: AgentPromptResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface AgentPromptBrokerOptions {
  send: (request: AgentPromptRequest) => void;
  timeoutMs?: number;
}

/**
 * Bridges an MCP call in the main process to an application-owned renderer
 * prompt. Requests are correlated explicitly and always time out so a closed
 * renderer can never leave an SSH operation hanging forever.
 */
export class AgentPromptBroker {
  private readonly send: (request: AgentPromptRequest) => void;
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, PendingPrompt>();

  constructor(options: AgentPromptBrokerOptions) {
    this.send = options.send;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
  }

  request(input: Omit<AgentPromptRequest, "id">): Promise<AgentPromptResponse> {
    const request = { ...input, id: randomUUID() } satisfies AgentPromptRequest;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        resolve({ id: request.id, canceled: true });
      }, this.timeoutMs);
      this.pending.set(request.id, { resolve, timer });
      try {
        this.send(request);
      } catch {
        clearTimeout(timer);
        this.pending.delete(request.id);
        resolve({ id: request.id, canceled: true });
      }
    });
  }

  respond(response: AgentPromptResponse): boolean {
    const pending = this.pending.get(response.id);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    pending.resolve(response);
    return true;
  }

  dispose(): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ id, canceled: true });
    }
    this.pending.clear();
  }
}
