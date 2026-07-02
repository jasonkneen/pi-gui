import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { launchDesktop, makeUserDataDir, makeWorkspace } from "../helpers/electron-app";

async function readSettingsLog(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

const computerUseHelperPath =
  "/Applications/pi-gui.app/Contents/SharedSupport/pi-gui Computer Use.app/Contents/MacOS/pi-gui-computer-use-helper";
const lockedUseInstallerPath =
  "/Applications/pi-gui.app/Contents/SharedSupport/pi-gui Computer Use.app/Contents/SharedSupport/pi-gui-computer-use-locked-use-installer";

test("shows Computer Use permission and locked-use status in Settings", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("computer-use-settings-workspace");
  const settingsLogPath = join(userDataDir, "computer-use-settings.log");
  const lockedUseActionLogPath = join(userDataDir, "computer-use-locked-use-actions.log");
  const status = {
    helperAvailable: true,
    helperPath: computerUseHelperPath,
    desktop: "locked",
    frontmostApp: "loginwindow",
    cursor: "enabled",
    cursorActive: "inactive",
    cursorDurationMs: 60_000,
    cursorGlideMs: 300,
    accessibility: "denied",
    screenRecording: "denied",
    lockedUse: "not_enabled",
    lockedUseInstaller: "not-installed",
    lockedUseInstallerPath,
    message: "Locked Computer Use requires a guarded macOS authorization plug-in.",
  };
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: {
      PI_APP_TEST_COMPUTER_USE_LOCKED_USE_ACTION_LOG_PATH: lockedUseActionLogPath,
      PI_APP_TEST_COMPUTER_USE_SETTINGS_LOG_PATH: settingsLogPath,
      PI_APP_TEST_COMPUTER_USE_STATUS_JSON: JSON.stringify(status),
      PI_GUI_COMPUTER_USE_LOCKED_USE_INSTALLER_PATH: status.lockedUseInstallerPath,
    },
  });

  try {
    const window = await harness.firstWindow();
    await window.getByRole("button", { name: "Settings", exact: true }).click();
    await window.getByRole("button", { name: "Computer Use", exact: true }).click();

    await expect(window.locator(".settings-view")).toContainText("Helper");
    await expect(window.locator(".settings-view")).toContainText("Available");
    await expect(window.locator(".settings-view")).toContainText("Locked");
    await expect(window.locator(".settings-view")).toContainText("loginwindow");
    await expect(window.locator(".settings-view")).toContainText("Agent cursor");
    await expect(window.locator(".settings-view")).toContainText("Cursor overlay");
    await expect(window.locator(".settings-view")).toContainText("60000ms");
    await expect(window.locator(".settings-view")).toContainText("300ms");
    await expect(window.locator(".settings-view")).toContainText("Not enabled");
    await expect(window.locator(".settings-view")).toContainText("Not installed");
    await expect(window.locator(".settings-view")).toContainText("Turned off");
    await expect(window.locator(".settings-view")).toContainText("Enabled");
    await expect(window.locator(".settings-view")).toContainText("guarded macOS authorization plug-in");

    await window.getByRole("button", { name: "Open Accessibility", exact: true }).click();
    await expect.poll(() => readSettingsLog(settingsLogPath), { timeout: 5_000 }).toContain("accessibility");
    await window.getByRole("button", { name: "Open Screen Recording", exact: true }).click();
    await expect.poll(() => readSettingsLog(settingsLogPath), { timeout: 5_000 }).toContain("screen-recording");

    await window.getByRole("button", { name: "Enable", exact: true }).click();
    await expect.poll(() => readSettingsLog(lockedUseActionLogPath), { timeout: 5_000 }).toContain("install");
  } finally {
    await harness.close();
  }
});

