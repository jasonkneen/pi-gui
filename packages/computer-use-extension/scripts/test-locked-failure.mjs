import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import computerUseExtension, { createComputerUseExtension } from "../dist/index.js";

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
const tokenLogPath = join(tempDir, "turn-tokens.log");
const endTokenLogPath = join(tempDir, "ended-turn-tokens.log");
const hideCursorLogPath = join(tempDir, "hide-cursor.log");
const beginCountPath = join(tempDir, "begin-count.txt");
await writeFile(
  fakeHelperPath,
  `#!/usr/bin/env node
import fs from "node:fs";
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  let response;
  if (request.command === "locked_use_end") {
    if (request.locked_use_turn_token && process.env.PI_GUI_COMPUTER_USE_TEST_END_TOKEN_LOG) {
      fs.appendFileSync(process.env.PI_GUI_COMPUTER_USE_TEST_END_TOKEN_LOG, request.locked_use_turn_token + "\\n");
    }
    response = {
      ok: true,
      content: [{ type: "text", text: "Locked Computer Use lease ended." }],
      details: { lockedUseLease: "ended", relockRequested: "true" },
    };
  } else if (request.command === "hide_cursor") {
    if (process.env.PI_GUI_COMPUTER_USE_TEST_HIDE_CURSOR_LOG) {
      fs.appendFileSync(process.env.PI_GUI_COMPUTER_USE_TEST_HIDE_CURSOR_LOG, "hide_cursor\\n");
    }
    response = {
      ok: true,
      content: [{ type: "text", text: "Computer Use agent cursor hidden." }],
      details: { cursorHidden: "true" },
    };
  } else if (request.command === "locked_use_begin") {
    if (request.locked_use_turn_token && process.env.PI_GUI_COMPUTER_USE_TEST_TOKEN_LOG) {
      fs.appendFileSync(process.env.PI_GUI_COMPUTER_USE_TEST_TOKEN_LOG, request.locked_use_turn_token + "\\n");
    }
    let beginCount = 0;
    if (process.env.PI_GUI_COMPUTER_USE_TEST_BEGIN_COUNT_PATH) {
      beginCount = fs.existsSync(process.env.PI_GUI_COMPUTER_USE_TEST_BEGIN_COUNT_PATH)
        ? Number(fs.readFileSync(process.env.PI_GUI_COMPUTER_USE_TEST_BEGIN_COUNT_PATH, "utf8")) || 0
        : 0;
      beginCount += 1;
      fs.writeFileSync(process.env.PI_GUI_COMPUTER_USE_TEST_BEGIN_COUNT_PATH, String(beginCount));
    }
    if (process.env.PI_GUI_COMPUTER_USE_TEST_DELAY_BEGIN === "1") {
      setTimeout(() => {
        const delayedResponse = {
          ok: true,
          content: [{ type: "text", text: "Locked Computer Use unlocked the desktop for this active turn." }],
          details: { lockedUseLease: "auto_unlocked", screenLocked: "false" },
        };
        process.stdout.write(JSON.stringify(delayedResponse) + "\\n");
        process.exit(0);
      }, 5000);
      return;
    }
    if (!request.locked_use_app_token) {
      response = {
        ok: true,
        content: [{ type: "text", text: "Desktop is already unlocked." }],
        details: { lockedUseLease: "not_needed", screenLocked: "false" },
      };
    } else if (request.locked_use_app_token === "runtime-app-token-000000000000000000000000") {
      if (process.env.PI_GUI_COMPUTER_USE_LOCKED_USE_APP_TOKEN) {
        response = {
          ok: false,
          error: "locked-use app token leaked into helper environment",
          details: { errorCode: "token_leaked" },
        };
      } else if (
        process.env.PI_GUI_COMPUTER_USE_DESKTOP_PID !== "4242" ||
        process.env.PI_GUI_COMPUTER_USE_DESKTOP_PATH !== "/Applications/pi-gui.app/Contents/MacOS/pi-gui" ||
        process.env.PI_GUI_COMPUTER_USE_LOCKED_USE_AUTH_SOCKET !== "/tmp/pi-gui-cu/test.sock"
      ) {
        response = {
          ok: false,
          error: "locked-use desktop authorization environment was not passed to helper",
          details: { errorCode: "desktop_authorization_env_missing" },
        };
      } else if (process.env.PI_GUI_COMPUTER_USE_TEST_NOT_NEEDED_AFTER_FIRST_BEGIN === "1" && beginCount > 1) {
        response = {
          ok: true,
          content: [{ type: "text", text: "Desktop is already unlocked." }],
          details: { lockedUseLease: "not_needed", screenLocked: "false" },
        };
      } else {
        response = {
          ok: true,
          content: [{ type: "text", text: "Locked Computer Use unlocked the desktop for this active turn." }],
          details: { lockedUseLease: "auto_unlocked", screenLocked: "false" },
        };
      }
    } else {
      response = {
        ok: false,
        error: "locked-use app token did not come from runtime config",
        details: { errorCode: "runtime_config_missing" },
      };
    }
  } else if (request.command === "status") {
    response = {
      ok: true,
      content: [{ type: "text", text: "Computer Use status (Pi GUI)\\nDesktop: locked" }],
      details: {
        screenLocked: "true",
        lockedUse: "not_enabled",
        cursorVisible: process.env.PI_GUI_COMPUTER_USE_SHOW_CURSOR,
        cursorDurationMs: process.env.PI_GUI_COMPUTER_USE_CURSOR_DURATION_MS,
        cursorGlideMs: process.env.PI_GUI_COMPUTER_USE_CURSOR_GLIDE_MS,
      },
    };
  } else if (request.command === "get_app_state" && request.app === "LockedUseDisabled") {
    response = {
      ok: false,
      error: "Computer Use is unavailable while the Mac is locked because Locked Computer Use is not enabled. Enable the locked Computer Use authorization plug-in, then retry.",
      details: { errorCode: "desktop_locked", screenLocked: "true", lockedUse: "not_enabled" },
    };
  } else if (request.command === "get_app_state" && request.app === "LockedUsePartial") {
    response = {
      ok: false,
      error: "Computer Use is unavailable while the Mac is locked because Locked Computer Use is partially installed. Reinstall or uninstall Locked Computer Use, then retry.",
      details: { errorCode: "desktop_locked", screenLocked: "true", lockedUse: "partial" },
    };
  } else if (request.command === "click" && request.app === "Preview") {
    response = {
      ok: false,
      error: "Screen Recording permission is required before using screenshot coordinates. In macOS System Settings > Privacy & Security > Screen Recording, enable pi-gui and pi-gui Computer Use, then retry.",
      details: { errorCode: "screen_recording_denied", screenRecording: "denied" },
    };
  } else if (request.command === "get_app_state" && request.app === "ImaginaryApp") {
    response = {
      ok: false,
      error: "Could not find app: ImaginaryApp",
      details: { errorCode: "app_not_found" },
    };
  } else if (request.command === "click" && request.app === "Notes") {
    response = {
      ok: false,
      error: "Cannot use screenshot coordinates because the target window screenshot is unavailable for Notes. Call get_app_state and use an element_index from the accessibility tree instead.",
      details: { screenshot: "unavailable" },
    };
  } else if (request.command === "click" && request.app === "Sketch") {
    response = {
      ok: false,
      error: "Computer Use blocked: this click in Sketch would require foreground physical input by moving the user's physical mouse at 120,120. Use a pressable element_index or a coordinate over a pressable accessibility element to keep Computer Use in the background.",
      details: { errorCode: "physical_input_required" },
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
process.env.PI_GUI_COMPUTER_USE_TEST_TOKEN_LOG = tokenLogPath;
process.env.PI_GUI_COMPUTER_USE_TEST_END_TOKEN_LOG = endTokenLogPath;
process.env.PI_GUI_COMPUTER_USE_TEST_HIDE_CURSOR_LOG = hideCursorLogPath;

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

const lockedUseNotEnabledThrown = await executeToolExpectingError(
  getAppState,
  "call-locked-use-not-enabled",
  { app: "LockedUseDisabled" },
  /Computer Use blocked: Locked Computer Use is not enabled/,
  "locked desktop failures should show the enable action when locked-use is not enabled",
);
await assertFailureResult({
  toolCallId: "call-locked-use-not-enabled",
  toolName: "get_app_state",
  input: { app: "LockedUseDisabled" },
  thrown: lockedUseNotEnabledThrown,
  expectedText: [/Computer Use blocked: Locked Computer Use is not enabled/, /authorization plug-in/],
  expectedDetails: { errorCode: "locked_use_not_enabled", screenLocked: "true", lockedUse: "not_enabled" },
});

const lockedUsePartialThrown = await executeToolExpectingError(
  getAppState,
  "call-locked-use-partial",
  { app: "LockedUsePartial" },
  /Computer Use blocked: Locked Computer Use setup needs repair/,
  "partial locked-use setup failures should stay distinct from generic lock failures",
);
await assertFailureResult({
  toolCallId: "call-locked-use-partial",
  toolName: "get_app_state",
  input: { app: "LockedUsePartial" },
  thrown: lockedUsePartialThrown,
  expectedText: [/Computer Use blocked: Locked Computer Use setup needs repair/, /Reinstall or uninstall Locked Computer Use/],
  expectedDetails: { errorCode: "locked_use_partial", screenLocked: "true", lockedUse: "partial" },
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

const appNotFoundThrown = await executeToolExpectingError(
  getAppState,
  "call-app-not-found",
  { app: "ImaginaryApp" },
  /Computer Use blocked: the requested app could not be found/,
  "app-not-found failures should throw so the runtime records a distinct tool error",
);
await assertFailureResult({
  toolCallId: "call-app-not-found",
  toolName: "get_app_state",
  input: { app: "ImaginaryApp" },
  thrown: appNotFoundThrown,
  expectedText: [/Computer Use blocked: the requested app could not be found/, /Could not find app: ImaginaryApp/],
  expectedDetails: { errorCode: "app_not_found" },
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

const physicalInputThrown = await executeToolExpectingError(
  click,
  "call-physical-input",
  { app: "Sketch", x: 120, y: 120 },
  /Computer Use blocked: this action would require foreground physical input/,
  "physical pointer fallback failures should throw so the runtime records a tool error",
);
await assertFailureResult({
  toolCallId: "call-physical-input",
  toolName: "click",
  input: { app: "Sketch", x: 120, y: 120 },
  thrown: physicalInputThrown,
  expectedText: [/Computer Use blocked: this action would require foreground physical input/, /physical mouse/],
  expectedDetails: { errorCode: "physical_input_required" },
});

const status = await tools.get("computer_use_status").execute("call-status", {}, undefined, undefined, { hasUI: false });
const statusText = status.content.find((item) => item.type === "text")?.text ?? "";
assert.match(statusText, /Desktop: locked/);
assert.equal(status.details.cursorVisible, "1", "Computer Use should show the agent cursor by default");
assert.equal(status.details.cursorDurationMs, "60000", "Computer Use should keep the cursor visible across active tool sequences");
assert.equal(status.details.cursorGlideMs, "300", "Computer Use should glide the cursor by default");

const configuredTools = new Map();
const configuredHandlers = new Map();
createComputerUseExtension({
  helperPath: fakeHelperPath,
  lockedUseAppToken: "runtime-app-token-000000000000000000000000",
  lockedUseDesktopPid: "4242",
  lockedUseDesktopPath: "/Applications/pi-gui.app/Contents/MacOS/pi-gui",
  lockedUseAuthorizationSocket: "/tmp/pi-gui-cu/test.sock",
})({
  registerTool(tool) {
    configuredTools.set(tool.name, tool);
  },
  on(event, handler) {
    configuredHandlers.set(event, handler);
  },
});
process.env.PI_GUI_COMPUTER_USE_LOCKED_USE_APP_TOKEN = "leaky-env-token";
const configuredRuntimeThrown = await executeToolExpectingError(
  configuredTools.get("click"),
  "call-runtime-config",
  { app: "Preview", x: 10, y: 10 },
  /Computer Use blocked: Screen Recording permission is not enabled/,
  "private runtime config should provide locked-use credentials without leaking them to helper env",
);
await assertFailureResult({
  toolCallId: "call-runtime-config",
  toolName: "click",
  input: { app: "Preview", x: 10, y: 10 },
  thrown: configuredRuntimeThrown,
  expectedText: [/Computer Use blocked: Screen Recording permission is not enabled/, /Run computer_use_status/],
  expectedDetails: { errorCode: "screen_recording_denied", screenRecording: "denied" },
});

await configuredHandlers.get("turn_end")({}, { ui: { setWidget() {} } });
assert.equal(
  await logLineCount(hideCursorLogPath),
  0,
  "turn_end should keep the active agent cursor visible until session shutdown",
);
const secondConfiguredRuntimeThrown = await executeToolExpectingError(
  configuredTools.get("click"),
  "call-runtime-config-second-turn",
  { app: "Preview", x: 10, y: 10 },
  /Computer Use blocked: Screen Recording permission is not enabled/,
  "private runtime config should generate a fresh locked-use turn token after turn_end",
);
await assertFailureResult({
  toolCallId: "call-runtime-config-second-turn",
  toolName: "click",
  input: { app: "Preview", x: 10, y: 10 },
  thrown: secondConfiguredRuntimeThrown,
  expectedText: [/Computer Use blocked: Screen Recording permission is not enabled/, /Run computer_use_status/],
  expectedDetails: { errorCode: "screen_recording_denied", screenRecording: "denied" },
});
await configuredHandlers.get("session_shutdown")({}, { ui: { setWidget() {} } });
await waitForLineCount(hideCursorLogPath, 1);
await writeFile(beginCountPath, "0", "utf8");
process.env.PI_GUI_COMPUTER_USE_TEST_BEGIN_COUNT_PATH = beginCountPath;
process.env.PI_GUI_COMPUTER_USE_TEST_NOT_NEEDED_AFTER_FIRST_BEGIN = "1";
const multiToolFirstThrown = await executeToolExpectingError(
  configuredTools.get("click"),
  "call-runtime-config-multi-first",
  { app: "Preview", x: 10, y: 10 },
  /Computer Use blocked: Screen Recording permission is not enabled/,
  "first action in a locked-use turn should start a lease",
);
await assertFailureResult({
  toolCallId: "call-runtime-config-multi-first",
  toolName: "click",
  input: { app: "Preview", x: 10, y: 10 },
  thrown: multiToolFirstThrown,
  expectedText: [/Computer Use blocked: Screen Recording permission is not enabled/, /Run computer_use_status/],
  expectedDetails: { errorCode: "screen_recording_denied", screenRecording: "denied" },
});
const multiToolSecondThrown = await executeToolExpectingError(
  configuredTools.get("click"),
  "call-runtime-config-multi-second",
  { app: "Preview", x: 10, y: 10 },
  /Computer Use blocked: Screen Recording permission is not enabled/,
  "later actions in an auto-unlocked turn should keep the active lease",
);
await assertFailureResult({
  toolCallId: "call-runtime-config-multi-second",
  toolName: "click",
  input: { app: "Preview", x: 10, y: 10 },
  thrown: multiToolSecondThrown,
  expectedText: [/Computer Use blocked: Screen Recording permission is not enabled/, /Run computer_use_status/],
  expectedDetails: { errorCode: "screen_recording_denied", screenRecording: "denied" },
});
await configuredHandlers.get("turn_end")({}, { ui: { setWidget() {} } });
delete process.env.PI_GUI_COMPUTER_USE_TEST_BEGIN_COUNT_PATH;
delete process.env.PI_GUI_COMPUTER_USE_TEST_NOT_NEEDED_AFTER_FIRST_BEGIN;
process.env.PI_GUI_COMPUTER_USE_TEST_DELAY_BEGIN = "1";
const abortController = new AbortController();
const cancelledBeginPromise = configuredTools
  .get("click")
  .execute("call-cancelled-begin", { app: "Preview", x: 10, y: 10 }, abortController.signal, undefined, {
    hasUI: false,
  })
  .then(
    () => undefined,
    (error) => error,
  );
await waitForLineCount(tokenLogPath, 5);
abortController.abort();
const cancelledBeginError = await cancelledBeginPromise;
assert.ok(cancelledBeginError instanceof Error, "cancelling locked-use begin should reject the action");
assert.equal(cancelledBeginError.message, "Computer Use action was cancelled.");
await configuredHandlers.get("turn_end")({}, { ui: { setWidget() {} } });
delete process.env.PI_GUI_COMPUTER_USE_TEST_DELAY_BEGIN;
await configuredHandlers.get("session_shutdown")({}, { ui: { setWidget() {} } });

const turnTokens = (await readFile(tokenLogPath, "utf8")).trim().split("\n").filter(Boolean);
const endedTurnTokens = (await readFile(endTokenLogPath, "utf8")).trim().split("\n").filter(Boolean);
assert.equal(turnTokens.length, 5, "runtime config should provide a locked-use token to each begin call");
assert.equal(new Set(turnTokens).size, 4, "runtime config should create one locked-use token per turn");
assert.notEqual(turnTokens[0], turnTokens[1], "locked-use turn tokens should not be reused across turns");
assert.notEqual(turnTokens[1], turnTokens[2], "multi-tool locked-use turn should start with a fresh token");
assert.equal(turnTokens[2], turnTokens[3], "multi-tool locked-use turn should reuse its active turn token");
assert.notEqual(turnTokens[3], turnTokens[4], "cancelled locked-use begin should run in a fresh turn token");
assert.deepEqual(
  endedTurnTokens,
  [turnTokens[0], turnTokens[1], turnTokens[2], turnTokens[4]],
  "locked-use leases should end on turn_end and session_shutdown",
);
delete process.env.PI_GUI_COMPUTER_USE_LOCKED_USE_APP_TOKEN;
delete process.env.PI_GUI_COMPUTER_USE_TEST_TOKEN_LOG;
delete process.env.PI_GUI_COMPUTER_USE_TEST_END_TOKEN_LOG;
delete process.env.PI_GUI_COMPUTER_USE_TEST_HIDE_CURSOR_LOG;

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

async function waitForLineCount(path, expectedCount) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const lines = await logLines(path);
    if (lines.length >= expectedCount) {
      return lines;
    }
    await delay(25);
  }
  const lines = await logLines(path);
  assert.fail(`Expected at least ${expectedCount} lines in ${path}, found ${lines.length}`);
}

async function logLineCount(path) {
  return (await logLines(path)).length;
}

async function logLines(path) {
  return (await readFile(path, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
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
