import net from "node:net";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  createComputerUseExtension,
  type ComputerUseRuntimeConfig,
} from "../../../packages/computer-use-extension/src/index";

const computerUsePackageName = "@pi-gui/computer-use-extension";
const helperEnv = "PI_GUI_COMPUTER_USE_HELPER_PATH";
const lockedUseInstallerEnv = "PI_GUI_COMPUTER_USE_LOCKED_USE_INSTALLER_PATH";
const lockedUseAppTokenEnv = "PI_GUI_COMPUTER_USE_LOCKED_USE_APP_TOKEN";
const lockedUseDesktopPidEnv = "PI_GUI_COMPUTER_USE_DESKTOP_PID";
const lockedUseDesktopPathEnv = "PI_GUI_COMPUTER_USE_DESKTOP_PATH";
const lockedUseAuthorizationSocketEnv = "PI_GUI_COMPUTER_USE_LOCKED_USE_AUTH_SOCKET";
const disableEnv = "PI_GUI_DISABLE_BUILTIN_COMPUTER_USE";
const helperExecutableName = "pi-gui-computer-use-helper";
const helperAppName = "pi-gui Computer Use.app";
const lockedUseInstallerExecutableName = "pi-gui-computer-use-locked-use-installer";
const lockedUseAuthorizationSocketDirectory = "/tmp/pi-gui-cu";
const lockedUseDaemonSocketPath = "/tmp/com.pi-gui.desktop.computer-use/LockScreenLoginAuthorization.sock";
const testForceLockedEnv = "PI_GUI_COMPUTER_USE_TEST_FORCE_LOCKED";
const testLockedUseInstallerStateEnv = "PI_GUI_COMPUTER_USE_TEST_LOCKED_USE_INSTALLER_STATE";
const testAssumeUnlockedAfterAuthorizationEnv = "PI_GUI_COMPUTER_USE_TEST_ASSUME_UNLOCKED_AFTER_AUTHORIZATION";
const testSkipRelockEnv = "PI_GUI_COMPUTER_USE_TEST_SKIP_RELOCK";
const testSkipUnlockReturnKeyEnv = "PI_GUI_COMPUTER_USE_TEST_SKIP_UNLOCK_RETURN_KEY";
const lockedUseUnlockTimeoutMsEnv = "PI_GUI_COMPUTER_USE_LOCKED_USE_UNLOCK_TIMEOUT_MS";
const lockedUseLeaseSecondsEnv = "PI_GUI_COMPUTER_USE_LOCKED_USE_LEASE_SECONDS";
const lockedUseSelfTestHelperTimeoutMs = 10_000;
const lockedUseSelfTestAuthorizationTimeoutMs = 3_000;
const lockedUseSelfTestConnectTimeoutMs = 1_000;
let lockedUseAuthorizationServer: net.Server | undefined;
let lockedUseAppToken: string | undefined;
let lockedUseAuthorizationSocketPath: string | undefined;

interface ConfigureComputerUseRuntimeOptions {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly execPath: string;
}

export interface ComputerUseRuntimeDriverOptions {
  readonly extensionFactories: readonly ExtensionFactory[];
  readonly inlineExtensionMetadata: readonly {
    readonly displayName: string;
    readonly description?: string;
  }[];
}

interface HelperResponse {
  readonly ok: boolean;
  readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly details?: Readonly<Record<string, string>>;
  readonly error?: string;
}

export interface ComputerUseLockedUseSelfTestResult {
  readonly helperPath: string;
  readonly desktopPath: string;
  readonly authorizationSocket: string;
  readonly authorizationProbe: HelperResponse;
  readonly begin: HelperResponse;
  readonly end: HelperResponse;
}

export async function configureComputerUseRuntime(
  options: ConfigureComputerUseRuntimeOptions,
): Promise<ComputerUseRuntimeDriverOptions | undefined> {
  await removeComputerUsePackageEntry(resolveAgentDir(), resolveComputerUsePackageDir(options));

  if (process.env[disableEnv] === "1") {
    return undefined;
  }

  configureHelperPath(options);
  configureLockedUseInstallerPath(options);
  const appToken = configureLockedUseAppToken();
  const desktopProcess = configureLockedUseDesktopProcess();
  const authorizationSocket = await tryConfigureLockedUseAuthorizationBroker(appToken);
  const runtimeConfig: ComputerUseRuntimeConfig = {
    helperPath: process.env[helperEnv]?.trim() || undefined,
    lockedUseAppToken: appToken,
    lockedUseDesktopPid: desktopProcess.pid,
    lockedUseDesktopPath: desktopProcess.path,
    lockedUseAuthorizationSocket: authorizationSocket,
  };

  return {
    extensionFactories: [createComputerUseExtension(runtimeConfig)],
    inlineExtensionMetadata: [
      {
        displayName: "Computer Use",
        description: "Control Mac apps from pi",
      },
    ],
  };
}

