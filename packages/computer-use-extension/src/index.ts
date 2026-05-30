import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

type HelperContent =
  | {
      readonly type: "text";
      readonly text: string;
    }
  | {
      readonly type: "image";
      readonly data: string;
      readonly mimeType: string;
    };

type JsonSchema = {
  readonly type?: string;
  readonly description?: string;
  readonly properties?: Record<string, JsonSchema>;
  readonly required?: string[];
  readonly anyOf?: JsonSchema[];
  readonly enum?: readonly unknown[];
};

type PropertySchema = JsonSchema & { readonly optional?: boolean };
type ComputerUseTool = Omit<ToolDefinition<any, unknown>, "execute"> & {
  readonly execute: (
    toolCallId: string,
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: any,
    ctx: ExtensionContext,
  ) => Promise<AgentToolResult<unknown>>;
};

interface HelperResponse {
  readonly ok: boolean;
  readonly content?: readonly HelperContent[];
  readonly details?: unknown;
  readonly error?: string;
}

const helperPathEnv = "PI_GUI_COMPUTER_USE_HELPER_PATH";
const autoAllowEnv = "PI_GUI_COMPUTER_USE_AUTO_ALLOW";
const appConfirmEnv = "PI_GUI_COMPUTER_USE_REQUIRE_APP_CONFIRMATION";
const toolTimeoutMs = 20_000;
const maxHelperOutputBytes = 24 * 1024 * 1024;
const allowedApps = new Set<string>();
const computerUseFailureResults = new Map<string, AgentToolResult<unknown>>();
const blockedToolGuideline =
  "If a Computer Use tool result says blocked or unavailable, do not retry the same action; report the exact status and the user action needed to continue.";

function objectSchema(properties: Record<string, PropertySchema>): any {
  const entries = Object.entries(properties);
  const required = entries.filter(([, schema]) => !schema.optional).map(([name]) => name);
  return {
    type: "object",
    ...(required.length > 0 ? { required } : {}),
    properties: Object.fromEntries(entries.map(([name, schema]) => [name, stripOptional(schema)])),
  };
}

function stringSchema(options: Pick<JsonSchema, "description"> = {}): PropertySchema {
  return { type: "string", ...options };
}

function numberSchema(options: Pick<JsonSchema, "description"> = {}): PropertySchema {
  return { type: "number", ...options };
}

function integerSchema(options: Pick<JsonSchema, "description"> = {}): PropertySchema {
  return { type: "integer", ...options };
}

function enumSchema(values: readonly string[], options: Pick<JsonSchema, "description"> = {}): PropertySchema {
  return { type: "string", enum: values, ...options };
}

function optional(schema: PropertySchema): PropertySchema {
  return { ...schema, optional: true };
}

function stripOptional(schema: PropertySchema): JsonSchema {
  const { optional: _optional, ...rest } = schema;
  return rest;
}

const AppParams = {
  app: stringSchema({ description: "App name, full app path, or unambiguous bundle identifier" }),
};

const statusTool: ComputerUseTool = {
  name: "computer_use_status",
  label: "Computer Use Status",
  description:
    "Check Computer Use helper availability, permissions, desktop lock state, and locked-use readiness without controlling an app.",
  promptSnippet: "Check whether local Mac Computer Use is ready",
  promptGuidelines: [blockedToolGuideline],
  parameters: objectSchema({}),
  executionMode: "sequential",
  async execute(toolCallId, _params, signal, _onUpdate, _ctx) {
    return runComputerUseAction(signal, () => callHelper(toolCallId, "status", {}, signal));
  },
};

const listAppsTool: ComputerUseTool = {
  name: "list_apps",
  label: "List Apps",
  description:
    "List the apps on this Mac. Returns running apps plus common installed apps that Pi can inspect or control.",
  promptSnippet: "List local Mac apps available for Computer Use",
  parameters: objectSchema({}),
  executionMode: "sequential",
  async execute(toolCallId, _params, signal, _onUpdate, _ctx) {
    return runComputerUseAction(signal, () => callHelper(toolCallId, "list_apps", {}, signal));
  },
};

const getAppStateTool: ComputerUseTool = {
  name: "get_app_state",
  label: "Get App State",
  description:
    "Start an app use session if needed, then get the state of the app's key window and return a screenshot and numbered accessibility tree. This must be called once per turn before interacting with the app.",
  promptSnippet: "Inspect a Mac app with screenshot plus numbered accessibility tree",
  promptGuidelines: [
    "Call get_app_state once before clicking, typing, pressing keys, scrolling, dragging, setting values, performing secondary actions, or selecting text in an app.",
    "Use element_index values from the latest get_app_state result whenever possible; use screenshot coordinates only when the accessibility tree cannot target the element.",
    blockedToolGuideline,
  ],
  parameters: objectSchema(AppParams),
  executionMode: "sequential",
  async execute(toolCallId, params, signal, _onUpdate, ctx) {
    await ensureAppAllowed(ctx, params.app);
    return runComputerUseAction(signal, () => callHelper(toolCallId, "get_app_state", params, signal));
  },
};

