import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

interface SessionRefLike {
  readonly workspaceId: string;
  readonly sessionId: string;
}

export interface SeededSessionFileMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly timestampMs?: number;
}

/** Resolve a session's pi JSONL file path from the app's catalog. */
export async function sessionFilePathFromCatalog(userDataDir: string, sessionRef: SessionRefLike): Promise<string> {
  const catalogs = JSON.parse(await readFile(join(userDataDir, "catalogs.json"), "utf8")) as {
    sessions: Array<{ sessionRef: SessionRefLike; sessionFilePath?: string }>;
    sessionFiles?: Record<string, string>;
  };
  const sessionFilePath =
    catalogs.sessions.find(
      (session) =>
        session.sessionRef.workspaceId === sessionRef.workspaceId &&
        session.sessionRef.sessionId === sessionRef.sessionId,
    )?.sessionFilePath ?? catalogs.sessionFiles?.[`${sessionRef.workspaceId}:${sessionRef.sessionId}`];
  if (!sessionFilePath) {
    throw new Error(`No session file tracked for ${sessionRef.workspaceId}:${sessionRef.sessionId}`);
  }
  return sessionFilePath;
}

/**
 * Append message entries straight to a pi session JSONL file, chaining off the
 * current leaf — the same shape pi itself writes. Use this to seed transcript
 * content that must survive an app relaunch (the app reads transcripts from
 * the session file, not from a cache).
 */
export async function appendMessagesToSessionFile(
  sessionFilePath: string,
  messages: readonly SeededSessionFileMessage[],
): Promise<void> {
  const lines = (await readFile(sessionFilePath, "utf8")).split("\n").filter(Boolean);
  const lastLine = lines.at(-1);
  if (!lastLine) {
    throw new Error(`Session file ${sessionFilePath} is empty`);
  }
  let parentId = (JSON.parse(lastLine) as { id?: string }).id ?? null;
  const baseTime = Date.now();

  const entries = messages.map((message, index) => {
    const id = `seeded-${baseTime}-${index}`;
    const timestamp = message.timestampMs ?? baseTime + index * 1_000;
    const entry = {
      type: "message",
      id,
      parentId,
      timestamp: new Date(timestamp).toISOString(),
      message:
        message.role === "assistant"
          ? {
              role: "assistant",
              content: [{ type: "text", text: message.text }],
              api: "test",
              provider: "test",
              model: "test",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "stop",
              timestamp,
            }
          : { role: "user", content: message.text, timestamp },
    };
    parentId = id;
    return entry;
  });

  await appendFile(sessionFilePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}
