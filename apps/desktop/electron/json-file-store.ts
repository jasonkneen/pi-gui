import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomicQueued } from "./atomic-file-write";

export class JsonFileStore<T> {
  private readonly rootDir: string;

  constructor(userDataDir: string, subdir: string) {
    this.rootDir = join(userDataDir, subdir);
  }

  async read(sessionKey: string): Promise<T | undefined> {
    try {
      const raw = await readFile(this.filePath(sessionKey), "utf8");
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  async write(sessionKey: string, data: T): Promise<void> {
    await writeFileAtomicQueued(this.filePath(sessionKey), `${JSON.stringify(data, null, 2)}\n`);
  }

  async listKeys(): Promise<string[]> {
    try {
      const entries = await readdir(this.rootDir);
      return entries.filter((name) => name.endsWith(".json")).map((name) => decodeURIComponent(name.slice(0, -".json".length)));
    } catch {
      return [];
    }
  }

  async remove(sessionKey: string): Promise<void> {
    try {
      await unlink(this.filePath(sessionKey));
    } catch {
      // Already gone.
    }
  }

  private filePath(sessionKey: string): string {
    return join(this.rootDir, `${encodeURIComponent(sessionKey)}.json`);
  }
}
