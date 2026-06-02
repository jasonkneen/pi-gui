import { expect, type Page } from "@playwright/test";
import type { DesktopComputerUseStatus } from "../../src/ipc";
import {
  cursorActivityLabel,
  cursorLabel,
  durationLabel,
  lockedUseActionLabel,
  lockedUseInstallerLabel,
  lockedUseLabel,
} from "../../src/settings-computer-use-section";
import { createSessionViaIpc, selectSession, waitForWorkspaceByPath } from "../helpers/electron-app";

interface ComputerUseExtensionSurfaceOptions {
  readonly disabledExtensionPath?: string;
  readonly disabledExtensionName?: string;
}

export async function assertComputerUseExtensionSurface(
  window: Page,
  workspacePath: string,
  sessionTitle: string,
  options: ComputerUseExtensionSurfaceOptions = {},
): Promise<void> {
  await waitForWorkspaceByPath(window, workspacePath);
  if (options.disabledExtensionPath) {
    await waitForRuntimeExtension(window, workspacePath, options.disabledExtensionPath);
    await setRuntimeExtensionEnabled(window, workspacePath, options.disabledExtensionPath, false);
    await expectExtensionEnabledState(window, workspacePath, options.disabledExtensionPath, false);
  }

  await window.getByRole("button", { name: "Extensions", exact: true }).click();
  await expect(window.getByTestId("extensions-surface")).toBeVisible();

  const extensionsList = window.getByTestId("extensions-list");
  const computerUseCard = extensionsList.getByRole("button", {
    name: /Computer Use.*Built-in.*top-level/i,
  });
  await expect(computerUseCard).toBeVisible();
  await computerUseCard.click();

  const detail = window.locator(".skill-detail");
  await expect(detail).toContainText("Computer Use");
  await expect(detail).toContainText("Built-in");
  await expect(detail).toContainText("top-level");
  await expect(detail).not.toContainText("temporary");
  await expect(window.getByRole("button", { name: "Open folder", exact: true })).toHaveCount(0);
  await expect(window.getByRole("button", { name: "Disable", exact: true })).toHaveCount(0);
  await window.getByRole("button", { name: "Open Computer Use settings", exact: true }).click();
  await expect(window.getByTestId("settings-surface")).toBeVisible();
  await expect(window.locator(".settings-view")).toContainText("Computer Use");
  await expect(window.locator(".settings-view")).toContainText("Locked computer use");
  await assertComputerUseSettingsMatchesRealStatus(window);
  await window.getByRole("button", { name: "Back to app", exact: true }).click();

  await createSessionViaIpc(window, workspacePath, sessionTitle);
  await selectSession(window, sessionTitle);

  const composer = window.getByTestId("composer");
  await expect(composer).toBeVisible();
  await composer.fill("@comp");

  const mentionMenu = window.getByTestId("mention-menu");
  await expect(mentionMenu).toBeVisible();
  await expect(mentionMenu.locator(".mention-menu__section-title").first()).toHaveText("Extensions");
  await expect(mentionMenu.locator(".mention-menu__section").first()).toContainText("Computer Use");
  await expect(mentionMenu.locator(".mention-menu__section").first()).not.toContainText("temporary");

  if (options.disabledExtensionPath && options.disabledExtensionName) {
    await composer.fill(`@${options.disabledExtensionName.slice(0, 4)}`);
    const extensionsSection = mentionMenu.locator(".mention-menu__section").first();
    await expect(mentionMenu.locator(".mention-menu__section-title").first()).toHaveText("Extensions");
    await expect(extensionsSection).toContainText(options.disabledExtensionName);
    await expect(extensionsSection).toContainText("Disabled");

    const enableButton = extensionsSection.getByRole("button", {
      name: new RegExp(`Enable ${escapeRegExp(options.disabledExtensionName)}`),
    });
    await expect(enableButton).toBeVisible();
    await enableButton.click();
    await expectExtensionEnabledState(window, workspacePath, options.disabledExtensionPath, true);
    await expect(composer).toHaveValue(`@${options.disabledExtensionName} `);
  }
}

export const disabledMentionExtensionSource = String.raw`
export default function disabledMentionExtension(pi) {
  pi.registerCommand("disabled-mention-demo", {
    description: "Command used to prove disabled extension mention recovery",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Disabled mention demo", "info");
    },
  });
}
`;

async function waitForRuntimeExtension(window: Page, workspacePath: string, extensionPath: string): Promise<void> {
  await expect
    .poll(async () => findRuntimeExtension(window, workspacePath, extensionPath) !== undefined, { timeout: 15_000 })
    .toBe(true);
}

async function expectExtensionEnabledState(
  window: Page,
  workspacePath: string,
  extensionPath: string,
  enabled: boolean,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastDebug: Awaited<ReturnType<typeof getRuntimeExtensionDebug>> | undefined;
  while (Date.now() < deadline) {
    lastDebug = await getRuntimeExtensionDebug(window, workspacePath, extensionPath);
    if (lastDebug.extension?.enabled === enabled) {
      return;
    }
    await window.waitForTimeout(250);
  }

  throw new Error(
    `Expected extension ${extensionPath} enabled=${String(enabled)}; last runtime state: ${JSON.stringify(
      lastDebug,
      null,
      2,
    )}`,
  );
}

async function findRuntimeExtension(window: Page, workspacePath: string, extensionPath: string) {
  return (await getRuntimeExtensionDebug(window, workspacePath, extensionPath)).extension;
}

