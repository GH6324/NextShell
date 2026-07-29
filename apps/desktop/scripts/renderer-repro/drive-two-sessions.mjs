/* eslint-disable */
// Playwright MCP browser_run_code_unsafe script — same format constraint as
// setup-mock.mjs (one bare `async (page) => {...}` expression). Run AFTER
// setup-mock.mjs in the same MCP session.
//
// Scenario: the multi-session smoke test that exposed the 2026-07 terminal
// freeze — open two tabs on one connection, type in tab A, switch to tab B,
// type there, switch back. Screenshots land in OUT_DIR; adapt the typed
// commands / assertions to the bug being chased.
async (page) => {
  // Adjust to <repo root>/.playwright-mcp (gitignored; also the MCP's own
  // output root, so screenshots stay readable by MCP file tools).
  const OUT_DIR = "/Users/ztwang/repo/nextshell/.playwright-mcp";

  const shot = async (name) => {
    await page.screenshot({ path: `${OUT_DIR}/${name}.png` });
  };

  // Mirrors useSessionLifecycle.startSession closely enough for repro: mint a
  // session id, stage the pending descriptor, open through the (mocked)
  // bridge, commit the opened descriptor. The vite module URL resolves to the
  // SAME store singleton the app uses.
  const openSession = async (title) => {
    return page.evaluate(async (tabTitle) => {
      const { useWorkspaceStore } = await import("/src/renderer/store/useWorkspaceStore.ts");
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      useWorkspaceStore.getState().upsertSession({
        id,
        target: "remote",
        connectionId: "fake-conn",
        title: tabTitle,
        type: "terminal",
        status: "connecting",
        createdAt: now,
        reconnectable: true
      });
      useWorkspaceStore.getState().setActiveSession(id);
      useWorkspaceStore.getState().setActiveConnection("fake-conn");
      const opened = await window.nextshell.session.open({
        target: "remote",
        connectionId: "fake-conn",
        sessionId: id
      });
      useWorkspaceStore.getState().upsertSession({ ...opened, title: tabTitle });
      useWorkspaceStore.getState().setActiveSession(id);
      return id;
    }, title);
  };

  const clickTab = async (title) => {
    await page.locator(".session-tab", { hasText: title }).first().click();
    await page.waitForTimeout(300);
  };

  const focusTerminal = async () => {
    await page.locator(".terminal-shell .xterm").first().click({ position: { x: 200, y: 100 } });
    await page.waitForTimeout(100);
  };

  // Real keystrokes through xterm's key handling — not session.write — so the
  // input path is exercised too.
  const typeLine = async (text) => {
    await page.keyboard.type(text, { delay: 15 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(120);
  };

  const idA = await openSession("tab-A");
  await page.waitForTimeout(600);
  const idB = await openSession("tab-B");
  await page.waitForTimeout(600);

  await clickTab("tab-A");
  await focusTerminal();
  await typeLine("echo hello-from-A");
  await typeLine("seq 200");
  await typeLine("echo A-final-marker");
  await page.waitForTimeout(300);
  await shot("01-tabA-after-typing");

  await clickTab("tab-B");
  await page.waitForTimeout(500);
  await shot("02-tabB-after-switch");

  await focusTerminal();
  await typeLine("echo CANARY-B");
  await page.waitForTimeout(400);
  await shot("03-tabB-after-typing");

  await clickTab("tab-A");
  await page.waitForTimeout(500);
  await shot("04-tabA-after-return");

  const diag = await page.evaluate(() => ({
    ackCount: window.__fakeState.ackLog.length,
    lastAcks: window.__fakeState.ackLog.slice(-5),
    shells: Array.from(window.__fakeState.shells.keys())
  }));

  return { idA, idB, diag, errors: globalThis.__nsErrors ?? [] };
}