const clickTool: ComputerUseTool = {
  name: "click",
  label: "Click",
  description: "Click an element by index or pixel coordinates from the latest screenshot.",
  promptSnippet: "Click a Mac app element or screenshot coordinate",
  parameters: objectSchema({
    ...AppParams,
    element_index: optional(stringSchema({ description: "Element index to click" })),
    x: optional(numberSchema({ description: "X coordinate in screenshot pixel coordinates" })),
    y: optional(numberSchema({ description: "Y coordinate in screenshot pixel coordinates" })),
    click_count: optional(integerSchema({ description: "Number of clicks. Defaults to 1" })),
    mouse_button: optional(
      enumSchema(["left", "right", "middle"], {
        description: "Mouse button to click. Defaults to left.",
      }),
    ),
  }),
  executionMode: "sequential",
  async execute(toolCallId, params, signal, _onUpdate, ctx) {
    await ensureAppAllowed(ctx, params.app);
    return runComputerUseAction(signal, () => callHelper(toolCallId, "click", params, signal));
  },
};

const performSecondaryActionTool: ComputerUseTool = {
  name: "perform_secondary_action",
  label: "Secondary Action",
  description: "Invoke a secondary accessibility action exposed by an element.",
  promptSnippet: "Perform a secondary Mac accessibility action",
  parameters: objectSchema({
    ...AppParams,
    element_index: stringSchema({ description: "Element identifier" }),
    action: stringSchema({ description: "Secondary accessibility action name" }),
  }),
  executionMode: "sequential",
  async execute(toolCallId, params, signal, _onUpdate, ctx) {
    await ensureAppAllowed(ctx, params.app);
    return runComputerUseAction(signal, () => callHelper(toolCallId, "perform_secondary_action", params, signal));
  },
};

const setValueTool: ComputerUseTool = {
  name: "set_value",
  label: "Set Value",
  description: "Set the value of a settable accessibility element.",
  promptSnippet: "Set the value of a Mac accessibility element",
  parameters: objectSchema({
    ...AppParams,
    element_index: stringSchema({ description: "Element identifier" }),
    value: stringSchema({ description: "Value to assign" }),
  }),
  executionMode: "sequential",
  async execute(toolCallId, params, signal, _onUpdate, ctx) {
    await ensureAppAllowed(ctx, params.app);
    return runComputerUseAction(signal, () => callHelper(toolCallId, "set_value", params, signal));
  },
};

const selectTextTool: ComputerUseTool = {
  name: "select_text",
  label: "Select Text",
  description:
    "Select text inside a text element, or place the text cursor before or after it. Provide text exactly as it appears in the accessibility tree.",
  promptSnippet: "Select text or place the cursor in a Mac text element",
  parameters: objectSchema({
    ...AppParams,
    element_index: stringSchema({ description: "Text element identifier" }),
    text: stringSchema({ description: "Target text as shown in the accessibility tree" }),
    prefix: optional(stringSchema({ description: "Optional text immediately before the target" })),
    suffix: optional(stringSchema({ description: "Optional text immediately after the target" })),
    selection: optional(
      enumSchema(["text", "cursor_before", "cursor_after"], {
        description: "Whether to select the text or place the cursor before or after it. Defaults to text.",
      }),
    ),
  }),
  executionMode: "sequential",
  async execute(toolCallId, params, signal, _onUpdate, ctx) {
    await ensureAppAllowed(ctx, params.app);
    return runComputerUseAction(signal, () => callHelper(toolCallId, "select_text", params, signal));
  },
};

const scrollTool: ComputerUseTool = {
  name: "scroll",
  label: "Scroll",
  description: "Scroll an element in a direction by a number of pages.",
  promptSnippet: "Scroll a Mac app element",
  parameters: objectSchema({
    ...AppParams,
    element_index: stringSchema({ description: "Element identifier" }),
    direction: stringSchema({ description: "Scroll direction: up, down, left, or right" }),
    pages: optional(numberSchema({ description: "Number of pages to scroll. Fractional values are supported." })),
  }),
  executionMode: "sequential",
  async execute(toolCallId, params, signal, _onUpdate, ctx) {
    await ensureAppAllowed(ctx, params.app);
    return runComputerUseAction(signal, () => callHelper(toolCallId, "scroll", params, signal));
  },
};

