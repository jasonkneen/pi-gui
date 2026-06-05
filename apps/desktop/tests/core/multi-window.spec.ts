import { basename } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSession,
  streamAssistantDeltas,
  waitForWorkspaceByPath,
  type DesktopHarness,
  type PiAppWindow,
} from "../helpers/electron-app";

const platformModifier = process.platform === "darwin" ? "meta" : "control";

async function waitForPiApp(window: Page): Promise<void> {
  await window.waitForLoadState("domcontentloaded");
  await window.waitForFunction(() => Boolean((window as PiAppWindow).piApp), undefined, {
    timeout: 15_000,
  });
}

async function waitForWindowCount(harness: DesktopHarness, count: number): Promise<void> {
  await expect
    .poll(
      () =>
        harness.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
      { timeout: 15_000 },
    )
    .toBe(count);
  await expect.poll(() => harness.electronApp.windows().length, { timeout: 15_000 }).toBe(count);
}

async function openWindowViaShortcut(harness: DesktopHarness, source: Page): Promise<Page> {
  const existing = new Set(harness.electronApp.windows());
  const sourceIndex = harness.electronApp.windows().indexOf(source);
  if (sourceIndex === -1) {
    throw new Error("Expected source page to belong to the Electron app.");
  }
  await harness.electronApp.evaluate(({ BrowserWindow }, payload) => {
    BrowserWindow.getAllWindows()[payload.sourceIndex]?.webContents.sendInputEvent({
      type: "keyDown",
      keyCode: "n",
      modifiers: [payload.modifier],
    });
  }, { sourceIndex, modifier: platformModifier });
  await waitForWindowCount(harness, existing.size + 1);
  const opened = harness.electronApp.windows().find((candidate) => !existing.has(candidate));
  if (!opened) {
    throw new Error("Expected Cmd+N to create another Electron window.");
  }
  await waitForPiApp(opened);
  return opened;
}

async function openWindowViaSecondInstanceEvent(harness: DesktopHarness): Promise<Page> {
  const existing = new Set(harness.electronApp.windows());
  await harness.electronApp.evaluate(({ app }) => {
    app.emit("second-instance");
  });
  await waitForWindowCount(harness, existing.size + 1);
  const opened = harness.electronApp.windows().find((candidate) => !existing.has(candidate));
  if (!opened) {
    throw new Error("Expected the singleton second-instance path to create another Electron window.");
  }
  await waitForPiApp(opened);
  return opened;
}

async function selectedSummary(window: Page): Promise<{
  readonly workspacePath: string;
  readonly sessionTitle: string;
}> {
  const state = await getDesktopState(window);
  const workspace = state.workspaces.find((entry) => entry.id === state.selectedWorkspaceId);
  const session = workspace?.sessions.find((entry) => entry.id === state.selectedSessionId);
  return {
    workspacePath: workspace?.path ?? "",
    sessionTitle: session?.title ?? "",
  };
}

async function expectSelected(window: Page, workspacePath: string, sessionTitle: string): Promise<void> {
  await expect.poll(() => selectedSummary(window), { timeout: 15_000 }).toEqual({
    workspacePath,
    sessionTitle,
  });
  await expect(window.locator(".topbar__session")).toHaveText(sessionTitle);
}

test("opens multiple app windows with independent workspace and thread selection", async () => {
  test.setTimeout(120_000);

  const userDataDir = await makeUserDataDir();
  const alphaPath = await makeWorkspace("multi-window-alpha");
  const betaPath = await makeWorkspace("multi-window-beta");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [alphaPath, betaPath],
    testMode: "background",
  });

  try {
    const alphaName = basename(alphaPath);
    const betaName = basename(betaPath);
    const firstWindow = await harness.firstWindow();
    await waitForWorkspaceByPath(firstWindow, alphaPath);
    await waitForWorkspaceByPath(firstWindow, betaPath);

    await createNamedThread(firstWindow, "Alpha thread", { workspaceName: alphaName });
    await createNamedThread(firstWindow, "Beta thread", { workspaceName: betaName });
    await selectSession(firstWindow, "Alpha thread");
    await expectSelected(firstWindow, alphaPath, "Alpha thread");

    const secondWindow = await openWindowViaShortcut(harness, firstWindow);
    await expectSelected(secondWindow, alphaPath, "Alpha thread");

    await selectSession(secondWindow, "Beta thread");
    await expectSelected(secondWindow, betaPath, "Beta thread");
    await expectSelected(firstWindow, alphaPath, "Alpha thread");

    await createNamedThread(secondWindow, "Beta follow-up", { workspaceName: betaName });
    await expectSelected(secondWindow, betaPath, "Beta follow-up");
    await expectSelected(firstWindow, alphaPath, "Alpha thread");
    await expect
      .poll(async () => {
        const state = await getDesktopState(firstWindow);
        return state.workspaces
          .find((workspace) => workspace.path === betaPath)
          ?.sessions.some((session) => session.title === "Beta follow-up") ?? false;
      })
      .toBe(true);

    await selectSession(firstWindow, "Beta follow-up");
    await expectSelected(firstWindow, betaPath, "Beta follow-up");
    await streamAssistantDeltas(harness, firstWindow, ["shared transcript update"]);
    await expect(firstWindow.getByTestId("transcript")).toContainText("shared transcript update");
    await expect(secondWindow.getByTestId("transcript")).toContainText("shared transcript update");

    await selectSession(firstWindow, "Alpha thread");
    await expectSelected(firstWindow, alphaPath, "Alpha thread");
    await expectSelected(secondWindow, betaPath, "Beta follow-up");

    const thirdWindow = await openWindowViaSecondInstanceEvent(harness);
    await expectSelected(thirdWindow, alphaPath, "Alpha thread");
    await waitForWindowCount(harness, 3);
  } finally {
    await harness.close();
  }
});
