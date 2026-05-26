import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  selectSession,
  writeProjectExtension,
} from "../helpers/electron-app";

const goalFakeProviderExtension = String.raw`
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

let callCount = 0;

function usage(totalTokens) {
  return {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function assistantBase(model, totalTokens) {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: model.provider,
    model: model.id,
    content: [],
    usage: usage(totalTokens),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function pushText(stream, message, text) {
  const contentIndex = message.content.length;
  message.content.push({ type: "text", text });
  stream.push({ type: "text_start", contentIndex, partial: message });
  stream.push({ type: "text_delta", contentIndex, delta: text, partial: message });
  stream.push({ type: "text_end", contentIndex, content: text, partial: message });
}

function pushUpdateGoalToolCall(stream, message) {
  const toolCall = {
    type: "toolCall",
    id: "goal-complete-call",
    name: "update_goal",
    arguments: { status: "complete" },
  };
  const contentIndex = message.content.length;
  message.content.push(toolCall);
  stream.push({ type: "toolcall_start", contentIndex, partial: message });
  stream.push({
    type: "toolcall_delta",
    contentIndex,
    delta: JSON.stringify(toolCall.arguments),
    partial: message,
  });
  stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: message });
}

function streamSimple(model) {
  const stream = createAssistantMessageEventStream();
  setTimeout(() => {
    callCount += 1;
    const message = assistantBase(model, callCount * 10);
    stream.push({ type: "start", partial: message });

    if (callCount === 1) {
      pushUpdateGoalToolCall(stream, message);
      message.stopReason = "toolUse";
      stream.push({ type: "done", reason: "toolUse", message });
      stream.end();
      return;
    }

    pushText(
      stream,
      message,
      "goal completed by fake provider",
    );
    stream.push({ type: "done", reason: "stop", message });
    stream.end();
  }, 10);
  return stream;
}

export default function goalFakeProvider(pi) {
  pi.registerProvider("goal-fake", {
    api: "openai-responses",
    apiKey: "GOAL_FAKE_API_KEY",
    baseUrl: "https://example.invalid",
    models: [
      {
        id: "goal-test",
        name: "Goal Test",
        reasoning: false,
        input: ["text"],
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
    streamSimple,
  });

  pi.on("session_start", async (_event, ctx) => {
    if (process.env.GOAL_FAKE_AUTO_MODEL === "0") {
      return;
    }
    const model = ctx.modelRegistry.find("goal-fake", "goal-test");
    if (model) {
      await pi.setModel(model);
    }
  });
}
`;

const goalTextOnlyProviderExtension = String.raw`
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

function usage(totalTokens) {
  return {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

export default function goalTextOnlyProvider(pi) {
  pi.registerProvider("goal-text-only", {
    api: "openai-responses",
    apiKey: "GOAL_FAKE_API_KEY",
    baseUrl: "https://example.invalid",
    models: [
      {
        id: "goal-text",
        name: "Goal Text",
        reasoning: false,
        input: ["text"],
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
    streamSimple(model) {
      const stream = createAssistantMessageEventStream();
      setTimeout(() => {
        const message = {
          role: "assistant",
          api: "openai-responses",
          provider: model.provider,
          model: model.id,
          content: [],
          usage: usage(10),
          stopReason: "stop",
          timestamp: Date.now(),
        };
        const contentIndex = message.content.length;
        message.content.push({ type: "text", text: "goal needs more work" });
        stream.push({ type: "start", partial: message });
        stream.push({ type: "text_start", contentIndex, partial: message });
        stream.push({ type: "text_delta", contentIndex, delta: "goal needs more work", partial: message });
        stream.push({ type: "text_end", contentIndex, content: "goal needs more work", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
      }, 10);
      return stream;
    },
  });
}
`;

async function expectGoalCommand(window: Page): Promise<void> {
  await expect
    .poll(async () => {
      const state = await getDesktopState(window);
      const sessionKey = `${state.selectedWorkspaceId}:${state.selectedSessionId}`;
      return (state.sessionCommandsBySession[sessionKey] ?? []).map((command) => command.name);
    })
    .toContain("goal");
}

