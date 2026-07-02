import { expect, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { getDesktopState, getSelectedTranscript } from "../helpers/electron-app";
import type { TimelineToolCall } from "../../src/timeline-types";

const helperExecutableName = "pi-gui-computer-use-helper";
const cursorOverlayArgument = "--cursor-overlay-daemon";
const cursorPositionPath = join(tmpdir(), "pi-gui-computer-use-agent-cursor-position");
const cursorPidPath = join(tmpdir(), "pi-gui-computer-use-agent-cursor.pid");
const execFileAsync = promisify(execFile);

export async function clearAgentCursorObservation(): Promise<void> {
  const rawPid = await readFile(cursorPidPath, "utf8").catch(() => "");
  const pid = Number(rawPid.trim());
  if (Number.isInteger(pid) && pid > 0 && (await agentCursorDaemonCommand(pid))) {
    await execFileAsync("kill", ["-TERM", `${pid}`]).catch(() => undefined);
    await delay(150);
  }
  await rm(cursorPositionPath, { force: true });
  await rm(cursorPidPath, { force: true });
}

export async function waitForDistinctAgentCursorRequests(
  startedAtSeconds: number,
  requiredCount: number,
  options: {
    readonly timeoutMs?: number;
    readonly failureLabel?: string;
  } = {},
): Promise<AgentCursorObservation[]> {
  const timeoutMs = options.timeoutMs ?? 210_000;
  const deadline = Date.now() + timeoutMs;
  const observations: AgentCursorObservation[] = [];
  let previousTimestamp = startedAtSeconds;
  while (Date.now() < deadline) {
    const observation = await readAgentCursorObservation(previousTimestamp);
    if (observation) {
      const previous = observations.at(-1);
      if (
        !previous ||
        observation.timestamp > previous.timestamp ||
        observation.x !== previous.x ||
        observation.y !== previous.y ||
        observation.pressed !== previous.pressed
      ) {
        observations.push(observation);
        previousTimestamp = observation.timestamp;
      }
      if (
        observations.length >= requiredCount &&
        new Set(observations.map((request) => `${request.x},${request.y}`)).size > 1 &&
        !observation.pressed
      ) {
        return observations;
      }
    }
    await delay(250);
  }
  throw new Error(
    `${options.failureLabel ?? "Installed Computer Use live run"} did not show ${requiredCount} distinct persistent agent cursor requests ending in a released cursor state.`,
  );
}

async function readAgentCursorObservation(startedAtSeconds: number): Promise<AgentCursorObservation | null> {
  const [rawPosition, rawPid] = await Promise.all([
    readFile(cursorPositionPath, "utf8").catch(() => ""),
    readFile(cursorPidPath, "utf8").catch(() => ""),
  ]);
  const parts = rawPosition.trim().split(",");
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  const timestamp = Number(parts[2]);
  const pid = Number(rawPid.trim());
  if (
    parts.length !== 4 ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(timestamp) ||
    timestamp < startedAtSeconds ||
    !Number.isInteger(pid) ||
    pid <= 0
  ) {
    return null;
  }
  const command = await agentCursorDaemonCommand(pid);
  if (!command) {
    return null;
  }
  return { x, y, timestamp, pressed: parts[3] === "1", pid, command };
}

async function agentCursorDaemonCommand(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", `${pid}`, "-o", "command="]);
    const command = stdout.trim();
    if (command.includes(helperExecutableName) && command.includes(cursorOverlayArgument)) {
      return command;
    }
  } catch {
    return null;
  }
  return null;
}

export interface AgentCursorObservation {
  readonly x: number;
  readonly y: number;
  readonly timestamp: number;
  readonly pressed: boolean;
  readonly pid: number;
  readonly command: string;
}

export async function waitForSelectedSessionIdle(window: Page, timeoutMs = 210_000): Promise<void> {
  await expect
    .poll(async () => {
      const state = await getDesktopState(window);
      const workspace = state.workspaces.find((entry) => entry.id === state.selectedWorkspaceId);
      const session = workspace?.sessions.find((entry) => entry.id === state.selectedSessionId);
      return session?.status ?? "";
    }, { timeout: timeoutMs })
    .toBe("idle");
}

export async function selectedToolCalls(window: Page): Promise<TimelineToolCall[]> {
  const selectedTranscript = await getSelectedTranscript(window);
  return (selectedTranscript?.transcript ?? []).filter(
    (item): item is TimelineToolCall => item.kind === "tool",
  );
}

export function isComputerUseTool(call: TimelineToolCall): boolean {
  return ["click", "get_app_state", "list_apps", "set_value", "scroll", "drag", "perform_secondary_action"].includes(call.toolName);
}

export function inputApp(input: unknown): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  return typeof input.app === "string" ? input.app : undefined;
}

export function toolOutputText(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }
  if (isRecord(output) && Array.isArray(output.content)) {
    return output.content
      .map((item) => (isRecord(item) && typeof item.text === "string" ? item.text : ""))
      .join("\n");
  }
  return output === undefined || output === null ? "" : JSON.stringify(output);
}

export function calculatorDisplays(text: string, expected: string): boolean {
  const expectedPattern = new RegExp(`(^|\\D)${escapeRegExp(expected)}(\\D|$)`);
  return text.split(/\r?\n/).some((line) => {
    const content = accessibilityTreeLineContent(line);
    if (!looksLikeCalculatorDisplayContent(content)) {
      return false;
    }
    return expectedPattern.test(content);
  });
}

function accessibilityTreeLineContent(line: string): string {
  return normalizeDisplayText(line).replace(/^\s*\d+\s+/, "");
}

function looksLikeCalculatorDisplayContent(content: string): boolean {
  return /^(text|static text|edit field)\b/i.test(content) || /\bValue:\s*/i.test(content);
}

function normalizeDisplayText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u200e\u200f\u202a-\u202e]/g, "")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
