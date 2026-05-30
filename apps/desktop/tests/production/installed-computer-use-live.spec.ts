import { expect, test, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  createNamedThread,
  getDesktopState,
  getRealAuthConfig,
  getSelectedTranscript,
  launchDesktopByExecutable,
  makeUserDataDir,
  makeWorkspace,
  resolveAppBundleExecutable,
} from "../helpers/electron-app";
import type { TimelineToolCall } from "../../src/timeline-types";
import { getFrontmostAppName, resetAppInBackground } from "../helpers/macos-ui";

const installedAppBundle = "/Applications/pi-gui.app";
const targetApp = "Calculator";
const helperExecutableName = "pi-gui-computer-use-helper";
const cursorOverlayArgument = "--cursor-overlay-daemon";
const cursorPositionPath = join(tmpdir(), "pi-gui-computer-use-agent-cursor-position");
const cursorPidPath = join(tmpdir(), "pi-gui-computer-use-agent-cursor.pid");
const execFileAsync = promisify(execFile);

test("installed app runs Computer Use through the real UI without foregrounding the target app", async () => {
  test.setTimeout(240_000);
  const realAuth = getRealAuthConfig();
  test.skip(!realAuth.enabled, realAuth.skipReason);

  const userDataDir = await makeUserDataDir("pi-gui-installed-computer-use-live-");
  const workspacePath = await makeWorkspace("installed-computer-use-live-workspace");
  const executablePath = await resolveAppBundleExecutable(installedAppBundle);
  await rm(cursorPositionPath, { force: true });
  await rm(cursorPidPath, { force: true });

  const harness = await launchDesktopByExecutable(executablePath, userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    realAuthSourceDir: realAuth.sourceDir,
    envOverrides: {
      PI_GUI_DISABLE_BUILTIN_COMPUTER_USE: undefined,
      PI_GUI_COMPUTER_USE_ALLOW_PHYSICAL_INPUT: "0",
      PI_GUI_COMPUTER_USE_AUTO_ALLOW: "1",
      PI_GUI_COMPUTER_USE_CURSOR_DURATION_MS: "8000",
      PI_GUI_COMPUTER_USE_CURSOR_GLIDE_MS: "300",
      PI_GUI_COMPUTER_USE_HELPER_PATH: undefined,
      PI_GUI_COMPUTER_USE_LOCKED_USE_INSTALLER_PATH: undefined,
      PI_GUI_COMPUTER_USE_SHOW_CURSOR: "1",
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
        "Use Computer Use to calculate 9+6 in Calculator using button clicks, not type_text.",
        "Do not open or activate Calculator; it is already running in the background.",
        "After the final Calculator click, call get_app_state and use only the displayed Calculator result from that state.",
        "Reply exactly:",
        "RESULT: <number>",
        "TOOL_ERRORS: <yes/no>",
      ].join("\n"),
    );
    const cursorSeen = waitForFreshAgentCursorRequest(Date.now() / 1000);
    void cursorSeen.catch(() => undefined);
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
      expect(toolCalls.some((call) => call.toolName === "click" && inputApp(call.input) === targetApp)).toBe(true);
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
      const cursorRequest = await cursorSeen;
      expect(cursorRequest.pressed).toBe(true);
      expect(cursorRequest.pid).toBeGreaterThan(0);
      expect(cursorRequest.command).toContain(cursorOverlayArgument);
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

async function waitForFreshAgentCursorRequest(startedAtSeconds: number): Promise<AgentCursorObservation> {
  const deadline = Date.now() + 210_000;
  while (Date.now() < deadline) {
    const observation = await readAgentCursorObservation(startedAtSeconds);
    if (observation) {
      return observation;
    }
    await delay(250);
  }
  throw new Error("Installed Computer Use live run did not show the separate agent cursor.");
}

async function readAgentCursorObservation(startedAtSeconds: number): Promise<AgentCursorObservation | null> {
  const [rawPosition, rawPid] = await Promise.all([
    readFile(cursorPositionPath, "utf8").catch(() => ""),
    readFile(cursorPidPath, "utf8").catch(() => ""),
  ]);
  const parts = rawPosition.trim().split(",");
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  const timestamp = Number(parts[2]);
  const pid = Number(rawPid.trim());
  if (
    parts.length !== 4 ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(timestamp) ||
    timestamp < startedAtSeconds ||
    !Number.isInteger(pid) ||
    pid <= 0
  ) {
    return null;
  }
  const command = await agentCursorDaemonCommand(pid);
  if (!command) {
    return null;
  }
  return { x, y, timestamp, pressed: parts[3] === "1", pid, command };
}

async function agentCursorDaemonCommand(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", `${pid}`, "-o", "command="]);
    const command = stdout.trim();
    if (command.includes(helperExecutableName) && command.includes(cursorOverlayArgument)) {
      return command;
    }
  } catch {
    return null;
  }
  return null;
}

interface AgentCursorObservation {
  readonly x: number;
  readonly y: number;
  readonly timestamp: number;
  readonly pressed: boolean;
  readonly pid: number;
  readonly command: string;
}

async function waitForSelectedSessionIdle(window: Page): Promise<void> {
  await expect
    .poll(async () => {
      const state = await getDesktopState(window);
      const workspace = state.workspaces.find((entry) => entry.id === state.selectedWorkspaceId);
      const session = workspace?.sessions.find((entry) => entry.id === state.selectedSessionId);
      return session?.status ?? "";
    }, { timeout: 210_000 })
    .toBe("idle");
}

async function selectedToolCalls(window: Page): Promise<TimelineToolCall[]> {
  const selectedTranscript = await getSelectedTranscript(window);
  return (selectedTranscript?.transcript ?? []).filter(
    (item): item is TimelineToolCall => item.kind === "tool",
  );
}

function inputApp(input: unknown): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  return typeof input.app === "string" ? input.app : undefined;
}

function toolOutputText(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }
  if (isRecord(output) && Array.isArray(output.content)) {
    return output.content
      .map((item) => (isRecord(item) && typeof item.text === "string" ? item.text : ""))
      .join("\n");
  }
  return output === undefined || output === null ? "" : JSON.stringify(output);
}

function calculatorDisplays(text: string, expected: string): boolean {
  const expectedPattern = new RegExp(`(^|\\D)${escapeRegExp(expected)}(\\D|$)`);
  return text.split(/\r?\n/).some((line) => {
    const content = accessibilityTreeLineContent(line);
    if (!looksLikeCalculatorDisplayContent(content)) {
      return false;
    }
    return expectedPattern.test(content);
  });
}

function accessibilityTreeLineContent(line: string): string {
  return normalizeDisplayText(line).replace(/^\s*\d+\s+/, "");
}

function looksLikeCalculatorDisplayContent(content: string): boolean {
  return /^(text|static text|edit field)\b/i.test(content) || /\bValue:\s*/i.test(content);
}

function normalizeDisplayText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u200e\u200f\u202a-\u202e]/g, "")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

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