async function expandGoalDock(window: Page) {
  await window.getByTestId("extension-dock-toggle").click();
  return window.getByTestId("extension-dock-body");
}

async function setSelectedSessionModel(window: Page, provider: string, modelId: string): Promise<void> {
  await expect
    .poll(async () => {
      const state = await getDesktopState(window);
      const models = state.runtimeByWorkspace[state.selectedWorkspaceId]?.models ?? [];
      return models.map(
        (model) => `${model.providerId}/${model.modelId}:${model.available ? "available" : "unavailable"}`,
      );
    })
    .toContain(`${provider}/${modelId}:available`);

  await window.evaluate(async ({ nextProvider, nextModelId }) => {
    const app = (window as Window & { piApp?: import("../../src/ipc").PiDesktopApi }).piApp;
    if (!app) {
      throw new Error("piApp IPC bridge is unavailable");
    }
    const state = await app.getState();
    await app.setSessionModel(state.selectedWorkspaceId, state.selectedSessionId, nextProvider, nextModelId);
  }, { nextProvider: provider, nextModelId: modelId });
}

async function writeFakeProviderSettings(
  agentDir: string,
  options: { readonly defaultModel?: boolean } = {},
): Promise<void> {
  const { defaultModel = true } = options;
  const modelsPath = join(agentDir, "models.json");
  const models = {
    providers: {
      "goal-fake": {
        name: "Goal Fake",
        api: "openai-responses",
        apiKey: "GOAL_FAKE_API_KEY",
        baseUrl: "https://example.invalid",
        models: [
          {
            id: "goal-test",
            name: "Goal Test",
            reasoning: false,
            input: ["text"],
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
            },
            contextWindow: 128000,
            maxTokens: 4096,
          },
        ],
      },
    },
  };
  await writeFile(modelsPath, `${JSON.stringify(models, null, 2)}\n`, "utf8");

  const settingsPath = join(agentDir, "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
  if (defaultModel) {
    settings.defaultProvider = "goal-fake";
    settings.defaultModel = "goal-test";
  } else {
    delete settings.defaultProvider;
    delete settings.defaultModel;
  }
  delete settings.enabledModels;
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

  const authPath = join(agentDir, "auth.json");
  const auth = JSON.parse(await readFile(authPath, "utf8")) as Record<string, unknown>;
  auth["goal-fake"] = { type: "api_key", key: "test-goal-key" };
  await writeFile(authPath, `${JSON.stringify(auth, null, 2)}\n`, "utf8");
}

async function writeTextOnlyProviderSettings(agentDir: string): Promise<void> {
  const modelsPath = join(agentDir, "models.json");
  const models = {
    providers: {
      "goal-text-only": {
        name: "Goal Text Only",
        api: "openai-responses",
        apiKey: "GOAL_FAKE_API_KEY",
        baseUrl: "https://example.invalid",
        models: [
          {
            id: "goal-text",
            name: "Goal Text",
            reasoning: false,
            input: ["text"],
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
            },
            contextWindow: 128000,
            maxTokens: 4096,
          },
        ],
      },
    },
  };
  await writeFile(modelsPath, `${JSON.stringify(models, null, 2)}\n`, "utf8");

  const settingsPath = join(agentDir, "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
  settings.defaultProvider = "goal-text-only";
  settings.defaultModel = "goal-text";
  delete settings.enabledModels;
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

  const authPath = join(agentDir, "auth.json");
  const auth = JSON.parse(await readFile(authPath, "utf8")) as Record<string, unknown>;
  auth["goal-text-only"] = { type: "api_key", key: "test-goal-key" };
  await writeFile(authPath, `${JSON.stringify(auth, null, 2)}\n`, "utf8");
}

