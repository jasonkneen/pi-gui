import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { SessionRef } from "@pi-gui/session-driver";
import {
  createChildThreadToolName,
  readThreadToolName,
  sendMessageToThreadToolName,
} from "../../electron/orchestration-runtime";
import type { OrchestrationChildThread, OrchestrationEvidenceRecord } from "../../src/desktop-state";
import {
  commitAllInGitRepo,
  createNamedThread,
  emitTestSessionEvent,
  getDesktopState,
  initGitRepo,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

test("shows persisted evidence records for child-thread review loops", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("evidence-ledger");
  await initGitRepo(workspacePath);
  await commitAllInGitRepo(workspacePath, "init");

  const firstRun = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await firstRun.firstWindow();
    await createNamedThread(window, "Parent review loop");
    const parentState = await getDesktopState(window);
    const parentRef = {
      workspaceId: parentState.selectedWorkspaceId,
      sessionId: parentState.selectedSessionId,
    };

    const childPrompt = "Review the evidence ledger contract";
    const createResult = await runOrchestrationRuntimeTool(
      firstRun,
      parentRef,
      createChildThreadToolName,
      { prompt: childPrompt },
      "evidence-create-child",
    );
    expect(toolResultText(createResult)).toContain("Created child thread");
    const child = await waitForChildThread(window);
    const childRef = {
      workspaceId: child.childWorkspaceId,
      sessionId: child.childSessionId,
    };

    await emitTestSessionEvent(firstRun, {
      type: "assistantDelta",
      sessionRef: childRef,
      timestamp: new Date().toISOString(),
      text: "P1: worker-reported evidence is separated from accepted proof.",
    });
    await emitRuntimeToolCall(
      firstRun,
      childRef,
      "exec_command",
      "evidence-child-typecheck",
      { cmd: "pnpm --filter @pi-gui/desktop run typecheck" },
      { content: [{ type: "text", text: "typecheck passed" }] },
    );

    const readResult = await runOrchestrationRuntimeTool(
      firstRun,
      parentRef,
      readThreadToolName,
      { thread_id: child.id },
    );
    await emitRuntimeToolCall(
      firstRun,
      parentRef,
      readThreadToolName,
      "evidence-read-child",
      { thread_id: child.id },
      { ...readResult },
    );

    const followUpResult = await runOrchestrationRuntimeTool(
      firstRun,
      parentRef,
      sendMessageToThreadToolName,
      { thread_id: child.id, message: "Please attach the command output and blocker status." },
    );
    await emitRuntimeToolCall(
      firstRun,
      parentRef,
      sendMessageToThreadToolName,
      "evidence-follow-up",
      { thread_id: child.id, message: "Please attach the command output and blocker status." },
      { ...followUpResult },
    );
    await emitTestSessionEvent(firstRun, {
      type: "assistantDelta",
      sessionRef: parentRef,
      timestamp: new Date().toISOString(),
      text: `orchestrator-accepted: ${child.id} accepted after reviewing the command output.`,
    });

    await window.getByTestId("workbench-tab-evidence").click();
    await expect(window.getByTestId("evidence-ledger")).toBeVisible();
    await expect(window.getByTestId("evidence-records")).toContainText("Worker-reported");
    await expect(window.getByTestId("evidence-records")).toContainText("Orchestrator-observed");
    await expect(window.getByTestId("evidence-records")).toContainText("Orchestrator-action");
    await expect(window.getByTestId("evidence-records")).toContainText("Orchestrator-accepted");
    await expect(window.getByTestId("evidence-records")).toContainText("P1 review finding");
    await expect(window.getByTestId("evidence-records")).toContainText("Test command run");
    await expect(window.getByTestId("evidence-records")).toContainText("typecheck");
    const evidence = await waitForEvidence(window);
    expect(evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "review_finding",
        source: "worker-reported",
        status: "reported",
        severity: "P1",
      }),
      expect.objectContaining({
        kind: "command",
        source: "command",
        status: "passed",
        command: "pnpm --filter @pi-gui/desktop run typecheck",
      }),
      expect.objectContaining({
        kind: "orchestrator_observation",
        source: "orchestrator-observed",
        status: "reported",
      }),
      expect.objectContaining({
        kind: "orchestrator_action",
        source: "orchestrator-action",
        status: "reported",
      }),
      expect.objectContaining({
        kind: "orchestrator_acceptance",
        source: "orchestrator-accepted",
        status: "accepted",
      }),
    ]));
    const readRecords = evidence.filter((record) => record.title === "Orchestrator read child output");
    expect(readRecords).toEqual([
      expect.objectContaining({
        source: "orchestrator-observed",
        status: "reported",
      }),
    ]);

    await expect
      .poll(async () => readFile(join(userDataDir, "ui-state.json"), "utf8"))
      .toContain("worker-reported");
  } finally {
    await firstRun.close();
  }

  const secondRun = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await secondRun.firstWindow();
    await window.getByTestId("workbench-tab-evidence").click();
    await expect(window.getByTestId("evidence-records")).toContainText("Worker-reported");
    await expect(window.getByTestId("evidence-records")).toContainText("Orchestrator-observed");
    await expect(window.getByTestId("evidence-records")).toContainText("Orchestrator-accepted");
    await expect(window.getByTestId("evidence-records")).toContainText("typecheck");
  } finally {
    await secondRun.close();
  }
});

