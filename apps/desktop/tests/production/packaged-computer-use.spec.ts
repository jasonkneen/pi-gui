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
const lockedUseInstallerExecutableName = "pi-gui-computer-use-locked-use-installer";
const authorizationPluginBundleName = "PiGuiComputerUseAuthorizationPlugin.bundle";
const helperSwiftSourcePath = join(process.cwd(), "apps", "desktop", "resources", "computer-use-helper.swift");
const lockedUseInstallerSourcePath = join(
  process.cwd(),
  "apps",
  "desktop",
  "resources",
  "computer-use-locked-use-installer.swift",
);
const authorizationPluginSourcePath = join(
  process.cwd(),
  "apps",
  "desktop",
  "resources",
  "computer-use-authorization-plugin.c",
);

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
  const helperAppSharedSupport = join(helperAppBundle, "Contents", "SharedSupport");
  const lockedUseInstallerExecutable = join(helperAppSharedSupport, lockedUseInstallerExecutableName);
  const authorizationPluginBundle = join(helperAppSharedSupport, authorizationPluginBundleName);
  const authorizationPluginExecutable = join(
    authorizationPluginBundle,
    "Contents",
    "MacOS",
    "PiGuiComputerUseAuthorizationPlugin",
  );
  const authorizationPluginInfoPlist = join(authorizationPluginBundle, "Contents", "Info.plist");
  const helperPath = join(appBundle, "Contents", "MacOS", helperExecutableName);

  await access(helperAppExecutable);
  await access(lockedUseInstallerExecutable);
  await access(authorizationPluginExecutable);
  await access(helperPath);

  const helperInfo = await readFile(helperAppInfoPlist, "utf8");
  expect(helperInfo).toMatch(/<key>LSUIElement<\/key>\s*<true\/>/);
  expect(helperInfo).toContain("<string>com.pi-gui.desktop.computer-use-helper</string>");
  const authorizationPluginInfo = await readFile(authorizationPluginInfoPlist, "utf8");
  expect(authorizationPluginInfo).toContain("<string>com.pi-gui.desktop.computer-use.authorization-plugin</string>");

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
  expect(helperSource).toContain("PI_GUI_COMPUTER_USE_LOCKED_USE_INSTALLER_PATH");
  expect(helperSource).toContain("PI_GUI_COMPUTER_USE_LOCKED_USE_APP_TOKEN");
  expect(helperSource).toContain("PI_GUI_COMPUTER_USE_LOCKED_USE_AUTH_SOCKET");
  expect(helperSource).toContain("PI_GUI_COMPUTER_USE_TEST_LOCKED_USE_INSTALLER_STATE");
  expect(helperSource).toContain("active-turn-token");
  expect(helperSource).toContain("--lock-screen-authorization-daemon");
  expect(helperSource).toContain("--lock-screen-authorization-protocol-version");
  expect(helperSource).toContain("pi-gui-computer-use-active-turn-v1");
  expect(helperSource).toContain("LockScreenLoginAuthorization.sock");
  expect(helperSource).toContain("configuration.plist");
  expect(helperSource).toContain("helperExecutablePath");
  expect(helperSource).toContain("CGRequestScreenCaptureAccess");
  expect(helperSource).toContain("--cursor-overlay-daemon");
  expect(helperSource).toContain("AXUIElementCopyElementAtPosition");
  expect(helperSource).toContain("outside the target window screenshot bounds");
  expect(helperSource).toContain("target window screenshot is unavailable");
  expect(helperSource).toContain("active-turn authorization service");
  expect(helperSource).toContain("waitForFrontmost");
  const helperSwiftSource = await readFile(helperSwiftSourcePath, "utf8");
  expect(helperSwiftSource).toContain("locked_use_begin");
  expect(helperSwiftSource).toContain("locked_use_end");
  expect(helperSwiftSource).toContain("locked_use_authorization_probe");
  expect(helperSwiftSource).toContain("lockedUseHelperSupportsActiveTurnProtocol");
  expect(helperSwiftSource).toContain("Installed Locked Computer Use helper is stale");
  expect(helperSwiftSource).toContain("does not support active-turn authorization");
  expect(helperSwiftSource).toContain("relockAutoUnlockedDesktopIfNeeded");
  expect(helperSwiftSource).toContain("shouldRelockAutoUnlockedDesktop");
  expect(helperSwiftSource).toContain("lockedUseDaemonStateRequiresRelock");
  expect(helperSwiftSource).toContain('state == "auto_unlocked" || state == "authorized"');
  expect(helperSwiftSource).toContain("isLockedUseAuthorizationDaemonProcess");
  expect(helperSwiftSource).toContain("requestDesktopLockedUseAuthorization");
  expect(helperSwiftSource).toContain("socketPeerSatisfiesCodeRequirement");
  expect(helperSwiftSource).toContain("makeSocketNonBlocking");
  expect(helperSwiftSource).toContain("makeSocketBlocking");
  expect(helperSwiftSource).toContain("setLockedUseClientSocketTimeout");
  expect(helperSwiftSource).toContain("SO_RCVTIMEO");
  expect(helperSwiftSource).toContain("SO_SNDTIMEO");
  expect(helperSwiftSource).toContain("O_NONBLOCK");
  expect(helperSwiftSource).toContain("process.standardInput = input");
  expect(helperSwiftSource).toContain('process.arguments = ["-o", "command=", "-p", "\\(pid)"]');
  expect(helperSwiftSource).toContain("try requireTrustedLockedUseDesktopAncestor()");

  const installerSource = await readFile(lockedUseInstallerExecutable, "latin1");
  expect(installerSource).toContain("PiGuiComputerUseAuthorizationPlugin:allow");
  expect(installerSource).toContain("com.pi-gui.desktop.ComputerUse.AuthorizationPlugin.original-screensaver");
  expect(installerSource).toContain("system.login.screensaver");
  expect(installerSource).toContain("--confirm-system-login-change");
  expect(installerSource).toContain("configuration.plist");
  expect(installerSource).toContain("helperExecutablePath");
  expect(installerSource).toContain("helperCodePath");
  const installerSwiftSource = await readFile(lockedUseInstallerSourcePath, "utf8");
  expect(installerSwiftSource).toContain('rule["k-of-n"] = 1');
  expect(installerSwiftSource).toContain('rule.removeValue(forKey: "k-of-n")');
  expect(installerSwiftSource).toContain('rule["class"] = "rule"');
  expect(installerSwiftSource).toContain("isPiGuiScreensaverWrapper");
  expect(installerSwiftSource).toContain('integerValue(in: rule, key: "k-of-n") == 1');
  expect(installerSwiftSource).toContain("currentScreensaverHasPiGuiDelegates");
  expect(installerSwiftSource).toContain("root:wheel");
  expect(installerSwiftSource).toContain("runChecked");
  expect(installerSwiftSource).toContain("installedHelperAppPath");
  expect(installerSwiftSource).toContain("supportDirectory");
  expect(installerSwiftSource).toContain("helperAppName");
  expect(installerSwiftSource).toContain("bundledHelperAppPath(resourceDirectory: resourceDirectory)");
  expect(installerSwiftSource).toContain("appendingPathComponent(helperAppName)");
  expect(installerSwiftSource).toContain('enclosingAppURL.pathExtension == "app"');
  expect(installerSwiftSource).toContain("sameFileSystemPath(sourceHelperAppPath, installedHelperAppPath)");
  expect(installerSwiftSource).toContain("hardenInstalledHelperApp");
  expect(installerSwiftSource).toContain('"shared": false');
  expect(installerSwiftSource).toContain("$0 != remoteRightName && $0 != originalScreensaverRightName");

  const authorizationPluginSource = await readFile(authorizationPluginExecutable, "latin1");
  expect(authorizationPluginSource).toContain("LockScreenLoginAuthorization.sock");
  expect(authorizationPluginSource).toContain("active-turn-token");
  expect(authorizationPluginSource).toContain("com.pi-gui.desktop.computer-use-helper");
  expect(authorizationPluginSource).toContain("configuration.plist");
  expect(authorizationPluginSource).toContain("helperExecutablePath");
  expect(authorizationPluginSource).toContain("helperCodePath");
  const authorizationPluginCSource = await readFile(authorizationPluginSourcePath, "utf8");
  expect(authorizationPluginCSource).toContain("PI_GUI_LOCKED_USE_TOKEN_PATH");
  expect(authorizationPluginCSource).toContain("readActiveTurnToken");
  expect(authorizationPluginCSource).toContain("SO_RCVTIMEO");
  expect(authorizationPluginCSource).toContain("SO_SNDTIMEO");
  expect(authorizationPluginCSource).toContain("PI_GUI_LOCKED_USE_SOCKET_TIMEOUT_SECONDS");
  expect(authorizationPluginCSource).toContain("SecRequirementCreateWithString");
  expect(authorizationPluginCSource).toContain("SecCodeCheckValidity");
  expect(authorizationPluginCSource).toContain("certificate leaf[subject.OU]");
  expect(authorizationPluginCSource).toContain("P2MBURJVUW");

  const mainSource = extractFile(appAsar, "out/main/main.js").toString("utf8");
  expect(mainSource).not.toContain("getAgentDir");
  expect(mainSource).not.toContain("@earendil-works/pi-coding-agent");
  expect(mainSource).toContain(helperAppName);
  expect(mainSource).toContain("PI_GUI_COMPUTER_USE_LOCKED_USE_INSTALLER_PATH");
  expect(mainSource).toContain("PI_GUI_COMPUTER_USE_LOCKED_USE_APP_TOKEN");
  expect(mainSource).toContain("PI_GUI_COMPUTER_USE_DESKTOP_PID");
  expect(mainSource).toContain("PI_GUI_COMPUTER_USE_DESKTOP_PATH");
  expect(mainSource).toContain("PI_GUI_COMPUTER_USE_LOCKED_USE_AUTH_SOCKET");
  expect(mainSource).toContain("/tmp/pi-gui-cu");
  expect(mainSource).toContain("auth-");
  expect(mainSource).toContain("tryConfigureLockedUseAuthorizationBroker");
  expect(mainSource).toContain("Locked Computer Use authorization broker is unavailable");
  expect(mainSource).toContain("createComputerUseExtension");
  expect(mainSource).toContain("inlineExtensionMetadata");
  expect(mainSource).toContain("removeComputerUsePackageEntry");
  expect(mainSource).toContain("isPackagedComputerUsePackagePath");
  expect(mainSource).toContain("app/Contents/Resources/app.asar/out/computer-use-extension");
  expect(mainSource).toContain("packageManifestName(resolvedSource)");
  expect(mainSource).toContain("scrubLockedUsePrivateProcessEnv");
  expect(mainSource).not.toContain('Symbol.for("pi-gui.computer-use.runtime")');
  expect(mainSource).not.toContain("process.env[lockedUseAppTokenEnv] =");
  expect(mainSource).not.toContain("process.env[lockedUseDesktopPidEnv] =");
  expect(mainSource).not.toContain("process.env[lockedUseAuthorizationSocketEnv] =");
  expect(mainSource).toContain("computerUsePrivateEnvKeys");
  expect(mainSource).toContain("delete env[key]");
  expect(mainSource).toContain(lockedUseInstallerExecutableName);
  expect(mainSource).toContain("SharedSupport");
  expect(extensionSource).toContain("locked_use_begin");
  expect(extensionSource).toContain("locked_use_end");
  expect(extensionSource).toContain("createComputerUseExtension");
  expect(extensionSource).toContain("AsyncLocalStorage");
  expect(extensionSource).toContain("PI_GUI_COMPUTER_USE_LOCKED_USE_APP_TOKEN");
  expect(extensionSource).not.toContain('Symbol.for("pi-gui.computer-use.runtime")');
  expect(extensionSource).toContain("lockedUseDesktopPid");
  expect(extensionSource).toContain("lockedUseAuthorizationSocket");
  expect(extensionSource).toContain("lockedUseCredentialsIfConfigured");
  expect(extensionSource).toContain("delete env[key]");
  expect(extensionSource).toContain("setEnvFromRuntimeConfig");
  expect(extensionSource).toContain("turn_end");
  expect(extensionSource).toContain("session_shutdown");
  expect(extensionSource).toContain("cleanupComputerUseRuntime");

  const helperResponse = await runPackagedHelper(helperAppExecutable, { command: "list_apps" });
  expect(helperResponse.ok).toBe(true);
  expect(helperResponse.content?.[0]?.type).toBe("text");
  expect(helperResponse.content?.[0]?.text).toContain("Finder");

  const helperStatus = await runPackagedHelper(helperAppExecutable, { command: "status" });
  expect(helperStatus.ok).toBe(true);
  expect(helperStatus.content?.[0]?.text).toContain("Computer Use status");
  expect(helperStatus.content?.[0]?.text).toContain("Locked Computer Use");

  const lockedUseInstallerStatus = await runLockedUseInstallerStatus(lockedUseInstallerExecutable);
  expect(lockedUseInstallerStatus).toMatch(/^OK: (installed|not-installed|partial)$/);
  await expectInstallerInstallWithoutConfirmToFail(lockedUseInstallerExecutable);

  const helperStatusWithInstaller = await runPackagedHelper(
    helperAppExecutable,
    { command: "status" },
    { PI_GUI_COMPUTER_USE_LOCKED_USE_INSTALLER_PATH: lockedUseInstallerExecutable },
  );
  expect(helperStatusWithInstaller.ok).toBe(true);
  expect(helperStatusWithInstaller.details?.lockedUseInstaller).toMatch(/^(installed|not-installed|partial)$/);
  expect(helperStatusWithInstaller.details?.lockedUse).toBe(
    helperStatusWithInstaller.details?.lockedUseInstaller === "installed" ? "enabled" : "not_enabled",
  );
  expect(helperStatusWithInstaller.details?.lockedUseInstallerPath).toBe(lockedUseInstallerExecutable);

  const helperStatusWithForcedInstalled = await runPackagedHelper(
    helperAppExecutable,
    { command: "status" },
    { PI_GUI_COMPUTER_USE_TEST_LOCKED_USE_INSTALLER_STATE: "installed" },
  );
  expect(helperStatusWithForcedInstalled.ok).toBe(true);
  expect(helperStatusWithForcedInstalled.details?.lockedUse).toBe("enabled");

  const lockedAuthorizationProbeWithoutTrustedDesktop = await runPackagedHelper(
    helperAppExecutable,
    {
      command: "locked_use_authorization_probe",
      locked_use_app_token: "test-app-token-000000000000000000000000000000",
      locked_use_turn_token: "test-turn-token-000000000000000000000000000000",
    },
    {
      PI_GUI_COMPUTER_USE_HELPER_PATH: helperAppExecutable,
      PI_GUI_COMPUTER_USE_LOCKED_USE_APP_TOKEN: "test-app-token-000000000000000000000000000000",
    },
  );
  expect(lockedAuthorizationProbeWithoutTrustedDesktop.ok).toBe(false);
  expect(lockedAuthorizationProbeWithoutTrustedDesktop.error).toContain("trusted pi-gui desktop process");
  expect(lockedAuthorizationProbeWithoutTrustedDesktop.details?.errorCode).toBe("desktop_locked");

  const directDaemonInvocation = await runDirectDaemonInvocation(helperAppExecutable);
  expect(directDaemonInvocation.code).not.toBe(0);
  expect(directDaemonInvocation.stderr).toContain("authorization daemon rejected");

  const lockedBeginWithoutTrustedDesktop = await runPackagedHelper(
    helperAppExecutable,
    {
      command: "locked_use_begin",
      locked_use_app_token: "test-app-token-000000000000000000000000000000",
      locked_use_turn_token: "test-turn-token-000000000000000000000000000000",
    },
    {
      PI_GUI_COMPUTER_USE_LOCKED_USE_APP_TOKEN: "test-app-token-000000000000000000000000000000",
      PI_GUI_COMPUTER_USE_TEST_FORCE_LOCKED: "1",
      PI_GUI_COMPUTER_USE_TEST_LOCKED_USE_INSTALLER_STATE: "installed",
    },
  );
  expect(lockedBeginWithoutTrustedDesktop.ok).toBe(false);
  expect(lockedBeginWithoutTrustedDesktop.error).toContain("trusted pi-gui desktop process");
  expect(lockedBeginWithoutTrustedDesktop.details?.errorCode).toBe("desktop_locked");

  const lockedBeginWithoutInstall = await runPackagedHelper(
    helperAppExecutable,
    { command: "locked_use_begin" },
    {
      PI_GUI_COMPUTER_USE_TEST_FORCE_LOCKED: "1",
      PI_GUI_COMPUTER_USE_TEST_LOCKED_USE_INSTALLER_STATE: "not-installed",
    },
  );
  expect(lockedBeginWithoutInstall.ok).toBe(false);
  expect(lockedBeginWithoutInstall.error).toContain("Locked Computer Use is not enabled");
  expect(lockedBeginWithoutInstall.details?.errorCode).toBe("desktop_locked");
  expect(lockedBeginWithoutInstall.details?.lockedUse).toBe("not_enabled");

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

function runDirectDaemonInvocation(helperPath: string): Promise<{ code: number | null; stderr: string }> {
  const turnToken = "direct-turn-token-000000000000000000000000000";
  return new Promise((resolve, reject) => {
    const child = spawn(
      helperPath,
      ["--lock-screen-authorization-daemon", `${process.pid}`, helperPath],
      {
        stdio: ["pipe", "ignore", "pipe"],
        env: process.env,
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stderr });
    });
    child.stdin.end(`${turnToken}\n`);
  });
}

function runLockedUseInstallerStatus(installerPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(installerPath, ["status"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
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
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(stderr.trim() || `Computer Use locked-use installer exited with code ${code}.`));
    });
  });
}

async function expectInstallerInstallWithoutConfirmToFail(installerPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(installerPath, ["install"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
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
        expect(code).not.toBe(0);
        expect(stdout.trim()).toBe("");
        expect(stderr).toContain("--confirm-system-login-change");
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}