async function expectSelectedSessionStatus(window: Page, status: string): Promise<void> {
  await expect
    .poll(async () => {
      const state = await getDesktopState(window);
      const selectedWorkspace = state.workspaces.find((entry) => entry.id === state.selectedWorkspaceId);
      return selectedWorkspace?.sessions.find((entry) => entry.id === state.selectedSessionId)?.status ?? "unknown";
    })
    .toBe(status);
}

test("bundles /goal as an internal extension and restores goal UI after relaunch", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("goal-extension-workspace");
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir, { enabledModels: [], withDefaultModel: false, withOpenAiAuth: false });
  let harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Goal session");
    await expectGoalCommand(window);

    const composer = window.getByTestId("composer");
    await composer.fill("/go");
    await expect(window.getByTestId("slash-menu")).toContainText("goal");

    await composer.fill("/goal finish the worktree goal");
    await composer.press("Enter");
    await expect(window.locator(".timeline")).toContainText("Goal active: finish the worktree goal");
    await expect(window.getByTestId("extension-dock-summary")).toHaveText("active: finish the worktree goal");

    const dockBody = await expandGoalDock(window);
    await expect(dockBody).toContainText("goal: active: finish the worktree goal");
    await expect(dockBody).toContainText("Goal: finish the worktree goal");
    await expect(dockBody).toContainText("Usage: 0 tokens");
  } finally {
    await harness.close();
  }

  harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await selectSession(window, "Goal session");
    await expectGoalCommand(window);
    await expect(window.getByTestId("extension-dock-summary")).toHaveText("active: finish the worktree goal", {
      timeout: 15_000,
    });

    const composer = window.getByTestId("composer");
    await composer.fill("/goal complete");
    await composer.press("Enter");
    await expect(window.locator(".timeline")).toContainText("Goal complete: finish the worktree goal");
    await expect(window.getByTestId("extension-dock")).toHaveCount(0);
  } finally {
    await harness.close();
  }
});

test("auto-continues a restored active goal once a model becomes available", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("goal-restored-auto-continue-workspace");
  await writeProjectExtension(workspacePath, "goal-fake-provider.ts", goalFakeProviderExtension);

  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir, { enabledModels: [], withDefaultModel: false, withOpenAiAuth: false });

  let harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: {
      GOAL_FAKE_API_KEY: "test-goal-key",
      GOAL_FAKE_AUTO_MODEL: "0",
    },
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Goal restored auto session");
    await expectGoalCommand(window);

    const composer = window.getByTestId("composer");
    await composer.fill("/goal continue after relaunch");
    await composer.press("Enter");
    await expect(window.getByTestId("extension-dock-summary")).toHaveText("active: continue after relaunch");
  } finally {
    await harness.close();
  }

  await writeFakeProviderSettings(agentDir);

  harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: {
      GOAL_FAKE_API_KEY: "test-goal-key",
    },
  });

  try {
    const window = await harness.firstWindow();
    await selectSession(window, "Goal restored auto session");
    await expectGoalCommand(window);

    await expect(window.getByTestId("transcript")).toContainText("goal completed by fake provider", {
      timeout: 30_000,
    });
    await expect(window.locator(".timeline")).toContainText("update_goal");
    await expect(window.getByTestId("extension-dock")).toHaveCount(0);

    const composer = window.getByTestId("composer");
    await composer.fill("/goal ");
    await composer.press("Enter");
    await expect(window.locator(".timeline")).toContainText("Goal complete: continue after relaunch (30 tokens");
  } finally {
    await harness.close();
  }
});

