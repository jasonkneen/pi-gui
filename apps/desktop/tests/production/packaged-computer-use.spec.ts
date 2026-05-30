import { expect, test } from "@playwright/test";
import { extractFile, listPackage } from "@electron/asar";
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolvePackagedAppBundle } from "../helpers/electron-app";

const expectedComputerUseTools = [
  "computer_use_status",
  "click",
  "drag",
  "get_app_state",
  "list_apps",
  "perform_secondary_action",
  "press_key",
  "scroll",
  "select_text",
  "set_value",
  "type_text",
];
const helperExecutableName = "pi-gui-computer-use-helper";
const helperAppName = "pi-gui Computer Use.app";

interface HelperResponse {
  readonly ok: boolean;
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly details?: Readonly<Record<string, string>>;
  readonly error?: string;
}

test("packaged app carries the built-in Computer Use helper and extension", async () => {
  test.setTimeout(60_000);
  const appBundle = await resolvePackagedAppBundle();
  const appAsar = join(appBundle, "Contents", "Resources", "app.asar");
  const helperAppBundle = join(appBundle, "Contents", "SharedSupport", helperAppName);
  const helperAppExecutable = join(helperAppBundle, "Contents", "MacOS", helperExecutableName);
  const helperAppInfoPlist = join(helperAppBundle, "Contents", "Info.plist");
  const helperPath = join(appBundle, "Contents", "MacOS", helperExecutableName);

  await access(helperAppExecutable);
  await access(helperPath);

  const helperInfo = await readFile(helperAppInfoPlist, "utf8");
  expect(helperInfo).toMatch(/<key>LSUIElement<\/key>\s*<true\/>/);
  expect(helperInfo).toContain("<string>com.pi-gui.desktop.computer-use-helper</string>");

  const files = listPackage(appAsar);
  expect(files).toContain("/out/computer-use-extension/package.json");
  expect(files).toContain("/out/computer-use-extension/dist/index.js");

  const packageJson = JSON.parse(
    extractFile(appAsar, "out/computer-use-extension/package.json").toString("utf8"),
  ) as {
    dependencies?: Record<string, string>;
    pi?: { extensions?: string[] };
  };
  expect(packageJson.pi?.extensions).toEqual(["./dist/index.js"]);
  expect(packageJson.dependencies).toBeUndefined();

  const extensionSource = extractFile(appAsar, "out/computer-use-extension/dist/index.js").toString("utf8");
  expect(extensionSource).not.toContain("@earendil-works/");
  expect(extensionSource).not.toContain("Computer Use ready");
  expect(extensionSource).not.toContain("Pi is using your computer");
  expect(extensionSource).toContain("plus, equals");
  expect(extensionSource).toContain("element_index for visible text fields");
  expect(extensionSource).toContain("Computer Use blocked");
  expect(extensionSource).toContain("desktop_locked");
  expect(extensionSource).toContain("screen_recording_denied");
  expect(extensionSource).toContain("screenshot_unavailable");
  for (const toolName of expectedComputerUseTools) {
    expect(extensionSource).toContain(`name: "${toolName}"`);
  }

  const helperSource = await readFile(helperPath, "latin1");
  for (const keyAlias of ["plus", "equals", "kp_add", "numpad_enter"]) {
    expect(helperSource).toContain(keyAlias);
  }
  expect(helperSource).toContain("PI_GUI_COMPUTER_USE_SHOW_CURSOR");
  expect(helperSource).toContain("AXScrollDown");
  expect(helperSource).toContain("AXTextArea");
  expect(helperSource).toContain("AXSelectedTextRange");
  expect(helperSource).toContain("all clear");
  expect(helperSource).toContain("enable pi-gui and pi-gui Computer Use");
  expect(helperSource).toContain("PI_GUI_COMPUTER_USE_CURSOR_DURATION_MS");
  expect(helperSource).toContain("PI_GUI_COMPUTER_USE_CURSOR_GLIDE_MS");
  expect(helperSource).toContain("PI_GUI_COMPUTER_USE_TEST_FORCE_SCREEN_RECORDING_DENIED");
  expect(helperSource).toContain("CGRequestScreenCaptureAccess");
  expect(helperSource).toContain("--cursor-overlay-daemon");
  expect(helperSource).toContain("AXUIElementCopyElementAtPosition");
  expect(helperSource).toContain("outside the target window screenshot bounds");
  expect(helperSource).toContain("target window screenshot is unavailable");
  expect(helperSource).toContain("waitForFrontmost");

  const mainSource = extractFile(appAsar, "out/main/main.js").toString("utf8");
  expect(mainSource).not.toContain("getAgentDir");
  expect(mainSource).not.toContain("@earendil-works/pi-coding-agent");
  expect(mainSource).toContain(helperAppName);
  expect(mainSource).toContain("SharedSupport");

  const helperResponse = await runPackagedHelper(helperAppExecutable, { command: "list_apps" });
  expect(helperResponse.ok).toBe(true);
  expect(helperResponse.content?.[0]?.type).toBe("text");
  expect(helperResponse.content?.[0]?.text).toContain("Finder");

  const helperStatus = await runPackagedHelper(helperAppExecutable, { command: "status" });
  expect(helperStatus.ok).toBe(true);
  expect(helperStatus.content?.[0]?.text).toContain("Computer Use status");
  expect(helperStatus.content?.[0]?.text).toContain("Locked Computer Use");

  const lockedHelperResponse = await runPackagedHelper(
    helperAppExecutable,
    { command: "get_app_state", app: "Finder" },
    { PI_GUI_COMPUTER_USE_TEST_FORCE_LOCKED: "1" },
  );
  expect(lockedHelperResponse.ok).toBe(false);
  expect(lockedHelperResponse.error).toContain("Mac is locked");
  expect(lockedHelperResponse.details?.errorCode).toBe("desktop_locked");

  const screenRecordingDeniedStatus = await runPackagedHelper(
    helperAppExecutable,
    { command: "status" },
    { PI_GUI_COMPUTER_USE_TEST_FORCE_SCREEN_RECORDING_DENIED: "1" },
  );
  expect(screenRecordingDeniedStatus.ok).toBe(true);
  expect(screenRecordingDeniedStatus.details?.screenRecording).toBe("denied");

  if (screenRecordingDeniedStatus.details?.screenLocked === "false") {
    const screenRecordingDeniedClick = await runPackagedHelper(
      helperAppExecutable,
      { command: "click", app: "Finder", x: 10, y: 10 },
      { PI_GUI_COMPUTER_USE_TEST_FORCE_SCREEN_RECORDING_DENIED: "1" },
    );
    expect(screenRecordingDeniedClick.ok).toBe(false);
    expect(screenRecordingDeniedClick.error).toContain("Screen Recording permission");
    expect(screenRecordingDeniedClick.details?.errorCode).toBe("screen_recording_denied");
  } else {
    test.info().annotations.push({
      type: "note",
      description: "Skipped packaged coordinate Screen Recording denial probe because the host session is locked.",
    });
  }
});

function runPackagedHelper(
  helperPath: string,
  request: Record<string, unknown>,
  envOverrides: Record<string, string> = {},
): Promise<HelperResponse> {
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...envOverrides },
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        if (stdout.trim()) {
          resolve(JSON.parse(stdout) as HelperResponse);
          return;
        }
      } catch (error) {
        reject(error);
        return;
      }
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Computer Use helper exited with code ${code}.`));
        return;
      }
      reject(new Error("Computer Use helper produced no response."));
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}