function configureHelperPath(options: ConfigureComputerUseRuntimeOptions): void {
  if (process.env[helperEnv]?.trim()) {
    return;
  }

  const candidates = computerUseHelperCandidates(options);
  process.env[helperEnv] = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function configureLockedUseInstallerPath(options: ConfigureComputerUseRuntimeOptions): void {
  if (process.env[lockedUseInstallerEnv]?.trim()) {
    return;
  }

  const candidates = computerUseLockedUseInstallerCandidates(options);
  process.env[lockedUseInstallerEnv] = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function configureLockedUseAppToken(): string {
  lockedUseAppToken ??= process.env[lockedUseAppTokenEnv]?.trim() || randomBytes(32).toString("hex");
  scrubLockedUsePrivateProcessEnv();
  return lockedUseAppToken;
}

function configureLockedUseDesktopProcess(): { pid: string; path: string } {
  scrubLockedUsePrivateProcessEnv();
  return {
    pid: `${process.pid}`,
    path: process.execPath,
  };
}

async function configureLockedUseAuthorizationBroker(appToken: string): Promise<string | undefined> {
  scrubLockedUsePrivateProcessEnv();
  if (process.platform !== "darwin") {
    return undefined;
  }

  const socketPath = path.join(lockedUseAuthorizationSocketDirectory, `auth-${process.pid}.sock`);
  await mkdir(lockedUseAuthorizationSocketDirectory, { recursive: true, mode: 0o700 });
  await chmod(lockedUseAuthorizationSocketDirectory, 0o700).catch(() => undefined);
  await rm(socketPath, { force: true });

  lockedUseAuthorizationServer?.close();
  lockedUseAuthorizationSocketPath = undefined;
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    const finish = (allowed: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.end(allowed ? "ALLOW\n" : "DENY\n");
    };
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 256) {
        finish(false);
        return;
      }
      if (buffer.includes("\n")) {
        finish(buffer.trim() === `authorize ${appToken}`);
      }
    });
    socket.on("end", () => finish(buffer.trim() === `authorize ${appToken}`));
    socket.on("error", () => undefined);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.unref();
  lockedUseAuthorizationServer = server;
  lockedUseAuthorizationSocketPath = socketPath;
  await chmod(socketPath, 0o600).catch(() => undefined);
  process.once("exit", () => {
    try {
      rmSync(socketPath, { force: true });
    } catch {
      // Best-effort cleanup for a per-process Unix socket.
    }
  });
  return socketPath;
}

export async function runComputerUseLockedUseSelfTest(): Promise<ComputerUseLockedUseSelfTestResult> {
  if (!process.env.PI_APP_TEST_MODE) {
    throw new Error("Computer Use locked-use self-test is only available in PI_APP_TEST_MODE.");
  }

  const helperPath = process.env[helperEnv]?.trim();
  if (!helperPath) {
    throw new Error(`Computer Use helper is not configured. Missing ${helperEnv}.`);
  }
  if (!lockedUseAppToken) {
    throw new Error("Locked Computer Use app token is not configured.");
  }
  if (!lockedUseAuthorizationSocketPath) {
    throw new Error("Locked Computer Use desktop authorization socket is not configured.");
  }

  const env = lockedUseSelfTestHelperEnv(lockedUseAuthorizationSocketPath);
  const authorizationProbeToken = randomBytes(32).toString("hex");
  const authorizationProbe = await runComputerUseHelperForSelfTest(
    helperPath,
    {
      command: "locked_use_authorization_probe",
      locked_use_app_token: lockedUseAppToken,
      locked_use_turn_token: authorizationProbeToken,
    },
    env,
  );
  if (!authorizationProbe.ok) {
    throw new Error(authorizationProbe.error ?? "Locked Computer Use authorization probe failed.");
  }

  const turnToken = randomBytes(32).toString("hex");
  const beginPromise = runComputerUseHelperForSelfTest(
    helperPath,
    {
      command: "locked_use_begin",
      locked_use_app_token: lockedUseAppToken,
      locked_use_turn_token: turnToken,
    },
    env,
  );
  const authorizationPromise = authorizeLockedUseTurnForSelfTest(turnToken);
  const [begin] = await Promise.all([beginPromise, authorizationPromise]);
  if (!begin.ok) {
    throw new Error(begin.error ?? "Locked Computer Use active-turn begin failed.");
  }

  const end = await runComputerUseHelperForSelfTest(
    helperPath,
    {
      command: "locked_use_end",
      locked_use_app_token: lockedUseAppToken,
      locked_use_turn_token: turnToken,
    },
    env,
  );
  if (!end.ok) {
    throw new Error(end.error ?? "Locked Computer Use active-turn end failed.");
  }

  return {
    helperPath,
    desktopPath: process.execPath,
    authorizationSocket: lockedUseAuthorizationSocketPath,
    authorizationProbe,
    begin,
    end,
  };
}

