import { expect, test, type Page } from "@playwright/test";
import {
  calculatorDisplays,
  clearAgentCursorObservation,
  inputApp,
  isComputerUseTool,
  selectedToolCalls,
  toolOutputText,
  waitForDistinctAgentCursorRequests,
  waitForSelectedSessionIdle,
} from "./computer-use-live-assertions";
import {
  createNamedThread,
  getAvailableRealAuthModelPatterns,
  getRealAuthConfig,
  launchDesktopByExecutable,
  makeUserDataDir,
  makeWorkspace,
  resolveAppBundleExecutable,
} from "../helpers/electron-app";
import {
  getDesktopLockState,
  lockDesktop,
  resetAppInBackground,
  waitForDesktopLocked,
} from "../helpers/macos-ui";

const installedAppBundle = "/Applications/pi-gui.app";
const targetApp = "Calculator";
const cursorOverlayArgument = "--cursor-overlay-daemon";
const lockScreenE2eEnvVar = "PI_APP_LOCK_SCREEN_E2E";

test("installed app completes a real Computer Use turn after the desktop locks", async () => {
  test.setTimeout(360_000);
  test.skip(process.env[lockScreenE2eEnvVar] !== "1", `Set ${lockScreenE2eEnvVar}=1 to allow this spec to lock the desktop.`);
  const realAuth = getRealAuthConfig();
  test.skip(!realAuth.enabled, realAuth.skipReason);

  await expect.poll(() => getDesktopLockState(), { timeout: 10_000 }).toBe("unlocked");
  const userDataDir = await makeUserDataDir("pi-gui-installed-computer-use-locked-live-");
  const workspacePath = await makeWorkspace("installed-computer-use-locked-live-workspace");
  const executablePath = await resolveAppBundleExecutable(installedAppBundle);
  const enabledModels = await getAvailableRealAuthModelPatterns(realAuth.sourceDir);
  await clearAgentCursorObservation();
  await resetAppInBackground(targetApp);

  const harness = await launchDesktopByExecutable(executablePath, userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    realAuthSourceDir: realAuth.sourceDir,
    enabledModels,
    envOverrides: {
      PI_GUI_DISABLE_BUILTIN_COMPUTER_USE: undefined,
      PI_GUI_COMPUTER_USE_ALLOW_PHYSICAL_INPUT: "0",
      PI_GUI_COMPUTER_USE_AUTO_ALLOW: "1",
      PI_GUI_COMPUTER_USE_CURSOR_DURATION_MS: undefined,
      PI_GUI_COMPUTER_USE_CURSOR_GLIDE_MS: undefined,
      PI_GUI_COMPUTER_USE_HELPER_PATH: undefined,
      PI_GUI_COMPUTER_USE_LOCKED_USE_INSTALLER_PATH: undefined,
      PI_GUI_COMPUTER_USE_SHOW_CURSOR: undefined,
      PI_GUI_COMPUTER_USE_TEST_FORBID_MOUSE_WARP: "1",
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

    await createNamedThread(window, "Installed locked Computer Use live");
    const composer = window.getByTestId("composer");
    await composer.fill(
      [
        "First use your bash tool to run this exact script:",
        "printf 'LOCK_WINDOW_START\\n'",
        "sleep 45",
        "printf 'LOCK_WINDOW_DONE\\n'",
        "",
        "Only after that command completes, use Computer Use to calculate 8+7 in Calculator by clicking the Calculator buttons 8, +, 7, and =.",
        "Do not use type_text or press_key for Calculator.",
        "Do not open or activate Calculator; it is already running in the background.",
        "After the final Calculator click, call get_app_state and use only the displayed Calculator result from that state.",
        "Reply exactly:",
        "RESULT: <number>",
        "TOOL_ERRORS: <yes/no>",
      ].join("\n"),
    );
    const cursorRequests = waitForDistinctAgentCursorRequests(Date.now() / 1000, 2, {
      timeoutMs: 270_000,
      failureLabel: "Installed locked Computer Use live run",
    });
    void cursorRequests.catch(() => undefined);
    await composer.press("Enter");

    await waitForDelayToolToBeRunning(window);
    await lockDesktop();
    await waitForDesktopLocked();
    await waitForDelayToolToBeRunning(window, 5_000);
    const lockedAt = new Date();

    const transcript = window.getByTestId("transcript");
    await expect(transcript).toContainText(/RESULT:\s*15/i, { timeout: 270_000 });
    await expect(transcript).toContainText(/TOOL_ERRORS:\s*no/i, { timeout: 270_000 });
    await waitForSelectedSessionIdle(window, 270_000);

    const toolCalls = await selectedToolCalls(window);
    expect(toolCalls.some((call) => toolOutputText(call.output).includes("LOCK_WINDOW_DONE"))).toBe(true);
    expect(toolCalls.some((call) => isComputerUseTool(call) && Date.parse(call.createdAt) > lockedAt.getTime())).toBe(true);
    expect(toolCalls.filter((call) => call.toolName === "click" && inputApp(call.input) === targetApp).length).toBeGreaterThanOrEqual(4);
    expect(
      toolCalls.some(
        (call) =>
          call.toolName === "get_app_state" &&
          call.status === "success" &&
          inputApp(call.input) === targetApp &&
          calculatorDisplays(toolOutputText(call.output), "15"),
      ),
    ).toBe(true);
    expect(toolCalls.some((call) => call.toolName === "type_text")).toBe(false);
    expect(toolCalls.some((call) => call.toolName === "press_key")).toBe(false);
    const observedCursorRequests = await cursorRequests;
    expect(new Set(observedCursorRequests.map((request) => request.pid)).size).toBe(1);
    expect(observedCursorRequests.at(-1)?.pressed).toBe(false);
    expect(observedCursorRequests[0]?.pid).toBeGreaterThan(0);
    expect(observedCursorRequests[0]?.command).toContain(cursorOverlayArgument);
    expect(new Set(observedCursorRequests.map((request) => `${request.x},${request.y}`)).size).toBeGreaterThan(1);
    await expect(window.locator(".timeline-tool--error")).toHaveCount(0);
    await expect(transcript).not.toContainText(/terminated/i);
    await expect.poll(() => getDesktopLockState(), { timeout: 60_000 }).toBe("locked");
  } finally {
    await harness.close();
  }
});

async function waitForDelayToolToBeRunning(window: Page, timeout = 90_000): Promise<void> {
  await expect
    .poll(
      async () =>
        (await selectedToolCalls(window)).some(
          (call) =>
            call.status === "running" &&
            (call.toolName === "bash" || call.toolName === "shell" || JSON.stringify(call.input ?? {}).includes("LOCK_WINDOW_START")),
        ),
      { timeout },
    )
    .toBe(true);
}