const dragTool: ComputerUseTool = {
  name: "drag",
  label: "Drag",
  description: "Drag from one point to another using pixel coordinates from the latest screenshot.",
  promptSnippet: "Drag inside a Mac app using screenshot coordinates",
  parameters: objectSchema({
    ...AppParams,
    from_x: numberSchema({ description: "Start X coordinate" }),
    from_y: numberSchema({ description: "Start Y coordinate" }),
    to_x: numberSchema({ description: "End X coordinate" }),
    to_y: numberSchema({ description: "End Y coordinate" }),
  }),
  executionMode: "sequential",
  async execute(toolCallId, params, signal, _onUpdate, ctx) {
    await ensureAppAllowed(ctx, params.app);
    return runComputerUseAction(signal, () => callHelper(toolCallId, "drag", params, signal));
  },
};

const pressKeyTool: ComputerUseTool = {
  name: "press_key",
  label: "Press Key",
  description:
    "Press a key or key-combination on the keyboard using xdotool-style syntax, such as Return, Tab, super+c, Up, plus, equals, or KP_0.",
  promptSnippet: "Press a key or key combination in a Mac app",
  parameters: objectSchema({
    ...AppParams,
    key: stringSchema({ description: "Key or key combination to press" }),
  }),
  executionMode: "sequential",
  async execute(toolCallId, params, signal, _onUpdate, ctx) {
    await ensureAppAllowed(ctx, params.app);
    return runComputerUseAction(signal, () => callHelper(toolCallId, "press_key", params, signal));
  },
};

const typeTextTool: ComputerUseTool = {
  name: "type_text",
  label: "Type Text",
  description:
    "Type literal text. Provide element_index for text fields when available so Pi can type through Accessibility without activating the app.",
  promptSnippet: "Type literal text into a Mac app",
  promptGuidelines: [
    "Prefer element_index for visible text fields or text areas from the latest get_app_state result; this keeps typing background-friendly.",
    "Omit element_index only when the app must receive literal keyboard input or the accessibility tree cannot target the text destination.",
  ],
  parameters: objectSchema({
    ...AppParams,
    element_index: optional(stringSchema({ description: "Editable text element index to type into" })),
    text: stringSchema({ description: "Literal text to type" }),
  }),
  executionMode: "sequential",
  async execute(toolCallId, params, signal, _onUpdate, ctx) {
    await ensureAppAllowed(ctx, params.app);
    return runComputerUseAction(signal, () => callHelper(toolCallId, "type_text", params, signal));
  },
};

export default function computerUseExtension(pi: ExtensionAPI): void {
  pi.registerTool(statusTool);
  pi.registerTool(listAppsTool);
  pi.registerTool(getAppStateTool);
  pi.registerTool(clickTool);
  pi.registerTool(performSecondaryActionTool);
  pi.registerTool(setValueTool);
  pi.registerTool(selectTextTool);
  pi.registerTool(scrollTool);
  pi.registerTool(dragTool);
  pi.registerTool(pressKeyTool);
  pi.registerTool(typeTextTool);

  pi.on("tool_result", async (event) => {
    const result = computerUseFailureResults.get(event.toolCallId);
    if (!result) {
      return;
    }
    computerUseFailureResults.delete(event.toolCallId);
    return { content: result.content, details: result.details, isError: true };
  });

  pi.on("turn_end", async (_event, ctx) => {
    computerUseFailureResults.clear();
    ctx.ui.setWidget("computer-use", undefined);
  });
}

async function ensureAppAllowed(ctx: ExtensionContext, app: string): Promise<void> {
  if (process.env[autoAllowEnv] === "1" || process.env[appConfirmEnv] === "0") {
    allowedApps.add(app);
    return;
  }
  if (allowedApps.has(app)) {
    return;
  }
  if (!ctx.hasUI) {
    throw new Error(`Computer Use needs approval before controlling ${app}. Re-run in Pi GUI to approve this app.`);
  }
  const ok = await ctx.ui.confirm(
    "Allow Computer Use",
    `Allow Pi to inspect and control ${app}? Use this only for apps you intend Pi to operate.`,
    { timeout: 60_000 },
  );
  if (!ok) {
    throw new Error(`Computer Use access to ${app} was not approved.`);
  }
  allowedApps.add(app);
}

async function runComputerUseAction(
  signal: AbortSignal | undefined,
  action: () => Promise<AgentToolResult<unknown>>,
): Promise<AgentToolResult<unknown>> {
  if (signal?.aborted) {
    throw new Error("Computer Use action was cancelled.");
  }
  return action();
}

