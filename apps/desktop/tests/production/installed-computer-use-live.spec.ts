import { expect, test } from "@playwright/test";
import {
  calculatorDisplays,
  clearAgentCursorObservation,
  inputApp,
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
import { getFrontmostAppName, resetAppInBackground } from "../helpers/macos-ui";

const installedAppBundle = "/Applications/pi-gui.app";
const targetApp = "Calculator";
const cursorOverlayArgument = "--cursor-overlay-daemon";

test("installed app runs Computer Use through the real UI without foregrounding the target app", async () => {
  test.setTimeout(240_000);
  const realAuth = getRealAuthConfig();
  test.skip(!realAuth.enabled, realAuth.skipReason);

  const userDataDir = await makeUserDataDir("pi-gui-installed-computer-use-live-");
  const workspacePath = await makeWorkspace("installed-computer-use-live-workspace");
  const executablePath = await resolveAppBundleExecutable(installedAppBundle);
  const enabledModels = await getAvailableRealAuthModelPatterns(realAuth.sourceDir);
  await clearAgentCursorObservation();

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

    const initialFrontmostApp = await getFrontmostAppName();
    test.skip(initialFrontmostApp === targetApp, `${targetApp} is already frontmost; focus-safety result would be ambiguous.`);
    await resetAppInBackground(targetApp);
    await expect.poll(() => getFrontmostAppName(), { timeout: 5_000 }).not.toBe(targetApp);

    await createNamedThread(window, "Installed Computer Use live");
    const composer = window.getByTestId("composer");
    await composer.fill(
      [
        "Use Computer Use to calculate 9+6 in Calculator by clicking the Calculator buttons 9, +, 6, and =.",
        "Do not use type_text or press_key.",
        "Do not open or activate Calculator; it is already running in the background.",
        "After the final Calculator click, call get_app_state and use only the displayed Calculator result from that state.",
        "Reply exactly:",
        "RESULT: <number>",
        "TOOL_ERRORS: <yes/no>",
      ].join("\n"),
    );
    const cursorRequests = waitForDistinctAgentCursorRequests(Date.now() / 1000, 2);
    void cursorRequests.catch(() => undefined);
    await composer.press("Enter");

    const focusSamples: string[] = [];
    const focusSampleErrors: string[] = [];
    let sampleFocus = true;
    const focusProbe = sampleFrontmostApps(focusSamples, focusSampleErrors, () => sampleFocus);
    try {
      const transcript = window.getByTestId("transcript");
      await expect(transcript).toContainText(/RESULT:\s*15/i, { timeout: 210_000 });
      await expect(transcript).toContainText(/TOOL_ERRORS:\s*no/i, { timeout: 210_000 });
      await waitForSelectedSessionIdle(window);

      const toolCalls = await selectedToolCalls(window);
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
      const distinctTargetCount = new Set(observedCursorRequests.map((request) => `${request.x},${request.y}`)).size;
      expect(distinctTargetCount).toBeGreaterThan(1);
      await expect(window.locator(".timeline-tool--error")).toHaveCount(0);
      await expect(transcript).not.toContainText(/terminated/i);
    } finally {
      sampleFocus = false;
      await focusProbe;
    }
    expect(focusSampleErrors).toEqual([]);
    expect(focusSamples.length).toBeGreaterThan(0);
    expect(focusSamples).not.toContain(targetApp);
  } finally {
    await harness.close();
  }
});

async function sampleFrontmostApps(
  samples: string[],
  errors: string[],
  shouldContinue: () => boolean,
): Promise<void> {
  while (shouldContinue()) {
    try {
      samples.push(await getFrontmostAppName());
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
