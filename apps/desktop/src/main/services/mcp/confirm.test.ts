import { describe, expect, test, vi } from "vitest";
import { AgentPromptBroker } from "./confirm";

describe("AgentPromptBroker", () => {
  test("correlates a renderer response with the pending main-process prompt", async () => {
    const send = vi.fn();
    const broker = new AgentPromptBroker({ send });
    const pending = broker.request({ kind: "confirm", title: "Confirm", message: "Proceed?" });
    const request = send.mock.calls[0]?.[0];
    expect(request?.id).toMatch(/[0-9a-f-]{36}/);
    expect(broker.respond({ id: request.id, canceled: false, value: "approved" })).toBe(true);
    await expect(pending).resolves.toMatchObject({ canceled: false, value: "approved" });
    expect(broker.respond({ id: request.id, canceled: true })).toBe(false);
  });

  test("times out and disposes prompts as cancellations", async () => {
    vi.useFakeTimers();
    try {
      const broker = new AgentPromptBroker({ send: () => undefined, timeoutMs: 100 });
      const timedOut = broker.request({ kind: "text", title: "Input", message: "Value" });
      await vi.advanceTimersByTimeAsync(101);
      await expect(timedOut).resolves.toMatchObject({ canceled: true });

      const disposed = broker.request({ kind: "confirm", title: "Confirm", message: "Proceed?" });
      broker.dispose();
      await expect(disposed).resolves.toMatchObject({ canceled: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
