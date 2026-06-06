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

async function browserWindowIndexForPage(harness: DesktopHarness, source: Page): Promise<number> {
  const marker = `pi-gui-window-${Date.now()}-${Math.random()}`;
  await source.evaluate((value) => {
    Object.assign(window, { __piGuiTestWindowMarker: value });
  }, marker);
  const index = await harness.electronApp.evaluate(async ({ BrowserWindow }, value) => {
    const windows = BrowserWindow.getAllWindows();
    for (const [candidateIndex, candidateWindow] of windows.entries()) {
      const candidateMarker = await candidateWindow.webContents
        .executeJavaScript("window.__piGuiTestWindowMarker", true)
        .catch(() => undefined);
      if (candidateMarker === value) {
        return candidateIndex;
      }
    }
    return -1;
  }, marker);
  if (index === -1) {
    throw new Error("Expected source page to belong to the Electron app.");
  }
  return index;
}

async function openWindowViaShortcut(harness: DesktopHarness, source: Page): Promise<Page> {
  const existing = new Set(harness.electronApp.windows());
  const sourceIndex = await browserWindowIndexForPage(harness, source);
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

async function openWindowViaSecondInstanceEvent(harness: DesktopHarness, source?: Page): Promise<Page> {
  const existing = new Set(harness.electronApp.windows());
  const sourceIndex = source ? await browserWindowIndexForPage(harness, source) : -1;
  await harness.electronApp.evaluate(({ app, BrowserWindow }, index) => {
    if (index >= 0) {
      const window = BrowserWindow.getAllWindows()[index];
      window?.show();
      window?.focus();
      window?.emit("focus");
    }
    app.emit("second-instance");
  }, sourceIndex);
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

test("selects an empty workspace from the sidebar row", async () => {
  const userDataDir = await makeUserDataDir();
  const alphaPath = await makeWorkspace("empty-workspace-alpha");
  const betaPath = await makeWorkspace("empty-workspace-beta");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [alphaPath, betaPath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, alphaPath);
    await waitForWorkspaceByPath(window, betaPath);

    await window.locator(".workspace-row__select", { hasText: basename(betaPath) }).click();
    await expect.poll(() => selectedSummary(window), { timeout: 15_000 }).toEqual({
      workspacePath: betaPath,
      sessionTitle: "",
    });
    await expect(window.locator(".topbar__workspace")).toContainText(basename(betaPath));
    await expect(window.getByRole("heading", { name: basename(betaPath), exact: true })).toBeVisible();
  } finally {
    await harness.close();
  }
});

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

    const thirdWindow = await openWindowViaSecondInstanceEvent(harness, firstWindow);
    await expectSelected(thirdWindow, alphaPath, "Alpha thread");
    await waitForWindowCount(harness, 3);
  } finally {
    await harness.close();
  }
});

test("keeps a background window composer draft when another window changes selection", async () => {
  test.setTimeout(120_000);

  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("multi-window-draft-sync");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const workspaceName = basename(workspacePath);
    const firstWindow = await harness.firstWindow();
    await waitForWorkspaceByPath(firstWindow, workspacePath);

    await createNamedThread(firstWindow, "Draft source one", { workspaceName });
    await createNamedThread(firstWindow, "Draft target two", { workspaceName });
    await createNamedThread(firstWindow, "Draft source three", { workspaceName });
    await selectSession(firstWindow, "Draft source one");

    const secondWindow = await openWindowViaShortcut(harness, firstWindow);
    await selectSession(secondWindow, "Draft target two");
    await expectSelected(firstWindow, workspacePath, "Draft source one");
    await expectSelected(secondWindow, workspacePath, "Draft target two");

    const secondComposer = secondWindow.getByTestId("composer");
    const unsavedDraft = "unsaved background draft";
    await secondComposer.fill(unsavedDraft);
    await expect(secondComposer).toHaveValue(unsavedDraft);

    await selectSession(firstWindow, "Draft source three");
    await expectSelected(firstWindow, workspacePath, "Draft source three");
    await expectSelected(secondWindow, workspacePath, "Draft target two");
    await secondWindow.waitForTimeout(500);
    await expect(secondComposer).toHaveValue(unsavedDraft);
  } finally {
    await harness.close();
  }
});
