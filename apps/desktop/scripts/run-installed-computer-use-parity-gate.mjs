import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import asar from "@electron/asar";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const repoDir = path.resolve(desktopDir, "..", "..");
const installedAppBundle = "/Applications/pi-gui.app";
const installedAppAsar = path.join(installedAppBundle, "Contents", "Resources", "app.asar");
const builtOutDir = path.join(desktopDir, "out");
const builtNativeComputerUseHelperApp = path.join(desktopDir, "build", "native", "pi-gui Computer Use.app");
const installedNativeComputerUseHelperApp = path.join(
  installedAppBundle,
  "Contents",
  "SharedSupport",
  "pi-gui Computer Use.app",
);
const installedNativeComputerUseHelperExecutable = path.join(
  installedNativeComputerUseHelperApp,
  "Contents",
  "MacOS",
  "pi-gui-computer-use-helper",
);
const workspaceRuntimePackages = [
  {
    packageName: "@pi-gui/catalogs",
    sourceDir: path.join(repoDir, "packages", "catalogs"),
  },
  {
    packageName: "@pi-gui/session-driver",
    sourceDir: path.join(repoDir, "packages", "session-driver"),
  },
  {
    packageName: "@pi-gui/pi-sdk-driver",
    sourceDir: path.join(repoDir, "packages", "pi-sdk-driver"),
  },
];
const realAuthEnvVar = "PI_APP_REAL_AUTH";
const realAuthSourceDirEnvVar = "PI_APP_REAL_AUTH_SOURCE_DIR";
const lockScreenE2eEnvVar = "PI_APP_LOCK_SCREEN_E2E";

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function main() {
  console.log("COMPUTER_USE_INSTALLED_PARITY_GATE_STEP installed-app-preflight");
  await access(installedAppBundle);

  console.log("COMPUTER_USE_INSTALLED_PARITY_GATE_STEP desktop-state-preflight");
  const initialLockState = await desktopLockStateForInstalledLive();
  if (initialLockState.locked) {
    console.warn(
      "Installed Computer Use parity gate detected a locked desktop; installed-app checks will run, then the live background cursor/focus E2E will stop until the desktop is unlocked.",
    );
  }

  await runPnpmStep("build", ["run", "build"], {
    cwd: desktopDir,
  });

  await assertInstalledAppUsesCurrentRuntimePayload();

  await runStep("extension-failure-shaping", process.execPath, [
    "packages/computer-use-extension/scripts/test-locked-failure.mjs",
  ], {
    cwd: repoDir,
  });

  await runPnpmStep(
    "timeline-failure-ui",
    [
      "--dir",
      repoDir,
      "exec",
      "playwright",
      "test",
      "-c",
      "apps/desktop/playwright.config.ts",
      "apps/desktop/tests/core/computer-use-timeline-failures.spec.ts",
    ],
    {
      cwd: desktopDir,
      env: {
        ...process.env,
        PI_APP_TEST_MODE: "background",
      },
    },
  );

  await runPnpmStep(
    "installed-extension-surface",
    [
      "--dir",
      repoDir,
      "exec",
      "playwright",
      "test",
      "-c",
      "apps/desktop/playwright.config.ts",
      "apps/desktop/tests/production/installed-computer-use-extension-surface.spec.ts",
    ],
    {
      cwd: desktopDir,
      env: {
        ...process.env,
        PI_APP_TEST_MODE: "background",
      },
    },
  );

  await runStep(
    "installed-helper-capabilities",
    process.execPath,
    ["scripts/computer-use-background-probe.mjs", "--installed", "--capabilities-only"],
    {
      cwd: desktopDir,
    },
  );
  await assertInstalledHelperFailureShaping();

  const lockedReadiness = await runInstalledLockedReadinessStatus();
  await logInstalledCompletionPreflightStatus();
  const backgroundProbeLockState = await desktopLockStateForInstalledLive();
  const backgroundProbeCompleted = await runInstalledBackgroundProbeIfUnlocked(backgroundProbeLockState);

  if (!lockedReadiness.ready) {
    throw lockedUseNotReadyForInstalledParityError();
  }
  assertLockScreenE2eConfirmedForInstalledParity();

  await runPnpmStep(
    "installed-locked-use-self-test",
    [
      "--dir",
      repoDir,
      "exec",
      "playwright",
      "test",
      "-c",
      "apps/desktop/playwright.config.ts",
      "apps/desktop/tests/production/installed-computer-use-locked-use-self-test.spec.ts",
    ],
    {
      cwd: desktopDir,
      env: {
        ...process.env,
        PI_APP_TEST_MODE: "background",
      },
    },
  );

  const liveLockState = await desktopLockStateForInstalledLive();
  if (liveLockState.locked) {
    throw lockedDesktopForInstalledLiveError();
  }
  if (!backgroundProbeCompleted) {
    await runInstalledBackgroundProbe();
  }

  await assertRealAuthReadyForInstalledLive();

  await runPnpmStep(
    "installed-live-background-cursor",
    [
      "--dir",
      repoDir,
      "exec",
      "playwright",
      "test",
      "-c",
      "apps/desktop/playwright.config.ts",
      "apps/desktop/tests/production/installed-computer-use-live.spec.ts",
    ],
    {
      cwd: desktopDir,
      env: {
        ...process.env,
        PI_APP_TEST_MODE: "background",
      },
    },
  );

  await runStep("installed-locked-live", process.execPath, ["scripts/run-installed-computer-use-locked-live-gate.mjs"], {
    cwd: desktopDir,
  });

  console.log(
    "COMPUTER_USE_INSTALLED_PARITY_GATE_OK installed-app-freshness-extension-surface-failure-timeline-installed-helper-failure-shaping-locked-use-helper-capabilities-background-probe-live-background-cursor-locked-live",
  );
}

