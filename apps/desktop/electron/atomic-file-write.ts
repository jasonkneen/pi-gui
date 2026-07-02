import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const writeQueueByPath = new Map<string, Promise<void>>();

/**
 * Write a file via temp-file + rename so readers never observe a partial
 * write, serializing concurrent writes to the same path.
 */
export async function writeFileAtomicQueued(filePath: string, contents: string): Promise<void> {
  await enqueueWrite(filePath, async () => {
    await mkdir(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmpPath, contents, "utf8");

    try {
      await rename(tmpPath, filePath);
    } catch (error) {
      if (!isReplaceRenameError(error)) {
        await cleanupTempFile(tmpPath);
        throw error;
      }

      try {
        await unlink(filePath);
      } catch (unlinkError) {
        if (!isMissingFileError(unlinkError)) {
          await cleanupTempFile(tmpPath);
          throw unlinkError;
        }
      }

      try {
        await rename(tmpPath, filePath);
      } catch (renameError) {
        await cleanupTempFile(tmpPath);
        throw renameError;
      }
    }
  });
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isReplaceRenameError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "EEXIST" || error.code === "EPERM");
}

async function cleanupTempFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

async function enqueueWrite(filePath: string, write: () => Promise<void>): Promise<void> {
  const previous = writeQueueByPath.get(filePath) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(write);
  writeQueueByPath.set(filePath, next);

  try {
    await next;
  } finally {
    if (writeQueueByPath.get(filePath) === next) {
      writeQueueByPath.delete(filePath);
    }
  }
}
