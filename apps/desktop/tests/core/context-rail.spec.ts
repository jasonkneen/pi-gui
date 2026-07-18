import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";
import { appendMessagesToSessionFile, sessionFilePathFromCatalog } from "../helpers/session-file";

const TURN_COUNT = 6;

test("context rail lists prompts and scrolls to a turn; timing markers render", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("context-rail-workspace");

  const firstRun = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  let workspaceId = "";
  let sessionId = "";
  try {
    const window = await firstRun.firstWindow();
    await createNamedThread(window, "Context rail session");
    const state = await getDesktopState(window);
    workspaceId = state.selectedWorkspaceId;
    sessionId = state.selectedSessionId;
  } finally {
    await firstRun.close();
  }

  const sessionFilePath = await sessionFilePathFromCatalog(userDataDir, { workspaceId, sessionId });
  const base = Date.now();
  const messages = [];
  for (let turn = 0; turn < TURN_COUNT; turn += 1) {
    const turnStart = base + turn * 60_000;
    messages.push({ role: "user" as const, text: `PROMPT ${turn} unique-marker-${turn}`, timestampMs: turnStart });
    messages.push({
      role: "assistant" as const,
      text: `Answer for turn ${turn}. ${"padding ".repeat(120)}`,
      timestampMs: turnStart + 8_000,
    });
  }
  await appendMessagesToSessionFile(sessionFilePath, messages);

  const run = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await run.firstWindow();
    await run.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setBounds({ x: 40, y: 40, width: 1500, height: 950 });
    });
    await waitForWorkspaceByPath(window, workspacePath);
    await expect(window.getByTestId("transcript")).toBeVisible({ timeout: 15_000 });

    // Timing markers derived from the 8s prompt->answer spans.
    await expect(window.getByTestId("timeline-turn-marker").first()).toContainText("Worked for 8s", {
      timeout: 10_000,
    });

    const rail = window.getByTestId("timeline-context-rail");
    await expect(rail).toBeVisible();
    const items = window.getByTestId("timeline-context-rail-item");
    await expect(items).toHaveCount(TURN_COUNT);

    // The rail sits in the outer margin: the transcript keeps its full 768px
    // measure even while the rail is present beside it.
    const measure = await window.getByTestId("transcript").evaluate((el) => (el as HTMLElement).clientWidth);
    expect(measure).toBe(768);

    const pane = window.getByTestId("timeline-pane");
    // Start pinned at the bottom, then jump to the first prompt via the rail.
    await pane.evaluate((el) => {
      (el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight;
    });
    const bottomScrollTop = await pane.evaluate((el) => (el as HTMLElement).scrollTop);
    expect(bottomScrollTop).toBeGreaterThan(50);

    await items.first().click();
    await expect
      .poll(async () => pane.evaluate((el) => (el as HTMLElement).scrollTop), { timeout: 5_000 })
      .toBeLessThan(bottomScrollTop / 2);

    const firstPromptRow = window.locator('[data-message-id]', { hasText: "PROMPT 0 unique-marker-0" });
    await expect(firstPromptRow).toBeInViewport();

    // The topbar toggle hides the rail even on this wide viewport, while the
    // transcript keeps its 768px measure.
    await window.getByRole("button", { name: "Hide prompt navigation" }).click();
    await expect(rail).toBeHidden();
    const measureAfterHide = await window
      .getByTestId("transcript")
      .evaluate((el) => (el as HTMLElement).clientWidth);
    expect(measureAfterHide).toBe(768);
  } finally {
    await run.close();
  }

  // The hidden preference persists across a restart.
  const rerun = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await rerun.firstWindow();
    await rerun.electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setBounds({ x: 40, y: 40, width: 1500, height: 950 });
    });
    await waitForWorkspaceByPath(window, workspacePath);
    await expect(window.getByTestId("transcript")).toBeVisible({ timeout: 15_000 });
    await expect(window.getByTestId("timeline-context-rail")).toBeHidden();

    // Toggling back on restores it.
    await window.getByRole("button", { name: "Show prompt navigation" }).click();
    await expect(window.getByTestId("timeline-context-rail")).toBeVisible();
  } finally {
    await rerun.close();
  }
});
