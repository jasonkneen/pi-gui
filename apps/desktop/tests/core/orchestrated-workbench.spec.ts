import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "@playwright/test";
import type { SessionDriverEvent, SessionRef, WorkspaceRef } from "@pi-gui/session-driver";
import {
  createChildThreadToolName,
  listThreadsToolName,
  readThreadToolName,
  sendMessageToThreadToolName,
} from "../../electron/orchestration-runtime";
import type { OrchestrationChildThread, TimelineToolCall } from "../../src/desktop-state";
import {
  commitAllInGitRepo,
  createNamedThread,
  createSessionViaIpc,
  emitTestSessionEvent,
  getDesktopState,
  getSelectedTranscript,
  initGitRepo,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSession,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

test("integrates real child threads, files, preview evidence, and relaunch persistence", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("orchestrated-workbench");
  const unrelatedWorkspacePath = await makeWorkspace("orchestrated-workbench-unrelated");
  await initGitRepo(workspacePath);
  await commitAllInGitRepo(workspacePath, "init");
  await initGitRepo(unrelatedWorkspacePath);
  await commitAllInGitRepo(unrelatedWorkspacePath, "init");
  await writeFile(join(workspacePath, "workbench-notes.txt"), "orchestrated file preview\n", "utf8");
  const outsideDir = await mkdtemp(join(tmpdir(), "pi-gui-outside-preview-"));
  const outsideFile = join(outsideDir, "secret.txt");
  await writeFile(outsideFile, "outside workspace\n", "utf8");
  await symlink(outsideFile, join(workspacePath, "escape-link.txt"));
  const previewUrl = "http://127.0.0.1:30475/";

  const firstRun = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath, unrelatedWorkspacePath],
    testMode: "background",
    envOverrides: {
      PI_APP_ORCHESTRATION_SUPERVISION_INTERVAL_MS: "250",
    },
  });

  try {
    const window = await firstRun.firstWindow();
    await window.route(previewUrl, async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Workbench preview</title><main>Preview ready</main>",
      });
    });
    const parentWorkspace = await waitForWorkspaceByPath(window, workspacePath);
    await waitForWorkspaceByPath(window, unrelatedWorkspacePath);
    await createNamedThread(window, "Parent orchestration session", {
      workspaceName: parentWorkspace.name,
    });

    await expect(window.getByTestId("orchestrated-workbench")).toBeVisible();
    await expect(window.getByTestId("orchestration-workbench")).toBeVisible();
    await expect(window.getByTestId("child-thread-list")).toContainText("No child threads");

    const parentState = await getDesktopState(window);
    const parentRef = {
      workspaceId: parentState.selectedWorkspaceId,
      sessionId: parentState.selectedSessionId,
    };
    await createSessionViaIpc(window, unrelatedWorkspacePath, "Unrelated isolated session");
    const unrelatedState = await getDesktopState(window);
    const unrelatedWorkspace = unrelatedState.workspaces.find((workspace) => workspace.path === unrelatedWorkspacePath);
    const unrelatedSession = unrelatedWorkspace?.sessions.find((session) => session.title === "Unrelated isolated session");
    if (!unrelatedWorkspace || !unrelatedSession) {
      throw new Error("Expected unrelated workspace session to exist");
    }
    const unrelatedThreadRef = `${unrelatedWorkspace.id}:${unrelatedSession.id}`;
    await selectSession(window, "Parent orchestration session");

    const childPrompt = "Audit the renderer state ownership boundary";
    const toolCallId = "create-child-thread-test";
    const createChildToolResult = await runOrchestrationRuntimeTool(
      firstRun,
      parentRef,
      createChildThreadToolName,
      { prompt: childPrompt },
      toolCallId,
    );
    expect(toolResultText(createChildToolResult)).toContain("Created child thread");
    const createChildDetails = toolResultDetails(createChildToolResult);
    expect(createChildDetails.childThreadId).toEqual(expect.any(String));
    expect(createChildDetails.childWorkspaceId).toEqual(expect.any(String));
    expect(createChildDetails.childSessionId).toEqual(expect.any(String));
    expect(createChildDetails.title).toBe("Audit the renderer state ownership boundary");
    await emitTestSessionEvent(firstRun, {
      type: "toolStarted",
      sessionRef: parentRef,
      timestamp: new Date().toISOString(),
      toolName: createChildThreadToolName,
      callId: toolCallId,
      input: { prompt: childPrompt },
    });
    await expect(window.getByTestId("transcript")).toContainText("Started child thread");
    await emitTestSessionEvent(firstRun, {
      type: "toolFinished",
      sessionRef: parentRef,
      timestamp: new Date().toISOString(),
      callId: toolCallId,
      success: true,
      output: {
        ...createChildToolResult,
      },
    });
    await expect(window.getByTestId("transcript")).toContainText(createChildThreadToolName);

    await expect(window.getByTestId("child-thread-row")).toHaveCount(1);
    await expect(window.getByTestId("child-thread-row")).toContainText("Audit the renderer state ownership boundary");
    await expect(window.getByTestId("child-thread-row")).not.toContainText("Mocked");
    await expect(window.getByTestId("child-supervision-loop")).toBeVisible();
    await expect(window.locator(".session-row__select", { hasText: "Audit the renderer state ownership boundary" }).first()).toBeVisible();
    const child = await waitForChildThread(window);
    expect(child.id).toBe(createChildDetails.childThreadId);
    expect(child.childWorkspaceId).toBe(createChildDetails.childWorkspaceId);
    expect(child.childSessionId).toBe(createChildDetails.childSessionId);
    await emitChildRunningSnapshot(firstRun, window, child);
    await expect(window.getByTestId("child-thread-detail")).toContainText("running");
    await expect(window.getByTestId("child-supervision-loop")).toContainText("Continue");
    await expect(window.getByTestId("child-supervision-loop")).toContainText("Stop");
    await expect
      .poll(async () => (await waitForChildThread(window)).transcript.map((message) => message.text))
      .toContain("Audit the renderer state ownership boundary");

    const listThreadsCallId = "list-threads-test";
    const listThreadsToolResult = await runOrchestrationRuntimeTool(firstRun, parentRef, listThreadsToolName, {});
    expect(toolResultText(listThreadsToolResult)).toContain(child.id);
    expect(["continue", "wake"]).toContain(threadDetailsForChild(listThreadsToolResult, child.id)?.supervisionGate);
    expect(toolResultText(listThreadsToolResult)).toContain("Parent orchestration session");
    expect(toolResultText(listThreadsToolResult)).not.toContain("Unrelated isolated session");
    await emitRuntimeToolCall(firstRun, parentRef, listThreadsToolName, listThreadsCallId, {}, {
      ...listThreadsToolResult,
    });
    await expect(window.getByTestId("transcript")).toContainText("Listed threads");
    await expect
      .poll(async () => toolOutputText(window, listThreadsCallId))
      .toContain(child.id);
    await expect
      .poll(async () => toolOutputText(window, listThreadsCallId))
      .toContain("Parent orchestration session");
    await expect
      .poll(async () => toolOutputText(window, listThreadsCallId))
      .not.toContain("Unrelated isolated session");

    const rejectedReadThreadCallId = "read-unrelated-thread-test";
    const rejectedReadThreadToolResult = await runOrchestrationRuntimeTool(
      firstRun,
      parentRef,
      readThreadToolName,
      { thread_id: unrelatedThreadRef },
    );
    expect(toolResultText(rejectedReadThreadToolResult)).toContain(`Unknown thread: ${unrelatedThreadRef}`);
    await emitRuntimeToolCall(firstRun, parentRef, readThreadToolName, rejectedReadThreadCallId, { thread_id: unrelatedThreadRef }, {
      ...rejectedReadThreadToolResult,
    });
    await expect
      .poll(async () => toolOutputText(window, rejectedReadThreadCallId))
      .toContain(`Unknown thread: ${unrelatedThreadRef}`);

    const readThreadCallId = "read-child-thread-test";
    const readThreadToolResult = await runOrchestrationRuntimeTool(
      firstRun,
      parentRef,
      readThreadToolName,
      { thread_id: child.id },
    );
    expect(toolResultText(readThreadToolResult)).toContain("Audit the renderer state ownership boundary");
    await emitRuntimeToolCall(firstRun, parentRef, readThreadToolName, readThreadCallId, { thread_id: child.id }, {
      ...readThreadToolResult,
    });
    await expect(window.getByTestId("transcript")).toContainText("Read thread");
    await expect
      .poll(async () => toolOutputText(window, readThreadCallId))
      .toContain("Audit the renderer state ownership boundary");

    await emitChildFailedSnapshot(firstRun, window, child);
    await expect(window.getByTestId("child-thread-detail")).toContainText("failed");
    await expect(window.getByTestId("child-supervision-loop")).toContainText("wake");
    await expect(window.getByTestId("child-supervision-loop")).toContainText("Child failed");
    await window.getByTestId("child-supervision-loop").getByRole("button", { name: "Continue" }).click();
    await expect(window.getByTestId("child-supervision-loop")).toContainText("continue");
    await emitChildRunningSnapshot(firstRun, window, child);
    await expect(window.getByTestId("child-thread-detail")).toContainText("running");
    await expect(window.getByTestId("child-supervision-loop")).toContainText("continue");

    const runtimeFollowUp = "Report whether IPC boundaries stay tight";
    const sendMessageCallId = "send-message-to-child-thread-test";
    const sendMessageToolResult = await runOrchestrationRuntimeTool(
      firstRun,
      parentRef,
      sendMessageToThreadToolName,
      { thread_id: child.id, message: runtimeFollowUp },
    );
    expect(toolResultText(sendMessageToolResult)).toContain("Queued message to thread");
    await emitRuntimeToolCall(
      firstRun,
      parentRef,
      sendMessageToThreadToolName,
      sendMessageCallId,
      { thread_id: child.id, message: runtimeFollowUp },
      {
        ...sendMessageToolResult,
      },
    );
    await expect
      .poll(async () => toolOutputText(window, sendMessageCallId))
      .toContain("Queued message to thread");
    await expect(window.getByTestId("child-thread-detail")).toContainText("waiting");
    await window.getByTestId("child-supervision-loop").getByRole("button", { name: "Stop" }).click();
    await expect(window.getByTestId("child-supervision-loop")).toContainText("stop");
    await expect(window.getByTestId("child-supervision-loop")).toContainText("stopped");
    await window.getByTestId("child-thread-open").click();
    await expect(window.locator(".topbar__session")).toHaveText("Audit the renderer state ownership boundary");
    await expect(window.getByTestId("queued-composer-message")).toContainText(runtimeFollowUp);
    await selectSession(window, "Parent orchestration session");

    await window.getByTestId("workbench-tab-files").click();
    const fileWorkbench = window.locator(".file-workbench");
    await expect(fileWorkbench).toBeVisible();
    await expect(fileWorkbench.getByTestId("file-workbench-tree")).toContainText("workbench-notes.txt");
    await expect(fileWorkbench.locator(".diff-panel__file-name").filter({ hasText: "workbench-notes.txt" })).toBeVisible();

    await fileWorkbench.getByTestId("file-workbench-tree").getByText("workbench-notes.txt").click();
    await expect(fileWorkbench.getByTestId("file-workbench-preview")).toContainText("orchestrated file preview");
    await fileWorkbench.getByRole("button", { name: "Add evidence" }).click();
    await expect(window.getByTestId("composer")).toHaveValue(/Workbench evidence/);
    await expect(window.getByTestId("composer")).toHaveValue(/workbench-notes.txt/);
    await expect(window.getByTestId("composer")).toHaveValue(/First line: orchestrated file preview/);

    await expect
      .poll(async () =>
        window.evaluate(async () => {
          const app = window.piApp;
          if (!app) {
            throw new Error("piApp IPC bridge is unavailable");
          }
          const state = await app.getState();
          try {
            await app.readWorkspaceFile(state.selectedWorkspaceId, "escape-link.txt");
            return "allowed";
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        }),
      )
      .toContain("Path escapes workspace");

    await fileWorkbench.locator(".diff-panel__file-name").filter({ hasText: "workbench-notes.txt" }).click();
    await expect(fileWorkbench.locator(".diff-inline")).toBeVisible();
    await expect(fileWorkbench.locator(".diff-line--added")).toContainText("orchestrated file preview");

    await window.getByTestId("workbench-tab-preview").click();
    await expect(window.getByTestId("preview-workbench")).toBeVisible();
    await window.getByLabel("Preview URL").fill(previewUrl);
    await window.getByRole("button", { name: "Load" }).click();
    await expect(window.getByTestId("preview-frame")).toBeVisible();
    await expect(window.getByTestId("preview-status")).toContainText("Ready");
    await window.getByLabel("Preview evidence observation").fill("Preview rendered inside the workbench");
    await window.getByRole("button", { name: "Attach evidence" }).click();
    await expect(window.getByTestId("composer")).toHaveValue(/Preview evidence/);
    await expect(window.getByTestId("composer")).toHaveValue(/Preview rendered inside the workbench/);

    await expect
      .poll(async () => {
        try {
          return await readFile(join(userDataDir, "ui-state.json"), "utf8");
        } catch {
          return "";
        }
      })
      .toContain("childSessionId");
    await expect
      .poll(async () => {
        try {
          return await readFile(join(userDataDir, "ui-state.json"), "utf8");
        } catch {
          return "";
        }
      })
      .toContain("supervisionLoop");
  } finally {
    await firstRun.close();
  }

  const secondRun = await launchDesktop(userDataDir, { testMode: "background" });
  try {
    const window = await secondRun.firstWindow();
    await expect(window.getByTestId("orchestrated-workbench")).toBeVisible();
    await expect(window.getByTestId("child-thread-row")).toContainText("Audit the renderer state ownership boundary");
    await expect(window.getByTestId("child-thread-row")).not.toContainText("Mocked");
    await expect(window.getByTestId("child-supervision-loop")).toContainText("stop");
    await expect(window.getByTestId("child-thread-transcript")).toContainText("Audit the renderer state ownership boundary");
    await window.getByTestId("child-thread-open").click();
    await expect(window.locator(".topbar__session")).toHaveText("Audit the renderer state ownership boundary");
  } finally {
    await secondRun.close();
  }
});

