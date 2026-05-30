import { spawn, execFile } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { promisify } from "node:util";
import { shell } from "electron";
import type {
  DesktopComputerUsePrivacyPane,
  DesktopComputerUseStatus,
  DesktopComputerUseStatusValue,
} from "../src/ipc";

const execFileAsync = promisify(execFile);
const helperPathEnv = "PI_GUI_COMPUTER_USE_HELPER_PATH";
const computerUsePrivateEnvKeys = [
  "PI_GUI_COMPUTER_USE_LOCKED_USE_APP_TOKEN",
  "PI_GUI_COMPUTER_USE_DESKTOP_PID",
  "PI_GUI_COMPUTER_USE_DESKTOP_PATH",
  "PI_GUI_COMPUTER_USE_LOCKED_USE_AUTH_SOCKET",
];
const statusOverrideEnv = "PI_APP_TEST_COMPUTER_USE_STATUS_JSON";
const settingsLogPathEnv = "PI_APP_TEST_COMPUTER_USE_SETTINGS_LOG_PATH";
const helperStatusTimeoutMs = 5_000;

interface HelperResponse {
  readonly ok: boolean;
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
  readonly details?: Record<string, string>;
  readonly error?: string;
}

export async function getComputerUseStatus(): Promise<DesktopComputerUseStatus> {
  const override = process.env[statusOverrideEnv]?.trim();
  if (override) {
    return JSON.parse(override) as DesktopComputerUseStatus;
  }

  const helperPath = process.env[helperPathEnv]?.trim();
  if (!helperPath) {
    return {
      helperAvailable: false,
      desktop: "unknown",
      accessibility: "unknown",
      screenRecording: "unknown",
      lockedUse: "not_enabled",
      message: `Computer Use helper is not configured. Missing ${helperPathEnv}.`,
    };
  }

  try {
    const response = await runHelper(helperPath, { command: "status" });
    if (!response.ok) {
      throw new Error(response.error ?? "Computer Use helper status failed.");
    }
    const details = response.details ?? {};
    return {
      helperAvailable: true,
      helperPath,
      desktop: details.screenLocked === "true" ? "locked" : details.screenLocked === "false" ? "unlocked" : "unknown",
      accessibility: permissionStatus(details.accessibility),
      screenRecording: permissionStatus(details.screenRecording),
      lockedUse: details.lockedUse === "enabled" ? "enabled" : "not_enabled",
      message: details.lockedUseMessage ?? textContent(response),
    };
  } catch (error) {
    return {
      helperAvailable: false,
      helperPath,
      desktop: "unknown",
      accessibility: "unknown",
      screenRecording: "unknown",
      lockedUse: "not_enabled",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function openComputerUsePrivacySettings(pane: DesktopComputerUsePrivacyPane): Promise<void> {
  const testLogPath = process.env[settingsLogPathEnv]?.trim();
  if (testLogPath) {
    await appendFile(testLogPath, `${pane}\n`, "utf8");
    return;
  }

  if (process.platform !== "darwin") {
    await shell.openExternal("https://support.apple.com/guide/mac-help/change-privacy-security-settings-mchl211c911f/mac");
    return;
  }

  const targets =
    pane === "screen-recording"
      ? [
          "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
          "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenRecording",
        ]
      : [
          "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        ];

  for (const target of targets) {
    try {
      await execFileAsync("open", [target]);
      return;
    } catch {
      // Try the next macOS pane URL before falling back to the app.
    }
  }

  await shell.openPath("/System/Applications/System Settings.app");
}

function permissionStatus(value: string | undefined): DesktopComputerUseStatusValue {
  switch (value) {
    case "granted":
      return "granted";
    case "denied":
      return "denied";
    default:
      return "unknown";
  }
}

function textContent(response: HelperResponse): string | undefined {
  return response.content
    ?.filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n")
    .trim();
}

function runHelper(helperPath: string, request: Record<string, unknown>): Promise<HelperResponse> {
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, [], { stdio: ["pipe", "pipe", "pipe"], env: helperEnvironment() });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (error?: Error, response?: HelperResponse) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      resolve(response ?? { ok: false, error: "Computer Use helper produced no response." });
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`Computer Use helper status timed out after ${helperStatusTimeoutMs}ms.`));
    }, helperStatusTimeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      if (code !== 0 && !stdout.trim()) {
        finish(new Error(stderr.trim() || `Computer Use helper exited with code ${code}.`));
        return;
      }
      try {
        finish(undefined, JSON.parse(stdout) as HelperResponse);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

function helperEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of computerUsePrivateEnvKeys) {
    delete env[key];
  }
  return env;
}