async function getRuntimeExtensionDebug(window: Page, workspacePath: string, extensionPath: string) {
  const targetDisplayName = inferExtensionEntryName(extensionPath);
  return window.evaluate(
    async ({ targetWorkspacePath, targetExtensionPath, targetDisplayName }) => {
      const app = (globalThis as typeof globalThis & { piApp?: unknown }).piApp as
        | {
            getState(): Promise<{
              workspaces: readonly { id: string; path: string }[];
              runtimeByWorkspace: Record<
                string,
                { extensions?: readonly { path: string; displayName: string; enabled: boolean }[] }
              >;
            }>;
          }
        | undefined;
      if (!app) {
        throw new Error("piApp IPC bridge is unavailable");
      }
      const state = await app.getState();
      const normalizePath = (value: string) => value.replace(/^\/private\/var\//, "/var/");
      const workspace = state.workspaces.find(
        (entry) => normalizePath(entry.path) === normalizePath(targetWorkspacePath),
      );
      if (!workspace) {
        return {
          workspace: undefined,
          extension: undefined,
          workspaces: state.workspaces.map((entry) => ({ id: entry.id, path: entry.path })),
          extensions: [],
        };
      }

      const extensions = state.runtimeByWorkspace[workspace.id]?.extensions ?? [];
      const exactPathMatch = extensions.find((entry) => normalizePath(entry.path) === normalizePath(targetExtensionPath));
      const displayNameMatches = extensions.filter((entry) => entry.displayName === targetDisplayName);
      const extension = exactPathMatch ?? (displayNameMatches.length === 1 ? displayNameMatches[0] : undefined);
      return {
        workspace: { id: workspace.id, path: workspace.path },
        extension,
        workspaces: state.workspaces.map((entry) => ({ id: entry.id, path: entry.path })),
        extensions: extensions.map((entry) => ({
          path: entry.path,
          displayName: entry.displayName,
          enabled: entry.enabled,
        })),
      };
    },
    { targetWorkspacePath: workspacePath, targetExtensionPath: extensionPath, targetDisplayName },
  );
}

function inferExtensionEntryName(filePath: string): string {
  return (filePath.split(/[\\/]/).pop() ?? filePath).replace(/\.(c|m)?(t|j)sx?$/i, "");
}

async function setRuntimeExtensionEnabled(
  window: Page,
  workspacePath: string,
  extensionPath: string,
  enabled: boolean,
): Promise<void> {
  await window.evaluate(
    async ({ targetWorkspacePath, targetExtensionPath, targetEnabled }) => {
      const app = (globalThis as any).piApp;
      if (!app) {
        throw new Error("piApp IPC bridge is unavailable");
      }
      const state = await app.getState();
      const workspace = state.workspaces.find((entry: { path: string }) => entry.path === targetWorkspacePath);
      if (!workspace) {
        throw new Error(`Workspace not found: ${targetWorkspacePath}`);
      }
      await app.setExtensionEnabled(workspace.id, targetExtensionPath, targetEnabled);
    },
    { targetWorkspacePath: workspacePath, targetExtensionPath: extensionPath, targetEnabled: enabled },
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function assertComputerUseSettingsMatchesRealStatus(window: Page): Promise<void> {
  const status = await getComputerUseStatus(window);
  const settings = window.locator(".settings-view");
  const helperRow = settingsRow(window, "Helper");
  await expect(helperRow).toContainText(status.helperAvailable ? "Available" : "Unavailable");
  if (status.frontmostApp) {
    await expect(settingsRow(window, "Frontmost app")).toContainText(status.frontmostApp);
  }
  await expect(settingsRow(window, "Agent cursor")).toContainText(cursorLabel(status.cursor));
  if (status.cursorActive) {
    await expect(settingsRow(window, "Cursor overlay")).toContainText(cursorActivityLabel(status.cursorActive));
  }
  if (status.cursorDurationMs) {
    await expect(settingsRow(window, "Cursor hold")).toContainText(durationLabel(status.cursorDurationMs));
  }
  if (status.cursorGlideMs !== undefined) {
    await expect(settingsRow(window, "Cursor glide")).toContainText(durationLabel(status.cursorGlideMs));
  }

  const lockedUseRow = settingsRow(window, "Locked computer use");
  await expect(lockedUseRow).toContainText(lockedUseLabel(status.lockedUse));
  const lockedUseAction = lockedUseActionLabel(status);
  if (lockedUseAction) {
    await expect(lockedUseRow.getByRole("button", { name: lockedUseAction, exact: true })).toBeVisible();
  } else {
    await expect(lockedUseRow.getByRole("button")).toHaveCount(0);
  }

  await expect(settingsRow(window, "Locked setup")).toContainText(lockedUseInstallerLabel(status.lockedUseInstaller));
  if (status.message) {
    await expect(settingsRow(window, "Details")).toContainText(status.message);
  }
}

async function getComputerUseStatus(window: Page): Promise<DesktopComputerUseStatus> {
  return window.evaluate(async () => {
    const app = (globalThis as typeof globalThis & { piApp?: unknown }).piApp as
      | { getComputerUseStatus(): Promise<DesktopComputerUseStatus> }
      | undefined;
    if (!app) {
      throw new Error("piApp IPC bridge is unavailable");
    }
    return app.getComputerUseStatus();
  });
}

function settingsRow(window: Page, title: string) {
  return window.locator(".settings-row").filter({
    has: window.locator(".settings-row__title", { hasText: new RegExp(`^${escapeRegExp(title)}$`) }),
  });
}
