import { expect, test } from "@playwright/test";
import { extractFile, listPackage } from "@electron/asar";
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolvePackagedAppBundle } from "../helpers/electron-app";

const expectedComputerUseTools = [
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
  expect(helperSource).toContain("--cursor-overlay-daemon");
  expect(helperSource).toContain("AXUIElementCopyElementAtPosition");
  expect(helperSource).toContain("outside the target window screenshot bounds");
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
});

function runPackagedHelper(helperPath: string, request: Record<string, unknown>): Promise<HelperResponse> {
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, [], { stdio: ["pipe", "pipe", "pipe"] });
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
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Computer Use helper exited with code ${code}.`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as HelperResponse);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}