test("hides locked-use setup action when installer is not configured", async () => {
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("computer-use-settings-unconfigured-workspace");
  const status = {
    helperAvailable: true,
    helperPath: computerUseHelperPath,
    desktop: "locked",
    cursor: "unknown",
    accessibility: "granted",
    screenRecording: "granted",
    lockedUse: "not_enabled",
    lockedUseInstaller: "not-configured",
    message: "The installer path is not configured.",
  };
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: {
      PI_APP_TEST_COMPUTER_USE_STATUS_JSON: JSON.stringify(status),
    },
  });

  try {
    const window = await harness.firstWindow();
    await window.getByRole("button", { name: "Settings", exact: true }).click();
    await window.getByRole("button", { name: "Computer Use", exact: true }).click();

    await expect(window.locator(".settings-view")).toContainText("Not configured");
    await expect(window.getByRole("button", { name: "Enable", exact: true })).toHaveCount(0);
  } finally {
    await harness.close();
  }
});

test("shows locked-use enabled and repair actions in Settings", async () => {
  const cases = [
    {
      name: "enabled",
      status: {
        helperAvailable: true,
        helperPath: computerUseHelperPath,
        desktop: "locked",
        cursor: "enabled",
        cursorActive: "inactive",
        accessibility: "granted",
        screenRecording: "granted",
        lockedUse: "enabled",
        lockedUseInstaller: "installed",
        lockedUseInstallerPath,
        message: "Locked Computer Use is enabled.",
      },
      expectedLabel: "Enabled",
      expectedSetup: "Installed",
      actionLabel: "Disable",
      expectedAction: "uninstall",
    },
    {
      name: "partial",
      status: {
        helperAvailable: true,
        helperPath: computerUseHelperPath,
        desktop: "locked",
        cursor: "enabled",
        cursorActive: "inactive",
        accessibility: "granted",
        screenRecording: "granted",
        lockedUse: "not_enabled",
        lockedUseInstaller: "partial",
        lockedUseInstallerPath,
        message: "Locked Computer Use authorization plug-in setup is partially installed.",
      },
      expectedLabel: "Not enabled",
      expectedSetup: "Needs repair",
      actionLabel: "Repair",
      expectedAction: "install",
    },
  ] as const;

  for (const testCase of cases) {
    const userDataDir = await makeUserDataDir();
    const workspacePath = await makeWorkspace(`computer-use-settings-${testCase.name}-workspace`);
    const lockedUseActionLogPath = join(userDataDir, "computer-use-locked-use-actions.log");
    const harness = await launchDesktop(userDataDir, {
      initialWorkspaces: [workspacePath],
      testMode: "background",
      envOverrides: {
        PI_APP_TEST_COMPUTER_USE_LOCKED_USE_ACTION_LOG_PATH: lockedUseActionLogPath,
        PI_APP_TEST_COMPUTER_USE_STATUS_JSON: JSON.stringify(testCase.status),
        PI_GUI_COMPUTER_USE_LOCKED_USE_INSTALLER_PATH: testCase.status.lockedUseInstallerPath,
      },
    });

    try {
      const window = await harness.firstWindow();
      await window.getByRole("button", { name: "Settings", exact: true }).click();
      await window.getByRole("button", { name: "Computer Use", exact: true }).click();

      await expect(settingsRow(window, "Locked computer use")).toContainText(testCase.expectedLabel);
      await expect(settingsRow(window, "Locked setup")).toContainText(testCase.expectedSetup);
      await expect(settingsRow(window, "Details")).toContainText(testCase.status.message);

      await settingsRow(window, "Locked computer use")
        .getByRole("button", { name: testCase.actionLabel, exact: true })
        .click();
      await expect
        .poll(() => readSettingsLog(lockedUseActionLogPath), { timeout: 5_000 })
        .toContain(testCase.expectedAction);
    } finally {
      await harness.close();
    }
  }
});

function settingsRow(window: Page, title: string) {
  return window.locator(".settings-row").filter({
    has: window.locator(".settings-row__title", { hasText: new RegExp(`^${escapeRegExp(title)}$`) }),
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