async function runPnpmStep(name, args, options) {
  const invocation = pnpmInvocation(args);
  await runStep(name, invocation.command, invocation.args, options);
}

async function runInstalledLockedReadinessStatus() {
  console.log("COMPUTER_USE_INSTALLED_PARITY_GATE_STEP installed-locked-readiness-status");
  const stdout = await capture(
    process.execPath,
    ["scripts/computer-use-locked-readiness.mjs", "--installed", "--allow-not-enabled"],
    {
      cwd: desktopDir,
    },
  );
  process.stdout.write(stdout);
  return {
    ready: /\bCOMPUTER_USE_LOCKED_READINESS_OK\b/.test(stdout),
  };
}

async function logInstalledCompletionPreflightStatus() {
  console.log("COMPUTER_USE_INSTALLED_PARITY_GATE_STEP installed-completion-preflight");
  const lockScreenE2e = process.env[lockScreenE2eEnvVar] === "1" ? "confirmed" : "not_confirmed";
  const realAuth = await installedRealAuthStatus();
  console.log(
    `COMPUTER_USE_INSTALLED_PARITY_GATE_COMPLETION_PREFLIGHT lock_screen_e2e=${lockScreenE2e} real_auth=${realAuth.state} source_dir=${statusToken(realAuth.sourceDir)} auth_json=${realAuth.authJson}`,
  );
}

async function installedRealAuthStatus() {
  if (process.env[realAuthEnvVar] !== "1") {
    return { state: "not_enabled", sourceDir: "unset", authJson: "missing" };
  }

  const rawSourceDir = process.env[realAuthSourceDirEnvVar]?.trim();
  if (!rawSourceDir) {
    return { state: "source_dir_missing", sourceDir: "unset", authJson: "missing" };
  }

  const sourceDir = path.resolve(rawSourceDir);
  const authPath = path.join(sourceDir, "auth.json");
  try {
    await access(authPath);
    return { state: "ready", sourceDir, authJson: "present" };
  } catch {
    return { state: "auth_file_missing", sourceDir, authJson: "missing" };
  }
}

function statusToken(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed.replace(/\s+/g, "_") : "unknown";
}

async function runInstalledBackgroundProbeIfUnlocked(lockState) {
  if (lockState.locked) {
    console.log("COMPUTER_USE_INSTALLED_PARITY_GATE_SKIPPED installed-background-probe desktop=locked");
    return false;
  }

  await runInstalledBackgroundProbe();
  return true;
}

