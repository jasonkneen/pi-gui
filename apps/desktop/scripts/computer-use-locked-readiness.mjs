#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const helperExecutableName = "pi-gui-computer-use-helper";
const helperAppName = "pi-gui Computer Use.app";
const lockedUseInstallerExecutableName = "pi-gui-computer-use-locked-use-installer";
const authorizationPluginBundleName = "PiGuiComputerUseAuthorizationPlugin.bundle";
const requiredTeamIdentifier = "P2MBURJVUW";
const lockedUseProtocolVersion = "pi-gui-computer-use-active-turn-v1";
const lockedUseInstallerEnv = "PI_GUI_COMPUTER_USE_LOCKED_USE_INSTALLER_PATH";
const cursorOverlayShowEnv = "PI_GUI_COMPUTER_USE_SHOW_CURSOR";
const cursorOverlayDurationEnv = "PI_GUI_COMPUTER_USE_CURSOR_DURATION_MS";
const cursorOverlayGlideEnv = "PI_GUI_COMPUTER_USE_CURSOR_GLIDE_MS";
const defaultCursorOverlayDurationMs = "60000";
const defaultCursorOverlayGlideMs = "300";
const privateEnvKeys = [
  "PI_GUI_COMPUTER_USE_LOCKED_USE_APP_TOKEN",
  "PI_GUI_COMPUTER_USE_DESKTOP_PID",
  "PI_GUI_COMPUTER_USE_DESKTOP_PATH",
  "PI_GUI_COMPUTER_USE_LOCKED_USE_AUTH_SOCKET",
];

const args = new Set(process.argv.slice(2));
const mode = args.has("--packaged") ? "packaged" : "installed";
const allowNotEnabled = args.has("--allow-not-enabled");

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function main() {
  const appBundle = mode === "packaged" ? await resolvePackagedAppBundle() : "/Applications/pi-gui.app";
  const paths = bundlePaths(appBundle);

  await Promise.all([
    access(appBundle),
    access(paths.helperAppBundle),
    access(paths.helperExecutable),
    access(paths.lockedUseInstaller),
    access(paths.authorizationPluginBundle),
  ]);

  await expectSignedCode(appBundle, {
    identifier: "com.pi-gui.desktop",
    teamIdentifier: requiredTeamIdentifier,
  });
  await expectSignedCode(paths.helperAppBundle, {
    identifier: "com.pi-gui.desktop.computer-use-helper",
    teamIdentifier: requiredTeamIdentifier,
  });
  await expectSignedCode(paths.authorizationPluginBundle, {
    identifier: "com.pi-gui.desktop.computer-use.authorization-plugin",
    teamIdentifier: requiredTeamIdentifier,
  });
  await expectSignedCode(paths.lockedUseInstaller, {
    teamIdentifier: requiredTeamIdentifier,
  });

  const protocolVersion = (await capture(paths.helperExecutable, ["--lock-screen-authorization-protocol-version"])).stdout.trim();
  if (protocolVersion !== lockedUseProtocolVersion) {
    throw new Error(
      `Computer Use helper at ${paths.helperExecutable} reports ${protocolVersion || "<empty>"}; expected ${lockedUseProtocolVersion}.`,
    );
  }

  const installerState = await lockedUseInstallerState(paths.lockedUseInstaller);
  const helperStatus = await runHelperStatus(paths.helperExecutable, paths.lockedUseInstaller);
  const details = helperStatus.details ?? {};
  const lockedUseState = details.lockedUse ?? "unknown";
  const statusInstallerState = details.lockedUseInstaller ?? "unknown";
  const desktopState = details.screenLocked === "true" ? "locked" : details.screenLocked === "false" ? "unlocked" : "unknown";
  const cursorState = details.cursorVisible === "1" ? "enabled" : details.cursorVisible === "0" ? "disabled" : "unknown";

  if (statusInstallerState !== installerState) {
    throw new Error(
      `Locked Computer Use status mismatch: installer reported ${installerState}, helper reported ${statusInstallerState}.`,
    );
  }

  console.log(
    `COMPUTER_USE_LOCKED_READINESS_STATUS mode=${mode} desktop=${desktopState} frontmost=${statusToken(details.frontmostApp)} cursor=${cursorState} cursor_active=${statusToken(details.cursorActive)} cursor_duration_ms=${statusToken(details.cursorDurationMs)} cursor_glide_ms=${statusToken(details.cursorGlideMs)} locked_use=${lockedUseState} installer=${installerState} helper=${paths.helperExecutable}`,
  );

  if (installerState === "installed" && lockedUseState === "enabled") {
    console.log(
      `COMPUTER_USE_LOCKED_READINESS_OK mode=${mode} helper=${paths.helperExecutable} installer=${paths.lockedUseInstaller}`,
    );
    return;
  }

  const detailText = details.lockedUseMessage || textContent(helperStatus) || "Locked Computer Use is not enabled.";
  const message = [
    `Locked Computer Use is not ready for real locked-screen E2E: installer=${installerState}, locked_use=${lockedUseState}.`,
    detailText,
    "Enable Locked Computer Use in pi-gui Settings > Computer Use, then rerun this readiness check.",
  ].join("\n");

  if (allowNotEnabled) {
    console.log(`COMPUTER_USE_LOCKED_READINESS_NOT_ENABLED mode=${mode} installer=${installerState} locked_use=${lockedUseState}`);
    console.log(message);
    return;
  }

  throw new Error(message);
}

