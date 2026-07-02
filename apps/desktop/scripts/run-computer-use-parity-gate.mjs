import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const repoDir = path.resolve(desktopDir, "..", "..");

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function main() {
  console.log("COMPUTER_USE_PARITY_GATE_STEP desktop-state-preflight");
  const initialLockState = await desktopLockStateForBackgroundProbe();
  if (initialLockState.locked) {
    console.warn(
      "Computer Use parity gate detected a locked desktop; package-level checks will run, then the real background cursor/focus probe will stop until the desktop is unlocked.",
    );
  }

  await runPnpmStep("build", ["run", "build"], {
    cwd: desktopDir,
  });

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
      "apps/desktop/tests/core/review-ux.spec.ts",
      "-g",
      "Computer Use",
    ],
    {
      cwd: desktopDir,
      env: {
        ...process.env,
        PI_APP_TEST_MODE: "background",
      },
    },
  );

  await runPnpmStep("package", ["exec", "electron-builder", "--mac", "--dir"], {
    cwd: desktopDir,
  });

  await runPnpmStep(
    "packaged-playwright",
    [
      "--dir",
      repoDir,
      "exec",
      "playwright",
      "test",
      "-c",
      "apps/desktop/playwright.config.ts",
      "apps/desktop/tests/production/packaged-computer-use.spec.ts",
      "apps/desktop/tests/production/packaged-computer-use-extension-surface.spec.ts",
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
    "packaged-locked-readiness-status",
    process.execPath,
    ["scripts/computer-use-locked-readiness.mjs", "--packaged", "--allow-not-enabled"],
    {
      cwd: desktopDir,
    },
  );

  const backgroundProbeLockState = await desktopLockStateForBackgroundProbe();
  if (backgroundProbeLockState.locked) {
    throw lockedDesktopForBackgroundProbeError();
  }

  await runStep("background-probe", process.execPath, ["scripts/computer-use-background-probe.mjs", "--packaged"], {
    cwd: desktopDir,
    env: {
      ...process.env,
      PI_GUI_COMPUTER_USE_STRICT_FOCUS_GUARD: "1",
      PI_GUI_COMPUTER_USE_ALLOW_USER_FOCUS_CHANGES: "1",
    },
  });

  console.log(
    "COMPUTER_USE_PARITY_GATE_OK packaged-helper-extension-locked-use-extension-surface-failure-timeline-background-cursor",
  );
}

async function runPnpmStep(name, args, options) {
  const invocation = pnpmInvocation(args);
  await runStep(name, invocation.command, invocation.args, options);
}

function pnpmInvocation(args) {
  const npmExecPath = process.env.npm_execpath ?? "";
  if (npmExecPath.includes("pnpm")) {
    return { command: process.execPath, args: [npmExecPath, ...args] };
  }
  return { command: "npx", args: ["pnpm", ...args] };
}

async function desktopLockStateForBackgroundProbe() {
  if (process.platform !== "darwin") {
    console.log("COMPUTER_USE_PARITY_GATE_DESKTOP_STATE state=not-darwin");
    return { locked: false };
  }

  let stdout = "";
  try {
    stdout = await capture("ioreg", ["-n", "Root", "-d1"], { cwd: desktopDir });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`Could not preflight macOS lock state before the Computer Use background probe: ${detail}`);
    console.log("COMPUTER_USE_PARITY_GATE_DESKTOP_STATE state=unknown");
    return { locked: false };
  }

  const locked = /"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(stdout) || /"IOConsoleLocked"\s*=\s*Yes/.test(stdout);
  console.log(`COMPUTER_USE_PARITY_GATE_DESKTOP_STATE state=${locked ? "locked" : "unlocked"}`);
  return { locked };
}

function lockedDesktopForBackgroundProbeError() {
  return new Error(
    [
      "COMPUTER_USE_PARITY_GATE_BLOCKED desktop=locked reason=background-probe-requires-unlocked-desktop",
      "Computer Use parity gate requires an unlocked desktop for the real background cursor/focus probe.",
      "Package-level checks completed before the blocked background probe: failure shaping, timeline failure UI, packaged helper/extension, locked-use self-test, top-level @ extension surface, and packaged locked-readiness status.",
      "Unlock the desktop before rerunning test:prod:packaged-computer-use-parity.",
    ].join("\n"),
  );
}

async function runStep(name, command, args, options) {
  console.log(`COMPUTER_USE_PARITY_GATE_STEP ${name}`);
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