async function runInstalledBackgroundProbe() {
  await runStep(
    "installed-background-probe",
    process.execPath,
    ["scripts/computer-use-background-probe.mjs", "--installed", "--preserve-frontmost"],
    {
      cwd: desktopDir,
      env: {
        ...process.env,
        PI_GUI_COMPUTER_USE_STRICT_FOCUS_GUARD: "1",
        PI_GUI_COMPUTER_USE_ALLOW_USER_FOCUS_CHANGES: "1",
        PI_GUI_COMPUTER_USE_ALLOW_USER_POINTER_CHANGES: "1",
      },
    },
  );
}

async function assertInstalledHelperFailureShaping() {
  console.log("COMPUTER_USE_INSTALLED_PARITY_GATE_STEP installed-helper-failure-shaping");
  const failureCases = [
    {
      name: "desktop_locked",
      request: { command: "get_app_state", app: "Finder" },
      env: { PI_GUI_COMPUTER_USE_TEST_FORCE_LOCKED: "1" },
      errorIncludes: ["Mac is locked"],
      details: { errorCode: "desktop_locked", screenLocked: "true" },
    },
    {
      name: "accessibility_denied",
      request: { command: "get_app_state", app: "Finder" },
      env: {
        PI_GUI_COMPUTER_USE_TEST_FORCE_UNLOCKED: "1",
        PI_GUI_COMPUTER_USE_TEST_FORCE_ACCESSIBILITY_DENIED: "1",
      },
      errorIncludes: ["Accessibility permission is not granted"],
      details: { errorCode: "accessibility_denied", accessibility: "denied" },
    },
    {
      name: "app_not_found",
      request: { command: "get_app_state", app: "Definitely Missing Pi GUI Test App" },
      env: { PI_GUI_COMPUTER_USE_TEST_FORCE_UNLOCKED: "1" },
      errorIncludes: ["Could not find app"],
      details: { errorCode: "app_not_found" },
    },
    {
      name: "screen_recording_denied",
      request: { command: "click", app: "Finder", x: 10, y: 10 },
      env: {
        PI_GUI_COMPUTER_USE_TEST_FORCE_UNLOCKED: "1",
        PI_GUI_COMPUTER_USE_TEST_FORCE_SCREEN_RECORDING_DENIED: "1",
      },
      errorIncludes: ["Screen Recording permission"],
      details: { errorCode: "screen_recording_denied", screenRecording: "denied" },
    },
    {
      name: "screenshot_unavailable",
      request: { command: "click", app: "Finder", x: 10, y: 10 },
      env: {
        PI_GUI_COMPUTER_USE_TEST_FORCE_UNLOCKED: "1",
        PI_GUI_COMPUTER_USE_TEST_FORCE_SCREENSHOT_UNAVAILABLE: "1",
      },
      errorIncludes: ["target window screenshot is unavailable"],
      details: { errorCode: "screenshot_unavailable", screenshot: "unavailable" },
    },
    {
      name: "physical_input_required",
      request: { command: "click", app: "Finder", x: 10, y: 10 },
      env: {
        PI_GUI_COMPUTER_USE_TEST_FORCE_UNLOCKED: "1",
        PI_GUI_COMPUTER_USE_TEST_FORCE_PHYSICAL_INPUT_REQUIRED: "1",
      },
      errorIncludes: ["would require foreground physical input", "moving the user's physical mouse"],
      details: { errorCode: "physical_input_required" },
    },
  ];

  for (const failureCase of failureCases) {
    const response = await runInstalledHelper(failureCase.request, failureCase.env);
    assertInstalledHelperFailure(failureCase, response);
  }
  console.log(`COMPUTER_USE_INSTALLED_HELPER_FAILURES_OK cases=${failureCases.length}`);
}

