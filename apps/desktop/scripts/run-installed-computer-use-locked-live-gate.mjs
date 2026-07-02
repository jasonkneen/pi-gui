#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const repoDir = path.resolve(desktopDir, "..", "..");
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
  console.log("COMPUTER_USE_INSTALLED_LOCKED_LIVE_GATE_STEP preflight");
  if (process.platform !== "darwin") {
    throw blockedError("platform=unsupported", "reason=requires-macos", "Locked Computer Use E2E requires macOS.");
  }
  if (process.env[lockScreenE2eEnvVar] !== "1") {
    throw blockedError(
      "lock_screen_e2e=not_confirmed",
      "reason=requires-explicit-lock-screen-confirmation",
      `Set ${lockScreenE2eEnvVar}=1 to allow this gate to lock the desktop during the installed-app E2E.`,
    );
  }
  await assertRealAuthReady();

  console.log("COMPUTER_USE_INSTALLED_LOCKED_LIVE_GATE_STEP installed-locked-readiness");
  const readiness = await runCaptured(process.execPath, ["scripts/computer-use-locked-readiness.mjs", "--installed"], {
    cwd: desktopDir,
  });
  process.stdout.write(readiness.stdout);
  process.stderr.write(readiness.stderr);
  if (readiness.code !== 0) {
    throw blockedError(
      "locked_use=not_ready",
      "reason=locked-readiness-not-ready",
      readiness.stderr.trim() || readiness.stdout.trim() || "Locked Computer Use readiness failed.",
    );
  }

  console.log("COMPUTER_USE_INSTALLED_LOCKED_LIVE_GATE_STEP desktop-state-preflight");
  const desktopState = await desktopLockState();
  console.log(`COMPUTER_USE_INSTALLED_LOCKED_LIVE_GATE_DESKTOP_STATE state=${desktopState}`);
  if (desktopState === "locked") {
    throw blockedError(
      "desktop=locked",
      "reason=preflight-requires-unlocked-desktop",
      "Unlock the desktop before running the locked-live gate; the spec locks it at the controlled point.",
    );
  }

  console.log("COMPUTER_USE_INSTALLED_LOCKED_LIVE_GATE_STEP installed-locked-live");
  const invocation = pnpmInvocation([
    "--dir",
    repoDir,
    "exec",
    "playwright",
    "test",
    "-c",
    "apps/desktop/playwright.config.ts",
    "apps/desktop/tests/production/installed-computer-use-locked-live.spec.ts",
  ]);
  await run(invocation.command, invocation.args, {
    cwd: desktopDir,
    env: {
      ...process.env,
      PI_APP_TEST_MODE: "background",
      [lockScreenE2eEnvVar]: "1",
    },
  });

  console.log("COMPUTER_USE_INSTALLED_LOCKED_LIVE_GATE_OK installed-real-auth-locked-desktop-computer-use-relock");
}

async function assertRealAuthReady() {
  if (process.env[realAuthEnvVar] !== "1") {
    throw blockedError(
      "real_auth=not_enabled",
      "reason=installed-live-requires-real-auth",
      `Set ${realAuthEnvVar}=1 and ${realAuthSourceDirEnvVar}=/absolute/path/to/agent.`,
    );
  }

  const rawSourceDir = process.env[realAuthSourceDirEnvVar]?.trim();
  if (!rawSourceDir) {
    throw blockedError(
      "real_auth=source_dir_missing",
      "reason=installed-live-requires-real-auth",
      `Set ${realAuthSourceDirEnvVar}=/absolute/path/to/agent when ${realAuthEnvVar}=1.`,
    );
  }

  const authPath = path.join(path.resolve(rawSourceDir), "auth.json");
  try {
    await access(authPath);
  } catch {
    throw blockedError(
      "real_auth=auth_file_missing",
      "reason=installed-live-requires-real-auth",
      `Real-auth source dir is missing required file auth.json: ${authPath}.`,
    );
  }
}

async function desktopLockState() {
  const result = await runCaptured("ioreg", ["-n", "Root", "-d1"], { cwd: desktopDir });
  if (result.code !== 0) {
    return "unknown";
  }
  if (/"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(result.stdout) || /"IOConsoleLocked"\s*=\s*Yes/.test(result.stdout)) {
    return "locked";
  }
  return "unlocked";
}

function pnpmInvocation(args) {
  const npmExecPath = process.env.npm_execpath ?? "";
  if (npmExecPath.includes("pnpm")) {
    return { command: process.execPath, args: [npmExecPath, ...args] };
  }
  return { command: "npx", args: ["pnpm", ...args] };
}

function blockedError(...lines) {
  return new Error(["COMPUTER_USE_INSTALLED_LOCKED_LIVE_GATE_BLOCKED", ...lines].join(" "));
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

function runCaptured(command, args, options = {}) {
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
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}
