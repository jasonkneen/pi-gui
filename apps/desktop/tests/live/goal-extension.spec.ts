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
  seedGoalTreeEditorSessionFixture,
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

function textFromContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (part && typeof part === "object" && part.type === "text") {
        return part.text || "";
      }
      return "";
    })
    .join("\\n");
}

function latestPromptText(context) {
  const messages = Array.isArray(context.messages) ? context.messages : [];
  const latest = messages[messages.length - 1];
  return textFromContent(latest?.content);
}

function allPromptText(context) {
  const messages = Array.isArray(context.messages) ? context.messages : [];
  return messages.map((message) => textFromContent(message?.content)).join("\\n");
}

function streamSimple(model, context) {
  const stream = createAssistantMessageEventStream();
  const prompt = latestPromptText(context);
  const contextText = allPromptText(context);
  const configuredFirstDelayMs = Number.parseInt(process.env.GOAL_FAKE_FIRST_DELAY_MS || "10", 10);
  const firstDelayMs = Number.isFinite(configuredFirstDelayMs) ? configuredFirstDelayMs : 10;
  const delay = callCount === 0 ? firstDelayMs : 10;
  setTimeout(() => {
    callCount += 1;
    const message = assistantBase(model, callCount * 10);
    stream.push({ type: "start", partial: message });

    if (
      callCount !== 1 &&
      (
        contextText.includes("Goal continuation requested.") ||
        (
          contextText.includes("Continue working toward the active session goal.") &&
          !prompt.includes("Continue working toward the active session goal.")
        )
      )
    ) {
      pushText(stream, message, "goal continuation prompt leaked");
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
      return;
    }

    if (callCount === 1) {
      if (!prompt.includes("Continue working toward the active session goal.")) {
        pushText(stream, message, "goal continuation prompt missing");
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
        return;
      }
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
  }, delay);
  return stream;
}

export default function goalFakeProvider(pi) {
  const provider = {
    api: "openai-responses",
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
  };

  if (process.env.GOAL_FAKE_REQUIRE_STORED_AUTH === "1") {
    provider.oauth = {
      name: "Goal Fake",
      async login() {
        return { type: "api_key", key: "test-goal-key" };
      },
      async refreshToken(credentials) {
        return credentials;
      },
      getApiKey(credentials) {
        return credentials.key || "test-goal-key";
      },
    };
  } else {
    provider.apiKey = "GOAL_FAKE_API_KEY";
  }

  pi.registerProvider("goal-fake", provider);

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

const goalPromptAwareProviderExtension = String.raw`
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

function textFromContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (part && typeof part === "object" && part.type === "text") {
        return part.text || "";
      }
      return "";
    })
    .join("\\n");
}

function latestPromptText(context) {
  const messages = Array.isArray(context.messages) ? context.messages : [];
  const latest = messages[messages.length - 1];
  return textFromContent(latest?.content);
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
    id: "regular-goal-complete-call",
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

export default function goalPromptAwareProvider(pi) {
  pi.registerProvider("goal-prompt-aware", {
    api: "openai-responses",
    apiKey: "GOAL_FAKE_API_KEY",
    baseUrl: "https://example.invalid",
    models: [
      {
        id: "goal-prompt",
        name: "Goal Prompt",
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
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const prompt = latestPromptText(context);
      const shouldUpdateGoal = prompt.includes("ordinary-chat-stale-update");
      setTimeout(() => {
        const message = assistantBase(model, 10);
        stream.push({ type: "start", partial: message });
        if (shouldUpdateGoal) {
          pushUpdateGoalToolCall(stream, message);
          message.stopReason = "toolUse";
          stream.push({ type: "done", reason: "toolUse", message });
        } else {
          pushText(stream, message, "goal prompt aware no-op");
          stream.push({ type: "done", reason: "stop", message });
        }
        stream.end();
      }, shouldUpdateGoal ? 2500 : 10);
      return stream;
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const model = ctx.modelRegistry.find("goal-prompt-aware", "goal-prompt");
    if (model) {
      await pi.setModel(model);
    }
  });
}
`;

const goalBranchProbeExtension = String.raw`
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export default function goalBranchProbe(pi) {
  pi.registerCommand("seed-branch-goal", {
    description: "Seed a persisted goal for branch restoration tests",
    handler: async (args, ctx) => {
      const objective = args.trim() || "branch-only goal should not leak";
      const now = Date.now();
      const goal = {
        goalId: "branch-probe-goal",
        objective,
        status: "paused",
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: now,
        updatedAt: now,
      };
      pi.appendEntry("pi-goal.goal", {
        version: 1,
        event: "set",
        goal,
        goalId: goal.goalId,
      });
      const baseLeafId = ctx.sessionManager.getLeafId();
      ctx.sessionManager._rewriteFile?.();
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (sessionFile) {
        const sidecarPath = sessionFile + ".pi-goal.json";
        mkdirSync(dirname(sidecarPath), { recursive: true });
        writeFileSync(
          sidecarPath,
          JSON.stringify({ version: 1, goal, baseLeafId, updatedAt: now }, null, 2) + "\\n",
          "utf8",
        );
      }
      ctx.ui.notify("Seeded branch goal", "info");
    },
  });

  pi.registerCommand("rewind-before-goal", {
    description: "Navigate to the branch before the goal was set",
    handler: async (_args, ctx) => {
      const goalEntry = ctx.sessionManager.getEntries().find((entry) => {
        return entry.type === "custom" && entry.customType === "pi-goal.goal" && entry.data?.event === "set";
      });
      if (!goalEntry?.parentId) {
        throw new Error("No goal entry with a parent was available");
      }
      await ctx.navigateTree(goalEntry.parentId, { label: "before goal" });
      ctx.ui.notify("Rewound before goal", "info");
    },
  });
}
`;

const goalBudgetProbeExtension = String.raw`
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export default function goalBudgetProbe(pi) {
  pi.registerCommand("seed-exhausted-goal", {
    description: "Seed an active goal whose token budget is already exhausted",
    handler: async (args, ctx) => {
      const objective = args.trim() || "budgeted goal should not continue";
      const now = Date.now();
      const goal = {
        goalId: "budget-probe-goal",
        objective,
        status: "active",
        tokenBudget: 10,
        tokensUsed: 10,
        timeUsedSeconds: 0,
        createdAt: now,
        updatedAt: now,
      };
      pi.appendEntry("pi-goal.goal", {
        version: 1,
        event: "set",
        goal,
        goalId: goal.goalId,
      });
      const baseLeafId = ctx.sessionManager.getLeafId();
      ctx.sessionManager._rewriteFile?.();
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (sessionFile) {
        const sidecarPath = sessionFile + ".pi-goal.json";
        mkdirSync(dirname(sidecarPath), { recursive: true });
        writeFileSync(
          sidecarPath,
          JSON.stringify({ version: 1, goal, baseLeafId, updatedAt: now }, null, 2) + "\\n",
          "utf8",
        );
      }
      ctx.ui.notify("Seeded exhausted goal", "info");
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

async function writePromptAwareProviderSettings(agentDir: string): Promise<void> {
  const modelsPath = join(agentDir, "models.json");
  const models = {
    providers: {
      "goal-prompt-aware": {
        name: "Goal Prompt Aware",
        api: "openai-responses",
        apiKey: "GOAL_FAKE_API_KEY",
        baseUrl: "https://example.invalid",
        models: [
          {
            id: "goal-prompt",
            name: "Goal Prompt",
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
  settings.defaultProvider = "goal-prompt-aware";
  settings.defaultModel = "goal-prompt";
  delete settings.enabledModels;
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

  const authPath = join(agentDir, "auth.json");
  const auth = JSON.parse(await readFile(authPath, "utf8")) as Record<string, unknown>;
  auth["goal-prompt-aware"] = { type: "api_key", key: "test-goal-key" };
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

async function selectedSessionPreview(window: Page): Promise<string | undefined> {
  const state = await getDesktopState(window);
  const selectedWorkspace = state.workspaces.find((entry) => entry.id === state.selectedWorkspaceId);
  return selectedWorkspace?.sessions.find((entry) => entry.id === state.selectedSessionId)?.preview;
}

async function selectedSessionFile(userDataDir: string, window: Page): Promise<string> {
  const state = await getDesktopState(window);
  const catalogs = JSON.parse(await readFile(join(userDataDir, "catalogs.json"), "utf8")) as {
    sessionFiles?: Record<string, string>;
  };
  const sessionFile = catalogs.sessionFiles?.[`${state.selectedWorkspaceId}:${state.selectedSessionId}`];
  expect(sessionFile).toBeTruthy();
  return sessionFile!;
}

async function selectedSessionTreePreviews(window: Page, customType: string): Promise<(string | undefined)[]> {
  return window.evaluate(async ({ targetCustomType }) => {
    const app = (window as Window & { piApp?: import("../../src/ipc").PiDesktopApi }).piApp;
    if (!app) {
      throw new Error("piApp IPC bridge is unavailable");
    }
    const state = await app.getState();
    const tree = await app.getSessionTree({
      workspaceId: state.selectedWorkspaceId,
      sessionId: state.selectedSessionId,
    });
    const previews: (string | undefined)[] = [];
    const visit = (nodes: typeof tree.roots): void => {
      for (const node of nodes) {
        if (node.customType === targetCustomType) {
          previews.push(node.preview);
        }
        visit(node.children);
      }
    };
    visit(tree.roots);
    return previews;
  }, { targetCustomType: customType });
}

async function writeLegacyGoalOnlySidecar(sessionFile: string, objective: string): Promise<void> {
  const entries = (await readFile(sessionFile, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const header = entries.find((entry) => entry.type === "session");
  expect(header).toBeTruthy();
  await writeFile(sessionFile, `${JSON.stringify(header)}\n`, "utf8");

  const now = Date.now();
  const goal = {
    goalId: "legacy-sidecar-goal",
    objective,
    status: "active",
    tokenBudget: 1,
    tokensUsed: 1,
    timeUsedSeconds: 0,
    createdAt: now,
    updatedAt: now,
  };
  await writeFile(
    `${sessionFile}.pi-goal.json`,
    `${JSON.stringify({ version: 1, goal, updatedAt: now }, null, 2)}\n`,
    "utf8",
  );
}

async function sessionHeaderCount(sessionFile: string): Promise<number> {
  return (await readFile(sessionFile, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.type === "session").length;
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

test("restores legacy sidecar-only goals without base leaf metadata", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("goal-legacy-sidecar-workspace");
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir);
  let sessionFile = "";
  let harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Goal legacy sidecar session");
    await expectGoalCommand(window);
    sessionFile = await selectedSessionFile(userDataDir, window);
  } finally {
    await harness.close();
  }

  await writeLegacyGoalOnlySidecar(sessionFile, "restore old sidecar");

  harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await selectSession(window, "Goal legacy sidecar session");
    await expectGoalCommand(window);
    await expect(window.getByTestId("extension-dock-summary")).toHaveText("active: restore old sidecar", {
      timeout: 15_000,
    });

    const composer = window.getByTestId("composer");
    await composer.fill("/goal pause");
    await composer.press("Enter");
    await expect(window.getByTestId("extension-dock-summary")).toHaveText("paused: restore old sidecar");

    const migratedSidecar = JSON.parse(await readFile(`${sessionFile}.pi-goal.json`, "utf8")) as {
      baseLeafId?: unknown;
    };
    expect(typeof migratedSidecar.baseLeafId).toBe("string");
  } finally {
    await harness.close();
  }
});

test("does not restore a sidecar goal on a branch before the goal was set", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("goal-branch-sidecar-workspace");
  await writeProjectExtension(workspacePath, "goal-branch-probe.ts", goalBranchProbeExtension);

  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir, { enabledModels: [], withDefaultModel: false, withOpenAiAuth: false });

  let harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Goal branch sidecar session");
    await expectGoalCommand(window);

    const composer = window.getByTestId("composer");
    await composer.fill("/seed-branch-goal branch-only goal should not leak");
    await composer.press("Enter");
    await expect(window.locator(".timeline")).toContainText("Seeded branch goal");

    await composer.fill("/goal ");
    await composer.press("Enter");
    await expect(window.getByTestId("extension-dock-summary")).toHaveText(
      "paused: branch-only goal should not leak",
    );

    await composer.fill("/rewind-before-goal");
    await window.getByRole("button", { name: "Send message" }).click();
    await expect(window.locator(".timeline")).toContainText("Rewound before goal");
    await expect(window.getByTestId("extension-dock")).toHaveCount(0);
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
    await selectSession(window, "Goal branch sidecar session");
    await expectGoalCommand(window);
    await expect(window.getByTestId("extension-dock")).toHaveCount(0);

    const composer = window.getByTestId("composer");
    await composer.fill("/goal ");
    await composer.press("Enter");
    await expect(window.locator(".timeline")).toContainText("Usage: /goal <objective>");
  } finally {
    await harness.close();
  }
});

test("auto-continues a restored active goal once a model becomes available", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("goal-restored-auto-continue-workspace");

  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir, { enabledModels: [], withDefaultModel: false, withOpenAiAuth: false });
  let sessionFile = "";

  let harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Goal restored auto session");
    await expectGoalCommand(window);

    const composer = window.getByTestId("composer");
    await composer.fill("/goal continue after relaunch");
    await composer.press("Enter");
    await expect(window.getByTestId("extension-dock-summary")).toHaveText("active: continue after relaunch");
    sessionFile = await selectedSessionFile(userDataDir, window);
    expect(await sessionHeaderCount(sessionFile)).toBe(1);
  } finally {
    await harness.close();
  }

  await seedAgentDir(agentDir, { withOpenAiAuth: false });

  harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
    scrubProviderEnv: true,
  });

  try {
    const window = await harness.firstWindow();
    await selectSession(window, "Goal restored auto session");
    await expectGoalCommand(window);
    await expect(window.getByTestId("extension-dock-summary")).toHaveText("active: continue after relaunch");
    await expectSelectedSessionStatus(window, "idle");
    await window.waitForTimeout(500);
    await expect(window.getByTestId("transcript")).not.toContainText("Authentication");
  } finally {
    await harness.close();
  }

  await writeProjectExtension(workspacePath, "goal-fake-provider.ts", goalFakeProviderExtension);
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
    expect(await sessionHeaderCount(sessionFile)).toBe(1);
  } finally {
    await harness.close();
  }
});

test("does not auto-continue while a tree prompt is reopened for editing", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("goal-tree-editor-workspace");

  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir, { enabledModels: [], withDefaultModel: false, withOpenAiAuth: false });
  await seedGoalTreeEditorSessionFixture(agentDir, workspacePath);

  let harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await selectSession(window, "Goal tree editor fixture session");
    await expectGoalCommand(window);
    await expect(window.getByTestId("extension-dock-summary")).toHaveText(
      "active: continue after editing a tree prompt",
    );

    const composer = window.getByTestId("composer");
    await composer.fill("/tree");
    await composer.press("Enter");

    const treeModal = window.getByTestId("tree-modal");
    await expect(treeModal).toBeVisible();
    await treeModal.locator(".tree-row__content", { hasText: "Edit this branch prompt" }).click();
    await treeModal.getByRole("button", { name: "Continue" }).click();
    await treeModal.getByRole("button", { name: "No summary" }).click();
    await treeModal.getByRole("button", { name: "Switch branch" }).click();
    await expect(treeModal).toHaveCount(0);
    await expect(composer).toHaveValue("Edit this branch prompt");
    await expect(window.getByTestId("extension-dock-summary")).toHaveText(
      "active: continue after editing a tree prompt",
    );
    await expectSelectedSessionStatus(window, "idle");
  } finally {
    await harness.close();
  }

  await writeProjectExtension(workspacePath, "goal-fake-provider.ts", goalFakeProviderExtension);
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
    await selectSession(window, "Goal tree editor fixture session");
    await expectGoalCommand(window);
    await expect(window.getByTestId("extension-dock-summary")).toHaveText(
      "active: continue after editing a tree prompt",
    );
    await expectSelectedSessionStatus(window, "idle");
    await window.waitForTimeout(750);
    await expect(window.getByTestId("transcript")).not.toContainText("goal completed by fake provider");
    await expect(window.locator(".timeline")).not.toContainText("update_goal");
    await expect(window.getByTestId("extension-dock-summary")).toHaveText(
      "active: continue after editing a tree prompt",
    );
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

  let harness = await launchDesktop(userDataDir, {
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
    await selectSession(window, "Goal no tool session");
    await expectGoalCommand(window);

    const transcript = window.getByTestId("transcript");
    await expect(transcript.getByText("goal needs more work")).toHaveCount(1);
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

test("does not auto-continue when the token budget is exhausted", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("goal-budget-exhausted-workspace");
  await writeProjectExtension(workspacePath, "goal-text-only-provider.ts", goalTextOnlyProviderExtension);
  await writeProjectExtension(workspacePath, "goal-budget-probe.ts", goalBudgetProbeExtension);

  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir, { enabledModels: [], withDefaultModel: false, withOpenAiAuth: false });
  await writeTextOnlyProviderSettings(agentDir);

  let harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: {
      GOAL_FAKE_API_KEY: "test-goal-key",
    },
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Goal exhausted budget session");
    await expectGoalCommand(window);
    await setSelectedSessionModel(window, "goal-text-only", "goal-text");

    const composer = window.getByTestId("composer");
    await composer.fill("/seed-exhausted-goal exhausted budget should stay idle");
    await composer.press("Enter");
    await expect(window.locator(".timeline")).toContainText("Seeded exhausted goal");
  } finally {
    await harness.close();
  }

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
    await selectSession(window, "Goal exhausted budget session");
    await expectGoalCommand(window);
    await expect(window.getByTestId("extension-dock-summary")).toHaveText(
      "active: exhausted budget should stay idle",
    );

    const dockBody = await expandGoalDock(window);
    await expect(dockBody).toContainText("Usage: 10/10 tokens");
    await expectSelectedSessionStatus(window, "idle");
    await window.waitForTimeout(500);
    await expect(window.getByTestId("transcript")).not.toContainText("goal needs more work");
    await expectSelectedSessionStatus(window, "idle");
  } finally {
    await harness.close();
  }
});

test("keeps hidden continuation prompts private and ignores stale completion after replacing a goal", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("goal-stale-continuation-workspace");
  await writeProjectExtension(workspacePath, "goal-fake-provider.ts", goalFakeProviderExtension);

  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir, { enabledModels: [], withDefaultModel: false, withOpenAiAuth: false });
  await writeFakeProviderSettings(agentDir);

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
    envOverrides: {
      GOAL_FAKE_API_KEY: "test-goal-key",
      GOAL_FAKE_FIRST_DELAY_MS: "8000",
    },
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Goal stale continuation session");
    await expectGoalCommand(window);
    await setSelectedSessionModel(window, "goal-fake", "goal-test");

    const composer = window.getByTestId("composer");
    await composer.fill("/goal stale continuation should be replaced");
    await composer.press("Enter");
    await expect(window.getByTestId("extension-dock-summary")).toHaveText(
      "active: stale continuation should be replaced",
    );
    await expectSelectedSessionStatus(window, "running");

    const sessionFile = await selectedSessionFile(userDataDir, window);
    await composer.fill("/goal replacement survives stale completion");
    await composer.press("Enter");
    const dialog = window.getByTestId("extension-dialog");
    await expect(dialog).toContainText("Replace goal?");
    await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(window.locator(".timeline")).toContainText("Goal active: replacement survives stale completion");
    await expect(window.getByTestId("extension-dock-summary")).toHaveText(
      "active: replacement survives stale completion",
    );

    await expect
      .poll(async () => {
        const sessionContents = await readFile(sessionFile, "utf8");
        if (sessionContents.includes("Continue working toward the active session goal.")) {
          return "leaked";
        }
        return sessionContents.includes("pi-goal.goal.continuation") ? "private" : "pending";
      }, { timeout: 30_000 })
      .toBe("private");
    await expect.poll(async () => readFile(sessionFile, "utf8")).toContain("Goal continuation requested.");
    await expect
      .poll(async () => selectedSessionTreePreviews(window, "pi-goal.goal.continuation"), { timeout: 30_000 })
      .toEqual([]);
    await expect
      .poll(async () => (await selectedSessionPreview(window)) ?? "")
      .not.toContain("Continue working toward the active session goal.");

    await window.waitForTimeout(9000);
    await expect(window.getByTestId("extension-dock-summary")).toHaveText(
      "active: replacement survives stale completion",
    );
    await expect(window.getByTestId("transcript")).not.toContainText("goal continuation prompt leaked");
    await expect(window.locator(".timeline")).not.toContainText(
      "Goal complete: replacement survives stale completion",
    );

    await composer.fill("/goal ");
    await composer.press("Enter");
    await expect(window.locator(".timeline")).toContainText("Goal active: replacement survives stale completion");
  } finally {
    await harness.close();
  }
});

test("ignores stale update_goal from a regular turn after replacing a goal", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("goal-stale-regular-turn-workspace");
  await writeProjectExtension(workspacePath, "goal-prompt-aware-provider.ts", goalPromptAwareProviderExtension);

  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir, { enabledModels: [], withDefaultModel: false, withOpenAiAuth: false });
  await writePromptAwareProviderSettings(agentDir);

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
    await createNamedThread(window, "Goal stale regular turn session");
    await expectGoalCommand(window);

    const composer = window.getByTestId("composer");
    await composer.fill("/goal stale regular turn should be replaced");
    await composer.press("Enter");
    await expect(window.getByTestId("extension-dock-summary")).toHaveText(
      "active: stale regular turn should be replaced",
    );
    await expect(window.getByTestId("transcript")).toContainText("goal prompt aware no-op", {
      timeout: 30_000,
    });
    await expectSelectedSessionStatus(window, "idle");

    await composer.fill("ordinary-chat-stale-update");
    await composer.press("Enter");
    await expectSelectedSessionStatus(window, "running");

    await composer.fill("/goal replacement survives regular stale completion");
    await composer.press("Enter");
    const dialog = window.getByTestId("extension-dialog");
    await expect(dialog).toContainText("Replace goal?");
    await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(window.locator(".timeline")).toContainText(
      "Goal active: replacement survives regular stale completion",
    );
    await expect(window.getByTestId("extension-dock-summary")).toHaveText(
      "active: replacement survives regular stale completion",
    );

    await expect(window.locator(".timeline")).toContainText("Ran update_goal", { timeout: 30_000 });
    await expectSelectedSessionStatus(window, "idle");
    await expect(window.getByTestId("extension-dock-summary")).toHaveText(
      "active: replacement survives regular stale completion",
    );
    await expect(window.locator(".timeline")).not.toContainText(
      "Goal complete: replacement survives regular stale completion",
    );

    await composer.fill("/goal ");
    await composer.press("Enter");
    await expect(window.locator(".timeline")).toContainText(
      "Goal active: replacement survives regular stale completion",
    );
  } finally {
    await harness.close();
  }
});

test("ignores stale update_goal from a turn that started while the goal was paused", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("goal-paused-stale-turn-workspace");
  await writeProjectExtension(workspacePath, "goal-prompt-aware-provider.ts", goalPromptAwareProviderExtension);

  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir, { enabledModels: [], withDefaultModel: false, withOpenAiAuth: false });
  await writePromptAwareProviderSettings(agentDir);

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
    await createNamedThread(window, "Goal paused stale turn session");
    await expectGoalCommand(window);

    const composer = window.getByTestId("composer");
    await composer.fill("/goal paused stale turn should survive resume");
    await composer.press("Enter");
    await expect(window.getByTestId("extension-dock-summary")).toHaveText(
      "active: paused stale turn should survive resume",
    );
    await expect(window.getByTestId("transcript")).toContainText("goal prompt aware no-op", {
      timeout: 30_000,
    });
    await expectSelectedSessionStatus(window, "idle");

    await composer.fill("/goal pause");
    await composer.press("Enter");
    await expect(window.getByTestId("extension-dock-summary")).toHaveText(
      "paused: paused stale turn should survive resume",
    );

    await composer.fill("ordinary-chat-stale-update");
    await composer.press("Enter");
    await expectSelectedSessionStatus(window, "running");

    await composer.fill("/goal resume");
    await composer.press("Enter");
    await expect(window.locator(".timeline")).toContainText("Goal active: paused stale turn should survive resume");
    await expect(window.getByTestId("extension-dock-summary")).toHaveText(
      "active: paused stale turn should survive resume",
    );

    await expect(window.locator(".timeline")).toContainText("Ran update_goal", { timeout: 30_000 });
    await expectSelectedSessionStatus(window, "idle");
    await expect(window.getByTestId("extension-dock-summary")).toHaveText(
      "active: paused stale turn should survive resume",
    );
    await expect(window.locator(".timeline")).not.toContainText(
      "Goal complete: paused stale turn should survive resume",
    );

    await composer.fill("/goal ");
    await composer.press("Enter");
    await expect(window.locator(".timeline")).toContainText("Goal active: paused stale turn should survive resume");
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
    await expect(window.getByTestId("transcript")).not.toContainText("goal continuation prompt leaked");
    await expect(window.locator(".timeline")).toContainText("update_goal");
    await expect(window.getByTestId("extension-dock")).toHaveCount(0);
    await expectSelectedSessionStatus(window, "idle");

    await composer.fill("normal chat after complete");
    await composer.press("Enter");
    await expect(window.getByTestId("transcript").getByText("goal completed by fake provider")).toHaveCount(2, {
      timeout: 30_000,
    });

    await composer.fill("/goal ");
    await composer.press("Enter");
    await expect(window.locator(".timeline")).toContainText(
      "Goal complete: finish through idle continuation (30 tokens",
    );
  } finally {
    await harness.close();
  }
});
