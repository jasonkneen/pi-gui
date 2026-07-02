import { expect, test } from "@playwright/test";
import {
  launchDesktopByExecutable,
  makeUserDataDir,
  makeWorkspace,
  resolveAppBundleExecutable,
  runComputerUseLockedUseSelfTest,
} from "../helpers/electron-app";

const installedAppBundle = "/Applications/pi-gui.app";
const helperAppName = "pi-gui Computer Use.app";

const installedComputerUseEnvOverrides = {
  PI_GUI_DISABLE_BUILTIN_COMPUTER_USE: undefined,
  PI_GUI_COMPUTER_USE_HELPER_PATH: undefined,
  PI_GUI_COMPUTER_USE_LOCKED_USE_APP_TOKEN: undefined,
  PI_GUI_COMPUTER_USE_LOCKED_USE_AUTH_SOCKET: undefined,
  PI_GUI_COMPUTER_USE_LOCKED_USE_INSTALLER_PATH: undefined,
} as const;

test("installed app completes the locked-use active-turn self-test through its trusted desktop process", async () => {
  test.setTimeout(60_000);

  const userDataDir = await makeUserDataDir("pi-gui-installed-computer-use-locked-use-");
  const workspacePath = await makeWorkspace("installed-computer-use-locked-use-workspace");
  const executablePath = await resolveAppBundleExecutable(installedAppBundle);
  const harness = await launchDesktopByExecutable(executablePath, userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: installedComputerUseEnvOverrides,
  });

  try {
    const result = await runComputerUseLockedUseSelfTest(harness);
    expect(result.helperPath).toContain(helperAppName);
    expect(result.helperPath).toContain("/Applications/pi-gui.app/Contents/SharedSupport/");
    expect(result.desktopPath).toBe(executablePath);
    expect(result.authorizationSocket).toContain("/tmp/pi-gui-cu/auth-");
    expect(result.authorizationProbe.ok).toBe(true);
    expect(result.authorizationProbe.details?.lockedUseAuthorizationService).toBe("ok");
    expect(result.authorizationProbe.details?.authorizationResponse).toBe("ALLOW");
    expect(result.begin.ok).toBe(true);
    expect(result.begin.details?.lockedUse).toBe("enabled");
    expect(result.begin.details?.lockedUseLease).toBe("auto_unlocked");
    expect(result.begin.details?.screenLocked).toBe("false");
    expect(result.end.ok).toBe(true);
    expect(result.end.details?.lockedUseLease).toBe("ended");
    expect(result.end.details?.relockRequested).toBe("false");
  } finally {
    await harness.close();
  }
});