async function callHelper(
  toolCallId: string,
  action: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<AgentToolResult<unknown>> {
  let helperPath: string;
  try {
    helperPath = await resolveHelperPath();
  } catch (error) {
    throwComputerUseFailure(toolCallId, errorMessage(error), { errorCode: "helper_unavailable" });
  }

  let response: HelperResponse;
  try {
    response = await runHelper(helperPath, { ...params, command: action }, signal);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    const message = errorMessage(error);
    throwComputerUseFailure(toolCallId, message, { errorCode: classifyComputerUseError(message, {}) });
  }

  if (!response.ok) {
    throwComputerUseFailure(toolCallId, response.error ?? "Computer Use helper failed.", response.details);
  }
  const content: HelperContent[] =
    response.content === undefined
      ? [{ type: "text", text: "Computer Use action completed." }]
      : response.content.map((item) => ({ ...item }));
  return {
    content,
    details: response.details ?? {},
  };
}

function throwComputerUseFailure(toolCallId: string, message: string, details: unknown): never {
  const result = computerUseFailureResult(message, details);
  computerUseFailureResults.set(toolCallId, result);
  throw new Error(textForResult(result));
}

function computerUseFailureResult(message: string, details: unknown): AgentToolResult<unknown> {
  const normalizedDetails = normalizeDetails(details);
  const errorCode = classifyComputerUseError(message, normalizedDetails);
  return {
    content: [
      {
        type: "text",
        text: `${failureTitle(errorCode)}\n${message}\n\nRun computer_use_status to check the current helper, permission, and lock-screen state before retrying.`,
      },
    ],
    details: {
      ...normalizedDetails,
      ok: false,
      errorCode,
      error: message,
    },
  };
}

function textForResult(result: AgentToolResult<unknown>): string {
  return result.content.find((item) => item.type === "text")?.text ?? "Computer Use failed.";
}

function normalizeDetails(details: unknown): Record<string, unknown> {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return {};
  }
  return { ...(details as Record<string, unknown>) };
}

function classifyComputerUseError(message: string, details: Record<string, unknown>): string {
  if (typeof details.errorCode === "string" && details.errorCode.trim()) {
    return details.errorCode;
  }
  if (message.includes("Mac is locked")) {
    return "desktop_locked";
  }
  if (message.includes("Accessibility permission")) {
    return "accessibility_denied";
  }
  if (message.includes("Screen Recording permission")) {
    return "screen_recording_denied";
  }
  if (message.includes("target window screenshot is unavailable")) {
    return "screenshot_unavailable";
  }
  if (message.includes("helper is not configured") || message.includes("ENOENT") || message.includes("not found")) {
    return "helper_unavailable";
  }
  if (message.includes("timed out")) {
    return "helper_timeout";
  }
  return "helper_failed";
}

function failureTitle(errorCode: string): string {
  switch (errorCode) {
    case "desktop_locked":
      return "Computer Use blocked: the Mac is locked.";
    case "accessibility_denied":
      return "Computer Use blocked: Accessibility permission is not enabled.";
    case "screen_recording_denied":
      return "Computer Use blocked: Screen Recording permission is not enabled.";
    case "screenshot_unavailable":
      return "Computer Use blocked: the target screenshot is unavailable.";
    case "helper_unavailable":
      return "Computer Use unavailable: the helper is not configured.";
    case "helper_timeout":
      return "Computer Use failed: the helper timed out.";
    default:
      return "Computer Use failed.";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return errorMessage(error) === "Computer Use action was cancelled.";
}

async function resolveHelperPath(): Promise<string> {
  const helperPath = process.env[helperPathEnv]?.trim();
  if (!helperPath) {
    throw new Error(`Computer Use helper is not configured. Missing ${helperPathEnv}.`);
  }
  await access(helperPath);
  return helperPath;
}

function runHelper(
  helperPath: string,
  request: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<HelperResponse> {
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`Computer Use helper timed out after ${toolTimeoutMs}ms.`));
    }, toolTimeoutMs);
    const abort = () => {
      child.kill("SIGTERM");
      finish(new Error("Computer Use action was cancelled."));
    };
    const finish = (error?: Error, response?: HelperResponse) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) {
        reject(error);
      } else {
        resolve(response ?? { ok: false, error: "Computer Use helper produced no response." });
      }
    };

    signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > maxHelperOutputBytes) {
        child.kill("SIGTERM");
        finish(new Error("Computer Use helper output exceeded the maximum size."));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (settled) {
        return;
      }

      if (stdout.trim()) {
        try {
          finish(undefined, JSON.parse(stdout) as HelperResponse);
          return;
        } catch (error) {
          if (code === 0) {
            const message = error instanceof Error ? error.message : String(error);
            finish(new Error(`Computer Use helper returned invalid JSON: ${message}`));
            return;
          }
        }
      }

      if (code !== 0) {
        finish(new Error(stderr.trim() || `Computer Use helper exited with code ${code}.`));
        return;
      }

      finish(new Error("Computer Use helper produced no response."));
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}
