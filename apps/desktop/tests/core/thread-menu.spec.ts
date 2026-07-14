import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  persistedSessionDataPaths,
} from "../helpers/electron-app";
import { appendMessagesToSessionFile, sessionFilePathFromCatalog } from "../helpers/session-file";

const proofDir = process.env.PI_APP_THREAD_MENU_PROOF_DIR;

async function captureProof(window: Page, filename: string): Promise<void> {
  if (!proofDir) return;
  await mkdir(proofDir, { recursive: true });
  await window.screenshot({ path: join(proofDir, filename) });
}

test("thread menu supports rename, archive/restore, mark read, copy id, and right click", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("thread-menu-workspace");
  const firstRun = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  let target: { workspaceId: string; sessionId: string } | undefined;
  try {
    const window = await firstRun.firstWindow();
    await createNamedThread(window, "Thread menu target");
    const state = await getDesktopState(window);
    target = { workspaceId: state.selectedWorkspaceId, sessionId: state.selectedSessionId };
    await createNamedThread(window, "Other active thread");
  } finally {
    await firstRun.close();
  }

  expect(target).toBeDefined();
  const uiStatePath = join(userDataDir, "ui-state.json");
  const uiState = JSON.parse(await readFile(uiStatePath, "utf8")) as {
    lastViewedAtBySession?: Record<string, string>;
  };
  const { rawSessionKey } = persistedSessionDataPaths(userDataDir, target!);
  const activityAt = Date.now() + 5 * 60_000;
  await appendMessagesToSessionFile(await sessionFilePathFromCatalog(userDataDir, target!), [
    { role: "assistant", text: "Unread menu activity", timestampMs: activityAt },
  ]);
  await writeFile(
    uiStatePath,
    `${JSON.stringify({
      ...uiState,
      lastViewedAtBySession: {
        ...(uiState.lastViewedAtBySession ?? {}),
        [rawSessionKey]: new Date(activityAt - 1_000).toISOString(),
      },
    }, null, 2)}\n`,
    "utf8",
  );

  const harness = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await harness.firstWindow();
    let row = window.locator(".session-row", { hasText: "Thread menu target" }).first();
    await expect(row).toHaveAttribute("data-sidebar-indicator", "unseen");

    await row.click({ button: "right" });
    const menu = row.getByRole("menu");
    await expect(menu.getByRole("button", { name: "Rename thread" })).toBeVisible();
    await expect(menu.getByRole("button", { name: "Archive" })).toBeVisible();
    await expect(menu.getByRole("button", { name: "Mark as read" })).toBeVisible();
    await expect(menu.getByRole("button", { name: "Copy session id" })).toBeVisible();
    await captureProof(window, "01-open-menu.png");

    await menu.getByRole("button", { name: "Copy session id" }).click();
    await expect.poll(() => window.evaluate(() => navigator.clipboard.readText())).toBe(target!.sessionId);

    await row.click({ button: "right" });
    await row.getByRole("menu").getByRole("button", { name: "Mark as read" }).click();
    await expect(row).toHaveAttribute("data-sidebar-indicator", "none");
    await captureProof(window, "02-marked-read.png");

    row = window.locator(".session-row", { hasText: "Thread menu target" }).first();
    await row.hover();
    await row.locator(".session-row__menu-button").click();
    await row.getByRole("menu").getByRole("button", { name: "Rename thread" }).click();
    const renameInput = window.getByLabel("Rename thread Thread menu target");
    await renameInput.fill("Renamed from menu");
    await window.getByRole("button", { name: "Save" }).click();
    row = window.locator(".session-row", { hasText: "Renamed from menu" }).first();
    await expect(row).toBeVisible();
    await captureProof(window, "03-renamed.png");

    await row.hover();
    await row.locator(".session-row__menu-button").click();
    await row.getByRole("menu").getByRole("button", { name: "Archive" }).click();
    await expect(window.locator(".session-list > .session-row", { hasText: "Renamed from menu" })).toHaveCount(0);
    const archivedToggle = window.locator(".archived-thread-group__toggle");
    await expect(archivedToggle).toBeVisible();
    await captureProof(window, "04-archived.png");

    await archivedToggle.click();
    const archivedRow = window.locator(".session-list--archived .session-row", { hasText: "Renamed from menu" });
    await archivedRow.click({ button: "right" });
    await archivedRow.getByRole("menu").getByRole("button", { name: "Restore" }).click();
    await expect(window.locator(".session-list > .session-row", { hasText: "Renamed from menu" })).toHaveCount(1);
  } finally {
    await harness.close();
  }
});
