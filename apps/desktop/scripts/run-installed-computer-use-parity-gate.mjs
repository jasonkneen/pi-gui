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

  const lockedReadiness = await runInstalledLockedReadinessStatus();
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

  await runStep(
    "installed-background-probe",
    process.execPath,
    ["scripts/computer-use-background-probe.mjs", "--installed"],
    {
      cwd: desktopDir,
      env: {
        ...process.env,
        PI_GUI_COMPUTER_USE_STRICT_FOCUS_GUARD: "1",
        PI_GUI_COMPUTER_USE_ALLOW_USER_FOCUS_CHANGES: "1",
      },
    },
  );

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
    "COMPUTER_USE_INSTALLED_PARITY_GATE_OK installed-app-freshness-extension-surface-failure-timeline-locked-use-helper-capabilities-background-probe-live-background-cursor-locked-live",
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

async function assertInstalledAppUsesCurrentRuntimePayload() {
  console.log("COMPUTER_USE_INSTALLED_PARITY_GATE_STEP installed-app-freshness");
  await access(installedAppAsar);
  const targets = [
    ...(await installedBuiltOutFreshnessTargets()),
    ...(await installedWorkspaceRuntimePackageFreshnessTargets()),
  ];
  await Promise.all(targets.map(assertInstalledFileFresh));
  console.log(`COMPUTER_USE_INSTALLED_PARITY_GATE_FRESH files=${targets.length}`);
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
      "Installed-app checks completed before the blocked live E2E: current app payload freshness, extension failure shaping, timeline failure UI, top-level @ extension surface, locked-use active-turn self-test, helper background-safety capabilities, and locked-readiness status.",
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
