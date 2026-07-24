import { describe, expect, test, vi } from "vitest";
import { openExternalLink } from "./linkOpening";

describe("openExternalLink", () => {
  test("opens immediately without asking when confirm is disabled", async () => {
    const confirmOpen = vi.fn(() => Promise.resolve(false));
    const openPath = vi.fn(() => Promise.resolve({ ok: true }));

    await openExternalLink("https://example.com", { confirm: false }, { confirmOpen, openPath });

    expect(confirmOpen).not.toHaveBeenCalled();
    expect(openPath).toHaveBeenCalledWith("https://example.com");
  });

  test("opens after the user confirms", async () => {
    const confirmOpen = vi.fn(() => Promise.resolve(true));
    const openPath = vi.fn(() => Promise.resolve({ ok: true }));

    await openExternalLink("https://example.com", { confirm: true }, { confirmOpen, openPath });

    expect(confirmOpen).toHaveBeenCalledWith("https://example.com");
    expect(openPath).toHaveBeenCalledWith("https://example.com");
  });

  test("does not open when the user cancels", async () => {
    const confirmOpen = vi.fn(() => Promise.resolve(false));
    const openPath = vi.fn(() => Promise.resolve({ ok: true }));

    await openExternalLink("https://example.com", { confirm: true }, { confirmOpen, openPath });

    expect(openPath).not.toHaveBeenCalled();
  });

  test("surfaces a failure result through the error hook", async () => {
    const openPath = vi.fn(() => Promise.resolve({ ok: false, error: "ENOENT" }));
    const showError = vi.fn();

    await openExternalLink("https://example.com", { confirm: false }, { openPath, showError });

    expect(showError).toHaveBeenCalledOnce();
    expect(showError.mock.calls[0]?.[0]).toContain("打开链接失败");
  });

  test("surfaces a thrown failure through the error hook", async () => {
    const openPath = vi.fn(() => Promise.reject(new Error("boom")));
    const showError = vi.fn();

    await openExternalLink("mailto:dev@example.com", { confirm: false }, { openPath, showError });

    expect(showError).toHaveBeenCalledOnce();
    expect(showError.mock.calls[0]?.[0]).toContain("打开链接失败");
  });

  test("stays quiet when the open succeeds", async () => {
    const openPath = vi.fn(() => Promise.resolve({ ok: true }));
    const showError = vi.fn();

    await openExternalLink("https://example.com", { confirm: false }, { openPath, showError });

    expect(showError).not.toHaveBeenCalled();
  });
});