async function runInstalledHelper(request, env = {}) {
  const stdout = await captureWithInput(
    installedNativeComputerUseHelperExecutable,
    [],
    `${JSON.stringify(request)}\n`,
    {
      cwd: desktopDir,
      env: {
        ...process.env,
        ...env,
      },
      allowNonZeroStdout: true,
    },
  );
  try {
    return JSON.parse(stdout);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Installed Computer Use helper returned invalid JSON for ${request.command}: ${detail}`);
  }
}

function assertInstalledHelperFailure(failureCase, response) {
  if (response?.ok !== false) {
    throw new Error(
      `Installed Computer Use helper failure case ${failureCase.name} did not fail: ${JSON.stringify(response)}`,
    );
  }
  const error = String(response.error ?? "");
  for (const expectedText of failureCase.errorIncludes) {
    if (!error.includes(expectedText)) {
      throw new Error(
        `Installed Computer Use helper failure case ${failureCase.name} did not include ${JSON.stringify(expectedText)} in ${JSON.stringify(error)}.`,
      );
    }
  }
  for (const [key, expectedValue] of Object.entries(failureCase.details)) {
    if (response.details?.[key] !== expectedValue) {
      throw new Error(
        `Installed Computer Use helper failure case ${failureCase.name} reported details.${key}=${JSON.stringify(response.details?.[key])}; expected ${JSON.stringify(expectedValue)}.`,
      );
    }
  }
}

async function assertInstalledAppUsesCurrentRuntimePayload() {
  console.log("COMPUTER_USE_INSTALLED_PARITY_GATE_STEP installed-app-freshness");
  await access(installedAppAsar);
  const targets = [
    ...(await installedBuiltOutFreshnessTargets()),
    ...(await installedWorkspaceRuntimePackageFreshnessTargets()),
  ];
  await Promise.all(targets.map(assertInstalledFileFresh));
  const nativeFreshness = await assertInstalledNativeComputerUsePayloadFresh();
  console.log(
    `COMPUTER_USE_INSTALLED_PARITY_GATE_FRESH files=${targets.length} native_files=${nativeFreshness.files} native_executables=${nativeFreshness.executables}`,
  );
}

async function installedBuiltOutFreshnessTargets() {
  const builtFiles = (await listFiles(builtOutDir)).filter(isRuntimeBuiltFile);
  return builtFiles.map((builtFile) => ({
    currentPath: builtFile,
    installedPath: path.relative(desktopDir, builtFile),
  }));
}

async function installedWorkspaceRuntimePackageFreshnessTargets() {
  const packageTargets = await Promise.all(
    workspaceRuntimePackages.map(async ({ packageName, sourceDir }) => {
      const packageFiles = (await listFiles(sourceDir)).filter(isRuntimePackageFile);
      const packageInstallDir = path.join("node_modules", packageName);
      return packageFiles.map((packageFile) => ({
        currentPath: packageFile,
        installedPath: path.join(packageInstallDir, path.relative(sourceDir, packageFile)),
      }));
    }),
  );
  return packageTargets.flat();
}

async function assertInstalledFileFresh(target) {
  const currentHash = await fileHash(target.currentPath);
  let installedHash = "";
  try {
    installedHash = bufferHash(asar.extractFile(installedAppAsar, target.installedPath));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw installedAppOutdatedError(`Installed app.asar is missing ${target.installedPath}. ${detail}`);
  }
  if (installedHash !== currentHash) {
    throw installedAppOutdatedError(
      `Installed app.asar does not match the current local build for ${target.installedPath}.`,
    );
  }
}

async function assertInstalledNativeComputerUsePayloadFresh() {
  const fileTargets = nativeComputerUseFileTargets();
  const executableTargets = nativeComputerUseExecutableTargets();
  await Promise.all([
    ...fileTargets.map(assertInstalledNativeFileFresh),
    ...executableTargets.map(assertInstalledMachOUuidFresh),
  ]);
  return {
    files: fileTargets.length,
    executables: executableTargets.length,
  };
}

function nativeComputerUseFileTargets() {
  return [
    "Contents/Info.plist",
    "Contents/PkgInfo",
    "Contents/SharedSupport/PiGuiComputerUseAuthorizationPlugin.bundle/Contents/Info.plist",
  ].map(nativeComputerUseTarget);
}

function nativeComputerUseExecutableTargets() {
  return [
    "Contents/MacOS/pi-gui-computer-use-helper",
    "Contents/SharedSupport/pi-gui-computer-use-locked-use-installer",
    "Contents/SharedSupport/PiGuiComputerUseAuthorizationPlugin.bundle/Contents/MacOS/PiGuiComputerUseAuthorizationPlugin",
  ].map(nativeComputerUseTarget);
}

function nativeComputerUseTarget(relativePath) {
  return {
    currentPath: path.join(builtNativeComputerUseHelperApp, relativePath),
    installedPath: path.join(installedNativeComputerUseHelperApp, relativePath),
    relativePath,
  };
}

async function assertInstalledNativeFileFresh(target) {
  const [currentHash, installedHash] = await Promise.all([
    fileHash(target.currentPath),
    fileHash(target.installedPath),
  ]);
  if (installedHash !== currentHash) {
    throw installedAppOutdatedError(
      `Installed native Computer Use file does not match the current local build for ${target.relativePath}.`,
    );
  }
}

async function assertInstalledMachOUuidFresh(target) {
  const [currentUuid, installedUuid] = await Promise.all([
    machOUuids(target.currentPath),
    machOUuids(target.installedPath),
  ]);
  if (installedUuid !== currentUuid) {
    throw installedAppOutdatedError(
      `Installed native Computer Use executable does not match the current local build UUID for ${target.relativePath}: current=${currentUuid || "<empty>"} installed=${installedUuid || "<empty>"}.`,
    );
  }
}

async function machOUuids(filePath) {
  const stdout = await capture("dwarfdump", ["--uuid", filePath], { cwd: desktopDir });
  const uuids = stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => {
      const match = /^UUID:\s+([A-Fa-f0-9-]+)\s+\(([^)]+)\)/.exec(line);
      return match ? `${match[1].toUpperCase()} (${match[2]})` : "";
    })
    .filter(Boolean)
    .join("\n");
  if (!uuids) {
    throw new Error(`Could not read Mach-O UUID from ${filePath}.`);
  }
  return uuids;
}

function isRuntimeBuiltFile(filePath) {
  return !filePath.endsWith(".d.ts") && !filePath.endsWith(".js.map");
}

function isRuntimePackageFile(filePath) {
  return (
    path.basename(filePath) === "package.json" ||
    (filePath.includes(`${path.sep}dist${path.sep}`) && filePath.endsWith(".js"))
  );
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return listFiles(entryPath);
      }
      return entry.isFile() ? [entryPath] : [];
    }),
  );
  return files.flat().sort();
}

async function fileHash(filePath) {
  return bufferHash(await readFile(filePath));
}

function bufferHash(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function installedAppOutdatedError(detail) {
  return new Error(
    [
      "COMPUTER_USE_INSTALLED_PARITY_GATE_BLOCKED installed_app=outdated reason=installed-app-does-not-match-current-build",
      "Installed Computer Use parity must run against the current local build installed at /Applications/pi-gui.app.",
      detail,
      "Install the freshly built pi-gui.app into /Applications, keep the installed app idle/closed, and rerun test:prod:installed-computer-use-parity.",
    ].join("\n"),
  );
}

function pnpmInvocation(args) {
  const npmExecPath = process.env.npm_execpath ?? "";
  if (npmExecPath.includes("pnpm")) {
    return { command: process.execPath, args: [npmExecPath, ...args] };
  }
  return { command: "npx", args: ["pnpm", ...args] };
}

async function desktopLockStateForInstalledLive() {
  if (process.platform !== "darwin") {
    console.log("COMPUTER_USE_INSTALLED_PARITY_GATE_DESKTOP_STATE state=not-darwin");
    return { locked: false };
  }

  let stdout = "";
  try {
    stdout = await capture("ioreg", ["-n", "Root", "-d1"], { cwd: desktopDir });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`Could not preflight macOS lock state before installed Computer Use live E2E: ${detail}`);
    console.log("COMPUTER_USE_INSTALLED_PARITY_GATE_DESKTOP_STATE state=unknown");
    return { locked: false };
  }

  const locked = /"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(stdout) || /"IOConsoleLocked"\s*=\s*Yes/.test(stdout);
  console.log(`COMPUTER_USE_INSTALLED_PARITY_GATE_DESKTOP_STATE state=${locked ? "locked" : "unlocked"}`);
  return { locked };
}

function lockedDesktopForInstalledLiveError() {
  return new Error(
    [
      "COMPUTER_USE_INSTALLED_PARITY_GATE_BLOCKED desktop=locked reason=installed-live-requires-unlocked-active-desktop",
      "Installed Computer Use parity requires a real installed-app live background cursor/focus E2E.",
      "Locked Computer Use readiness is enabled, but this gate still needs an unlocked desktop before the active-user background cursor/focus E2E and the controlled locked-live E2E.",
      "Installed-app checks completed before the blocked live E2E: current app payload freshness, extension failure shaping, timeline failure UI, top-level @ extension surface, helper background-safety capabilities, installed helper failure shaping, locked-readiness status, and locked-use active-turn self-test.",
      "Unlock the desktop, keep the installed app idle/closed, and rerun test:prod:installed-computer-use-parity with PI_APP_LOCK_SCREEN_E2E=1 plus real auth.",
    ].join("\n"),
  );
}

function lockedUseNotReadyForInstalledParityError() {
  return new Error(
    [
      "COMPUTER_USE_INSTALLED_PARITY_GATE_BLOCKED locked_use=not_ready reason=installed-locked-use-not-ready",
      "Installed Computer Use parity cannot pass until Locked Computer Use is enabled and the real locked-screen E2E can run.",
      "The installed locked-readiness status above reports the exact installer and helper state.",
      "Enable Locked Computer Use in pi-gui Settings > Computer Use, then rerun test:prod:installed-computer-use-parity with PI_APP_LOCK_SCREEN_E2E=1 plus real auth.",
    ].join("\n"),
  );
}

function assertLockScreenE2eConfirmedForInstalledParity() {
  if (process.env[lockScreenE2eEnvVar] === "1") {
    return;
  }
  throw new Error(
    [
      "COMPUTER_USE_INSTALLED_PARITY_GATE_BLOCKED lock_screen_e2e=not_confirmed reason=requires-explicit-lock-screen-confirmation",
      "Installed Computer Use parity includes a controlled real desktop lock and relock E2E.",
      `Set ${lockScreenE2eEnvVar}=1 to allow test:prod:installed-computer-use-parity to lock the desktop during the installed-app E2E.`,
    ].join("\n"),
  );
}

async function assertRealAuthReadyForInstalledLive() {
  if (process.env[realAuthEnvVar] !== "1") {
    throw realAuthBlockedError(`Set ${realAuthEnvVar}=1 and ${realAuthSourceDirEnvVar}=/absolute/path/to/agent.`);
  }

  const rawSourceDir = process.env[realAuthSourceDirEnvVar]?.trim();
  if (!rawSourceDir) {
    throw realAuthBlockedError(`Set ${realAuthSourceDirEnvVar}=/absolute/path/to/agent when ${realAuthEnvVar}=1.`);
  }

  const authPath = path.join(path.resolve(rawSourceDir), "auth.json");
  try {
    await access(authPath);
  } catch {
    throw realAuthBlockedError(`Real-auth source dir is missing required file auth.json: ${authPath}.`);
  }
}

function realAuthBlockedError(detail) {
  return new Error(
    [
      "COMPUTER_USE_INSTALLED_PARITY_GATE_BLOCKED real_auth=not_enabled reason=installed-live-requires-real-auth",
      "Installed Computer Use parity cannot pass by skipping the real live background cursor/focus E2E.",
      detail,
      "Rerun test:prod:installed-computer-use-parity with real auth after the installed preconditions are available.",
    ].join("\n"),
  );
}

async function runStep(name, command, args, options) {
  console.log(`COMPUTER_USE_INSTALLED_PARITY_GATE_STEP ${name}`);
  await run(command, args, options);
}

function capture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const exitDetail = signal ? `signal ${signal}` : `exit code ${code}`;
      reject(new Error(stderr.trim() || `${command} ${args.join(" ")} failed with ${exitDetail}.`));
    });
  });
}

function captureWithInput(command, args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const { allowNonZeroStdout = false, ...spawnOptions } = options;
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...spawnOptions,
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0 || (allowNonZeroStdout && stdout.trim())) {
        resolve(stdout);
        return;
      }
      const exitDetail = signal ? `signal ${signal}` : `exit code ${code}`;
      reject(new Error(stderr.trim() || `${command} ${args.join(" ")} failed with ${exitDetail}.`));
    });
    child.stdin.end(input);
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const exitDetail = signal ? `signal ${signal}` : `exit code ${code}`;
      reject(new Error(`${command} ${args.join(" ")} failed with ${exitDetail}.`));
    });
  });
}
