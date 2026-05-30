import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import computerUseExtension from "../dist/index.js";

const tools = new Map();
const handlers = new Map();
computerUseExtension({
  registerTool(tool) {
    tools.set(tool.name, tool);
  },
  on(event, handler) {
    handlers.set(event, handler);
  },
});

const getAppState = tools.get("get_app_state");
assert.ok(getAppState, "get_app_state tool should be registered");
const click = tools.get("click");
assert.ok(click, "click tool should be registered");

const tempDir = await mkdtemp(join(tmpdir(), "pi-gui-computer-use-extension-"));
const fakeHelperPath = join(tempDir, "fake-helper.mjs");
await writeFile(
  fakeHelperPath,
  `#!/usr/bin/env node
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  let response;
  if (request.command === "status") {
    response = {
      ok: true,
      content: [{ type: "text", text: "Computer Use status (Pi GUI)\\nDesktop: locked" }],
      details: { screenLocked: "true", lockedUse: "not_enabled" },
    };
  } else if (request.command === "click" && request.app === "Preview") {
    response = {
      ok: false,
      error: "Screen Recording permission is required before using screenshot coordinates. In macOS System Settings > Privacy & Security > Screen Recording, enable pi-gui and pi-gui Computer Use, then retry.",
      details: { errorCode: "screen_recording_denied", screenRecording: "denied" },
    };
  } else if (request.command === "click" && request.app === "Notes") {
    response = {
      ok: false,
      error: "Cannot use screenshot coordinates because the target window screenshot is unavailable for Notes. Call get_app_state and use an element_index from the accessibility tree instead.",
      details: { screenshot: "unavailable" },
    };
  } else {
    response = {
      ok: false,
      error: "Computer Use is unavailable while the Mac is locked. Unlock the desktop and retry.",
      details: { errorCode: "desktop_locked", screenLocked: "true" },
    };
  }
  process.stdout.write(JSON.stringify(response) + "\\n");
  process.exit(response.ok ? 0 : 1);
});
`,
  "utf8",
);
await chmod(fakeHelperPath, 0o755);

process.env.PI_GUI_COMPUTER_USE_HELPER_PATH = fakeHelperPath;
process.env.PI_GUI_COMPUTER_USE_AUTO_ALLOW = "1";

const lockedThrown = await executeToolExpectingError(
  getAppState,
  "call-locked",
  { app: "Calculator" },
  /Computer Use blocked: the Mac is locked/,
  "locked helper failures should throw so the runtime records a tool error",
);
await assertFailureResult({
  toolCallId: "call-locked",
  toolName: "get_app_state",
  input: { app: "Calculator" },
  thrown: lockedThrown,
  expectedText: [/Computer Use blocked: the Mac is locked/, /Run computer_use_status/],
  expectedDetails: { errorCode: "desktop_locked", screenLocked: "true" },
});

const screenRecordingThrown = await executeToolExpectingError(
  click,
  "call-screen-recording",
  { app: "Preview", x: 10, y: 10 },
  /Computer Use blocked: Screen Recording permission is not enabled/,
  "Screen Recording coordinate failures should throw so the runtime records a tool error",
);
await assertFailureResult({
  toolCallId: "call-screen-recording",
  toolName: "click",
  input: { app: "Preview", x: 10, y: 10 },
  thrown: screenRecordingThrown,
  expectedText: [/Computer Use blocked: Screen Recording permission is not enabled/, /Run computer_use_status/],
  expectedDetails: { errorCode: "screen_recording_denied", screenRecording: "denied" },
});

const screenshotUnavailableThrown = await executeToolExpectingError(
  click,
  "call-screenshot-unavailable",
  { app: "Notes", x: 10, y: 10 },
  /Computer Use blocked: the target screenshot is unavailable/,
  "unavailable screenshot coordinate failures should throw so the runtime records a tool error",
);
await assertFailureResult({
  toolCallId: "call-screenshot-unavailable",
  toolName: "click",
  input: { app: "Notes", x: 10, y: 10 },
  thrown: screenshotUnavailableThrown,
  expectedText: [/Computer Use blocked: the target screenshot is unavailable/, /element_index/],
  expectedDetails: { errorCode: "screenshot_unavailable", screenshot: "unavailable" },
});

const status = await tools.get("computer_use_status").execute("call-status", {}, undefined, undefined, { hasUI: false });
const statusText = status.content.find((item) => item.type === "text")?.text ?? "";
assert.match(statusText, /Desktop: locked/);

async function executeToolExpectingError(tool, toolCallId, input, expectedMessage, assertionMessage) {
  let thrown;
  try {
    await tool.execute(toolCallId, input, undefined, undefined, { hasUI: false });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error, assertionMessage);
  assert.match(thrown.message, expectedMessage);
  return thrown;
}

async function assertFailureResult({ toolCallId, toolName, input, thrown, expectedText, expectedDetails }) {
  const result = await handlers.get("tool_result")(
    {
      type: "tool_result",
      toolCallId,
      toolName,
      input,
      content: [{ type: "text", text: thrown.message }],
      details: {},
      isError: true,
    },
    {},
  );
  const text = result.content.find((item) => item.type === "text")?.text ?? "";
  for (const pattern of expectedText) {
    assert.match(text, pattern);
  }
  for (const [key, value] of Object.entries(expectedDetails)) {
    assert.equal(result.details[key], value);
  }
  assert.equal(result.isError, true);
}