function lockedUseSelfTestHelperEnv(authorizationSocket: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [lockedUseDesktopPidEnv]: `${process.pid}`,
    [lockedUseDesktopPathEnv]: process.execPath,
    [lockedUseAuthorizationSocketEnv]: authorizationSocket,
    [testForceLockedEnv]: "1",
    [testLockedUseInstallerStateEnv]: "installed",
    [testAssumeUnlockedAfterAuthorizationEnv]: "1",
    [testSkipRelockEnv]: "1",
    [testSkipUnlockReturnKeyEnv]: "1",
    [lockedUseUnlockTimeoutMsEnv]: "3000",
    [lockedUseLeaseSecondsEnv]: "5",
  };
  delete env[lockedUseAppTokenEnv];
  return env;
}

function runComputerUseHelperForSelfTest(
  helperPath: string,
  request: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Promise<HelperResponse> {
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, response?: HelperResponse) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error) {
        reject(error);
        return;
      }
      resolve(response ?? { ok: false, error: "Computer Use helper produced no response." });
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`Computer Use helper self-test timed out for ${request.command}.`));
    }, lockedUseSelfTestHelperTimeoutMs);

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
      try {
        if (stdout.trim()) {
          finish(undefined, JSON.parse(stdout) as HelperResponse);
          return;
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (code !== 0) {
        finish(new Error(stderr.trim() || `Computer Use helper exited with code ${code}.`));
        return;
      }
      finish(new Error("Computer Use helper produced no response."));
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

async function authorizeLockedUseTurnForSelfTest(turnToken: string): Promise<void> {
  const response = await requestLockedUseDaemonAuthorizationForSelfTest(turnToken);
  if (response !== "ALLOW") {
    throw new Error(`Locked Computer Use daemon returned ${response} instead of ALLOW.`);
  }
}

async function requestLockedUseDaemonAuthorizationForSelfTest(turnToken: string): Promise<string> {
  const deadline = Date.now() + lockedUseSelfTestAuthorizationTimeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await connectLockedUseDaemonForSelfTest(turnToken);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  throw new Error(`Timed out waiting for Locked Computer Use daemon socket: ${errorMessage(lastError)}`);
}

function connectLockedUseDaemonForSelfTest(turnToken: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(lockedUseDaemonSocketPath);
    let response = "";
    let settled = false;
    const finish = (error?: Error, value?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error) {
        reject(error);
        return;
      }
      resolve(value ?? "");
    };
    const timeout = setTimeout(() => {
      socket.destroy();
      finish(new Error("Locked Computer Use daemon authorization timed out."));
    }, lockedUseSelfTestConnectTimeoutMs);

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`authorize ${turnToken}\n`);
    });
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("error", (error) => finish(error));
    socket.on("end", () => {
      finish(undefined, response.trim());
    });
    socket.on("close", () => finish(undefined, response.trim()));
  });
}

async function tryConfigureLockedUseAuthorizationBroker(appToken: string): Promise<string | undefined> {
  try {
    return await configureLockedUseAuthorizationBroker(appToken);
  } catch (error) {
    console.warn(`Locked Computer Use authorization broker is unavailable: ${errorMessage(error)}`);
    return undefined;
  }
}

function scrubLockedUsePrivateProcessEnv(): void {
  delete process.env[lockedUseAppTokenEnv];
  delete process.env[lockedUseDesktopPidEnv];
  delete process.env[lockedUseDesktopPathEnv];
  delete process.env[lockedUseAuthorizationSocketEnv];
}

function computerUseHelperCandidates(options: ConfigureComputerUseRuntimeOptions): string[] {
  if (options.isPackaged) {
    return [
      path.join(path.dirname(options.execPath), "..", "SharedSupport", helperAppName, "Contents", "MacOS", helperExecutableName),
      path.join(path.dirname(options.execPath), helperExecutableName),
    ];
  }

  return [
    path.join(__dirname, "..", "..", "build", "native", helperAppName, "Contents", "MacOS", helperExecutableName),
    path.join(__dirname, "..", "..", "build", "native", helperExecutableName),
  ];
}

function computerUseLockedUseInstallerCandidates(options: ConfigureComputerUseRuntimeOptions): string[] {
  const helperAppRelativePath = path.join(
    helperAppName,
    "Contents",
    "SharedSupport",
    lockedUseInstallerExecutableName,
  );

  if (options.isPackaged) {
    return [
      path.join(path.dirname(options.execPath), "..", "SharedSupport", helperAppRelativePath),
      path.join(path.dirname(options.execPath), lockedUseInstallerExecutableName),
    ];
  }

  return [
    path.join(__dirname, "..", "..", "build", "native", helperAppRelativePath),
    path.join(__dirname, "..", "..", "build", "native", lockedUseInstallerExecutableName),
  ];
}

function resolveAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  return configured ? path.resolve(expandHome(configured)) : path.join(os.homedir(), ".pi", "agent");
}

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function resolveComputerUsePackageDir(options: ConfigureComputerUseRuntimeOptions): string {
  if (options.isPackaged) {
    return path.join(options.resourcesPath, "app.asar", "out", "computer-use-extension");
  }

  const linkedPackageDir = tryResolveLinkedComputerUsePackageDir();
  if (linkedPackageDir) {
    return linkedPackageDir;
  }

  const fallbackDirs = [
    path.join(__dirname, "..", "computer-use-extension"),
    path.resolve(__dirname, "..", "..", "..", "..", "packages", "computer-use-extension"),
  ];
  const fallbackDir = fallbackDirs.find(hasComputerUsePackageManifest);
  if (fallbackDir) {
    return fallbackDir;
  }

  throw new Error(`Unable to resolve ${computerUsePackageName}. Searched ${fallbackDirs.join(", ")}.`);
}

function tryResolveLinkedComputerUsePackageDir(): string | undefined {
  try {
    return findComputerUsePackageDir(require.resolve(computerUsePackageName));
  } catch (error) {
    if (isModuleResolutionError(error)) {
      return undefined;
    }
    throw error;
  }
}

function findComputerUsePackageDir(resolvedEntry: string): string {
  let currentDir = path.dirname(resolvedEntry);
  while (currentDir !== path.dirname(currentDir)) {
    if (hasComputerUsePackageManifest(currentDir)) {
      return currentDir;
    }
    currentDir = path.dirname(currentDir);
  }
  throw new Error(`Unable to locate package root for ${computerUsePackageName} from ${resolvedEntry}.`);
}

function hasComputerUsePackageManifest(directory: string): boolean {
  return existsSync(path.join(directory, "package.json"));
}

function isModuleResolutionError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: string }).code === "MODULE_NOT_FOUND" ||
      (error as { code?: string }).code === "ERR_PACKAGE_PATH_NOT_EXPORTED")
  );
}

async function removeComputerUsePackageEntry(agentDir: string, packageDir: string): Promise<void> {
  const settingsPath = path.join(agentDir, "settings.json");
  const settings = await readSettings(settingsPath);
  if (!Array.isArray(settings.packages)) {
    return;
  }

  const nextPackages = settings.packages.filter((entry) => !isComputerUsePackageEntry(entry, packageDir, agentDir));
  if (nextPackages.length === settings.packages.length) {
    return;
  }

  await mkdir(agentDir, { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify({ ...settings, packages: nextPackages }, null, 2)}\n`, "utf8");
}

async function readSettings(settingsPath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }
  return {};
}

function isComputerUsePackageEntry(entry: unknown, packageDir: string, agentDir: string): boolean {
  const source = packageEntrySource(entry)?.trim();
  if (!source) {
    return false;
  }
  if (
    source === computerUsePackageName ||
    source === `npm:${computerUsePackageName}` ||
    source.startsWith(`npm:${computerUsePackageName}@`)
  ) {
    return true;
  }
  if (isRemotePackageSource(source)) {
    return false;
  }

  const resolvedSource = resolvePackageSourcePath(source, agentDir);
  return (
    resolvedSource === path.resolve(packageDir) ||
    isPackagedComputerUsePackagePath(resolvedSource) ||
    packageManifestName(resolvedSource) === computerUsePackageName
  );
}

function isRemotePackageSource(source: string): boolean {
  return /^(git|github|https?|ssh):/.test(source);
}

function resolvePackageSourcePath(source: string, agentDir: string): string {
  const expanded = expandHome(source);
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(agentDir, expanded));
}

function isPackagedComputerUsePackagePath(sourcePath: string): boolean {
  const normalized = sourcePath.split(path.sep).join("/");
  return normalized.endsWith(".app/Contents/Resources/app.asar/out/computer-use-extension");
}

function packageManifestName(sourcePath: string): string | undefined {
  try {
    const raw = readFileSync(path.join(sourcePath, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const name = (parsed as { name?: unknown }).name;
      return typeof name === "string" ? name : undefined;
    }
  } catch {
    // Missing or invalid local packages are not pi-gui Computer Use packages.
  }
  return undefined;
}

function packageEntrySource(entry: unknown): string | undefined {
  if (typeof entry === "string") {
    return entry;
  }
  if (entry && typeof entry === "object" && "source" in entry) {
    const source = (entry as { source?: unknown }).source;
    return typeof source === "string" ? source : undefined;
  }
  return undefined;
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