function bundlePaths(appBundle) {
  const helperAppBundle = path.join(appBundle, "Contents", "SharedSupport", helperAppName);
  const helperSharedSupport = path.join(helperAppBundle, "Contents", "SharedSupport");
  return {
    helperAppBundle,
    helperExecutable: path.join(helperAppBundle, "Contents", "MacOS", helperExecutableName),
    lockedUseInstaller: path.join(helperSharedSupport, lockedUseInstallerExecutableName),
    authorizationPluginBundle: path.join(helperSharedSupport, authorizationPluginBundleName),
  };
}

async function resolvePackagedAppBundle() {
  for (const outputDir of ["mac-arm64", "mac", "mac-universal"]) {
    const candidate = path.join(desktopDir, "release", outputDir, "pi-gui.app");
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next release output directory.
    }
  }
  throw new Error("Packaged pi-gui.app was not found. Run package:dir before the packaged locked-readiness check.");
}

async function expectSignedCode(targetPath, expected) {
  const details = await codesignDetails(targetPath);
  if (expected.identifier && !details.includes(`Identifier=${expected.identifier}`)) {
    throw new Error(`Expected ${targetPath} to be signed as ${expected.identifier}.\n${details}`);
  }
  if (!details.includes(`TeamIdentifier=${expected.teamIdentifier}`)) {
    throw new Error(`Expected ${targetPath} to be signed by TeamIdentifier=${expected.teamIdentifier}.\n${details}`);
  }
  if (!details.includes("flags=0x10000(runtime)")) {
    throw new Error(`Expected ${targetPath} to use hardened runtime.\n${details}`);
  }
  await codesignVerify(targetPath);
}

async function codesignDetails(targetPath) {
  const result = await capture("codesign", ["-dv", targetPath]);
  if (result.code === 0) {
    return commandOutput(result);
  }
  throw new Error(commandOutput(result).trim() || `codesign -dv failed for ${targetPath} with code ${result.code}.`);
}

async function codesignVerify(targetPath) {
  const result = await capture("codesign", ["--verify", "--deep", "--strict", targetPath]);
  if (result.code !== 0) {
    throw new Error(commandOutput(result).trim() || `codesign --verify failed for ${targetPath} with code ${result.code}.`);
  }
}

async function lockedUseInstallerState(installerPath) {
  const result = await capture(installerPath, ["status"]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `Locked Computer Use installer status failed with code ${result.code}.`);
  }
  const match = /^OK: (installed|not-installed|partial)$/m.exec(result.stdout.trim());
  if (!match) {
    throw new Error(`Locked Computer Use installer returned unexpected status: ${result.stdout.trim() || "<empty>"}`);
  }
  return match[1];
}

async function runHelperStatus(helperPath, installerPath) {
  const result = await capture(helperPath, [], {
    input: `${JSON.stringify({ command: "status" })}\n`,
    env: helperEnvironment(installerPath),
    timeoutMs: 5_000,
  });
  if (result.code !== 0 && !result.stdout.trim()) {
    throw new Error(result.stderr.trim() || `Computer Use helper status failed with code ${result.code}.`);
  }
  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Computer Use helper returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    throw new Error(response.error ?? "Computer Use helper status failed.");
  }
  return response;
}

function helperEnvironment(installerPath) {
  const env = {
    ...process.env,
    [lockedUseInstallerEnv]: installerPath,
  };
  setDefaultEnv(env, cursorOverlayShowEnv, "1");
  setDefaultEnv(env, cursorOverlayDurationEnv, defaultCursorOverlayDurationMs);
  setDefaultEnv(env, cursorOverlayGlideEnv, defaultCursorOverlayGlideMs);
  for (const key of Object.keys(env)) {
    if (privateEnvKeys.includes(key) || key.startsWith("PI_GUI_COMPUTER_USE_TEST_")) {
      delete env[key];
    }
  }
  return env;
}

function setDefaultEnv(env, key, value) {
  if (!env[key]?.trim()) {
    env[key] = value;
  }
}

function capture(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const child = spawn(command, commandArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env ?? process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`${command} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => finish(undefined, { code, signal, stdout, stderr }));
    if (options.input) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

function commandOutput(result) {
  return `${result.stdout}${result.stderr}`;
}

function textContent(response) {
  return response.content
    ?.filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n")
    .trim();
}

function statusToken(value) {
  const text = typeof value === "string" && value.trim() ? value.trim() : "unknown";
  return text.replace(/\s+/g, "_");
}