test("resumes a paused goal by starting idle continuation", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("goal-resume-auto-continue-workspace");

  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir, { enabledModels: [], withDefaultModel: false, withOpenAiAuth: false });

  let harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Goal resume session");
    await expectGoalCommand(window);

    const composer = window.getByTestId("composer");
    await composer.fill("/goal resume should run");
    await composer.press("Enter");
    await expect(window.getByTestId("extension-dock-summary")).toHaveText("active: resume should run");

    await composer.fill("/goal pause");
    await composer.press("Enter");
    await expect(window.getByTestId("extension-dock-summary")).toHaveText("paused: resume should run");
  } finally {
    await harness.close();
  }

  await writeProjectExtension(workspacePath, "goal-fake-provider.ts", goalFakeProviderExtension);
  await writeFakeProviderSettings(agentDir, { defaultModel: false });

  harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: {
      GOAL_FAKE_API_KEY: "test-goal-key",
      GOAL_FAKE_AUTO_MODEL: "0",
    },
  });

  try {
    const window = await harness.firstWindow();
    await selectSession(window, "Goal resume session");
    await expectGoalCommand(window);
    await expect(window.getByTestId("extension-dock-summary")).toHaveText("paused: resume should run");
    await setSelectedSessionModel(window, "goal-fake", "goal-test");
    await expect(window.getByTestId("transcript")).not.toContainText("goal completed by fake provider");

    const composer = window.getByTestId("composer");
    await composer.fill("/goal resume");
    await composer.press("Enter");

    await expect(window.getByTestId("transcript")).toContainText("goal completed by fake provider", {
      timeout: 30_000,
    });
    await expect(window.locator(".timeline")).toContainText("update_goal");
    await expect(window.getByTestId("extension-dock")).toHaveCount(0);
    await expectSelectedSessionStatus(window, "idle");
  } finally {
    await harness.close();
  }
});

test("suppresses repeated idle continuation after a no-tool response", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("goal-no-tool-suppression-workspace");
  await writeProjectExtension(workspacePath, "goal-text-only-provider.ts", goalTextOnlyProviderExtension);

  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir, { enabledModels: [], withDefaultModel: false, withOpenAiAuth: false });
  await writeTextOnlyProviderSettings(agentDir);

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: {
      GOAL_FAKE_API_KEY: "test-goal-key",
    },
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Goal no tool session");
    await expectGoalCommand(window);
    await setSelectedSessionModel(window, "goal-text-only", "goal-text");

    const composer = window.getByTestId("composer");
    await composer.fill("/goal stop after one no-tool continuation");
    await composer.press("Enter");

    const transcript = window.getByTestId("transcript");
    await expect(transcript).toContainText("goal needs more work", { timeout: 30_000 });
    await expectSelectedSessionStatus(window, "idle");
    await window.waitForTimeout(500);
    await expect(transcript.getByText("goal needs more work")).toHaveCount(1);
    await expect(window.getByTestId("extension-dock-summary")).toHaveText(
      "active: stop after one no-tool continuation",
    );
  } finally {
    await harness.close();
  }
});

test("auto-continues an active goal while idle and stops after update_goal completes it", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("goal-auto-continue-workspace");
  await writeProjectExtension(workspacePath, "goal-fake-provider.ts", goalFakeProviderExtension);

  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir);
  await writeFakeProviderSettings(agentDir);

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: {
      GOAL_FAKE_API_KEY: "test-goal-key",
    },
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Goal auto session");
    await expectGoalCommand(window);
    await setSelectedSessionModel(window, "goal-fake", "goal-test");

    const composer = window.getByTestId("composer");
    await composer.fill("/goal finish through idle continuation");
    await composer.press("Enter");
    await expect(window.getByTestId("extension-dock-summary")).toHaveText(
      "active: finish through idle continuation",
    );

    await expect(window.getByTestId("transcript")).toContainText("goal completed by fake provider", {
      timeout: 30_000,
    });
    await expect(window.getByTestId("transcript")).not.toContainText("Continue working toward the active session goal.");
    await expect(window.locator(".timeline")).toContainText("update_goal");
    await expect(window.getByTestId("extension-dock")).toHaveCount(0);
    await expectSelectedSessionStatus(window, "idle");

    await composer.fill("/goal ");
    await composer.press("Enter");
    await expect(window.locator(".timeline")).toContainText(
      "Goal complete: finish through idle continuation (30 tokens",
    );
  } finally {
    await harness.close();
  }
});
