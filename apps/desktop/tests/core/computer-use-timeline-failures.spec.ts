import { expect, test, type Page } from "@playwright/test";
import type { SessionDriverEvent, SessionRef } from "@pi-gui/session-driver";
import {
  createNamedThread,
  type DesktopHarness,
  emitTestSessionEvent,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

interface ComputerUseFailureScenario {
  readonly name: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly title: string;
  readonly helperMessage: string;
  readonly errorCode: string;
  readonly details?: Record<string, unknown>;
}

const failureScenarios: readonly ComputerUseFailureScenario[] = [
  {
    name: "lock state",
    toolName: "get_app_state",
    input: { app: "Calculator" },
    title: "Computer Use blocked: the Mac is locked.",
    helperMessage: "Computer Use is unavailable while the Mac is locked. Unlock the desktop and retry.",
    errorCode: "desktop_locked",
    details: { screenLocked: "true" },
  },
  {
    name: "Accessibility permission",
    toolName: "get_app_state",
    input: { app: "Calculator" },
    title: "Computer Use blocked: Accessibility permission is not enabled.",
    helperMessage:
      "Accessibility permission is not granted for pi-gui Computer Use. In macOS System Settings > Privacy & Security > Accessibility, enable pi-gui and pi-gui Computer Use.",
    errorCode: "accessibility_denied",
    details: { accessibility: "denied" },
  },
  {
    name: "Screen Recording permission",
    toolName: "click",
    input: { app: "Preview", x: 10, y: 10 },
    title: "Computer Use blocked: Screen Recording permission is not enabled.",
    helperMessage:
      "Screen Recording permission is required before using screenshot coordinates. In macOS System Settings > Privacy & Security > Screen Recording, enable pi-gui and pi-gui Computer Use, then retry.",
    errorCode: "screen_recording_denied",
    details: { screenRecording: "denied" },
  },
  {
    name: "helper setup",
    toolName: "computer_use_status",
    input: {},
    title: "Computer Use unavailable: the helper is not configured.",
    helperMessage: "Computer Use helper is not configured. Missing PI_GUI_COMPUTER_USE_HELPER_PATH.",
    errorCode: "helper_unavailable",
  },
  {
    name: "app not found",
    toolName: "get_app_state",
    input: { app: "ImaginaryApp" },
    title: "Computer Use blocked: the requested app could not be found.",
    helperMessage: "Could not find app: ImaginaryApp",
    errorCode: "app_not_found",
  },
  {
    name: "screenshot unavailable",
    toolName: "click",
    input: { app: "Notes", x: 10, y: 10 },
    title: "Computer Use blocked: the target screenshot is unavailable.",
    helperMessage:
      "Cannot use screenshot coordinates because the target window screenshot is unavailable for Notes. Call get_app_state and use an element_index from the accessibility tree instead.",
    errorCode: "screenshot_unavailable",
    details: { screenshot: "unavailable" },
  },
  {
    name: "physical input",
    toolName: "click",
    input: { app: "Sketch", x: 120, y: 120 },
    title: "Computer Use blocked: this action would require foreground physical input.",
    helperMessage:
      "Computer Use blocked: this click in Sketch would require foreground physical input by moving the user's physical mouse at 120,120. Use a pressable element_index or a coordinate over a pressable accessibility element to keep Computer Use in the background.",
    errorCode: "physical_input_required",
  },
];

test("Computer Use failure categories stay distinct in timeline rows and run failures", async () => {
  test.setTimeout(45_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("computer-use-timeline-failures-workspace");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Computer Use timeline failures");
    const sessionRef = await selectedSessionRef(window);

    for (const scenario of failureScenarios) {
      await assertComputerUseFailureScenario(window, harness, sessionRef, scenario);
    }
  } finally {
    await harness.close();
  }
});

async function assertComputerUseFailureScenario(
  window: Page,
  harness: DesktopHarness,
  sessionRef: SessionRef,
  scenario: ComputerUseFailureScenario,
): Promise<void> {
  const callId = `computer-use-${scenario.errorCode}`;
  const timestamp = new Date().toISOString();
  const startedEvent: Extract<SessionDriverEvent, { type: "toolStarted" }> = {
    type: "toolStarted",
    sessionRef,
    timestamp,
    toolName: scenario.toolName,
    callId,
    input: scenario.input,
  };
  await emitTestSessionEvent(harness, startedEvent);

  const toolItem = window.locator(".timeline-tool").last();
  await expect(toolItem.locator(".timeline-tool__label")).toContainText(scenario.toolName);

  const finishedEvent: Extract<SessionDriverEvent, { type: "toolFinished" }> = {
    type: "toolFinished",
    sessionRef,
    timestamp,
    callId,
    success: false,
    output: computerUseFailureOutput(scenario),
  };
  await emitTestSessionEvent(harness, finishedEvent);

  await expect(toolItem).toHaveClass(/timeline-tool--error/);
  await expect(toolItem.locator(".timeline-tool__detail")).toHaveText(scenario.title);
  await expect(toolItem.locator(".timeline-tool__header")).toHaveAttribute("aria-expanded", "false");

  await toolItem.locator(".timeline-tool__header").click();
  await expect(toolItem.locator(".timeline-tool__pre")).toContainText(scenario.errorCode);
  await expect(toolItem.locator(".timeline-tool__pre")).toContainText(scenario.helperMessage);
  await toolItem.locator(".timeline-tool__header").click();

  const failedEvent: Extract<SessionDriverEvent, { type: "runFailed" }> = {
    type: "runFailed",
    sessionRef,
    timestamp,
    error: { message: "terminated", code: "RUN_FAILED" },
  };
  await emitTestSessionEvent(harness, failedEvent);

  const failureActivity = window.locator(".timeline-activity--error").last();
  await expect(failureActivity, scenario.name).toContainText(scenario.title);
  await expect(failureActivity, scenario.name).toContainText("RUN_FAILED");
  await expect(failureActivity, scenario.name).not.toContainText("terminated");
}

function computerUseFailureOutput(scenario: ComputerUseFailureScenario) {
  return {
    content: [
      {
        type: "text",
        text: `${scenario.title}\n${scenario.helperMessage}\n\nRun computer_use_status to check the current helper, permission, and lock-screen state before retrying.`,
      },
    ],
    details: {
      ok: false,
      errorCode: scenario.errorCode,
      error: scenario.helperMessage,
      ...scenario.details,
    },
    isError: true,
  };
}

async function selectedSessionRef(window: Page): Promise<SessionRef> {
  const state = await getDesktopState(window);
  if (!state.selectedWorkspaceId || !state.selectedSessionId) {
    throw new Error("Expected a selected session");
  }
  return { workspaceId: state.selectedWorkspaceId, sessionId: state.selectedSessionId };
}