async function waitForChildThread(window: Parameters<typeof getDesktopState>[0]): Promise<OrchestrationChildThread> {
  await expect.poll(async () => {
    const state = await getDesktopState(window);
    return state.orchestrationChildren[0] ?? null;
  }, { timeout: 15_000 }).not.toBeNull();
  const state = await getDesktopState(window);
  const child = state.orchestrationChildren[0];
  if (!child) {
    throw new Error("Expected a child thread link");
  }
  return child;
}

async function waitForEvidence(window: Parameters<typeof getDesktopState>[0]): Promise<readonly OrchestrationEvidenceRecord[]> {
  await expect.poll(async () => {
    const state = await getDesktopState(window);
    return state.orchestrationChildren[0]?.evidence.length ?? 0;
  }, { timeout: 15_000 }).toBeGreaterThanOrEqual(5);
  const state = await getDesktopState(window);
  return state.orchestrationChildren[0]?.evidence ?? [];
}

async function emitRuntimeToolCall(
  harness: Awaited<ReturnType<typeof launchDesktop>>,
  sessionRef: SessionRef,
  toolName: string,
  callId: string,
  input: unknown,
  output: unknown,
): Promise<void> {
  await emitTestSessionEvent(harness, {
    type: "toolStarted",
    sessionRef,
    timestamp: new Date().toISOString(),
    toolName,
    callId,
    input,
  });
  await emitTestSessionEvent(harness, {
    type: "toolFinished",
    sessionRef,
    timestamp: new Date().toISOString(),
    callId,
    success: true,
    output,
  });
}

async function runOrchestrationRuntimeTool(
  harness: Awaited<ReturnType<typeof launchDesktop>>,
  sessionRef: SessionRef,
  toolName: string,
  params: unknown,
  toolCallId?: string,
): Promise<unknown> {
  return harness.electronApp.evaluate(async (_, input) => {
    const hooks = (globalThis as {
      __PI_APP_TEST_HOOKS?: {
        runOrchestrationRuntimeTool?: (toolInput: {
          readonly toolName: string;
          readonly toolCallId?: string;
          readonly sessionRef: SessionRef;
          readonly params: unknown;
        }) => Promise<unknown>;
      };
    }).__PI_APP_TEST_HOOKS;
    if (!hooks?.runOrchestrationRuntimeTool) {
      throw new Error("Orchestration runtime tool test hook is unavailable");
    }
    return hooks.runOrchestrationRuntimeTool(input);
  }, { toolName, toolCallId, sessionRef, params });
}

function toolResultText(result: unknown): string {
  if (typeof result !== "object" || result === null || !("content" in result) || !Array.isArray(result.content)) {
    return JSON.stringify(result);
  }
  return result.content
    .map((item) =>
      typeof item === "object" && item !== null && "type" in item && item.type === "text" && "text" in item
        ? item.text
        : "",
    )
    .filter((text): text is string => typeof text === "string" && text.length > 0)
    .join("\n");
}
