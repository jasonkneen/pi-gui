import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  launchDesktopByExecutable,
  makeUserDataDir,
  makeWorkspace,
  resolveAppBundleExecutable,
  writeProjectExtension,
} from "../helpers/electron-app";
import {
  assertComputerUseExtensionSurface,
  disabledMentionExtensionSource,
} from "./computer-use-extension-surface-assertions";

const installedAppBundle = "/Applications/pi-gui.app";

test("installed app presents Computer Use and actionable extension mentions", async () => {
  test.setTimeout(60_000);

  const userDataDir = await makeUserDataDir("pi-gui-installed-computer-use-extension-surface-");
  const lockedUseActionLogPath = join(userDataDir, "computer-use-locked-use-actions.log");
  const workspacePath = await makeWorkspace("installed-computer-use-extension-surface");
  const disabledExtensionName = "disabled-mention-extension";
  const disabledExtensionPath = await writeProjectExtension(
    workspacePath,
    `${disabledExtensionName}.ts`,
    disabledMentionExtensionSource,
  );
  const executablePath = await resolveAppBundleExecutable(installedAppBundle);
  const harness = await launchDesktopByExecutable(executablePath, userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: {
      PI_APP_TEST_COMPUTER_USE_LOCKED_USE_ACTION_LOG_PATH: lockedUseActionLogPath,
      PI_GUI_COMPUTER_USE_HELPER_PATH: undefined,
      PI_GUI_COMPUTER_USE_LOCKED_USE_INSTALLER_PATH: undefined,
    },
  });

  try {
    const window = await harness.firstWindow();
    await expect
      .poll(async () =>
        harness.electronApp.evaluate(() => ({
          defaultApp: Boolean(process.defaultApp),
          execPath: process.execPath,
        })),
      )
      .toEqual({
        defaultApp: false,
        execPath: executablePath,
      });
    await assertComputerUseExtensionSurface(window, workspacePath, "Installed extension mentions", {
      disabledExtensionName,
      disabledExtensionPath,
      lockedUseActionLogPath,
    });
  } finally {
    await harness.close();
  }
});