async function waitForChildThread(window: Parameters<typeof getDesktopState>[0]): Promise<OrchestrationChildThread> {
  return expect.poll(async () => {
    const state = await getDesktopState(window);
    return state.orchestrationChildren[0] ?? null;
  }, { timeout: 15_000 }).not.toBeNull().then(async () => {
    const state = await getDesktopState(window);
    const child = state.orchestrationChildren[0];
    if (!child) {
      throw new Error("Expected a child thread link");
    }
    return child;
  });
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

async function toolOutputText(window: Parameters<typeof getDesktopState>[0], callId: string): Promise<string> {
  const transcript = await getSelectedTranscript(window);
  const tool = transcript?.transcript.find(
    (item): item is TimelineToolCall => item.kind === "tool" && item.callId === callId,
  );
  if (!tool) {
    return "";
  }
  return JSON.stringify(tool.output);
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

function toolResultDetails(result: unknown): Record<string, unknown> {
  if (typeof result !== "object" || result === null || !("details" in result)) {
    throw new Error(`Tool result did not include details: ${JSON.stringify(result)}`);
  }
  const details = result.details;
  if (typeof details !== "object" || details === null) {
    throw new Error(`Tool result details were not an object: ${JSON.stringify(result)}`);
  }
  return details as Record<string, unknown>;
}

function threadDetailsForChild(result: unknown, childThreadId: string): Record<string, unknown> | undefined {
  const details = toolResultDetails(result);
  if (!Array.isArray(details.threads)) {
    return undefined;
  }
  return details.threads.find((thread): thread is Record<string, unknown> =>
    typeof thread === "object" &&
    thread !== null &&
    "childThreadId" in thread &&
    thread.childThreadId === childThreadId,
  );
}

async function emitChildRunningSnapshot(
  harness: Awaited<ReturnType<typeof launchDesktop>>,
  window: Parameters<typeof getDesktopState>[0],
  child: OrchestrationChildThread,
): Promise<void> {
  await emitChildStatusSnapshot(harness, window, child, "running");
}

async function emitChildFailedSnapshot(
  harness: Awaited<ReturnType<typeof launchDesktop>>,
  window: Parameters<typeof getDesktopState>[0],
  child: OrchestrationChildThread,
): Promise<void> {
  await emitChildStatusSnapshot(harness, window, child, "failed");
}

async function emitChildStatusSnapshot(
  harness: Awaited<ReturnType<typeof launchDesktop>>,
  window: Parameters<typeof getDesktopState>[0],
  child: OrchestrationChildThread,
  status: "running" | "failed",
): Promise<void> {
  const state = await getDesktopState(window);
  const workspace = state.workspaces.find((entry) => entry.id === child.childWorkspaceId);
  const session = workspace?.sessions.find((entry) => entry.id === child.childSessionId);
  if (!workspace || !session) {
    throw new Error(`Expected child session to exist before emitting ${status} snapshot`);
  }

  const sessionRef: SessionRef = {
    workspaceId: child.childWorkspaceId,
    sessionId: child.childSessionId,
  };
  const workspaceRef: WorkspaceRef = {
    workspaceId: workspace.id,
    path: workspace.path,
    displayName: workspace.name,
  };
  const timestamp = new Date().toISOString();
  const runId = status === "running" ? "orchestrated-workbench-child-run" : undefined;
  const event: Extract<SessionDriverEvent, { type: "sessionUpdated" }> = {
    type: "sessionUpdated",
    sessionRef,
    timestamp,
    ...(runId ? { runId } : {}),
    snapshot: {
      ref: sessionRef,
      workspace: workspaceRef,
      title: session.title,
      status,
      updatedAt: timestamp,
      preview: session.preview,
      ...(runId ? { runningRunId: runId } : {}),
      queuedMessages: [],
    },
  };
  await emitTestSessionEvent(harness, event);
}
